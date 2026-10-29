import { net } from "electron";
import { WEBAPP_EXECUTE_RESPONSE_BYTES, isExecuteRecord, type WebappExecuteResult } from "../../../shared/webapp-execute";
import { getMainLocale } from "../../support/i18n/main-i18n";

export class WebappExecuteError extends Error {
  constructor(readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}
const errors: Record<string, string> = {
  invalid_request: "invalid_args", unknown_field: "invalid_args",
  result_submit_unavailable: "assistant_agent_unsupported", execute_unsupported_agent: "assistant_agent_unsupported",
  agent_not_found: "assistant_agent_unavailable", approval_required: "approval_required",
  output_missing: "output_missing", output_invalid: "output_invalid", cancelled: "cancelled", run_error: "assistant_failed"
};
export type ExecuteIdentity = { baseUrl: string; token: string };
export function executeHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "X-Locale": getMainLocale() };
}
export async function postWebappExecute(identity: ExecuteIdentity, body: unknown, signal: AbortSignal): Promise<WebappExecuteResult> {
  const response = await net.fetch(new URL("/api/execute", identity.baseUrl).href, {
    method: "POST", headers: executeHeaders(identity.token), body: JSON.stringify(body),
    credentials: "omit", redirect: "error", cache: "no-store", signal
  });
  const reader = response.body?.getReader();
  if (!reader) throw new WebappExecuteError("invalid_platform_response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > WEBAPP_EXECUTE_RESPONSE_BYTES) throw new WebappExecuteError("assistant_result_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebappExecuteError(response.status === 404 ? "assistant_execute_unavailable" : "invalid_platform_response"); }
  if (!isExecuteRecord(payload)) throw new WebappExecuteError("invalid_platform_response");
  const data = isExecuteRecord(payload.data) ? payload.data : {};
  if (!response.ok || payload.code !== 0) {
    const error = isExecuteRecord(data.error) ? data.error : {};
    const platformCode = typeof error.code === "string" && Object.hasOwn(errors, error.code) ? error.code : "";
    throw new WebappExecuteError(platformCode ? errors[platformCode] : response.status === 404 ? "assistant_execute_unavailable" : "assistant_unavailable", {
      ...(platformCode ? { platformCode } : {}), httpStatus: response.status,
      ...(typeof data.chatId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(data.chatId) && platformCode ? { chatId: data.chatId } : {})
    });
  }
  if (typeof data.chatId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(data.chatId)) throw new WebappExecuteError("invalid_platform_response");
  if (data.status === "success" && isExecuteRecord(data.output)) return { chatId: data.chatId, status: "success", output: data.output };
  if (data.status === "failure" && typeof data.reason === "string" && data.reason.trim()) return { chatId: data.chatId, status: "failure", reason: data.reason };
  throw new WebappExecuteError("invalid_platform_response");
}

// HTTP-created Runs must be interrupted over HTTP, never through the WS stopRun path.
export async function interruptWebappExecute(identity: ExecuteIdentity, run: { runId: string; chatId: string; agentKey: string }, requestId: string) {
  const response = await net.fetch(new URL("/api/interrupt", identity.baseUrl).href, {
    method: "POST", headers: executeHeaders(identity.token), body: JSON.stringify({ ...run, requestId }),
    credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000)
  });
  await response.body?.cancel();
}
