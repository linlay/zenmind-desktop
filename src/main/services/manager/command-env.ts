import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

export function buildServiceEnv(): NodeJS.ProcessEnv {
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

export function resolveNodeBin() {
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
