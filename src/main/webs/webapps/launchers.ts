import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { App } from "electron";
import type {
  WebappBackendConfig,
  WebappBackendOwnership,
  WebappContainerBackendConfig,
  WebappEntry,
  WebappLauncherKind,
  WebappPrerequisiteIssue
} from "../../../shared/contracts";
import {
  buildContainerEngineInvocation,
  resolveContainerEngine,
  type ContainerEngineResolution
} from "../../container-engine";
import { buildServiceEnv, resolveCommandBin } from "../../services/manager/command-env";
import { getConfiguredDesktopActionBridgePort } from "../../desktop-action-bridge-settings";
import { resolveWebappRelativePath } from "../common";
import { WEBAPP_JAVA_MIN_MAJOR } from "./store";
import { readWebappRuntimeSettings } from "./runtime-settings";

const HOST = "127.0.0.1";
const JAVA_PROBE_TIMEOUT_MS = 10_000;
const CONTAINER_INSPECT_TIMEOUT_MS = 10_000;

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
  ownership: WebappBackendOwnership,
  issues: WebappPrerequisiteIssue[],
  values: Partial<WebappLauncherCheck> = {}
): WebappLauncherCheck {
  return {
    ok: false,
    launcher,
    ownership,
    runtimeVersion: values.runtimeVersion ?? "",
    externalId: values.externalId ?? "",
    backendUrl: values.backendUrl ?? "",
    backendPort: values.backendPort ?? null,
    issues
  };
}

function managedCheck(
  launcher: "node" | "native" | "java",
  context: WebappLauncherContext,
  runtimeVersion = "",
  command = ""
): WebappLauncherCheck {
  const backendPort = context.backendPort;
  return {
    ok: true,
    launcher,
    ownership: "desktop",
    runtimeVersion,
    externalId: "",
    backendUrl: backendPort ? `http://${HOST}:${backendPort}` : "",
    backendPort,
    issues: [],
    ...(command ? { command } : {})
  };
}

function managedEnv(context: WebappLauncherContext) {
  const scopedActions = context.item.schemaVersion === 4 && context.actionToken;
  return {
    ...buildServiceEnv(),
    ...(
      context.item.backend && context.item.backend.launcher !== "container"
        ? context.item.backend.env
        : {}
    ),
    HOST,
    PORT: String(context.backendPort ?? ""),
    WEBAPP_ID: context.item.id,
    WEBAPP_ROOT: context.webappDir,
    WEBAPP_DATA_DIR: context.dataDir,
    WEBAPP_STATE_DIR: context.stateDir,
    WEBAPP_LOG_DIR: context.logDir,
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
    detached: process.platform !== "win32"
  });
  return { ...check, child };
}

const nodeLauncher: BackendLauncher = {
  kind: "node",
  validatePrerequisites(context) {
    return managedCheck("node", context, process.versions.node, process.execPath);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!backend || backend.launcher !== "node") {
      return { ...failedCheck("node", "desktop", [issue("invalid_backend", "Node backend is invalid.")]), child: null };
    }
    const entryPath = resolveWebappRelativePath(context.webappDir, backend.entry);
    return startManagedProcess(
      check,
      process.execPath,
      [entryPath, ...backend.args],
      context,
      { ELECTRON_RUN_AS_NODE: "1" }
    );
  }
};

const nativeLauncher: BackendLauncher = {
  kind: "native",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.launcher !== "native") {
      return failedCheck("native", "desktop", [issue("invalid_backend", "Native backend is invalid.")]);
    }
    const entryPath = resolveWebappRelativePath(context.webappDir, backend.entry);
    if (process.platform === "win32" && path.extname(entryPath).toLowerCase() !== ".exe") {
      return failedCheck("native", "desktop", [
        issue("native_entry_extension", "Windows native backend entry must be an .exe file.", ".exe", path.extname(entryPath))
      ]);
    }
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
      return failedCheck("native", "desktop", [issue("native_entry_missing", "Native backend entry does not exist.")]);
    }
    return managedCheck("native", context, context.item.target, entryPath);
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !backend || backend.launcher !== "native") {
      return { ...check, child: null };
    }
    const entryPath = resolveWebappRelativePath(context.webappDir, backend.entry);
    if (process.platform === "darwin") {
      fs.chmodSync(entryPath, 0o755);
    }
    return startManagedProcess(check, entryPath, backend.args, context);
  }
};

type JavaProbe = {
  ok: boolean;
  executable: string;
  major: number;
  version: string;
  home: string;
  issue?: WebappPrerequisiteIssue;
};

const javaProbeCache = new Map<string, JavaProbe>();

function resolveJavaExecutable(app: App) {
  const configured = readWebappRuntimeSettings(app).javaExecutable;
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const isExecutableFile = (candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (configured && isExecutableFile(configured)) {
    return configured;
  }
  const javaHomeExecutable = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", javaName)
    : "";
  if (javaHomeExecutable && isExecutableFile(javaHomeExecutable)) {
    return javaHomeExecutable;
  }
  const pathExecutable = resolveCommandBin("java");
  return pathExecutable && isExecutableFile(pathExecutable) ? pathExecutable : "";
}

function probeJava(app: App): JavaProbe {
  const executable = resolveJavaExecutable(app);
  if (!executable) {
    return {
      ok: false,
      executable: "",
      major: 0,
      version: "",
      home: "",
      issue: issue(
        "java_not_found",
        `Java ${WEBAPP_JAVA_MIN_MAJOR} or newer was not found. Configure javaExecutable, JAVA_HOME, or PATH.`,
        `>=${WEBAPP_JAVA_MIN_MAJOR}`
      )
    };
  }
  const cached = javaProbeCache.get(executable);
  if (cached) {
    return cached;
  }
  const result = spawnSync(executable, ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
    env: buildServiceEnv(),
    timeout: JAVA_PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const specification = output.match(/^\s*java\.specification\.version\s*=\s*([^\s]+)\s*$/mu)?.[1] ?? "";
  const version = output.match(/^\s*java\.version\s*=\s*([^\s]+)\s*$/mu)?.[1]
    ?? output.match(/version\s+"([^"]+)"/u)?.[1]
    ?? "";
  const home = output.match(/^\s*java\.home\s*=\s*(.+?)\s*$/mu)?.[1] ?? "";
  const majorText = specification.startsWith("1.") ? specification.slice(2) : specification;
  const major = Number.parseInt(majorText || version, 10);
  let probe: JavaProbe;
  if (result.error || result.status !== 0 || !Number.isInteger(major)) {
    probe = {
      ok: false,
      executable,
      major: 0,
      version,
      home,
      issue: issue("java_probe_failed", "Java runtime could not be inspected.", `>=${WEBAPP_JAVA_MIN_MAJOR}`, version)
    };
  } else if (major < WEBAPP_JAVA_MIN_MAJOR) {
    probe = {
      ok: false,
      executable,
      major,
      version,
      home,
      issue: issue(
        "java_version_unsupported",
        `Java ${WEBAPP_JAVA_MIN_MAJOR} or newer is required.`,
        `>=${WEBAPP_JAVA_MIN_MAJOR}`,
        version || String(major)
      )
    };
  } else {
    probe = { ok: true, executable, major, version, home };
  }
  javaProbeCache.set(executable, probe);
  return probe;
}

const javaLauncher: BackendLauncher = {
  kind: "java",
  validatePrerequisites(context) {
    const java = probeJava(context.app);
    if (!java.ok) {
      return failedCheck(
        "java",
        "desktop",
        java.issue ? [java.issue] : [],
        { runtimeVersion: java.version, externalId: java.executable }
      );
    }
    return {
      ...managedCheck("java", context, java.version, java.executable),
      externalId: java.executable
    };
  },
  start(context) {
    const check = this.validatePrerequisites(context);
    const backend = context.item.backend;
    if (!check.ok || !backend || backend.launcher !== "java" || !check.command) {
      return { ...check, child: null };
    }
    const entryPath = resolveWebappRelativePath(context.webappDir, backend.entry);
    return startManagedProcess(
      check,
      check.command,
      [...backend.jvmArgs, "-jar", entryPath, ...backend.args],
      context
    );
  }
};

function runContainerCommand(engine: ContainerEngineResolution, args: string[]) {
  const invocation = buildContainerEngineInvocation(engine, args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: engine.env,
    timeout: CONTAINER_INSPECT_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
}

function inspectExternalContainer(
  app: App,
  backend: WebappContainerBackendConfig
): WebappLauncherCheck {
  const configuredEngine = backend.engine === "auto"
    ? readWebappRuntimeSettings(app).containerEngine
    : backend.engine;
  const engine = resolveContainerEngine({
    ...(configuredEngine === "auto" ? {} : { preferredName: configuredEngine }),
    timeoutMs: CONTAINER_INSPECT_TIMEOUT_MS
  });
  if (!engine) {
    return failedCheck("container", "external", [
      issue("container_engine_unavailable", "Docker or Podman is not available.", configuredEngine)
    ]);
  }
  const imageResult = runContainerCommand(engine, ["image", "inspect", backend.image, "--format", "{{.Id}}"]);
  const imageId = imageResult.status === 0 ? imageResult.stdout.trim() : "";
  if (!imageId) {
    return failedCheck("container", "external", [
      issue("container_image_missing", `Container image is not installed: ${backend.image}`, backend.image)
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  const inspectResult = runContainerCommand(engine, ["container", "inspect", backend.containerName]);
  if (inspectResult.status !== 0) {
    return failedCheck("container", "external", [
      issue("container_missing", `Container does not exist: ${backend.containerName}`, backend.containerName)
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  let inspected: any;
  try {
    inspected = JSON.parse(inspectResult.stdout)?.[0];
  } catch {
    inspected = null;
  }
  if (!inspected || inspected.State?.Running !== true) {
    return failedCheck("container", "external", [
      issue("container_not_running", `Container is not running: ${backend.containerName}`, "running")
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  const actualImageId = String(inspected.Image ?? "");
  if (actualImageId && actualImageId !== imageId) {
    return failedCheck("container", "external", [
      issue("container_image_mismatch", "Running container does not use the expected image.", imageId, actualImageId)
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  const bindings = inspected.NetworkSettings?.Ports?.[`${backend.containerPort}/tcp`];
  const bindingList = Array.isArray(bindings) ? bindings : [];
  const unsafeBinding = bindingList.find((candidate: any) =>
    candidate?.HostIp !== "127.0.0.1" && candidate?.HostIp !== "::1"
  );
  if (unsafeBinding) {
    return failedCheck("container", "external", [
      issue(
        "container_port_exposed",
        `Container port ${backend.containerPort} is exposed beyond loopback.`,
        "127.0.0.1 or ::1",
        String(unsafeBinding.HostIp || "all interfaces")
      )
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  const binding = bindingList[0] ?? null;
  const backendPort = Number.parseInt(String(binding?.HostPort ?? ""), 10);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
    return failedCheck("container", "external", [
      issue(
        "container_loopback_port_missing",
        `Container port ${backend.containerPort} must be published on 127.0.0.1 or ::1.`,
        `127.0.0.1:<port> -> ${backend.containerPort}/tcp`
      )
    ], { runtimeVersion: engine.name, externalId: backend.containerName });
  }
  const bindingHost = binding.HostIp === "::1" ? "[::1]" : HOST;
  return {
    ok: true,
    launcher: "container",
    ownership: "external",
    runtimeVersion: `${engine.name}:${imageId}`,
    externalId: backend.containerName,
    backendUrl: `http://${bindingHost}:${backendPort}`,
    backendPort,
    issues: []
  };
}

const containerLauncher: BackendLauncher = {
  kind: "container",
  validatePrerequisites(context) {
    const backend = context.item.backend;
    if (!backend || backend.launcher !== "container") {
      return failedCheck("container", "external", [issue("invalid_backend", "Container backend is invalid.")]);
    }
    return inspectExternalContainer(context.app, backend);
  },
  start(context) {
    return {
      ...this.validatePrerequisites(context),
      child: null
    };
  }
};

const LAUNCHERS = new Map<BackendLauncher["kind"], BackendLauncher>([
  ["node", nodeLauncher],
  ["native", nativeLauncher],
  ["java", javaLauncher],
  ["container", containerLauncher]
]);

export function getWebappBackendLauncher(backend: WebappBackendConfig) {
  return LAUNCHERS.get(backend.launcher)!;
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
  javaProbeCache.clear();
}

export const __launcherTestInternals = {
  clearJavaProbeCache() {
    resetWebappRuntimeProbeCaches();
  },
  inspectExternalContainer,
  probeJava
};
