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
  WebappRuntimeCheckResult,
  WebappRuntimeState
} from "../../../shared/contracts";
import type { WebappBridgeCapability } from "../../../shared/webapp-bridge";
import { readServiceLogFile } from "../../services/manager/logs";
import {
  isProcessRunning,
  listProcessTreePidsAsync,
  requestWindowsProcessTreeExitAsync,
  terminateCapturedProcessTreeAsync,
  terminateProcessTree
} from "../../services/manager/process-cleanup";
import {
  matchProcessInstallDirAsync,
  pidMatchesInstallDir,
} from "../../services/manager/process-identity";
import { delay, probeHttpUrl } from "../../services/manager/service-probes";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsStateRoot
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
import { getWebappAllowedActions } from "./capability-policy";
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
  backendActionToken: string;
  pageActionToken: string;
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

function normalizeStoredTarget(
  value: unknown,
  fallback: WebappRuntimeState["target"]
): WebappRuntimeState["target"] {
  return value === "universal" ||
    value === "darwin-arm64" ||
    value === "darwin-x64" ||
    value === "windows-arm64" ||
    value === "windows-x64"
    ? value
    : fallback;
}

function normalizeStoredLauncher(
  value: unknown,
  fallback: WebappRuntimeState["launcher"]
): WebappRuntimeState["launcher"] {
  return value === "none" ||
    value === "node" ||
    value === "native" ||
    value === "java" ||
    value === "container"
    ? value
    : fallback;
}

function readStoredStateById(
  app: App,
  webappId: string,
  item: WebappEntry | null = null
): WebappRuntimeState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getStatePath(app, webappId), "utf8")
    ) as Partial<WebappRuntimeState>;
    const status = parsed.status === "running" ||
      parsed.status === "starting" ||
      parsed.status === "blocked" ||
      parsed.status === "error"
      ? parsed.status
      : "stopped";
    return {
      id: webappId,
      entryKey: `webapp:${webappId}`,
      kind: "webapp",
      status,
      version: typeof parsed.version === "string" ? parsed.version : item?.version ?? "",
      target: normalizeStoredTarget(parsed.target, item?.target ?? "universal"),
      launcher: normalizeStoredLauncher(
        parsed.launcher,
        item ? launcherForItem(item) : "none"
      ),
      ownership: parsed.ownership === "desktop" || parsed.ownership === "external"
        ? parsed.ownership
        : item
          ? ownershipForItem(item)
          : null,
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

function readStoredState(app: App, item: WebappEntry): WebappRuntimeState | null {
  return readStoredStateById(app, item.id, item);
}

function listStoredRuntimeStates(app: App) {
  try {
    return fs.readdirSync(getDesktopWebappsStateRoot(app), {
      withFileTypes: true
    }).flatMap((entry) => {
      if (!entry.isDirectory()) {
        return [];
      }
      const state = readStoredStateById(app, entry.name);
      return state ? [state] : [];
    });
  } catch {
    return [] as WebappRuntimeState[];
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
    return true;
  }
  const treePids = await listProcessTreePidsAsync(pid).catch(() => [pid]);
  const capturedPids = treePids.length > 0 ? treePids : [pid];
  if (process.platform === "win32") {
    const exitedGracefully = await requestWindowsProcessTreeExitAsync(
      pid,
      capturedPids
    );
    if (exitedGracefully) {
      return true;
    }
    const terminated = await terminateCapturedProcessTreeAsync(pid, capturedPids);
    return terminated && capturedPids.every((candidatePid) => !isProcessRunning(candidatePid));
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return terminateCapturedProcessTreeAsync(pid, capturedPids);
  }
  await waitForChildExit(child, 1_000);
  const gracefulDeadline = Date.now() + 1_000;
  while (Date.now() < gracefulDeadline && capturedPids.some((candidatePid) => isProcessRunning(candidatePid))) {
    await delay(100);
  }
  if (capturedPids.every((candidatePid) => !isProcessRunning(candidatePid))) {
    return true;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The detached process group has exited.
  }
  await waitForChildExit(child, 500);
  const forceDeadline = Date.now() + 500;
  while (Date.now() < forceDeadline && capturedPids.some((candidatePid) => isProcessRunning(candidatePid))) {
    await delay(100);
  }
  return capturedPids.every((candidatePid) => !isProcessRunning(candidatePid));
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

function shouldIssueBackendActionToken(item: WebappEntry) {
  return item.schemaVersion >= 4 &&
    Boolean(item.backend) &&
    item.backend?.launcher !== "container" &&
    getWebappAllowedActions(item, "backendActionToken").length > 0;
}

function revokeRecordActionTokens(record: RuntimeRecord) {
  revokeWebappActionToken(record.backendActionToken);
  revokeWebappActionToken(record.pageActionToken);
  record.backendActionToken = "";
  record.pageActionToken = "";
}

function prerequisiteMessage(check: WebappLauncherCheck) {
  return check.issues.map((entry) => entry.message).filter(Boolean).join(" ") ||
    t("webapp.runtimePrerequisitesReady");
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

  emitLifecycleChange(reason: DesktopWebappChangedReason, webappId: string) {
    try {
      this.publicationChangeListener?.(reason, webappId);
    } catch (error) {
      console.warn(
        `[webapp] failed to emit ${reason} for ${webappId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  allowsLocalPageCapability(rawUrl: string, capability: WebappBridgeCapability) {
    let origin = "";
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return false;
    }
    return [...this.records.values()].some((record) => {
      if (record.state.status !== "running" || record.item.schemaVersion !== 5) {
        return false;
      }
      try {
        return new URL(record.state.webUrl).origin === origin &&
          record.item.desktopBridge?.capabilities.includes(capability) === true;
      } catch {
        return false;
      }
    });
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
        revokeRecordActionTokens(record);
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

  checkRuntime(app: App, webappId: string): WebappRuntimeCheckResult {
    const item = findWebapp(app, webappId);
    if (!item) {
      return {
        ready: false,
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
      ready: check.ok,
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

  checkItemPrerequisites(
    app: App,
    item: WebappEntry,
    webappDir: string
  ): WebappLauncherCheck & { message: string } {
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
      backendActionToken: "",
      pageActionToken: issueWebappActionToken(item, "localPageGateway"),
      state: initialState
    };
    this.records.set(id, record);

    try {
      if (!item.backend) {
        const gateway = await startWebappGateway({
          app,
          item,
          webappDir: record.webappDir,
          backendUrl: "",
          pageActionToken: record.pageActionToken
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
        revokeRecordActionTokens(record);
        return { ok: false, item, state: record.state, message: record.state.message };
      }

      if (shouldIssueBackendActionToken(item)) {
        record.backendActionToken = issueWebappActionToken(item, "backendActionToken");
      }
      const launchContext = createLauncherContext(
        app,
        item,
        backendPort,
        record.webappDir,
        record.backendActionToken
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
        backendUrl: launched.backendUrl,
        pageActionToken: record.pageActionToken
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
          revokeRecordActionTokens(current);
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
      revokeRecordActionTokens(record);
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
    message = t("webapp.stopped")
  ): Promise<WebappCommandResult> {
    const id = webappId.trim();
    const item = findWebapp(app, id);
    const record = this.records.get(id);
    if (record) {
      let gatewayFailureMessage = "";
      try {
        await record.gateway?.close();
      } catch (error) {
        const gatewayMessage = error instanceof Error ? error.message : String(error);
        gatewayFailureMessage = t("webapp.gatewayCloseFailed", { message: gatewayMessage });
      }
      record.gateway = null;
      revokeRecordActionTokens(record);
      if (record.child) {
        const terminated = await terminateRuntimeChild(record.child);
        if (!terminated) {
          const pid = record.child.pid ?? record.state.pid;
          const failureMessage = pid
            ? t("webapp.processTreeStillRunningWithPid", { pid })
            : t("webapp.processTreeStillRunning");
          record.state = {
            ...record.state,
            status: "error",
            webUrl: "",
            frontendPort: null,
            message: failureMessage,
            updatedAt: nowIso()
          };
          writeState(app, record.state);
          writeLogLine(getLogPath(app, id, "error"), `[${nowIso()}] ${failureMessage}`);
          return {
            ok: false,
            item: item ?? record.item,
            state: record.state,
            message: failureMessage
          };
        }
        record.child = null;
      }
      if (gatewayFailureMessage) {
        record.state = {
          ...record.state,
          status: "error",
          webUrl: "",
          frontendPort: null,
          pid: null,
          message: gatewayFailureMessage,
          updatedAt: nowIso()
        };
        writeState(app, record.state);
        writeLogLine(
          getLogPath(app, id, "error"),
          `[${nowIso()}] ${gatewayFailureMessage}`
        );
        return {
          ok: false,
          item: item ?? record.item,
          state: record.state,
          message: gatewayFailureMessage
        };
      }
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
    const stored = item
      ? readStoredState(app, item)
      : readStoredStateById(app, id);
    if (!item && !stored) {
      return { ok: false, item: null, state: null, message: t("webapp.notFound") };
    }
    if (stored?.ownership === "desktop" && stored.pid && isProcessRunning(stored.pid)) {
      const identityMatch = await matchProcessInstallDirAsync(
        stored.pid,
        getWebappDir(app, id)
      );
      if (identityMatch === "unknown") {
        const failureMessage = t("webapp.processOwnershipUnknown", { pid: stored.pid });
        const failedState = {
          ...stored,
          status: "error" as const,
          message: failureMessage,
          updatedAt: nowIso()
        };
        writeState(app, failedState);
        return {
          ok: false,
          item,
          state: failedState,
          message: failureMessage
        };
      }
      if (identityMatch === "matched") {
        const capturedPids = await listProcessTreePidsAsync(stored.pid).catch(() => [stored.pid!]);
        const exitedGracefully = process.platform === "win32"
          ? await requestWindowsProcessTreeExitAsync(stored.pid, capturedPids)
          : false;
        const terminated = exitedGracefully ||
          await terminateCapturedProcessTreeAsync(stored.pid, capturedPids);
        const remainingPids = capturedPids.filter((pid) => isProcessRunning(pid));
        if (!terminated || remainingPids.length > 0) {
          const failureMessage = t("webapp.processTreeStillRunningWithPid", {
            pid: remainingPids.join(", ") || stored.pid
          });
          const failedState = {
            ...stored,
            status: "error" as const,
            message: failureMessage,
            updatedAt: nowIso()
          };
          writeState(app, failedState);
          return {
            ok: false,
            item,
            state: failedState,
            message: failureMessage
          };
        }
      }
    }
    const state = item
      ? createStoppedState(item, message)
      : {
          ...stored!,
          status: "stopped" as const,
          webUrl: "",
          frontendPort: null,
          pid: null,
          message,
          updatedAt: nowIso()
        };
    writeState(app, state);
    return { ok: true, item, state, message };
  }

  async restart(app: App, webappId: string) {
    await this.stop(app, webappId);
    return this.start(app, webappId);
  }

  async stopAll(app: App) {
    const ids = new Set([
      ...this.records.keys(),
      ...readWebappItems(app)
        .filter((item) => {
          const stored = readStoredState(app, item);
          return stored?.ownership === "desktop" && Boolean(stored.pid);
        })
        .map((item) => item.id),
      ...listStoredRuntimeStates(app)
        .filter((state) =>
          state.ownership === "desktop" && Boolean(state.pid)
        )
        .map((state) => state.id)
    ]);
    const results = await Promise.all([...ids].map((id) => this.stop(app, id)));
    this.stopExternalMonitorIfIdle();
    return results;
  }

  listActivePorts(app: App) {
    const ports = new Map<string, { id: string; port: number }>();
    const items = readWebappItems(app);
    for (const item of items) {
      const record = this.records.get(item.id);
      const state = record?.state ?? readStoredState(app, item);
      if (state?.frontendPort) {
        ports.set(`${item.id}:gateway:${state.frontendPort}`, {
          id: `${item.id}:gateway`,
          port: state.frontendPort
        });
      }
      if (state?.ownership === "desktop" && state.backendPort) {
        ports.set(`${item.id}:backend:${state.backendPort}`, {
          id: `${item.id}:backend`,
          port: state.backendPort
        });
      }
    }
    const installedIds = new Set(items.map((item) => item.id));
    for (const state of listStoredRuntimeStates(app)) {
      if (installedIds.has(state.id)) {
        continue;
      }
      if (state.frontendPort) {
        ports.set(`${state.id}:gateway:${state.frontendPort}`, {
          id: `${state.id}:gateway`,
          port: state.frontendPort
        });
      }
      if (state.ownership === "desktop" && state.backendPort) {
        ports.set(`${state.id}:backend:${state.backendPort}`, {
          id: `${state.id}:backend`,
          port: state.backendPort
        });
      }
    }
    return [...ports.values()];
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
      revokeRecordActionTokens(record);
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

export function listActiveWebappPorts(app: App) {
  return webappRuntime.listActivePorts(app);
}

export const __testInternals = {
  HOST,
  EXTERNAL_MONITOR_INTERVAL_MS,
  reservePort
};
