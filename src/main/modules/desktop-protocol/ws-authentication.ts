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

export function authenticateDesktopWsProtocolSession(
  options: DesktopWsServerOptions,
  token: string,
  subprotocol?: string
) {
  return (options.verifyToken ?? ((nextToken, nextSubprotocol) =>
    verifyDesktopAccessToken(options.app, nextToken, options.ensureIdentityCenterJwk, nextSubprotocol)))(token, subprotocol);
}

export function readAuthRefreshReason(payload: Record<string, unknown>): AgentAuthRefreshReason {
  return readText(payload.reason) === "unauthorized" ? "unauthorized" : "missing";
}

export async function issueDesktopWsRefreshAuth(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  reason: AgentAuthRefreshReason
): Promise<DesktopWsIssuedAuthRefresh> {
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
