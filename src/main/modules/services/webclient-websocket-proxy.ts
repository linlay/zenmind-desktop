import http from "node:http";
import { buildUpstreamUrl } from "./webclient-proxy-policy";
import { getHeaderValue } from "./webclient-http-utils";
import { AgentWebclientHostRecord } from "./webclient-host-types";
import net from "node:net";
import { type Socket } from "node:net";
import { type ManifestDesktopProxyRoute } from "../../../shared/contracts";
import tls from "node:tls";

export function targetPort(target: URL) {
  if (target.port) {
    return Number.parseInt(target.port, 10);
  }
  return target.protocol === "https:" ? 443 : 80;
}

export function buildUpgradeRequest(
  req: http.IncomingMessage,
  target: URL,
  options: { accessToken?: string | null; stripHeaders?: string[] } = {}
) {
  const upstreamUrl = buildUpstreamUrl(target, req.url);
  if (options.accessToken) {
    upstreamUrl.searchParams.set("token", options.accessToken);
  }
  const requestTarget = `${upstreamUrl.pathname}${upstreamUrl.search}`;
  const lines = [`GET ${requestTarget} HTTP/${req.httpVersion}`];
  let hasUpgrade = false;
  const stripHeaders = new Set((options.stripHeaders || []).map((header) => header.toLowerCase()));

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index] ?? "";
    const value = req.rawHeaders[index + 1] ?? "";
    const lowerName = name.toLowerCase();
    if (!name || lowerName === "host" || lowerName === "connection" || stripHeaders.has(lowerName)) {
      continue;
    }
    if (lowerName === "upgrade") {
      hasUpgrade = true;
    }
    lines.push(`${name}: ${value}`);
  }

  lines.push(`Host: ${target.host}`);
  lines.push("Connection: Upgrade");
  if (!hasUpgrade) {
    lines.push("Upgrade: websocket");
  }
  lines.push(`X-Forwarded-Host: ${getHeaderValue(req.headers, "host")}`);
  lines.push("X-Forwarded-Proto: http");
  if (req.socket.remoteAddress) {
    lines.push(`X-Forwarded-For: ${req.socket.remoteAddress}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function writeWebSocketProxyError(
  record: AgentWebclientHostRecord,
  error: Error,
  req: http.IncomingMessage,
  socket: Socket
) {
  record.logger.error?.(
    `[agent-webclient-host] websocket proxy ${req.url || ""} failed: ${error.message || String(error)}`
  );
  if (!socket.destroyed) {
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 20\r\n\r\nupstream unavailable");
    } catch {
      // Ignore socket write failures while reporting websocket proxy errors.
    }
    socket.destroy();
  }
}

export function proxyWebSocketUpgrade(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  route: ManifestDesktopProxyRoute,
  target: URL,
  options: { accessToken?: string | null } = {}
) {
  const secure = target.protocol === "https:";
  const connectOptions = {
    host: target.hostname,
    port: targetPort(target)
  };
  let connected = false;
  const onConnect = () => {
    connected = true;
    upstream.write(buildUpgradeRequest(req, target, {
      accessToken: options.accessToken,
      stripHeaders: route.stripRequestHeaders
    }));
    if (head.byteLength > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  };
  const upstream = secure
    ? tls.connect({ ...connectOptions, servername: target.hostname }, onConnect)
    : net.connect(connectOptions, onConnect);

  upstream.on("error", (error) => {
    if (!connected) {
      writeWebSocketProxyError(record, error, req, socket);
      return;
    }
    socket.destroy(error);
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
  upstream.on("close", () => {
    socket.destroy();
  });
}
