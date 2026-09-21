import { AgentWebclientHostRecord } from "./webclient-host-types";
import http from "node:http";
import { type ManifestDesktopProxyRoute } from "../../../shared/contracts";
import { buildUpstreamUrl, isSseProxyRequest, getProxyRequestHeaders } from "./webclient-proxy-policy";
import https from "node:https";
import { resolveHttpRouteAccessToken, writeHttpTokenIssueFailure, refreshHttpRouteAccessToken } from "./webclient-proxy-auth";
import { getHeaderValue, handleProxyError } from "./webclient-http-utils";

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
