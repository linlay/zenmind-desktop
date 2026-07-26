import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  DesktopWebappChangedReason,
  WebappCommandResult,
  WebappEntry,
  WebappLauncherKind,
  WebappLogReadOptions,
  WebappLogReadResult,
  WebappLogTarget,
  WebappPrerequisiteResult,
  WebappRuntimeState
} from "../../../shared/contracts";
import { readServiceLogFile } from "../../services/manager/logs";
import { isProcessRunning, terminateProcessTree } from "../../services/manager/process-cleanup";
import { pidMatchesInstallDir } from "../../services/manager/process-identity";
import { delay, probeHttpUrl } from "../../services/manager/service-probes";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot
} from "../../user-paths";
import { t } from "../../i18n/main-i18n";
import { startWebappGateway, type WebappGateway } from "./gateway";
import {
  checkWebappBackendPrerequisites,
  getWebappBackendLauncher,
  type WebappLauncherCheck,
  type WebappLauncherContext
} from "./launchers";
import {
  issueWebappActionToken,
  revokeWebappActionToken
} from "./action-tokens";
import { getWebappDir, readWebappItems } from "./store";
import { syncPublishedWebappRoute } from "./publisher";

const HOST = "127.0.0.1";
const STATE_FILE = "runtime.json";
const MAIN_LOG_FILE = "main.log";
const ERROR_LOG_FILE = "error.log";
const HEALTH_INTERVAL_MS = 250;
const EXTERNAL_MONITOR_INTERVAL_MS = 15_000;

type RuntimeRecord = {
  item: WebappEntry;
  webappDir: string;
  child: ChildProcess | null;
  gateway: WebappGateway | null;
  actionToken: string;
  state: WebappRuntimeState;
};

function nowIso() {
  return new Date().toISOString();
}

function launcherForItem(item: WebappEntry): WebappLauncherKind {
  return item.backend?.launcher ?? "none";
}

function ownershipForItem(item: WebappEntry) {
  if (!item.backend) {
    return null;
  }
  return item.backend.launcher === "container" ? "external" as const : "desktop" as const;
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

function readStoredState(app: App, item: WebappEntry): WebappRuntimeState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStatePath(app, item.id), "utf8")) as Partial<WebappRuntimeState>;
    if (typeof parsed.id !== "string") {
      return null;
    }
    const status = parsed.status === "running" ||
      parsed.status === "starting" ||
      parsed.status === "blocked" ||
      parsed.status === "error"
      ? parsed.status
      : "stopped";
    return {
      id: parsed.id,
      entryKey: typeof parsed.entryKey === "string" && parsed.entryKey.startsWith("webapp:")
        ? parsed.entryKey as `webapp:${string}`
        : item.entryKey,
      kind: "webapp",
      status,
      version: typeof parsed.version === "string" ? parsed.version : item.version,
      target: parsed.target ?? item.target,
      launcher: parsed.launcher ?? launcherForItem(item),
      ownership: parsed.ownership ?? ownershipForItem(item),
      runtimeVersion: typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : "",
      externalId: typeof parsed.externalId === "string" ? parsed.externalId : "",
      prerequisiteIssues: Array.isArray(parsed.prerequisiteIssues) ? parsed.prerequisiteIssues : [],
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

function createBaseState(
  item: WebappEntry,
  status: WebappRuntimeState["status"],
  message: string
): WebappRuntimeState {
  return {
    id: item.id,
    entryKey: item.entryKey,
    kind: "webapp",
    status,
    version: item.version,
    target: item.target,
    launcher: launcherForItem(item),
    ownership: ownershipForItem(item),
    runtimeVersion: "",
    externalId: "",
    prerequisiteIssues: [],
    webUrl: "",
    backendUrl: "",
    frontendPort: null,
    backendPort: null,
    pid: null,
    message,
    updatedAt: nowIso()
  };
}

function createStoppedState(
  item: WebappEntry,
  message = t("service.currentlyNotRunning", { name: t("settings.websites.label") })
) {
  return createBaseState(item, "stopped", message);
}

function writeLogLine(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line.endsWith("\n") ? line : `${line}\n`}`, "utf8");
}

function pipeChildLogs(app: App, webappId: string, child: ChildProcess) {
  const mainLogPath = getLogPath(app, webappId, "main");
  const errorLogPath = getLogPath(app, webappId, "error");
  fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => fs.appendFileSync(mainLogPath, chunk));
  child.stderr?.on("data", (chunk: Buffer) => fs.appendFileSync(errorLogPath, chunk));
}

function terminateRuntimeProcessTree(pid: number) {
  const terminated = terminateProcessTree(pid);
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      const forceTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The detached process group has already exited.
        }
      }, 1_000);
      forceTimer.unref();
    } catch {
      // The process group has already exited or was created by an older runtime.
    }
  }
  return terminated;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function terminateRuntimeChild(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    terminateProcessTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    terminateProcessTree(pid);
    return;
  }
  await waitForChildExit(child, 1_000);
  await delay(100);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The detached process group has exited.
  }
  await waitForChildExit(child, 500);
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return resolvedPort;
}

function probeTcp(backendUrl: string, timeoutMs: number) {
  return new Promise<{ ok: boolean; message: string }>((resolve) => {
    let url: URL;
    try {
      url = new URL(backendUrl);
    } catch {
      resolve({ ok: false, message: "TCP health check endpoint is invalid." });
      return;
    }
    const port = Number.parseInt(url.port, 10);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (!host || !Number.isInteger(port)) {
      resolve({ ok: false, message: "TCP health check endpoint is invalid." });
      return;
    }
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean, message: string) => {
      socket.destroy();
      resolve({ ok, message });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, ""));
    socket.once("timeout", () => finish(false, "TCP health check timed out."));
    socket.once("error", (error) => finish(false, error.message));
  });
}

async function waitForBackendHealth(
  item: WebappEntry,
  check: WebappLauncherCheck,
  child: ChildProcess | null
) {
  if (!item.backend || !check.backendPort) {
    throw new Error("backend endpoint is unavailable");
  }
  const deadline = Date.now() + item.backend.health.timeoutMs;
  let lastMessage = "";
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(t("service.processExited", { reason: child.exitCode ?? child.signalCode ?? "unknown" }));
    }
    const probe = item.backend.health.type === "http"
      ? await probeHttpUrl(`${check.backendUrl}${item.backend.health.path}`, { timeoutMs: 1000 })
      : await probeTcp(check.backendUrl, 1000);
    if (probe.ok) {
      return;
    }
    lastMessage = probe.message ?? "";
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new Error(t("service.healthTimeout", { message: lastMessage || check.backendUrl }));
}

function findWebapp(app: App, webappId: string) {
  return readWebappItems(app).find((item) => item.id === webappId.trim()) ?? null;
}

function createLauncherContext(
  app: App,
  item: WebappEntry,
  backendPort: number | null,
  webappDir = getWebappDir(app, item.id),
  actionToken = ""
): WebappLauncherContext {
  return {
    app,
    item,
    webappDir,
    dataDir: getDesktopWebappDataRoot(app, item.id),
    stateDir: getDesktopWebappStateRoot(app, item.id),
    logDir: getDesktopWebappLogsRoot(app, item.id),
    backendPort,
    actionToken
  };
}

function shouldIssueActionToken(item: WebappEntry) {
  return item.schemaVersion === 4 &&
    Boolean(item.backend) &&
    item.backend?.launcher !== "container";
}

function prerequisiteMessage(check: WebappLauncherCheck) {
  return check.issues.map((entry) => entry.message).filter(Boolean).join(" ") ||
    "WebApp runtime prerequisites are satisfied.";
}

export class WebappRuntime {
  private readonly records = new Map<string, RuntimeRecord>();
  private publicationChangeListener: ((reason: DesktopWebappChangedReason, webappId: string) => void) | null = null;
  private externalMonitor: NodeJS.Timeout | null = null;
  private externalMonitorApp: App | null = null;

  setPublicationChangeListener(
    listener: ((reason: DesktopWebappChangedReason, webappId: string) => void) | null
  ) {
    this.publicationChangeListener = listener;
  }

  private syncPublishedRoute(app: App, item: WebappEntry, state: WebappRuntimeState) {
    void syncPublishedWebappRoute(app, item, state).then((publishState) => {
      if (!publishState?.active) {
        return;
      }
      this.publicationChangeListener?.(
        publishState.status === "published" ? "route-synced" : "publish-failed",
        item.id
      );
    });
  }

  private ensureExternalMonitor(app: App) {
    this.externalMonitorApp = app;
    if (this.externalMonitor) {
      return;
    }
    this.externalMonitor = setInterval(() => {
      const monitorApp = this.externalMonitorApp;
      if (!monitorApp) {
        return;
      }
      for (const record of this.records.values()) {
        if (record.item.backend?.launcher !== "container" || record.state.status !== "running") {
          continue;
        }
        const check = checkWebappBackendPrerequisites(
          createLauncherContext(monitorApp, record.item, null)
        );
        if (check.ok) {
          continue;
        }
        void record.gateway?.close();
        record.gateway = null;
        record.state = {
          ...record.state,
          status: "blocked",
          webUrl: "",
          frontendPort: null,
          prerequisiteIssues: check.issues,
          message: prerequisiteMessage(check),
          updatedAt: nowIso()
        };
        writeState(monitorApp, record.state);
      }
    }, EXTERNAL_MONITOR_INTERVAL_MS);
    this.externalMonitor.unref();
  }

  private stopExternalMonitorIfIdle() {
    if ([...this.records.values()].some((record) => record.item.backend?.launcher === "container")) {
      return;
    }
    if (this.externalMonitor) {
      clearInterval(this.externalMonitor);
      this.externalMonitor = null;
      this.externalMonitorApp = null;
    }
  }

  checkPrerequisites(app: App, webappId: string): WebappPrerequisiteResult {
    const item = findWebapp(app, webappId);
    if (!item) {
      return {
        ok: false,
        launcher: "none",
        ownership: null,
        runtimeVersion: "",
        externalId: "",
        backendUrl: "",
        backendPort: null,
        issues: [{ code: "webapp_not_found", message: t("webapp.notFound") }],
        message: t("webapp.notFound")
      };
    }
    const check = checkWebappBackendPrerequisites(createLauncherContext(app, item, null));
    return {
      ok: check.ok,
      launcher: check.launcher,
      ownership: check.ownership,
      runtimeVersion: check.runtimeVersion,
      externalId: check.externalId,
      backendUrl: check.backendUrl,
      backendPort: check.backendPort,
      issues: check.issues,
      message: prerequisiteMessage(check)
    };
  }

  checkItemPrerequisites(app: App, item: WebappEntry, webappDir: string): WebappPrerequisiteResult {
    const check = checkWebappBackendPrerequisites(
      createLauncherContext(app, item, null, webappDir)
    );
    return {
      ok: check.ok,
      launcher: check.launcher,
      ownership: check.ownership,
      runtimeVersion: check.runtimeVersion,
      externalId: check.externalId,
      backendUrl: check.backendUrl,
      backendPort: check.backendPort,
      issues: check.issues,
      message: prerequisiteMessage(check)
    };
  }

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
    const stored = readStoredState(app, item);
    if (
      stored?.ownership === "desktop" &&
      stored.pid &&
      isProcessRunning(stored.pid)
    ) {
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

    const contextBase = createLauncherContext(app, item, null);
    fs.mkdirSync(contextBase.dataDir, { recursive: true });
    fs.mkdirSync(contextBase.logDir, { recursive: true });
    fs.mkdirSync(contextBase.stateDir, { recursive: true });
    writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] starting ${id} version=${item.version} launcher=${launcherForItem(item)}`);

    const initialState = {
      ...createBaseState(item, "starting", t("webapp.starting")),
      startedAt: nowIso()
    };
    writeState(app, initialState);

    let record: RuntimeRecord = {
      item,
      webappDir: contextBase.webappDir,
      child: null,
      gateway: null,
      actionToken: "",
      state: initialState
    };
    this.records.set(id, record);

    try {
      if (!item.backend) {
        const gateway = await startWebappGateway({
          app,
          item,
          webappDir: record.webappDir,
          backendUrl: ""
        });
        record.gateway = gateway;
        record.state = {
          ...record.state,
          status: "running",
          webUrl: gateway.webUrl,
          frontendPort: gateway.port,
          message: t("webapp.started", { label: item.label }),
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] running web=${record.state.webUrl} backend=none`);
        this.syncPublishedRoute(app, item, record.state);
        return { ok: true, item, state: record.state, message: record.state.message };
      }

      const backendPort = item.backend.launcher === "container"
        ? null
        : await reservePort(item.backend.port);
      const context = createLauncherContext(app, item, backendPort);
      const launcher = getWebappBackendLauncher(item.backend);
      const preflight = launcher.validatePrerequisites(context);
      if (!preflight.ok) {
        record.state = {
          ...record.state,
          status: "blocked",
          runtimeVersion: preflight.runtimeVersion,
          externalId: preflight.externalId,
          prerequisiteIssues: preflight.issues,
          message: prerequisiteMessage(preflight),
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] blocked: ${record.state.message}`);
        return { ok: false, item, state: record.state, message: record.state.message };
      }

      if (shouldIssueActionToken(item)) {
        record.actionToken = issueWebappActionToken(id);
      }
      const launchContext = createLauncherContext(
        app,
        item,
        backendPort,
        record.webappDir,
        record.actionToken
      );
      const launched = launcher.start(launchContext);
      if (!launched.ok) {
        throw new Error(prerequisiteMessage(launched));
      }
      record.child = launched.child;
      record.state = {
        ...record.state,
        runtimeVersion: launched.runtimeVersion,
        externalId: launched.externalId,
        backendUrl: launched.backendUrl,
        backendPort: launched.backendPort,
        pid: launched.child?.pid ?? null,
        prerequisiteIssues: []
      };
      writeState(app, record.state);

      let spawnError: Promise<never> | null = null;
      if (launched.child) {
        pipeChildLogs(app, id, launched.child);
        spawnError = new Promise<never>((_resolve, reject) => {
          launched.child!.once("error", (error) => {
            writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend spawn failed: ${error.message}`);
            reject(error);
          });
        });
      }
      await (
        spawnError
          ? Promise.race([waitForBackendHealth(item, launched, launched.child), spawnError])
          : waitForBackendHealth(item, launched, null)
      );

      const gateway = await startWebappGateway({
        app,
        item,
        webappDir: record.webappDir,
        backendUrl: launched.backendUrl
      });
      record.gateway = gateway;
      record.state = {
        ...record.state,
        status: "running",
        webUrl: gateway.webUrl,
        frontendPort: gateway.port,
        message: t("webapp.started", { label: item.label }),
        updatedAt: nowIso()
      };
      writeState(app, record.state);
      writeLogLine(
        getLogPath(app, id, "main"),
        `[${nowIso()}] running web=${record.state.webUrl} backend=${record.state.backendUrl} launcher=${record.state.launcher}`
      );

      if (launched.child) {
        const child = launched.child;
        child.once("exit", (code, signal) => {
          const current = this.records.get(id);
          if (!current || current.child !== child || current.state.status === "stopped") {
            return;
          }
          if (child.pid) {
            terminateRuntimeProcessTree(child.pid);
          }
          revokeWebappActionToken(current.actionToken);
          current.actionToken = "";
          void current.gateway?.close();
          current.gateway = null;
          current.state = {
            ...current.state,
            status: "error",
            webUrl: "",
            frontendPort: null,
            message: t("service.processExited", { reason: code ?? signal ?? "unknown" }),
            updatedAt: nowIso()
          };
          writeState(app, current.state);
          writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] backend exited: ${code ?? signal ?? "unknown"}`);
        });
      } else if (item.backend.launcher === "container") {
        this.ensureExternalMonitor(app);
      }

      this.syncPublishedRoute(app, item, record.state);
      return { ok: true, item, state: record.state, message: record.state.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record.gateway?.close().catch(() => undefined);
      if (record.child) {
        await terminateRuntimeChild(record.child);
      }
      revokeWebappActionToken(record.actionToken);
      record.actionToken = "";
      const status = item.backend?.launcher === "container" ? "blocked" : "error";
      record.state = {
        ...record.state,
        status,
        webUrl: "",
        frontendPort: null,
        message,
        updatedAt: nowIso()
      };
      writeState(app, record.state);
      writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] start failed: ${message}`);
      return { ok: false, item, state: record.state, message };
    }
  }

  async stop(
    app: App,
    webappId: string,
    message = t("service.stopped", { name: t("settings.websites.label") })
  ): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id);
    const record = this.records.get(id);
    if (record) {
      await record.gateway?.close().catch(() => undefined);
      record.gateway = null;
      if (record.child) {
        await terminateRuntimeChild(record.child);
      }
      revokeWebappActionToken(record.actionToken);
      record.actionToken = "";
      record.state = {
        ...record.state,
        status: "stopped",
        webUrl: "",
        frontendPort: null,
        pid: null,
        message,
        updatedAt: nowIso()
      };
      this.records.delete(id);
      this.stopExternalMonitorIfIdle();
      writeState(app, record.state);
      writeLogLine(getLogPath(app, id, "main"), `[${nowIso()}] stopped ${id}`);
      return { ok: true, item: item ?? record.item, state: record.state, message };
    }
    if (!item) {
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }
    const stored = readStoredState(app, item);
    if (
      stored?.ownership === "desktop" &&
      stored.pid &&
      isProcessRunning(stored.pid) &&
      pidMatchesInstallDir(stored.pid, getWebappDir(app, id))
    ) {
      terminateRuntimeProcessTree(stored.pid);
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
    this.stopExternalMonitorIfIdle();
  }

  readLog(
    app: App,
    webappId: string,
    target: WebappLogTarget,
    options: WebappLogReadOptions = {}
  ): WebappLogReadResult {
    return readServiceLogFile(getLogPath(app, webappId.trim(), target), options);
  }

  private refreshRecordProcessState(app: App, record: RuntimeRecord) {
    if (!record.item.backend && record.gateway?.server.listening) {
      return;
    }
    if (record.item.backend?.launcher === "container" && record.gateway?.server.listening) {
      return;
    }
    if (record.child && record.child.exitCode === null && record.child.signalCode === null) {
      return;
    }
    if (record.state.status === "running" || record.state.status === "starting") {
      revokeWebappActionToken(record.actionToken);
      record.actionToken = "";
      record.state = {
        ...record.state,
        status: "error",
        webUrl: "",
        frontendPort: null,
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
  EXTERNAL_MONITOR_INTERVAL_MS,
  reservePort
};
