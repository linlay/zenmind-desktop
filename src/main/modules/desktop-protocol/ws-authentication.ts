import http from "node:http";
import { DESKTOP_WS_HOST, DESKTOP_WS_PORT } from "../../../shared/desktop-ws";
import { readText } from "./ws-values";
import crypto from "node:crypto";
import { type App } from "electron";
import { type DesktopWsServerOptions, type DesktopWsAuthSession, type DesktopWsConnection, type DesktopWsIssuedAuthRefresh } from "./ws-contracts";
import { getDesktopDeviceId } from "../identity";
import { type AgentAuthRefreshReason } from "../../../shared/contracts";

export const AUTH_EXPIRING_WINDOW_MS = 5 * 60_000;

export const AUTH_EXPIRING_THROTTLE_MS = 60_000;

export function readTokenFromSubprotocol(req: http.IncomingMessage) {
  const rawProtocol = String(req.headers["sec-websocket-protocol"] ?? "");
  for (const candidate of rawProtocol.split(",")) {
    const protocol = candidate.trim();
    const lower = protocol.toLowerCase();
    if (lower.startsWith("bearer.")) {
      const token = protocol.slice("bearer.".length).trim();
      return token ? { token, subprotocol: protocol } : null;
    }
    if (lower.startsWith("bearer ")) {
      const token = protocol.slice("bearer ".length).trim();
      return token ? { token, subprotocol: protocol } : null;
    }
  }
  return null;
}

export function readTokenFromRequest(req: http.IncomingMessage) {
  const fromProtocol = readTokenFromSubprotocol(req);
  if (fromProtocol) {
    return fromProtocol;
  }
  const parsed = new URL(req.url || "/", `http://${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}`);
  const token = readText(parsed.searchParams.get("token"));
  return token ? { token, subprotocol: "" } : null;
}

export function decodeJwtPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function verifyRs256Jwt(token: string, publicKeyPem: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid JWT");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJwtPart(headerPart);
  if (header.alg !== "RS256") {
    throw new Error("unsupported JWT alg");
  }
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  if (!verifier.verify(publicKeyPem, Buffer.from(signaturePart, "base64url"))) {
    throw new Error("invalid JWT signature");
  }
  return decodeJwtPart(payloadPart);
}

export async function verifyDesktopAccessToken(
  app: App,
  token: string,
  ensureIdentityCenterJwk: DesktopWsServerOptions["ensureIdentityCenterJwk"],
  subprotocol?: string
): Promise<DesktopWsAuthSession> {
  const { publicKeyPem } = await ensureIdentityCenterJwk(app);
  const payload = verifyRs256Jwt(token, publicKeyPem);
  const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new Error("token expired");
  }
  const scope = readText(payload.scope);
  if (scope !== "app") {
    throw new Error("token scope must be app");
  }
  const deviceId = readText(payload.device_id) || readText(payload.deviceId);
  if (!deviceId || deviceId !== getDesktopDeviceId(app)) {
    throw new Error("token device_id does not match this Desktop");
  }
  return {
    subject: readText(payload.sub),
    deviceId,
    scope,
    expiresAt: exp * 1000,
    subprotocol
  };
}

const consumedRouteIds = new Map<string, number>();

export async function authenticateDesktopWsProtocolSession(
  options: DesktopWsServerOptions,
  token: string,
  subprotocol?: string,
  requireAccountRoute = false,
  consumeRoute = true
): Promise<DesktopWsAuthSession> {
  const routeToken = /^tr_[A-Za-z0-9_-]{43}$/.test(token);
  if (!routeToken) {
    if (requireAccountRoute) throw new Error("account route credential required");
    return (options.verifyToken ?? ((nextToken, nextSubprotocol) =>
      verifyDesktopAccessToken(options.app, nextToken, options.ensureIdentityCenterJwk, nextSubprotocol)))(token, subprotocol);
  }
  if (!options.verifyAccountRoute || !options.issueAccessToken) throw new Error("account route verifier unavailable");
  const route = await options.verifyAccountRoute(token);
  const expiresAt = Date.parse(route.expiresAt);
  const issuedAt = Date.parse(route.issuedAt);
  if (route.schemaVersion !== 1 || !route.accountId || !route.sourceDeviceId || !route.targetDesktopId ||
      !route.jti || !route.requestId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
      issuedAt > Date.now() || expiresAt <= Date.now() || expiresAt - issuedAt > 120_000) {
    throw new Error("invalid account route context");
  }
  const key = JSON.stringify([route.accountId, route.targetDesktopId, route.jti]);
  if (consumeRoute) {
    for (const [id, expiry] of consumedRouteIds) if (expiry <= Date.now()) consumedRouteIds.delete(id);
    if (consumedRouteIds.has(key) || consumedRouteIds.size >= 4096) throw new Error("route credential already consumed or capacity exceeded");
    consumedRouteIds.set(key, expiresAt);
  }
  // Remote account authorization does not replace the local Platform subject.
  const local = await options.issueAccessToken(options.app, "missing");
  if (!local.ok || !local.token) throw new Error("local Platform credential unavailable");
  const auth = await (options.verifyToken ?? ((nextToken: string) =>
    verifyDesktopAccessToken(options.app, nextToken, options.ensureIdentityCenterJwk)))(local.token);
  return { ...auth, expiresAt, subprotocol, accountRoute: { ...route, credential: token } };
}

export function validateDesktopWsConnectionRoute(options: DesktopWsServerOptions, connection: DesktopWsConnection): Promise<void> {
  if (connection.closed || connection.auth.expiresAt <= Date.now()) return Promise.reject(new Error("session expired"));
  const auth = connection.auth;
  if (!auth.accountRoute || Date.now() - connection.routeValidatedAt < 10_000) return Promise.resolve();
  if (!connection.routeValidation) {
    connection.routeValidation = (async () => {
      if (!options.verifyAccountRoute) throw new Error("account route verifier unavailable");
      const route = await options.verifyAccountRoute(auth.accountRoute!.credential);
      if (connection.closed || connection.auth !== auth || route.accountId !== auth.accountRoute!.accountId ||
          route.sourceDeviceId !== auth.accountRoute!.sourceDeviceId || route.targetDesktopId !== auth.accountRoute!.targetDesktopId ||
          route.jti !== auth.accountRoute!.jti || Date.parse(route.expiresAt) <= Date.now()) throw new Error("account route changed");
      connection.routeValidatedAt = Date.now();
    })().finally(() => { connection.routeValidation = null; });
  }
  return connection.routeValidation;
}

export function readAuthRefreshReason(payload: Record<string, unknown>): AgentAuthRefreshReason {
  return readText(payload.reason) === "unauthorized" ? "unauthorized" : "missing";
}

export async function issueDesktopWsRefreshAuth(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  reason: AgentAuthRefreshReason
): Promise<DesktopWsIssuedAuthRefresh> {
  if (connection.auth.accountRoute) throw new Error("fresh account route credential required");
  if (!options.issueAccessToken) {
    throw new Error("Desktop WS token issuer is not configured");
  }
  const tokenResult = await options.issueAccessToken(options.app, reason);
  const token = readText(tokenResult.token);
  if (!tokenResult.ok || !token) {
    throw new Error(tokenResult.message || "Desktop WS token unavailable");
  }
  const auth = await authenticateDesktopWsProtocolSession(options, token, connection.auth.subprotocol);
  connection.auth = auth;
  return { token, auth };
}

export function refreshDesktopWsConnectionAuth(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  reason: AgentAuthRefreshReason
) {
  if (!connection.authRefresh) {
    connection.authRefresh = issueDesktopWsRefreshAuth(options, connection, reason).finally(() => {
      connection.authRefresh = null;
    });
  }
  return connection.authRefresh;
}
