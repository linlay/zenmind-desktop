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
} from "../../../../shared/contracts";

import type { WebappBridgeCapability } from "../../../../shared/webapp-bridge";

import { readServiceLogFile } from "../../../support/logging/service-logs";

import {
  isProcessRunning,
  listProcessTreePidsAsync,
  requestWindowsProcessTreeExitAsync,
  terminateCapturedProcessTreeAsync,
  terminateProcessTree
} from "../../services";

import {
  matchProcessInstallDirAsync,
  pidMatchesInstallDir,
} from "../../services";

import { delay, probeHttpUrl } from "../../services";

import {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsStateRoot
} from "../../../infrastructure/filesystem/user-paths";

import { t } from "../../../support/i18n/main-i18n";

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
import type { WebsIntegrationPorts } from "../integration-ports";

import { syncPublishedWebappRoute } from "./publisher";

export const HOST = "127.0.0.1";

export const STATE_FILE = "runtime.json";

export const MAIN_LOG_FILE = "main.log";

export const ERROR_LOG_FILE = "error.log";

export const HEALTH_INTERVAL_MS = 250;

export const HEALTH_MONITOR_INTERVAL_MS = 5_000;

export const HEALTH_MONITOR_FAILURE_THRESHOLD = 3;

export type RuntimeRecord = {
  item: WebappEntry;
  webappDir: string;
  child: ChildProcess | null;
  gateway: WebappGateway | null;
  backendActionToken: string;
  pageActionToken: string;
  healthTimer: NodeJS.Timeout | null;
  healthProbeActive: boolean;
  consecutiveHealthFailures: number;
  state: WebappRuntimeState;
};

export function nowIso() {
  return new Date().toISOString();
}

export function launcherForItem(item: WebappEntry): WebappLauncherKind {
  return item.backend?.command.type ?? "none";
}

export function ownershipForItem(item: WebappEntry) {
  if (!item.backend) {
    return null;
  }
  return "desktop" as const;
}

export function getStatePath(app: App, webappId: string) {
  return path.join(getDesktopWebappStateRoot(app, webappId), STATE_FILE);
}

export function getLogPath(app: App, webappId: string, target: WebappLogTarget) {
  return path.join(getDesktopWebappLogsRoot(app, webappId), target === "error" ? ERROR_LOG_FILE : MAIN_LOG_FILE);
}

export function writeState(app: App, state: WebappRuntimeState) {
  const statePath = getStatePath(app, state.id);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function normalizeStoredTarget(
  value: unknown,
  fallback: WebappRuntimeState["target"]
): WebappRuntimeState["target"] {
  return value === "any" ||
    value === "darwin-arm64" ||
    value === "darwin-x64" ||
    value === "darwin-universal" ||
    value === "win32-arm64" ||
    value === "win32-x64"
    ? value
    : fallback;
}

export function normalizeStoredLauncher(
  value: unknown,
  fallback: WebappRuntimeState["launcher"]
): WebappRuntimeState["launcher"] {
  return value === "none" ||
    value === "electron-node" ||
    value === "executable" ||
    value === "runtime"
    ? value
    : fallback;
}

export function readStoredStateById(
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
      target: normalizeStoredTarget(parsed.target, item?.target ?? "any"),
      launcher: normalizeStoredLauncher(
        parsed.launcher,
        item ? launcherForItem(item) : "none"
      ),
      ownership: parsed.ownership === "desktop"
        ? "desktop"
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

export function readStoredState(app: App, item: WebappEntry): WebappRuntimeState | null {
  return readStoredStateById(app, item.id, item);
}

export function listStoredRuntimeStates(app: App) {
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

export function createBaseState(
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

export function createStoppedState(
  item: WebappEntry,
  message = t("service.currentlyNotRunning", { name: t("settings.websites.label") })
) {
  return createBaseState(item, "stopped", message);
}

export function writeLogLine(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line.endsWith("\n") ? line : `${line}\n`}`, "utf8");
}

export function pipeChildLogs(app: App, webappId: string, child: ChildProcess) {
  const mainLogPath = getLogPath(app, webappId, "main");
  const errorLogPath = getLogPath(app, webappId, "error");
  fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => fs.appendFileSync(mainLogPath, chunk));
  child.stderr?.on("data", (chunk: Buffer) => fs.appendFileSync(errorLogPath, chunk));
}

export function terminateRuntimeProcessTree(pid: number) {
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

export function waitForChildExit(child: ChildProcess, timeoutMs: number) {
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

export async function terminateRuntimeChild(child: ChildProcess, shutdownTimeoutMs = 3_000) {
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
  await waitForChildExit(child, shutdownTimeoutMs);
  const gracefulDeadline = Date.now() + shutdownTimeoutMs;
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

export async function listen(server: http.Server, port: number) {
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

export async function reservePort(port: number) {
  const server = http.createServer();
  const resolvedPort = await listen(server, port);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return resolvedPort;
}

export function probeTcp(backendUrl: string, timeoutMs: number) {
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

export async function waitForBackendHealth(
  item: WebappEntry,
  check: WebappLauncherCheck,
  child: ChildProcess | null
) {
  if (!item.backend || !check.backendPort) {
    throw new Error("backend endpoint is unavailable");
  }
  const deadline = Date.now() + item.backend.health.startupTimeoutMs;
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

export function findWebapp(app: App, webappId: string, ports?: WebsIntegrationPorts) {
  return readWebappItems(app, process.platform, ports)
    .find((item) => item.id === webappId.trim()) ?? null;
}

export function createLauncherContext(
  app: App,
  item: WebappEntry,
  backendPort: number | null,
  webappDir = getWebappDir(app, item.id),
  actionToken = "",
  integrationPorts?: WebsIntegrationPorts
): WebappLauncherContext {
  return {
    app,
    integrationPorts,
    item,
    webappDir,
    dataDir: getDesktopWebappDataRoot(app, item.id),
    stateDir: getDesktopWebappStateRoot(app, item.id),
    logDir: getDesktopWebappLogsRoot(app, item.id),
    backendPort,
    actionToken
  };
}

export function shouldIssueBackendActionToken(item: WebappEntry) {
  return Boolean(item.backend) &&
    getWebappAllowedActions(item, "backendActionToken").length > 0;
}

export function revokeRecordActionTokens(record: RuntimeRecord) {
  revokeWebappActionToken(record.backendActionToken);
  revokeWebappActionToken(record.pageActionToken);
  record.backendActionToken = "";
  record.pageActionToken = "";
}

export function stopRecordHealthMonitor(record: RuntimeRecord) {
  if (record.healthTimer) {
    clearInterval(record.healthTimer);
    record.healthTimer = null;
  }
  record.healthProbeActive = false;
  record.consecutiveHealthFailures = 0;
}

export async function probeBackendHealthOnce(item: WebappEntry, backendUrl: string) {
  if (!item.backend || !backendUrl) {
    return { ok: false, message: "backend endpoint is unavailable" };
  }
  return item.backend.health.type === "http"
    ? probeHttpUrl(`${backendUrl}${item.backend.health.path}`, { timeoutMs: 1_500 })
    : probeTcp(backendUrl, 1_500);
}

export function prerequisiteMessage(check: WebappLauncherCheck) {
  return check.issues.map((entry) => entry.message).filter(Boolean).join(" ") ||
    t("webapp.runtimePrerequisitesReady");
}
