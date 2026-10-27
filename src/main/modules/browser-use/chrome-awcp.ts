import { createHash } from "node:crypto";
import type { JSHandle, Page, Request } from "playwright-core";
import {
  AWCP_LIMITS, AWCP_PROTOCOL_VERSION, assertJsonValue, assertPlainRecord, assertToken,
  awcpHostError, awcpPreflightFailure, isAwcpHostError, validateActionResponse,
  validateInvokePayload, validateManualError, validateManualIndex, validateManualPayload, validateManualSection,
  type AwcpActionResponse, type AwcpManualResponse,
} from "../awcp";
import type { ChromeWorkerTab } from "./chrome-worker-contract";

export const CHROME_AWCP_MAX_SCRIPT_BYTES = 12 * 1024 * 1024;
type Parameters = { requestId: string; runId: string; runLease: number; payload: Record<string, unknown>; expectedUrl: string; bridgeScript: string };
export type ChromeAwcpRunLease = { runId: string; lease: number; pending: number; released: boolean };
type Binding = { page: Page; epoch: number; revision: string; actions: Set<string>; sections: Set<string> };
type PageState = { page: Page; pageId: string; epoch: number; scriptHash?: string; ownedBridge?: JSHandle<unknown>; dispose(): void };
type Active = { runLease: number; page: Page; pageId: string; cancel(error: Error): Promise<void> };
type Context = { check(): void; dispatch(): void; epoch: number };

function parameters(input: unknown): Parameters {
  assertPlainRecord(input, "Chrome AWCP request");
  if (Object.keys(input).sort().join(",") !== "bridgeScript,expectedUrl,payload,requestId,runId,runLease")
    throw awcpHostError("awcp_invalid_request", "The Chrome AWCP request has unsupported fields.");
  assertToken("requestId", input.requestId, AWCP_LIMITS.maxRequestIdLength);
  assertToken("runId", input.runId, AWCP_LIMITS.maxRequestIdLength);
  assertRunLease(input.runLease);
  assertPlainRecord(input.payload, "AWCP payload");
  if (typeof input.expectedUrl !== "string" || input.expectedUrl.length > 8192)
    throw awcpHostError("awcp_invalid_request", "The Chrome AWCP page address is invalid.");
  try {
    const url = new URL(input.expectedUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw awcpHostError("awcp_invalid_request", "The Chrome AWCP page address is invalid."); }
  if (typeof input.bridgeScript !== "string" || input.bridgeScript.length > CHROME_AWCP_MAX_SCRIPT_BYTES
    || Buffer.byteLength(input.bridgeScript, "utf8") > CHROME_AWCP_MAX_SCRIPT_BYTES)
    throw awcpHostError("awcp_invalid_request", "The fixed website bridge script exceeds the allowed size.");
  return input as Parameters;
}

function assertRunLease(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw awcpHostError("awcp_invalid_request", "A private AWCP Run lease is required.");
}

async function bounded(work: Promise<unknown>, ms = 300): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work.catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

/** Fixed AWCP transport for one owned extension connection; it exposes no script tool. */
export class ChromeAwcp {
  private readonly bindings = new Map<number, Map<string, Binding>>();
  private readonly pages = new Map<string, PageState>();
  private readonly active = new Map<string, Active>();
  private readonly runs = new Map<number, ChromeAwcpRunLease>();
  private releasedThrough = 0;
  private configurationEpoch = 0;
  private closed = false;

  constructor(private readonly signal: AbortSignal) {}
  generation() { return this.configurationEpoch; }

  /** Capture cancellation identity before queueing; old requests never look up a replacement Run. */
  retainRun(input: unknown): ChromeAwcpRunLease {
    const args = parameters(input);
    if (this.closed || this.signal.aborted) throw awcpHostError("awcp_cancelled", "The Chrome AWCP connection was released.");
    if (args.runLease <= this.releasedThrough) throw awcpHostError("site_control_unavailable", "The AWCP Run authorization ended.");
    let run = this.runs.get(args.runLease);
    if (run && run.runId !== args.runId) throw awcpHostError("awcp_invalid_request", "The private AWCP Run lease does not match.");
    if (!run) { run = { runId: args.runId, lease: args.runLease, pending: 0, released: false }; this.runs.set(run.lease, run); }
    run.pending++;
    return run;
  }

  releaseRequest(run: ChromeAwcpRunLease): void {
    run.pending--;
    if (run.released && run.pending === 0 && this.runs.get(run.lease) === run) this.runs.delete(run.lease);
  }

  private assertRun(args: Parameters, run: ChromeAwcpRunLease): void {
    if (run.released || run.lease <= this.releasedThrough || this.runs.get(run.lease) !== run)
      throw awcpHostError("site_control_unavailable", "The AWCP Run authorization ended.");
    if (run.runId !== args.runId || run.lease !== args.runLease)
      throw awcpHostError("awcp_invalid_request", "The private AWCP Run lease does not match.");
  }

  watch(tab: ChromeWorkerTab): PageState {
    const previous = this.pages.get(tab.desktopPageId);
    if (previous?.page === tab.page) return previous;
    if (previous) { this.invalidate(previous); previous.dispose(); }
    const state: PageState = { page: tab.page, pageId: tab.desktopPageId, epoch: 0, dispose: () => undefined };
    const navigation = () => this.invalidate(state);
    const frame = (candidate: import("playwright-core").Frame) => { if (candidate === tab.page.mainFrame()) navigation(); };
    const request = (candidate: Request) => {
      try { if (candidate.isNavigationRequest() && candidate.frame() === tab.page.mainFrame()) navigation(); }
      catch { /* Service-worker and already-detached requests have no authorized main Frame. */ }
    };
    const destroyed = () => {
      if (this.pages.get(state.pageId) !== state) return;
      this.invalidate(state, "awcp_target_unavailable");
      for (const binding of this.bindings.values()) binding.delete(state.pageId);
      this.pages.delete(state.pageId); state.dispose();
      // The document has gone; release the remote reference without running any
      // cleanup script on a closed/crashed target or keeping its Page alive.
      const handle = state.ownedBridge; state.ownedBridge = undefined;
      if (handle) void bounded(handle.dispose());
    };
    tab.page.on("framenavigated", frame); tab.page.on("request", request);
    tab.page.on("close", destroyed); tab.page.on("crash", destroyed);
    state.dispose = () => {
      tab.page.off("framenavigated", frame); tab.page.off("request", request);
      tab.page.off("close", destroyed); tab.page.off("crash", destroyed);
    };
    this.pages.set(state.pageId, state);
    return state;
  }

  private invalidate(state: PageState, code = "awcp_navigation_interrupted") {
    state.epoch++;
    for (const binding of this.bindings.values()) binding.get(state.pageId)?.sections.clear();
    for (const active of this.active.values()) if (active.page === state.page)
      void active.cancel(awcpHostError(code, "The authorized Chrome page changed during the AWCP request."));
  }

  private binding(runLease: number, state: PageState, revision: string): Binding {
    const current = this.bindings.get(runLease)?.get(state.pageId);
    if (!current) throw awcpPreflightFailure("manual_required", "Read this page's AWCP directory in the current Run first.");
    if (current.page !== state.page || current.epoch !== state.epoch || state.page.isClosed())
      throw awcpPreflightFailure("page_changed", "The AWCP page binding changed. Read the current directory.");
    if (current.revision !== revision)
      throw awcpPreflightFailure("stale_revision", "The AWCP revision changed. Read the current directory.");
    return current;
  }

  private cancelPage(page: Page, requestId: string): Promise<void> {
    if (page.isClosed()) return Promise.resolve();
    return bounded(page.evaluate(`(() => { const api = globalThis.awcp; return typeof api?.cancel === 'function' ? api.cancel(${JSON.stringify(requestId)}) : false; })()`));
  }

  private async disposeHandle(handle: JSHandle<unknown>) {
    await bounded(handle.evaluate(value => {
      const current = (globalThis as typeof globalThis & { __zenmindWebsiteBridge?: unknown }).__zenmindWebsiteBridge;
      if (value && typeof value === "object" && current === value) {
        const dispose = (value as { dispose?: unknown }).dispose;
        if (typeof dispose === "function") dispose.call(value);
      }
    }));
    await bounded(handle.dispose());
  }

  private async disposeOwned(state: PageState) {
    const handle = state.ownedBridge; state.ownedBridge = undefined;
    if (handle) await this.disposeHandle(handle);
  }

  async releaseRun(input: unknown): Promise<{ released: true }> {
    assertPlainRecord(input, "AWCP Run release");
    if (Object.keys(input).sort().join(",") !== "runId,runLease") throw awcpHostError("awcp_invalid_request", "The AWCP Run release has unsupported fields.");
    assertToken("runId", input.runId, AWCP_LIMITS.maxRequestIdLength);
    assertRunLease(input.runLease);
    const run = this.runs.get(input.runLease);
    if (run && run.runId !== input.runId) throw awcpHostError("awcp_invalid_request", "The private AWCP Run lease does not match.");
    // Main grants these monotonically to this workspace's single operation owner.
    // A scalar watermark rejects retired identities even after their records drain.
    this.releasedThrough = Math.max(this.releasedThrough, input.runLease);
    for (const current of this.runs.values()) if (current.lease <= this.releasedThrough) {
      current.released = true;
      if (current.pending === 0) this.runs.delete(current.lease);
    }
    for (const lease of this.bindings.keys()) if (lease <= this.releasedThrough) this.bindings.delete(lease);
    await Promise.all([...this.active.values()].filter(active => active.runLease <= this.releasedThrough)
      .map(active => active.cancel(awcpHostError("site_control_unavailable", "The AWCP Run authorization ended."))));
    return { released: true };
  }

  /** Bypasses the action queue so changing an installed bridge can cancel a pending invocation. */
  async refresh(input: unknown = {}): Promise<{ refreshed: true }> {
    assertPlainRecord(input, "AWCP bridge refresh");
    if (Object.keys(input).length) throw awcpHostError("awcp_invalid_request", "The AWCP bridge refresh has unsupported fields.");
    this.configurationEpoch++; this.bindings.clear();
    for (const state of this.pages.values()) { state.epoch++; state.scriptHash = undefined; }
    await Promise.all([
      ...[...this.active.values()].map(active => active.cancel(awcpHostError("awcp_cancelled", "The website bridge configuration changed. Read its current directory."))),
      ...[...this.pages.values()].map(state => this.disposeOwned(state)),
    ]);
    return { refreshed: true };
  }

  async dispose() {
    this.closed = true;
    await this.refresh();
    for (const state of this.pages.values()) state.dispose();
    this.pages.clear(); this.runs.clear();
  }

  private async withPage<T>(tab: ChromeWorkerTab, args: Parameters, run: ChromeAwcpRunLease, generation: number, invoke: boolean, execute: (state: PageState, context: Context) => Promise<T>): Promise<T> {
    if (this.closed || this.signal.aborted) throw awcpHostError("awcp_cancelled", "The Chrome AWCP connection was released.");
    this.assertRun(args, run);
    if (generation !== this.configurationEpoch) throw awcpPreflightFailure("page_changed", "The website bridge configuration changed. Read its current directory.");
    if (this.active.has(args.requestId)) throw awcpHostError("awcp_duplicate_request", "The AWCP request id is already active.");
    if (tab.page.isClosed()) throw awcpHostError("awcp_target_unavailable", "The authorized Chrome page is unavailable.");
    if (tab.page.url() !== args.expectedUrl) throw awcpPreflightFailure("page_changed", "The Chrome page address changed before AWCP execution.");
    const state = this.watch(tab), scriptHash = createHash("sha256").update(args.bridgeScript).digest("hex");
    if (state.scriptHash !== undefined && state.scriptHash !== scriptHash) this.invalidate(state);
    state.scriptHash = scriptHash;
    const epoch = state.epoch;
    let failure: Error | undefined, dispatched = false, canceling: Promise<void> | undefined;
    let rejectLifecycle!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectLifecycle = reject; });
    void interrupted.catch(() => undefined);
    const active: Active = { runLease: run.lease, page: state.page, pageId: state.pageId, cancel: error => {
      if (!failure) { failure = error; rejectLifecycle(error); }
      if (!canceling) canceling = invoke && dispatched ? this.cancelPage(state.page, args.requestId) : Promise.resolve();
      return canceling;
    } };
    this.active.set(args.requestId, active);
    const abort = () => void active.cancel(awcpHostError("awcp_cancelled", "The Chrome AWCP request was cancelled."));
    this.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => void active.cancel(awcpHostError("awcp_transport_failed", "The Chrome AWCP request timed out; page changes may already have started.", { executionStarted: dispatched })), 35000);
    const context: Context = { epoch, check: () => {
      if (failure) throw failure;
      if (this.closed || this.signal.aborted) throw awcpHostError("awcp_cancelled", "The Chrome AWCP connection was released.");
      this.assertRun(args, run);
      if (generation !== this.configurationEpoch || state.epoch !== epoch || this.pages.get(state.pageId) !== state || state.page.url() !== args.expectedUrl)
        throw awcpHostError("awcp_navigation_interrupted", "The authorized Chrome page changed during the AWCP request.");
      if (state.page.isClosed()) throw awcpHostError("awcp_target_unavailable", "The authorized Chrome page is unavailable.");
    }, dispatch: () => { context.check(); dispatched = true; } };
    try {
      context.check();
      // Cancellation may win before a page evaluation replies. Keep its identity
      // until that actual work settles, including late injection cleanup.
      run.pending++;
      const work = Promise.resolve().then(() => execute(state, context));
      void work.then(() => this.releaseRequest(run), () => this.releaseRequest(run));
      const result = await Promise.race([work, interrupted]); context.check(); return result;
    } catch (error) {
      if (isAwcpHostError(error)) throw error;
      throw awcpHostError("awcp_transport_failed", "The authorized Chrome AWCP operation failed.", { executionStarted: dispatched });
    } finally {
      clearTimeout(timer); this.signal.removeEventListener("abort", abort);
      if (this.active.get(args.requestId) === active) this.active.delete(args.requestId);
    }
  }

  private async ensureProtocol(state: PageState, args: Parameters, context: Context) {
    let installedHandle: JSHandle<unknown> | undefined;
    try {
      context.check();
      // Capture exactly the state created by this injection in one page task.
      // A refresh may cancel us before the CDP reply arrives; the returned handle
      // still identifies only this old state and can never dispose a replacement.
      installedHandle = await state.page.evaluateHandle(`(() => {
        const __desktopAwcpBefore = globalThis.__zenmindWebsiteBridge;
        ${args.bridgeScript};
        const __desktopAwcpAfter = globalThis.__zenmindWebsiteBridge;
        return __desktopAwcpAfter != null && __desktopAwcpAfter !== __desktopAwcpBefore ? __desktopAwcpAfter : null;
      })()`); context.check();
      const installed = await installedHandle.evaluate(value => value != null); context.check();
      if (installed) {
        const previous = state.ownedBridge;
        state.ownedBridge = installedHandle; installedHandle = undefined;
        if (previous) void previous.dispose().catch(() => undefined);
      }
    } finally {
      if (installedHandle) await this.disposeHandle(installedHandle);
    }
    const probe = await state.page.evaluate(`(() => {
      const api = globalThis.awcp;
      if (api == null) return { present: false };
      const entryType = typeof api;
      if (entryType !== 'object' && entryType !== 'function') return { present: true, entryType };
      const version = api.protocolVersion;
      const actualVersion = typeof version === 'number' ? (Number.isFinite(version) ? version : 'number')
        : version === null || typeof version === 'boolean' ? version : typeof version;
      return { present: true, entryType, actualVersion, manualType: typeof api.manual, invokeType: typeof api.invoke };
    })()`); context.check();
    assertPlainRecord(probe, "AWCP protocol probe", "awcp_invalid_contract");
    if (probe.present === false) throw awcpHostError("awcp_protocol_unavailable", "The authorized Chrome page does not expose AWCP.");
    if (probe.present !== true || (probe.entryType !== "object" && probe.entryType !== "function") || probe.actualVersion === "undefined")
      throw awcpHostError("awcp_invalid_contract", "The authorized Chrome page exposes an invalid AWCP entry point.");
    if (probe.actualVersion !== AWCP_PROTOCOL_VERSION)
      throw awcpHostError("awcp_unsupported_protocol", "The authorized Chrome page exposes an unsupported AWCP version.", { supportedVersions: [AWCP_PROTOCOL_VERSION], actualVersion: probe.actualVersion });
    if (probe.manualType !== "function" || probe.invokeType !== "function")
      throw awcpHostError("awcp_invalid_contract", "The authorized Chrome page exposes an invalid AWCP entry point.");
  }

  async manual(tab: ChromeWorkerTab, input: unknown, run: ChromeAwcpRunLease, generation = this.generation()): Promise<AwcpManualResponse> {
    const args = parameters(input), payload = validateManualPayload(args.payload);
    return this.withPage(tab, args, run, generation, false, async (state, context) => {
      await this.ensureProtocol(state, args, context); context.check();
      if ("section" in payload) {
        const binding = this.binding(args.runLease, state, payload.revision);
        if (!binding.actions.has(payload.section)) throw awcpPreflightFailure("action_not_found", "The requested AWCP section is unavailable.");
      }
      const envelope = JSON.stringify(payload);
      const value = await state.page.evaluate(`globalThis.awcp.manual(JSON.parse(${JSON.stringify(envelope)}))`); context.check();
      assertJsonValue(value, "AWCP manual", "awcp_invalid_contract");
      if ("section" in payload) {
        const error = validateManualError(value, payload.section);
        if (error === "stale_revision") { this.bindings.get(args.runLease)?.delete(state.pageId); throw awcpPreflightFailure("stale_revision", "The AWCP revision changed. Read its directory again."); }
        if (error === "section_not_found") throw awcpPreflightFailure("action_not_found", "The requested AWCP section is unavailable.");
        const section = validateManualSection(value, payload.section, payload.revision);
        this.binding(args.runLease, state, payload.revision).sections.add(section.section);
        return { ok: true, method: "AWCP.getManual", ...section };
      }
      const index = validateManualIndex(value);
      let bindings = this.bindings.get(args.runLease);
      if (!bindings) { bindings = new Map(); this.bindings.set(args.runLease, bindings); }
      bindings.set(state.pageId, { page: state.page, epoch: context.epoch, revision: index.revision,
        actions: new Set(index.sections.map(section => section.section)), sections: new Set() });
      return { ok: true, method: "AWCP.getManual", ...index };
    });
  }

  async invoke(tab: ChromeWorkerTab, input: unknown, run: ChromeAwcpRunLease, generation = this.generation()): Promise<AwcpActionResponse> {
    const args = parameters(input), payload = validateInvokePayload(args.requestId, args.payload);
    return this.withPage(tab, args, run, generation, true, async (state, context) => {
      await this.ensureProtocol(state, args, context); context.check();
      const binding = this.binding(args.runLease, state, payload.revision);
      if (!binding.sections.has(payload.action)) {
        const reason = binding.actions.has(payload.action) ? "manual_required" : "action_not_found";
        throw awcpPreflightFailure(reason, reason === "manual_required" ? "Read this AWCP section before invoking it." : "The requested AWCP action is unavailable.");
      }
      const envelope = JSON.stringify({ requestId: args.requestId, ...payload });
      context.dispatch();
      const value = await state.page.evaluate(`globalThis.awcp.invoke(JSON.parse(${JSON.stringify(envelope)}))`); context.check();
      const response = validateActionResponse(value, args.requestId, payload.action);
      if (!response.ok && response.error.code === "stale_revision") this.bindings.get(args.runLease)?.delete(state.pageId);
      return response;
    });
  }
}
