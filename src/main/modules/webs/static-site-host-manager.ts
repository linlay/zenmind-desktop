import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const HOST = "127.0.0.1";
const DEFAULT_INDEX = "index.html";
const DEFAULT_AUTO_PORT_START = 8000;
const DEFAULT_AUTO_PORT_END = 8099;
const MAX_TCP_PORT = 65535;

type PathPlatform = NodeJS.Platform | "win32" | "darwin" | "linux";

type StaticSiteHostManagerOptions = {
  autoPortStart?: number;
  autoPortEnd?: number;
};

export type StaticSiteStartRequest = {
  rootDir?: unknown;
  siteId?: unknown;
  port?: unknown;
  spa?: unknown;
  index?: unknown;
};

type StaticSiteConfig = {
  siteId: string;
  rootDir: string;
  requestedPort: number | null;
  spa: boolean;
  index: string;
};

type StaticSiteRecord = {
  config: StaticSiteConfig;
  server: http.Server | null;
  sockets: Set<net.Socket>;
  port: number | null;
  webUrl: string;
};

export type StaticSiteState = {
  siteId: string;
  rootDir: string;
  requestedPort: number | null;
  port: number | null;
  webUrl: string;
  running: boolean;
  spa: boolean;
  index: string;
};

type ResolvedStaticFile =
  | { ok: true; filePath: string; stat: fs.Stats }
  | { ok: false; status: number; message: string; allowSpaFallback?: boolean };

const MIME_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

export class StaticSiteHostError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "StaticSiteHostError";
    this.code = code;
    this.details = details;
  }
}

function isValidPort(value: number) {
  return Number.isInteger(value) && value > 0 && value <= MAX_TCP_PORT;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSiteId(value: unknown) {
  const siteId = readString(value);
  return siteId || `static-${randomUUID()}`;
}

function normalizeIndex(value: unknown) {
  const index = readString(value) || DEFAULT_INDEX;
  const normalized = index.replace(/\\/gu, "/");
  const pieces = normalized.split("/").filter(Boolean);
  if (
    pieces.length !== 1 ||
    normalized.startsWith("/") ||
    pieces.some((piece) => piece === "." || piece === ".." || piece.startsWith("."))
  ) {
    throw new StaticSiteHostError("invalid_index", "index must be a non-hidden file name under rootDir.", { index });
  }
  return pieces[0];
}

function normalizeRequestedPort(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!isValidPort(port)) {
    throw new StaticSiteHostError("invalid_port", "port must be an integer between 1 and 65535.", { port: value });
  }
  return port;
}

function getPathModule(platformValue: PathPlatform = process.platform) {
  return platformValue === "win32" ? path.win32 : path;
}

export function isPathInsideRoot(rootDir: string, targetPath: string, platformValue: PathPlatform = process.platform) {
  const pathModule = getPathModule(platformValue);
  const relative = pathModule.relative(rootDir, targetPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

function hasBlockedPathSegment(segments: string[]) {
  return segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."));
}

function decodeRequestPath(urlValue: string | undefined) {
  try {
    const parsed = new URL(String(urlValue || "/"), `http://${HOST}`);
    return decodeURIComponent(parsed.pathname || "/");
  } catch {
    return null;
  }
}

function requestPathHasExtension(requestPath: string) {
  return path.posix.extname(requestPath) !== "";
}

function splitRequestPath(requestPath: string) {
  return requestPath
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);
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

function getMimeType(filePath: string) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function writeText(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(message);
}

async function resolveFileFromCandidate(
  rootDir: string,
  candidatePath: string,
  index: string
): Promise<ResolvedStaticFile> {
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
    const indexPath = path.join(candidateRealPath, index);
    const indexRealPath = await realpathInsideRoot(rootDir, indexPath);
    if (!indexRealPath) {
      return { ok: false, status: 404, message: "not found" };
    }
    const indexStat = await statFile(indexRealPath);
    if (!indexStat?.isFile()) {
      return { ok: false, status: 404, message: "not found" };
    }
    return { ok: true, filePath: indexRealPath, stat: indexStat };
  }

  if (!stat.isFile()) {
    return { ok: false, status: 404, message: "not found" };
  }

  return { ok: true, filePath: candidateRealPath, stat };
}

async function resolveStaticFile(record: StaticSiteRecord, urlValue: string | undefined): Promise<ResolvedStaticFile> {
  const requestPath = decodeRequestPath(urlValue);
  if (requestPath === null) {
    return { ok: false, status: 400, message: "invalid request path" };
  }

  const segments = splitRequestPath(requestPath);
  if (hasBlockedPathSegment(segments)) {
    return { ok: false, status: 404, message: "not found" };
  }

  const candidatePath = path.resolve(record.config.rootDir, ...segments);
  const resolved = await resolveFileFromCandidate(record.config.rootDir, candidatePath, record.config.index);
  if (resolved.ok) {
    return resolved;
  }

  if (resolved.allowSpaFallback && record.config.spa && !requestPathHasExtension(requestPath)) {
    return resolveFileFromCandidate(
      record.config.rootDir,
      path.join(record.config.rootDir, record.config.index),
      record.config.index
    );
  }

  return resolved;
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: { filePath: string; stat: fs.Stats }) {
  const headers = {
    "Content-Type": getMimeType(file.filePath),
    "Content-Length": String(file.stat.size),
    "Cache-Control": "no-store"
  };

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(file.filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      writeText(res, 500, "internal server error");
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
}

async function handleStaticRequest(record: StaticSiteRecord, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      "Allow": "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end("method not allowed");
    return;
  }

  const resolved = await resolveStaticFile(record, req.url);
  if (!resolved.ok) {
    writeText(res, resolved.status, resolved.message);
    return;
  }
  sendFile(req, res, resolved);
}

async function listen(server: http.Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function isPortInUseError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}

function serializeState(record: StaticSiteRecord): StaticSiteState {
  return {
    siteId: record.config.siteId,
    rootDir: record.config.rootDir,
    requestedPort: record.config.requestedPort,
    port: record.port,
    webUrl: record.webUrl,
    running: Boolean(record.server),
    spa: record.config.spa,
    index: record.config.index
  };
}

export class StaticSiteHostManager {
  private readonly sites = new Map<string, StaticSiteRecord>();
  private readonly autoPortStart: number;
  private readonly autoPortEnd: number;

  constructor(options: StaticSiteHostManagerOptions = {}) {
    this.autoPortStart = options.autoPortStart ?? DEFAULT_AUTO_PORT_START;
    this.autoPortEnd = options.autoPortEnd ?? DEFAULT_AUTO_PORT_END;
  }

  list() {
    return [...this.sites.values()].map(serializeState);
  }

  async start(request: StaticSiteStartRequest) {
    const config = await this.resolveStartConfig(request);
    const existing = this.sites.get(config.siteId);
    if (existing?.server) {
      await this.stop(config.siteId);
    }

    const record: StaticSiteRecord = {
      config,
      server: null,
      sockets: new Set(),
      port: null,
      webUrl: ""
    };

    try {
      const server = await this.listenWithPortSelection(record);
      record.server = server;
      record.webUrl = `http://${HOST}:${record.port}/`;
      this.sites.set(config.siteId, record);
      return serializeState(record);
    } catch (error) {
      this.sites.delete(config.siteId);
      if (error instanceof StaticSiteHostError) {
        throw error;
      }
      throw new StaticSiteHostError("start_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async stop(siteIdValue: unknown) {
    const siteId = readString(siteIdValue);
    if (!siteId) {
      throw new StaticSiteHostError("invalid_args", "siteId is required.");
    }
    const record = this.sites.get(siteId);
    if (!record) {
      throw new StaticSiteHostError("not_found", `static site not found: ${siteId}`, { siteId });
    }
    await this.closeRecord(record);
    return serializeState(record);
  }

  async restart(siteIdValue: unknown) {
    const siteId = readString(siteIdValue);
    if (!siteId) {
      throw new StaticSiteHostError("invalid_args", "siteId is required.");
    }
    const record = this.sites.get(siteId);
    if (!record) {
      throw new StaticSiteHostError("not_found", `static site not found: ${siteId}`, { siteId });
    }
    const config = { ...record.config };
    await this.closeRecord(record);
    return this.start({
      rootDir: config.rootDir,
      siteId: config.siteId,
      port: config.requestedPort ?? undefined,
      spa: config.spa,
      index: config.index
    });
  }

  async stopAll() {
    await Promise.all([...this.sites.values()].map((record) => this.closeRecord(record)));
    return this.list();
  }

  private async resolveStartConfig(request: StaticSiteStartRequest) {
    const rootDir = readString(request.rootDir);
    if (!rootDir) {
      throw new StaticSiteHostError("invalid_args", "rootDir is required.");
    }

    const rootPath = path.resolve(rootDir);
    let rootRealPath: string;
    let rootStat: fs.Stats;
    try {
      rootRealPath = await fs.promises.realpath(rootPath);
      rootStat = await fs.promises.stat(rootRealPath);
    } catch {
      throw new StaticSiteHostError("invalid_root", `rootDir does not exist: ${rootDir}`, { rootDir });
    }
    if (!rootStat.isDirectory()) {
      throw new StaticSiteHostError("invalid_root", `rootDir is not a directory: ${rootDir}`, { rootDir });
    }

    const index = normalizeIndex(request.index);
    const indexPath = path.join(rootRealPath, index);
    const indexRealPath = await realpathInsideRoot(rootRealPath, indexPath);
    const indexStat = indexRealPath ? await statFile(indexRealPath) : null;
    if (!indexStat?.isFile()) {
      throw new StaticSiteHostError("index_not_found", `index file not found under rootDir: ${index}`, {
        rootDir: rootRealPath,
        index
      });
    }

    return {
      siteId: normalizeSiteId(request.siteId),
      rootDir: rootRealPath,
      requestedPort: normalizeRequestedPort(request.port),
      spa: request.spa === false ? false : true,
      index
    };
  }

  private createServer(record: StaticSiteRecord) {
    const server = http.createServer((req, res) => {
      handleStaticRequest(record, req, res).catch(() => {
        if (!res.headersSent) {
          writeText(res, 500, "internal server error");
          return;
        }
        res.destroy();
      });
    });
    server.on("connection", (socket) => {
      record.sockets.add(socket);
      socket.on("close", () => {
        record.sockets.delete(socket);
      });
    });
    return server;
  }

  private async tryListen(record: StaticSiteRecord, port: number) {
    const server = this.createServer(record);
    try {
      record.port = await listen(server, port);
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private async listenWithPortSelection(record: StaticSiteRecord) {
    if (record.config.requestedPort !== null) {
      try {
        return await this.tryListen(record, record.config.requestedPort);
      } catch (error) {
        if (isPortInUseError(error)) {
          throw new StaticSiteHostError("port_in_use", `port is already in use: ${record.config.requestedPort}`, {
            port: record.config.requestedPort
          });
        }
        throw error;
      }
    }

    for (let port = this.autoPortStart; port <= this.autoPortEnd; port += 1) {
      try {
        return await this.tryListen(record, port);
      } catch (error) {
        if (!isPortInUseError(error)) {
          throw error;
        }
      }
    }

    return this.tryListen(record, 0);
  }

  private closeRecord(record: StaticSiteRecord) {
    const server = record.server;
    record.server = null;
    record.port = null;
    record.webUrl = "";
    for (const socket of record.sockets) {
      socket.destroy();
    }
    record.sockets.clear();
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

export const staticSiteHostManager = new StaticSiteHostManager();

export function stopAllStaticSiteHosts() {
  return staticSiteHostManager.stopAll();
}

export const __testInternals = {
  DEFAULT_AUTO_PORT_START,
  DEFAULT_AUTO_PORT_END,
  hasBlockedPathSegment,
  isPathInsideRoot
};
