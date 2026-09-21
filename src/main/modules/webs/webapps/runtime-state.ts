import { type WebappEntry, type WebappRuntimeState, type WebappLauncherKind, type WebappLogTarget } from "../../../../shared/contracts";
import { type ChildProcess } from "node:child_process";
import { type WebappGateway } from "./gateway";
import { type App } from "electron";
import path from "node:path";
import { getDesktopWebappStateRoot, getDesktopWebappLogsRoot, getDesktopWebappsStateRoot } from "../../../infrastructure/filesystem/user-paths";
import fs from "node:fs";
import { t } from "../../../support/i18n/main-i18n";

export const STATE_FILE = "runtime.json";

export const MAIN_LOG_FILE = "main.log";

export const ERROR_LOG_FILE = "error.log";

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
