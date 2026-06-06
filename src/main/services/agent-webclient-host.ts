import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { Socket } from "node:net";
import type { ServiceDefinition } from "../manifest-utils";
import { readEnvFile } from "../env-file";
import type { ServiceLayout } from "./manager/layout";

const HOST = "127.0.0.1";
const DEFAULT_BASE_URL = "http://127.0.0.1:11949";
const DEV_CORS_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);
const DEV_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEV_CORS_ALLOW_HEADERS = "Content-Type, Authorization, Accept, Cache-Control";
const RUNTIME_CONFIG_ENV_KEYS = [
  "DESKTOP_APP",
  "DEBUG_PANEL_ENABLED",
  "DELTA_LOGS_ENABLED",
  "SETTINGS_MENU_ENABLED",
  "QUICK_ACTIONS_ENABLED",
  "VOICE_ASR_CLIENT_GATE_ENABLED",
  "VOICE_ASR_CLIENT_GATE_RMS_THRESHOLD",
  "VOICE_ASR_CLIENT_GATE_OPEN_HOLD_MS",
  "VOICE_ASR_CLIENT_GATE_CLOSE_HOLD_MS",
  "VOICE_ASR_CLIENT_GATE_PRE_ROLL_MS"
];
const SPA_ROUTE_PREFIXES = [
  "/agent/",
  "/agents/",
  "/automations",
  "/copilot",
  "/memory"
];

type Logger = Pick<typeof console, "error" | "warn" | "log">;

type AgentWebclientHostConfig = {
  service: ServiceDefinition;
  layout: ServiceLayout;
  env: Map<string, string>;
  port: number;
  logger?: Logger;
};

type AgentWebclientHostRecord = {
  serviceId: string;
  server: http.Server;
  port: number;
  webUrl: string;
  frontendDist: string;
  indexFile: string;
  layout: ServiceLayout;
  baseUrl: URL;
  voiceBaseUrl: URL | null;
  logger: Logger;
  sockets: Set<Socket>;
};

type FrontendRequestResolution =
  | { type: "file"; filePath: string }
  | { type: "notFound" };

const hosts = new Map<string, AgentWebclientHostRecord>();

function parseRequestUrl(urlValue: string | undefined) {
  return new URL(String(urlValue || "/"), "http://127.0.0.1");
}

function parseRequestPath(urlValue: string | undefined) {
  return parseRequestUrl(urlValue).pathname;
}

function getHeaderValue(headers: http.IncomingHttpHeaders, key: string) {
  const value = headers[key.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function normalizeEnvUrl(value: string | undefined, fallback?: string) {
  const raw = String(value ?? "").trim() || fallback || "";
  return raw ? new URL(raw) : null;
}

function getFrontendDist(service: ServiceDefinition, layout: ServiceLayout) {
  const relativeDist = service.frontend.dist || path.join("frontend", "dist");
  return path.resolve(layout.programDir, relativeDist);
}

function getFrontendIndex(service: ServiceDefinition, frontendDist: string) {
  return path.resolve(frontendDist, service.frontend.index || "index.html");
}

function assertHostConfig(config: AgentWebclientHostConfig) {
  if (!config.port || config.port <= 0 || config.port > 65535) {
    throw new Error("agent-webclient host requires a valid port.");
  }
  const frontendDist = getFrontendDist(config.service, config.layout);
  const indexFile = getFrontendIndex(config.service, frontendDist);
  if (!fs.existsSync(indexFile)) {
    throw new Error(`agent-webclient frontend index.html not found: ${indexFile}`);
  }
  return { frontendDist, indexFile };
}

function readRuntimeConfig(record: AgentWebclientHostRecord) {
  const currentEnv = readEnvFile(record.layout.envPath);
  const runtimeConfig = RUNTIME_CONFIG_ENV_KEYS.reduce<Record<string, string>>((result, key) => {
    result[key] = String(currentEnv.get(key) ?? "").trim();
    return result;
  }, {});
  runtimeConfig.VOICE_ENABLED = String(Boolean(record.voiceBaseUrl));
  return runtimeConfig;
}

function createRuntimeConfigScript(runtimeConfig: Record<string, string>) {
  return `globalThis.__AGENT_WEBCLIENT_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;
}

function isDesktopAppRuntime(record: AgentWebclientHostRecord) {
  const desktopAppValue = readRuntimeConfig(record).DESKTOP_APP;
  return desktopAppValue.trim().toLowerCase() === "true";
}

function hasBearerWebSocketProtocol(req: http.IncomingMessage) {
  const rawProtocol = getHeaderValue(req.headers, "sec-websocket-protocol");
  return rawProtocol
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .some((item) => item.startsWith("bearer.") || item.startsWith("bearer "));
}

function hasWebSocketAccessToken(req: http.IncomingMessage) {
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

function rejectUnauthenticatedWebSocketUpgrade(
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

function rejectVoiceDisabledWebSocketUpgrade(socket: Socket) {
  const payload = `${JSON.stringify({ error: "voice disabled" })}\n`;
  if (!socket.destroyed) {
    try {
      socket.write([
        "HTTP/1.1 404 Not Found",
        "Content-Type: application/json; charset=utf-8",
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

function isSseQueryRequest(urlValue: string | undefined) {
  return parseRequestPath(urlValue) === "/api/query";
}

function isSpaRoutePath(requestPath: string) {
  return SPA_ROUTE_PREFIXES.some((routePath) =>
    requestPath === routePath || requestPath.startsWith(routePath)
  );
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function resolveFrontendRequest(record: AgentWebclientHostRecord, requestPath: string): FrontendRequestResolution {
  const normalizedPath = parseRequestPath(requestPath);
  if (normalizedPath === "/") {
    return { type: "file", filePath: record.indexFile };
  }

  const distRoot = path.resolve(record.frontendDist);
  const decodedPath = decodePathname(normalizedPath);
  const assetPath = path.resolve(record.frontendDist, `.${decodedPath}`);
  const isInsideDist = assetPath === distRoot || assetPath.startsWith(`${distRoot}${path.sep}`);

  if (isInsideDist && fs.existsSync(assetPath)) {
    const stats = fs.statSync(assetPath);
    if (stats.isFile()) {
      return { type: "file", filePath: assetPath };
    }
    if (stats.isDirectory()) {
      const nestedIndex = path.join(assetPath, "index.html");
      if (fs.existsSync(nestedIndex)) {
        return { type: "file", filePath: nestedIndex };
      }
    }
  }

  if (path.extname(normalizedPath) && !isSpaRoutePath(normalizedPath)) {
    return { type: "notFound" };
  }

  return { type: "file", filePath: record.indexFile };
}

function contentTypeForFile(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function applyDevCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = getHeaderValue(req.headers, "origin");
  if (!DEV_CORS_ALLOWED_ORIGINS.has(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", DEV_CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", DEV_CORS_ALLOW_HEADERS);
  const currentVary = String(res.getHeader("Vary") ?? "").trim();
  res.setHeader("Vary", currentVary ? `${currentVary}, Origin` : "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function writeJSON(res: http.ServerResponse, statusCode: number, body: unknown) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string) {
  const stats = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeForFile(filePath),
    "Content-Length": stats.size,
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath)
    .on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(error instanceof Error ? error.message : String(error));
    })
    .pipe(res);
}

function buildUpstreamUrl(target: URL, requestUrlValue: string | undefined) {
  const requestUrl = parseRequestUrl(requestUrlValue);
  const upstreamUrl = new URL(target.toString());
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;
  upstreamUrl.hash = "";
  return upstreamUrl;
}

function getProxyRequestHeaders(
  req: http.IncomingMessage,
  target: URL,
  options: { sseQuery?: boolean } = {}
) {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (options.sseQuery && key.toLowerCase() === "accept-encoding") {
      continue;
    }
    headers[key] = value;
  }
  headers.host = target.host;
  headers["x-forwarded-host"] = getHeaderValue(req.headers, "host");
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  if (options.sseQuery) {
    headers["accept-encoding"] = "";
  }
  return headers;
}

function handleProxyError(
  record: AgentWebclientHostRecord,
  error: Error,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  record.logger.error?.(
    `[agent-webclient-host] reverse proxy ${req.method} ${req.url || ""} failed: ${error.message}`
  );
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  }
  if (!res.writableEnded) {
    res.end("upstream unavailable");
  }
}

function proxyHttpRequest(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL
) {
  const upstreamUrl = buildUpstreamUrl(target, req.url);
  const client = upstreamUrl.protocol === "https:" ? https : http;
  const sseQuery = isSseQueryRequest(req.url);
  const proxyReq = client.request(upstreamUrl, {
    method: req.method,
    headers: getProxyRequestHeaders(req, target, { sseQuery })
  }, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    if (
      sseQuery &&
      (proxyRes.statusCode ?? 0) >= 200 &&
      (proxyRes.statusCode ?? 0) < 300 &&
      String(proxyRes.headers["content-type"] || "").toLowerCase().startsWith("text/event-stream")
    ) {
      headers.connection = "keep-alive";
      headers["cache-control"] = "no-cache, no-transform";
      headers["x-accel-buffering"] = "no";
    }
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, headers);
    if (req.method === "HEAD") {
      res.end();
      proxyRes.resume();
      return;
    }
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    handleProxyError(record, error, req, res);
  });
  req.pipe(proxyReq);
}

function targetPort(target: URL) {
  if (target.port) {
    return Number.parseInt(target.port, 10);
  }
  return target.protocol === "https:" ? 443 : 80;
}

function buildUpgradeRequest(req: http.IncomingMessage, target: URL) {
  const upstreamUrl = buildUpstreamUrl(target, req.url);
  const requestTarget = `${upstreamUrl.pathname}${upstreamUrl.search}`;
  const lines = [`GET ${requestTarget} HTTP/${req.httpVersion}`];
  let hasUpgrade = false;

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index] ?? "";
    const value = req.rawHeaders[index + 1] ?? "";
    const lowerName = name.toLowerCase();
    if (!name || lowerName === "host" || lowerName === "connection" || lowerName === "sec-websocket-extensions") {
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

function writeWebSocketProxyError(
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

function proxyWebSocketUpgrade(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: URL
) {
  const secure = target.protocol === "https:";
  const connectOptions = {
    host: target.hostname,
    port: targetPort(target)
  };
  let connected = false;
  const onConnect = () => {
    connected = true;
    upstream.write(buildUpgradeRequest(req, target));
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

function handleHttpRequest(record: AgentWebclientHostRecord, req: http.IncomingMessage, res: http.ServerResponse) {
  if (applyDevCors(req, res)) {
    return;
  }

  const requestPath = parseRequestPath(req.url);
  if (requestPath === "/runtime-config.js" && (req.method === "GET" || req.method === "HEAD")) {
    const payload = createRuntimeConfigScript(readRuntimeConfig(record));
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload)
    });
    res.end(req.method === "HEAD" ? undefined : payload);
    return;
  }

  if (requestPath.startsWith("/api/voice")) {
    if (!record.voiceBaseUrl) {
      writeJSON(res, 404, { error: "voice disabled" });
      return;
    }
    proxyHttpRequest(record, req, res, record.voiceBaseUrl);
    return;
  }

  if (requestPath.startsWith("/api")) {
    proxyHttpRequest(record, req, res, record.baseUrl);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404);
    res.end();
    return;
  }

  const resolved = resolveFrontendRequest(record, req.url || "/");
  if (resolved.type === "notFound") {
    res.writeHead(404);
    res.end();
    return;
  }
  sendFile(req, res, resolved.filePath);
}

function handleUpgrade(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer
) {
  const requestPath = parseRequestPath(req.url);
  if (requestPath.startsWith("/api/voice")) {
    if (record.voiceBaseUrl) {
      proxyWebSocketUpgrade(record, req, socket, head, record.voiceBaseUrl);
      return;
    }
    rejectVoiceDisabledWebSocketUpgrade(socket);
    return;
  }
  if (requestPath.startsWith("/api")) {
    proxyWebSocketUpgrade(record, req, socket, head, record.baseUrl);
    return;
  }
  if (requestPath === "/ws") {
    if (isDesktopAppRuntime(record) && !hasWebSocketAccessToken(req)) {
      rejectUnauthenticatedWebSocketUpgrade(req, socket, record.logger);
      return;
    }
    proxyWebSocketUpgrade(record, req, socket, head, record.baseUrl);
    return;
  }
  socket.destroy();
}

export function isHostManagedAgentWebclientService(service: Pick<ServiceDefinition, "id" | "frontend">) {
  return service.id === "agent-webclient" && service.frontend.hostManaged === true;
}

export function getAgentWebclientHostState(serviceId = "agent-webclient") {
  const record = hosts.get(serviceId);
  return record
    ? {
        running: true,
        port: record.port,
        webUrl: record.webUrl,
        pid: process.pid
      }
    : {
        running: false,
        port: null,
        webUrl: "",
        pid: null
      };
}

export async function startAgentWebclientHost(config: AgentWebclientHostConfig) {
  const serviceId = config.service.id;
  const current = hosts.get(serviceId);
  if (current && current.port === config.port) {
    return getAgentWebclientHostState(serviceId);
  }
  if (current) {
    await stopAgentWebclientHost(serviceId);
  }

  const { frontendDist, indexFile } = assertHostConfig(config);
  const logger = config.logger || console;
  const baseUrl = normalizeEnvUrl(config.env.get("BASE_URL"), DEFAULT_BASE_URL) ?? new URL(DEFAULT_BASE_URL);
  const voiceBaseUrl = normalizeEnvUrl(config.env.get("VOICE_BASE_URL"));
  const webUrl = `http://${HOST}:${config.port}/`;
  const record: AgentWebclientHostRecord = {
    serviceId,
    server: http.createServer(),
    port: config.port,
    webUrl,
    frontendDist,
    indexFile,
    layout: config.layout,
    baseUrl,
    voiceBaseUrl,
    logger,
    sockets: new Set()
  };

  record.server.on("connection", (socket: Socket) => {
    record.sockets.add(socket);
    socket.on("close", () => {
      record.sockets.delete(socket);
    });
  });
  record.server.on("request", (req, res) => {
    try {
      handleHttpRequest(record, req, res);
    } catch (error) {
      logger.error?.(`[agent-webclient-host] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("internal server error");
    }
  });
  record.server.on("upgrade", (req, socket, head) => {
    try {
      handleUpgrade(record, req, socket as Socket, head);
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      record.server.removeListener("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      record.server.removeListener("error", handleError);
      resolve();
    };
    record.server.once("error", handleError);
    record.server.once("listening", handleListening);
    record.server.listen(config.port, HOST);
  });

  hosts.set(serviceId, record);
  logger.log?.(`[agent-webclient-host] listening on ${webUrl}`);
  return getAgentWebclientHostState(serviceId);
}

export function stopAgentWebclientHost(serviceId = "agent-webclient") {
  const record = hosts.get(serviceId);
  if (!record) {
    return Promise.resolve(getAgentWebclientHostState(serviceId));
  }
  hosts.delete(serviceId);
  return new Promise<ReturnType<typeof getAgentWebclientHostState>>((resolve) => {
    record.server.close(() => {
      resolve(getAgentWebclientHostState(serviceId));
    });
    for (const socket of record.sockets) {
      socket.destroy();
    }
  });
}

export const __testInternals = {
  createRuntimeConfigScript,
  hasWebSocketAccessToken,
  isSseQueryRequest,
  parseRequestPath,
  resolveFrontendRequest
};
