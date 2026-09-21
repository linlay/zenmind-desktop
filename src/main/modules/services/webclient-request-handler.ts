import { AgentWebclientHostRecord } from "./webclient-host-types";
import http from "node:http";
import { applyDevCors, parseRequestPath, writeJSON } from "./webclient-http-utils";
import { isDesktopBridgeOnlyHttpPath } from "./webclient-host-policy";
import { createRuntimeConfigScript, readRuntimeConfig, resolveRouteTarget } from "./webclient-host-config";
import { findProxyRoute } from "./webclient-proxy-policy";
import {
  writeDisabledHttpResponse,
  writeMissingTargetHttpResponse,
  writeDisabledWebSocketUpgrade,
  resolveWebSocketRouteAccessToken
} from "./webclient-proxy-auth";
import { proxyHttpRequest } from "./webclient-http-proxy";
import { resolveFrontendRequest, sendFile } from "./webclient-static-files";
import { type Socket } from "node:net";
import { writeWebSocketProxyError, proxyWebSocketUpgrade } from "./webclient-websocket-proxy";

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
