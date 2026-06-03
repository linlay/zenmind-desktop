import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { App } from "electron";
import type {
  ServiceCommandResult,
  ServiceConfigReadResult,
  ServiceDesiredStatus,
  ServiceId,
  ServiceImportResult,
  ServiceLogReadOptions,
  ServiceLogReadResult,
  ServiceLogStreamEvent,
  ServiceLogStreamOptions,
  ServiceLogTarget,
  ServiceLogsMeta,
  ServiceState,
  ServiceVerification,
  StartupRestoreMode,
  StartupRestoreServicePhase
} from "../../../shared/contracts";
import type { ServiceDefinition } from "../../manifest-utils";
import { getAllServices, getService } from "../service-registry";
import { ensureAppServerJwk } from "../../app-server-auth";
import { readEnvFile, parseEnvFileContent } from "../../env-file";
import { extractArchiveToDir } from "../../archive-utils";
import {
  buildServiceLayoutEnv,
  getBuiltinServiceVersionRoot,
  getInitializationStatePath,
  getInstallDir,
  getServiceLayout,
  resolveConfigPath,
  resolveConfigTemplatePath,
  resolveProgramPath,
  resolveServiceRuntimePath,
  type ServiceLayout
} from "./layout";
import {
  LOG_READ_WINDOW_BYTES,
  readLogRange,
  readServiceLogFile,
  normalizeLogStreamOffset,
  normalizeLogStreamPollInterval
} from "./logs";
import {
  beginStartupTiming,
  flushStartupTimingSummary
} from "../../startup-timing";
import {
  agentPlatformInstallNeedsRefresh,
  agentWebclientInstallNeedsRefresh,
  serviceInstallNeedsRefresh,
  zenmindAppServerInstallNeedsRefresh
} from "./install-refresh";
import {
  formatDesktopAgentPlatformRuntimeRoot,
  hasConfiguredAgentPlatformRuntimePath,
  resolveAgentPlatformAgentsDir,
  resolveAgentPlatformInitializationRuntimeRoot,
  resolveHomeDir,
  resolvePreferredAgentPlatformRuntimeRoot
} from "./runtime-paths";
import {
  buildServiceEnv,
  resolveNodeBin
} from "./command-env";
import { ensureDesktopRegisterApiKey } from "../../desktop-register";
import { getDesktopDeviceId } from "../../device-identity";
import {
  decodePowerShellCapturePayload,
  IS_WINDOWS,
  runExecFile,
  SERVICE_COMMAND_TIMEOUT_MS,
  windowsPowerShellPath
} from "./command-runner";
import {
  upsertEnvFileContent,
  writeEnvFileUpdates
} from "./env-content";
import {
  DEFAULT_STARTUP_SERVICE_IDS,
  getDefaultStartupServiceIds,
  getLastRunningServicesStatePath,
  getOptionalServiceIdsToRestore,
  getServiceIdsToRestore,
  INSTALL_ONLY_STARTUP_SERVICE_IDS,
  isNonBlockingRestoreFailure,
  orderServiceIdsForRestore,
  readInitializationState,
  readLastRunningServices,
  writeInitializationState,
  writeLastRunningServices
} from "./state-files";
import {
  fixShellScriptPermissions,
  patchProgramCommonForLayeredLayout
} from "./program-layout";
import {
  computeAssetSignature,
  ensureArchiveHealthy,
  ensureBundleAssetHealthy,
  getOptionalBundleAssetPath,
  isInstallHealthy,
  listMissingBundleEntries,
  listMissingRuntimeFiles,
  moveExtractedBuiltinRoot,
  readBuiltinAssetSignature
} from "./bundle-assets";
import {
  buildProcessTreePids,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromWindowsPowerShell,
  type ProcessTreeRow
} from "./process-tree";
import {
  AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE,
  AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS,
  DEFAULT_PROVIDER_APIKEY_KEY_PART,
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID,
  PROCESS_EXEC_PATH_PLACEHOLDER,
  applyAgentPlatformWindowsHostShellDefaults,
  ensureLocalCliAcpRelayDesktopConfig,
  isManagedAgentPlatformAuthLocalPublicKeyPath,
  normalizeAgentContainerHubEnvContentForDesktop,
  normalizeAgentPlatformBashConfigContent,
  normalizeAgentPlatformDeprecatedConfigFiles,
  normalizeAgentPlatformEnvContentForRuntime,
  normalizeAgentPlatformEnvContentForSave,
  normalizeAgentPlatformFileToolsConfigContent,
  normalizeAgentWebclientEnvContentForDesktop,
  normalizePreservedBuiltinEnvForInstall,
  normalizeShellSourcedAgentPlatformEnvUpdates,
  resolveAcpCommandForDesktop
} from "./env-normalization";
import {
  containerEngineAvailable,
  probeContainerEngines
} from "./container-engine";
import {
  CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS,
  delay,
  getServiceVerificationDelayMs,
  normalizeProbeUrl,
  probeHttpUrl,
  type HttpProbeResult
} from "./service-probes";

export { getInstallDir } from "./layout";
export { fixShellScriptPermissions } from "./program-layout";

const startedThisSession = new Set<ServiceId>();

type ServiceLogStreamCallback = (event: ServiceLogStreamEvent) => void;

type ManagedRootPid = {
  pid: number;
  serviceId: ServiceId;
  installDir?: string;
  pidFilePaths: string[];
};

type ManagedProcessCleanupTarget = ManagedRootPid & {
  treePids: number[];
};

type ManagedProcessCleanupTargets = {
  roots: ManagedRootPid[];
  stalePidFilePaths: string[];
};

type ManagedServiceStopState = {
  mainPidFilePath: string;
  managedMainPid: number | null;
  port: number;
  managedPortPids: number[];
};

type TerminateProcessTreeOptions = {
  platform?: NodeJS.Platform | string;
  isProcessRunningImpl?: (pid: number | null) => boolean;
  spawnSyncImpl?: typeof spawnSync;
  listProcessTreePidsImpl?: typeof listProcessTreePids;
  terminateProcessListImpl?: typeof terminateProcessList;
};

type ForceCleanupManagedProcessesOptions = {
  platform?: NodeJS.Platform | string;
  collectManagedProcessCleanupTargetsImpl?: (app: App) => ManagedProcessCleanupTargets;
  terminateProcessTreeImpl?: typeof terminateProcessTree;
  terminateProcessListImpl?: typeof terminateProcessList;
  listProcessTreePidsImpl?: typeof listProcessTreePids;
  isProcessRunningImpl?: (pid: number | null) => boolean;
  pidMatchesInstallDirImpl?: typeof pidMatchesInstallDir;
  removePidFileImpl?: typeof removePidFile;
  consoleError?: (message: string) => void;
};

type StartupPreparationProgressPhase =
  | "pending"
  | "installing"
  | "initializing"
  | "starting"
  | "succeeded"
  | "failed"
  | "skipped";

type StartupPreparationResult = {
  mode: StartupRestoreMode;
  started: ServiceId[];
  failures: string[];
};

const SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 2_500;
const WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 1_000;

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function fileExists(targetPath: string) {
  return fs.existsSync(targetPath);
}

function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
}

function isAssetNewerThanInstall(
  assetPath: string,
  layoutOrInstallDir: ServiceLayout | string,
  app?: App,
  service?: ServiceDefinition
) {
  try {
    const initStatePath = getInitializationStatePath(layoutOrInstallDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    const initializationState = readInitializationState(layoutOrInstallDir);
    if (initializationState?.assetSignature) {
      const assetSignature = app && service
        ? readBuiltinAssetSignature(app, service) ?? computeAssetSignature(assetPath)
        : computeAssetSignature(assetPath);
      return initializationState.assetSignature !== assetSignature;
    }
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

function needsBundledAssetRefresh(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  let assetPath: string;
  try {
    assetPath = ensureBundleAssetHealthy(app, service);
  } catch {
    return false;
  }

  if (!fs.existsSync(installDir)) {
    return true;
  }

  try {
    if (serviceInstallNeedsRefresh(service, installDir)) {
      return true;
    }
    return isAssetNewerThanInstall(assetPath, layout, app, service);
  } catch {
    return false;
  }
}

function installedBuiltinNeedsStartupRepair(app: App, service: ServiceDefinition, current: ServiceState) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
    return true;
  }

  const initializationState = readInitializationState(layout);
  if (
    initializationState?.status !== "succeeded" ||
    initializationState.version !== service.version
  ) {
    return true;
  }

  return shouldReinitializeMissingCoreServiceConfig(service, current);
}

const ZENMIND_APP_SERVER_BCRYPT_KEYS = [
  "AUTH_ADMIN_PASSWORD_BCRYPT",
  "AUTH_APP_MASTER_PASSWORD_BCRYPT"
] as const;
const ZENMIND_APP_SERVER_FALLBACK_PASSWORD_BCRYPT =
  "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1ue";
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/u;

function singleQuoteEnvValue(value: string) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function readRawEnvValue(content: string, key: string) {
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const lineKey = trimmed.slice(0, separatorIndex).trim();
    if (lineKey === key) {
      return trimmed.slice(separatorIndex + 1).trim();
    }
  }
  return "";
}

function unquoteEnvValue(rawValue: string) {
  return rawValue.trim().replace(/^['"]|['"]$/gu, "");
}

function isSingleQuotedBcryptEnvValue(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'") || trimmed.length < 2) {
    return false;
  }
  return BCRYPT_HASH_PATTERN.test(trimmed.slice(1, -1));
}

function readTemplateBcryptEnvValue(layout: ServiceLayout, key: string) {
  const templatePath = resolveConfigTemplatePath(layout, ".env.example");
  if (!fs.existsSync(templatePath)) {
    return "";
  }

  try {
    const rawValue = readRawEnvValue(fs.readFileSync(templatePath, "utf8"), key);
    if (isSingleQuotedBcryptEnvValue(rawValue)) {
      return rawValue;
    }
    const unquoted = unquoteEnvValue(rawValue);
    if (BCRYPT_HASH_PATTERN.test(unquoted)) {
      return singleQuoteEnvValue(unquoted);
    }
  } catch {
    // Fall back below when bundled templates are unreadable or stale.
  }
  return "";
}

function resolveDefaultAppServerBcryptEnvValue(layout: ServiceLayout, key: string) {
  return readTemplateBcryptEnvValue(layout, key) ||
    singleQuoteEnvValue(ZENMIND_APP_SERVER_FALLBACK_PASSWORD_BCRYPT);
}

function syncZenmindAppServerDesktopEnv(
  layout: ServiceLayout,
  content: string,
  updates: Map<string, string>
) {
  updates.set("AUTH_DB_PATH", path.join(layout.dataDir, "auth.db"));

  for (const key of ZENMIND_APP_SERVER_BCRYPT_KEYS) {
    const currentRawValue = readRawEnvValue(content, key);
    if (!isSingleQuotedBcryptEnvValue(currentRawValue)) {
      updates.set(key, resolveDefaultAppServerBcryptEnvValue(layout, key));
    }
  }
}

const MAX_TCP_PORT = 65535;
const CORE_SERVICE_IDS = new Set<ServiceId>([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "zenmind-app-server"
]);
const AGENT_WEBCLIENT_PLATFORM_URL_KEYS = ["BASE_URL"] as const;
const DESKTOP_MANAGED_PLATFORM_URL_PORTS = new Set([
  "7078",
  "11949",
  "18081",
  "7200",
  "7000",
  "11953",
  "117078"
]);
const DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS = new Set(["7079", "11960", "117079"]);
const LOCAL_SERVICE_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
const CONTAINER_HUB_SERVICE_HOSTS = new Set([...LOCAL_SERVICE_HOSTS, "host.docker.internal"]);

function parsePortValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const pieces = trimmed.split(":");
  const portText = pieces[pieces.length - 1] ?? "";
  const port = Number.parseInt(portText, 10);
  return Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : null;
}

function getServicePortEnvKeys(service: ServiceDefinition) {
  return service.web.portEnvKey ? [service.web.portEnvKey] : [];
}

function parsePort(service: ServiceDefinition, env: Map<string, string>) {
  const portEnvKeys = getServicePortEnvKeys(service);
  if (portEnvKeys.length === 0) {
    return service.web.defaultPort;
  }

  for (const key of portEnvKeys) {
    const value = env.get(key);
    if (!value) {
      continue;
    }
    const port = parsePortValue(value);
    if (port) {
      return port;
    }
  }

  return service.web.defaultPort;
}

function getWebUrl(service: ServiceDefinition, env: Map<string, string>) {
  const port = parsePort(service, env);
  if (!port) {
    return "";
  }
  const routePath = service.web.routePath;
  return routePath ? `http://127.0.0.1:${port}${routePath}` : `http://127.0.0.1:${port}`;
}

function normalizeUrlHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function readHttpUrlHostPort(value: string) {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return {
      hostname: normalizeUrlHostname(parsed.hostname),
      port: parsed.port
    };
  } catch {
    // Keep going: URL rejects invalid TCP ports such as 117078, but those
    // are precisely the broken persisted defaults we need to migrate.
  }

  const match = raw.match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::([0-9]+))?(?:[/?#]|$)/iu);
  if (!match) {
    return null;
  }

  return {
    hostname: normalizeUrlHostname(match[1] ?? ""),
    port: match[2] ?? ""
  };
}

function isDesktopManagedHttpUrl(
  value: string,
  managedPorts: Set<string>,
  managedHosts: Set<string>,
  allowMissingPort = false
) {
  const parsed = readHttpUrlHostPort(value);
  if (!parsed || !managedHosts.has(parsed.hostname)) {
    return false;
  }
  if (!parsed.port) {
    return allowMissingPort;
  }
  return managedPorts.has(parsed.port);
}

function resolveRuntimePath(layoutOrInstallDir: ServiceLayout | string, relativePath: string) {
  if (!relativePath) {
    return "";
  }
  if (typeof layoutOrInstallDir === "string") {
    return path.join(layoutOrInstallDir, relativePath);
  }
  return resolveServiceRuntimePath(layoutOrInstallDir, relativePath);
}

function readPid(pidFilePath: string) {
  if (!fs.existsSync(pidFilePath)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(pidFilePath, "utf8").trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") {
      return null;
    }
    throw error;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function isProcessRunning(pid: number | null) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listListeningPids(port: number) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }

  const env = buildServiceEnv();

  try {
    if (IS_WINDOWS) {
      const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        env,
        timeout: 1500
      });
      if (result.status !== 0 || result.error) {
        return [];
      }

      const pids = new Set<number>();
      for (const line of result.stdout.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("TCP")) {
          continue;
        }

        const parts = trimmed.split(/\s+/u);
        const localAddress = parts[1] ?? "";
        const state = (parts[3] ?? "").toUpperCase();
        const pidText = parts[4] ?? "";
        if (state !== "LISTENING") {
          continue;
        }

        const parsedPort = Number.parseInt(localAddress.split(":").at(-1) ?? "", 10);
        const pid = Number.parseInt(pidText, 10);
        if (parsedPort === port && Number.isFinite(pid)) {
          pids.add(pid);
        }
      }

      return [...pids];
    }

    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      env,
      timeout: 1500
    });
    if (result.status !== 0 || result.error) {
      return [];
    }

    return [...new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid))
    )];
  } catch {
    return [];
  }
}

function readProcessCommand(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return "";
  }

  const env = buildServiceEnv();

  try {
    if (IS_WINDOWS) {
      const query = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
      const result = spawnSync(windowsPowerShellPath(), ["-NoProfile", "-Command", query], {
        encoding: "utf8",
        env,
        timeout: 1500
      });
      if (result.status !== 0 || result.error) {
        return "";
      }
      return result.stdout.trim();
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      env,
      timeout: 1500
    });
    if (result.status !== 0 || result.error) {
      return "";
    }
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function readProcessTreeRows() {
  const env = buildServiceEnv();

  try {
    if (IS_WINDOWS) {
      const command = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress"
      ].join("; ");
      const result = spawnSync(windowsPowerShellPath(), ["-NoProfile", "-Command", command], {
        encoding: "utf8",
        env,
        timeout: 3000
      });
      if (result.status !== 0 || result.error) {
        return [];
      }
      return parseProcessTreeRowsFromWindowsPowerShell(result.stdout);
    }

    const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      env,
      timeout: 3000
    });
    if (result.status !== 0 || result.error) {
      return [];
    }
    return parseProcessTreeRowsFromPs(result.stdout);
  } catch {
    return [];
  }
}

function listProcessTreePids(rootPid: number) {
  return buildProcessTreePids(rootPid, readProcessTreeRows());
}

function normalizeProcessPath(value: string) {
  return path.normalize(value).replace(/\\/gu, "/");
}

function pidMatchesInstallDir(pid: number, installDir: string) {
  const command = readProcessCommand(pid);
  if (!command) {
    return false;
  }

  return normalizeProcessPath(command).includes(normalizeProcessPath(installDir));
}

function detectManagedServicePid(installDir: string, port: number) {
  for (const pid of listListeningPids(port)) {
    if (pidMatchesInstallDir(pid, installDir)) {
      return pid;
    }
  }
  return null;
}

function writePidFile(pidFilePath: string, pid: number) {
  ensureDir(path.dirname(pidFilePath));
  fs.writeFileSync(pidFilePath, `${pid}\n`, "utf8");
}

function readManagedPidFile(pidFilePaths: string[], installDir?: string) {
  for (const pidFilePath of pidFilePaths) {
    const pid = readPid(pidFilePath);
    if (!pid) {
      if (fs.existsSync(pidFilePath)) {
        removePidFile(pidFilePath);
      }
      continue;
    }
    if (installDir && (!isProcessRunning(pid) || !pidMatchesInstallDir(pid, installDir))) {
      removePidFile(pidFilePath);
      continue;
    }
    if (pid) {
      return pid;
    }
  }
  return null;
}

function writeManagedPidFiles(pidFilePaths: string[], pid: number) {
  for (const pidFilePath of pidFilePaths) {
    writePidFile(pidFilePath, pid);
  }
}

function listBuiltinSiblingInstallDirs(app: App, service: ServiceDefinition, currentInstallDir: string) {
  const versionRoot = getBuiltinServiceVersionRoot(app, service.id);
  if (!fs.existsSync(versionRoot)) {
    return [];
  }

  return fs.readdirSync(versionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(versionRoot, entry.name))
    .filter((installDir) => path.normalize(installDir) !== path.normalize(currentInstallDir));
}

function readPreservedEnvFromSiblingInstallDirs(siblingInstallDirs: string[]) {
  const candidates = siblingInstallDirs
    .map((installDir) => {
      const envPath = path.join(installDir, ".env");
      if (!fileExists(envPath)) {
        return null;
      }

      try {
        return {
          envPath,
          content: fs.readFileSync(envPath, "utf8"),
          mtimeMs: fs.statSync(envPath).mtimeMs
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is { envPath: string; content: string; mtimeMs: number } => Boolean(item))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates[0]?.content ?? "";
}

function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isProcessRunning(pid);
}

function terminateProcess(pid: number) {
  if (!isProcessRunning(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessRunning(pid);
  }

  if (waitForProcessExit(pid, 2500)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessRunning(pid);
  }

  return waitForProcessExit(pid, 1000);
}

function waitForProcessesExit(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessRunning(pid))) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return pids.every((pid) => !isProcessRunning(pid));
}

function signalProcessList(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    if (!isProcessRunning(pid)) {
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the liveness check and signal delivery.
    }
  }
}

function terminateProcessList(pids: number[]) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isFinite(pid) && pid > 0);
  if (uniquePids.length === 0 || uniquePids.every((pid) => !isProcessRunning(pid))) {
    return true;
  }

  if (process.platform === "win32") {
    for (const pid of uniquePids) {
      if (isProcessRunning(pid)) {
        try {
          spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
            env: buildServiceEnv(),
            timeout: 2000
          });
        } catch {
          // ignore
        }
      }
    }
    return uniquePids.every((pid) => !isProcessRunning(pid));
  }

  signalProcessList(uniquePids, "SIGTERM");
  if (waitForProcessesExit(uniquePids, 2500)) {
    return true;
  }

  signalProcessList(uniquePids, "SIGKILL");
  return waitForProcessesExit(uniquePids, 1000);
}

function terminateProcessTree(rootPid: number, options: TerminateProcessTreeOptions = {}) {
  const platform = options.platform ?? process.platform;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const listProcessTreePidsImpl = options.listProcessTreePidsImpl ?? listProcessTreePids;
  const terminateProcessListImpl = options.terminateProcessListImpl ?? terminateProcessList;

  if (!isProcessRunningImpl(rootPid)) {
    return true;
  }

  if (platform === "win32") {
    try {
      const result = spawnSyncImpl("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
        encoding: "utf8",
        env: buildServiceEnv(),
        timeout: 5000
      });
      if (result.status === 0 || !isProcessRunningImpl(rootPid)) {
        return true;
      }
    } catch {
      // Fall back to process table traversal below.
    }
  }

  const treePids = listProcessTreePidsImpl(rootPid);
  return terminateProcessListImpl(treePids.length > 0 ? treePids : [rootPid]);
}

function removePidFile(pidFilePath: string) {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore pid cleanup failures and let the next startup attempt surface a real error if needed.
  }
}

function uniqueNonEmptyPaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean))];
}

function getManagedPidFilePaths(service: ServiceDefinition, layout: ServiceLayout) {
  if (!service.runtime.pidRelativePath) {
    return [];
  }

  const pidFileName = path.basename(service.runtime.pidRelativePath);
  return uniqueNonEmptyPaths([
    resolveRuntimePath(layout, service.runtime.pidRelativePath),
    resolveRuntimePath(layout.programDir, service.runtime.pidRelativePath),
    pidFileName ? path.join(layout.stateDir, "pid", pidFileName) : ""
  ]);
}

function addManagedRootPid(
  roots: Map<number, ManagedRootPid>,
  serviceId: ServiceId,
  pid: number | null,
  installDir: string,
  pidFilePath = ""
) {
  if (!pid || !pidMatchesInstallDir(pid, installDir)) {
    return;
  }

  const existing = roots.get(pid);
  if (existing) {
    if (pidFilePath) {
      existing.pidFilePaths = uniqueNonEmptyPaths([...existing.pidFilePaths, pidFilePath]);
    }
    return;
  }

  roots.set(pid, {
    pid,
    serviceId,
    installDir,
    pidFilePaths: pidFilePath ? [pidFilePath] : []
  });
}

function collectManagedProcessCleanupTargets(app: App): ManagedProcessCleanupTargets {
  const roots = new Map<number, ManagedRootPid>();
  const stalePidFilePaths = new Set<string>();

  for (const service of getAllServices()) {
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    if (!fs.existsSync(installDir)) {
      continue;
    }

    for (const pidFilePath of getManagedPidFilePaths(service, layout)) {
      const pid = readPid(pidFilePath);
      if (!pid) {
        if (fs.existsSync(pidFilePath)) {
          stalePidFilePaths.add(pidFilePath);
        }
        continue;
      }
      if (!isProcessRunning(pid) || !pidMatchesInstallDir(pid, installDir)) {
        stalePidFilePaths.add(pidFilePath);
        continue;
      }
      addManagedRootPid(roots, service.id, pid, installDir, pidFilePath);
    }

    const envPath = layout.envPath;
    const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
    const port = parsePort(service, env);
    if (port > 0) {
      for (const pid of listListeningPids(port)) {
        addManagedRootPid(roots, service.id, pid, installDir);
      }
    }
  }

  return {
    roots: [...roots.values()],
    stalePidFilePaths: [...stalePidFilePaths]
  };
}

function collectManagedRootPids(app: App) {
  return collectManagedProcessCleanupTargets(app).roots;
}

export function captureManagedProcessCleanupSnapshot(app: App) {
  return collectManagedRootPids(app).map((root): ManagedProcessCleanupTarget => ({
    ...root,
    treePids: listProcessTreePids(root.pid)
  }));
}

function mergeCleanupTargets(targets: ManagedProcessCleanupTarget[], roots: ManagedRootPid[]) {
  const merged = new Map<number, ManagedProcessCleanupTarget>();

  for (const target of targets) {
    merged.set(target.pid, {
      ...target,
      pidFilePaths: [...target.pidFilePaths],
      treePids: [...target.treePids]
    });
  }

  for (const root of roots) {
    const existing = merged.get(root.pid);
    if (existing) {
      existing.installDir = existing.installDir ?? root.installDir;
      existing.pidFilePaths = uniqueNonEmptyPaths([...existing.pidFilePaths, ...root.pidFilePaths]);
      if (existing.treePids.length === 0) {
        existing.treePids = listProcessTreePids(root.pid);
      }
      continue;
    }

    merged.set(root.pid, {
      ...root,
      pidFilePaths: [...root.pidFilePaths],
      treePids: listProcessTreePids(root.pid)
    });
  }

  return [...merged.values()];
}

function buildCleanupTreePids(root: ManagedProcessCleanupTarget, listProcessTreePidsImpl: typeof listProcessTreePids) {
  const pids = [...listProcessTreePidsImpl(root.pid), ...root.treePids]
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== root.pid);
  return [...new Set([...pids, root.pid])];
}

function shouldRemoveManagedPidFile(
  root: ManagedProcessCleanupTarget,
  isProcessRunningImpl: (pid: number | null) => boolean,
  pidMatchesInstallDirImpl: typeof pidMatchesInstallDir
) {
  if (!isProcessRunningImpl(root.pid)) {
    return true;
  }
  if (root.installDir && !pidMatchesInstallDirImpl(root.pid, root.installDir)) {
    return true;
  }
  return false;
}

export async function forceCleanupManagedProcesses(
  app: App,
  snapshot: ManagedProcessCleanupTarget[] = [],
  options: ForceCleanupManagedProcessesOptions = {}
) {
  const collectManagedProcessCleanupTargetsImpl =
    options.collectManagedProcessCleanupTargetsImpl ?? collectManagedProcessCleanupTargets;
  const terminateProcessTreeImpl = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const terminateProcessListImpl = options.terminateProcessListImpl ?? terminateProcessList;
  const listProcessTreePidsImpl = options.listProcessTreePidsImpl ?? listProcessTreePids;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const pidMatchesInstallDirImpl = options.pidMatchesInstallDirImpl ?? pidMatchesInstallDir;
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;
  const consoleError = options.consoleError ?? console.error;
  const platform = options.platform ?? process.platform;
  const collected = collectManagedProcessCleanupTargetsImpl(app);
  const roots = mergeCleanupTargets(snapshot, collected.roots);
  const failures: string[] = [];

  for (const stalePidFilePath of collected.stalePidFilePaths) {
    removePidFileImpl(stalePidFilePath);
  }

  for (const root of roots) {
    const treePids = buildCleanupTreePids(root, listProcessTreePidsImpl);
    const terminated = platform === "win32"
      ? terminateProcessTreeImpl(root.pid, {
          platform,
          isProcessRunningImpl,
          listProcessTreePidsImpl,
          terminateProcessListImpl
        })
      : terminateProcessListImpl(treePids);
    if (terminated || shouldRemoveManagedPidFile(root, isProcessRunningImpl, pidMatchesInstallDirImpl)) {
      for (const pidFilePath of root.pidFilePaths) {
        removePidFileImpl(pidFilePath);
      }
    }

    if (!terminated && treePids.some((pid) => isProcessRunningImpl(pid))) {
      failures.push(`${root.serviceId}: PID ${root.pid}`);
    }
  }

  if (failures.length > 0) {
    consoleError(`failed to force-clean managed service processes: ${failures.join("; ")}`);
  }
}

function collectManagedServiceStopState(
  service: ServiceDefinition,
  layoutOrInstallDir: ServiceLayout | string,
  env: Map<string, string>
): ManagedServiceStopState {
  const installDir = typeof layoutOrInstallDir === "string" ? layoutOrInstallDir : layoutOrInstallDir.programDir;
  const mainPidFilePath = resolveRuntimePath(layoutOrInstallDir, service.runtime.pidRelativePath);
  const mainPid = readPid(mainPidFilePath);
  const managedMainPid =
    mainPid && isProcessRunning(mainPid) && pidMatchesInstallDir(mainPid, installDir)
      ? mainPid
      : null;
  const port = parsePort(service, env);
  const managedPortPids =
    port > 0
      ? [...new Set(listListeningPids(port).filter((pid) => pidMatchesInstallDir(pid, installDir)))]
      : [];

  return {
    mainPidFilePath,
    managedMainPid,
    port,
    managedPortPids
  };
}

function buildManagedServiceStopIssues(
  service: ServiceDefinition,
  state: ManagedServiceStopState,
  phase: "stop" | "cleanup"
) {
  const issues: string[] = [];

  if (phase === "stop" && state.managedMainPid) {
    issues.push(`stop script returned but process still alive (pid=${state.managedMainPid})`);
  }
  if (phase === "cleanup" && state.managedMainPid) {
    issues.push(`managed process still alive after cleanup (pid=${state.managedMainPid})`);
  }
  if (state.port > 0 && state.managedPortPids.length > 0) {
    issues.push(`port ${state.port} still occupied by managed process after ${phase}`);
  }

  return issues;
}

function forceStopServiceInstallDir(
  service: ServiceDefinition,
  installDir: string,
  env: Map<string, string>,
  options: {
    isWindows?: boolean;
    collectState?: typeof collectManagedServiceStopState;
    terminateProcessImpl?: typeof terminateProcess;
    terminateProcessTreeImpl?: typeof terminateProcessTree;
    removePidFileImpl?: typeof removePidFile;
  } = {}
) {
  const isWindows = options.isWindows ?? IS_WINDOWS;
  const collectState = options.collectState ?? collectManagedServiceStopState;
  const terminateProcessImpl = options.terminateProcessImpl ?? terminateProcess;
  const terminateProcessTreeImpl = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;
  const state = collectState(service, installDir, env);
  const pidsToTerminate = [
    state.managedMainPid,
    ...state.managedPortPids
  ].filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0);
  let allTerminated = true;

  for (const pid of [...new Set(pidsToTerminate)]) {
    const terminated = isWindows ? terminateProcessTreeImpl(pid) : terminateProcessImpl(pid);
    allTerminated = terminated && allTerminated;
  }

  if (state.mainPidFilePath) {
    removePidFileImpl(state.mainPidFilePath);
  }

  return allTerminated;
}

function ensureManagedServiceStoppedForPlatform(
  service: ServiceDefinition,
  layoutOrInstallDir: ServiceLayout | string,
  env: Map<string, string>,
  options: {
    isWindows?: boolean;
    collectState?: typeof collectManagedServiceStopState;
    forceStop?: typeof forceStopServiceInstallDir;
  } = {}
) {
  const isWindows = options.isWindows ?? IS_WINDOWS;
  if (!isWindows) {
    return {
      ok: true,
      forcedCleanup: false,
      message: ""
    };
  }

  const collectState = options.collectState ?? collectManagedServiceStopState;
  const forceStop = options.forceStop ?? forceStopServiceInstallDir;
  const installDir = typeof layoutOrInstallDir === "string" ? layoutOrInstallDir : layoutOrInstallDir.programDir;
  const afterStopState = collectState(service, layoutOrInstallDir, env);
  const stopIssues = buildManagedServiceStopIssues(service, afterStopState, "stop");
  if (stopIssues.length === 0) {
    return {
      ok: true,
      forcedCleanup: false,
      message: ""
    };
  }

  forceStop(service, installDir, env);
  const afterCleanupState = collectState(service, layoutOrInstallDir, env);
  const cleanupIssues = buildManagedServiceStopIssues(service, afterCleanupState, "cleanup");
  if (cleanupIssues.length === 0) {
    return {
      ok: true,
      forcedCleanup: true,
      message: stopIssues.join("; ")
    };
  }

  return {
    ok: false,
    forcedCleanup: true,
    message: cleanupIssues.join("; ")
  };
}

async function stopBuiltinInstallDir(service: ServiceDefinition, installDir: string) {
  const stopCommand = service.stopCommand;
  if (stopCommand.length > 0) {
    try {
      await runExecFile(stopCommand[0], stopCommand.slice(1), installDir);
    } catch {
      // Fall back to direct PID termination below.
    }
  }

  const envPath = path.join(installDir, ".env");
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  forceStopServiceInstallDir(service, installDir, env);
}

async function reconcileBuiltinSiblingInstallDirs(app: App, service: ServiceDefinition, currentInstallDir: string) {
  const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, currentInstallDir);
  if (siblingInstallDirs.length === 0) {
    return siblingInstallDirs;
  }

  for (const installDir of siblingInstallDirs) {
    await stopBuiltinInstallDir(service, installDir);

    const pidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
    const pidFromFile = readPid(pidFilePath);
    if (pidFromFile && isProcessRunning(pidFromFile) && pidMatchesInstallDir(pidFromFile, installDir)) {
      continue;
    }

    fs.rmSync(installDir, { recursive: true, force: true });
  }

  return siblingInstallDirs;
}

function collectPrerequisites(service: ServiceDefinition, layout: ServiceLayout) {
  const prerequisites: string[] = [];
  const envPath = layout.envPath;
  if (!fs.existsSync(envPath)) {
    prerequisites.push("缺少 .env 配置文件");
  }

  for (const target of service.importTargets) {
    const targetPath = resolveConfigPath(layout, target.relativePath);
    if (target.required && !fs.existsSync(targetPath)) {
      prerequisites.push(`缺少 ${target.label}`);
    }
  }

  if (service.id === "agent-container-hub") {
    const engineProbe = probeContainerEngines();
    if (!engineProbe.engine) {
      const installed = engineProbe.probes.filter((probe) => probe.installed);
      if (installed.length > 0) {
        const names = installed.map((probe) => probe.engine).join(" / ");
        prerequisites.push(`${names} 已安装，但 daemon/VM 未连接，请先启动 Docker Desktop 或执行 podman machine start`);
      } else {
        prerequisites.push("未检测到 Docker 或 Podman");
      }
    }
  }

  if (false && service.id === "agent-container-hub" && !containerEngineAvailable()) {
    prerequisites.push("未检测到 Docker 或 Podman");
  }

  return prerequisites;
}

function ensureDefaultConfig(service: ServiceDefinition, layout: ServiceLayout) {
  for (const configFile of service.configFiles) {
    const targetPath = resolveConfigPath(layout, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}

function copyDirectoryEntriesIfMissing(sourceDir: string, targetDir: string) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryEntriesIfMissing(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(targetPath)) {
      continue;
    }
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function ensureAgentContainerHubDesktopConfig(layout: ServiceLayout) {
  copyDirectoryEntriesIfMissing(
    resolveConfigTemplatePath(layout, path.join("configs", "environments")),
    resolveConfigPath(layout, path.join("configs", "environments"))
  );
}

async function ensureInitializationRequirements(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, layout);
  }

  if (CORE_SERVICE_IDS.has(service.id)) {
    await syncCoreServiceDesktopInitializationConfig(app, service, layout);
    return;
  }

  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates);
  syncCoreServiceDefaultPortEnv(service, env, updates);
  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

async function ensureMutableInstallDir(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id, { source: "ensureMutableInstallDir" });
    return getInstallDir(app, service);
  }

  throw new Error(`${service.name} 尚未导入，请先导入插件。`);
}

type InstallBuiltinServiceOptions = {
  force?: boolean;
  archivePath?: string;
  source?: string;
};

export async function installBuiltinService(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const timing = beginStartupTiming("installBuiltinService", {
    serviceId,
    force: Boolean(options.force),
    source: options.source ?? "direct"
  });
  let didExtract = false;
  const service = getService(serviceId);
  try {
    if (service.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    const assetPath = options.archivePath
      ? ensureArchiveHealthy(service, options.archivePath, "安装包")
      : ensureBundleAssetHealthy(app, service);
    const initializationAssetSignature = options.archivePath ? computeAssetSignature(assetPath) : undefined;

    const finalInstallDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, finalInstallDir);
    const needsExtract =
      options.force ||
      !fs.existsSync(finalInstallDir) ||
      !isInstallHealthy(service, finalInstallDir) ||
      serviceInstallNeedsRefresh(service, finalInstallDir) ||
      isAssetNewerThanInstall(assetPath, layout, options.archivePath ? undefined : app, service);

    const preservedEnvPath = layout.envPath;
    const hasCurrentEnv = fileExists(preservedEnvPath);
    const preservedEnvRaw = hasCurrentEnv
      ? fs.readFileSync(preservedEnvPath, "utf8")
      : readPreservedEnvFromSiblingInstallDirs(siblingInstallDirs);
    const preservedEnv = preservedEnvRaw
      ? normalizePreservedBuiltinEnvForInstall(service, preservedEnvRaw)
      : { content: "" };

    await reconcileBuiltinSiblingInstallDirs(app, service, finalInstallDir);

    if (!needsExtract) {
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    }

    const versionRoot = path.dirname(finalInstallDir);
    ensureDir(versionRoot);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${service.id}-extract-`));
    try {
      await extractArchiveToDir(assetPath, tempRoot);
      didExtract = true;
      const entries = fs.readdirSync(tempRoot);
      if (entries.length !== 1) {
        throw new Error(`unexpected archive layout for ${service.id}`);
      }
      const extractedRoot = path.join(tempRoot, entries[0]);
      if (fs.existsSync(finalInstallDir)) {
        await stopBuiltinInstallDir(service, finalInstallDir);
      }
      fs.rmSync(finalInstallDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      moveExtractedBuiltinRoot(extractedRoot, finalInstallDir);
      patchProgramCommonForLayeredLayout(finalInstallDir);
      if (preservedEnv.content) {
        ensureDir(path.dirname(layout.envPath));
        fs.writeFileSync(layout.envPath, preservedEnv.content, "utf8");
      }
      const initialization = await initializeServiceInternal(app, serviceId, {
        skipInstallRefresh: true,
        assetSignatureOverride: initializationAssetSignature
      });
      if (!initialization.ok) {
        throw new Error(initialization.message);
      }
      return finalInstallDir;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } finally {
    timing.end({ extracted: didExtract });
  }
}

export async function initializeService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return initializeServiceInternal(app, serviceId);
}

async function initializeServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: { skipInstallRefresh?: boolean; assetSignatureOverride?: string } = {}
): Promise<ServiceCommandResult> {
  const timing = beginStartupTiming("initializeServiceInternal", {
    serviceId,
    skipInstallRefresh: Boolean(options.skipInstallRefresh)
  });
  const service = getService(serviceId);
  try {
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const currentState = await getServiceState(app, serviceId);

    if (!currentState.installed) {
      return {
        ok: false,
        message: service.kind === "plugin" ? `${service.name} 尚未导入，请先导入插件。` : `${service.name} 尚未安装。`,
        service: currentState
      };
    }

    if (!isInstallHealthy(service, installDir)) {
      return {
        ok: false,
        message: currentState.message,
        service: currentState
      };
    }

    if (!options.skipInstallRefresh && service.kind === "builtin" && serviceInstallNeedsRefresh(service, installDir)) {
      try {
        await installBuiltinService(app, service.id, { force: true, source: "initializeServiceInternal:refresh" });
      } catch (error) {
        const nextState = await getServiceState(app, serviceId);
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          service: nextState
        };
      }

      const nextState = await getServiceState(app, serviceId);
      return {
        ok: true,
        message: `${service.name} 已重新安装并初始化。`,
        service: nextState
      };
    }

    try {
      fixShellScriptPermissions(installDir);
      patchProgramCommonForLayeredLayout(layout.programDir);
      prepareServiceExecutionLayout(service, layout);
      if (service.id === "agent-container-hub") {
        ensureAgentContainerHubDesktopConfig(layout);
      }
      if (service.deployCommand) {
        await runExecFile(service.deployCommand[0], service.deployCommand.slice(1), installDir, {
          env: buildServiceLayoutEnv(layout)
        });
      }
      await ensureInitializationRequirements(app, service, layout);
      const assetSignature = options.assetSignatureOverride ?? readBuiltinAssetSignature(app, service);
      writeInitializationState(layout, {
        version: service.version,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        ...(assetSignature ? { assetSignature } : {})
      });
    } catch (error) {
      writeInitializationState(layout, {
        version: service.version,
        status: "failed",
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
      const nextState = await getServiceState(app, serviceId);
      return {
        ok: false,
        message: nextState.message,
        service: nextState
      };
    }

    const nextState = await getServiceState(app, serviceId);
    return {
      ok: true,
      message: `${service.name} 已初始化。`,
      service: nextState
    };
  } finally {
    timing.end();
  }
}

export async function listServices(app: App) {
  return Promise.all(getAllServices().map((service) => getServiceState(app, service.id)));
}

export async function getServiceState(app: App, serviceId: ServiceId): Promise<ServiceState> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const installed = fs.existsSync(installDir);
  const pidFilePath = resolveRuntimePath(layout, service.runtime.pidRelativePath);
  const pidFilePaths = getManagedPidFilePaths(service, layout);
  const logFilePath = resolveRuntimePath(layout, service.runtime.logRelativePath);
  const errorLogFilePath = resolveRuntimePath(layout, service.runtime.errorLogRelativePath);
  const configFiles = service.configFiles.map((configFile) => {
    const absolutePath = resolveConfigPath(layout, configFile.relativePath);
    return {
      key: configFile.key,
      label: configFile.label,
      relativePath: configFile.relativePath,
      absolutePath,
      required: configFile.required,
      exists: fs.existsSync(absolutePath)
    };
  });

  const env = installed ? readEnvFile(layout.envPath) : new Map<string, string>();
  const port = parsePort(service, env);
  const webUrl = installed ? getWebUrl(service, env) : getWebUrl(service, new Map<string, string>());
  const pidFromFile = installed ? readManagedPidFile(pidFilePaths, installDir) : null;
  const missingRuntimeFiles = installed ? listMissingRuntimeFiles(service, installDir) : [];
  const initializationState =
    installed && missingRuntimeFiles.length === 0 ? readInitializationState(layout) : null;
  const initializationSucceeded =
    initializationState?.status === "succeeded" && initializationState.version === service.version;
  const prerequisites =
    installed && missingRuntimeFiles.length === 0 && initializationSucceeded
      ? collectPrerequisites(service, layout)
      : [];
  let pid = pidFromFile;
  let running = installed && missingRuntimeFiles.length === 0 && isProcessRunning(pid);
  let conflictingPortPid: number | null = null;

  if (running && pidFromFile) {
    writeManagedPidFiles(pidFilePaths, pidFromFile);
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && port > 0) {
    const detectedPid = detectManagedServicePid(installDir, port);
    if (detectedPid) {
      pid = detectedPid;
      running = true;
      writeManagedPidFiles(pidFilePaths, detectedPid);
    } else {
      conflictingPortPid = listListeningPids(port).find((candidatePid) => candidatePid !== pidFromFile) ?? null;
    }
  }

  let status: ServiceState["status"] = "not-installed";
  let statusLabel = "未安装";
  let message = "尚未安装到本地运行目录。";

  if (installed) {
    status = "stopped";
    statusLabel = "已停止";
    message = "服务已安装，可手动启动。";
  }

  if (installed && missingRuntimeFiles.length > 0) {
    status = "error";
    statusLabel = "安装损坏";
    message = `安装目录缺少关键文件：${missingRuntimeFiles.join(", ")}`;
  }

  if (installed && missingRuntimeFiles.length === 0 && !initializationSucceeded) {
    if (initializationState?.status === "failed" && initializationState.version === service.version) {
      status = "error";
      statusLabel = "初始化失败";
      message = initializationState.lastError ? `初始化失败：${initializationState.lastError}` : "初始化失败，请重试。";
    } else {
      status = "initialization-required";
      statusLabel = "待初始化";
      message = service.kind === "plugin" ? "插件已导入，请先完成初始化。" : "服务已安装，请先完成初始化。";
    }
  }

  if (!installed && service.kind === "builtin") {
    try {
      ensureBundleAssetHealthy(app, service);
    } catch (error) {
      status = "error";
      statusLabel = "资源损坏";
      message = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && prerequisites.length > 0) {
    const hasDependencyError = prerequisites.some((item) => item.includes("Docker") || item.includes("Podman"));
    status = hasDependencyError ? "dependency-missing" : "config-required";
    statusLabel = hasDependencyError ? "依赖未满足" : "待配置";
    message = prerequisites.join("；");
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && conflictingPortPid) {
    status = "error";
    statusLabel = "端口冲突";
    message = `端口 ${port} 已被其他进程占用（PID ${conflictingPortPid}）。`;
  }

  if (running && initializationSucceeded) {
    status = "running";
    statusLabel = "运行中";
    message = `服务进程正在运行。${webUrl ? `入口：${webUrl}` : ""}`.trim();
  }

  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    version: service.version,
    description: service.description,
    installDir,
    paths: {
      programDir: layout.programDir,
      configDir: layout.configDir,
      dataDir: layout.dataDir,
      stateDir: layout.stateDir,
      logDir: layout.logDir
    },
    installed,
    status,
    statusLabel,
    message,
    frontendMode: service.frontend.mode,
    configFiles,
    healthMeta: {
      pid,
      pidFilePath,
      logFilePath,
      errorLogFilePath,
      webUrl,
      port,
      prerequisites
    }
  };
}

function buildVerificationResult(
  service: ServiceDefinition,
  state: ServiceState,
  desired: ServiceDesiredStatus,
  probes: HttpProbeResult[] = []
): ServiceVerification {
  const installDir = getInstallDirFromState(state);
  const pid = state.healthMeta.pid;
  const pidAlive = desired === "running" ? isProcessRunning(pid) : !pid || !isProcessRunning(pid);
  const port = state.healthMeta.port ?? 0;
  const listeningPids = port > 0 ? listListeningPids(port) : [];
  const managedPortPid = listeningPids.find((candidatePid) => (
    installDir ? pidMatchesInstallDir(candidatePid, installDir) : true
  )) ?? null;
  const portListening = port > 0 ? Boolean(managedPortPid) : desired === "running";
  const httpProbe = probes.find((probe) => probe.target === state.healthMeta.webUrl);
  const runtimeInfoProbe = probes.find((probe) => probe.target.includes("/api/runtime-info"));
  const issues: string[] = [];

  if (desired === "running") {
    if (state.status !== "running") {
      issues.push(`复查后服务状态仍为 ${state.status}`);
    }
    if (pid && !isProcessRunning(pid)) {
      issues.push(`PID ${pid} 已不存在`);
    }
    if (!pid) {
      issues.push("没有读取到有效 PID");
    }
    if (service.id === "agent-container-hub") {
      if (port > 0 && !managedPortPid) {
        issues.push(`端口 ${port} 无受管进程监听`);
      }
      if (httpProbe && !httpProbe.ok) {
        issues.push(`${httpProbe.target} 探测失败：${httpProbe.message || "HTTP 不可用"}`);
      }
      if (runtimeInfoProbe) {
        const looksJson = /application\/json/iu.test(runtimeInfoProbe.contentType || "")
          || /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "");
        if (!runtimeInfoProbe.ok || !looksJson) {
          issues.push(runtimeInfoProbe.ok
            ? `HTTP ${runtimeInfoProbe.statusCode} 但 /api/runtime-info 返回的不是 JSON`
            : `/api/runtime-info 探测失败：${runtimeInfoProbe.message || "HTTP 不可用"}`);
        }
      } else {
        issues.push("缺少 /api/runtime-info 验证结果");
      }
    }
  } else {
    if (state.status === "running") {
      issues.push("复查后服务仍处于 running");
    }
    if (pid && isProcessRunning(pid)) {
      issues.push(`PID ${pid} 仍在运行`);
    }
    if (port > 0 && managedPortPid) {
      issues.push(`端口 ${port} 仍被受管进程 PID ${managedPortPid} 监听`);
    }
  }

  const baseVerified = desired === "running"
    ? state.status === "running" && pidAlive
    : state.status !== "running" && pidAlive && !managedPortPid;
  const strictVerified = service.id === "agent-container-hub" && desired === "running"
    ? baseVerified && portListening && probes.every((probe) => probe.ok) && Boolean(runtimeInfoProbe)
    : baseVerified;

  return {
    verified: strictVerified && issues.length === 0,
    desired,
    actualStatus: state.status,
    pidAlive,
    portListening,
    managedPortPid,
    httpOk: httpProbe ? httpProbe.ok : null,
    runtimeInfoOk: runtimeInfoProbe ? runtimeInfoProbe.ok && (
      /application\/json/iu.test(runtimeInfoProbe.contentType || "") ||
      /^\s*[{[]/u.test(runtimeInfoProbe.bodyPreview || "")
    ) : null,
    checkedAt: new Date().toISOString(),
    issues,
    probes: probes.map((probe) => ({
      target: probe.target,
      ok: probe.ok,
      statusCode: probe.statusCode,
      contentType: probe.contentType,
      message: probe.message
    }))
  };
}

function getInstallDirFromState(state: ServiceState) {
  return state.installDir || "";
}

async function collectServiceVerification(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus
): Promise<{ state: ServiceState; verification: ServiceVerification }> {
  const service = getService(serviceId);
  const state = await getServiceState(app, serviceId);
  const probes: HttpProbeResult[] = [];

  if (desired === "running" && state.status === "running" && state.healthMeta.webUrl) {
    const webUrl = state.healthMeta.webUrl;
    probes.push(await probeHttpUrl(webUrl));
    if (service.id === "agent-container-hub") {
      probes.push(await probeHttpUrl(normalizeProbeUrl(webUrl, "/api/runtime-info")));
    }
  }

  return {
    state,
    verification: buildVerificationResult(service, state, desired, probes)
  };
}

export async function verifyServiceState(
  app: App,
  serviceId: ServiceId,
  desired: ServiceDesiredStatus
): Promise<ServiceVerification> {
  const timing = beginStartupTiming("verifyServiceState", { serviceId, desired });
  let verified = false;
  try {
    const delayMs = getServiceVerificationDelayMs();
    const service = getService(serviceId);
    const retryUntil = service.id === "agent-container-hub" && desired === "running"
      ? Date.now() + CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS
      : 0;
    let current = await collectServiceVerification(app, serviceId, desired);
    if (current.verification.verified && delayMs <= 0) {
      verified = true;
      return current.verification;
    }

    do {
      await delay(delayMs > 0 ? delayMs : 1500);
      current = await collectServiceVerification(app, serviceId, desired);
      if (current.verification.verified) {
        verified = true;
        return current.verification;
      }
    } while (
      retryUntil > 0 &&
      Date.now() < retryUntil &&
      shouldRetryServiceVerification(service, desired, current.verification)
    );

    verified = current.verification.verified;
    return current.verification;
  } finally {
    timing.end({ verified });
  }
}

function serviceVerificationFailureMessage(actionMessage: string, verification: ServiceVerification) {
  const issues = verification.issues.length > 0 ? verification.issues.join("；") : `状态为 ${verification.actualStatus}`;
  return `${actionMessage}，但复查失败：${issues}`;
}

function shouldRetryServiceVerification(
  service: ServiceDefinition,
  desired: ServiceDesiredStatus,
  verification: ServiceVerification
) {
  return service.id === "agent-container-hub" &&
    desired === "running" &&
    !verification.verified &&
    verification.actualStatus === "running" &&
    verification.pidAlive;
}

async function attachServiceVerification(
  app: App,
  serviceId: ServiceId,
  result: ServiceCommandResult,
  desired: ServiceDesiredStatus,
  actionMessage: string
): Promise<ServiceCommandResult> {
  const verification = await verifyServiceState(app, serviceId, desired);
  const service = await getServiceState(app, serviceId);
  if (!verification.verified) {
    return {
      ...result,
      ok: false,
      message: serviceVerificationFailureMessage(actionMessage, verification),
      service,
      verification
    };
  }
  return {
    ...result,
    ok: true,
    service,
    verification
  };
}

async function applyEnvBindings(app: App, service: ServiceDefinition, env: Map<string, string>, updates: Map<string, string>) {
  for (const binding of service.desktop.envBindings) {
    const bindingKey = binding.key;
    if (service.id === "agent-webclient" && AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS.has(bindingKey)) {
      continue;
    }
    const currentValue = env.get(bindingKey) ?? "";

    if (binding.onlyIfDefault) {
      const defaults = new Set(binding.defaults ?? [""]);
      if (!defaults.has(currentValue)) {
        continue;
      }
    }

    if (binding.fromService && binding.template) {
      try {
        const depState = await getServiceState(app, binding.fromService);
        const port = depState.healthMeta.port ?? 0;
        const resolved = binding.template.replace("{{port}}", String(port));
        updates.set(bindingKey, resolved);
      } catch {
        // Dependency service not registered; skip this binding.
      }
      continue;
    }

    if (binding.value !== undefined) {
      if (
        bindingKey === "NODE_BIN" &&
        binding.value.trim() === PROCESS_EXEC_PATH_PLACEHOLDER &&
        NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)
      ) {
        continue;
      }
      const resolved = binding.value.replace("{{serviceDefaultPort}}", String(service.web.defaultPort));
      updates.set(bindingKey, resolved);
    }
  }
}

function getEnvValueWithUpdates(env: Map<string, string>, updates: Map<string, string>, key: string) {
  return updates.get(key) ?? env.get(key) ?? "";
}

function resolveEnvBindingValue(service: ServiceDefinition, bindingKey: string) {
  const binding = service.desktop.envBindings.find((item) => {
    return item.key === bindingKey && item.value !== undefined;
  });
  if (!binding?.value) {
    return String(service.web.defaultPort);
  }
  return binding.value.replace("{{serviceDefaultPort}}", String(service.web.defaultPort));
}

function canApplyDefaultEnvBinding(service: ServiceDefinition, bindingKey: string, currentValue: string) {
  const binding = service.desktop.envBindings.find((item) => {
    return item.key === bindingKey && item.value !== undefined;
  });
  if (!binding) {
    return false;
  }
  if (!binding.onlyIfDefault) {
    return true;
  }
  return new Set(binding.defaults ?? [""]).has(currentValue);
}

function syncCoreServiceDefaultPortEnv(
  service: ServiceDefinition,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  if (!CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  for (const key of getServicePortEnvKeys(service)) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (!options.force && !canApplyDefaultEnvBinding(service, key, currentValue)) {
      continue;
    }
    updates.set(key, resolveEnvBindingValue(service, key));
  }
}

function isDesktopManagedContainerHubUrl(value: string) {
  return isDesktopManagedHttpUrl(
    value,
    DESKTOP_MANAGED_CONTAINER_HUB_URL_PORTS,
    CONTAINER_HUB_SERVICE_HOSTS,
    true
  );
}

function addManagedUrlPort(ports: Set<string>, port: number | null | undefined) {
  if (port && port > 0 && port <= MAX_TCP_PORT) {
    ports.add(String(port));
  }
}

function isDesktopManagedPlatformUrl(
  value: string,
  currentPlatformPort: number | null,
  additionalManagedPorts: Array<number | null | undefined> = []
) {
  const managedPorts = new Set(DESKTOP_MANAGED_PLATFORM_URL_PORTS);
  addManagedUrlPort(managedPorts, currentPlatformPort);
  for (const port of additionalManagedPorts) {
    addManagedUrlPort(managedPorts, port);
  }
  return isDesktopManagedHttpUrl(value, managedPorts, LOCAL_SERVICE_HOSTS);
}

async function getServicePortForEnvSync(app: App, serviceId: ServiceId) {
  try {
    const state = await getServiceState(app, serviceId);
    return state.healthMeta.port ?? getService(serviceId).web.defaultPort;
  } catch {
    try {
      return getService(serviceId).web.defaultPort;
    } catch {
      return null;
    }
  }
}

async function syncAgentPlatformContainerHubUrl(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  if (!hubPort) {
    return;
  }

  const currentValue = getEnvValueWithUpdates(env, updates, "CONTAINER_HUB_BASE_URL");
  if (!options.force && currentValue && !isDesktopManagedContainerHubUrl(currentValue)) {
    return;
  }

  updates.set("CONTAINER_HUB_BASE_URL", `http://127.0.0.1:${hubPort}`);
}

function syncAgentWebclientPlatformUrlsToPort(
  env: Map<string, string>,
  updates: Map<string, string>,
  platformPort: number | null,
  additionalManagedPorts: Array<number | null | undefined> = [],
  options: { force?: boolean } = {}
) {
  if (!platformPort) {
    return;
  }

  const platformUrl = `http://127.0.0.1:${platformPort}`;
  for (const key of AGENT_WEBCLIENT_PLATFORM_URL_KEYS) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (!options.force && currentValue && !isDesktopManagedPlatformUrl(currentValue, platformPort, additionalManagedPorts)) {
      continue;
    }
    updates.set(key, platformUrl);
  }
}

async function syncAgentWebclientPlatformUrls(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>,
  options: { force?: boolean } = {}
) {
  const platformPort = await getServicePortForEnvSync(app, "agent-platform");
  syncAgentWebclientPlatformUrlsToPort(env, updates, platformPort, [], options);
}

async function syncCoreServiceDesktopInitializationConfig(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  if (service.id === "agent-container-hub") {
    ensureAgentContainerHubDesktopConfig(layout);
  }

  const envPath = layout.envPath;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (service.id === "agent-container-hub") {
    const normalizedContent = normalizeAgentContainerHubEnvContentForDesktop(content);
    if (normalizedContent !== content) {
      ensureDir(path.dirname(envPath));
      fs.writeFileSync(envPath, normalizedContent, "utf8");
      content = normalizedContent;
    }
  }
  if (service.id === "agent-webclient") {
    const normalizedContent = normalizeAgentWebclientEnvContentForDesktop(content);
    if (normalizedContent !== content) {
      ensureDir(path.dirname(envPath));
      fs.writeFileSync(envPath, normalizedContent, "utf8");
      content = normalizedContent;
    }
  }

  const env = parseEnvFileContent(content);
  const updates = new Map<string, string>();
  await applyEnvBindings(app, service, env, updates);
  syncCoreServiceDefaultPortEnv(service, env, updates, { force: true });

  if (service.id === "zenmind-app-server") {
    syncZenmindAppServerDesktopEnv(layout, content, updates);
  }

  if (service.id === "agent-platform") {
    if (getEnvValueWithUpdates(env, updates, "AUTH_ENABLED") !== "true") {
      updates.set("AUTH_ENABLED", "true");
    }
    updates.set("PROVIDER_APIKEY_KEY_PART", DEFAULT_PROVIDER_APIKEY_KEY_PART);
    await syncAgentPlatformContainerHubUrl(app, env, updates, { force: true });
    const runtimeRoot = resolveAgentPlatformInitializationRuntimeRoot(app);
    updates.set("RUNTIME_DIR", formatDesktopAgentPlatformRuntimeRoot(app, runtimeRoot));
  }

  if (service.id === "agent-webclient") {
    await syncAgentWebclientPlatformUrls(app, env, updates, { force: true });
  }

  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates, {
      uncommentExisting: service.id === "agent-platform"
    });
  }

  if (service.id === "zenmind-app-server") {
    await ensureAppServerJwk(app);
  }

  if (service.id === "agent-platform") {
    await ensureAgentPlatformAppServerPublicKey(app, layout);
  }
}

function shouldReinitializeMissingCoreServiceConfig(service: ServiceDefinition, state: ServiceState) {
  return (
    service.kind === "builtin" &&
    CORE_SERVICE_IDS.has(service.id) &&
    state.status === "config-required" &&
    state.configFiles.some((configFile) => configFile.required && !configFile.exists)
  );
}

async function ensureAgentPlatformContainerHubDependency(app: App, layout: ServiceLayout) {
  let hubService: ServiceDefinition;
  try {
    hubService = getService("agent-container-hub");
  } catch {
    return;
  }

  const env = readEnvFile(layout.envPath);
  const baseURL = env.get("CONTAINER_HUB_BASE_URL")?.trim() ?? "";
  if (!isDesktopManagedContainerHubUrl(baseURL)) {
    return;
  }

  const hubState = await getServiceState(app, hubService.id);
  if (hubState.status === "running") {
    return;
  }
  if (hubState.status === "not-installed") {
    return;
  }

  // Container Hub powers optional sandbox/runtime metadata. agent-platform can
  // start without it and falls back internally, so the Desktop default startup
  // must not install or start it as a hard dependency.
  console.warn(
    `[service-manager] Container Hub is not running (${hubState.status}); starting agent-platform without it.`
  );
}

async function ensureAgentPlatformAppServerPublicKey(app: App, layout: ServiceLayout) {
  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const publicKeyEnvValue = env.get("AUTH_LOCAL_PUBLIC_KEY_FILE")?.trim() ?? "";
  const usesCustomPublicKey = publicKeyEnvValue
    ? !isManagedAgentPlatformAuthLocalPublicKeyPath(publicKeyEnvValue, layout)
    : false;
  const updates = new Map<string, string>();

  if (env.get("AUTH_ENABLED")?.trim() !== "true") {
    updates.set("AUTH_ENABLED", "true");
  }

  if (usesCustomPublicKey) {
    if (updates.size > 0) {
      writeEnvFileUpdates(envPath, updates);
    }
    return;
  }

  const appServerService = getService("zenmind-app-server");
  await ensureMutableInstallDir(app, appServerService);
  const { publicKeyPem } = await ensureAppServerJwk(app);
  const targetPath = resolveConfigPath(layout, AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE);

  ensureDir(path.dirname(targetPath));
  const currentPublicKey = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  if (currentPublicKey !== publicKeyPem) {
    fs.writeFileSync(targetPath, publicKeyPem, "utf8");
  }

  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

async function ensureAgentPlatformDesktopConfig(app: App, service: ServiceDefinition, layout: ServiceLayout) {
  normalizeAgentPlatformDeprecatedConfigFiles(layout);

  const envPath = layout.envPath;
  const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const normalizedContent = normalizeAgentPlatformEnvContentForRuntime(currentContent, layout);
  if (normalizedContent !== currentContent) {
    ensureDir(path.dirname(envPath));
    fs.writeFileSync(envPath, normalizedContent, "utf8");
  }
  const env = parseEnvFileContent(normalizedContent);
  const updates = new Map<string, string>();

  await applyEnvBindings(app, service, env, updates);
  await syncAgentPlatformContainerHubUrl(app, env, updates);

  if (!env.get("PROVIDER_APIKEY_KEY_PART")?.trim()) {
    updates.set("PROVIDER_APIKEY_KEY_PART", DEFAULT_PROVIDER_APIKEY_KEY_PART);
  }
  applyAgentPlatformWindowsHostShellDefaults(env, updates);

  const desktopRuntimeRoot = resolvePreferredAgentPlatformRuntimeRoot(app);
  if (!hasConfiguredAgentPlatformRuntimePath(env)) {
    updates.set("RUNTIME_DIR", formatDesktopAgentPlatformRuntimeRoot(app, desktopRuntimeRoot));
  }

  if (updates.size > 0) {
    normalizeShellSourcedAgentPlatformEnvUpdates(updates);
    writeEnvFileUpdates(envPath, updates);
  }
}

async function ensurePreStartRequirements(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  prepareServiceExecutionLayout(service, layout);
  patchProgramCommonForLayeredLayout(layout.programDir);

  if (service.id === "agent-platform") {
    await ensureAgentPlatformDesktopConfig(app, service, layout);
    await ensureDesktopRegisterApiKey(app);
    await ensureAgentPlatformContainerHubDependency(app, layout);
  }

  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, layout);
  }

  if (service.id === "agent-webclient") {
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = agentWebclientInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, layout, app, service))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh,
        source: "ensurePreStartRequirements:agent-webclient-refresh"
      });
    }
  }

  if (service.id === "zenmind-app-server") {
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = zenmindAppServerInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, layout, app, service))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh,
        source: "ensurePreStartRequirements:app-server-refresh"
      });
    }
  }

  if (service.id === "zenmind-app-server") {
    const envPath = layout.envPath;
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const env = parseEnvFileContent(content);
    const updates = new Map<string, string>();
    syncCoreServiceDefaultPortEnv(service, env, updates, { force: true });
    syncZenmindAppServerDesktopEnv(layout, content, updates);
    if (updates.size > 0) {
      writeEnvFileUpdates(envPath, updates);
    }
    await ensureAppServerJwk(app);
  }

  if (service.id === "agent-platform") {
    await ensureAgentPlatformAppServerPublicKey(app, layout);
  }
}

type RunServiceCommandOptions = {
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

type StartServiceOptions = {
  skipPreStartRequirements?: boolean;
  skipBuiltinAssetRefresh?: boolean;
};

function getPreparedStartupStartOptions(): StartServiceOptions {
  return {
    skipPreStartRequirements: true,
    skipBuiltinAssetRefresh: true
  };
}

function yieldStartupScheduler() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const NODE_BIN_START_ENV_SERVICE_IDS = new Set<ServiceId>([
  "agent-webclient",
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID
]);

function resolveNodeBinStartEnv() {
  const nodeBin = resolveNodeBin();
  const env: Record<string, string> = { NODE_BIN: nodeBin };
  if (nodeBin === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function getStartCommandEnvOverrides(_app: App, service: ServiceDefinition) {
  if (!NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)) {
    return undefined;
  }

  return resolveNodeBinStartEnv();
}

function getDesktopStartCommandOptions(app: App, service: ServiceDefinition): RunServiceCommandOptions {
  return {
    refreshBuiltinAsset: false,
    env: getStartCommandEnvOverrides(app, service)
  };
}

function buildDesktopServiceCommandEnv(
  app: App,
  layout: ServiceLayout,
  overrides: NodeJS.ProcessEnv | undefined
) {
  return {
    ...buildServiceLayoutEnv(layout),
    ...(overrides ?? {}),
    DESKTOP_DEVICE_ID: getDesktopDeviceId(app)
  };
}

function isDaemonStartArg(value: string) {
  return value.trim().toLowerCase() === "--daemon" || value.trim().toLowerCase() === "-daemon";
}

function getDesktopStartCommand(service: Pick<ServiceDefinition, "id" | "kind" | "startCommand">) {
  if (
    service.kind !== "builtin" ||
    !CORE_SERVICE_IDS.has(service.id) ||
    service.startCommand.some(isDaemonStartArg)
  ) {
    return service.startCommand;
  }

  return [...service.startCommand, "--daemon"];
}

async function runServiceCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  successMessage: string,
  options: RunServiceCommandOptions = {}
) {
  const timing = beginStartupTiming("runServiceCommand", {
    serviceId: service.id,
    command: command[0] ? path.basename(command[0]) : "none",
    args: command.slice(1).join(",") || "none"
  });
  const installDir = getInstallDir(app, service);
  try {
    const shouldRefreshBuiltinAsset = options.refreshBuiltinAsset !== false;
    if (service.kind === "builtin" && shouldRefreshBuiltinAsset) {
      const assetPath = getOptionalBundleAssetPath(app, service);
      if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
        if (!assetPath) {
          throw new Error(`${service.name} 未安装或安装已损坏。`);
        }
        await installBuiltinService(app, service.id, { source: "runServiceCommand:missing-install" });
      } else if (assetPath && isAssetNewerThanInstall(assetPath, getServiceLayout(app, service), app, service)) {
        await installBuiltinService(app, service.id, { source: "runServiceCommand:asset-newer" });
      }
    } else if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      throw new Error(`${service.name} 未安装或安装已损坏。`);
    }

    if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      if (service.kind !== "builtin") {
        throw new Error(`${service.name} 未安装或安装已损坏。`);
      }
      if (!shouldRefreshBuiltinAsset) {
        throw new Error(`${service.name} 未安装或安装已损坏。`);
      }
      ensureBundleAssetHealthy(app, service);
      await installBuiltinService(app, service.id, { source: "runServiceCommand:repair-install" });
    }
    if (command.length === 0) {
      throw new Error(`${service.name} 缺少可执行脚本定义。`);
    }
    const layout = getServiceLayout(app, service);
    prepareServiceExecutionLayout(service, layout);
    await runExecFile(command[0], command.slice(1), installDir, {
      timeoutMs: options.timeoutMs,
      env: buildDesktopServiceCommandEnv(app, layout, options.env)
    });
    return {
      ok: true,
      message: successMessage,
      service: await getServiceState(app, service.id)
    } satisfies ServiceCommandResult;
  } finally {
    timing.end();
  }
}

async function startServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: StartServiceOptions = {}
): Promise<ServiceCommandResult> {
  const current = await getServiceState(app, serviceId);
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const shouldRefreshFromBundledAsset =
    service.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    needsBundledAssetRefresh(app, service);

  if (shouldRefreshFromBundledAsset) {
    if (current.status === "running") {
      await stopService(app, serviceId);
    }
    await installBuiltinService(app, serviceId, { source: "prepareBuiltinServiceForStartup" });
  }

  const refreshedState = shouldRefreshFromBundledAsset
    ? await getServiceState(app, serviceId)
    : current;
  const initializationState = refreshedState.installed ? readInitializationState(getServiceLayout(app, service)) : null;
  let preparedState = refreshedState;

  if (shouldReinitializeMissingCoreServiceConfig(service, preparedState)) {
    const initialization = await initializeServiceInternal(app, serviceId, { skipInstallRefresh: true });
    if (!initialization.ok) {
      return initialization;
    }
    preparedState = initialization.service;
  }

  if (preparedState.status === "initialization-required") {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (initializationState?.status === "failed" && initializationState.version === service.version) {
    return {
      ok: false,
      message: preparedState.message,
      service: preparedState
    };
  }

  if (
    preparedState.kind === "builtin" &&
    !options.skipBuiltinAssetRefresh &&
    (!preparedState.installed || (preparedState.status === "error" && !isInstallHealthy(service, installDir)))
  ) {
    await installBuiltinService(app, serviceId, { source: "startServiceInternal:asset-refresh" });
  }
  const nextState = await getServiceState(app, serviceId);
  if (
    nextState.status === "config-required" ||
    nextState.status === "dependency-missing" ||
    nextState.status === "error"
  ) {
    return {
      ok: false,
      message: nextState.message,
      service: nextState
    };
  }
  let result: ServiceCommandResult;
  if (nextState.status === "running") {
    result = {
      ok: true,
      message: `${nextState.name} 已在运行。`,
      service: nextState
    };
  } else {
    if (!options.skipPreStartRequirements) {
      await ensurePreStartRequirements(app, service);
    }
    const preStartState = await getServiceState(app, serviceId);
    if (
      preStartState.status === "config-required" ||
      preStartState.status === "dependency-missing" ||
      preStartState.status === "error"
    ) {
      return {
        ok: false,
        message: preStartState.message,
        service: preStartState
      };
    }
    if (preStartState.status === "running") {
      result = {
        ok: true,
        message: `${preStartState.name} 已在运行。`,
        service: preStartState
      };
    } else {
      result = await runServiceCommand(
        app,
        service,
        getDesktopStartCommand(service),
        `${service.name} 已启动。`,
        getDesktopStartCommandOptions(app, service)
      );
      startedThisSession.add(serviceId);
    }
  }

  const verifiedResult = await attachServiceVerification(app, serviceId, result, "running", `${service.name} 启动命令已执行`);
  return verifiedResult;
}

export async function startService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return startServiceInternal(app, serviceId);
}

export async function stopService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId);
  if (!current.installed) {
    return {
      ok: true,
      message: `${service.name} 尚未安装。`,
      service: current
    };
  }
  if (current.status !== "running") {
    return {
      ok: true,
      message: `${service.name} 当前未运行。`,
      service: current
    };
  }

  const result = await runServiceCommand(app, service, service.stopCommand, `${service.name} 已停止。`, {
    refreshBuiltinAsset: false
  });
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const envPath = layout.envPath;
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  const stopVerification = ensureManagedServiceStoppedForPlatform(service, layout, env);
  if (!stopVerification.ok) {
    throw new Error(stopVerification.message);
  }
  startedThisSession.delete(serviceId);

  return attachServiceVerification(app, serviceId, result, "stopped", `${service.name} 停止命令已执行`);
}

async function runServiceRestart(
  stopOperation: () => Promise<ServiceCommandResult>,
  startOperation: () => Promise<ServiceCommandResult>
) {
  await stopOperation();
  return startOperation();
}

export async function restartService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return runServiceRestart(
    () => stopService(app, serviceId),
    () => startService(app, serviceId)
  );
}

export async function readServiceConfig(app: App, serviceId: ServiceId, key: string): Promise<ServiceConfigReadResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const filePath = resolveConfigPath(layout, configFile.relativePath);
  if (!fs.existsSync(installDir)) {
    return {
      ok: true,
      path: filePath,
      content: "",
      exists: false,
      source: "missing"
    };
  }

  if (fs.existsSync(filePath)) {
    return {
      ok: true,
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
      exists: true,
      source: "file"
    };
  }

  if (configFile.templateRelativePath) {
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      return {
        ok: true,
        path: filePath,
        content: fs.readFileSync(templatePath, "utf8"),
        exists: false,
        source: "template"
      };
    }
  }

  return {
    ok: true,
    path: filePath,
    content: "",
    exists: false,
    source: "missing"
  };
}

export async function writeServiceConfig(
  app: App,
  serviceId: ServiceId,
  key: string,
  content: string
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }
  const installDir = await ensureMutableInstallDir(app, service);
  const layout = getServiceLayout(app, service);

  const filePath = resolveConfigPath(layout, configFile.relativePath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  prepareServiceExecutionLayout(service, layout);

  const message =
    key === "env" && CORE_SERVICE_IDS.has(service.id)
      ? `${service.name} 配置已保存。端口修改需重启服务后生效。`
      : `${service.name} 配置已保存。`;

  return {
    ok: true,
    message,
    service: await getServiceState(app, serviceId)
  };
}

export async function importServiceFile(
  app: App,
  serviceId: ServiceId,
  targetKey: string,
  sourcePath: string
): Promise<ServiceImportResult> {
  const service = getService(serviceId);
  const target = service.importTargets.find((item) => item.key === targetKey);
  if (!target) {
    throw new Error(`unknown import target: ${targetKey}`);
  }

  const installDir = await ensureMutableInstallDir(app, service);
  const layout = getServiceLayout(app, service);

  const targetPath = resolveConfigPath(layout, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  prepareServiceExecutionLayout(service, layout);

  return {
    ok: true,
    message: `${target.label} 已导入。`,
    targetPath,
    service: await getServiceState(app, serviceId)
  };
}

export async function getServiceLogsMeta(app: App, serviceId: ServiceId): Promise<ServiceLogsMeta> {
  const state = await getServiceState(app, serviceId);
  return {
    ok: true,
    logPath: state.healthMeta.logFilePath,
    exists: fs.existsSync(state.healthMeta.logFilePath)
  };
}

export async function readServiceLog(
  app: App,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogReadOptions = {}
): Promise<ServiceLogReadResult> {
  const state = await getServiceState(app, serviceId);
  const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;
  return readServiceLogFile(filePath, options);
}

export function watchServiceLog(
  app: App,
  subscriptionId: string,
  serviceId: ServiceId,
  target: ServiceLogTarget,
  options: ServiceLogStreamOptions = {},
  onEvent: ServiceLogStreamCallback
) {
  let currentPath = "";
  let currentOffset = normalizeLogStreamOffset(options);
  let currentExists = false;
  let polling = false;
  let stopped = false;

  async function sendReset(message: string) {
    const result = await readServiceLog(app, serviceId, target);
    currentPath = result.path;
    currentOffset = result.endOffset;
    currentExists = result.exists;
    onEvent({
      subscriptionId,
      serviceId,
      target,
      type: "reset",
      path: result.path,
      exists: result.exists,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      hasPrevious: result.hasPrevious,
      totalBytes: result.totalBytes,
      message
    });
  }

  async function poll() {
    if (polling || stopped) {
      return;
    }

    polling = true;
    try {
      const state = await getServiceState(app, serviceId);
      const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;

      if (!filePath) {
        if (currentPath || currentExists) {
          currentPath = "";
          currentOffset = 0;
          currentExists = false;
          onEvent({
            subscriptionId,
            serviceId,
            target,
            type: "reset",
            path: "",
            exists: false,
            content: "",
            startOffset: 0,
            endOffset: 0,
            hasPrevious: false,
            totalBytes: 0,
            message: "日志路径已清空。"
          });
        }
        return;
      }

      if (currentPath && filePath !== currentPath) {
        await sendReset("日志路径已变化，已刷新到最新内容。");
        return;
      }

      currentPath = filePath;

      if (!fs.existsSync(filePath)) {
        currentExists = false;
        return;
      }

      const stat = fs.statSync(filePath);
      const totalBytes = stat.size;
      if (totalBytes < currentOffset) {
        await sendReset("日志已轮转，已刷新到最新内容。");
        return;
      }

      currentExists = true;
      if (totalBytes <= currentOffset) {
        currentOffset = totalBytes;
        return;
      }

      const deltaBytes = totalBytes - currentOffset;
      if (deltaBytes > LOG_READ_WINDOW_BYTES) {
        await sendReset("日志增长较快，已刷新到最新内容。");
        return;
      }

      const startOffset = currentOffset;
      const content = readLogRange(filePath, startOffset, totalBytes);
      currentOffset = totalBytes;
      if (content.length === 0) {
        return;
      }

      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "append",
        path: filePath,
        exists: true,
        content,
        startOffset,
        endOffset: totalBytes,
        hasPrevious: startOffset > 0,
        totalBytes
      });
    } catch (reason) {
      onEvent({
        subscriptionId,
        serviceId,
        target,
        type: "error",
        path: currentPath,
        exists: currentExists,
        content: "",
        startOffset: currentOffset,
        endOffset: currentOffset,
        hasPrevious: currentOffset > 0,
        totalBytes: currentOffset,
        message: reason instanceof Error ? reason.message : String(reason)
      });
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, normalizeLogStreamPollInterval(options));
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function stopStartedServices(app: App) {
  for (const serviceId of [...startedThisSession]) {
    try {
      await stopService(app, serviceId);
    } catch (error) {
      console.error(`failed to stop ${serviceId} during app shutdown`, error);
    }
  }
}

export async function stopRunningServices(app: App) {
  const services = await listServices(app);
  const runningServices = services.filter((service) => service.status === "running");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );
  const failures: string[] = [];

  for (const service of runningServices) {
    try {
      await stopService(app, service.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${service.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`停止运行中服务失败：${failures.join("；")}`);
  }
}

type ShutdownServiceStopResult = {
  ok: boolean;
  serviceId: ServiceId;
  serviceName: string;
  elapsedMs: number;
  message: string;
};

function getShutdownStopCommandTimeoutMs(timeoutMs: number | undefined, platform: NodeJS.Platform | string = process.platform) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : platform === "win32"
      ? WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS
      : SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function stopServiceForShutdown(
  app: App,
  serviceState: ServiceState,
  timeoutMs: number
): Promise<ShutdownServiceStopResult> {
  const service = getService(serviceState.id);
  const startedAt = Date.now();

  try {
    await runServiceCommand(app, service, service.stopCommand, `${service.name} 已停止。`, {
      refreshBuiltinAsset: false,
      timeoutMs
    });
    startedThisSession.delete(service.id);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[service-manager] shutdown stop succeeded for ${service.id} in ${elapsedMs}ms`);
    return {
      ok: true,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message: ""
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = getErrorMessage(error);
    console.warn(`[service-manager] shutdown stop failed for ${service.id} after ${elapsedMs}ms: ${message}`);
    return {
      ok: false,
      serviceId: service.id,
      serviceName: service.name,
      elapsedMs,
      message
    };
  }
}

export async function stopRunningServicesForShutdown(
  app: App,
  options: { stopCommandTimeoutMs?: number } = {}
) {
  const startedAt = Date.now();
  const timeoutMs = getShutdownStopCommandTimeoutMs(options.stopCommandTimeoutMs);
  const services = await listServices(app);
  const runningServices = services.filter((service) => service.status === "running");
  writeLastRunningServices(
    app,
    runningServices.map((service) => service.id)
  );

  if (runningServices.length === 0) {
    console.log("[service-manager] shutdown stop skipped: no running services");
    return {
      ok: true,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      runningServiceIds: [] as ServiceId[],
      stopped: [] as ShutdownServiceStopResult[],
      failures: [] as ShutdownServiceStopResult[]
    };
  }

  const results = await Promise.all(
    runningServices.map((service) => stopServiceForShutdown(app, service, timeoutMs))
  );
  const stopped = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[service-manager] shutdown stop summary: services=${runningServices.length} stopped=${stopped.length} failed=${failures.length} elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}`
  );

  return {
    ok: failures.length === 0,
    timeoutMs,
    elapsedMs,
    runningServiceIds: runningServices.map((service) => service.id),
    stopped,
    failures
  };
}

export async function restoreRunningServices(
  app: App,
  options: {
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: "succeeded" | "failed" | "skipped", message: string) => void;
  } = {}
) {
  const serviceIds = getServiceIdsToRestore(app);
  const restored: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of serviceIds) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId);
      if (
        (current.kind === "plugin" && current.status === "not-installed") ||
        current.status === "initialization-required"
      ) {
        options.onProgress?.(serviceId, "skipped", current.message);
        continue;
      }

      options.onStarting?.(serviceId);
      const startedAt = Date.now();
      const result = await startService(app, serviceId);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        console.info(`[service-manager] restored ${serviceId} in ${elapsedMs}ms`);
        restored.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
      } else {
        console.warn(`[service-manager] failed to restore ${serviceId} after ${elapsedMs}ms: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        if (isNonBlockingRestoreFailure(serviceId)) {
          continue;
        }
        failures.push(`${serviceId}: ${result.message}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${message}`);
      break;
    }
  }

  return {
    restored,
    failures
  };
}

type StartupRestoreOptions = {
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
};

type StartupServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  running: boolean;
};

async function prepareDefaultStartupServiceForParallelRestore(
  app: App,
  serviceId: ServiceId,
  options: StartupRestoreOptions
): Promise<StartupServiceResult> {
  try {
    const current = await getServiceState(app, serviceId);
    if (current.status === "running") {
      return {
        serviceId,
        ok: true,
        message: `${current.name} 已在运行。`,
        running: true
      };
    }

    if (
      current.status === "not-installed" ||
      current.status === "initialization-required"
    ) {
      options.onProgress?.(serviceId, "skipped", current.message);
      return {
        serviceId,
        ok: false,
        message: current.message,
        running: false
      };
    }

    await ensurePreStartRequirements(app, getService(serviceId));
    const prepared = await getServiceState(app, serviceId);
    if (
      prepared.status === "config-required" ||
      prepared.status === "dependency-missing" ||
      prepared.status === "error"
    ) {
      options.onProgress?.(serviceId, "failed", prepared.message);
      return {
        serviceId,
        ok: false,
        message: prepared.message,
        running: false
      };
    }

    return {
      serviceId,
      ok: true,
      message: `${prepared.name} 已准备就绪。`,
      running: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.(serviceId, "failed", message);
    return {
      serviceId,
      ok: false,
      message,
      running: false
    };
  }
}

async function startDefaultStartupServiceForParallelRestore(
  app: App,
  serviceId: ServiceId,
  options: StartupRestoreOptions
): Promise<StartupServiceResult> {
  try {
    const current = await getServiceState(app, serviceId);
    options.onStarting?.(serviceId);

    if (current.status === "running") {
      const message = `${current.name} 已在运行。`;
      console.info(`[service-manager] reused running startup service ${serviceId}`);
      options.onProgress?.(serviceId, "succeeded", message);
      return {
        serviceId,
        ok: true,
        message,
        running: true
      };
    }

    options.onProgress?.(serviceId, "starting", `${current.name} 启动中...`);
    const startedAt = Date.now();
    const result = await startServiceInternal(app, serviceId, { skipPreStartRequirements: true });
    const elapsedMs = Date.now() - startedAt;
    if (result.ok && result.service.status === "running") {
      console.info(`[service-manager] restored ${serviceId} in ${elapsedMs}ms`);
      options.onProgress?.(serviceId, "succeeded", result.message);
      return {
        serviceId,
        ok: true,
        message: result.message,
        running: true
      };
    }

    const failureMessage = result.ok
      ? `${result.service.name} 启动后未进入运行中状态。`
      : result.message;
    console.warn(`[service-manager] failed to restore ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
    options.onProgress?.(serviceId, "failed", failureMessage);
    return {
      serviceId,
      ok: false,
      message: failureMessage,
      running: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.(serviceId, "failed", message);
    return {
      serviceId,
      ok: false,
      message,
      running: false
    };
  }
}

async function restoreDefaultStartupServicesInParallel(
  app: App,
  options: StartupRestoreOptions = {}
) {
  const started: ServiceId[] = [];
  const failures: string[] = [];
  const preflightResults: StartupServiceResult[] = [];

  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    preflightResults.push(await prepareDefaultStartupServiceForParallelRestore(app, serviceId, options));
  }

  const preflightFailures = new Set<ServiceId>();
  for (const result of preflightResults) {
    if (!result.ok) {
      preflightFailures.add(result.serviceId);
      failures.push(`${result.serviceId}: ${result.message}`);
    }
  }

  const servicesToStart = DEFAULT_STARTUP_SERVICE_IDS.filter((serviceId) => !preflightFailures.has(serviceId));
  const startResults = await Promise.all(
    servicesToStart.map((serviceId) => startDefaultStartupServiceForParallelRestore(app, serviceId, options))
  );
  const startResultById = new Map(startResults.map((result) => [result.serviceId, result]));

  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const result = startResultById.get(serviceId);
    if (!result) {
      continue;
    }
    if (result.ok && result.running) {
      started.push(serviceId);
    } else {
      failures.push(`${serviceId}: ${result.message}`);
    }
  }

  return {
    started,
    failures
  };
}

async function restoreOptionalStartupServices(
  app: App,
  options: StartupRestoreOptions = {}
) {
  const started: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of getOptionalServiceIdsToRestore(app)) {
    try {
      getService(serviceId);
    } catch {
      continue;
    }

    try {
      const current = await getServiceState(app, serviceId);
      if (
        (current.kind === "plugin" && current.status === "not-installed") ||
        current.status === "initialization-required"
      ) {
        options.onProgress?.(serviceId, "skipped", current.message);
        continue;
      }

      options.onStarting?.(serviceId);
      options.onProgress?.(serviceId, "starting", `${current.name} 启动中...`);
      const startedAt = Date.now();
      const result = await startService(app, serviceId);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok && result.service.status === "running") {
        console.info(`[service-manager] restored optional startup service ${serviceId} in ${elapsedMs}ms`);
        started.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
        continue;
      }

      const failureMessage = result.ok
        ? `${result.service.name} 启动后未进入运行中状态。`
        : result.message;
      console.warn(`[service-manager] failed to restore optional startup service ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
      options.onProgress?.(serviceId, "failed", failureMessage);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${failureMessage}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.(serviceId, "failed", message);
      if (isNonBlockingRestoreFailure(serviceId)) {
        continue;
      }
      failures.push(`${serviceId}: ${message}`);
      break;
    }
  }

  return {
    started,
    failures
  };
}

async function startPreparedDefaultStartupServiceForBootstrap(
  app: App,
  serviceId: ServiceId,
  current: ServiceState,
  options: StartupRestoreOptions = {}
): Promise<StartupServiceResult> {
  try {
    options.onStarting?.(serviceId);
    options.onProgress?.(serviceId, "starting", `${current.name} starting...`);
    await yieldStartupScheduler();
    const startedAt = Date.now();
    const result = await startServiceInternal(app, serviceId, getPreparedStartupStartOptions());
    const elapsedMs = Date.now() - startedAt;
    if (result.ok && result.service.status === "running") {
      console.info(`[service-manager] bootstrapped ${serviceId} in ${elapsedMs}ms`);
      options.onProgress?.(serviceId, "succeeded", result.message);
      return {
        serviceId,
        ok: true,
        message: result.message,
        running: true
      };
    }

    const failureMessage = result.ok
      ? `${result.service.name} did not enter running state after start`
      : result.message;
    console.warn(`[service-manager] failed to bootstrap ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
    options.onProgress?.(serviceId, "failed", failureMessage);
    return {
      serviceId,
      ok: false,
      message: failureMessage,
      running: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.(serviceId, "failed", message);
    return {
      serviceId,
      ok: false,
      message,
      running: false
    };
  }
}

function shouldEnableBuiltinBootstrap(_app: App) {
  return true;
}

async function shouldRunBuiltinBootstrap(app: App) {
  if (!shouldEnableBuiltinBootstrap(app)) {
    return false;
  }

  for (const serviceId of INSTALL_ONLY_STARTUP_SERVICE_IDS) {
    const current = await getServiceState(app, serviceId);
    if (
      current.status === "not-installed" ||
      current.status === "initialization-required" ||
      shouldReinitializeMissingCoreServiceConfig(getService(serviceId), current)
    ) {
      return true;
    }

    const service = getService(serviceId);
    if (service.kind === "builtin" && needsBundledAssetRefresh(app, service)) {
      return true;
    }

    if (current.status === "error" && installedBuiltinNeedsStartupRepair(app, service, current)) {
      return true;
    }
  }

  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const current = await getServiceState(app, serviceId);
    if (
      current.status === "not-installed" ||
      current.status === "initialization-required" ||
      shouldReinitializeMissingCoreServiceConfig(getService(serviceId), current)
    ) {
      return true;
    }

    const service = getService(serviceId);
    if (service.kind === "builtin" && needsBundledAssetRefresh(app, service)) {
      return true;
    }

    if (current.status === "error" && installedBuiltinNeedsStartupRepair(app, service, current)) {
      return true;
    }
  }

  return false;
}

async function prepareBuiltinServiceForStartup(
  app: App,
  serviceId: ServiceId,
  options: {
    onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
  } = {}
) {
  const service = getService(serviceId);
  let current = await getServiceState(app, serviceId);
  const bundledAssetNeedsRefresh = service.kind === "builtin" && needsBundledAssetRefresh(app, service);
  const installNeedsRepair =
    current.status === "error" && installedBuiltinNeedsStartupRepair(app, service, current);

  if (
    current.status === "not-installed" ||
    bundledAssetNeedsRefresh ||
    installNeedsRepair
  ) {
    options.onProgress?.(serviceId, "installing", `${current.name} 安装中...`);
    if (bundledAssetNeedsRefresh && current.status === "running") {
      await stopService(app, serviceId);
    }
    await installBuiltinService(app, serviceId, { source: "prepareBuiltinServiceForStartup" });
    current = await getServiceState(app, serviceId);
  } else if (current.status === "initialization-required" || shouldReinitializeMissingCoreServiceConfig(service, current)) {
    options.onProgress?.(serviceId, "initializing", `${current.name} 初始化中...`);
    const initialization = await initializeService(app, serviceId);
    if (!initialization.ok) {
      return {
        ok: false,
        message: initialization.message,
        service: initialization.service
      };
    }
    current = initialization.service;
  }

  return {
    ok: true,
    message: `${current.name} 已准备就绪。`,
    service: current
  };
}

export async function runStartupPreparation(
  app: App,
  options: {
    onModeResolved?: (mode: StartupRestoreMode) => void;
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
  } = {}
): Promise<StartupPreparationResult> {
  try {
  await ensureDesktopRegisterApiKey(app);

  if (!(await shouldRunBuiltinBootstrap(app))) {
    options.onModeResolved?.("restore");
    const defaultRestoreResult = await restoreDefaultStartupServicesInParallel(app, {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    const optionalRestoreResult = await restoreOptionalStartupServices(app, {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    return {
      mode: "restore",
      started: [...defaultRestoreResult.started, ...optionalRestoreResult.started],
      failures: [...defaultRestoreResult.failures, ...optionalRestoreResult.failures]
    };
  }

  options.onModeResolved?.("bootstrap");
  const started: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of INSTALL_ONLY_STARTUP_SERVICE_IDS) {
    try {
      const result = await prepareBuiltinServiceForStartup(app, serviceId, {
        onProgress: options.onProgress
      });
      if (!result.ok) {
        console.warn(`[service-manager] optional startup service ${serviceId} is unavailable: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        continue;
      }
      options.onProgress?.(serviceId, "succeeded", result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[service-manager] optional startup service ${serviceId} failed preparation: ${message}`);
      options.onProgress?.(serviceId, "failed", message);
    }
  }

  const preparedDefaultServices = new Map<ServiceId, ServiceState>();
  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    try {
      const preparation = await prepareBuiltinServiceForStartup(app, serviceId, {
        onProgress: options.onProgress
      });
      if (!preparation.ok) {
        failures.push(`${serviceId}: ${preparation.message}`);
        options.onProgress?.(serviceId, "failed", preparation.message);
        continue;
      }

      const current = preparation.service;
      preparedDefaultServices.set(serviceId, current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${serviceId}: ${message}`);
      options.onProgress?.(serviceId, "failed", message);
    }
  }

  const startOptions = {
    onStarting: options.onStarting,
    onProgress: options.onProgress
  };
  const appServerStartupResult = preparedDefaultServices.has("zenmind-app-server")
    ? await startPreparedDefaultStartupServiceForBootstrap(
        app,
        "zenmind-app-server",
        preparedDefaultServices.get("zenmind-app-server")!,
        startOptions
      )
    : null;
  const startResults = [
    ...(appServerStartupResult ? [appServerStartupResult] : []),
    ...(appServerStartupResult?.ok && appServerStartupResult.running
      ? await Promise.all(
          DEFAULT_STARTUP_SERVICE_IDS
            .filter((serviceId) => serviceId !== "zenmind-app-server" && preparedDefaultServices.has(serviceId))
            .map((serviceId) =>
              startPreparedDefaultStartupServiceForBootstrap(
                app,
                serviceId,
                preparedDefaultServices.get(serviceId)!,
                startOptions
              )
            )
        )
      : [])
  ];
  const startResultById = new Map(startResults.map((result) => [result.serviceId, result]));
  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const result = startResultById.get(serviceId);
    if (!result) {
      continue;
    }
    if (result.ok && result.running) {
      started.push(serviceId);
    } else {
      failures.push(`${serviceId}: ${result.message}`);
    }
  }

  const optionalRestoreResult = await restoreOptionalStartupServices(app, {
    onStarting: options.onStarting,
    onProgress: options.onProgress
  });
  started.push(...optionalRestoreResult.started);
  failures.push(...optionalRestoreResult.failures);

  return {
    mode: "bootstrap",
    started,
    failures
  };
  } finally {
    flushStartupTimingSummary();
  }
}

export const __testInternals = {
  LOG_READ_WINDOW_BYTES,
  parseEnvFileContent,
  parsePort,
  getWebUrl,
  containerEngineAvailable,
  probeContainerEngines,
  fixShellScriptPermissions,
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  upsertEnvFileContent,
  ensurePreStartRequirements,
  agentPlatformInstallNeedsRefresh,
  agentWebclientInstallNeedsRefresh,
  zenmindAppServerInstallNeedsRefresh,
  resolveNodeBin,
  getStartCommandEnvOverrides,
  buildDesktopServiceCommandEnv,
  getDesktopStartCommand,
  getDesktopStartCommandOptions,
  getPreparedStartupStartOptions,
  resolveAcpCommandForDesktop,
  normalizeAgentPlatformEnvContentForRuntime,
  normalizeAgentPlatformEnvContentForSave,
  normalizeAgentPlatformBashConfigContent,
  normalizeAgentPlatformFileToolsConfigContent,
  normalizeAgentContainerHubEnvContentForDesktop,
  normalizeAgentWebclientEnvContentForDesktop,
  applyAgentPlatformWindowsHostShellDefaults,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromPowerShell: parseProcessTreeRowsFromWindowsPowerShell,
  buildProcessTreePids,
  collectManagedRootPids,
  captureManagedProcessCleanupSnapshot,
  mergeCleanupTargets,
  terminateProcessTree,
  terminateProcessList,
  collectManagedServiceStopState,
  forceStopServiceInstallDir,
  ensureManagedServiceStoppedForPlatform,
  getShutdownStopCommandTimeoutMs,
  decodePowerShellCapturePayload,
  runExecFile,
  runServiceRestart,
  probeHttpUrl,
  verifyServiceState,
  buildVerificationResult,
  getInitializationStatePath,
  readInitializationState,
  readBuiltinAssetSignature,
  readLogRange,
  getLastRunningServicesStatePath,
  getDefaultStartupServiceIds,
  getServiceIdsToRestore,
  getOptionalServiceIdsToRestore,
  orderServiceIdsForRestore,
  needsBundledAssetRefresh,
  shouldEnableBuiltinBootstrap,
  shouldRunBuiltinBootstrap,
  readLastRunningServices,
  watchServiceLog,
  writeLastRunningServices
};
