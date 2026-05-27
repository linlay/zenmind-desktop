import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { getBuiltinAssetsRoot } from "../../builtin-loader";
import { getAllServices, getService } from "../service-registry";
import { ensureAppServerJwk } from "../../app-server-auth";
import { readEnvFile, parseEnvFileContent } from "../../env-file";
import { extractArchiveToDir, listArchiveEntries } from "../../archive-utils";
import { getDesktopStateRoot } from "../../user-paths";
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

export { getInstallDir } from "./layout";

const startedThisSession = new Set<ServiceId>();

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ServiceLogStreamCallback = (event: ServiceLogStreamEvent) => void;

type ProcessTreeRow = {
  pid: number;
  ppid: number;
};

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

type PowerShellCapturePayload = ExecResult & {
  hadError: boolean;
  exitCode: number;
};

let shellPathEntriesCache: string[] | null = null;

function listExistingDirs(paths: string[]) {
  return paths.filter((dirPath) => {
    try {
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  });
}

function getUserNodeToolPaths() {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".volta", "bin"),
    path.join(homeDir, ".asdf", "shims"),
    path.join(homeDir, ".npm-global", "bin"),
    path.join(homeDir, "bin")
  ];
  const nvmVersionsRoot = path.join(homeDir, ".nvm", "versions", "node");

  try {
    if (fs.existsSync(nvmVersionsRoot) && fs.statSync(nvmVersionsRoot).isDirectory()) {
      const versionBins = fs
        .readdirSync(nvmVersionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(nvmVersionsRoot, entry.name, "bin"))
        .sort()
        .reverse();
      candidates.push(...versionBins);
    }
  } catch {
    // Ignore unreadable user-managed Node installations and keep probing other paths.
  }

  return listExistingDirs(candidates);
}

function getStaticServicePaths() {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const appData = process.env.APPDATA ?? "";
    const userProfile = process.env.USERPROFILE ?? "";
    const nodeBinDir = process.env.ZENMIND_NODE_BIN
      ? path.dirname(process.env.ZENMIND_NODE_BIN)
      : (process.execPath ? path.dirname(process.execPath) : null);
    return [
      path.join(programFiles, "nodejs"),
      path.join(programFiles, "Docker", "Docker", "resources", "bin"),
      path.join(programFiles, "RedHat", "Podman"),
      path.join(programFiles, "Podman"),
      ...(localAppData ? [
        path.join(localAppData, "Programs", "nodejs"),
        path.join(localAppData, "Programs", "Podman"),
        path.join(localAppData, "Programs", "RedHat", "Podman")
      ] : []),
      ...(appData ? [path.join(appData, "npm")] : []),
      path.join(programFiles, "Git", "mingw64", "bin"),
      path.join(programFiles, "Git", "usr", "bin"),
      ...(userProfile ? [path.join(userProfile, "bin")] : []),
      ...(nodeBinDir ? [nodeBinDir] : [])
    ];
  }

  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/podman/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    "/Applications/OrbStack.app/Contents/MacOS/bin",
    ...getUserNodeToolPaths()
  ];
}

function getShellPathEntries() {
  if (process.platform === "win32") {
    return [];
  }
  if (shellPathEntriesCache) {
    return shellPathEntriesCache;
  }

  const shellPath =
    process.env.SHELL
    || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "")
    || (fs.existsSync("/bin/bash") ? "/bin/bash" : "");
  if (!shellPath) {
    shellPathEntriesCache = [];
    return shellPathEntriesCache;
  }

  try {
    const result = spawnSync(shellPath, ["-lc", "printf '%s' \"$PATH\""], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      timeout: 1500
    });
    if (result.status === 0 && !result.error) {
      shellPathEntriesCache = result.stdout.split(path.delimiter).filter(Boolean);
      return shellPathEntriesCache;
    }
  } catch {
    // Fall back to the static service paths when the login shell cannot be probed.
  }

  shellPathEntriesCache = [];
  return shellPathEntriesCache;
}

type InitializationState = {
  version: string;
  status: "succeeded" | "failed";
  updatedAt: string;
  lastError?: string;
  assetSignature?: string;
};

type LastRunningServicesState = {
  runningServiceIds: ServiceId[];
  updatedAt: string;
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

const LAST_RUNNING_SERVICES_FILE = "last-running-services.json";
const INSTALL_ONLY_STARTUP_SERVICE_IDS = ["agent-container-hub"] as const;
const DEFAULT_STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const RESTORE_PRIORITY = ["agent-container-hub", "zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const INSTALL_ONLY_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(INSTALL_ONLY_STARTUP_SERVICE_IDS);
const DEFAULT_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(DEFAULT_STARTUP_SERVICE_IDS);
const SERVICE_COMMAND_TIMEOUT_MS = 60_000;
const SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 2_500;

function buildServiceEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extraPaths = [...getStaticServicePaths(), ...getShellPathEntries()];
  if (extraPaths.length === 0) {
    return env;
  }
  const current = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extraPaths])];
  env.PATH = merged.join(path.delimiter);
  if (process.platform === "win32") {
    env.Path = env.PATH;
  }
  return env;
}

function resolveNodeBin() {
  const explicit = process.env.ZENMIND_NODE_BIN?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  const serviceEnv = buildServiceEnv();
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(locator, ["node"], {
      encoding: "utf8",
      env: serviceEnv,
      timeout: 1500
    });
    if (result.status === 0 && !result.error) {
      const resolved = result.stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // Fall back to Electron when the host does not expose a standalone Node runtime.
  }

  return process.execPath;
}

function resolveCommandBin(command: string) {
  const normalized = command.trim();
  if (!normalized) {
    return "";
  }

  const serviceEnv = buildServiceEnv();
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(locator, [normalized], {
      encoding: "utf8",
      env: serviceEnv,
      timeout: 1500
    });
    if (result.status === 0 && !result.error) {
      return result.stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean) ?? "";
    }
  } catch {
    // Fall back to an empty string when the host command cannot be located.
  }

  return "";
}

function isCommandBasenameMatch(command: string, expected: string) {
  return path.basename(command).toLowerCase() === expected.toLowerCase();
}

const bundleValidationCache = new Map<string, { key: string; missingEntries: string[] }>();
const syncedAssetManifestCache = new Map<string, { key: string; services: SyncedAssetManifestService[] }>();

type SyncedAssetManifestService = {
  id?: unknown;
  version?: unknown;
  assetFileName?: unknown;
  assetSignature?: unknown;
};

function getAssetPath(app: App, service: ServiceDefinition) {
  if (!service.desktop.assetFileName) {
    throw new Error(`桌面端内置资源缺少 assetFileName：${service.id}`);
  }
  return path.join(getBuiltinAssetsRoot(app), service.id, service.desktop.assetFileName);
}

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

function readInitializationState(layoutOrInstallDir: ServiceLayout | string): InitializationState | null {
  const filePath = getInitializationStatePath(layoutOrInstallDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const status = parsed.status === "succeeded" || parsed.status === "failed" ? parsed.status : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const lastError = typeof parsed.lastError === "string" && parsed.lastError.trim() ? parsed.lastError : undefined;
    const assetSignature = typeof parsed.assetSignature === "string" && parsed.assetSignature.trim()
      ? parsed.assetSignature
      : undefined;
    if (!version || !status || !updatedAt) {
      return null;
    }
    return {
      version,
      status,
      updatedAt,
      ...(assetSignature ? { assetSignature } : {}),
      ...(lastError ? { lastError } : {})
    };
  } catch {
    return null;
  }
}

function computeAssetSignature(assetPath: string) {
  const stat = fs.statSync(assetPath);
  const hash = createHash("sha256")
    .update(fs.readFileSync(assetPath))
    .digest("hex");
  return `${stat.size}:${hash}`;
}

function moveExtractedBuiltinRoot(extractedRoot: string, finalInstallDir: string) {
  try {
    fs.renameSync(extractedRoot, finalInstallDir);
    return;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EXDEV") {
      throw error;
    }
  }

  fs.cpSync(extractedRoot, finalInstallDir, { recursive: true, force: true });
  fs.rmSync(extractedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function readSyncedBuiltinAssetManifest(app: App) {
  const manifestPath = path.join(getBuiltinAssetsRoot(app), "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const stat = fs.statSync(manifestPath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = syncedAssetManifestCache.get(manifestPath);
    if (cached && cached.key === cacheKey) {
      return cached.services;
    }

    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { services?: unknown };
    const services = Array.isArray(parsed.services)
      ? parsed.services.filter((item): item is SyncedAssetManifestService => Boolean(item) && typeof item === "object")
      : [];
    syncedAssetManifestCache.set(manifestPath, {
      key: cacheKey,
      services
    });
    return services;
  } catch {
    return [];
  }
}

function readSyncedBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  const assetFileName = service.desktop.assetFileName;
  if (!assetFileName) {
    return undefined;
  }

  const match = readSyncedBuiltinAssetManifest(app).find((entry) =>
    entry.id === service.id &&
    entry.version === service.version &&
    entry.assetFileName === assetFileName &&
    typeof entry.assetSignature === "string" &&
    entry.assetSignature.trim().length > 0
  );

  return typeof match?.assetSignature === "string" ? match.assetSignature : undefined;
}

function readBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return undefined;
  }
  const syncedSignature = readSyncedBuiltinAssetSignature(app, service);
  if (syncedSignature) {
    return syncedSignature;
  }
  const assetPath = getOptionalBundleAssetPath(app, service);
  return assetPath ? computeAssetSignature(assetPath) : undefined;
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

function writeInitializationState(layoutOrInstallDir: ServiceLayout | string, state: InitializationState) {
  const filePath = getInitializationStatePath(layoutOrInstallDir);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getLastRunningServicesStatePath(app: App) {
  return path.join(getDesktopStateRoot(app), LAST_RUNNING_SERVICES_FILE);
}

function orderServiceIdsForRestore(serviceIds: ServiceId[]) {
  const priority = new Map<ServiceId, number>(RESTORE_PRIORITY.map((serviceId, index) => [serviceId, index]));
  return [...new Set(serviceIds)].sort((left, right) => {
    const leftPriority = priority.get(left) ?? RESTORE_PRIORITY.length;
    const rightPriority = priority.get(right) ?? RESTORE_PRIORITY.length;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

function getDefaultStartupServiceIds() {
  return [...DEFAULT_STARTUP_SERVICE_IDS];
}

function getServiceIdsToRestore(app: App) {
  return orderServiceIdsForRestore([
    ...getDefaultStartupServiceIds(),
    ...readLastRunningServices(app)
  ]);
}

function getOptionalServiceIdsToRestore(app: App) {
  return orderServiceIdsForRestore(
    readLastRunningServices(app).filter((serviceId) => !DEFAULT_STARTUP_SERVICE_ID_SET.has(serviceId))
  );
}

function isNonBlockingRestoreFailure(serviceId: ServiceId) {
  return INSTALL_ONLY_STARTUP_SERVICE_ID_SET.has(serviceId);
}

function readLastRunningServices(app: App): ServiceId[] {
  const filePath = getLastRunningServicesStatePath(app);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const runningServiceIds = Array.isArray(parsed.runningServiceIds)
      ? parsed.runningServiceIds.filter((value): value is ServiceId => typeof value === "string" && value.trim().length > 0)
      : [];
    return orderServiceIdsForRestore(runningServiceIds);
  } catch {
    return [];
  }
}

function writeLastRunningServices(app: App, serviceIds: ServiceId[]) {
  const filePath = getLastRunningServicesStatePath(app);
  const state: LastRunningServicesState = {
    runningServiceIds: orderServiceIdsForRestore(serviceIds),
    updatedAt: new Date().toISOString()
  };
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function fixShellScriptPermissions(rootDir: string) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.name.endsWith(".sh")) {
        fs.chmodSync(entryPath, 0o755);
      }
    }
  }
}

function patchShellProgramCommonForLayeredLayout(programDir: string) {
  const scriptPath = path.join(programDir, "scripts", "program-common.sh");
  if (!fs.existsSync(scriptPath)) {
    return;
  }

  let content = fs.readFileSync(scriptPath, "utf8");
  const original = content;
  content = content
    .replace(/ENV_FILE="\$\{ZENMIND_SERVICE_ENV_FILE:-\$BUNDLE_ROOT\/\.env\}"/gu, 'ENV_FILE="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/.env"')
    .replace(/ENV_FILE="\$BUNDLE_ROOT\/\.env"/gu, 'ENV_FILE="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/.env"')
    .replace(/CONFIG_DIR="\$\{ZENMIND_SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs"/gu, 'CONFIG_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs"')
    .replace(/CONFIG_DIR="\$BUNDLE_ROOT\/configs"/gu, 'CONFIG_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs"')
    .replace(/CONFIG_ENV_DIR="\$\{ZENMIND_SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs\/environments"/gu, 'CONFIG_ENV_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs/environments"')
    .replace(/CONFIG_ENV_DIR="\$BUNDLE_ROOT\/configs\/environments"/gu, 'CONFIG_ENV_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs/environments"')
    .replace(/DATA_DIR="\$\{ZENMIND_SERVICE_DATA_DIR:-\$BUNDLE_ROOT\/data\}"/gu, 'DATA_DIR="${SERVICE_DATA_DIR:-$BUNDLE_ROOT/data}"')
    .replace(/DATA_DIR="\$BUNDLE_ROOT\/data"/gu, 'DATA_DIR="${SERVICE_DATA_DIR:-$BUNDLE_ROOT/data}"')
    .replace(/RUN_DIR="\$\{ZENMIND_SERVICE_STATE_DIR:-\$BUNDLE_ROOT\/run\}"/gu, 'RUN_DIR="${SERVICE_STATE_DIR:-$BUNDLE_ROOT/run}"')
    .replace(/RUN_DIR="\$BUNDLE_ROOT\/run"/gu, 'RUN_DIR="${SERVICE_STATE_DIR:-$BUNDLE_ROOT/run}"')
    .replace(/LOG_FILE="\$\{ZENMIND_SERVICE_LOG_DIR:-\$RUN_DIR\}\//gu, 'LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/LOG_FILE="\$RUN_DIR\//gu, 'LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/ERROR_LOG_FILE="\$\{ZENMIND_SERVICE_LOG_DIR:-\$RUN_DIR\}\//gu, 'ERROR_LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/ERROR_LOG_FILE="\$RUN_DIR\//gu, 'ERROR_LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/nohup "\$BACKEND_BIN" >>"\$LOG_FILE" 2>&1 &/gu, 'nohup "$BACKEND_BIN" </dev/null >>"$LOG_FILE" 2>&1 &')
    .replace(/nohup "\$NODE_CMD" "\$BACKEND_ENTRY" >>"\$LOG_FILE" 2>&1 &/gu, 'nohup "$NODE_CMD" "$BACKEND_ENTRY" </dev/null >>"$LOG_FILE" 2>&1 &')
    .replace(
      /cp -R -n "\$source_env_dir"\/\. "\$CONFIG_ENV_DIR"\/\n/gu,
      [
        'local entry',
        '    for entry in "$source_env_dir"/*; do',
        '      [[ -e "$entry" ]] || continue',
        '      local target="$CONFIG_ENV_DIR/$(basename "$entry")"',
        '      if [[ ! -e "$target" ]]; then',
        '        cp -R "$entry" "$target"',
        '      fi',
        '    done',
        ''
      ].join("\n")
    );

  if (content !== original) {
    fs.writeFileSync(scriptPath, content, "utf8");
  }
}

function patchPowerShellProgramCommonForLayeredLayout(programDir: string) {
  const scriptPath = path.join(programDir, "scripts", "program-common.ps1");
  if (!fs.existsSync(scriptPath)) {
    return;
  }

  let content = fs.readFileSync(scriptPath, "utf8");
  const original = content;
  content = content
    .replace(/\$Script:EnvFile\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_ENV_FILE\)\s*\{\s*\$env:ZENMIND_SERVICE_ENV_FILE\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+["']\.env["']\s*\}/gu, '$Script:EnvFile = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) ".env"')
    .replace(/\$Script:EnvFile\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]\.env['"]/gu, '$Script:EnvFile = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) ".env"')
    .replace(/\$Script:ConfigDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]configs['"]/gu, '$Script:ConfigDir = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) "configs"')
    .replace(/\$Script:ConfigEnvDir\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:BundleRoot\s+['"]configs['"]\)\s+['"]environments['"]/gu, '$Script:ConfigEnvDir = Join-Path (Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) "configs") "environments"')
    .replace(/\$Script:DataDir\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_DATA_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_DATA_DIR\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+['"]data['"]\s*\}/gu, '$Script:DataDir = if ($env:SERVICE_DATA_DIR) { $env:SERVICE_DATA_DIR } else { Join-Path $Script:BundleRoot "data" }')
    .replace(/\$Script:DataDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]data['"]/gu, '$Script:DataDir = if ($env:SERVICE_DATA_DIR) { $env:SERVICE_DATA_DIR } else { Join-Path $Script:BundleRoot "data" }')
    .replace(/\$Script:RunDir\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_STATE_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_STATE_DIR\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+['"]run['"]\s*\}/gu, '$Script:RunDir = if ($env:SERVICE_STATE_DIR) { $env:SERVICE_STATE_DIR } else { Join-Path $Script:BundleRoot "run" }')
    .replace(/\$Script:RunDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]run['"]/gu, '$Script:RunDir = if ($env:SERVICE_STATE_DIR) { $env:SERVICE_STATE_DIR } else { Join-Path $Script:BundleRoot "run" }')
    .replace(/\$Script:LogFile\s*=\s*Join-Path\s+\$\(if\s*\(\$env:ZENMIND_SERVICE_LOG_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_LOG_DIR\s*\}\s*else\s*\{\s*\$Script:RunDir\s*\}\)\s+([^;\r\n]+)/gu, '$Script:LogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:LogFile\s*=\s*Join-Path\s+\$Script:RunDir\s+([^;\r\n]+)/gu, '$Script:LogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:ErrorLogFile\s*=\s*Join-Path\s+\$\(if\s*\(\$env:ZENMIND_SERVICE_LOG_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_LOG_DIR\s*\}\s*else\s*\{\s*\$Script:RunDir\s*\}\)\s+([^;\r\n]+)/gu, '$Script:ErrorLogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:ErrorLogFile\s*=\s*Join-Path\s+\$Script:RunDir\s+([^;\r\n]+)/gu, '$Script:ErrorLogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1');

  if (content !== original) {
    fs.writeFileSync(scriptPath, content, "utf8");
  }
}

function patchAgentPlatformRuntimeNames(programDir: string) {
  const shellPath = path.join(programDir, "scripts", "program-common.sh");
  if (fs.existsSync(shellPath)) {
    let content = fs.readFileSync(shellPath, "utf8");
    const original = content;
    content = content
      .replace(/LOG_FILE="\$LOG_DIR\/\$APP_NAME\.log"/gu, 'LOG_FILE="$LOG_DIR/agent-platform.log"')
      .replace(/PID_FILE="\$RUN_DIR\/\$APP_NAME\.pid"/gu, 'PID_FILE="$RUN_DIR/agent-platform.pid"');
    if (!content.includes('mkdir -p "$(dirname "$PID_FILE")"')) {
      content = content.replace(
        /program_clear_stale_pid_file "\$PID_FILE" "\$APP_NAME"/gu,
        'mkdir -p "$(dirname "$PID_FILE")"\n  program_clear_stale_pid_file "$PID_FILE" "$APP_NAME"'
      );
    }
    if (content !== original) {
      fs.writeFileSync(shellPath, content, "utf8");
    }
  }

  const powerShellPath = path.join(programDir, "scripts", "program-common.ps1");
  if (fs.existsSync(powerShellPath)) {
    let content = fs.readFileSync(powerShellPath, "utf8");
    const original = content;
    content = content
      .replace(
        /\$Script:LogFile\s*=\s*Join-Path\s+\$Script:LogDir\s+["']\$Script:AppName\.log["']/gu,
        '$Script:LogFile = Join-Path $Script:LogDir "agent-platform.log"'
      )
      .replace(
        /\$Script:PidFile\s*=\s*Join-Path\s+\$Script:RunDir\s+["']\$Script:AppName\.pid["']/gu,
        '$Script:PidFile = Join-Path $Script:RunDir "agent-platform.pid"'
      );
    if (!content.includes('Split-Path -Parent $Script:PidFile')) {
      content = content.replace(
        /Clear-StalePidFile\s+-PidFile\s+\$Script:PidFile\s+-ProcessName\s+\$Script:AppName/gu,
        'New-Item -ItemType Directory -Path (Split-Path -Parent $Script:PidFile) -Force | Out-Null\r\n  Clear-StalePidFile -PidFile $Script:PidFile -ProcessName $Script:AppName'
      );
    }
    if (content !== original) {
      fs.writeFileSync(powerShellPath, content, "utf8");
    }
  }

  const manifestPath = path.join(programDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        runtime?: { pidRelativePath?: string; logRelativePath?: string };
      };
      manifest.runtime = {
        ...(manifest.runtime ?? {}),
        pidRelativePath: "run/agent-platform.pid",
        logRelativePath: "run/agent-platform.log"
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch {
      // Leave invalid manifests to the normal health checks.
    }
  }
}

function patchProgramCommonForLayeredLayout(programDir: string) {
  patchShellProgramCommonForLayeredLayout(programDir);
  patchPowerShellProgramCommonForLayeredLayout(programDir);
  const manifestPath = path.join(programDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: string };
    if (manifest.id === "agent-platform") {
      patchAgentPlatformRuntimeNames(programDir);
    }
  } catch {
    // Invalid manifests are reported by the install health checks.
  }
}

function listMissingRuntimeFiles(service: ServiceDefinition, installDir: string) {
  return service.runtime.requiredPaths.filter((relativePath) => !fileExists(path.join(installDir, relativePath)));
}

function isInstallHealthy(service: ServiceDefinition, installDir: string) {
  return listMissingRuntimeFiles(service, installDir).length === 0;
}

function listTarEntries(archivePath: string) {
  return listArchiveEntries(archivePath);
}

function listMissingBundleEntries(service: ServiceDefinition, archivePath: string) {
  const stat = fs.statSync(archivePath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = bundleValidationCache.get(archivePath);
  if (cached && cached.key === cacheKey) {
    return cached.missingEntries;
  }

  const entries = listTarEntries(archivePath);
  const missingEntries = service.runtime.requiredPaths.filter((relativePath) => {
    const expectedPath = `${service.desktop.bundleTopLevelDir}/${relativePath}`;
    if (entries.has(expectedPath) || entries.has(`${expectedPath}/`)) {
      return false;
    }
    const backslashPath = expectedPath.replace(/\//g, "\\");
    if (entries.has(backslashPath) || entries.has(`${backslashPath}\\`)) {
      return false;
    }
    const prefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    const backslashPrefix = backslashPath.endsWith("\\") ? backslashPath : `${backslashPath}\\`;
    return ![...entries].some(
      (entry) => entry.startsWith(prefix) || entry.startsWith(backslashPrefix)
    );
  });
  bundleValidationCache.set(archivePath, {
    key: cacheKey,
    missingEntries
  });
  return missingEntries;
}

function ensureArchiveHealthy(service: ServiceDefinition, archivePath: string, sourceLabel: string) {
  if (!fileExists(archivePath)) {
    throw new Error(`${sourceLabel}缺失：${archivePath}`);
  }

  const missingEntries = listMissingBundleEntries(service, archivePath);
  if (missingEntries.length > 0) {
    throw new Error(`${sourceLabel}不完整，缺少：${missingEntries.join(", ")}`);
  }

  return archivePath;
}

function ensureBundleAssetHealthy(app: App, service: ServiceDefinition) {
  return ensureArchiveHealthy(service, getAssetPath(app, service), "桌面端内置资源");
}

function getOptionalBundleAssetPath(app: App, service: ServiceDefinition) {
  try {
    return ensureBundleAssetHealthy(app, service);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[service-manager] builtin asset unavailable for ${service.id}; using installed service when possible: ${message}`
    );
    return null;
  }
}

function formatEnvValue(value: string) {
  if (value === "") {
    return "";
  }
  // 只在含换行时加引号（多行值无法不带引号）。其它一律原样写：
  // - 反斜杠路径不会被转义成 `\\`（PowerShell naive 加载器读不懂转义）
  // - 含空格或特殊字符也直接写（PS 整行 IndexOf('=') 解析能正确分割）
  if (/[\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, '\\"')}"`;
  }
  return value;
}

function upsertEnvFileContent(
  content: string,
  updates: Map<string, string>,
  options: { uncommentExisting?: boolean } = {}
) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const pending = new Map(updates);
  const applied = new Set<string>();
  const nextLines = lines.flatMap((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      return [line];
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (options.uncommentExisting && trimmed.startsWith("#")) {
        const uncommented = trimmed.slice(1).trimStart();
        const uncommentedSeparatorIndex = uncommented.indexOf("=");
        if (uncommentedSeparatorIndex > 0) {
          const key = uncommented.slice(0, uncommentedSeparatorIndex).trim();
          if (!applied.has(key) && pending.has(key)) {
            const value = pending.get(key) ?? "";
            pending.delete(key);
            applied.add(key);
            return [`${key}=${formatEnvValue(value)}`];
          }
        }
      }
      return [line];
    }

    const key = line.slice(0, separatorIndex).trim();
    if (applied.has(key)) {
      return [];
    }
    if (!pending.has(key)) {
      return [line];
    }

    const value = pending.get(key) ?? "";
    pending.delete(key);
    applied.add(key);
    return [`${key}=${formatEnvValue(value)}`];
  });

  if (pending.size > 0 && nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== "") {
    nextLines.push("");
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${nextLines.join("\n")}\n`;
}

function writeEnvFileUpdates(
  filePath: string,
  updates: Map<string, string>,
  options: { uncommentExisting?: boolean } = {}
) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, upsertEnvFileContent(current, updates, options), "utf8");
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
const PROCESS_EXEC_PATH_PLACEHOLDER = "{{processExecPath}}";
const AGENT_WEBCLIENT_PLATFORM_URL_KEYS = ["BASE_URL"] as const;
const AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS = new Set(["WS_BASE_URL", "VOICE_BASE_URL"]);
const AGENT_WEBCLIENT_DESKTOP_ENV_UPDATES = new Map([["DESKTOP_APP", "true"]]);
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

function parseProcessTreeRowsFromPs(stdout: string): ProcessTreeRow[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidText, ppidText] = line.split(/\s+/u);
      const pid = Number.parseInt(pidText ?? "", 10);
      const ppid = Number.parseInt(ppidText ?? "", 10);
      return { pid, ppid };
    })
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0 && Number.isFinite(row.ppid) && row.ppid >= 0);
}

function parseProcessTreeRowsFromWindowsPowerShell(stdout: string): ProcessTreeRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const pid = typeof item.ProcessId === "number" ? item.ProcessId : Number.parseInt(String(item.ProcessId ?? ""), 10);
        const ppid =
          typeof item.ParentProcessId === "number"
            ? item.ParentProcessId
            : Number.parseInt(String(item.ParentProcessId ?? ""), 10);
        return { pid, ppid };
      })
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0 && Number.isFinite(row.ppid) && row.ppid >= 0);
  } catch {
    return [];
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

function buildProcessTreePids(rootPid: number, rows: ProcessTreeRow[]) {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const visited = new Set<number>();
  const ordered: number[] = [];
  const visit = (pid: number) => {
    if (visited.has(pid)) {
      return;
    }
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
    ordered.push(pid);
  };

  visit(rootPid);
  return ordered;
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

function readManagedPidFile(pidFilePaths: string[]) {
  for (const pidFilePath of pidFilePaths) {
    const pid = readPid(pidFilePath);
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

const IS_WINDOWS = process.platform === "win32";

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellArray(values: string[]) {
  if (values.length === 0) {
    return "@()";
  }
  return `@(${values.map((value) => quotePowerShell(value)).join(", ")})`;
}

function decodeBase64Utf8(content: string) {
  const trimmed = content.trim();
  return trimmed ? Buffer.from(trimmed, "base64").toString("utf8") : "";
}

function coerceExecText(value: string | Buffer) {
  return typeof value === "string" ? value : value.toString("utf8");
}

function normalizeCapturedText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function decodePowerShellCapturePayload(value: string | Buffer): PowerShellCapturePayload | null {
  const content = coerceExecText(value).trim();
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Utf8(content)) as Record<string, unknown>;
    return {
      stdout: normalizeCapturedText(parsed.stdout),
      stderr: normalizeCapturedText(parsed.stderr),
      hadError: parsed.hadError === true,
      exitCode: typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : 0
    };
  } catch {
    return null;
  }
}

function buildPowerShellWrapperScript(scriptPath: string, args: string[]) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$scriptPath = ${quotePowerShell(scriptPath)}
$scriptArgs = ${encodePowerShellArray(args)}
$stdout = [System.Collections.Generic.List[string]]::new()
$stderr = [System.Collections.Generic.List[string]]::new()
$hadError = $false
$nativeExitCode = 0
function Add-CapturedText([System.Collections.Generic.List[string]]$Lines, [object]$Value) {
  if ($null -eq $Value) {
    return
  }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return
  }
  $Lines.Add($text.TrimEnd([char]13, [char]10))
}
try {
  $output = & $scriptPath @scriptArgs 2>&1
  foreach ($item in @($output)) {
    if ($item -is [System.Management.Automation.ErrorRecord]) {
      $hadError = $true
      Add-CapturedText $stderr ($item | Out-String)
    } elseif ($item -is [System.Management.Automation.InformationRecord]) {
      Add-CapturedText $stdout $item.MessageData
    } else {
      Add-CapturedText $stdout $item
    }
  }
  if (-not $?) {
    $hadError = $true
  }
  if ($LASTEXITCODE) {
    $nativeExitCode = $LASTEXITCODE
  }
} catch {
  $hadError = $true
  Add-CapturedText $stderr ($_ | Out-String)
}
$payload = @{
  stdout = ($stdout -join [Environment]::NewLine)
  stderr = ($stderr -join [Environment]::NewLine)
  hadError = $hadError
  exitCode = $nativeExitCode
} | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload)
[Console]::Out.Write([System.Convert]::ToBase64String($bytes))
if ($hadError -or $nativeExitCode -ne 0) {
  exit 1
}
`;
}

function formatExecErrorMessage(errorMessage: string, result: ExecResult) {
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return details || errorMessage;
}

type RunExecFileOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

function getCommandTimeoutMs(timeoutMs: number | undefined) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : SERVICE_COMMAND_TIMEOUT_MS;
}

function buildServiceCommandEnv(overrides?: NodeJS.ProcessEnv) {
  return {
    ...buildServiceEnv(),
    ...(overrides ?? {})
  };
}

function runPowerShellScript(scriptPath: string, args: string[], cwd: string, options: RunExecFileOptions = {}) {
  const wrapperScriptPath = path.join(
    os.tmpdir(),
    `zenmind-powershell-wrapper-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );
  fs.writeFileSync(wrapperScriptPath, buildPowerShellWrapperScript(scriptPath, args), "utf8");
  const timeoutMs = getCommandTimeoutMs(options.timeoutMs);
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(windowsPowerShellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperScriptPath], {
      cwd,
      env: buildServiceCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(killTimer);
      try {
        fs.rmSync(wrapperScriptPath, { force: true });
      } catch {
        // Ignore wrapper cleanup failures and surface the script result instead.
      }
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const killTimer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (err) => {
      settle(() => reject(err));
    });
    child.once("exit", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const decoded = decodePowerShellCapturePayload(stdout);
      const result = decoded ?? {
        stdout: "",
        stderr: [coerceExecText(stderr).trim(), coerceExecText(stdout).trim()].filter(Boolean).join("\n")
      };

      settle(() => {
        if (didTimeout) {
          reject(new Error(formatExecErrorMessage(`PowerShell command timed out after ${timeoutMs}ms`, result)));
          return;
        }

        if (code !== 0) {
          const status = signal ? `signal ${signal}` : `code ${code ?? -1}`;
          reject(new Error(formatExecErrorMessage(`PowerShell command exited with ${status}`, result)));
          return;
        }

        resolve({
          stdout: result.stdout,
          stderr: result.stderr
        });
      });
    });
  });
}

function resolveExecCommand(command: string, args: string[], cwd: string) {
  if (IS_WINDOWS && command.toLowerCase().endsWith(".ps1")) {
    const scriptPath = path.isAbsolute(command) ? command : path.join(cwd, command);
    return {
      command: scriptPath,
      args,
      powershellScript: true
    };
  }
  return { command, args, powershellScript: false };
}

function runExecFile(command: string, args: string[], cwd: string, options: RunExecFileOptions = {}) {
  const resolved = resolveExecCommand(command, args, cwd);
  const timeoutMs = getCommandTimeoutMs(options.timeoutMs);
  if (resolved.powershellScript) {
    return runPowerShellScript(resolved.command, resolved.args, cwd, { timeoutMs, env: options.env });
  }

  return new Promise<ExecResult>((resolve, reject) => {
    if (!fs.existsSync(cwd)) {
      reject(new Error(`工作目录不存在：${cwd}`));
      return;
    }

    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: buildServiceCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;

    const killTimer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (didTimeout) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${resolved.command} ${resolved.args.join(" ")}\n${stderr || stdout}`.trim()));
        return;
      }
      if (code !== 0) {
        const status = signal ? `signal ${signal}` : `code ${code ?? -1}`;
        reject(new Error(`Command failed: ${resolved.command} ${resolved.args.join(" ")} exited with ${status}\n${stderr || stdout}`.trim()));
        return;
      }
      resolve({
        stdout,
        stderr
      });
    });
  });
}

let containerEngineDiagOnce = false;

type ContainerEngineProbe = {
  engine: string;
  command: string;
  installed: boolean;
  reachable: boolean;
  message: string;
};

function getContainerEngineExecutableNames(name: string) {
  if (!IS_WINDOWS) {
    return [name];
  }
  return name.toLowerCase().endsWith(".exe") ? [name] : [`${name}.exe`, name];
}

function findCommandInServicePath(name: string, env: NodeJS.ProcessEnv) {
  for (const dirPath of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const executableName of getContainerEngineExecutableNames(name)) {
      const candidate = path.join(dirPath, executableName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore unreadable PATH entries and continue probing.
      }
    }
  }
  return "";
}

function resolveContainerEngineCommand(name: string, env: NodeJS.ProcessEnv, diagOnce: boolean) {
  const opts = { encoding: "utf8" as const, env };
  const r = IS_WINDOWS
    ? spawnSync("where.exe", [name], opts)
    : spawnSync("sh", ["-lc", `command -v ${name}`], opts);
  const located = r.status === 0 && !r.error
    ? r.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean) ?? ""
    : "";
  const fallback = located ? "" : findCommandInServicePath(name, env);
  if (diagOnce) {
    console.log(`[container-engine] ${IS_WINDOWS ? "where.exe" : "command -v"} ${name} -> status=${r.status} stdout=${located} fallback=${fallback}`);
  }
  return located || fallback;
}

function probeContainerEngines() {
  const timing = beginStartupTiming("containerEngineAvailable", {}, { log: false });
  const env = buildServiceEnv();
  const diagOnce = !containerEngineDiagOnce;
  containerEngineDiagOnce = true;
  if (diagOnce) {
    const pathPreview = (env.PATH ?? "").split(path.delimiter).slice(0, 8).join(" | ");
    console.log(`[container-engine] PATH(top 8): ${pathPreview}`);
  }

  let selectedEngine = "";
  const probes: ContainerEngineProbe[] = [];
  try {
    const reachable = (name: string, command: string) => {
      const start = Date.now();
      const r = spawnSync(command, ["info"], {
        encoding: "utf8",
        env,
        timeout: 15000,
        stdio: "pipe"
      });
      const ms = Date.now() - start;
      const message = String(r.stderr || r.stdout || r.error?.message || "").trim();
      if (diagOnce) {
        console.log(`[container-engine] ${name} info -> command=${command} status=${r.status} signal=${r.signal} elapsed=${ms}ms error=${r.error?.message ?? ""} detail=${message.split(/\r?\n/u)[0] ?? ""}`);
      }
      return {
        ok: r.status === 0,
        message
      };
    };

    for (const engine of ["docker", "podman"]) {
      const command = resolveContainerEngineCommand(engine, env, diagOnce);
      if (!command) {
        probes.push({
          engine,
          command: "",
          installed: false,
          reachable: false,
          message: ""
        });
        continue;
      }
      const result = reachable(engine, command);
      probes.push({
        engine,
        command,
        installed: true,
        reachable: result.ok,
        message: result.message
      });
      if (result.ok) {
        selectedEngine = engine;
        return { engine, probes };
      }
    }

    return { engine: "", probes };

    const exists = (name: string) => {
      const opts = { encoding: "utf8" as const, env };
      const r = IS_WINDOWS
        ? spawnSync("where.exe", [name], opts)
        : spawnSync("sh", ["-lc", `command -v ${name}`], opts);
      if (diagOnce) {
        console.log(`[container-engine] ${IS_WINDOWS ? "where.exe" : "command -v"} ${name} → status=${r.status} stdout=${r.stdout?.trim()?.split(/\r?\n/u)[0] ?? ""}`);
      }
      return r.status === 0;
    };

    const reachableLegacy = (name: string) => {
      const start = Date.now();
      const r = spawnSync(name, ["info"], {
        encoding: "utf8",
        env,
        timeout: 15000,
        stdio: "ignore"
      });
      const ms = Date.now() - start;
      if (diagOnce) {
        console.log(`[container-engine] ${name} info → status=${r.status} signal=${r.signal} elapsed=${ms}ms error=${r.error?.message ?? ""}`);
      }
      return r.status === 0;
    };

    for (const engine of ["docker", "podman"]) {
      if (exists(engine) && reachableLegacy(engine)) {
        selectedEngine = engine;
        return { engine, probes };
      }
    }

    return { engine: "", probes };
  } finally {
    timing.end({ engine: selectedEngine || "none" });
  }
}

function containerEngineAvailable() {
  return probeContainerEngines().engine;
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
    if (service.id === "agent-platform" && configFile.relativePath === "configs/channels.yml") {
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, "", "utf8");
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
      : { content: "", backupContent: "" };

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
      extractArchiveToDir(assetPath, tempRoot);
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
        if (preservedEnv.backupContent) {
          writeAgentPlatformLegacyEnvBackupIfNeeded(layout.configDir, preservedEnv.backupContent);
        }
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
  const pidFromFile = installed ? readManagedPidFile(pidFilePaths) : null;
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

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getServiceVerificationDelayMs() {
  const raw = Number.parseInt(process.env.SERVICE_VERIFY_DELAY_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

function normalizeProbeUrl(baseURL: string, pathname?: string) {
  const parsed = new URL(baseURL);
  if (pathname) {
    parsed.pathname = pathname;
    parsed.search = "";
    parsed.hash = "";
  }
  return parsed.toString();
}

type HttpProbeResult = {
  target: string;
  ok: boolean;
  statusCode?: number;
  contentType?: string;
  message?: string;
  bodyPreview?: string;
};

function probeHttpUrl(target: string, timeoutMs = 1200): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      resolve({ target, ok: false, message: "URL 无效" });
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, {
      method: "GET",
      timeout: timeoutMs
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (Buffer.concat(chunks).byteLength < 4096) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "");
        const bodyPreview = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
        resolve({
          target,
          ok: statusCode >= 200 && statusCode < 400,
          statusCode,
          contentType,
          bodyPreview,
          message: statusCode >= 200 && statusCode < 400 ? undefined : `HTTP ${statusCode || "无响应"}`
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("HTTP probe timeout"));
    });
    request.on("error", (error) => {
      resolve({
        target,
        ok: false,
        message: error.message
      });
    });
    request.end();
  });
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
    const first = await collectServiceVerification(app, serviceId, desired);
    if (first.verification.verified && delayMs <= 0) {
      verified = true;
      return first.verification;
    }

    await delay(delayMs > 0 ? delayMs : 1500);
    const second = await collectServiceVerification(app, serviceId, desired);
    verified = second.verification.verified;
    return second.verification;
  } finally {
    timing.end({ verified });
  }
}

function serviceVerificationFailureMessage(actionMessage: string, verification: ServiceVerification) {
  const issues = verification.issues.length > 0 ? verification.issues.join("；") : `状态为 ${verification.actualStatus}`;
  return `${actionMessage}，但复查失败：${issues}`;
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

const DEFAULT_LOCAL_CLI_ACP_RELAY_PORT = "3220";
const LOCAL_CLI_ACP_RELAY_PLUGIN_ID = "local-cli-acp-relay";
const DEFAULT_CLAUDE_CODE_ACP_ARGS = "-y @zed-industries/claude-code-acp";
const DEFAULT_LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS = "60000";
const DEFAULT_LOCAL_CLI_ACP_RUN_TIMEOUT_MS = "600000";
const DEFAULT_PROVIDER_APIKEY_KEY_PART = "0.1.0";
const AGENT_BASH_SHELL_EXECUTABLE_KEY = "AGENT_BASH_SHELL_EXECUTABLE";
const AGENT_BASH_SHELL_ARGS_KEY = "AGENT_BASH_SHELL_ARGS";
const WINDOWS_AGENT_BASH_SHELL_EXECUTABLE = "powershell.exe";
const WINDOWS_AGENT_BASH_SHELL_ARGS = "-NoProfile,-ExecutionPolicy,Bypass,-Command,{{command}}";
const AGENT_PLATFORM_LEGACY_ENV_BACKUP_FILE = ".env.legacy-backup";
const AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS = [
  "LOCAL_CLI_ACP_RELAY_ENABLED",
  "LOCAL_CLI_ACP_RELAY_USER_ENABLED",
  "LOCAL_CLI_ACP_RELAY_PORT",
  "LOCAL_CLI_ACP_RELAY_AUTH_TOKEN",
  "LOCAL_CLI_ACP_DEFAULT_CWD",
  "LOCAL_CLI_ACP_ALLOWED_CWD_ROOTS",
  "LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS",
  "LOCAL_CLI_ACP_RUN_TIMEOUT_MS",
  "CLAUDE_CODE_ACP_COMMAND",
  "CLAUDE_CODE_ACP_ARGS"
] as const;
const AGENT_PLATFORM_DESKTOP_REMOVED_ENV_KEYS = [
  "AGENT_WS_ENABLED"
] as const;
const AGENT_PLATFORM_DEPRECATED_BASH_CONFIG_KEYS = [
  "allowed-paths",
  "path-checked-commands",
  "path-check-bypass-commands"
] as const;
const AGENT_PLATFORM_DEPRECATED_FILE_TOOLS_CONFIG_KEYS = [
  "allowed-read-paths",
  "allowed-write-paths"
] as const;
const AGENT_PLATFORM_DEPRECATED_ENV_KEYS = [
  "GATEWAY_USER_ID",
  "GATEWAY_TICKET",
  "GATEWAY_AGENT_KEY",
  "GATEWAY_CHANNEL",
  "GATEWAY_UPLOAD_PATH",
  "GATEWAY_DOWNLOAD_PATH",
  "GATEWAY_AUTH_TOKEN",
  "GATEWAY_WS_URL",
  "AGENT_GATEWAY_WS_URL",
  "GATEWAY_JWT_TOKEN",
  "GATEWAY_BASE_URL",
  "AGENT_GATEWAY_WS_TOKEN",
  "AGENT_GATEWAY_WS_HANDSHAKE_TIMEOUT_MS",
  "AGENT_GATEWAY_WS_RECONNECT_MIN_MS",
  "AGENT_GATEWAY_WS_RECONNECT_MAX_MS",
  "AGENT_AUTH_ENABLED",
  "AGENT_AUTH_JWKS_URI",
  "AGENT_AUTH_ISSUER",
  "AGENT_AUTH_JWKS_CACHE_SECONDS",
  "AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE",
  "AGENT_CONTAINER_HUB_ENABLED",
  "AGENT_CONTAINER_HUB_BASE_URL",
  "AGENT_CONTAINER_HUB_AUTH_TOKEN",
  "AGENT_CONTAINER_HUB_DEFAULT_ENVIRONMENT_ID",
  "AGENT_CONTAINER_HUB_REQUEST_TIMEOUT_MS",
  "AGENT_CONTAINER_HUB_DEFAULT_SANDBOX_LEVEL",
  "AGENT_CONTAINER_HUB_AGENT_IDLE_TIMEOUT_MS",
  "AGENT_CONTAINER_HUB_DESTROY_QUEUE_DELAY_MS",
  "AGENT_STREAM_INCLUDE_TOOL_PAYLOAD_EVENTS",
  "AGENT_STREAM_INCLUDE_DEBUG_EVENTS",
  "AGENT_CONFIG_DIR",
  "AGENT_AGENTS_EXTERNAL_DIR",
  "AGENT_TEAMS_EXTERNAL_DIR",
  "AGENT_MODELS_EXTERNAL_DIR",
  "AGENT_PROVIDERS_EXTERNAL_DIR",
  "AGENT_TOOLS_EXTERNAL_DIR",
  "AGENT_SKILLS_EXTERNAL_DIR",
  "AGENT_VIEWPORTS_EXTERNAL_DIR",
  "AGENT_MCP_SERVERS_REGISTRY_EXTERNAL_DIR",
  "AGENT_VIEWPORT_SERVERS_REGISTRY_EXTERNAL_DIR",
  "AGENT_SCHEDULE_EXTERNAL_DIR",
  "AGENT_DATA_EXTERNAL_DIR",
  "AGENT_MEMORY_STORAGE_DIR",
  "CHAT_IMAGE_TOKEN_SECRET",
  "CHAT_IMAGE_TOKEN_TTL_SECONDS",
  "CHAT_RESOURCE_TICKET_ENABLED",
  "MEMORY_CHATS_DIR",
  "MEMORY_CHATS_K",
  "MEMORY_CHATS_CHARSET",
  "MEMORY_CHATS_ACTION_TOOLS",
  "MEMORY_CHATS_INDEX_SQLITE_FILE",
  "MEMORY_CHATS_INDEX_AUTO_REBUILD_ON_INCOMPATIBLE_SCHEMA"
] as const;

const AGENT_PLATFORM_ENV_KEY_RENAMES = new Map<string, string>([
  ["AGENT_AUTH_ENABLED", "AUTH_ENABLED"],
  ["AGENT_AUTH_JWKS_URI", "AUTH_JWKS_URI"],
  ["AGENT_AUTH_ISSUER", "AUTH_ISSUER"],
  ["AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE", "AUTH_LOCAL_PUBLIC_KEY_FILE"],
  ["AGENT_CONTAINER_HUB_BASE_URL", "CONTAINER_HUB_BASE_URL"],
  ["AGENT_STREAM_INCLUDE_TOOL_PAYLOAD_EVENTS", "STREAM_INCLUDE_TOOL_PAYLOAD_EVENTS"],
  ["AGENT_STREAM_INCLUDE_DEBUG_EVENTS", "STREAM_INCLUDE_DEBUG_EVENTS"],
  ["AGENT_AGENTS_EXTERNAL_DIR", "AGENTS_DIR"],
  ["AGENT_TEAMS_EXTERNAL_DIR", "TEAMS_DIR"],
  ["AGENT_TOOLS_EXTERNAL_DIR", "TOOLS_DIR"],
  ["AGENT_SKILLS_EXTERNAL_DIR", "SKILLS_MARKET_DIR"],
  ["AGENT_SCHEDULE_EXTERNAL_DIR", "SCHEDULES_DIR"]
]);

const AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE = path.join("configs", "local-public-key.pem").replace(/\\/gu, "/");


function agentWebclientInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");
  let backendEntry = "backend/server.cjs";
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        backend?: { entry?: unknown } | null;
        runtime?: { requiredPaths?: unknown } | null;
      };
      if (typeof manifest.backend?.entry === "string" && manifest.backend.entry.trim()) {
        backendEntry = manifest.backend.entry.trim();
      }
      const requiredPaths = Array.isArray(manifest.runtime?.requiredPaths)
        ? manifest.runtime.requiredPaths.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (
        backendEntry === "backend/server.js" ||
        requiredPaths.includes("backend/package.json") ||
        requiredPaths.includes("backend/node_modules")
      ) {
        return true;
      }
    }

    const staleUnixLauncherMarkers = ["BACKEND_PACKAGE_FILE", "BACKEND_NODE_MODULES_DIR", "backend/package.json", "backend/node_modules"];
    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      const hasInvalidAbsoluteBackendEntry = /BACKEND_ENTRY=["']\/backend\/server\.cjs["']/u.test(programCommon);
      if (hasInvalidAbsoluteBackendEntry || staleUnixLauncherMarkers.some((marker) => programCommon.includes(marker))) {
        return true;
      }
    }

    const staleWindowsLauncherMarkers = ["BackendPackageFile", "BackendModulesDir", "backend\\package.json", "backend\\node_modules"];
    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      const hasInvalidAbsoluteBackendEntry = /\$Script:BackendEntry\s*=\s*["']\\?backend\\server\.cjs["']/u.test(programCommon);
      if (hasInvalidAbsoluteBackendEntry || staleWindowsLauncherMarkers.some((marker) => programCommon.includes(marker))) {
        return true;
      }
    }
  } catch {
    return true;
  }

  const serverPath = fs.existsSync(path.join(installDir, backendEntry))
    ? path.join(installDir, backendEntry)
    : path.join(installDir, "backend", "server.js");
  if (!fs.existsSync(serverPath)) {
    return false;
  }

  try {
    const serverContent = fs.readFileSync(serverPath, "utf8");
    return (
      serverContent.includes("(secure ? https : http).request") ||
      serverContent.includes("function buildUpgradeRequest(") ||
      !serverContent.includes("function createWebSocketProxy(") ||
      !serverContent.includes("proxy.upgrade(req, socket, head)") ||
      !serverContent.includes("server.on('upgrade'")
    );
  } catch {
    return true;
  }
}

function zenmindAppServerInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const indexPath = path.join(installDir, "frontend", "dist", "index.html");
  const envExamplePath = path.join(installDir, ".env.example");
  const envPath = path.join(installDir, ".env");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");

  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        frontend?: { entry?: unknown } | null;
        web?: { routePath?: unknown } | null;
      };
      if (manifest.frontend?.entry !== "/admin/" || manifest.web?.routePath !== "/admin/") {
        return true;
      }
    }

    if (fs.existsSync(envExamplePath)) {
      const envExample = fs.readFileSync(envExamplePath, "utf8");
      if (!envExample.includes("FRONTEND_DIST_DIR=./frontend/dist")) {
        return true;
      }
    }

    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      if (!/(^|\n)FRONTEND_DIST_DIR=.+(\n|$)/u.test(envContent)) {
        return true;
      }
    }

    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      if (
        !programCommon.includes('FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"') ||
        !programCommon.includes('nohup "$BACKEND_BIN"')
      ) {
        return true;
      }
    }

    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      if (
        !programCommon.includes("Resolve-ProgramFrontendDistDir") ||
        !programCommon.includes("$env:FRONTEND_DIST_DIR")
      ) {
        return true;
      }
    }

    if (!fs.existsSync(indexPath)) {
      return false;
    }

    const indexContent = fs.readFileSync(indexPath, "utf8");
    return !indexContent.includes("/admin/assets/");
  } catch {
    return true;
  }
}

function agentPlatformInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const desktopExamplePath = path.join(installDir, "configs", "desktop.example.yml");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");

  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        configFiles?: Array<{ key?: unknown; relativePath?: unknown; templateRelativePath?: unknown }> | null;
        runtime?: { pidRelativePath?: unknown; logRelativePath?: unknown } | null;
      };
      if (
        manifest.runtime?.pidRelativePath !== "run/agent-platform.pid" ||
        manifest.runtime?.logRelativePath !== "run/agent-platform.log"
      ) {
        return true;
      }
      const hasDesktopBridgeConfig = Array.isArray(manifest.configFiles) &&
        manifest.configFiles.some((entry) =>
          entry?.key === "desktop" &&
          entry.relativePath === "configs/desktop.yml" &&
          entry.templateRelativePath === "configs/desktop.example.yml"
        );
      if (!hasDesktopBridgeConfig) {
        return true;
      }
    }

    if (!fs.existsSync(desktopExamplePath)) {
      return true;
    }
    const desktopExample = fs.readFileSync(desktopExamplePath, "utf8");
    if (
      !/path:\s*\/actions\/call/u.test(desktopExample) ||
      !/path:\s*\/cdp\/call/u.test(desktopExample)
    ) {
      return true;
    }

    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      const declaresPidFile = /(^|\n)\s*PID_FILE=/u.test(programCommon);
      const hasDesktopPidFile =
        programCommon.includes('PID_FILE="$RUN_DIR/agent-platform.pid"') ||
        programCommon.includes('PID_FILE="$RUN_DIR/pid/agent-platform.pid"');
      if (
        programCommon.includes('PID_FILE="$RUN_DIR/$APP_NAME.pid"') ||
        programCommon.includes('LOG_FILE="$LOG_DIR/$APP_NAME.log"') ||
        (declaresPidFile && !hasDesktopPidFile)
      ) {
        return true;
      }
    }

    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      const declaresPidFile = /(^|\r?\n)\s*\$Script:PidFile\s*=/u.test(programCommon);
      const hasDesktopPidFile =
        /\$Script:PidFile\s*=\s*Join-Path\s+\$Script:RunDir\s+['"]agent-platform\.pid['"]/u.test(programCommon) ||
        /\$Script:PidFile\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:RunDir\s+['"]pid['"]\)\s+['"]agent-platform\.pid['"]/u.test(programCommon);
      if (
        programCommon.includes('$Script:PidFile = Join-Path $Script:RunDir "$Script:AppName.pid"') ||
        programCommon.includes('$Script:LogFile = Join-Path $Script:LogDir "$Script:AppName.log"') ||
        (declaresPidFile && !hasDesktopPidFile)
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

function serviceInstallNeedsRefresh(service: ServiceDefinition, installDir: string) {
  if (service.id === "agent-platform") {
    return agentPlatformInstallNeedsRefresh(installDir);
  }

  if (service.id === "agent-webclient") {
    return agentWebclientInstallNeedsRefresh(installDir);
  }

  if (service.id === "zenmind-app-server") {
    return zenmindAppServerInstallNeedsRefresh(installDir);
  }

  return false;
}

const agentPlatformDesktopRuntimePaths = [
  ["REGISTRIES_DIR", "registries"],
  ["TOOLS_DIR", "tools"],
  ["OWNER_DIR", "owner"],
  ["AGENTS_DIR", "agents"],
  ["TEAMS_DIR", "teams"],
  ["ROOT_DIR", "root"],
  ["SCHEDULES_DIR", "schedules"],
  ["CHATS_DIR", "chats"],
  ["MEMORY_DIR", "memory"],
  ["PAN_DIR", "pan"],
  ["SKILLS_MARKET_DIR", "skills-market"]
] as const;

function resolveHomeDir(app?: App | null) {
  try {
    const homePath = app?.getPath("home")?.trim();
    if (homePath) {
      return homePath;
    }
  } catch {
    // Fall back to the process home directory when Electron does not expose a home path yet.
  }
  return process.env.HOME || os.homedir();
}

function resolveDesktopDir(app?: App | null, homeDir = resolveHomeDir(app)) {
  try {
    const desktopPath = app?.getPath("desktop")?.trim();
    if (desktopPath) {
      return desktopPath;
    }
  } catch {
    // Fall back to the conventional desktop location when Electron cannot resolve it.
  }
  return path.join(homeDir, "Desktop");
}

function expandHomeShortcut(value: string, homeDir = resolveHomeDir()) {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function normalizeConfigPath(value: string, homeDir = resolveHomeDir()) {
  return path.normalize(expandHomeShortcut(value, homeDir)).replace(/\\/gu, "/");
}

function stripNormalizedPathSuffix(value: string, suffix: string) {
  if (value === suffix) {
    return ".";
  }
  if (value.endsWith(`/${suffix}`)) {
    return value.slice(0, -suffix.length - 1) || "/";
  }
  return "";
}

function formatDesktopAgentPlatformRuntimePath(app: App, value: string) {
  if (process.platform === "win32") {
    return value;
  }

  const homeDir = resolveHomeDir(app);
  const normalizedHomeDir = normalizeConfigPath(homeDir, homeDir);
  const normalizedValue = normalizeConfigPath(value, homeDir);
  const normalizedZenmindRoot = `${normalizedHomeDir}/.zenmind`;
  if (normalizedValue === normalizedZenmindRoot) {
    return "~/.zenmind";
  }
  if (normalizedValue.startsWith(`${normalizedZenmindRoot}/`)) {
    return `~/.zenmind/${normalizedValue.slice(normalizedZenmindRoot.length + 1)}`;
  }
  return value;
}

function resolveAgentPlatformInitializationRuntimeRoot(app: App) {
  const homeDir = resolveHomeDir(app);
  if (IS_WINDOWS) {
    return path.join(homeDir, ".zenmind");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, ".zenmind");
  }
  return path.join(homeDir, ".zenmind");
}

function formatDesktopAgentPlatformRuntimeRoot(app: App, runtimeRoot: string) {
  return formatDesktopAgentPlatformRuntimePath(app, runtimeRoot);
}

function countMatchingFiles(rootDir: string, maxDepth: number, predicate: (filePath: string) => boolean, depth = 0): number {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return 0;
  }

  let count = 0;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && predicate(entryPath)) {
      count += 1;
      continue;
    }
    if (entry.isDirectory() && depth < maxDepth) {
      count += countMatchingFiles(entryPath, maxDepth, predicate, depth + 1);
    }
  }
  return count;
}

function getAgentPlatformRuntimeRootScore(runtimeRoot: string) {
  if (!runtimeRoot || !fs.existsSync(runtimeRoot) || !fs.statSync(runtimeRoot).isDirectory()) {
    return -1;
  }

  const agentsDir = path.join(runtimeRoot, "agents");
  const registriesDir = path.join(runtimeRoot, "registries");
  const chatsDir = path.join(runtimeRoot, "chats");
  const teamsDir = path.join(runtimeRoot, "teams");
  const existingTopLevelDirs = ["agents", "registries", "teams", "chats", "skills-market"]
    .filter((dirName) => fs.existsSync(path.join(runtimeRoot, dirName)))
    .length;
  const agentCount = countMatchingFiles(agentsDir, 2, (filePath) => path.basename(filePath) === "agent.yml");
  const registryCount = countMatchingFiles(registriesDir, 2, (filePath) => /\.(json|ya?ml)$/u.test(filePath));
  const chatCount = countMatchingFiles(
    chatsDir,
    2,
    (filePath) => path.basename(filePath) === "chats.db" || filePath.endsWith(".jsonl")
  );
  const teamCount = countMatchingFiles(teamsDir, 1, (filePath) => /\.(json|ya?ml)$/u.test(filePath));

  return existingTopLevelDirs + agentCount * 100 + registryCount * 10 + teamCount * 3 + chatCount * 2;
}

function resolveDesktopRuntimeRoot(app?: App | null) {
  const homeDir = resolveHomeDir(app);
  const desktopDir = resolveDesktopDir(app, homeDir);
  const legacyDesktopDir = path.join(homeDir, "Desktop");
  const candidates = [...new Set([
    path.join(homeDir, ".zenmind"),
    path.join(desktopDir, ".zenmind"),
    path.join(legacyDesktopDir, ".zenmind"),
    path.join(desktopDir, "zenmind-env"),
    path.join(legacyDesktopDir, "zenmind-env"),
    path.join(homeDir, "zenmind")
  ])];
  for (const candidate of candidates) {
    const score = getAgentPlatformRuntimeRootScore(candidate);
    if (score > 0) {
      return candidate;
    }
  }
  return null;
}

function resolvePreferredAgentPlatformRuntimeRoot(app?: App | null) {
  return resolveDesktopRuntimeRoot(app) ?? path.join(resolveHomeDir(app), ".zenmind");
}

function resolveAgentPlatformAgentsDir(env: Map<string, string>, desktopRuntimeRoot: string | null) {
  const configuredAgentsDir = env.get("AGENTS_DIR")?.trim();
  if (configuredAgentsDir) {
    return configuredAgentsDir;
  }
  const configuredRuntimeRoot = env.get("RUNTIME_DIR")?.trim();
  if (configuredRuntimeRoot) {
    return path.join(configuredRuntimeRoot, "agents");
  }
  if (hasConfiguredAgentPlatformRuntimePath(env)) {
    return "";
  }
  if (!desktopRuntimeRoot) {
    return "";
  }
  return path.join(desktopRuntimeRoot, "agents");
}

function hasConfiguredAgentPlatformRuntimePath(env: Map<string, string>) {
  if (env.get("RUNTIME_DIR")?.trim()) {
    return true;
  }
  return agentPlatformDesktopRuntimePaths.some(([key]) => Boolean(env.get(key)?.trim()));
}

function getAgentPlatformRuntimePathKeysResolvingUnderRoot(env: Map<string, string>, runtimeRoot: string) {
  const homeDir = resolveHomeDir();
  const normalizedRuntimeRoot = normalizeConfigPath(runtimeRoot, homeDir);
  const keys: string[] = [];

  for (const [key, relativePath] of agentPlatformDesktopRuntimePaths) {
    const value = env.get(key)?.trim();
    if (!value) {
      continue;
    }
    const normalizedValue = normalizeConfigPath(value, homeDir);
    const normalizedExpected = normalizeConfigPath(path.join(normalizedRuntimeRoot, relativePath), homeDir);
    if (normalizedValue === normalizedExpected) {
      keys.push(key);
    }
  }

  return keys;
}

function inferAgentPlatformRuntimeRootFromChildPaths(env: Map<string, string>) {
  const homeDir = resolveHomeDir();
  const roots = new Set<string>();
  let configuredPathCount = 0;

  for (const [key, relativePath] of agentPlatformDesktopRuntimePaths) {
    const value = env.get(key)?.trim();
    if (!value) {
      continue;
    }
    configuredPathCount += 1;
    const normalizedValue = normalizeConfigPath(value, homeDir);
    const normalizedRelativePath = normalizeConfigPath(relativePath, homeDir);
    const root = stripNormalizedPathSuffix(normalizedValue, normalizedRelativePath);
    if (!root) {
      return "";
    }
    roots.add(root);
  }

  if (configuredPathCount < 2 || roots.size !== 1) {
    return "";
  }

  return [...roots][0] ?? "";
}

function resolveLegacyAgentPlatformRuntimeRootMigration(app: App, env: Map<string, string>) {
  if (env.get("RUNTIME_DIR")?.trim()) {
    return null;
  }

  const configuredRuntimePaths = agentPlatformDesktopRuntimePaths
    .map(([key]) => env.get(key)?.trim() ?? "")
    .filter(Boolean);
  if (configuredRuntimePaths.length === 0) {
    return null;
  }

  const homeDir = resolveHomeDir(app);
  const legacyRuntimeRoot = path.join(homeDir, "zenmind");
  const normalizedLegacyRoot = normalizeConfigPath(legacyRuntimeRoot, homeDir);
  const allPathsStillUseLegacyRoot = configuredRuntimePaths.every((configuredPath) => {
    const normalizedPath = normalizeConfigPath(configuredPath, homeDir);
    return normalizedPath === normalizedLegacyRoot || normalizedPath.startsWith(`${normalizedLegacyRoot}/`);
  });
  if (!allPathsStillUseLegacyRoot) {
    return null;
  }

  const preferredRuntimeRoot = resolveDesktopRuntimeRoot(app);
  if (!preferredRuntimeRoot) {
    return null;
  }

  const normalizedPreferredRoot = normalizeConfigPath(preferredRuntimeRoot, homeDir);
  if (normalizedPreferredRoot === normalizedLegacyRoot) {
    return null;
  }

  const legacyScore = getAgentPlatformRuntimeRootScore(legacyRuntimeRoot);
  const preferredScore = getAgentPlatformRuntimeRootScore(preferredRuntimeRoot);
  if (preferredScore <= legacyScore) {
    return null;
  }

  return preferredRuntimeRoot;
}



function resolveAcpCommandForDesktop(env: Map<string, string>) {
  const currentAcpCommand = env.get("CLAUDE_CODE_ACP_COMMAND") ?? "";
  const currentAcpArgs = env.get("CLAUDE_CODE_ACP_ARGS") ?? "";
  const normalizedAcpCommand = currentAcpCommand.trim().replace(/^['"]|['"]$/gu, "");
  const usesDefaultAcpCommand =
    !currentAcpCommand
    || isCommandBasenameMatch(currentAcpCommand, "npx")
    || normalizedAcpCommand === "claude-code-acp";
  const usesDefaultAcpArgs =
    !currentAcpArgs || currentAcpArgs.trim() === "-y @zed-industries/claude-code-acp";
  const resolvedClaudeCodeAcpBin = resolveCommandBin("claude-code-acp");
  if (resolvedClaudeCodeAcpBin && usesDefaultAcpCommand) {
    return {
      command: resolvedClaudeCodeAcpBin,
      args: usesDefaultAcpArgs ? "\"\"" : currentAcpArgs
    };
  }

  const resolvedNpxBin = resolveCommandBin("npx");
  if (resolvedNpxBin && (!currentAcpCommand || isCommandBasenameMatch(currentAcpCommand, "npx"))) {
    return {
      command: resolvedNpxBin,
      args: usesDefaultAcpArgs ? "-y @zed-industries/claude-code-acp" : currentAcpArgs
    };
  }

  if (usesDefaultAcpCommand) {
    console.warn(
      `[service-manager] Unable to resolve claude-code-acp or npx from Desktop PATH. Existing command="${currentAcpCommand || "(empty)"}"`
    );
  }
  return null;
}

function applyAgentPlatformWindowsHostShellDefaults(
  env: Map<string, string>,
  updates: Map<string, string>,
  isWindows = IS_WINDOWS
) {
  if (!isWindows) {
    return false;
  }
  const hasExplicitShell =
    Boolean(env.get(AGENT_BASH_SHELL_EXECUTABLE_KEY)?.trim()) ||
    Boolean(env.get(AGENT_BASH_SHELL_ARGS_KEY)?.trim()) ||
    updates.has(AGENT_BASH_SHELL_EXECUTABLE_KEY) ||
    updates.has(AGENT_BASH_SHELL_ARGS_KEY);
  if (hasExplicitShell) {
    return false;
  }
  updates.set(AGENT_BASH_SHELL_EXECUTABLE_KEY, WINDOWS_AGENT_BASH_SHELL_EXECUTABLE);
  updates.set(AGENT_BASH_SHELL_ARGS_KEY, WINDOWS_AGENT_BASH_SHELL_ARGS);
  return true;
}
function shellQuoteEnvValue(value: string) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function normalizeShellSourcedAgentPlatformEnvValues(env: Map<string, string>, updates: Map<string, string>) {
  const acpArgs = env.get("CLAUDE_CODE_ACP_ARGS")?.trim() ?? "";
  if (/\s/u.test(acpArgs) && !/^(['"]).*\1$/u.test(acpArgs)) {
    updates.set("CLAUDE_CODE_ACP_ARGS", shellQuoteEnvValue(acpArgs));
  }
}

function normalizeShellSourcedAgentPlatformEnvUpdates(updates: Map<string, string>) {
  const acpArgs = updates.get("CLAUDE_CODE_ACP_ARGS")?.trim() ?? "";
  if (/\s/u.test(acpArgs) && !/^(['"]).*\1$/u.test(acpArgs)) {
    updates.set("CLAUDE_CODE_ACP_ARGS", shellQuoteEnvValue(acpArgs));
  }
}

function isPlaceholderAgentPlatformLegacySecret(value: string) {
  const normalized = value.trim().replace(/^['"]|['"]$/gu, "").toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized.includes("replace-with") ||
    normalized.includes("your-chat-image-token") ||
    normalized === "your-secret" ||
    normalized === "changeme" ||
    normalized === "change-me" ||
    normalized === "todo" ||
    normalized === "secret" ||
    normalized === "..."
  );
}

function parsePositiveIntegerEnvValue(value: string) {
  const normalized = value.trim();
  if (!/^[0-9]+$/u.test(normalized)) {
    return "";
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return "";
  }
  return String(parsed);
}

function migrateAgentPlatformLegacyChatEnv(env: Map<string, string>, migrated: Map<string, string>) {
  const legacyImageSecret = env.get("CHAT_IMAGE_TOKEN_SECRET")?.trim() ?? "";
  const currentResourceTicketSecret = env.get("CHAT_RESOURCE_TICKET_SECRET")?.trim() ?? "";
  if (
    legacyImageSecret &&
    !currentResourceTicketSecret &&
    !isPlaceholderAgentPlatformLegacySecret(legacyImageSecret)
  ) {
    migrated.set("CHAT_RESOURCE_TICKET_SECRET", legacyImageSecret);
  }

  const legacyImageTokenTtl = env.get("CHAT_IMAGE_TOKEN_TTL_SECONDS")?.trim() ?? "";
  const currentResourceTicketTtl = env.get("CHAT_RESOURCE_TICKET_TTL_SECONDS")?.trim() ?? "";
  const migratedTtl = parsePositiveIntegerEnvValue(legacyImageTokenTtl);
  if (migratedTtl && !currentResourceTicketTtl) {
    migrated.set("CHAT_RESOURCE_TICKET_TTL_SECONDS", migratedTtl);
  }
}

function agentPlatformEnvContainsDeprecatedKeys(content: string) {
  const env = parseEnvFileContent(content);
  return AGENT_PLATFORM_DEPRECATED_ENV_KEYS.some((key) => env.has(key));
}

function writeAgentPlatformLegacyEnvBackupIfNeeded(installDir: string, originalContent: string) {
  if (!originalContent.trim() || !agentPlatformEnvContainsDeprecatedKeys(originalContent)) {
    return;
  }

  const backupPath = path.join(installDir, AGENT_PLATFORM_LEGACY_ENV_BACKUP_FILE);
  if (fs.existsSync(backupPath)) {
    return;
  }

  ensureDir(path.dirname(backupPath));
  fs.writeFileSync(backupPath, originalContent, "utf8");
}

function normalizePreservedBuiltinEnvForInstall(service: ServiceDefinition, content: string) {
  if (service.id === "agent-container-hub") {
    return {
      content: normalizeAgentContainerHubEnvContentForDesktop(content),
      backupContent: ""
    };
  }

  return {
    content,
    backupContent: ""
  };
}

const AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS = [
  "STATE_DB_PATH",
  "CONFIG_ROOT",
  "ROOTFS_ROOT",
  "BUILD_ROOT",
  "SESSION_MOUNT_TEMPLATE_ROOT"
] as const;

function isAbsoluteServiceEnvPath(value: string) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeAgentContainerHubEnvContentForDesktop(content: string) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      if (!AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS.includes(
        key as (typeof AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS)[number]
      )) {
        return true;
      }

      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
      return isAbsoluteServiceEnvPath(value);
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function removeEnvKeysFromContent(content: string, keys: readonly string[]) {
  const blocked = new Set(keys);
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      return !blocked.has(key);
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function getTopLevelYamlKey(line: string) {
  const match = /^([A-Za-z0-9_-]+)\s*:/u.exec(line);
  return match?.[1] ?? "";
}

function removeDeprecatedTopLevelYamlKeys(content: string, keys: readonly string[]) {
  const blocked = new Set(keys);
  const nextLines: string[] = [];
  let skippingRemovedBlock = false;

  for (const line of content.split(/\r?\n/u)) {
    const key = getTopLevelYamlKey(line);
    if (key) {
      skippingRemovedBlock = false;
      if (blocked.has(key)) {
        skippingRemovedBlock = true;
        continue;
      }
    } else if (skippingRemovedBlock && /^[ \t]/u.test(line)) {
      continue;
    }

    nextLines.push(line);
  }

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function normalizeAgentPlatformBashConfigContent(content: string) {
  return removeDeprecatedTopLevelYamlKeys(content, AGENT_PLATFORM_DEPRECATED_BASH_CONFIG_KEYS);
}

function normalizeAgentPlatformFileToolsConfigContent(content: string) {
  return removeDeprecatedTopLevelYamlKeys(content, AGENT_PLATFORM_DEPRECATED_FILE_TOOLS_CONFIG_KEYS);
}

function normalizeAgentPlatformDeprecatedConfigFile(filePath: string, normalize: (content: string) => string) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const current = fs.readFileSync(filePath, "utf8");
  const next = normalize(current);
  if (next === current) {
    return false;
  }
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function normalizeAgentPlatformDeprecatedConfigFiles(layout: ServiceLayout) {
  const configsDir = path.join(layout.configDir, "configs");
  return [
    normalizeAgentPlatformDeprecatedConfigFile(
      path.join(configsDir, "bash.yml"),
      normalizeAgentPlatformBashConfigContent
    ),
    normalizeAgentPlatformDeprecatedConfigFile(
      path.join(configsDir, "file-tools.yml"),
      normalizeAgentPlatformFileToolsConfigContent
    )
  ].some(Boolean);
}

function removeAgentWebclientManagedNodeBinPlaceholder(content: string) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
      return key !== "NODE_BIN" || value !== PROCESS_EXEC_PATH_PLACEHOLDER;
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function isManagedAgentPlatformAuthLocalPublicKeyPath(value: string, layout?: ServiceLayout) {
  const unquoted = value.trim().replace(/^['"]|['"]$/gu, "");
  const normalized = normalizeConfigPath(unquoted);
  if (
    normalized === AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE ||
    normalized === "local-public-key.pem"
  ) {
    return true;
  }

  if (!layout) {
    return false;
  }

  const managedPath = normalizeConfigPath(resolveConfigPath(layout, AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE));
  return normalized === managedPath;
}

function removeManagedAgentPlatformAuthLocalPublicKey(content: string, layout?: ServiceLayout) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== "AUTH_LOCAL_PUBLIC_KEY_FILE") {
        return true;
      }

      const value = trimmed.slice(separatorIndex + 1).trim();
      return !isManagedAgentPlatformAuthLocalPublicKeyPath(value, layout);
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function removeDesktopManagedAgentPlatformEnvContent(content: string, layout?: ServiceLayout) {
  return removeManagedAgentPlatformAuthLocalPublicKey(
    removeEnvKeysFromContent(content, AGENT_PLATFORM_DESKTOP_REMOVED_ENV_KEYS),
    layout
  );
}

function normalizeAgentWebclientEnvContentForDesktop(content: string) {
  return upsertEnvFileContent(
    removeAgentWebclientManagedNodeBinPlaceholder(content),
    AGENT_WEBCLIENT_DESKTOP_ENV_UPDATES,
    { uncommentExisting: true }
  );
}

function normalizeAgentPlatformEnvContentForRuntime(content: string, layout?: ServiceLayout) {
  const env = parseEnvFileContent(content);
  const migrated = new Map<string, string>();
  const configuredRuntimeRoot = env.get("RUNTIME_DIR")?.trim();
  const inferredRuntimeRoot = configuredRuntimeRoot ? "" : inferAgentPlatformRuntimeRootFromChildPaths(env);
  const runtimeRoot = configuredRuntimeRoot || inferredRuntimeRoot;
  const runtimeChildKeysToRemove = runtimeRoot
    ? getAgentPlatformRuntimePathKeysResolvingUnderRoot(env, runtimeRoot)
    : [];

  for (const [oldKey, newKey] of AGENT_PLATFORM_ENV_KEY_RENAMES) {
    const oldValue = env.get(oldKey)?.trim();
    const newValue = env.get(newKey)?.trim();
    if (oldValue && !newValue) {
      migrated.set(newKey, oldValue);
    }
  }

  if (inferredRuntimeRoot) {
    migrated.set("RUNTIME_DIR", inferredRuntimeRoot);
  }

  normalizeShellSourcedAgentPlatformEnvValues(env, migrated);
  migrateAgentPlatformLegacyChatEnv(env, migrated);

  return removeDesktopManagedAgentPlatformEnvContent(
    upsertEnvFileContent(
      removeEnvKeysFromContent(
        removeEnvKeysFromContent(content, AGENT_PLATFORM_DEPRECATED_ENV_KEYS),
        runtimeChildKeysToRemove
      ),
      migrated
    ),
    layout
  );
}

function normalizeAgentPlatformEnvContentForSave(content: string) {
  return removeEnvKeysFromContent(
    normalizeAgentPlatformEnvContentForRuntime(content),
    AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS
  );
}

function resolveLocalCliAcpRelayDefaultCwd(app?: App | null) {
  return resolveDesktopDir(app);
}

function canOverrideLocalCliAcpRelayValue(currentValue: string, defaultValue: string) {
  const normalized = currentValue.trim();
  if (!normalized) {
    return true;
  }
  return normalized === defaultValue;
}

function readInstalledServiceEnv(app: App, serviceId: ServiceId) {
  try {
    const service = getService(serviceId);
    const installDir = getInstallDir(app, service);
    const layout = getServiceLayout(app, service);
    const envPath = layout.envPath;
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    return {
      installDir,
      envPath,
      content,
      env: parseEnvFileContent(content)
    };
  } catch {
    return null;
  }
}

function migrateLegacyAgentPlatformRelayEnv(
  app: App,
  env: Map<string, string>,
  updates: Map<string, string>
) {
  const platformEnvInfo = readInstalledServiceEnv(app, "agent-platform");
  if (!platformEnvInfo || !platformEnvInfo.content.trim()) {
    return;
  }

  const migrationRules = [
    {
      legacyKey: "LOCAL_CLI_ACP_RELAY_PORT",
      pluginKey: "PORT",
      defaultValue: DEFAULT_LOCAL_CLI_ACP_RELAY_PORT
    },
    {
      legacyKey: "LOCAL_CLI_ACP_RELAY_AUTH_TOKEN",
      pluginKey: "AUTH_TOKEN",
      defaultValue: ""
    },
    {
      legacyKey: "LOCAL_CLI_ACP_DEFAULT_CWD",
      pluginKey: "DEFAULT_CWD",
      defaultValue: "~/Desktop"
    },
    {
      legacyKey: "LOCAL_CLI_ACP_ALLOWED_CWD_ROOTS",
      pluginKey: "ALLOWED_CWD_ROOTS",
      defaultValue: "~/Desktop"
    },
    {
      legacyKey: "LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS",
      pluginKey: "HANDSHAKE_TIMEOUT_MS",
      defaultValue: DEFAULT_LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS
    },
    {
      legacyKey: "LOCAL_CLI_ACP_RUN_TIMEOUT_MS",
      pluginKey: "RUN_TIMEOUT_MS",
      defaultValue: DEFAULT_LOCAL_CLI_ACP_RUN_TIMEOUT_MS
    },
    {
      legacyKey: "CLAUDE_CODE_ACP_COMMAND",
      pluginKey: "CLAUDE_CODE_ACP_COMMAND",
      defaultValue: ""
    },
    {
      legacyKey: "CLAUDE_CODE_ACP_ARGS",
      pluginKey: "CLAUDE_CODE_ACP_ARGS",
      defaultValue: ""
    }
  ] as const;

  for (const rule of migrationRules) {
    const currentValue = updates.get(rule.pluginKey) ?? env.get(rule.pluginKey) ?? "";
    if (!canOverrideLocalCliAcpRelayValue(currentValue, rule.defaultValue)) {
      continue;
    }

    const legacyValue = platformEnvInfo.env.get(rule.legacyKey)?.trim() ?? "";
    if (!legacyValue) {
      continue;
    }
    updates.set(rule.pluginKey, legacyValue);
  }

  const cleanedContent = removeEnvKeysFromContent(platformEnvInfo.content, AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS);
  if (cleanedContent !== platformEnvInfo.content) {
    fs.writeFileSync(platformEnvInfo.envPath, cleanedContent, "utf8");
  }
}

async function ensureLocalCliAcpRelayDesktopConfig(app: App, layout: ServiceLayout) {
  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();

  migrateLegacyAgentPlatformRelayEnv(app, env, updates);

  if (!env.get("PORT")?.trim()) {
    updates.set("PORT", DEFAULT_LOCAL_CLI_ACP_RELAY_PORT);
  }
  if (!env.get("DEFAULT_CWD")?.trim()) {
    updates.set("DEFAULT_CWD", resolveLocalCliAcpRelayDefaultCwd(app));
  }
  if (!env.get("ALLOWED_CWD_ROOTS")?.trim()) {
    updates.set("ALLOWED_CWD_ROOTS", resolveLocalCliAcpRelayDefaultCwd(app));
  }
  if (!env.get("HANDSHAKE_TIMEOUT_MS")?.trim()) {
    updates.set("HANDSHAKE_TIMEOUT_MS", DEFAULT_LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS);
  }
  if (!env.get("RUN_TIMEOUT_MS")?.trim()) {
    updates.set("RUN_TIMEOUT_MS", DEFAULT_LOCAL_CLI_ACP_RUN_TIMEOUT_MS);
  }
  const effectiveEnv = new Map(env);
  for (const [key, value] of updates) {
    effectiveEnv.set(key, value);
  }
  const resolvedAcpCommand = resolveAcpCommandForDesktop(effectiveEnv);
  if (resolvedAcpCommand) {
    updates.set("CLAUDE_CODE_ACP_COMMAND", resolvedAcpCommand.command);
    updates.set("CLAUDE_CODE_ACP_ARGS", resolvedAcpCommand.args);
  }

  if (updates.size > 0) {
    normalizeShellSourcedAgentPlatformEnvUpdates(updates);
    writeEnvFileUpdates(envPath, updates);
  }
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
    writeAgentPlatformLegacyEnvBackupIfNeeded(layout.configDir, currentContent);
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

  const migratedRuntimeRoot = resolveLegacyAgentPlatformRuntimeRootMigration(app, env);
  if (migratedRuntimeRoot) {
    const homeDir = resolveHomeDir(app);
    updates.set("RUNTIME_DIR", formatDesktopAgentPlatformRuntimeRoot(app, migratedRuntimeRoot));
    console.warn(
      `[service-manager] Migrated agent-platform runtime paths from legacy desktop default ${path.join(homeDir, "zenmind")} to ${migratedRuntimeRoot}`
    );
  }

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
      env: {
        ...buildServiceLayoutEnv(layout),
        ...(options.env ?? {})
      }
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

function getShutdownStopCommandTimeoutMs(timeoutMs: number | undefined) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
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
  resolveLegacyAgentPlatformRuntimeRootMigration,
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
