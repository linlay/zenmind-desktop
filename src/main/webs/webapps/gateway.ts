import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { App } from "electron";
import type { WebappEntry } from "../../../shared/contracts";
import { getConfiguredDesktopActionBridgePort } from "../../desktop-action-bridge-settings";
import { resolveWebappRelativePath } from "../common";
import { isWebappActionAllowed } from "./capability-policy";
import { readWebappManifestFromDir } from "./store";
import {
  WEBAPP_BRIDGE_MODULE_PATH,
  WEBAPP_BRIDGE_MODULE_SOURCE
} from "./bridge-module";

const HOST = "127.0.0.1";
const DESKTOP_RESERVED_PREFIX = "/__desktop/";
const DESKTOP_ACTION_PATH = "/__desktop/actions/call";
export const WEBAPP_APP_CONFIG_PATH = "/__desktop/app-config.json";
const DESKTOP_ACTION_BODY_LIMIT = 64 * 1024;

export type WebappGateway = {
  server: http.Server;
  sockets: Set<net.Socket>;
  port: number;
  webUrl: string;
  close: () => Promise<void>;
};

type ResolvedStaticFile =
  | { ok: true; filePath: string; stat: fs.Stats }
  | { ok: false; status: number; message: string; allowSpaFallback?: boolean };

function writeText(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(message);
}

function writeBridgeError(
  res: http.ServerResponse,
  status: number,
  action: string,
  code: string,
  message: string,
  details?: unknown
) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify({
    ok: false,
    action: action || "unknown",
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  }));
}

function getRequestPath(urlValue: string | undefined) {
  try {
    return decodeURIComponent(new URL(String(urlValue || "/"), `http://${HOST}`).pathname || "/");
  } catch {
    return null;
  }
}

function splitRequestPath(requestPath: string) {
  return requestPath
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);
}

function hasUnsafeSegment(segments: string[]) {
  return segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."));
}

function isPathInsideRoot(rootDir: string, targetPath: string) {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function statFile(filePath: string) {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

async function realpathInsideRoot(rootDir: string, filePath: string) {
  try {
    const realPath = await fs.promises.realpath(filePath);
    return isPathInsideRoot(rootDir, realPath) ? realPath : null;
  } catch {
    return null;
  }
}

async function resolveFile(rootDir: string, candidatePath: string, index: string): Promise<ResolvedStaticFile> {
  const initialStat = await statFile(candidatePath);
  if (!initialStat) {
    return { ok: false, status: 404, message: "not found", allowSpaFallback: true };
  }
  const candidateRealPath = await realpathInsideRoot(rootDir, candidatePath);
  if (!candidateRealPath) {
    return { ok: false, status: 404, message: "not found" };
  }
  const stat = await statFile(candidateRealPath) ?? initialStat;
  if (stat.isDirectory()) {
    const indexRealPath = await realpathInsideRoot(rootDir, path.join(candidateRealPath, index));
    const indexStat = indexRealPath ? await statFile(indexRealPath) : null;
    if (!indexRealPath || !indexStat?.isFile()) {
      return { ok: false, status: 404, message: "not found" };
    }
    return { ok: true, filePath: indexRealPath, stat: indexStat };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404, message: "not found" };
  }
  return { ok: true, filePath: candidateRealPath, stat };
}

function getMimeType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
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
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: { filePath: string; stat: fs.Stats }) {
  const headers = {
    "Content-Type": getMimeType(file.filePath),
    "Content-Length": String(file.stat.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file.filePath)
    .on("error", () => {
      if (!res.headersSent) {
        writeText(res, 500, "internal server error");
      } else {
        res.destroy();
      }
    })
    .pipe(res);
}

function requestPathHasExtension(requestPath: string) {
  return path.posix.extname(requestPath) !== "";
}

async function handleStaticRequest(
  item: WebappEntry,
  webappDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Allow": "GET, HEAD", "Cache-Control": "no-store" });
    res.end("method not allowed");
    return;
  }
  const requestPath = getRequestPath(req.url);
  if (requestPath === null) {
    writeText(res, 400, "invalid request path");
    return;
  }
  const segments = splitRequestPath(requestPath);
  if (hasUnsafeSegment(segments)) {
    writeText(res, 404, "not found");
    return;
  }
  const frontendRoot = resolveWebappRelativePath(webappDir, item.frontend.root);
  const frontendRealRoot = fs.realpathSync(frontendRoot);
  const resolved = await resolveFile(
    frontendRealRoot,
    path.resolve(frontendRealRoot, ...segments),
    item.frontend.index
  );
  if (resolved.ok) {
    sendFile(req, res, resolved);
    return;
  }
  if (resolved.allowSpaFallback && item.frontend.spa && !requestPathHasExtension(requestPath)) {
    const indexResolved = await resolveFile(
      frontendRealRoot,
      path.join(frontendRealRoot, item.frontend.index),
      item.frontend.index
    );
    if (indexResolved.ok) {
      sendFile(req, res, indexResolved);
      return;
    }
  }
  writeText(res, resolved.status, resolved.message);
}

function shouldProxyRequest(item: WebappEntry, requestPath: string) {
  if (!item.backend) {
    return false;
  }
  return requestPath === item.frontend.apiPrefix ||
    requestPath.startsWith(`${item.frontend.apiPrefix}/`);
}

function resolveBackendEndpoint(backendUrl: string) {
  try {
    const url = new URL(backendUrl);
    const port = Number.parseInt(url.port, 10);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (url.protocol !== "http:" || !host || !Number.isInteger(port)) {
      return null;
    }
    return {
      host,
      port,
      hostHeader: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
    };
  } catch {
    return null;
  }
}

function proxyHttpRequest(
  backendUrl: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const backend = resolveBackendEndpoint(backendUrl);
  if (!backend) {
    writeText(res, 502, "backend not running");
    return;
  }
  const upstream = http.request({
    host: backend.host,
    port: backend.port,
    method: req.method,
    path: req.url || "/",
    headers: {
      ...req.headers,
      host: backend.hostHeader,
      "x-forwarded-host": req.headers.host ?? "",
      "x-forwarded-proto": "http"
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.on("error", () => res.destroy());
    proxyRes.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
    } else {
      writeText(res, 502, "backend unavailable");
    }
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) {
      upstream.destroy();
    }
  });
  req.pipe(upstream);
}

function proxyWebSocket(
  backendUrl: string,
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
) {
  const backend = resolveBackendEndpoint(backendUrl);
  if (!backend) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect(backend.port, backend.host);
  upstream.once("connect", () => {
    const headers = Object.entries(req.headers)
      .flatMap(([key, value]) => Array.isArray(value)
        ? value.map((entry) => `${key}: ${entry}`)
        : value === undefined ? [] : [`${key}: ${value}`]
      );
    const hostIndex = headers.findIndex((header) => header.toLowerCase().startsWith("host:"));
    if (hostIndex >= 0) {
      headers[hostIndex] = `host: ${backend.hostHeader}`;
    }
    upstream.write([
      `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`,
      ...headers,
      "",
      ""
    ].join("\r\n"));
    if (head.length > 0) {
      upstream.write(head);
    }
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  upstream.on("error", () => {
    if (!clientSocket.destroyed) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  clientSocket.on("error", () => upstream.destroy());
  clientSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    if (!clientSocket.destroyed) {
      clientSocket.destroy();
    }
  });
}

function readRequestBody(req: http.IncomingMessage, limit: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleDesktopBridgeRequest(
  options: { app: App; item: WebappEntry; pageActionToken: string },
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Allow": "POST", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const origin = String(req.headers.origin || "").trim();
  if (!origin) {
    writeBridgeError(
      res,
      403,
      "unknown",
      "forbidden",
      "Desktop actions require the local WebApp origin"
    );
    return;
  }
  try {
    const originUrl = new URL(origin);
    const host = String(req.headers.host || "").toLowerCase();
    const loopback = originUrl.protocol === "http:" &&
      (originUrl.hostname === HOST || originUrl.hostname === "localhost");
    if (!loopback || originUrl.host.toLowerCase() !== host) {
      writeBridgeError(
        res,
        403,
        "unknown",
        "forbidden",
        "Desktop actions are available only from the local WebApp origin"
      );
      return;
    }
  } catch {
    writeBridgeError(res, 403, "unknown", "forbidden", "invalid request origin");
    return;
  }
  let action = "";
  try {
    const parsed = JSON.parse(await readRequestBody(req, DESKTOP_ACTION_BODY_LIMIT)) as {
      action?: unknown;
      args?: unknown;
    };
    action = typeof parsed.action === "string" ? parsed.action : "";
    if (!isWebappActionAllowed(options.item, "localPageGateway", action)) {
      writeBridgeError(
        res,
        403,
        action,
        "forbidden",
        "action is not allowed by the local WebApp capability policy"
      );
      return;
    }
    const response = await fetch(
      `http://${HOST}:${getConfiguredDesktopActionBridgePort(options.app)}/webapps/pages/actions/call`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${options.pageActionToken}`
        },
        body: JSON.stringify({
          action,
          args: parsed.args && typeof parsed.args === "object" ? parsed.args : {}
        }),
        signal: AbortSignal.timeout(120_000)
      }
    );
    const body = await response.text();
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
  } catch (error) {
    const isInputError = error instanceof SyntaxError ||
      (error instanceof Error && error.message === "request body too large");
    writeBridgeError(
      res,
      isInputError ? 400 : 502,
      action,
      isInputError ? "invalid_request" : "bridge_unavailable",
      isInputError
        ? "Desktop Bridge request body is invalid."
        : "Desktop Action Bridge is unavailable."
    );
  }
}

function listen(server: http.Server) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, HOST);
  });
}

export async function startWebappGateway(options: {
  app: App;
  item: WebappEntry;
  webappDir: string;
  backendUrl: string;
  pageActionToken: string;
}): Promise<WebappGateway> {
  const installedManifest = readWebappManifestFromDir(options.webappDir);
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const requestPath = getRequestPath(req.url);
    if (requestPath === null) {
      writeText(res, 400, "invalid request path");
      return;
    }
    if (requestPath === WEBAPP_BRIDGE_MODULE_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Allow": "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const body = req.method === "HEAD" ? "" : WEBAPP_BRIDGE_MODULE_SOURCE;
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(WEBAPP_BRIDGE_MODULE_SOURCE)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(body);
      return;
    }
    if (requestPath === DESKTOP_ACTION_PATH) {
      void handleDesktopBridgeRequest(options, req, res);
      return;
    }
    if (requestPath === WEBAPP_APP_CONFIG_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Allow": "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const payload = JSON.stringify({
        id: installedManifest.id,
        label: installedManifest.label,
        version: installedManifest.version,
        appConfig: installedManifest.appConfig
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(payload)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(req.method === "HEAD" ? "" : payload);
      return;
    }
    if (requestPath.startsWith(DESKTOP_RESERVED_PREFIX)) {
      writeText(res, 404, "not found");
      return;
    }
    if (shouldProxyRequest(options.item, requestPath)) {
      proxyHttpRequest(options.backendUrl, req, res);
      return;
    }
    void handleStaticRequest(options.item, options.webappDir, req, res)
      .catch(() => writeText(res, 500, "internal server error"));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const requestPath = getRequestPath(req.url);
    if (
      requestPath === null ||
      requestPath.startsWith(DESKTOP_RESERVED_PREFIX) ||
      !shouldProxyRequest(options.item, requestPath)
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyWebSocket(options.backendUrl, req, socket, head);
  });
  const port = await listen(server);
  return {
    server,
    sockets,
    port,
    webUrl: `http://${HOST}:${port}/`,
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export const __gatewayTestInternals = {
  getRequestPath,
  resolveBackendEndpoint,
  shouldProxyRequest
};
