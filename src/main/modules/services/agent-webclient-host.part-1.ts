import fs from "node:fs";

import http from "node:http";

import https from "node:https";

import net from "node:net";

import path from "node:path";

import tls from "node:tls";

import type { Socket } from "node:net";

import {
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../../../shared/contracts";

import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  ManifestDesktopDisabledResponse,
  ManifestDesktopHosting,
  ManifestDesktopProxyRoute
} from "../../../shared/contracts";

import type { ServiceDefinition } from "../../support/manifest/manifest-utils";

import { readEnvFile } from "../../infrastructure/filesystem/env-file";

import type { ServiceLayout } from "./manager/layout";

export const HOST = "127.0.0.1";

export const DEV_CORS_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

export const DEV_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export const DEV_CORS_ALLOW_HEADERS = "Content-Type, Authorization, Accept, Cache-Control";

export const DESKTOP_BRIDGE_ONLY_HTTP_PATHS = new Set([
  "/api/query",
  "/api/btw",
  "/api/attach",
  "/api/submit",
  "/api/interrupt",
  "/api/steer",
  "/api/access-level",
]);

export function isDesktopBridgeOnlyHttpPath(requestPath: string) {
  let decodedPath = requestPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    // A malformed encoded path must never be forwarded to a broader /api route.
    return requestPath.startsWith("/api/") || requestPath.startsWith("/ws");
  }
  const normalizedPath = decodedPath.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
  if (normalizedPath === "/ws" || normalizedPath.startsWith("/ws/")) {
    return true;
  }
  return [...DESKTOP_BRIDGE_ONLY_HTTP_PATHS].some(
    (pathPrefix) => normalizedPath === pathPrefix || normalizedPath.startsWith(`${pathPrefix}/`),
  );
}

export type Logger = Pick<typeof console, "error" | "warn" | "log">;

export type IssueAccessToken = (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;

export type HostManagedDesktopHosting = {
  runtimeConfigPath: string;
  runtimeConfigEnvKeys: string[];
  spaRoutePrefixes: string[];
  proxyRoutes: ManifestDesktopProxyRoute[];
};

export type AgentWebclientHostConfig = {
  service: ServiceDefinition;
  layout: ServiceLayout;
  env: Map<string, string>;
  envOverrides?: Map<string, string>;
  port: number;
  logger?: Logger;
  issueAccessToken?: IssueAccessToken;
};

export type AgentWebclientHostRecord = {
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

export type FrontendRequestResolution =
  | { type: "file"; filePath: string }
  | { type: "notFound" };

export const hosts = new Map<string, AgentWebclientHostRecord>();

export function parseRequestUrl(urlValue: string | undefined) {
  return new URL(String(urlValue || "/"), "http://127.0.0.1");
}

export function parseRequestPath(urlValue: string | undefined) {
  return parseRequestUrl(urlValue).pathname;
}

export function getHeaderValue(headers: http.IncomingHttpHeaders, key: string) {
  const value = headers[key.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function normalizeEnvUrl(value: string | undefined, fallback?: string) {
  const raw = String(value ?? "").trim() || fallback || "";
  return raw ? new URL(raw) : null;
}

export function normalizeRoutePath(routePath: string | undefined, fallback = "/") {
  const trimmed = String(routePath ?? "").trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function cloneDesktopHosting(hosting: ManifestDesktopHosting): ManifestDesktopHosting {
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

export function sortProxyRoutes(routes: ManifestDesktopProxyRoute[]) {
  return [...routes].sort((left, right) => {
    if (left.match !== right.match) {
      return left.match === "exact" ? -1 : 1;
    }
    return right.path.length - left.path.length;
  });
}

export function normalizeDesktopHosting(service: ServiceDefinition): HostManagedDesktopHosting {
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

export function getFrontendDist(service: ServiceDefinition, layout: ServiceLayout) {
  const relativeDist = service.frontend.dist || path.join("frontend", "dist");
  return path.resolve(layout.programDir, relativeDist);
}

export function getFrontendIndex(service: ServiceDefinition, frontendDist: string) {
  return path.resolve(frontendDist, service.frontend.index || "index.html");
}

export function assertHostConfig(config: AgentWebclientHostConfig) {
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

export function getEnvValue(record: AgentWebclientHostRecord, env: Map<string, string>, key: string) {
  return record.envOverrides.get(key) ?? env.get(key) ?? record.env.get(key);
}

export function resolveRouteTarget(record: AgentWebclientHostRecord, route: ManifestDesktopProxyRoute) {
  return normalizeEnvUrl(record.envOverrides.get(route.targetEnv) ?? record.env.get(route.targetEnv));
}

export function resolveRouteTargetFromEnv(
  record: AgentWebclientHostRecord,
  route: ManifestDesktopProxyRoute,
  env: Map<string, string>
) {
  return normalizeEnvUrl(getEnvValue(record, env, route.targetEnv));
}

export function isVoiceEnabled(record: AgentWebclientHostRecord, env: Map<string, string>) {
  return record.hosting.proxyRoutes.some((route) =>
    route.targetEnv === "VOICE_BASE_URL" && Boolean(resolveRouteTargetFromEnv(record, route, env))
  );
}

export function readRuntimeConfig(record: AgentWebclientHostRecord) {
  const currentEnv = readEnvFile(record.layout.envPath);
  const runtimeConfig = record.hosting.runtimeConfigEnvKeys.reduce<Record<string, string>>((result, key) => {
    result[key] = String(getEnvValue(record, currentEnv, key) ?? "").trim();
    return result;
  }, {});
  runtimeConfig.VOICE_ENABLED = String(isVoiceEnabled(record, currentEnv));
  return runtimeConfig;
}

export function createRuntimeConfigScript(runtimeConfig: Record<string, string>) {
  return `globalThis.__AGENT_WEBCLIENT_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;
}

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

export function isSseQueryRequest(urlValue: string | undefined) {
  return parseRequestPath(urlValue) === "/api/query";
}

export function isSpaRoutePath(record: AgentWebclientHostRecord, requestPath: string) {
  return record.hosting.spaRoutePrefixes.some((routePath) =>
    requestPath === routePath || requestPath.startsWith(routePath)
  );
}

export function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function resolveFrontendRequest(record: AgentWebclientHostRecord, requestPath: string): FrontendRequestResolution {
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

export function contentTypeForFile(filePath: string) {
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

export function applyDevCors(req: http.IncomingMessage, res: http.ServerResponse) {
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

export function writeJSON(res: http.ServerResponse, statusCode: number, body: unknown) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string) {
  const stats = fs.statSync(filePath);
  const basename = path.basename(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeForFile(filePath),
    "Content-Length": stats.size,
    "Cache-Control": basename === "conversation.template.html"
      ? "no-store"
      : basename === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable"
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

export function buildUpstreamUrl(target: URL, requestUrlValue: string | undefined) {
  const requestUrl = parseRequestUrl(requestUrlValue);
  const upstreamUrl = new URL(target.toString());
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;
  upstreamUrl.hash = "";
  return upstreamUrl;
}

export function getProxyRequestHeaders(
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

export function handleProxyError(
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

export function routeMatchesPath(route: ManifestDesktopProxyRoute, requestPath: string) {
  return route.match === "exact"
    ? requestPath === route.path
    : requestPath.startsWith(route.path);
}

export function findProxyRoute(
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

export function isSseProxyRequest(route: ManifestDesktopProxyRoute, urlValue: string | undefined) {
  const requestPath = parseRequestPath(urlValue);
  return Boolean(route.ssePaths?.some((ssePath) => requestPath === ssePath));
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
