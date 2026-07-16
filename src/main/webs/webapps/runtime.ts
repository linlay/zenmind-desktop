import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  WebappCommandResult,
  WebappEntry,
  WebappLogReadOptions,
  WebappLogReadResult,
  WebappLogTarget,
  WebappRuntimeState
} from "../../../shared/contracts";
import { buildServiceEnv, resolveNodeBin } from "../../services/manager/command-env";
import { readServiceLogFile } from "../../services/manager/logs";
import { isProcessRunning, terminateProcessTree } from "../../services/manager/process-cleanup";
import { pidMatchesInstallDir } from "../../services/manager/process-identity";
import { delay, probeHttpUrl } from "../../services/manager/service-probes";
import {
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot
} from "../../user-paths";
import { resolveWebappRelativePath } from "../common";
import {
  getWebappDir,
  readWebappItems
} from "./store";
import { syncPublishedWebappRoute } from "./publisher";
import { t } from "../../i18n/main-i18n";
import { getConfiguredDesktopActionBridgePort } from "../../desktop-action-bridge-settings";

const HOST = "127.0.0.1";
const STATE_FILE = "runtime.json";
const MAIN_LOG_FILE = "main.log";
const ERROR_LOG_FILE = "error.log";
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 250;
const DESKTOP_ASSISTANT_PATH = "/__desktop/actions/call";
const DESKTOP_ASSISTANT_ACTIONS = new Set([
  "desktop.assistant.complete",
  "desktop.assistant.translate"
]);
const DESKTOP_ASSISTANT_BODY_LIMIT = 64 * 1024;

type RuntimeRecord = {
  item: WebappEntry;
  webappDir: string;
  child: ChildProcess | null;
  server: http.Server | null;
  sockets: Set<net.Socket>;
  state: WebappRuntimeState;
};

type ResolvedStaticFile =
  | { ok: true; filePath: string; stat: fs.Stats }
  | { ok: false; status: number; message: string; allowSpaFallback?: boolean };

function nowIso() {
  return new Date().toISOString();
}

function getStatePath(app: App, webappId: string) {
  return path.join(getDesktopWebappStateRoot(app, webappId), STATE_FILE);
}

function getLogPath(app: App, webappId: string, target: WebappLogTarget) {
  return path.join(getDesktopWebappLogsRoot(app, webappId), target === "error" ? ERROR_LOG_FILE : MAIN_LOG_FILE);
}

function writeState(app: App, state: WebappRuntimeState) {
  const statePath = getStatePath(app, state.id);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readStoredState(app: App, webappId: string): WebappRuntimeState | null {
  const statePath = getStatePath(app, webappId);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<WebappRuntimeState>;
    if (typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      entryKey: typeof parsed.entryKey === "string" && parsed.entryKey.startsWith("webapp:")
        ? parsed.entryKey as `webapp:${string}`
        : `webapp:${parsed.id}`,
      kind: "webapp",
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

function createStoppedState(item: WebappEntry, message = t("service.currentlyNotRunning", { name: t("settings.websites.label") })): WebappRuntimeState {
  return {
    id: item.id,
    entryKey: item.entryKey,
    kind: "webapp",
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

function pipeChildLogs(app: App, webappId: string, child: ChildProcess) {
  const mainLogPath = getLogPath(app, webappId, "main");
  const errorLogPath = getLogPath(app, webappId, "error");
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

async function handleDesktopAssistantRequest(
  app: App,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Allow": "POST", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const host = String(req.headers.host || "").toLowerCase();
      const originHost = originUrl.host.toLowerCase();
      const loopback = originUrl.protocol === "http:" &&
        (originUrl.hostname === HOST || originUrl.hostname === "localhost");
      if (!loopback || originHost !== host) {
        writeText(res, 403, "Desktop assistant actions are available only from the local WebApp origin");
        return;
      }
    } catch {
      writeText(res, 403, "invalid request origin");
      return;
    }
  }
  try {
    const parsed = JSON.parse(await readRequestBody(req, DESKTOP_ASSISTANT_BODY_LIMIT)) as {
      action?: unknown;
      args?: unknown;
    };
    const action = typeof parsed.action === "string" ? parsed.action : "";
    if (!DESKTOP_ASSISTANT_ACTIONS.has(action)) {
      writeText(res, 403, "only Desktop assistant actions are allowed");
      return;
    }
    const response = await fetch(
      `http://${HOST}:${getConfiguredDesktopActionBridgePort(app)}/actions/call`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
          permissionMode: "full_access"
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
    writeText(res, 502, error instanceof Error ? error.message : String(error));
  }
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
  const frontendRoot = resolveWebappRelativePath(record.webappDir, record.item.frontend.root);
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
      throw new Error(t("service.processExited", { reason: child.exitCode ?? child.signalCode ?? "unknown" }));
    }
    const probe = await probeHttpUrl(target, { timeoutMs: 1000 });
    if (probe.ok) {
      return;
    }
    lastMessage = probe.message ?? "";
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new Error(t("service.healthTimeout", { message: lastMessage || target }));
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

function findWebapp(app: App, webappId: string) {
  return readWebappItems(app).find((item) => item.id === webappId.trim()) ?? null;
}

export class WebappRuntime {
  private readonly records = new Map<string, RuntimeRecord>();

  getStatus(app: App, webappId: string) {
    const id = webappId.trim();
    const record = this.records.get(id);
    if (record) {
      this.refreshRecordProcessState(app, record);
      return record.state;
    }
    const item = findWebapp(app, id);
    if (!item) {
      return null;
    }
    const stored = readStoredState(app, id);
    if (stored?.pid && isProcessRunning(stored.pid)) {
      return {
        ...stored,
        status: "error",
        webUrl: "",
        message: t("service.runningUnmanagedProcess"),
        updatedAt: nowIso()
      } satisfies WebappRuntimeState;
    }
    return createStoppedState(item);
  }

  async start(app: App, webappId: string): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id);
    if (!item) {
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }

    const existing = this.records.get(id);
    if (existing?.state.status === "running") {
      return { ok: true, item, state: existing.state, message: t("webapp.alreadyRunning", { label: item.label }) };
    }
    if (existing) {
      await this.stop(app, id);
    }

    const webappDir = getWebappDir(app, id);
    const logDir = getDesktopWebappLogsRoot(app, id);
    const stateDir = getDesktopWebappStateRoot(app, id);
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] starting ${id}`);

    let record: RuntimeRecord | null = null;
    try {
      if (!item.backend) {
        const state: WebappRuntimeState = {
          id,
          entryKey: item.entryKey,
          kind: "webapp",
          status: "starting",
          webUrl: "",
          backendUrl: "",
          frontendPort: null,
          backendPort: null,
          pid: null,
          message: t("webapp.starting"),
          startedAt: nowIso(),
          updatedAt: nowIso()
        };
        const staticRecord: RuntimeRecord = {
          item,
          webappDir,
          child: null,
          server: null,
          sockets: new Set(),
          state
        };
        record = staticRecord;
        this.records.set(id, staticRecord);
        writeState(app, state);
        const server = http.createServer((req, res) => {
          const requestPath = getRequestPath(req.url);
          if (requestPath === DESKTOP_ASSISTANT_PATH) {
            void handleDesktopAssistantRequest(app, req, res);
            return;
          }
          handleStaticRequest(staticRecord, req, res).catch((error) => {
            writeText(res, 500, error instanceof Error ? error.message : String(error));
          });
        });
        server.on("connection", (socket) => {
          staticRecord.sockets.add(socket);
          socket.on("close", () => staticRecord.sockets.delete(socket));
        });
        const frontendPort = await listen(server, 0);
        staticRecord.server = server;
        staticRecord.state = {
          ...staticRecord.state,
          status: "running",
          webUrl: `http://${HOST}:${frontendPort}/`,
          frontendPort,
          message: t("webapp.started", { label: item.label }),
          updatedAt: nowIso()
        };
        writeState(app, staticRecord.state);
        writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] running web=${staticRecord.state.webUrl} backend=none`);
        void syncPublishedWebappRoute(app, item, staticRecord.state);
        return { ok: true, item, state: staticRecord.state, message: staticRecord.state.message };
      }
      const backendPort = item.backend.port === 0 ? await reservePort(0) : await reservePort(item.backend.port);
      const backendUrl = `http://${HOST}:${backendPort}`;
      const healthUrl = `${backendUrl}${item.backend.healthPath}`;
      const state: WebappRuntimeState = {
        id,
        entryKey: item.entryKey,
        kind: "webapp",
        status: "starting",
        webUrl: "",
        backendUrl,
        frontendPort: null,
        backendPort,
        pid: null,
        message: t("webapp.starting"),
        startedAt: nowIso(),
        updatedAt: nowIso()
      };
      writeState(app, state);

      const entryPath = resolveWebappRelativePath(webappDir, item.backend.entry);
      const nodeBin = resolveNodeBin();
      const child = spawn(nodeBin, [entryPath, ...item.backend.args], {
        cwd: webappDir,
        env: {
          ...buildServiceEnv(),
          ...item.backend.env,
          HOST,
          PORT: String(backendPort),
          WEBAPP_ID: id,
          WEBAPP_ROOT: webappDir,
          WEBAPP_STATE_DIR: stateDir,
          WEBAPP_LOG_DIR: logDir,
          DESKTOP_ACTION_BRIDGE_URL: `http://${HOST}:${getConfiguredDesktopActionBridgePort(app)}`
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
        webappDir,
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
          message: t("service.processExited", { reason: code ?? signal ?? "unknown" }),
          updatedAt: nowIso()
        };
        writeState(app, current.state);
        writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend exited: ${code ?? signal ?? "unknown"}`);
      });

      await Promise.race([waitForBackendHealth(healthUrl, child), childError]);
      const server = http.createServer((req, res) => {
        const requestPath = getRequestPath(req.url);
        if (requestPath === DESKTOP_ASSISTANT_PATH) {
          void handleDesktopAssistantRequest(app, req, res);
          return;
        }
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
        message: t("webapp.started", { label: item.label }),
        updatedAt: nowIso()
      };
      writeState(app, runningRecord.state);
      writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] running web=${runningRecord.state.webUrl} backend=${backendUrl}`);
      void syncPublishedWebappRoute(app, item, runningRecord.state);
      return { ok: true, item, state: runningRecord.state, message: runningRecord.state.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record) {
        await this.stop(app, id, `${t("webapp.startFailed")}: ${message}`);
      }
      const state = {
        ...(record?.state ?? createStoppedState(item)),
        status: "error",
        webUrl: "",
        message,
        updatedAt: nowIso()
      } satisfies WebappRuntimeState;
      writeState(app, state);
      writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] start failed: ${message}`);
      return { ok: false, item, state, message };
    }
  }

  async stop(app: App, webappId: string, message = t("service.stopped", { name: t("settings.websites.label") })): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id);
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
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }
    const stored = readStoredState(app, id);
    if (stored?.pid && isProcessRunning(stored.pid) && pidMatchesInstallDir(stored.pid, getWebappDir(app, id))) {
      terminateProcessTree(stored.pid);
    }
    const state = createStoppedState(item, message);
    writeState(app, state);
    return { ok: true, item, state, message };
  }

  async restart(app: App, webappId: string) {
    await this.stop(app, webappId);
    return this.start(app, webappId);
  }

  async stopAll(app: App) {
    await Promise.all([...this.records.keys()].map((id) => this.stop(app, id)));
  }

  readLog(app: App, webappId: string, target: WebappLogTarget, options: WebappLogReadOptions = {}): WebappLogReadResult {
    return readServiceLogFile(getLogPath(app, webappId.trim(), target), options);
  }

  private refreshRecordProcessState(app: App, record: RuntimeRecord) {
    if (!record.item.backend && record.server?.listening) {
      return;
    }
    if (record.child && record.child.exitCode === null && record.child.signalCode === null) {
      return;
    }
    if (record.state.status === "running" || record.state.status === "starting") {
      record.state = {
        ...record.state,
        status: "error",
        webUrl: "",
        message: t("service.backendNotRunning"),
        updatedAt: nowIso()
      };
      writeState(app, record.state);
    }
  }
}

export const webappRuntime = new WebappRuntime();

export function stopAllWebapps(app: App) {
  return webappRuntime.stopAll(app);
}

export const __testInternals = {
  HOST,
  HEALTH_TIMEOUT_MS,
  DESKTOP_ASSISTANT_PATH,
  DESKTOP_ASSISTANT_ACTIONS,
  getRequestPath,
  shouldProxyRequest,
  reservePort
};
