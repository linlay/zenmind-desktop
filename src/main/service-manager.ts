import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
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
} from "../shared/contracts";
import type { ServiceDefinition } from "./manifest-utils";
import { getBuiltinAssetsRoot } from "./builtin-loader";
import { getAllServices, getService } from "./service-registry";
import { getPluginInstallDir } from "./plugin-loader";
import { ensureKeyPairForPan } from "./pan-auth";
import { readEnvFile, parseEnvFileContent } from "./env-file";
import { extractArchiveToDir, listArchiveEntries } from "./archive-utils";
import { getDataRoot, getServicesRoot } from "./user-paths";

const startedThisSession = new Set<ServiceId>();
const LOG_READ_WINDOW_BYTES = 256 * 1024;
const LOG_STREAM_POLL_INTERVAL_MS = 1000;

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
  pidFilePaths: string[];
};

type ManagedProcessCleanupTarget = ManagedRootPid & {
  treePids: number[];
};

type ManagedServiceStopState = {
  mainPidFilePath: string;
  managedMainPid: number | null;
  port: number;
  managedPortPids: number[];
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
    return [
      path.join(programFiles, "nodejs"),
      path.join(programFiles, "Docker", "Docker", "resources", "bin"),
      path.join(programFiles, "RedHat", "Podman"),
      path.join(programFiles, "Podman"),
      ...(localAppData ? [path.join(localAppData, "Programs", "nodejs")] : []),
      ...(appData ? [path.join(appData, "npm")] : [])
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

const INITIALIZATION_STATE_DIRNAME = ".zenmind-desktop";
const INITIALIZATION_STATE_FILE = "init-state.json";
const LAST_RUNNING_SERVICES_FILE = "last-running-services.json";
const DEFAULT_STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const RESTORE_PRIORITY = ["agent-container-hub", "zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const SERVICE_COMMAND_TIMEOUT_MS = 60_000;
const SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 2_500;

function buildServiceEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extraPaths = [...getStaticServicePaths(), ...getShellPathEntries()];
  if (extraPaths.length === 0) {
    return env;
  }
  const current = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extraPaths])];
  env.PATH = merged.join(path.delimiter);
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

function resolveCloudflaredBin() {
  const explicit = process.env.CLOUDFLARED_BIN?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  const fromPath = resolveCommandBin("cloudflared");
  if (fromPath) {
    return fromPath;
  }
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe")]
    : [
      "/opt/homebrew/bin/cloudflared",
      "/opt/homebrew/opt/cloudflared/bin/cloudflared",
      "/usr/local/bin/cloudflared"
    ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? "";
}

function isCommandBasenameMatch(command: string, expected: string) {
  return path.basename(command).toLowerCase() === expected.toLowerCase();
}

const bundleValidationCache = new Map<string, { key: string; missingEntries: string[] }>();

export function getInstallDir(app: App, service: ServiceDefinition) {
  if (service.kind === "plugin") {
    return getPluginInstallDir(app, service.id);
  }
  return path.join(getServicesRoot(app), service.id, service.version);
}

function getBuiltinServiceVersionRoot(app: App, serviceId: ServiceId) {
  return path.join(getServicesRoot(app), serviceId);
}

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

function getInitializationStatePath(installDir: string) {
  return path.join(installDir, INITIALIZATION_STATE_DIRNAME, INITIALIZATION_STATE_FILE);
}

function readInitializationState(installDir: string): InitializationState | null {
  const filePath = getInitializationStatePath(installDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const status = parsed.status === "succeeded" || parsed.status === "failed" ? parsed.status : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const lastError = typeof parsed.lastError === "string" && parsed.lastError.trim() ? parsed.lastError : undefined;
    if (!version || !status || !updatedAt) {
      return null;
    }
    return {
      version,
      status,
      updatedAt,
      ...(lastError ? { lastError } : {})
    };
  } catch {
    return null;
  }
}

function isAssetNewerThanInstall(assetPath: string, installDir: string) {
  try {
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    const initStatePath = getInitializationStatePath(installDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
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
    return isAssetNewerThanInstall(assetPath, installDir);
  } catch {
    return false;
  }
}

function writeInitializationState(installDir: string, state: InitializationState) {
  const filePath = getInitializationStatePath(installDir);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getLastRunningServicesStatePath(app: App) {
  return path.join(getDataRoot(app), INITIALIZATION_STATE_DIRNAME, LAST_RUNNING_SERVICES_FILE);
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
    ...readLastRunningServices(app).filter((serviceId) => serviceId !== "agent-container-hub")
  ]);
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
    const prefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    return ![...entries].some((entry) => entry.startsWith(prefix));
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

function upsertEnvFileContent(content: string, updates: Map<string, string>) {
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

function writeEnvFileUpdates(filePath: string, updates: Map<string, string>) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, upsertEnvFileContent(current, updates), "utf8");
}

const MAX_TCP_PORT = 65535;
const CORE_SERVICE_IDS = new Set<ServiceId>([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "zenmind-app-server"
]);
const AGENT_WEBCLIENT_PLATFORM_URL_KEYS = ["BASE_URL", "WS_BASE_URL", "VOICE_BASE_URL"] as const;
const AGENT_WEBCLIENT_DESKTOP_ONLY_ENV_KEYS = ["NODE_BIN", "NODE_ENV", "DEV_SERVER_ALLOWED_HOSTS"] as const;
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
  const keys = service.web.portEnvKey ? [service.web.portEnvKey] : [];
  if (service.id === "agent-platform" && !keys.includes("SERVER_PORT")) {
    keys.push("SERVER_PORT");
  }
  return keys;
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

function resolveRuntimePath(installDir: string, relativePath: string) {
  return relativePath ? path.join(installDir, relativePath) : "";
}

function readPid(pidFilePath: string) {
  if (!fs.existsSync(pidFilePath)) {
    return null;
  }
  const raw = fs.readFileSync(pidFilePath, "utf8").trim();
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

function parseProcessTreeRowsFromPowerShell(stdout: string): ProcessTreeRow[] {
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
      return parseProcessTreeRowsFromPowerShell(result.stdout);
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

  signalProcessList(uniquePids, "SIGTERM");
  if (waitForProcessesExit(uniquePids, 2500)) {
    return true;
  }

  signalProcessList(uniquePids, "SIGKILL");
  return waitForProcessesExit(uniquePids, 1000);
}

function terminateProcessTree(rootPid: number) {
  if (!isProcessRunning(rootPid)) {
    return true;
  }

  if (IS_WINDOWS) {
    try {
      const result = spawnSync("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
        encoding: "utf8",
        env: buildServiceEnv(),
        timeout: 5000
      });
      if (result.status === 0 || !isProcessRunning(rootPid)) {
        return true;
      }
    } catch {
      // Fall back to process table traversal below.
    }
  }

  const treePids = listProcessTreePids(rootPid);
  return terminateProcessList(treePids.length > 0 ? treePids : [rootPid]);
}

function removePidFile(pidFilePath: string) {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore pid cleanup failures and let the next startup attempt surface a real error if needed.
  }
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
      existing.pidFilePaths.push(pidFilePath);
    }
    return;
  }

  roots.set(pid, {
    pid,
    serviceId,
    pidFilePaths: pidFilePath ? [pidFilePath] : []
  });
}

function collectManagedRootPids(app: App) {
  const roots = new Map<number, ManagedRootPid>();

  for (const service of getAllServices()) {
    const installDir = getInstallDir(app, service);
    if (!fs.existsSync(installDir)) {
      continue;
    }

    const pidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
    addManagedRootPid(roots, service.id, readPid(pidFilePath), installDir, pidFilePath);

    const envPath = path.join(installDir, ".env");
    const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
    const port = parsePort(service, env);
    if (port > 0) {
      for (const pid of listListeningPids(port)) {
        addManagedRootPid(roots, service.id, pid, installDir);
      }
    }
  }

  return [...roots.values()];
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
      existing.pidFilePaths.push(...root.pidFilePaths);
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

export async function forceCleanupManagedProcesses(app: App, snapshot: ManagedProcessCleanupTarget[] = []) {
  const roots = mergeCleanupTargets(snapshot, collectManagedRootPids(app));
  const failures: string[] = [];

  for (const root of roots) {
    const terminated = root.treePids.length > 0
      ? terminateProcessList(root.treePids)
      : terminateProcessTree(root.pid);
    for (const pidFilePath of root.pidFilePaths) {
      removePidFile(pidFilePath);
    }

    if (!terminated && root.treePids.some((pid) => isProcessRunning(pid))) {
      failures.push(`${root.serviceId}: PID ${root.pid}`);
    }
  }

  if (failures.length > 0) {
    console.error(`failed to force-clean managed service processes: ${failures.join("; ")}`);
  }
}

function collectManagedServiceStopState(
  service: ServiceDefinition,
  installDir: string,
  env: Map<string, string>
): ManagedServiceStopState {
  const mainPidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
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
  installDir: string,
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
  const afterStopState = collectState(service, installDir, env);
  const stopIssues = buildManagedServiceStopIssues(service, afterStopState, "stop");
  if (stopIssues.length === 0) {
    return {
      ok: true,
      forcedCleanup: false,
      message: ""
    };
  }

  forceStop(service, installDir, env);
  const afterCleanupState = collectState(service, installDir, env);
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
    execFile(
      windowsPowerShellPath(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperScriptPath],
      { cwd, env: buildServiceCommandEnv(options.env), timeout: timeoutMs },
      (error, stdout, stderr) => {
        try {
          fs.rmSync(wrapperScriptPath, { force: true });
        } catch {
          // Ignore wrapper cleanup failures and surface the script result instead.
        }
        const decoded = decodePowerShellCapturePayload(stdout);
        const result = decoded ?? {
          stdout: "",
          stderr: [coerceExecText(stderr).trim(), coerceExecText(stdout).trim()].filter(Boolean).join("\n")
        };

        if (error) {
          reject(new Error(formatExecErrorMessage(error.message, result)));
          return;
        }

        resolve({
          stdout: result.stdout,
          stderr: result.stderr
        });
      }
    );
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
function containerEngineAvailable() {
  const env = buildServiceEnv();
  const diagOnce = !containerEngineDiagOnce;
  containerEngineDiagOnce = true;
  if (diagOnce) {
    const pathPreview = (env.PATH ?? "").split(path.delimiter).slice(0, 8).join(" | ");
    console.log(`[container-engine] PATH(top 8): ${pathPreview}`);
  }

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

  const reachable = (name: string) => {
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
    if (exists(engine) && reachable(engine)) {
      return engine;
    }
  }

  return "";
}

function collectPrerequisites(service: ServiceDefinition, installDir: string) {
  const prerequisites: string[] = [];
  const envPath = path.join(installDir, ".env");
  if (!fs.existsSync(envPath)) {
    prerequisites.push("缺少 .env 配置文件");
  }

  for (const target of service.importTargets) {
    const targetPath = path.join(installDir, target.relativePath);
    if (target.required && !fs.existsSync(targetPath)) {
      prerequisites.push(`缺少 ${target.label}`);
    }
  }

  if (service.id === "agent-container-hub" && !containerEngineAvailable()) {
    prerequisites.push("未检测到 Docker 或 Podman");
  }

  return prerequisites;
}

function ensureDefaultConfig(service: ServiceDefinition, installDir: string) {
  for (const configFile of service.configFiles) {
    const targetPath = path.join(installDir, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = path.join(installDir, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}

async function ensureInitializationRequirements(app: App, service: ServiceDefinition, installDir: string) {
  if (service.id === "agent-platform") {
    await ensureAgentPlatformDesktopConfig(app, service, installDir);
    ensureLocalAuthPublicKey(app, installDir);
  }

  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, installDir);
  }

  if (service.id === "agent-webclient") {
    const envPath = path.join(installDir, ".env");
    const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const normalizedContent = normalizeAgentWebclientEnvContentForDesktop(currentContent);
    if (normalizedContent !== currentContent) {
      fs.writeFileSync(envPath, normalizedContent, "utf8");
    }
  }

  if (service.id === "pan-webclient") {
    ensureLocalAuthPublicKey(app, installDir);
  }
}

function ensureLocalAuthPublicKey(app: App, installDir: string) {
  const publicKeyPath = path.join(installDir, "configs", "local-public-key.pem");
  if (fs.existsSync(publicKeyPath)) {
    return;
  }

  const { publicKeyPem } = ensureKeyPairForPan(app);
  ensureDir(path.dirname(publicKeyPath));
  fs.writeFileSync(publicKeyPath, publicKeyPem, "utf8");
}

async function ensureMutableInstallDir(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id);
    return getInstallDir(app, service);
  }

  throw new Error(`${service.name} 尚未导入，请先导入插件。`);
}

type InstallBuiltinServiceOptions = {
  force?: boolean;
  archivePath?: string;
};

export async function installBuiltinService(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const service = getService(serviceId);
  if (service.kind !== "builtin") {
    throw new Error(`service ${serviceId} is not a builtin service`);
  }
  const assetPath = options.archivePath
    ? ensureArchiveHealthy(service, options.archivePath, "安装包")
    : ensureBundleAssetHealthy(app, service);

  const finalInstallDir = getInstallDir(app, service);
  const siblingInstallDirs = listBuiltinSiblingInstallDirs(app, service, finalInstallDir);
  const needsExtract =
    options.force ||
    !fs.existsSync(finalInstallDir) ||
    !isInstallHealthy(service, finalInstallDir) ||
    serviceInstallNeedsRefresh(service, finalInstallDir) ||
    isAssetNewerThanInstall(assetPath, finalInstallDir);

  const preservedEnvPath = path.join(finalInstallDir, ".env");
  const hasCurrentEnv = fileExists(preservedEnvPath);
  const preservedEnvRaw = hasCurrentEnv
    ? fs.readFileSync(preservedEnvPath, "utf8")
    : readPreservedEnvFromSiblingInstallDirs(siblingInstallDirs);
  const preservedEnv = preservedEnvRaw
    ? normalizePreservedBuiltinEnvForInstall(service, preservedEnvRaw)
    : { content: "", backupContent: "" };

  await reconcileBuiltinSiblingInstallDirs(app, service, finalInstallDir);

  if (!needsExtract) {
    const initialization = await initializeServiceInternal(app, serviceId, { skipInstallRefresh: true });
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
    const entries = fs.readdirSync(tempRoot);
    if (entries.length !== 1) {
      throw new Error(`unexpected archive layout for ${service.id}`);
    }
    const extractedRoot = path.join(tempRoot, entries[0]);
    fs.rmSync(finalInstallDir, { recursive: true, force: true });
    fs.cpSync(extractedRoot, finalInstallDir, { recursive: true });
    if (preservedEnv.content) {
      fs.writeFileSync(path.join(finalInstallDir, ".env"), preservedEnv.content, "utf8");
      if (preservedEnv.backupContent) {
        writeAgentPlatformLegacyEnvBackupIfNeeded(finalInstallDir, preservedEnv.backupContent);
      }
    }
    const initialization = await initializeServiceInternal(app, serviceId, { skipInstallRefresh: true });
    if (!initialization.ok) {
      throw new Error(initialization.message);
    }
    return finalInstallDir;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function initializeService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  return initializeServiceInternal(app, serviceId);
}

async function initializeServiceInternal(
  app: App,
  serviceId: ServiceId,
  options: { skipInstallRefresh?: boolean } = {}
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
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
      await installBuiltinService(app, service.id, { force: true });
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
    ensureDefaultConfig(service, installDir);
    fixShellScriptPermissions(installDir);
    await ensureInitializationRequirements(app, service, installDir);
    if (service.deployCommand) {
      await runExecFile(service.deployCommand[0], service.deployCommand.slice(1), installDir);
    }
    writeInitializationState(installDir, {
      version: service.version,
      status: "succeeded",
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    writeInitializationState(installDir, {
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
}

export async function listServices(app: App) {
  return Promise.all(getAllServices().map((service) => getServiceState(app, service.id)));
}

export async function getServiceState(app: App, serviceId: ServiceId): Promise<ServiceState> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const installed = fs.existsSync(installDir);
  const pidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
  const logFilePath = resolveRuntimePath(installDir, service.runtime.logRelativePath);
  const errorLogFilePath = resolveRuntimePath(installDir, service.runtime.errorLogRelativePath);
  const configFiles = service.configFiles.map((configFile) => {
    const absolutePath = path.join(installDir, configFile.relativePath);
    return {
      key: configFile.key,
      label: configFile.label,
      relativePath: configFile.relativePath,
      absolutePath,
      required: configFile.required,
      exists: fs.existsSync(absolutePath)
    };
  });

  const env = installed ? readEnvFile(path.join(installDir, ".env")) : new Map<string, string>();
  const port = parsePort(service, env);
  const webUrl = installed ? getWebUrl(service, env) : getWebUrl(service, new Map<string, string>());
  const pidFromFile = installed ? readPid(pidFilePath) : null;
  const missingRuntimeFiles = installed ? listMissingRuntimeFiles(service, installDir) : [];
  const initializationState =
    installed && missingRuntimeFiles.length === 0 ? readInitializationState(installDir) : null;
  const initializationSucceeded =
    initializationState?.status === "succeeded" && initializationState.version === service.version;
  const prerequisites =
    installed && missingRuntimeFiles.length === 0 && initializationSucceeded
      ? collectPrerequisites(service, installDir)
      : [];
  let pid = pidFromFile;
  let running = installed && missingRuntimeFiles.length === 0 && isProcessRunning(pid);
  let conflictingPortPid: number | null = null;

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && !running && port > 0) {
    const detectedPid = detectManagedServicePid(installDir, port);
    if (detectedPid) {
      pid = detectedPid;
      running = true;
      if (pidFromFile !== detectedPid) {
        writePidFile(pidFilePath, detectedPid);
      }
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
  const raw = Number.parseInt(process.env.ZENMIND_SERVICE_VERIFY_DELAY_MS ?? "", 10);
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
  const first = await collectServiceVerification(app, serviceId, desired);
  if (!first.verification.verified || getServiceVerificationDelayMs() <= 0) {
    return first.verification;
  }

  await delay(getServiceVerificationDelayMs());
  const second = await collectServiceVerification(app, serviceId, desired);
  return second.verification;
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

async function isAgentWebclientRunning(app: App) {
  try {
    const webclientState = await getServiceState(app, "agent-webclient");
    return webclientState.status === "running";
  } catch {
    return false;
  }
}

function didAgentPlatformRuntimeChange(previousPlatformState: ServiceState, nextPlatformState: ServiceState) {
  if (previousPlatformState.status !== "running") {
    return true;
  }
  return previousPlatformState.healthMeta.pid !== nextPlatformState.healthMeta.pid;
}

async function restartAgentWebclientAfterPlatformStart(app: App, platformResult: ServiceCommandResult) {
  const webclientResult = await restartService(app, "agent-webclient");
  if (!webclientResult.ok || webclientResult.service.status !== "running") {
    return {
      ...platformResult,
      ok: false,
      message: `${platformResult.message} 但智能助理刷新失败：${webclientResult.message}`
    };
  }
  return platformResult;
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
  "RUNTIME_DIR",
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

function serviceInstallNeedsRefresh(service: ServiceDefinition, installDir: string) {
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
  const usesDefaultAcpCommand =
    !currentAcpCommand
    || isCommandBasenameMatch(currentAcpCommand, "npx")
    || isCommandBasenameMatch(currentAcpCommand, "claude-code-acp");
  const usesDefaultAcpArgs =
    !currentAcpArgs || currentAcpArgs.trim() === "-y @zed-industries/claude-code-acp";
  const resolvedClaudeCodeAcpBin = resolveCommandBin("claude-code-acp");
  if (resolvedClaudeCodeAcpBin && usesDefaultAcpCommand) {
    return {
      command: resolvedClaudeCodeAcpBin,
      args: usesDefaultAcpArgs ? "" : currentAcpArgs
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
  if (service.id === "agent-webclient") {
    return {
      content: normalizeAgentWebclientEnvContentForDesktop(content),
      backupContent: ""
    };
  }

  if (service.id !== "agent-platform") {
    return {
      content,
      backupContent: ""
    };
  }

  const normalized = normalizeAgentPlatformEnvContentForRuntime(content);
  return {
    content: normalized,
    backupContent: normalized !== content ? content : ""
  };
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

function normalizeAgentWebclientEnvContentForDesktop(content: string) {
  return removeEnvKeysFromContent(content, AGENT_WEBCLIENT_DESKTOP_ONLY_ENV_KEYS);
}

function normalizeAgentPlatformEnvContentForRuntime(content: string) {
  const env = parseEnvFileContent(content);
  const migrated = new Map<string, string>();

  for (const [oldKey, newKey] of AGENT_PLATFORM_ENV_KEY_RENAMES) {
    const oldValue = env.get(oldKey)?.trim();
    const newValue = env.get(newKey)?.trim();
    if (oldValue && !newValue) {
      migrated.set(newKey, oldValue);
    }
  }

  const legacyRuntimeRoot = env.get("RUNTIME_DIR")?.trim();
  if (legacyRuntimeRoot) {
    for (const [key, relativePath] of agentPlatformDesktopRuntimePaths) {
      if (!env.get(key)?.trim()) {
        migrated.set(key, path.join(legacyRuntimeRoot, relativePath));
      }
    }
  }

  normalizeShellSourcedAgentPlatformEnvValues(env, migrated);
  migrateAgentPlatformLegacyChatEnv(env, migrated);
  syncAgentPlatformDesktopPortEnv(env, migrated);

  return upsertEnvFileContent(removeEnvKeysFromContent(content, AGENT_PLATFORM_DEPRECATED_ENV_KEYS), migrated);
}

function normalizeAgentPlatformEnvContentForSave(content: string) {
  return removeEnvKeysFromContent(
    normalizeAgentPlatformEnvContentForRuntime(content),
    AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS
  );
}

async function normalizeCoreServiceEnvContentForSave(
  app: App,
  service: ServiceDefinition,
  key: string,
  content: string
) {
  if (key !== "env" || !CORE_SERVICE_IDS.has(service.id)) {
    return content;
  }

  const normalizedContent =
    service.id === "agent-platform"
      ? normalizeAgentPlatformEnvContentForSave(content)
      : service.id === "agent-webclient"
        ? normalizeAgentWebclientEnvContentForDesktop(content)
        : content;
  const env = parseEnvFileContent(normalizedContent);
  const updates = new Map<string, string>();

  syncCoreServiceDefaultPortEnv(service, env, updates);

  if (service.id === "agent-platform") {
    syncAgentPlatformDesktopPortEnv(env, updates);
    await syncAgentPlatformContainerHubUrl(app, env, updates);
  }

  if (service.id === "agent-webclient") {
    await syncAgentWebclientPlatformUrls(app, env, updates);
  }

  return updates.size > 0 ? upsertEnvFileContent(normalizedContent, updates) : normalizedContent;
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
    const envPath = path.join(installDir, ".env");
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

async function ensureLocalCliAcpRelayDesktopConfig(app: App, installDir: string) {
  const envPath = path.join(installDir, ".env");
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
  if (!env.get("NODE_BIN")?.trim()) {
    updates.set("NODE_BIN", resolveNodeBin());
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
    const bindingKey = service.id === "agent-platform"
      ? (AGENT_PLATFORM_ENV_KEY_RENAMES.get(binding.key) ?? binding.key)
      : binding.key;
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
    const key = service.id === "agent-platform"
      ? (AGENT_PLATFORM_ENV_KEY_RENAMES.get(item.key) ?? item.key)
      : item.key;
    return key === bindingKey && item.value !== undefined;
  });
  if (!binding?.value) {
    return String(service.web.defaultPort);
  }
  return binding.value.replace("{{serviceDefaultPort}}", String(service.web.defaultPort));
}

function canApplyDefaultEnvBinding(service: ServiceDefinition, bindingKey: string, currentValue: string) {
  const binding = service.desktop.envBindings.find((item) => {
    const key = service.id === "agent-platform"
      ? (AGENT_PLATFORM_ENV_KEY_RENAMES.get(item.key) ?? item.key)
      : item.key;
    return key === bindingKey && item.value !== undefined;
  });
  if (!binding) {
    return false;
  }
  if (!binding.onlyIfDefault) {
    return true;
  }
  return new Set(binding.defaults ?? [""]).has(currentValue);
}

function syncCoreServiceDefaultPortEnv(service: ServiceDefinition, env: Map<string, string>, updates: Map<string, string>) {
  if (!CORE_SERVICE_IDS.has(service.id)) {
    return;
  }

  for (const key of getServicePortEnvKeys(service)) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (!canApplyDefaultEnvBinding(service, key, currentValue)) {
      continue;
    }
    updates.set(key, resolveEnvBindingValue(service, key));
  }
}

function syncAgentPlatformDesktopPortEnv(env: Map<string, string>, updates: Map<string, string>) {
  const updatedServerPort = parsePortValue(updates.get("SERVER_PORT") ?? "");
  if (updatedServerPort) {
    updates.set("HOST_PORT", String(updatedServerPort));
    return;
  }

  const updatedHostPort = parsePortValue(updates.get("HOST_PORT") ?? "");
  if (updatedHostPort) {
    updates.set("SERVER_PORT", String(updatedHostPort));
    return;
  }

  const hostPort = parsePortValue(getEnvValueWithUpdates(env, updates, "HOST_PORT"));
  if (hostPort) {
    updates.set("SERVER_PORT", String(hostPort));
    return;
  }

  const serverPort = parsePortValue(getEnvValueWithUpdates(env, updates, "SERVER_PORT"));
  if (serverPort) {
    updates.set("HOST_PORT", String(serverPort));
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

async function syncAgentPlatformContainerHubUrl(app: App, env: Map<string, string>, updates: Map<string, string>) {
  const hubPort = await getServicePortForEnvSync(app, "agent-container-hub");
  if (!hubPort) {
    return;
  }

  const currentValue = getEnvValueWithUpdates(env, updates, "CONTAINER_HUB_BASE_URL");
  if (currentValue && !isDesktopManagedContainerHubUrl(currentValue)) {
    return;
  }

  updates.set("CONTAINER_HUB_BASE_URL", `http://127.0.0.1:${hubPort}`);
}

function syncAgentWebclientPlatformUrlsToPort(
  env: Map<string, string>,
  updates: Map<string, string>,
  platformPort: number | null,
  additionalManagedPorts: Array<number | null | undefined> = []
) {
  if (!platformPort) {
    return;
  }

  const platformUrl = `http://127.0.0.1:${platformPort}`;
  for (const key of AGENT_WEBCLIENT_PLATFORM_URL_KEYS) {
    const currentValue = getEnvValueWithUpdates(env, updates, key);
    if (currentValue && !isDesktopManagedPlatformUrl(currentValue, platformPort, additionalManagedPorts)) {
      continue;
    }
    updates.set(key, platformUrl);
  }
}

async function syncAgentWebclientPlatformUrls(app: App, env: Map<string, string>, updates: Map<string, string>) {
  const platformPort = await getServicePortForEnvSync(app, "agent-platform");
  syncAgentWebclientPlatformUrlsToPort(env, updates, platformPort);
}

function readInstalledServicePortForSync(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (!fs.existsSync(installDir)) {
    return null;
  }
  const envPath = path.join(installDir, ".env");
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  return parsePort(service, env);
}

async function syncAgentWebclientEnvAfterAgentPlatformSave(app: App, previousPlatformPort: number | null) {
  const webclientEnvInfo = readInstalledServiceEnv(app, "agent-webclient");
  if (!webclientEnvInfo || !fs.existsSync(webclientEnvInfo.envPath)) {
    return;
  }

  const platformPort = await getServicePortForEnvSync(app, "agent-platform");
  const updates = new Map<string, string>();
  syncAgentWebclientPlatformUrlsToPort(webclientEnvInfo.env, updates, platformPort, [previousPlatformPort]);
  if (updates.size === 0) {
    return;
  }

  fs.writeFileSync(webclientEnvInfo.envPath, upsertEnvFileContent(webclientEnvInfo.content, updates), "utf8");
}

async function syncCoreServiceDependentEnvAfterSave(
  app: App,
  service: ServiceDefinition,
  key: string,
  previousServicePort: number | null
) {
  if (key !== "env" || service.id !== "agent-platform") {
    return;
  }

  await syncAgentWebclientEnvAfterAgentPlatformSave(app, previousServicePort);
}

async function ensureAgentPlatformContainerHubDependency(app: App, installDir: string) {
  let hubService: ServiceDefinition;
  try {
    hubService = getService("agent-container-hub");
  } catch {
    return;
  }

  const env = readEnvFile(path.join(installDir, ".env"));
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

async function ensureAgentPlatformDesktopConfig(app: App, service: ServiceDefinition, installDir: string) {
  const envPath = path.join(installDir, ".env");
  const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const normalizedContent = normalizeAgentPlatformEnvContentForRuntime(currentContent);
  if (normalizedContent !== currentContent) {
    writeAgentPlatformLegacyEnvBackupIfNeeded(installDir, currentContent);
    fs.writeFileSync(envPath, normalizedContent, "utf8");
  }
  const env = parseEnvFileContent(normalizedContent);
  const updates = new Map<string, string>();

  await applyEnvBindings(app, service, env, updates);
  syncAgentPlatformDesktopPortEnv(env, updates);
  await syncAgentPlatformContainerHubUrl(app, env, updates);

  updates.set("NODE_BIN", resolveNodeBin());
  if (!env.get("PROVIDER_APIKEY_KEY_PART")?.trim()) {
    updates.set("PROVIDER_APIKEY_KEY_PART", DEFAULT_PROVIDER_APIKEY_KEY_PART);
  }
  applyAgentPlatformWindowsHostShellDefaults(env, updates);
  if (!env.get("CLOUDFLARED_BIN")?.trim()) {
    const cloudflaredBin = resolveCloudflaredBin();
    if (cloudflaredBin) {
      updates.set("CLOUDFLARED_BIN", cloudflaredBin);
    }
  }

  const migratedRuntimeRoot = resolveLegacyAgentPlatformRuntimeRootMigration(app, env);
  if (migratedRuntimeRoot) {
    const homeDir = resolveHomeDir(app);
    for (const [key, relativePath] of agentPlatformDesktopRuntimePaths) {
      updates.set(key, path.join(migratedRuntimeRoot, relativePath));
    }
    console.warn(
      `[service-manager] Migrated agent-platform runtime paths from legacy desktop default ${path.join(homeDir, "zenmind")} to ${migratedRuntimeRoot}`
    );
  }

  const desktopRuntimeRoot = resolvePreferredAgentPlatformRuntimeRoot(app);
  if (!hasConfiguredAgentPlatformRuntimePath(env)) {
    for (const [key, relativePath] of agentPlatformDesktopRuntimePaths) {
      if (!env.get(key)) {
        updates.set(key, path.join(desktopRuntimeRoot, relativePath));
      }
    }
  }

  if (updates.size > 0) {
    normalizeShellSourcedAgentPlatformEnvUpdates(updates);
    writeEnvFileUpdates(envPath, updates);
  }
}

async function ensurePreStartRequirements(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (service.id === "agent-platform") {
    await ensureAgentPlatformDesktopConfig(app, service, installDir);
    await ensureAgentPlatformContainerHubDependency(app, installDir);
    ensureLocalAuthPublicKey(app, installDir);
    return;
  }

  if (service.id === LOCAL_CLI_ACP_RELAY_PLUGIN_ID) {
    await ensureLocalCliAcpRelayDesktopConfig(app, installDir);
  }

  const envPath = path.join(installDir, ".env");
  if (service.id === "agent-webclient") {
    const currentContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const normalizedContent = normalizeAgentWebclientEnvContentForDesktop(currentContent);
    if (normalizedContent !== currentContent) {
      fs.writeFileSync(envPath, normalizedContent, "utf8");
    }
  }
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();

  // Apply manifest-declared envBindings generically.
  await applyEnvBindings(app, service, env, updates);

  // Service-specific logic that cannot be expressed via envBindings.
  if (service.id === "agent-webclient") {
    updates.delete("NODE_BIN");
    await syncAgentWebclientPlatformUrls(app, env, updates);
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = agentWebclientInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, installDir))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh
      });
    }
  }

  if (service.id === "zenmind-app-server") {
    const assetPath = getOptionalBundleAssetPath(app, service);
    const forceRefresh = zenmindAppServerInstallNeedsRefresh(installDir);
    if (assetPath && (forceRefresh || isAssetNewerThanInstall(assetPath, installDir))) {
      await installBuiltinService(app, service.id, {
        force: forceRefresh
      });
    }
    if (!env.get("FRONTEND_DIST_DIR")?.trim()) {
      updates.set("FRONTEND_DIST_DIR", "./frontend/dist");
    }
  }

  if (updates.size > 0) {
    writeEnvFileUpdates(envPath, updates);
  }
}

type RunServiceCommandOptions = {
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

function resolveAgentWebclientStartEnv() {
  const nodeBin = resolveNodeBin();
  if (IS_WINDOWS) {
    return { NODE_BIN: nodeBin };
  }

  if (process.platform === "darwin") {
    return { NODE_BIN: nodeBin };
  }

  return { NODE_BIN: nodeBin };
}

function getStartCommandEnvOverrides(service: ServiceDefinition) {
  if (service.id !== "agent-webclient") {
    return undefined;
  }

  return resolveAgentWebclientStartEnv();
}

async function runServiceCommand(
  app: App,
  service: ServiceDefinition,
  command: string[],
  successMessage: string,
  options: RunServiceCommandOptions = {}
) {
  const installDir = getInstallDir(app, service);
  const shouldRefreshBuiltinAsset = options.refreshBuiltinAsset !== false;
  if (service.kind === "builtin" && shouldRefreshBuiltinAsset) {
    const assetPath = getOptionalBundleAssetPath(app, service);
    if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
      if (!assetPath) {
        throw new Error(`${service.name} 未安装或安装已损坏。`);
      }
      await installBuiltinService(app, service.id);
    } else if (assetPath && isAssetNewerThanInstall(assetPath, installDir)) {
      await installBuiltinService(app, service.id);
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
    await installBuiltinService(app, service.id);
  }
  if (command.length === 0) {
    throw new Error(`${service.name} 缺少可执行脚本定义。`);
  }
  await runExecFile(command[0], command.slice(1), installDir, {
    timeoutMs: options.timeoutMs,
    env: options.env
  });
  return {
    ok: true,
    message: successMessage,
    service: await getServiceState(app, service.id)
  } satisfies ServiceCommandResult;
}

export async function startService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const current = await getServiceState(app, serviceId);
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const shouldRefreshFromBundledAsset = service.kind === "builtin" && needsBundledAssetRefresh(app, service);
  const shouldRestartWebclientAfterPlatformStart = service.id === "agent-platform"
    ? await isAgentWebclientRunning(app)
    : false;

  if (shouldRefreshFromBundledAsset) {
    if (current.status === "running") {
      await stopService(app, serviceId);
    }
    await installBuiltinService(app, serviceId);
  }

  const refreshedState = shouldRefreshFromBundledAsset
    ? await getServiceState(app, serviceId)
    : current;
  const initializationState = refreshedState.installed ? readInitializationState(installDir) : null;

  if (refreshedState.status === "initialization-required") {
    return {
      ok: false,
      message: refreshedState.message,
      service: refreshedState
    };
  }

  if (initializationState?.status === "failed" && initializationState.version === service.version) {
    return {
      ok: false,
      message: refreshedState.message,
      service: refreshedState
    };
  }

  if ((!refreshedState.installed || refreshedState.status === "error") && refreshedState.kind === "builtin") {
    await installBuiltinService(app, serviceId);
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
    await ensurePreStartRequirements(app, service);
    result = await runServiceCommand(app, service, service.startCommand, `${service.name} 已启动。`, {
      env: getStartCommandEnvOverrides(service)
    });
    startedThisSession.add(serviceId);
  }

  // Bridge registration hook（无论是否已在运行都走一遍，幂等）
  if (service.kind === "plugin") {
    const { registerBridge } = await import("./bridge-registrar");
    try {
      const regResult = await registerBridge(app, serviceId);
      if (!regResult.ok) {
        result = {
          ...result,
          message: `${result.message} (但桥接注册失败: ${regResult.message})`
        };
      }
    } catch (error) {
      console.warn(`[service-manager] Bridge registration failed for ${serviceId}:`, error);
    }
  }

  const verifiedResult = await attachServiceVerification(app, serviceId, result, "running", `${service.name} 启动命令已执行`);
  if (
    service.id === "agent-platform" &&
    shouldRestartWebclientAfterPlatformStart &&
    verifiedResult.ok &&
    didAgentPlatformRuntimeChange(current, verifiedResult.service)
  ) {
    return restartAgentWebclientAfterPlatformStart(app, verifiedResult);
  }
  return verifiedResult;
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
  const envPath = path.join(installDir, ".env");
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  const stopVerification = ensureManagedServiceStoppedForPlatform(service, installDir, env);
  if (!stopVerification.ok) {
    throw new Error(stopVerification.message);
  }
  startedThisSession.delete(serviceId);

  // Bridge unregistration hook
  if (service.kind === "plugin") {
    const { unregisterBridge } = await import("./bridge-registrar");
    try {
      const unregResult = await unregisterBridge(app, serviceId);
      if (!unregResult.ok) {
        console.warn(`[service-manager] Bridge unregistration failed for ${serviceId}: ${unregResult.message}`);
      }
    } catch (error) {
      console.warn(`[service-manager] Bridge unregistration failed for ${serviceId}:`, error);
    }
  }

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
  if (!fs.existsSync(installDir)) {
    return {
      ok: true,
      path: path.join(installDir, configFile.relativePath),
      content: "",
      exists: false,
      source: "missing"
    };
  }

  const filePath = path.join(installDir, configFile.relativePath);
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
    const templatePath = path.join(installDir, configFile.templateRelativePath);
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
  const previousServicePort =
    key === "env" && service.id === "agent-platform"
      ? readInstalledServicePortForSync(app, service)
      : null;

  const installDir = await ensureMutableInstallDir(app, service);

  const filePath = path.join(installDir, configFile.relativePath);
  ensureDir(path.dirname(filePath));
  const normalizedContent = await normalizeCoreServiceEnvContentForSave(app, service, key, content);
  fs.writeFileSync(filePath, normalizedContent, "utf8");
  await syncCoreServiceDependentEnvAfterSave(app, service, key, previousServicePort);

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

  const targetPath = path.join(installDir, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);

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

  if (!filePath) {
    return {
      ok: true,
      path: "",
      exists: false,
      content: "",
      truncated: false,
      startOffset: 0,
      endOffset: 0,
      hasPrevious: false,
      resetRequired: false,
      totalBytes: 0
    };
  }

  try {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    const requestedLimitBytes =
      typeof options.limitBytes === "number" && Number.isFinite(options.limitBytes)
        ? Math.floor(options.limitBytes)
        : LOG_READ_WINDOW_BYTES;
    const limitBytes = Math.min(
      LOG_READ_WINDOW_BYTES,
      Math.max(1, requestedLimitBytes)
    );
    const requestedBeforeOffset =
      typeof options.beforeOffset === "number" && Number.isFinite(options.beforeOffset)
        ? Math.max(0, Math.floor(options.beforeOffset))
        : undefined;
    const resetRequired = requestedBeforeOffset !== undefined && requestedBeforeOffset > totalBytes;
    const requestedEndOffset =
      requestedBeforeOffset === undefined || resetRequired ? totalBytes : Math.min(requestedBeforeOffset, totalBytes);
    const requestedStartOffset = Math.max(0, requestedEndOffset - limitBytes);
    const bytesToRead = requestedEndOffset - requestedStartOffset;

    if (bytesToRead === 0) {
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: "",
        truncated: requestedStartOffset > 0,
        startOffset: requestedStartOffset,
        endOffset: requestedEndOffset,
        hasPrevious: requestedStartOffset > 0,
        resetRequired,
        totalBytes
      };
    }

    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, requestedStartOffset);
      const actualEndOffset = requestedStartOffset + bytesRead;
      let alignedStartOffset = requestedStartOffset;
      let contentStartIndex = 0;
      let startsOnLineBoundary = requestedStartOffset === 0;

      if (!startsOnLineBoundary && requestedStartOffset > 0) {
        const previousByte = Buffer.alloc(1);
        const previousByteCount = fs.readSync(descriptor, previousByte, 0, 1, requestedStartOffset - 1);
        startsOnLineBoundary = previousByteCount === 1 && previousByte[0] === 0x0a;
      }

      if (!startsOnLineBoundary && requestedStartOffset > 0 && bytesRead > 0) {
        const newlineIndex = buffer.indexOf(0x0a, 0);
        if (newlineIndex !== -1 && newlineIndex + 1 < bytesRead) {
          contentStartIndex = newlineIndex + 1;
          alignedStartOffset += contentStartIndex;
        }
      }

      const hasPrevious = alignedStartOffset > 0;
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: buffer.toString("utf8", contentStartIndex, bytesRead),
        truncated: hasPrevious,
        startOffset: alignedStartOffset,
        endOffset: actualEndOffset,
        hasPrevious,
        resetRequired,
        totalBytes
      };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        exists: false,
        content: "",
        truncated: false,
        startOffset: 0,
        endOffset: 0,
        hasPrevious: false,
        resetRequired: false,
        totalBytes: 0
      };
    }
    throw error;
  }
}

function readLogRange(filePath: string, startOffset: number, endOffset: number) {
  const bytesToRead = Math.max(0, endOffset - startOffset);
  if (bytesToRead === 0) {
    return "";
  }

  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, startOffset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeLogStreamPollInterval(options: ServiceLogStreamOptions) {
  if (typeof options.pollIntervalMs !== "number" || !Number.isFinite(options.pollIntervalMs)) {
    return LOG_STREAM_POLL_INTERVAL_MS;
  }
  return Math.max(250, Math.floor(options.pollIntervalMs));
}

function normalizeLogStreamOffset(options: ServiceLogStreamOptions) {
  if (typeof options.fromOffset !== "number" || !Number.isFinite(options.fromOffset)) {
    return 0;
  }
  return Math.max(0, Math.floor(options.fromOffset));
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
        failures.push(`${serviceId}: ${result.message}`);
        options.onProgress?.(serviceId, "failed", result.message);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${serviceId}: ${message}`);
      options.onProgress?.(serviceId, "failed", message);
      break;
    }
  }

  return {
    restored,
    failures
  };
}

function shouldEnableBuiltinBootstrap(app: App) {
  return app.isPackaged || process.env.ZENMIND_DESKTOP_AUTO_PROVISION_BUILTINS === "1";
}

async function shouldRunBuiltinBootstrap(app: App) {
  if (!shouldEnableBuiltinBootstrap(app)) {
    return false;
  }

  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    const current = await getServiceState(app, serviceId);
    if (
      current.status === "not-installed" ||
      current.status === "initialization-required" ||
      current.status === "error"
    ) {
      return true;
    }

    const service = getService(serviceId);
    if (service.kind === "builtin" && needsBundledAssetRefresh(app, service)) {
      return true;
    }
  }

  return false;
}

export async function runStartupPreparation(
  app: App,
  options: {
    onModeResolved?: (mode: StartupRestoreMode) => void;
    onStarting?: (serviceId: ServiceId) => void;
    onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
  } = {}
): Promise<StartupPreparationResult> {
  if (!(await shouldRunBuiltinBootstrap(app))) {
    options.onModeResolved?.("restore");
    const restoreResult = await restoreRunningServices(app, {
      onStarting: options.onStarting,
      onProgress: options.onProgress
    });
    return {
      mode: "restore",
      started: restoreResult.restored,
      failures: restoreResult.failures
    };
  }

  options.onModeResolved?.("bootstrap");
  const started: ServiceId[] = [];
  const failures: string[] = [];

  for (const serviceId of DEFAULT_STARTUP_SERVICE_IDS) {
    try {
      const service = getService(serviceId);
      let current = await getServiceState(app, serviceId);
      const bundledAssetNeedsRefresh = service.kind === "builtin" && needsBundledAssetRefresh(app, service);

      if (
        current.status === "not-installed" ||
        current.status === "error" ||
        bundledAssetNeedsRefresh
      ) {
        options.onProgress?.(serviceId, "installing", `${current.name} 安装中...`);
        if (bundledAssetNeedsRefresh && current.status === "running") {
          await stopService(app, serviceId);
        }
        await installBuiltinService(app, serviceId);
        current = await getServiceState(app, serviceId);
      } else if (current.status === "initialization-required") {
        options.onProgress?.(serviceId, "initializing", `${current.name} 初始化中...`);
        const initialization = await initializeService(app, serviceId);
        if (!initialization.ok) {
          failures.push(`${serviceId}: ${initialization.message}`);
          options.onProgress?.(serviceId, "failed", initialization.message);
          continue;
        }
        current = initialization.service;
      }

      options.onStarting?.(serviceId);
      options.onProgress?.(serviceId, "starting", `${current.name} 启动中...`);
      const startedAt = Date.now();
      const result = await startService(app, serviceId);
      const elapsedMs = Date.now() - startedAt;
      if (result.ok && result.service.status === "running") {
        console.info(`[service-manager] bootstrapped ${serviceId} in ${elapsedMs}ms`);
        started.push(serviceId);
        options.onProgress?.(serviceId, "succeeded", result.message);
        continue;
      }

      const failureMessage = result.ok
        ? `${result.service.name} 启动后未进入运行中状态。`
        : result.message;
      console.warn(`[service-manager] failed to bootstrap ${serviceId} after ${elapsedMs}ms: ${failureMessage}`);
      failures.push(`${serviceId}: ${failureMessage}`);
      options.onProgress?.(serviceId, "failed", failureMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${serviceId}: ${message}`);
      options.onProgress?.(serviceId, "failed", message);
    }
  }

  return {
    mode: "bootstrap",
    started,
    failures
  };
}

export const __testInternals = {
  LOG_READ_WINDOW_BYTES,
  parseEnvFileContent,
  parsePort,
  getWebUrl,
  containerEngineAvailable,
  fixShellScriptPermissions,
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  upsertEnvFileContent,
  ensurePreStartRequirements,
  agentWebclientInstallNeedsRefresh,
  zenmindAppServerInstallNeedsRefresh,
  resolveNodeBin,
  resolveAcpCommandForDesktop,
  normalizeAgentPlatformEnvContentForRuntime,
  normalizeAgentPlatformEnvContentForSave,
  applyAgentPlatformWindowsHostShellDefaults,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromPowerShell,
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
  readLogRange,
  getLastRunningServicesStatePath,
  getDefaultStartupServiceIds,
  getServiceIdsToRestore,
  orderServiceIdsForRestore,
  needsBundledAssetRefresh,
  shouldEnableBuiltinBootstrap,
  shouldRunBuiltinBootstrap,
  readLastRunningServices,
  watchServiceLog,
  writeLastRunningServices
};
