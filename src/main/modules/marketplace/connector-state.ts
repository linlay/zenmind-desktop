import type {
  MarketConnectorAgentState, MarketConnectorAuthSession, MarketConnectorConnection,
  MarketConnectorDisconnectResult, MarketConnectorPreparation, MarketConnectorTokenSchema
} from "../../../shared/contracts/market-connector-state";
import { asObject, asString } from "./common";
import { callConnectorPlatform, connectorId } from "./connector-market";

const states = new Set(["not_required", "delegated", "configured", "setup_required", "unauthorized", "preparing", "pending", "authorized", "failed", "canceled"]);
function shortText(value: unknown, limit = 2048) { return asString(value).slice(0, limit); }
function safeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid connector authorization URL");
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password) throw new Error("Invalid connector authorization URL");
  return url.href;
}
export function normalizeConnectorAuth(value: unknown, id: string): MarketConnectorAuthSession {
  const raw = asObject(value);
  if (raw.connectorId !== id || !states.has(asString(raw.status)) || (raw.sessionId !== undefined && typeof raw.sessionId !== "string") || (raw.expiresAt !== undefined && typeof raw.expiresAt !== "string")) throw new Error("Invalid connector authorization response");
  const sessionId = asString(raw.sessionId), expiresAt = asString(raw.expiresAt);
  if (raw.authBrowser !== undefined && raw.authBrowser !== "embedded" && raw.authBrowser !== "system") throw new Error("Invalid connector browser policy");
  const active = raw.status === "pending" || raw.status === "preparing";
  if (active && (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !(Date.parse(expiresAt) > Date.now()))) throw new Error("Connector authorization expired");
  return { connectorId: id, sessionId, status: raw.status as MarketConnectorAuthSession["status"],
    authBrowser: raw.authBrowser as MarketConnectorAuthSession["authBrowser"], expiresAt,
    ...(active && raw.authorizationUrl ? { authorizationUrl: safeUrl(raw.authorizationUrl) } : {}),
    ...(raw.message ? { message: shortText(raw.message) } : {}) };
}
export function normalizeConnectorPreparation(value: unknown, id: string): MarketConnectorPreparation {
  const raw = asObject(value);
  if (raw.connectorId !== id || !["pending", "preparing", "ready", "failed", "canceled"].includes(asString(raw.status))) throw new Error("Invalid connector preparation response");
  return { connectorId: id, status: raw.status as MarketConnectorPreparation["status"], stage: shortText(raw.stage, 128), message: shortText(raw.message) };
}
export function normalizeConnectorConnection(value: unknown, id: string): MarketConnectorConnection {
  const raw = asObject(value), cap = asObject(raw.capabilities);
  if (raw.connectorId !== id || typeof raw.bound !== "boolean" || typeof raw.enabled !== "boolean" || (!raw.bound && raw.enabled)
      || !["not_connected", "disabled", "preparing", "authorization_required", "ready", "unavailable"].includes(asString(raw.readiness))) throw new Error("Invalid connector connection response");
  for (const key of ["canConnect", "canDisconnect", "canEnable", "hasCli", "hasMcp"]) if (typeof cap[key] !== "boolean") throw new Error("Invalid connector capabilities");
  if (cap.authMode !== null && !["token", "oneid-token", "oauth", "mcp"].includes(asString(cap.authMode))) throw new Error("Invalid connector authentication mode");
  if (cap.authBrowser !== "system" && cap.authBrowser !== "embedded") throw new Error("Invalid connector browser policy");
  return { connectorId: id, bound: raw.bound, enabled: raw.enabled, readiness: raw.readiness as MarketConnectorConnection["readiness"],
    authentication: normalizeConnectorAuth(raw.authentication, id),
    ...(raw.preparation ? { preparation: normalizeConnectorPreparation(raw.preparation, id) } : {}),
    capabilities: { canConnect: cap.canConnect as boolean, canDisconnect: cap.canDisconnect as boolean, canEnable: cap.canEnable as boolean,
      hasCli: cap.hasCli as boolean, hasMcp: cap.hasMcp as boolean, authMode: cap.authMode as MarketConnectorConnection["capabilities"]["authMode"], authBrowser: cap.authBrowser as "system" | "embedded" } };
}
export async function readConnectorConnections(): Promise<MarketConnectorConnection[]> {
  const raw = asObject(await callConnectorPlatform("/api/connectors/connection"));
  if (!Array.isArray(raw.connections) || raw.connections.length > 4096) throw new Error("Invalid connector connections response");
  return raw.connections.map(value => normalizeConnectorConnection(value, connectorId(asObject(value).connectorId)));
}
export async function readConnectorConnection(value: unknown) {
  const id = connectorId(value);
  return normalizeConnectorConnection(await callConnectorPlatform(`/api/connectors/connection?id=${encodeURIComponent(id)}`), id);
}
export async function prepareConnectorConnection(value: unknown) {
  const id = connectorId(value);
  return normalizeConnectorPreparation(await callConnectorPlatform(`/api/admin/connectors/prepare?id=${encodeURIComponent(id)}`, { method: "POST" }), id);
}
export async function startConnectorConnection(value: unknown) {
  const id = connectorId(value);
  return normalizeConnectorAuth(await callConnectorPlatform(`/api/connectors/connect?id=${encodeURIComponent(id)}`, { method: "POST" }), id);
}
export async function cancelConnectorConnection(value: unknown) {
  const raw = asObject(value), id = connectorId(raw.connectorId), sessionId = asString(raw.sessionId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid connector authorization identity");
  await callConnectorPlatform(`/api/admin/connectors/auth/cancel?${new URLSearchParams({ id, sessionId })}`, { method: "POST" });
  return readConnectorConnection(id);
}
export async function setConnectorConnectionEnabled(value: unknown) {
  const raw = asObject(value), id = connectorId(raw.connectorId);
  if (typeof raw.enabled !== "boolean") throw new Error("Explicit connector enabled state is required");
  return normalizeConnectorConnection(await callConnectorPlatform("/api/connectors/connection", { method: "PUT", body: { connectorId: id, enabled: raw.enabled } }), id);
}
export async function disconnectConnectorConnection(value: unknown): Promise<MarketConnectorDisconnectResult> {
  const id = connectorId(value);
  const raw = asObject(await callConnectorPlatform(`/api/connectors/disconnect?id=${encodeURIComponent(id)}`, { method: "POST" }));
  if (raw.connectorId !== id || raw.bound !== false || raw.enabled !== false || !["unsupported", "failed", "succeeded"].includes(asString(raw.remote_revocation))) throw new Error("Invalid connector disconnect response");
  return { connectorId: id, bound: false, enabled: false, remote_revocation: raw.remote_revocation as MarketConnectorDisconnectResult["remote_revocation"] };
}
export async function readConnectorTokenSchema(value: unknown): Promise<MarketConnectorTokenSchema> {
  const id = connectorId(value), raw = asObject(await callConnectorPlatform("/api/admin/connectors"));
  const item = Array.isArray(raw.connectors) ? raw.connectors.map(asObject).find(item => item.id === id) : undefined;
  const schema = asObject(item?.token_schema);
  if (item?.auth_mode !== "token" || !Array.isArray(schema.fields) || !schema.fields.length || schema.fields.length > 64) throw new Error("Invalid connector credential schema");
  const seen = new Set<string>();
  const fields = schema.fields.map(value => {
    const field = asObject(value), key = asString(field.key);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || seen.has(key) || !asString(field.label) || !["text", "password"].includes(asString(field.type)) || typeof field.required !== "boolean" || (field.type === "password" && field.defaultValue !== undefined)) throw new Error("Invalid connector credential field");
    seen.add(key);
    return { key, label: shortText(field.label, 128), type: field.type as "text" | "password", required: field.required,
      placeholder: shortText(field.placeholder), description: shortText(field.description),
      ...(field.type === "text" && typeof field.defaultValue === "string" ? { defaultValue: shortText(field.defaultValue) } : {}) };
  });
  return { fields, title: shortText(schema.title, 128), description: shortText(schema.description), docLabel: shortText(schema.docLabel, 128), ...(schema.docUrl ? { docUrl: safeUrl(schema.docUrl) } : {}) };
}
export async function saveConnectorCredentials(value: unknown) {
  const raw = asObject(value), id = connectorId(raw.connectorId), credentials = asObject(raw.credentials);
  if (!Object.keys(credentials).length || Object.keys(credentials).length > 64 || Buffer.byteLength(JSON.stringify(credentials)) > 65536) throw new Error("Invalid connector credentials");
  for (const [key, field] of Object.entries(credentials)) if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof field !== "string") throw new Error("Invalid connector credential value");
  await callConnectorPlatform(`/api/admin/connectors/auth?id=${encodeURIComponent(id)}`, { method: "PUT", body: { credentials } });
  return readConnectorConnection(id);
}
function normalizeAgentState(value: unknown, agentKey: string): MarketConnectorAgentState {
  const raw = asObject(value);
  if (raw.agentKey !== agentKey || typeof raw.reloadPending !== "boolean" || !Array.isArray(raw.connectorIds) || !Array.isArray(raw.activeConnectorIds)) throw new Error("Invalid connector Agent state");
  return { agentKey, connectorIds: raw.connectorIds.map(connectorId), activeConnectorIds: raw.activeConnectorIds.map(connectorId), reloadPending: raw.reloadPending };
}
function agentIdentity(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) throw new Error("Invalid Agent identity");
  return value;
}
export async function setConnectorAgent(value: unknown) {
  const raw = asObject(value), id = connectorId(raw.connectorId), agentKey = agentIdentity(raw.agentKey);
  if (typeof raw.enabled !== "boolean") throw new Error("Explicit Agent connector state is required");
  return normalizeAgentState(await callConnectorPlatform("/api/admin/agents/connectors", { method: "PUT", body: { agentKey, connectorId: id, enabled: raw.enabled } }), agentKey);
}
export async function readConnectorAgent(value: unknown) {
  const agentKey = agentIdentity(value);
  return normalizeAgentState(await callConnectorPlatform(`/api/admin/agents/connectors?agentKey=${encodeURIComponent(agentKey)}`), agentKey);
}
