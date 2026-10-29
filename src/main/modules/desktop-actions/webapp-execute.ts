import { randomUUID } from "node:crypto";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { validateWebappExecute, WEBAPP_EXECUTE_TIMEOUT_MS, type WebappExecuteInput } from "../../../shared/webapp-execute";
import { captureWebappContext, ConnectorError, type WebappContext } from "./webapp-platform-client";
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

export async function executeWebappExecute(options: DesktopActionBridgeOptions, args: unknown,
  invocation: DesktopActionInvocationContext, limits = { timeoutMs: WEBAPP_EXECUTE_TIMEOUT_MS, checkMs: 1000 }): Promise<DesktopActionCallResponse> {
  const action = "assistant.execute";
  const fail = (code: string, details?: Record<string, unknown>): DesktopActionCallResponse =>
    ({ ok: false, action, error: { code, message: `Assistant execution failed (${code}).`, ...(details ? { details } : {}) } });
  if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") return fail("forbidden");
  const invalid = validateWebappExecute(args); if (invalid) return fail(invalid);
  if (active.size >= 8 || [...active].filter(item => item.app === options.app && item.appId === invocation.webappId).length >= 2) return fail("app_capacity_exceeded");
  const abort = new AbortController();
  const entry = { app: options.app, appId: invocation.webappId, abort }; active.add(entry);
  const revoked = () => abort.abort(new WebappExecuteError("app_grant_required"));
  const disconnected = () => abort.abort(new WebappExecuteError("cancelled"));
  invocation.signal?.addEventListener("abort", revoked, { once: true });
  invocation.requestSignal?.addEventListener("abort", disconnected, { once: true });
  if (invocation.signal?.aborted) revoked();
  if (invocation.requestSignal?.aborted) disconnected();
  const timer = setTimeout(() => abort.abort(new WebappExecuteError("assistant_timeout")), limits.timeoutMs); timer.unref();
  let context: WebappContext | undefined; let agentKey = ""; let sent = false; let finished = false;
  let releaseChat = () => {}; let unsubscribe = () => {}; let checking = false;
  let run: { runId: string; chatId: string; agentKey: string } | undefined;
  const requestId = randomUUID();
  const interrupt = () => {
    if (sent && !finished && context && run) void interruptWebappExecute(context, run, randomUUID()).catch(() => {});
  };
  abort.signal.addEventListener("abort", interrupt, { once: true });
  const checkTimer = setInterval(() => {
    if (!context || checking || abort.signal.aborted) return;
    checking = true;
    void context.check().catch(() => revoked()).finally(() => { checking = false; });
  }, limits.checkMs); checkTimer.unref();
  try {
    context = await abortable(captureWebappContext(options, invocation.webappId, invocation.signal), abort.signal);
    agentKey = await abortable(selectWebappAssistantAgent(options, context.item), abort.signal);
    releaseChat = prepareWebappChat(context.key);
    // Passive Primary Push only: no Run stream or page-control grant is acquired.
    unsubscribe = await abortable(options.assistantBridge.observeExecuteRun(requestId, agentKey, identity => {
      if (!finished && sent && !run) run = identity;
    }, abort.signal), abort.signal);
    await abortable(context.check(), abort.signal);
    abort.signal.throwIfAborted(); sent = true;
    const input = args as WebappExecuteInput;
    const result = await abortable(postWebappExecute(context, { agentKey, message: input.message, outputSchema: input.outputSchema,
      ...(input.input === undefined ? {} : { input: input.input }), accessLevel: "default", requestId }, abort.signal), abort.signal);
    await abortable(context.check(), abort.signal);
    abort.signal.throwIfAborted();
    rememberWebappChat(context.key, result.chatId);
    finished = true;
    return { ok: true, action, result };
  } catch (error) {
    const failure = abort.signal.aborted ? abort.signal.reason : error;
    if (context && failure instanceof WebappExecuteError && typeof failure.details?.chatId === "string") {
      try { await abortable(context.check(), abort.signal); rememberWebappChat(context.key, failure.details.chatId); }
      catch { return fail(abort.signal.reason instanceof WebappExecuteError ? abort.signal.reason.code : "app_grant_required"); }
    }
    return fail(failure instanceof WebappExecuteError || failure instanceof ConnectorError ? failure.code : "assistant_unavailable", {
      ...(failure instanceof WebappExecuteError ? failure.details : {}), requestId,
      ...(agentKey ? { agentKey } : {}), executionState: sent ? "unknown" : "not_started"
    });
  } finally {
    finished = true; unsubscribe(); releaseChat(); active.delete(entry);
    clearTimeout(timer); clearInterval(checkTimer);
    invocation.signal?.removeEventListener("abort", revoked);
    invocation.requestSignal?.removeEventListener("abort", disconnected);
    abort.signal.removeEventListener("abort", interrupt);
  }
}
