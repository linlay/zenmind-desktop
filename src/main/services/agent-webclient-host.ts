import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { Socket } from "node:net";
import {
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../../shared/contracts";
import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  ManifestDesktopDisabledResponse,
  ManifestDesktopHosting,
  ManifestDesktopProxyRoute
} from "../../shared/contracts";
import type { ServiceDefinition } from "../manifest-utils";
import { readEnvFile } from "../env-file";
import type { ServiceLayout } from "./manager/layout";

const HOST = "127.0.0.1";
const DEV_CORS_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);
const DEV_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEV_CORS_ALLOW_HEADERS = "Content-Type, Authorization, Accept, Cache-Control";

type Logger = Pick<typeof console, "error" | "warn" | "log">;

type IssueAccessToken = (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;

type HostManagedDesktopHosting = {
  runtimeConfigPath: string;
  runtimeConfigEnvKeys: string[];
  spaRoutePrefixes: string[];
  proxyRoutes: ManifestDesktopProxyRoute[];
};

type AgentWebclientHostConfig = {
  service: ServiceDefinition;
  layout: ServiceLayout;
  env: Map<string, string>;
  envOverrides?: Map<string, string>;
  port: number;
  logger?: Logger;
  issueAccessToken?: IssueAccessToken;
};

type AgentWebclientHostRecord = {
  serviceId: string;
  server: http.Server;
  port: number;
  webUrl: string;
  frontendDist: string;
  indexFile: string;
  frontendSpa: boolean;
  layout: ServiceLayout;
  env: Map<string, string>;
  envOverrides: Map<string, string>;
  hosting: HostManagedDesktopHosting;
  logger: Logger;
  issueAccessToken?: IssueAccessToken;
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

function normalizeRoutePath(routePath: string | undefined, fallback = "/") {
  const trimmed = String(routePath ?? "").trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function cloneDesktopHosting(hosting: ManifestDesktopHosting): ManifestDesktopHosting {
  return {
    ...(hosting.runtimeConfig
      ? {
          runtimeConfig: {
            ...(hosting.runtimeConfig.path === undefined ? {} : { path: hosting.runtimeConfig.path }),
            ...(hosting.runtimeConfig.envKeys === undefined ? {} : { envKeys: [...hosting.runtimeConfig.envKeys] })
          }
        }
      : {}),
    ...(hosting.spaRoutes === undefined ? {} : { spaRoutes: [...hosting.spaRoutes] }),
    ...(hosting.proxyRoutes === undefined
      ? {}
      : {
          proxyRoutes: hosting.proxyRoutes.map((route) => ({
            ...route,
            ...(route.ssePaths === undefined ? {} : { ssePaths: [...route.ssePaths] }),
            ...(route.stripRequestHeaders === undefined ? {} : { stripRequestHeaders: [...route.stripRequestHeaders] }),
            ...(route.disabledResponse === undefined
              ? {}
              : {
                  disabledResponse: {
                    ...route.disabledResponse
                  }
                })
          }))
        })
  };
}

function sortProxyRoutes(routes: ManifestDesktopProxyRoute[]) {
  return [...routes].sort((left, right) => {
    if (left.match !== right.match) {
      return left.match === "exact" ? -1 : 1;
    }
    return right.path.length - left.path.length;
  });
}

function normalizeDesktopHosting(service: ServiceDefinition): HostManagedDesktopHosting {
  const serviceHosting = service.desktop?.hosting;
  const hosting = cloneDesktopHosting(
    serviceHosting || (
      service.id === "agent-webclient" && service.frontend.hostManaged === true
        ? DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
        : {}
    )
  );

  const defaultRuntimeConfig = DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING.runtimeConfig;
  return {
    runtimeConfigPath: normalizeRoutePath(hosting.runtimeConfig?.path, defaultRuntimeConfig?.path || "/runtime-config.js"),
    runtimeConfigEnvKeys: hosting.runtimeConfig?.envKeys?.length
      ? [...hosting.runtimeConfig.envKeys]
      : [...(defaultRuntimeConfig?.envKeys || [])],
    spaRoutePrefixes: hosting.spaRoutes?.map((routePath) => normalizeRoutePath(routePath)).filter(Boolean) || [],
    proxyRoutes: sortProxyRoutes(
      (hosting.proxyRoutes || []).map((route) => ({
        ...route,
        path: normalizeRoutePath(route.path),
        ssePaths: route.ssePaths?.map((routePath) => normalizeRoutePath(routePath)).filter(Boolean),
        stripRequestHeaders: route.stripRequestHeaders?.map((header) => header.trim()).filter(Boolean)
      }))
    )
  };
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

function getEnvValue(record: AgentWebclientHostRecord, env: Map<string, string>, key: string) {
  return record.envOverrides.get(key) ?? env.get(key) ?? record.env.get(key);
}

function resolveRouteTarget(record: AgentWebclientHostRecord, route: ManifestDesktopProxyRoute) {
  return normalizeEnvUrl(record.envOverrides.get(route.targetEnv) ?? record.env.get(route.targetEnv));
}

function resolveRouteTargetFromEnv(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  env: Map<string, string>
) {
  return normalizeEnvUrl(getEnvValue(record, env, route.targetEnv));
}

function isVoiceEnabled(record: AgentWebclientHostRecord, env: Map<string, string>) {
  return record.hosting.proxyRoutes.some((route) =>
    route.targetEnv === "VOICE_BASE_URL" && Boolean(resolveRouteTargetFromEnv(record, route, env))
  );
}

function readRuntimeConfig(record: AgentWebclientHostRecord) {
  const currentEnv = readEnvFile(record.layout.envPath);
  const runtimeConfig = record.hosting.runtimeConfigEnvKeys.reduce<Record<string, string>>((result, key) => {
    result[key] = String(getEnvValue(record, currentEnv, key) ?? "").trim();
    return result;
  }, {});
  runtimeConfig.VOICE_ENABLED = String(isVoiceEnabled(record, currentEnv));
  return runtimeConfig;
}

function createRuntimeConfigScript(runtimeConfig: Record<string, string>) {
  return `globalThis.__AGENT_WEBCLIENT_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;
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

function writeDisabledWebSocketUpgrade(
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

function isSseQueryRequest(urlValue: string | undefined) {
  return parseRequestPath(urlValue) === "/api/query";
}

function isSpaRoutePath(record: AgentWebclientHostRecord, requestPath: string) {
  return record.hosting.spaRoutePrefixes.some((routePath) =>
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

  if (!record.frontendSpa) {
    return { type: "notFound" };
  }

  if (path.extname(normalizedPath) && !isSpaRoutePath(record, normalizedPath)) {
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
  const configuredDevOrigin = String(process.env.VITE_DEV_SERVER_URL ?? "").replace(/\/$/u, "");
  if (!DEV_CORS_ALLOWED_ORIGINS.has(origin) && origin !== configuredDevOrigin) {
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
  options: { sseRequest?: boolean; accessToken?: string | null } = {}
) {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (options.sseRequest && key.toLowerCase() === "accept-encoding") {
      continue;
    }
    headers[key] = value;
  }
  if (options.accessToken && !getHeaderValue(req.headers, "authorization").trim()) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }
  headers.host = target.host;
  headers["x-forwarded-host"] = getHeaderValue(req.headers, "host");
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  if (options.sseRequest) {
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

function routeMatchesPath(route: ManifestDesktopProxyRoute, requestPath: string) {
  return route.match === "exact"
    ? requestPath === route.path
    : requestPath.startsWith(route.path);
}

function findProxyRoute(
  record: AgentWebclientHostRecord,
  requestPath: string,
  kind: "http" | "websocket"
) {
  return record.hosting.proxyRoutes.find((route) => {
    if (kind === "http" && route.http === false) {
      return false;
    }
    if (kind === "websocket" && route.websocket !== true) {
      return false;
    }
    return routeMatchesPath(route, requestPath);
  }) || null;
}

function isSseProxyRequest(route: ManifestDesktopProxyRoute, urlValue: string | undefined) {
  const requestPath = parseRequestPath(urlValue);
  return Boolean(route.ssePaths?.some((ssePath) => requestPath === ssePath));
}

function writeDisabledHttpResponse(
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

function writeMissingTargetHttpResponse(
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

async function issueRouteAccessToken(
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

async function resolveHttpRouteAccessToken(
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

async function refreshHttpRouteAccessToken(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute
) {
  const tokenResult = await issueRouteAccessToken(record, route, "unauthorized");
  return tokenResult.ok && tokenResult.token.trim() ? tokenResult.token.trim() : null;
}

function writeHttpTokenIssueFailure(
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

function writeWebSocketTokenIssueFailure(
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

async function resolveWebSocketRouteAccessToken(
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

async function proxyHttpRequest(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ManifestDesktopProxyRoute,
  target: URL
) {
  const upstreamUrl = buildUpstreamUrl(target, req.url);
  const client = upstreamUrl.protocol === "https:" ? https : http;
  const sseRequest = isSseProxyRequest(route, req.url);
  const accessToken = await resolveHttpRouteAccessToken(record, route, req);
  const requestHasAuthorization = Boolean(getHeaderValue(req.headers, "authorization").trim());
  if (route.auth === "agent-platform-access-token" && !accessToken && !requestHasAuthorization) {
    writeHttpTokenIssueFailure(record, req, res, route);
    return;
  }
  const canRetryUnauthorized =
    route.auth === "agent-platform-access-token" &&
    Boolean(accessToken) &&
    !requestHasAuthorization &&
    (req.method === "GET" || req.method === "HEAD");

  const forwardResponse = (proxyRes: http.IncomingMessage) => {
    const headers = { ...proxyRes.headers };
    if (
      sseRequest &&
      route.disableProxyBuffering !== false &&
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
  };

  const send = (token: string | null | undefined, allowUnauthorizedRetry: boolean) => {
    const proxyReq = client.request(upstreamUrl, {
      method: req.method,
      headers: getProxyRequestHeaders(req, target, { sseRequest, accessToken: token })
    }, (proxyRes) => {
      if (allowUnauthorizedRetry && proxyRes.statusCode === 401) {
        void refreshHttpRouteAccessToken(record, route)
          .then((nextToken) => {
            if (nextToken) {
              proxyRes.resume();
              send(nextToken, false);
              return;
            }
            forwardResponse(proxyRes);
          })
          .catch(() => {
            forwardResponse(proxyRes);
          });
        return;
      }
      forwardResponse(proxyRes);
    });

    proxyReq.on("error", (error) => {
      handleProxyError(record, error, req, res);
    });
    if (req.method === "GET" || req.method === "HEAD") {
      proxyReq.end();
      return;
    }
    req.pipe(proxyReq);
  };

  send(accessToken, canRetryUnauthorized);
}

function targetPort(target: URL) {
  if (target.port) {
    return Number.parseInt(target.port, 10);
  }
  return target.protocol === "https:" ? 443 : 80;
}

function buildUpgradeRequest(
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

async function handleHttpRequest(record: AgentWebclientHostRecord, req: http.IncomingMessage, res: http.ServerResponse) {
  if (applyDevCors(req, res)) {
    return;
  }

  const requestPath = parseRequestPath(req.url);
  if (requestPath === record.hosting.runtimeConfigPath && (req.method === "GET" || req.method === "HEAD")) {
    const payload = createRuntimeConfigScript(readRuntimeConfig(record));
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload)
    });
    res.end(req.method === "HEAD" ? undefined : payload);
    return;
  }

  const proxyRoute = findProxyRoute(record, requestPath, "http");
  if (proxyRoute) {
    const target = resolveRouteTarget(record, proxyRoute);
    if (!target) {
      if (proxyRoute.optional) {
        writeDisabledHttpResponse(res, proxyRoute.disabledResponse);
        return;
      }
      writeMissingTargetHttpResponse(record, req, res, proxyRoute);
      return;
    }
    await proxyHttpRequest(record, req, res, proxyRoute, target);
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

async function handleUpgrade(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer
) {
  const requestPath = parseRequestPath(req.url);
  const proxyRoute = findProxyRoute(record, requestPath, "websocket");
  if (proxyRoute) {
    const target = resolveRouteTarget(record, proxyRoute);
    if (!target) {
      if (proxyRoute.optional) {
        writeDisabledWebSocketUpgrade(socket, proxyRoute.disabledResponse);
        return;
      }
      writeWebSocketProxyError(record, new Error(`missing proxy target ${proxyRoute.targetEnv}`), req, socket);
      return;
    }
    const accessToken = await resolveWebSocketRouteAccessToken(record, proxyRoute, req, socket);
    if (accessToken === undefined) {
      return;
    }
    proxyWebSocketUpgrade(record, req, socket, head, proxyRoute, target, { accessToken });
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
  const hosting = normalizeDesktopHosting(config.service);
  const webUrl = `http://${HOST}:${config.port}/`;
  const record: AgentWebclientHostRecord = {
    serviceId,
    server: http.createServer(),
    port: config.port,
    webUrl,
    frontendDist,
    indexFile,
    frontendSpa: config.service.frontend.spa !== false,
    layout: config.layout,
    env: config.env,
    envOverrides: config.envOverrides ?? new Map<string, string>(),
    hosting,
    logger,
    issueAccessToken: config.issueAccessToken,
    sockets: new Set()
  };

  record.server.on("connection", (socket: Socket) => {
    record.sockets.add(socket);
    socket.on("close", () => {
      record.sockets.delete(socket);
    });
  });
  record.server.on("request", (req, res) => {
    handleHttpRequest(record, req, res).catch((error) => {
      logger.error?.(`[agent-webclient-host] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("internal server error");
    });
  });
  record.server.on("upgrade", (req, socket, head) => {
    handleUpgrade(record, req, socket as Socket, head).catch(() => {
      socket.destroy();
    });
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
