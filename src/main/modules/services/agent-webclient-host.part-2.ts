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

import { AgentWebclientHostConfig, AgentWebclientHostRecord, HOST, applyDevCors, assertHostConfig, buildUpstreamUrl, createRuntimeConfigScript, findProxyRoute, getHeaderValue, getProxyRequestHeaders, handleProxyError, hasWebSocketAccessToken, hosts, isDesktopBridgeOnlyHttpPath, isSseProxyRequest, isSseQueryRequest, normalizeDesktopHosting, parseRequestPath, readRuntimeConfig, refreshHttpRouteAccessToken, resolveFrontendRequest, resolveHttpRouteAccessToken, resolveRouteTarget, resolveWebSocketRouteAccessToken, sendFile, writeDisabledHttpResponse, writeDisabledWebSocketUpgrade, writeHttpTokenIssueFailure, writeJSON, writeMissingTargetHttpResponse } from "./agent-webclient-host.part-1";

export async function proxyHttpRequest(
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

export async function handleHttpRequest(record: AgentWebclientHostRecord, req: http.IncomingMessage, res: http.ServerResponse) {
  if (applyDevCors(req, res)) {
    return;
  }

  const requestPath = parseRequestPath(req.url);
  if (isDesktopBridgeOnlyHttpPath(requestPath)) {
    writeJSON(res, 404, {
      error: "desktop_realtime_bridge_required",
      message: "Agent Platform realtime and Run controls are available only through the Desktop Platform Frame Port",
    });
    return;
  }
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

export async function handleUpgrade(
  record: AgentWebclientHostRecord,
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer
) {
  const requestPath = parseRequestPath(req.url);
  if (!requestPath.startsWith("/api/voice")) {
    writeDisabledWebSocketUpgrade(socket, {
      status: 404,
      json: { error: "desktop_realtime_bridge_required" },
    });
    return;
  }
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
