import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type ShellPathProbeResult = {
  entries: string[];
  succeeded: boolean;
};

type ShellPathSpawnSyncResult = {
  status: number | null;
  error?: Error;
  stdout: string;
};

type ShellPathSpawnSync = (
  command: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    env: NodeJS.ProcessEnv;
    timeout: number;
  }
) => ShellPathSpawnSyncResult;

let shellPathEntriesCache: ShellPathProbeResult | null = null;
const LEGACY_LAYOUT_ENV_KEYS = ["CONFIG", "DATA", "STATE", "LOG"].map((name) => `SERVICE_${name}_DIR`);
const LEGACY_LAYOUT_ENV_KEY_SET = new Set(LEGACY_LAYOUT_ENV_KEYS);
const HOST_INHERITED_ENV_KEYS = ["__CFBundleIdentifier", "PWD"] as const;
const SHELL_PATH_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_SHELL_PROBE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_PATH_BEGIN_MARKER = "__ZENMIND_PATH_BEGIN__";
const SHELL_PATH_END_MARKER = "__ZENMIND_PATH_END__";
const RAW_PATH_PRINT_COMMAND = "printf '%s' \"$PATH\"";

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
    const configuredNodeBin = process.env.DESKTOP_NODE_BIN;
    const nodeBinDir = configuredNodeBin
      ? path.dirname(configuredNodeBin)
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

function splitPathEntries(value: string) {
  return value.split(path.delimiter).filter(Boolean);
}

function getMarkedPathPrintCommand() {
  return `printf '%s%s%s' '${SHELL_PATH_BEGIN_MARKER}' "$PATH" '${SHELL_PATH_END_MARKER}'`;
}

function extractMarkedShellPath(output: string) {
  const beginIndex = output.indexOf(SHELL_PATH_BEGIN_MARKER);
  if (beginIndex < 0) {
    return null;
  }
  const valueStart = beginIndex + SHELL_PATH_BEGIN_MARKER.length;
  const endIndex = output.indexOf(SHELL_PATH_END_MARKER, valueStart);
  if (endIndex < 0) {
    return null;
  }
  return output.slice(valueStart, endIndex);
}

function resolveProbeShellPath(env: NodeJS.ProcessEnv, existsSyncImpl: (candidatePath: string) => boolean) {
  return env.SHELL
    || (existsSyncImpl("/bin/zsh") ? "/bin/zsh" : "")
    || (existsSyncImpl("/bin/bash") ? "/bin/bash" : "");
}

function isZshShell(shellPath: string) {
  return path.basename(shellPath).toLowerCase() === "zsh";
}

function runShellPathProbe(
  shellPath: string,
  args: string[],
  parseStdout: (stdout: string) => string | null,
  env: NodeJS.ProcessEnv,
  spawnSyncImpl: ShellPathSpawnSync
) {
  try {
    const result = spawnSyncImpl(shellPath, args, {
      encoding: "utf8",
      env: {
        ...env,
        PATH: env.PATH ?? DEFAULT_SHELL_PROBE_PATH
      },
      timeout: SHELL_PATH_PROBE_TIMEOUT_MS
    });
    if (result.status !== 0 || result.error) {
      return null;
    }
    const shellPathValue = parseStdout(result.stdout);
    if (!shellPathValue) {
      return null;
    }
    const entries = splitPathEntries(shellPathValue);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

function probeShellPathEntries(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSyncImpl?: (candidatePath: string) => boolean;
  spawnSyncImpl?: ShellPathSpawnSync;
} = {}): ShellPathProbeResult {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { entries: [], succeeded: false };
  }

  const env = options.env ?? process.env;
  const existsSyncImpl = options.existsSyncImpl ?? fs.existsSync;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const shellPath = resolveProbeShellPath(env, existsSyncImpl);
  if (!shellPath) {
    return { entries: [], succeeded: false };
  }

  if (isZshShell(shellPath)) {
    const interactiveEntries = runShellPathProbe(
      shellPath,
      ["-ilc", getMarkedPathPrintCommand()],
      extractMarkedShellPath,
      env,
      spawnSyncImpl
    );
    if (interactiveEntries) {
      return { entries: interactiveEntries, succeeded: true };
    }
  }

  const loginEntries = runShellPathProbe(
    shellPath,
    ["-lc", RAW_PATH_PRINT_COMMAND],
    (stdout) => stdout,
    env,
    spawnSyncImpl
  );
  if (loginEntries) {
    return { entries: loginEntries, succeeded: true };
  }

  return { entries: [], succeeded: false };
}

function getShellPathEntries() {
  if (shellPathEntriesCache) {
    return shellPathEntriesCache;
  }

  shellPathEntriesCache = probeShellPathEntries();
  return shellPathEntriesCache;
}

function mergeServicePathEntries(
  inheritedPaths: string[],
  staticPaths: string[],
  shellPathResult: ShellPathProbeResult
) {
  const pathEntries = shellPathResult.succeeded
    ? [...shellPathResult.entries, ...staticPaths, ...inheritedPaths]
    : [...inheritedPaths, ...staticPaths];
  return [...new Set(pathEntries)];
}

export function buildServiceEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of HOST_INHERITED_ENV_KEYS) {
    delete env[key];
  }
  for (const key of LEGACY_LAYOUT_ENV_KEYS) {
    delete env[key];
  }
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (LEGACY_LAYOUT_ENV_KEY_SET.has(key.toUpperCase())) {
        delete env[key];
      }
    }
  }
  const staticPaths = getStaticServicePaths();
  const shellPathResult = getShellPathEntries();
  const current = splitPathEntries(env.PATH ?? env.Path ?? "");
  const merged = mergeServicePathEntries(current, staticPaths, shellPathResult);
  if (merged.length === 0) {
    return env;
  }
  env.PATH = merged.join(path.delimiter);
  if (process.platform === "win32") {
    env.Path = env.PATH;
  }
  return env;
}

export function resolveNodeBin() {
  const explicit = process.env.DESKTOP_NODE_BIN?.trim();
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

export function resolveCommandBin(command: string) {
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

export function isCommandBasenameMatch(command: string, expected: string) {
  return path.basename(command).toLowerCase() === expected.toLowerCase();
}

export const __testInternals = {
  SHELL_PATH_BEGIN_MARKER,
  SHELL_PATH_END_MARKER,
  extractMarkedShellPath,
  mergeServicePathEntries,
  probeShellPathEntries,
  resetShellPathEntriesCache() {
    shellPathEntriesCache = null;
  },
  setShellPathEntriesCacheForTests(result: ShellPathProbeResult) {
    shellPathEntriesCache = result;
  },
  splitPathEntries
};
