import http from "node:http";
import { DEV_CORS_ALLOWED_ORIGINS, DEV_CORS_ALLOW_METHODS, DEV_CORS_ALLOW_HEADERS } from "./webclient-host-policy";
import { AgentWebclientHostRecord } from "./webclient-host-types";

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
