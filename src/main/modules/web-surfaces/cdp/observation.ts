import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserObservation, BrowserObservedElement } from "../../../../shared/browser-use";
import { executeClick } from "./click";
import { observationExpression, type ObservationProbeRequest } from "./observation-script";
import {
  DEFAULT_OBSERVATION_ELEMENTS, DEFAULT_OBSERVATION_TEXT_LENGTH, SURFACE_SCROLL_DEFAULT_DELTA_Y,
  type SurfaceClickParams, type SurfaceInteractParams, type SurfaceObserveParams, type SurfaceRefParams,
} from "./observation-params";
import type { PageModalState } from "./page-automation";
import { pressSurfaceKey, typeSurfaceText } from "./keyboard";

type Send = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;
type Binding = {
  contents: WebContents;
  surfaceId: string;
  worldName: string;
  key: string;
  observationId: string | null;
  expectedDetaches: number;
  dispose: () => void;
};

function observationError(code: string) {
  return Object.assign(new Error(code), { code });
}

/** Main owns identities; the isolated world owns actual Node references, never DOM attributes. */
export class SurfaceObservationRegistry {
  private readonly bindings = new WeakMap<WebContents, Binding>();
  private readonly liveBindings = new Set<Binding>();

  /** modalState reports native dialogs, file choosers and downloads that the page script cannot see. */
  constructor(private readonly modalState?: (contents: WebContents) => PageModalState | undefined) {}

  dispose() {
    for (const binding of [...this.liveBindings]) binding.dispose();
  }

  /** Normal per-command debugger cleanup must not look like a lost browser connection. */
  detachOwnedDebugger(contents: WebContents, detach: () => void) {
    const binding = this.bindings.get(contents);
    if (binding) binding.expectedDetaches += 1;
    try { detach(); }
    catch (error) {
      if (binding) binding.expectedDetaches = Math.max(0, binding.expectedDetaches - 1);
      throw error;
    }
  }

  /** Native dialog and file chooser identities are only valid inside the observation that reported them. */
  assertCurrent(surfaceId: string, contents: WebContents, observationId: unknown) {
    const binding = this.bindings.get(contents);
    if (!binding || binding.surfaceId !== surfaceId || typeof observationId !== "string" || binding.observationId !== observationId) {
      throw observationError("observation_stale");
    }
  }

  invalidate(contents: WebContents) {
    const binding = this.bindings.get(contents);
    if (binding) binding.observationId = null;
  }

  private bind(surfaceId: string, contents: WebContents) {
    const existing = this.bindings.get(contents);
    if (existing?.surfaceId === surfaceId) return existing;
    existing?.dispose();
    // WebContents.debugger is a native getter and cannot be read after destroyed.
    const debuggerRef = contents.debugger;
    let disposed = false;
    const binding: Binding = {
      contents, surfaceId, worldName: `desktop-browser-observation-${randomUUID()}`,
      key: `__observation_${randomUUID().replaceAll("-", "")}`, observationId: null, expectedDetaches: 0,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        binding.observationId = null;
        this.bindings.delete(contents);
        this.liveBindings.delete(binding);
        for (const remove of [
          () => contents.off("did-start-navigation", onNavigation),
          () => contents.off("did-navigate-in-page", onNavigation),
          () => contents.off("destroyed", onGone),
          () => contents.off("render-process-gone", onGone),
          () => debuggerRef.off("detach", onDetach),
        ]) {
          try { remove(); } catch { /* Native teardown can finish before listener cleanup. */ }
        }
      },
    };
    const onNavigation = () => { binding.observationId = null; };
    const onGone = () => binding.dispose();
    const onDetach = () => {
      if (binding.expectedDetaches > 0) binding.expectedDetaches -= 1;
      else binding.observationId = null;
    };
    contents.on("did-start-navigation", onNavigation);
    contents.on("did-navigate-in-page", onNavigation);
    contents.once("destroyed", onGone);
    contents.once("render-process-gone", onGone);
    debuggerRef.on("detach", onDetach);
    this.bindings.set(contents, binding);
    this.liveBindings.add(binding);
    return binding;
  }

  private async context(binding: Binding, send: Send, check: () => Promise<void>, remainingMs: () => number) {
    await check();
    const tree = await send("Page.getFrameTree", {}, remainingMs());
    await check();
    const frameId = tree.frameTree?.frame?.id;
    if (typeof frameId !== "string") throw observationError("observation_unavailable");
    const world = await send("Page.createIsolatedWorld", {
      frameId, worldName: binding.worldName, grantUniveralAccess: false,
    }, remainingMs());
    await check();
    if (!Number.isInteger(world.executionContextId)) throw observationError("observation_unavailable");
    return world.executionContextId as number;
  }

  private async evaluate(binding: Binding, contextId: number, request: ObservationProbeRequest,
    send: Send, check: () => Promise<void>, remainingMs: () => number) {
    await check();
    const result = await send("Runtime.evaluate", {
      expression: observationExpression(binding.key, request), contextId, returnByValue: true,
      timeout: remainingMs(),
    }, remainingMs());
    await check();
    if (result.exceptionDetails) throw observationError("page_evaluation_failed");
    const value = result.result?.value;
    if (!value || typeof value !== "object") throw observationError("invalid_observation_result");
    if (typeof value.error === "string") throw observationError(value.error);
    return value as Record<string, any>;
  }

  private transaction(surfaceId: string, contents: WebContents, validate: () => Promise<void>, signal: AbortSignal | undefined,
    timeoutMs: number, observationId?: string) {
    const binding = observationId ? this.bindings.get(contents) : this.bind(surfaceId, contents);
    if (!binding || binding.surfaceId !== surfaceId || observationId && binding.observationId !== observationId) {
      throw observationError("observation_stale");
    }
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const check = async () => {
      if (signal?.aborted) throw Object.assign(new Error("canceled"), { code: "canceled" });
      if (Date.now() >= deadline) throw Object.assign(new Error("timeout"), { code: "timeout" });
      if (contents.isDestroyed()) throw observationError("target_closed");
      await validate();
      if (signal?.aborted) throw Object.assign(new Error("canceled"), { code: "canceled" });
      if (this.bindings.get(contents) !== binding || observationId && binding.observationId !== observationId) throw observationError("observation_stale");
    };
    return { binding, check, remainingMs };
  }

  async observe(surfaceId: string, params: SurfaceObserveParams, contents: WebContents, send: Send,
    validate: () => Promise<void>, signal?: AbortSignal): Promise<BrowserObservation> {
    const { binding, check, remainingMs } = this.transaction(surfaceId, contents, validate, signal, 5000);
    const observationId = randomUUID();
    // Clear the previous snapshot before issuing any async work. A failed observation grants no refs.
    binding.observationId = observationId;
    const modals = this.modalState?.(contents);
    const extras = modals ? {
      ...(modals.dialogs.length ? { dialogs: modals.dialogs } : {}),
      ...(modals.fileChoosers.length ? { fileChoosers: modals.fileChoosers } : {}),
      ...(modals.downloads.length ? { downloads: modals.downloads } : {}),
    } : {};
    if (modals?.dialogs.length) {
      // A native dialog blocks page scripts; report it without evaluating anything in the page.
      await check();
      return { surfaceId, provider: "workpanel", observationId, url: contents.getURL(), title: contents.getTitle?.() ?? "",
        text: "", elements: [], truncated: false, ...extras };
    }
    try {
      const contextId = await this.context(binding, send, check, remainingMs);
      const result = await this.evaluate(binding, contextId, {
        kind: "observe", observationId,
        maxTextLength: params.maxTextLength ?? DEFAULT_OBSERVATION_TEXT_LENGTH,
        maxElements: params.maxElements ?? DEFAULT_OBSERVATION_ELEMENTS,
        ...(params.viewportOnly ? { viewportOnly: true } : {}),
      }, send, check, remainingMs);
      if (binding.observationId !== observationId) throw observationError("observation_stale");
      return {
        surfaceId, provider: "workpanel", observationId,
        url: result.url as string, title: result.title as string, text: result.text as string,
        elements: result.elements as BrowserObservedElement[], truncated: result.truncated === true,
        ...(result.viewportOnly === true ? { viewportOnly: true } : {}),
        ...extras,
      };
    } catch (error) {
      binding.observationId = null;
      throw error;
    }
  }

  async click(surfaceId: string, params: SurfaceClickParams, contents: WebContents, send: Send,
    validate: () => Promise<void>, signal?: AbortSignal) {
    const { binding, check, remainingMs } = this.transaction(surfaceId, contents, validate, signal, params.timeoutMs ?? 3000, params.observationId);
    const contextId = await this.context(binding, send, check, remainingMs);
    const clickParams = { x: 0, y: 0, waitFor: params.waitFor, timeoutMs: params.timeoutMs };
    const sendInput: Send = async (method, args, timeoutMs) => {
      if (method === "Input.dispatchMouseEvent" && args.type === "mousePressed") await check();
      return send(method, args, timeoutMs);
    };
    return executeClick(clickParams, contents, sendInput, validate, signal, (kind) => this.evaluate(binding, contextId, {
      kind, observationId: params.observationId, ref: params.ref, waitFor: params.waitFor,
    }, send, check, remainingMs));
  }

  async interact(surfaceId: string, params: SurfaceInteractParams, contents: WebContents, send: Send,
    validate: () => Promise<void>, signal?: AbortSignal,
    onInputDiagnostic?: (phase: "before_input" | "after_input", evidence: Record<string, boolean>) => void) {
    const action = params.action;
    // type dispatches key events per character, so its budget grows with the text instead of the 3s default.
    const timeoutMs = params.timeoutMs ?? (action === "type" ? 10_000 : 5000);
    const { binding, check, remainingMs } = this.transaction(surfaceId, contents, validate, signal, timeoutMs, params.observationId);
    const contextId = await this.context(binding, send, check, remainingMs);
    const targeted = params.ref !== undefined || params.selector !== undefined;
    const probe = (kind: ObservationProbeRequest["kind"]) => this.evaluate(binding, contextId, {
      kind, observationId: params.observationId ?? "", ref: params.ref, selector: params.selector,
      value: params.value, values: params.values,
    }, send, check, remainingMs);
    const sendInput: Send = async (method, args, timeout) => {
      if (method === "Input.dispatchMouseEvent" && args.type === "mousePressed" || method === "Input.dispatchKeyEvent" && args.type !== "keyUp") await check();
      return send(method, args, timeout);
    };
    const done = { status: "done" as const, action, ...(params.ref !== undefined ? { ref: params.ref, observationId: params.observationId } : {}) };
    const diagnose = (phase: "before_input" | "after_input", evidence: Record<string, any>) => {
      if (!onInputDiagnostic) return;
      let native: Record<string, boolean> = { nativeFocusAvailable: false };
      try {
        const frame = contents.focusedFrame, main = contents.mainFrame, host = contents.hostWebContents;
        const hostFrame = host?.focusedFrame;
        native = { nativeFocusAvailable: typeof contents.isFocused === "function", nativeGuestFocused: contents.isFocused?.() === true,
          nativeFocusedFramePresent: !!frame, nativeFocusedFrameIsMain: !!frame && frame === main,
          nativeHostFocused: host?.isFocused() === true,
          nativeHostFocusedFrameIsGuest: !!hostFrame && !!main && hostFrame.processId === main.processId && hostFrame.routingId === main.routingId };
      } catch { /* Focus diagnostics must not change a page action's behavior. */ }
      try { onInputDiagnostic(phase, { ...native, domFocused: evidence.domFocused === true,
        documentFocused: evidence.documentFocused === true, topDocumentFocused: evidence.topDocumentFocused === true,
        targetIsMainDocument: evidence.targetIsMainDocument === true, valueMatched: evidence.valueMatched === true }); }
      catch { /* Logs are not an input dependency. */ }
    };
    // The page may still settle after scrollIntoView; take the point only once two probes agree.
    const point = async () => {
      let previous = await probe("locate");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const current = await probe("verify");
        if (typeof current.x !== "number" || typeof current.y !== "number") throw observationError("invalid_probe_result");
        if (current.x === previous.x && current.y === previous.y) return { x: current.x as number, y: current.y as number };
        previous = current;
      }
      throw observationError("element_not_stable");
    };
    const focusTarget = async () => {
      if (!targeted) return;
      if (!(await probe("focus")).matched) throw observationError("element_focus_changed");
    };

    if (action === "fill") {
      const prepared = await probe("fill");
      if (!prepared.prepared) throw observationError("interaction_not_completed");
      const focused = await probe("verify-focus");
      diagnose("before_input", focused);
      await check();
      if (params.value) await send("Input.insertText", { text: params.value }, remainingMs());
      else {
        // Clearing a selected input needs a real editing key; insertText("") can be a no-op.
        const key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
        try { await send("Input.dispatchKeyEvent", { ...key, type: "keyDown" }, remainingMs()); }
        finally { await send("Input.dispatchKeyEvent", { ...key, type: "keyUp" }, 1000); }
      }
      await check();
      const filled = await probe("verify-fill");
      diagnose("after_input", filled);
      if (!filled.matched) throw observationError("input_value_mismatch");
      return done;
    }
    if (action === "select") {
      if (!(await probe("select")).matched) throw observationError("input_value_mismatch");
      return done;
    }
    if (action === "focus") {
      if (!(await probe("focus")).matched) throw observationError("interaction_not_completed");
      return done;
    }
    if (action === "scroll") {
      if (targeted) {
        if (!(await probe("scroll")).matched) throw observationError("interaction_not_completed");
        return done;
      }
      const viewport = await probe("viewport");
      await check();
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.max(0, (viewport.width as number) / 2), y: Math.max(0, (viewport.height as number) / 2),
        deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? SURFACE_SCROLL_DEFAULT_DELTA_Y }, remainingMs());
      return done;
    }
    if (action === "hover") {
      const target = await point();
      await check();
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...target, button: "none" }, remainingMs());
      return done;
    }
    if (action === "check" || action === "uncheck") {
      const wanted = action === "check";
      const state = await probe("check-state");
      if (state.checked === wanted) return { ...done, changed: false };
      if (!wanted && state.radio === true) throw observationError("radio_cannot_uncheck");
      const target = await point();
      const mouse = { ...target, button: "left", clickCount: 1 };
      await sendInput("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" }, remainingMs());
      // Always release on the original guest; the press is never repeated.
      await send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" }, 1000);
      if ((await probe("check-state")).checked !== wanted) throw observationError("input_value_mismatch");
      return { ...done, changed: true };
    }
    if (action === "type") {
      await focusTarget();
      await typeSurfaceText(sendInput, params.value!, check, remainingMs);
      return done;
    }
    await focusTarget();
    await pressSurfaceKey(sendInput, params.key!, remainingMs());
    return done;
  }

  /** Resolves an observed file input for DOM.setFileInputFiles without exposing it to page scripts. */
  async fileInput(surfaceId: string, params: SurfaceRefParams, contents: WebContents, send: Send,
    validate: () => Promise<void>, signal?: AbortSignal): Promise<{ objectId: string; multiple: boolean }> {
    const { binding, check, remainingMs } = this.transaction(surfaceId, contents, validate, signal, params.timeoutMs ?? 5000, params.observationId);
    const contextId = await this.context(binding, send, check, remainingMs);
    const request = { observationId: params.observationId, ref: params.ref };
    const checked = await this.evaluate(binding, contextId, { kind: "file-input", ...request }, send, check, remainingMs);
    await check();
    const handle = await send("Runtime.evaluate", {
      expression: observationExpression(binding.key, { kind: "file-input-element", ...request }), contextId, returnByValue: false,
    }, remainingMs());
    await check();
    if (handle.result?.subtype !== "node" || typeof handle.result.objectId !== "string") throw observationError("element_not_file_input");
    return { objectId: handle.result.objectId, multiple: checked.multiple === true };
  }

  /** Captures the state an action produced so the model can continue with fresh refs. */
  async observeAfterAction(surfaceId: string, params: SurfaceObserveParams, contents: WebContents, send: Send,
    validate: () => Promise<void>, signal?: AbortSignal): Promise<{ observation: BrowserObservation } | { observationError: { code: string; message: string } }> {
    this.invalidate(contents);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 100);
        function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
        signal?.addEventListener("abort", done, { once: true });
      });
      return { observation: await this.observe(surfaceId, params, contents, send, validate, signal) };
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "observation_unavailable";
      return { observationError: { code, message: "The action result is preserved. Capture a fresh observation before the next action; do not repeat the completed action." } };
    }
  }
}
