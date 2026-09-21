import http from "node:http";
import { getHeaderValue, parseRequestUrl, writeJSON } from "./webclient-http-utils";
import { type Socket } from "node:net";
import { Logger, AgentWebclientHostRecord } from "./webclient-host-types";
import {
  type ManifestDesktopDisabledResponse,
  type ManifestDesktopProxyRoute,
  type AgentAuthRefreshReason,
  type AgentAuthIssueResult
} from "../../../shared/contracts";

export function hasBearerWebSocketProtocol(req: http.IncomingMessage) {
  const rawProtocol = getHeaderValue(req.headers, "sec-websocket-protocol");
  return rawProtocol
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .some((item) => item.startsWith("bearer.") || item.startsWith("bearer "));
}

export function hasWebSocketAccessToken(req: http.IncomingMessage) {
  try {
    const url = parseRequestUrl(req.url);
    return Boolean(
      url.searchParams.get("token")?.trim() ||
      url.searchParams.get("access_token")?.trim() ||
      hasBearerWebSocketProtocol(req)
    );
  } catch {
    return hasBearerWebSocketProtocol(req);
  }
}

export function rejectUnauthenticatedWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: Socket,
  logger: Logger
) {
  logger.warn?.(`[agent-webclient-host] blocked unauthenticated /ws upgrade: ${req.url || "/ws"}`);
  if (!socket.destroyed) {
    try {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nunauthorized");
      return;
    } catch {
      // Ignore socket write failures before closing the unauthenticated upgrade.
    }
  }
  socket.destroy();
}

export function writeDisabledWebSocketUpgrade(
  socket: Socket,
  response: ManifestDesktopDisabledResponse | undefined
) {
  const statusCode = response?.status ?? 404;
  const statusMessage = statusCode === 404 ? "Not Found" : "Proxy Route Disabled";
  const hasJson = response && "json" in response;
  const contentType = response?.contentType || (hasJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  const payload = `${hasJson
    ? JSON.stringify(response?.json)
    : (response?.body ?? "disabled")}\n`;
  if (!socket.destroyed) {
    try {
      socket.write([
        `HTTP/1.1 ${statusCode} ${statusMessage}`,
        `Content-Type: ${contentType}`,
        `Content-Length: ${Buffer.byteLength(payload)}`,
        "",
        payload
      ].join("\r\n"), () => {
        socket.destroy();
      });
      return;
    } catch {
      // Ignore socket write failures while closing the disabled voice upgrade.
    }
  }
  socket.destroy();
}

export function writeDisabledHttpResponse(
  res: http.ServerResponse,
  response: ManifestDesktopDisabledResponse | undefined
) {
  const statusCode = response?.status ?? 404;
  if (response && "json" in response) {
    writeJSON(res, statusCode, response.json);
    return;
  }
  const payload = `${response?.body ?? "disabled"}\n`;
  res.writeHead(statusCode, {
    "Content-Type": response?.contentType || "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function writeMissingTargetHttpResponse(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ManifestDesktopProxyRoute
) {
  record.logger.error?.(
    `[agent-webclient-host] missing proxy target ${route.targetEnv} for ${req.method} ${req.url || ""}`
  );
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("upstream unavailable");
}

export async function issueRouteAccessToken(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  reason: AgentAuthRefreshReason = "missing"
) {
  if (route.auth !== "agent-platform-access-token") {
    return { ok: true, token: "", message: "" } satisfies AgentAuthIssueResult;
  }
  if (!record.issueAccessToken) {
    return {
      ok: false,
      token: "",
      message: "desktop access token issuer unavailable"
    } satisfies AgentAuthIssueResult;
  }
  return record.issueAccessToken(reason);
}

export async function resolveHttpRouteAccessToken(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  req: http.IncomingMessage
) {
  if (route.auth !== "agent-platform-access-token" || getHeaderValue(req.headers, "authorization").trim()) {
    return null;
  }
  const tokenResult = await issueRouteAccessToken(record, route);
  return tokenResult.ok && tokenResult.token.trim() ? tokenResult.token.trim() : null;
}

export async function refreshHttpRouteAccessToken(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute
) {
  const tokenResult = await issueRouteAccessToken(record, route, "unauthorized");
  return tokenResult.ok && tokenResult.token.trim() ? tokenResult.token.trim() : null;
}

export function writeHttpTokenIssueFailure(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ManifestDesktopProxyRoute
) {
  record.logger.warn?.(
    `[agent-webclient-host] blocked ${req.method} ${req.url || ""}: ${route.auth || "auth"} token unavailable`
  );
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("unauthorized");
}

export function writeWebSocketTokenIssueFailure(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  message: string
) {
  record.logger.warn?.(
    `[agent-webclient-host] blocked ${req.url || ""}: ${message}`
  );
  if (!socket.destroyed) {
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 20\r\n\r\nupstream unavailable");
    } catch {
      // Ignore socket write failures while closing the failed authenticated upgrade.
    }
    socket.destroy();
  }
}

export async function resolveWebSocketRouteAccessToken(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  req: http.IncomingMessage,
  socket: Socket
) {
  if (route.auth !== "agent-platform-access-token" || hasWebSocketAccessToken(req)) {
    return null;
  }
  const tokenResult = await issueRouteAccessToken(record, route);
  if (tokenResult.ok && tokenResult.token.trim()) {
    return tokenResult.token.trim();
  }
  if (record.issueAccessToken) {
    writeWebSocketTokenIssueFailure(record, req, socket, tokenResult.message || "desktop access token unavailable");
  } else {
    rejectUnauthenticatedWebSocketUpgrade(req, socket, record.logger);
  }
  return undefined;
}
