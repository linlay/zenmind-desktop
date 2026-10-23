import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserObservation, BrowserObservedElement } from "../../../../shared/browser-use";
import { executeClick } from "./click";
import { observationExpression, type ObservationProbeRequest } from "./observation-script";
import {
  DEFAULT_OBSERVATION_ELEMENTS, DEFAULT_OBSERVATION_TEXT_LENGTH,
  type SurfaceClickParams, type SurfaceInteractParams, type SurfaceObserveParams,
} from "./observation-params";

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
    try {
      const contextId = await this.context(binding, send, check, remainingMs);
      const result = await this.evaluate(binding, contextId, {
        kind: "observe", observationId,
        maxTextLength: params.maxTextLength ?? DEFAULT_OBSERVATION_TEXT_LENGTH,
        maxElements: params.maxElements ?? DEFAULT_OBSERVATION_ELEMENTS,
      }, send, check, remainingMs);
      if (binding.observationId !== observationId) throw observationError("observation_stale");
      return {
        surfaceId, provider: "workpanel", observationId,
        url: result.url as string, title: result.title as string, text: result.text as string,
        elements: result.elements as BrowserObservedElement[], truncated: result.truncated === true,
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
    const { binding, check, remainingMs } = this.transaction(surfaceId, contents, validate, signal, params.timeoutMs ?? 3000, params.observationId);
    const contextId = await this.context(binding, send, check, remainingMs);
    const probe = (kind: ObservationProbeRequest["kind"]) => this.evaluate(binding, contextId, {
      kind, observationId: params.observationId, ref: params.ref, value: params.value,
    }, send, check, remainingMs);
    const prepared = await probe(params.action);
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
    if (params.action === "fill") {
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
    } else if (!prepared.matched) throw observationError("interaction_not_completed");
    else if (params.action === "select" && !(await probe("verify-fill")).matched) throw observationError("input_value_mismatch");
    return { status: "done" as const, action: params.action, ref: params.ref, observationId: params.observationId };
  }
}
