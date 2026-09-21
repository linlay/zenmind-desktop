import { parseRequestPath, parseRequestUrl, getHeaderValue } from "./webclient-http-utils";
import http from "node:http";
import { type ManifestDesktopProxyRoute } from "../../../shared/contracts";
import { AgentWebclientHostRecord } from "./webclient-host-types";

export function isSseQueryRequest(urlValue: string | undefined) {
  return parseRequestPath(urlValue) === "/api/query";
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
