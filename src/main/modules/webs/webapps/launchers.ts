import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  WebappBackendConfig,
  WebappBackendOwnership,
  WebappEntry,
  WebappLauncherKind,
  WebappPrerequisiteIssue
} from "../../../../shared/contracts";
import { buildServiceEnv, resolveCommandBin } from "../../services";
import { requireWebsIntegrationPorts, type WebsIntegrationPorts } from "../integration-ports";
import { resolveWebappRelativePath } from "../common";
import { WEBAPP_FILE, readWebappUserConfigValues } from "./store";
import { resolveConfiguredRuntimeExecutable } from "./runtime-settings";

const HOST = "127.0.0.1";
const SAFE_INHERITED_ENV_KEYS = new Set([
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMSPEC",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR"
]);

export type WebappLauncherContext = {
  app: App;
  integrationPorts?: WebsIntegrationPorts;
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
  const inheritedEnv = Object.fromEntries(
    Object.entries(buildServiceEnv()).filter(([key, value]) =>
      value !== undefined && SAFE_INHERITED_ENV_KEYS.has(key.toUpperCase())
    )
  );
  return {
    ...inheritedEnv,
    ...(context.item.backend?.env ?? {}),
    HOST,
    PORT: String(context.backendPort ?? ""),
    WEBAPP_ID: context.item.id,
    WEBAPP_ROOT: context.webappDir,
    WEBAPP_DATA_DIR: context.dataDir,
    WEBAPP_STATE_DIR: context.stateDir,
    WEBAPP_LOG_DIR: context.logDir,
    WEBAPP_MANIFEST_PATH: path.join(context.webappDir, WEBAPP_FILE),
    WEBAPP_USER_CONFIG_PATH: path.join(context.stateDir, "user-config.json"),
    DESKTOP_ACTION_BRIDGE_URL: scopedActions
      ? `http://${HOST}:${requireWebsIntegrationPorts(context.integrationPorts).getConfiguredDesktopActionBridgePort(context.app)}/webapps`
      : `http://${HOST}:${requireWebsIntegrationPorts(context.integrationPorts).getConfiguredDesktopActionBridgePort(context.app)}`,
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
  fs.mkdirSync(context.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(context.stateDir, "user-config.json"),
    `${JSON.stringify(readWebappUserConfigValues(context.app, context.item.id), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
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
    const scriptPath = resolveWebappRelativePath(context.webappDir, backend.command.entry);
    return startManagedProcess(
      check,
      process.execPath,
      [scriptPath, ...backend.args],
      context,
      { ELECTRON_RUN_AS_NODE: "1" }
    );
  }
};

const executableLauncher: BackendLauncher = {
  kind: "executable",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.command.type !== "executable") {
      return failedCheck("executable", [issue("invalid_backend", "executable backend is invalid.")]);
    }
    const executable = resolveWebappRelativePath(context.webappDir, backend.command.entry);
    if (!isExecutableFile(executable)) {
      return failedCheck("executable", [
        issue("executable_missing", "Backend executable does not exist.", backend.command.entry)
      ]);
    }
    if (process.platform === "win32" && path.extname(executable).toLowerCase() !== ".exe") {
      return failedCheck("executable", [
        issue("executable_extension", "Windows backend executable must be an .exe file.", ".exe")
      ]);
    }
    return managedCheck("executable", context, context.item.target, executable);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !check.command || !backend || backend.command.type !== "executable") {
      return { ...check, child: null };
    }
    if (process.platform === "darwin") {
      fs.chmodSync(check.command, 0o755);
    }
    return startManagedProcess(check, check.command, backend.args, context);
  }
};

function parseRuntimeVersion(output: string) {
  return output.match(/\d+(?:\.\d+){0,2}/u)?.[0] ?? "";
}

function compareRuntimeVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function resolveRuntimeExecutable(context: WebappLauncherContext, runtime: "python" | "java") {
  const configured = resolveConfiguredRuntimeExecutable(context.app, context.item.id, runtime);
  if (configured && isExecutableFile(configured)) {
    return configured;
  }
  const candidates = runtime === "python"
    ? process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]
    : ["java"];
  for (const candidate of candidates) {
    const resolved = resolveCommandBin(candidate);
    if (resolved && isExecutableFile(resolved)) {
      return resolved;
    }
  }
  return "";
}

function probeRuntimeVersion(command: string, runtime: "python" | "java") {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    shell: false
  });
  return parseRuntimeVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

const runtimeLauncher: BackendLauncher = {
  kind: "runtime",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.command.type !== "runtime") {
      return failedCheck("runtime", [issue("invalid_backend", "runtime backend is invalid.")]);
    }
    const executable = resolveRuntimeExecutable(context, backend.command.runtime);
    if (!executable) {
      return failedCheck("runtime", [
        issue(
          "runtime_missing",
          `${backend.command.runtime} runtime was not found. Select an existing executable in WebApp settings.`,
          backend.command.runtime
        )
      ]);
    }
    const runtimeVersion = probeRuntimeVersion(executable, backend.command.runtime);
    if (
      backend.command.minimumVersion &&
      (!runtimeVersion || compareRuntimeVersions(runtimeVersion, backend.command.minimumVersion) < 0)
    ) {
      return failedCheck("runtime", [
        issue(
          "runtime_version_too_low",
          `${backend.command.runtime} ${backend.command.minimumVersion} or newer is required.`,
          backend.command.minimumVersion,
          runtimeVersion || "unknown"
        )
      ], { runtimeVersion, externalId: executable });
    }
    return managedCheck("runtime", context, runtimeVersion, executable);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !check.command || !backend || backend.command.type !== "runtime") {
      return { ...check, child: null };
    }
    const entry = resolveWebappRelativePath(context.webappDir, backend.command.entry);
    const runtimeArgs = backend.command.runtime === "java"
      ? ["-jar", entry, ...backend.args]
      : [entry, ...backend.args];
    return startManagedProcess(check, check.command, runtimeArgs, context);
  }
};

const LAUNCHERS = new Map<BackendLauncher["kind"], BackendLauncher>([
  ["electron-node", electronNodeLauncher],
  ["executable", executableLauncher],
  ["runtime", runtimeLauncher]
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
  // Runtimes are intentionally resolved on every check so local bindings take effect immediately.
}
