import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  WebappBackendConfig,
  WebappBackendOwnership,
  WebappEntry,
  WebappLauncherKind,
  WebappPrerequisiteIssue
} from "../../../shared/contracts";
import { buildServiceEnv, resolveCommandBin } from "../../services/manager/command-env";
import { getConfiguredDesktopActionBridgePort } from "../../desktop-action-bridge-settings";
import { resolveWebappRelativePath } from "../common";
import { WEBAPP_FILE } from "./store";
import { resolveConfiguredSystemExecutable } from "./runtime-settings";

const HOST = "127.0.0.1";

export type WebappLauncherContext = {
  app: App;
  item: WebappEntry;
  webappDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
  backendPort: number | null;
  actionToken: string;
};

export type WebappLauncherCheck = {
  ok: boolean;
  launcher: WebappLauncherKind;
  ownership: WebappBackendOwnership | null;
  runtimeVersion: string;
  externalId: string;
  backendUrl: string;
  backendPort: number | null;
  issues: WebappPrerequisiteIssue[];
  command?: string;
};

export type WebappLauncherStartResult = WebappLauncherCheck & {
  child: ChildProcess | null;
};

export interface BackendLauncher {
  kind: Exclude<WebappLauncherKind, "none">;
  validatePrerequisites(context: WebappLauncherContext): WebappLauncherCheck;
  start(context: WebappLauncherContext): WebappLauncherStartResult;
}

function issue(
  code: string,
  message: string,
  required?: string,
  detected?: string
): WebappPrerequisiteIssue {
  return {
    code,
    message,
    ...(required ? { required } : {}),
    ...(detected ? { detected } : {})
  };
}

function failedCheck(
  launcher: Exclude<WebappLauncherKind, "none">,
  issues: WebappPrerequisiteIssue[],
  values: Partial<WebappLauncherCheck> = {}
): WebappLauncherCheck {
  return {
    ok: false,
    launcher,
    ownership: "desktop",
    runtimeVersion: values.runtimeVersion ?? "",
    externalId: values.externalId ?? "",
    backendUrl: values.backendUrl ?? "",
    backendPort: values.backendPort ?? null,
    issues
  };
}

function managedCheck(
  launcher: Exclude<WebappLauncherKind, "none">,
  context: WebappLauncherContext,
  runtimeVersion = "",
  command = ""
): WebappLauncherCheck {
  return {
    ok: true,
    launcher,
    ownership: "desktop",
    runtimeVersion,
    externalId: command,
    backendUrl: context.backendPort ? `http://${HOST}:${context.backendPort}` : "",
    backendPort: context.backendPort,
    issues: [],
    ...(command ? { command } : {})
  };
}

function isExecutableFile(candidate: string) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function managedEnv(context: WebappLauncherContext) {
  const scopedActions = Boolean(context.actionToken);
  return {
    ...buildServiceEnv(),
    ...(context.item.backend?.env ?? {}),
    HOST,
    PORT: String(context.backendPort ?? ""),
    WEBAPP_ID: context.item.id,
    WEBAPP_ROOT: context.webappDir,
    WEBAPP_DATA_DIR: context.dataDir,
    WEBAPP_STATE_DIR: context.stateDir,
    WEBAPP_LOG_DIR: context.logDir,
    WEBAPP_MANIFEST_PATH: path.join(context.webappDir, WEBAPP_FILE),
    DESKTOP_ACTION_BRIDGE_URL: scopedActions
      ? `http://${HOST}:${getConfiguredDesktopActionBridgePort(context.app)}/webapps`
      : `http://${HOST}:${getConfiguredDesktopActionBridgePort(context.app)}`,
    ...(scopedActions ? { DESKTOP_ACTION_BRIDGE_TOKEN: context.actionToken } : {})
  };
}

function startManagedProcess(
  check: WebappLauncherCheck,
  command: string,
  args: string[],
  context: WebappLauncherContext,
  extraEnv: NodeJS.ProcessEnv = {}
): WebappLauncherStartResult {
  if (!check.ok) {
    return { ...check, child: null };
  }
  const child = spawn(command, args, {
    cwd: context.webappDir,
    env: {
      ...managedEnv(context),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false
  });
  return { ...check, child };
}

const electronNodeLauncher: BackendLauncher = {
  kind: "electron-node",
  validatePrerequisites(context) {
    return managedCheck("electron-node", context, process.versions.node, process.execPath);
  },
  start(context) {
    const backend = context.item.backend;
    if (!backend || backend.command.type !== "electron-node") {
      return {
        ...failedCheck("electron-node", [issue("invalid_backend", "electron-node backend is invalid.")]),
        child: null
      };
    }
    const check = this.validatePrerequisites(context);
    const scriptPath = resolveWebappRelativePath(context.webappDir, backend.command.script);
    return startManagedProcess(
      check,
      process.execPath,
      [scriptPath, ...backend.args],
      context,
      { ELECTRON_RUN_AS_NODE: "1" }
    );
  }
};

const bundledLauncher: BackendLauncher = {
  kind: "bundled",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.command.type !== "bundled") {
      return failedCheck("bundled", [issue("invalid_backend", "bundled backend is invalid.")]);
    }
    const executable = resolveWebappRelativePath(context.webappDir, backend.command.executable);
    if (!isExecutableFile(executable)) {
      return failedCheck("bundled", [
        issue("bundled_executable_missing", "Bundled backend executable does not exist.", backend.command.executable)
      ]);
    }
    if (process.platform === "win32" && path.extname(executable).toLowerCase() !== ".exe") {
      return failedCheck("bundled", [
        issue("bundled_executable_extension", "Windows bundled backend executable must be an .exe file.", ".exe")
      ]);
    }
    return managedCheck("bundled", context, context.item.target, executable);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !check.command || !backend || backend.command.type !== "bundled") {
      return { ...check, child: null };
    }
    if (process.platform === "darwin") {
      fs.chmodSync(check.command, 0o755);
    }
    return startManagedProcess(check, check.command, backend.args, context);
  }
};

function resolveSystemExecutable(context: WebappLauncherContext, logicalName: string) {
  const configured = resolveConfiguredSystemExecutable(context.app, context.item.id, logicalName);
  if (configured && isExecutableFile(configured)) {
    return configured;
  }
  const fromPath = resolveCommandBin(logicalName);
  return fromPath && isExecutableFile(fromPath) ? fromPath : "";
}

const systemLauncher: BackendLauncher = {
  kind: "system",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.command.type !== "system") {
      return failedCheck("system", [issue("invalid_backend", "system backend is invalid.")]);
    }
    const executable = resolveSystemExecutable(context, backend.command.executable);
    if (!executable) {
      return failedCheck("system", [
        issue(
          "system_runtime_missing",
          `System runtime ${backend.command.executable} was not found. Select an existing executable in WebApp settings.`,
          backend.command.executable
        )
      ]);
    }
    return managedCheck("system", context, backend.command.executable, executable);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !check.command || !backend || backend.command.type !== "system") {
      return { ...check, child: null };
    }
    return startManagedProcess(check, check.command, backend.args, context);
  }
};

const LAUNCHERS = new Map<BackendLauncher["kind"], BackendLauncher>([
  ["electron-node", electronNodeLauncher],
  ["bundled", bundledLauncher],
  ["system", systemLauncher]
]);

export function getWebappBackendLauncher(backend: NonNullable<WebappBackendConfig>) {
  return LAUNCHERS.get(backend.command.type)!;
}

export function checkWebappBackendPrerequisites(context: WebappLauncherContext) {
  const backend = context.item.backend;
  if (!backend) {
    return {
      ok: true,
      launcher: "none",
      ownership: null,
      runtimeVersion: "",
      externalId: "",
      backendUrl: "",
      backendPort: null,
      issues: []
    } satisfies WebappLauncherCheck;
  }
  return getWebappBackendLauncher(backend).validatePrerequisites(context);
}

export function resetWebappRuntimeProbeCaches() {
  // System runtimes are intentionally resolved on every check so local bindings take effect immediately.
}
