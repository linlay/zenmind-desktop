import { net } from "electron";
import type { DesktopActionBridgeOptions } from "./runtime.part-1";
export class ConnectorError extends Error {
  constructor(readonly code: string) { super(code); }
}
export async function platform(options: DesktopActionBridgeOptions) {
  const state = await options.services.getResponsiveServiceState(options.app, "agent-platform");
  const baseUrl = state?.status === "running" ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "") : "";
  const issued = await options.issueAgentAccessToken(options.app, "missing");
  if (!baseUrl || !issued.ok || !issued.token) throw new ConnectorError("desktop_identity_required");
  let subject = "";
  try { subject = JSON.parse(Buffer.from(issued.token.split(".")[1], "base64url").toString()).sub; } catch { /* fail closed */ }
  if (!/^desktop-user:[0-9a-f]{64}$/u.test(subject)) throw new ConnectorError("desktop_identity_required");
  // The token is supplied by Desktop's validated identity provider. Decoding
  // here only detects identity changes; it does not authenticate a page token.
  return { baseUrl, token: issued.token, subject };
}
export async function request(baseUrl: string, token: string, path: string, method: string, body?: unknown, binary = false, signal?: AbortSignal): Promise<any> {
  const response = await net.fetch(new URL(path, baseUrl).href, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "omit", redirect: "error", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000)
  });
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectorError("invalid_platform_response");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 1024 * 1024) throw new ConnectorError(binary ? "artifact_too_large" : "invalid_platform_response"); chunks.push(value); }
  } finally { await reader.cancel(); }
  if (binary && response.ok) return { dataBase64: Buffer.concat(chunks).toString("base64") };
  let payload: any;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ConnectorError("invalid_platform_response"); }
  if (!response.ok || payload?.code !== 0) {
    const code = payload?.data?.errorCode;
    throw new ConnectorError(typeof code === "string" && /^[a-z_]{1,80}$/u.test(code) ? code : "connector_unavailable");
  }
  return payload.data;
}

const tokenIdentities = new WeakMap<AbortSignal, string>();
export async function captureWebappContext(options: DesktopActionBridgeOptions, appId: string, signal?: AbortSignal) {
  const identity = await platform(options);
  if (signal) {
    const identityKey = JSON.stringify([identity.baseUrl, identity.subject]);
    const bound = tokenIdentities.get(signal);
    if (bound && bound !== identityKey) throw new ConnectorError("app_grant_required");
    tokenIdentities.set(signal, identityKey);
  }
  const runtime = options.webs.webappRuntime.getStatus(options.app, appId);
  const item = options.webs.webappManager.list(options.app).find(value => value.id === appId);
  if (!item || runtime?.status !== "running" || signal?.aborted) throw new ConnectorError("app_grant_required");
  const fingerprint = JSON.stringify([runtime.startedAt, runtime.webUrl, item.version, item.desktopBridge, item.copilot]);
  const key = JSON.stringify([identity.baseUrl, identity.subject, appId, fingerprint]);
  async function check() {
    const current = await platform(options);
    const active = options.webs.webappRuntime.getStatus(options.app, appId);
    const installed = options.webs.webappManager.list(options.app).find(value => value.id === appId);
    if (signal?.aborted || current.subject !== identity.subject || current.baseUrl !== identity.baseUrl ||
        !installed || active?.status !== "running" ||
        JSON.stringify([active.startedAt, active.webUrl, installed.version, installed.desktopBridge, installed.copilot]) !== fingerprint) {
      throw new ConnectorError("app_grant_required");
    }
  }
  return { ...identity, appId, item, key, signal, check };
}
export type WebappContext = Awaited<ReturnType<typeof captureWebappContext>>;
