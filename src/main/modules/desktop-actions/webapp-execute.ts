import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { validateWebappExecute, WEBAPP_EXECUTE_TIMEOUT_MS, type WebappExecuteInput } from "../../../shared/webapp-execute";
import { captureWebappContext, ConnectorError, platform, probeWebappExecutionIdentity, type WebappContext } from "./webapp-platform-client";
import { selectWebappAssistantAgent } from "./webapp-assistant-agent";
import { prepareWebappChat, rememberWebappChat } from "./webapp-connector";
import { WebappExecuteError, postWebappExecute, interruptWebappExecute } from "./webapp-execute-client";

const active = new Set<{ app: object; appId: string; abort: AbortController }>();
export function stopWebappExecutions() {
  for (const request of active) request.abort.abort(new WebappExecuteError("cancelled"));
}

// Race even non-cancellable preflight APIs; their late result must never start a POST.
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason; }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function checkDeliveryContext(context: WebappContext, signal: AbortSignal) {
  try {
    await abortable(context.check(), signal);
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "desktop_identity_required") throw error;
    // Retry only the identity lookup, never execute; delivery still requires a fresh, matching identity.
    context.checkInstance();
    await delay(100, undefined, { signal });
    await abortable(context.check(), signal);
  }
}

export async function executeWebappExecute(options: DesktopActionBridgeOptions, args: unknown,
  invocation: DesktopActionInvocationContext, limits = { timeoutMs: WEBAPP_EXECUTE_TIMEOUT_MS, checkMs: 15_000 }): Promise<DesktopActionCallResponse> {
  const action = "assistant.execute";
  const requestId = randomUUID(); const startedAt = Date.now();
  let agentKey = "";
  const log = (stage: string, code: string, warning = false, details: Record<string, unknown> = {}) => {
    const record = { requestId, ...(agentKey ? { agentKey } : {}), stage, elapsedMs: Date.now() - startedAt, code, ...details };
    if (warning) console.warn("[webapp-execute]", record); else console.info("[webapp-execute]", record);
  };
  const fail = (code: string, details?: Record<string, unknown>): DesktopActionCallResponse => {
    log("result", code, true, { executionState: details?.executionState ?? "not_started" });
    return { ok: false, action, error: { code, message: `Assistant execution failed (${code}).`, ...(details ? { details } : {}) } };
  };
  if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") return fail("forbidden");
  const invalid = validateWebappExecute(args); if (invalid) return fail(invalid);
  if (active.size >= 8 || [...active].filter(item => item.app === options.app && item.appId === invocation.webappId).length >= 2) return fail("app_capacity_exceeded");
  log("accepted", "accepted");
  const abort = new AbortController();
  const entry = { app: options.app, appId: invocation.webappId, abort }; active.add(entry);
  const revoked = () => abort.abort(new WebappExecuteError("app_grant_required"));
  const disconnected = () => abort.abort(new WebappExecuteError("cancelled"));
  invocation.signal?.addEventListener("abort", revoked, { once: true });
  invocation.requestSignal?.addEventListener("abort", disconnected, { once: true });
  if (invocation.signal?.aborted) revoked();
  if (invocation.requestSignal?.aborted) disconnected();
  const timer = setTimeout(() => abort.abort(new WebappExecuteError("assistant_timeout")), limits.timeoutMs); timer.unref();
  let context: WebappContext | undefined; let sent = false; let finished = false;
  let releaseChat = () => {}; let unsubscribe = () => {}; let checking = false;
  let run: { runId: string; chatId: string; agentKey: string } | undefined;
  const interrupt = () => {
    const original = context; const target = run;
    if (!sent || finished || !original || !target) return;
    // Independent deadline/token: the execute signal is already aborted and its token may have expired.
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new WebappExecuteError("assistant_interrupt_timeout")), 3000); timeout.unref();
    void (async () => {
      log("interrupt", "interrupt_requested");
      const current = await abortable(platform(options), deadline.signal);
      original.assertIdentity(current);
      await interruptWebappExecute(current, target, randomUUID(), deadline.signal);
      log("interrupt", "interrupt_accepted");
    })().catch(error => {
      log("interrupt", deadline.signal.aborted ? "assistant_interrupt_timeout" :
        error instanceof ConnectorError && error.code === "app_grant_required" ? "assistant_interrupt_identity_changed" : "assistant_interrupt_failed", true);
    }).finally(() => clearTimeout(timeout));
  };
  abort.signal.addEventListener("abort", interrupt, { once: true });
  const checkTimer = setInterval(() => {
    if (!context || checking || abort.signal.aborted) return;
    const original = context;
    checking = true;
    void Promise.resolve().then(() => { original.checkInstance(); return probeWebappExecutionIdentity(options); })
      .then(current => { original.assertIdentity(current); original.checkInstance(); })
      .catch(error => {
        if (finished || abort.signal.aborted) return;
        if (error instanceof ConnectorError && error.code === "app_grant_required") revoked();
        else log("identity_probe", "execution_identity_probe_unavailable", true);
      }).finally(() => { checking = false; });
  }, limits.checkMs); checkTimer.unref();
  try {
    context = await abortable(captureWebappContext(options, invocation.webappId, invocation.signal), abort.signal);
    agentKey = await abortable(selectWebappAssistantAgent(options, context.item), abort.signal);
    releaseChat = prepareWebappChat(context.key);
    // Passive Primary Push only: no Run stream or page-control grant is acquired.
    unsubscribe = options.assistantBridge.observeExecuteRun(requestId, agentKey, identity => {
      if (!finished && sent && !run) run = identity;
    }, abort.signal);
    await abortable(context.check(), abort.signal);
    abort.signal.throwIfAborted(); sent = true;
    log("platform", "execute_sent");
    const input = args as WebappExecuteInput;
    const result = await abortable(postWebappExecute(context, { agentKey, message: input.message, outputSchema: input.outputSchema,
      ...(input.input === undefined ? {} : { input: input.input }), accessLevel: "ask_for_approval", requestId }, abort.signal), abort.signal);
    await checkDeliveryContext(context, abort.signal);
    abort.signal.throwIfAborted();
    rememberWebappChat(context.key, result.chatId);
    finished = true;
    log("result", result.status === "success" ? "success" : "business_failure", false, { chatId: result.chatId });
    return { ok: true, action, result };
  } catch (error) {
    const failure = abort.signal.aborted ? abort.signal.reason : error;
    if (context && failure instanceof WebappExecuteError && typeof failure.details?.chatId === "string") {
      try { await checkDeliveryContext(context, abort.signal); rememberWebappChat(context.key, failure.details.chatId); }
      catch { return fail(abort.signal.reason instanceof WebappExecuteError ? abort.signal.reason.code : "app_grant_required",
        { requestId, agentKey, executionState: sent ? "unknown" : "not_started" }); }
    }
    return fail(failure instanceof WebappExecuteError || failure instanceof ConnectorError ? failure.code : "assistant_unavailable", {
      ...(failure instanceof WebappExecuteError ? failure.details : {}), requestId,
      ...(agentKey ? { agentKey } : {}), executionState: failure instanceof WebappExecuteError && failure.details?.executionState === "not_started" ? "not_started" : sent ? "unknown" : "not_started"
    });
  } finally {
    finished = true; unsubscribe(); releaseChat(); active.delete(entry);
    clearTimeout(timer); clearInterval(checkTimer);
    invocation.signal?.removeEventListener("abort", revoked);
    invocation.requestSignal?.removeEventListener("abort", disconnected);
    abort.signal.removeEventListener("abort", interrupt);
  }
}
