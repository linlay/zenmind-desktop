import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  WebsiteCommandResult,
  WebsiteListItem,
  WebsiteLocalAppEntry,
  WebsiteLogReadOptions,
  WebsiteLogReadResult,
  WebsiteLogTarget,
  WebsiteRuntimeState
} from "../../shared/contracts";
import { buildServiceEnv, resolveNodeBin } from "../services/manager/command-env";
import { readServiceLogFile } from "../services/manager/logs";
import { isProcessRunning, terminateProcessTree } from "../services/manager/process-cleanup";
import { pidMatchesInstallDir } from "../services/manager/process-identity";
import { delay, probeHttpUrl } from "../services/manager/service-probes";
import {
  getDesktopWebsiteLogsRoot,
  getDesktopWebsiteStateRoot
} from "../user-paths";
import {
  getWebsiteDir,
  readWebsiteItems,
  resolveWebsiteRelativePath
} from "./website-store";

const HOST = "127.0.0.1";
const STATE_FILE = "runtime.json";
const MAIN_LOG_FILE = "main.log";
const ERROR_LOG_FILE = "error.log";
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 250;

type RuntimeRecord = {
  item: WebsiteLocalAppEntry;
  websiteDir: string;
  child: ChildProcess | null;
  server: http.Server | null;
  sockets: Set<net.Socket>;
  state: WebsiteRuntimeState;
};

type ResolvedStaticFile =
  | { ok: true; filePath: string; stat: fs.Stats }
  | { ok: false; status: number; message: string; allowSpaFallback?: boolean };

function isLocalApp(item: WebsiteListItem): item is WebsiteLocalAppEntry {
  return item.kind === "local-app";
}

function nowIso() {
  return new Date().toISOString();
}

function getStatePath(app: App, websiteId: string) {
  return path.join(getDesktopWebsiteStateRoot(app, websiteId), STATE_FILE);
}

function getLogPath(app: App, websiteId: string, target: WebsiteLogTarget) {
  return path.join(getDesktopWebsiteLogsRoot(app, websiteId), target === "error" ? ERROR_LOG_FILE : MAIN_LOG_FILE);
}

function writeState(app: App, state: WebsiteRuntimeState) {
  const statePath = getStatePath(app, state.id);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readStoredState(app: App, websiteId: string): WebsiteRuntimeState | null {
  const statePath = getStatePath(app, websiteId);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<WebsiteRuntimeState>;
    if (typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      kind: "local-app",
      status: parsed.status === "running" || parsed.status === "starting" || parsed.status === "error"
        ? parsed.status
        : "stopped",
      webUrl: typeof parsed.webUrl === "string" ? parsed.webUrl : "",
      backendUrl: typeof parsed.backendUrl === "string" ? parsed.backendUrl : "",
      frontendPort: typeof parsed.frontendPort === "number" ? parsed.frontendPort : null,
      backendPort: typeof parsed.backendPort === "number" ? parsed.backendPort : null,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      message: typeof parsed.message === "string" ? parsed.message : "",
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso()
    };
  } catch {
    return null;
  }
}

function createStoppedState(item: WebsiteLocalAppEntry, message = "网站小应用未运行。"): WebsiteRuntimeState {
  return {
    id: item.id,
    kind: "local-app",
    status: "stopped",
    webUrl: "",
    backendUrl: "",
    frontendPort: null,
    backendPort: null,
    pid: null,
    message,
    updatedAt: nowIso()
  };
}

function writeLogLine(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line.endsWith("\n") ? line : `${line}\n`}`, "utf8");
}

function pipeChildLogs(app: App, websiteId: string, child: ChildProcess) {
  const mainLogPath = getLogPath(app, websiteId, "main");
  const errorLogPath = getLogPath(app, websiteId, "error");
  fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => {
    fs.appendFileSync(mainLogPath, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    fs.appendFileSync(errorLogPath, chunk);
  });
}

function getRequestPath(urlValue: string | undefined) {
  try {
    return decodeURIComponent(new URL(String(urlValue || "/"), `http://${HOST}`).pathname || "/");
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

function writeText(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(message);
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

async function handleStaticRequest(
  record: RuntimeRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      "Allow": "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
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
  const frontendRoot = resolveWebsiteRelativePath(record.websiteDir, record.item.frontend.root);
  const frontendRealRoot = fs.realpathSync(frontendRoot);
  const resolved = await resolveFile(
    frontendRealRoot,
    path.resolve(frontendRealRoot, ...segments),
    record.item.frontend.index
  );
  if (resolved.ok) {
    sendFile(req, res, resolved);
    return;
  }
  if (resolved.allowSpaFallback && record.item.frontend.spa && !requestPathHasExtension(requestPath)) {
    const indexResolved = await resolveFile(
      frontendRealRoot,
      path.join(frontendRealRoot, record.item.frontend.index),
      record.item.frontend.index
    );
    if (indexResolved.ok) {
      sendFile(req, res, indexResolved);
      return;
    }
  }
  writeText(res, resolved.status, resolved.message);
}

function shouldProxyRequest(apiPrefix: string, requestPath: string) {
  return requestPath === apiPrefix || requestPath.startsWith(`${apiPrefix}/`);
}

function proxyApiRequest(
  record: RuntimeRecord,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const backendPort = record.state.backendPort;
  if (!backendPort) {
    writeText(res, 502, "backend not running");
    return;
  }

  const upstream = http.request({
    host: HOST,
    port: backendPort,
    method: req.method,
    path: req.url || "/",
    headers: {
      ...req.headers,
      host: `${HOST}:${backendPort}`
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  upstream.on("error", (error) => {
    writeText(res, 502, error.message);
  });
  req.pipe(upstream);
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

async function reservePort(port: number) {
  const server = http.createServer();
  const resolvedPort = await listen(server, port);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return resolvedPort;
}

async function waitForBackendHealth(target: string, child: ChildProcess) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastMessage = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`后端进程已退出：${child.exitCode ?? child.signalCode ?? "unknown"}`);
    }
    const probe = await probeHttpUrl(target, { timeoutMs: 1000 });
    if (probe.ok) {
      return;
    }
    lastMessage = probe.message ?? "";
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new Error(`后端健康检查超时：${lastMessage || target}`);
}

function closeServer(record: RuntimeRecord) {
  for (const socket of record.sockets) {
    socket.destroy();
  }
  record.sockets.clear();
  if (!record.server) {
    return Promise.resolve();
  }
  const server = record.server;
  record.server = null;
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function findLocalWebsite(app: App, websiteId: string) {
  return readWebsiteItems(app).find((item): item is WebsiteLocalAppEntry =>
    item.kind === "local-app" && item.id === websiteId.trim()
  ) ?? null;
}

export class WebsiteAppRuntime {
  private readonly records = new Map<string, RuntimeRecord>();

  getStatus(app: App, websiteId: string) {
    const id = websiteId.trim();
    const record = this.records.get(id);
    if (record) {
      this.refreshRecordProcessState(app, record);
      return record.state;
    }
    const item = findLocalWebsite(app, id);
    if (!item) {
      return null;
    }
    const stored = readStoredState(app, id);
    if (stored?.pid && isProcessRunning(stored.pid)) {
      return {
        ...stored,
        status: "error",
        webUrl: "",
        message: "发现旧的网站小应用进程，但当前 Desktop 未管理它。",
        updatedAt: nowIso()
      } satisfies WebsiteRuntimeState;
    }
    return createStoppedState(item);
  }

  async start(app: App, websiteId: string): Promise<WebsiteCommandResult> {
    const id = websiteId.trim();
    const item = findLocalWebsite(app, id);
    if (!item) {
      return { ok: false, item: null, state: null, message: "未找到这个本地网站小应用。" };
    }

    const existing = this.records.get(id);
    if (existing?.state.status === "running") {
      return { ok: true, item, state: existing.state, message: `「${item.label}」已在运行。` };
    }
    if (existing) {
      await this.stop(app, id);
    }

    const websiteDir = getWebsiteDir(app, id);
    const logDir = getDesktopWebsiteLogsRoot(app, id);
    const stateDir = getDesktopWebsiteStateRoot(app, id);
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] starting ${id}`);

    let record: RuntimeRecord | null = null;
    try {
      const backendPort = item.backend.port === 0 ? await reservePort(0) : await reservePort(item.backend.port);
      const backendUrl = `http://${HOST}:${backendPort}`;
      const healthUrl = `${backendUrl}${item.backend.healthPath}`;
      const state: WebsiteRuntimeState = {
        id,
        kind: "local-app",
        status: "starting",
        webUrl: "",
        backendUrl,
        frontendPort: null,
        backendPort,
        pid: null,
        message: "正在启动网站小应用。",
        startedAt: nowIso(),
        updatedAt: nowIso()
      };
      writeState(app, state);

      const entryPath = resolveWebsiteRelativePath(websiteDir, item.backend.entry);
      const nodeBin = resolveNodeBin();
      const child = spawn(nodeBin, [entryPath, ...item.backend.args], {
        cwd: websiteDir,
        env: {
          ...buildServiceEnv(),
          ...item.backend.env,
          HOST,
          PORT: String(backendPort),
          WEBSITE_ID: id,
          WEBSITE_ROOT: websiteDir,
          WEBSITE_STATE_DIR: stateDir,
          WEBSITE_LOG_DIR: logDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      state.pid = child.pid ?? null;
      state.updatedAt = nowIso();
      writeState(app, state);
      pipeChildLogs(app, id, child);
      const childError = new Promise<never>((_resolve, reject) => {
        child.once("error", (error) => {
          writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend spawn failed: ${error.message}`);
          reject(error);
        });
      });

      const runningRecord: RuntimeRecord = {
        item,
        websiteDir,
        child,
        server: null,
        sockets: new Set(),
        state
      };
      record = runningRecord;
      this.records.set(id, runningRecord);
      child.once("exit", (code, signal) => {
        const current = this.records.get(id);
        if (!current || current.child !== child || current.state.status === "stopped") {
          return;
        }
        current.state = {
          ...current.state,
          status: "error",
          webUrl: "",
          message: `后端进程已退出：${code ?? signal ?? "unknown"}`,
          updatedAt: nowIso()
        };
        writeState(app, current.state);
        writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend exited: ${code ?? signal ?? "unknown"}`);
      });

      await Promise.race([waitForBackendHealth(healthUrl, child), childError]);
      const server = http.createServer((req, res) => {
        const requestPath = getRequestPath(req.url);
        if (requestPath !== null && shouldProxyRequest(item.frontend.apiPrefix, requestPath)) {
          proxyApiRequest(runningRecord, req, res);
          return;
        }
        handleStaticRequest(runningRecord, req, res).catch((error) => {
          writeText(res, 500, error instanceof Error ? error.message : String(error));
        });
      });
      server.on("connection", (socket) => {
        runningRecord.sockets.add(socket);
        socket.on("close", () => {
          runningRecord.sockets.delete(socket);
        });
      });
      const frontendPort = await listen(server, 0);
      runningRecord.server = server;
      runningRecord.state = {
        ...runningRecord.state,
        status: "running",
        webUrl: `http://${HOST}:${frontendPort}/`,
        frontendPort,
        message: `「${item.label}」已启动。`,
        updatedAt: nowIso()
      };
      writeState(app, runningRecord.state);
      writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] running web=${runningRecord.state.webUrl} backend=${backendUrl}`);
      return { ok: true, item, state: runningRecord.state, message: runningRecord.state.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record) {
        await this.stop(app, id, `启动失败：${message}`);
      }
      const state = {
        ...(record?.state ?? createStoppedState(item)),
        status: "error",
        webUrl: "",
        message,
        updatedAt: nowIso()
      } satisfies WebsiteRuntimeState;
      writeState(app, state);
      writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] start failed: ${message}`);
      return { ok: false, item, state, message };
    }
  }

  async stop(app: App, websiteId: string, message = "网站小应用已停止。"): Promise<WebsiteCommandResult> {
    const id = websiteId.trim();
    const item = findLocalWebsite(app, id);
    const record = this.records.get(id);
    if (record) {
      record.state = {
        ...record.state,
        status: "stopped",
        webUrl: "",
        message,
        updatedAt: nowIso()
      };
      await closeServer(record);
      if (record.child?.pid) {
        terminateProcessTree(record.child.pid);
      }
      this.records.delete(id);
      writeState(app, record.state);
      writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] stopped ${id}`);
      return { ok: true, item: item ?? record.item, state: record.state, message };
    }

    if (!item) {
      return { ok: false, item: null, state: null, message: "未找到这个本地网站小应用。" };
    }
    const stored = readStoredState(app, id);
    if (stored?.pid && isProcessRunning(stored.pid) && pidMatchesInstallDir(stored.pid, getWebsiteDir(app, id))) {
      terminateProcessTree(stored.pid);
    }
    const state = createStoppedState(item, message);
    writeState(app, state);
    return { ok: true, item, state, message };
  }

  async restart(app: App, websiteId: string) {
    await this.stop(app, websiteId);
    return this.start(app, websiteId);
  }

  async stopAll(app: App) {
    await Promise.all([...this.records.keys()].map((id) => this.stop(app, id)));
  }

  readLog(app: App, websiteId: string, target: WebsiteLogTarget, options: WebsiteLogReadOptions = {}): WebsiteLogReadResult {
    return readServiceLogFile(getLogPath(app, websiteId.trim(), target), options);
  }

  private refreshRecordProcessState(app: App, record: RuntimeRecord) {
    if (record.child && record.child.exitCode === null && record.child.signalCode === null) {
      return;
    }
    if (record.state.status === "running" || record.state.status === "starting") {
      record.state = {
        ...record.state,
        status: "error",
        webUrl: "",
        message: "网站小应用后端进程未运行。",
        updatedAt: nowIso()
      };
      writeState(app, record.state);
    }
  }
}

export const websiteAppRuntime = new WebsiteAppRuntime();

export function stopAllWebsiteApps(app: App) {
  return websiteAppRuntime.stopAll(app);
}

export const __testInternals = {
  HOST,
  HEALTH_TIMEOUT_MS,
  getRequestPath,
  shouldProxyRequest,
  reservePort
};
