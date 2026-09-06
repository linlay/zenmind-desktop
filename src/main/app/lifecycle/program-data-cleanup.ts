import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { App } from "electron";
import { getPluginsRoot, getProgramsRoot } from "../../infrastructure/filesystem/user-paths";
import { buildServiceEnv } from "../../modules/services";
import { terminateProcessTree } from "../../modules/services";
import { windowsPowerShellPath } from "../../modules/services";

export const PROGRAM_DATA_VERSION_FILE = "VERSION";

type ProcessInfo = {
  pid: number;
  identity: string;
};

type CleanupFailure = {
  path: string;
  message: string;
};

type CleanupOptions = {
  platform?: NodeJS.Platform;
  spawnSyncImpl?: typeof spawnSync;
  terminateProcessTreeImpl?: typeof terminateProcessTree;
  listProcessesImpl?: (platform: NodeJS.Platform, spawnSyncImpl: typeof spawnSync) => ProcessInfo[];
};

export type ProgramDataVersionCleanupResult = {
  programRoot: string;
  pluginsRoot: string;
  versionPath: string;
  currentVersion: string;
  previousVersion: string;
  cleaned: boolean;
  skipped: boolean;
  removedPaths: string[];
  failedPaths: CleanupFailure[];
  stoppedPids: number[];
};

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function namesEqual(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function normalizeProgramDataVersion(value: unknown) {
  const version = String(value ?? "").trim().replace(/^v/iu, "");
  return version ? `v${version}` : "";
}

function readProgramDataVersion(versionPath: string) {
  try {
    return normalizeProgramDataVersion(fs.readFileSync(versionPath, "utf8"));
  } catch {
    return "";
  }
}

function isPreservedProgramDataEntry(entry: fs.Dirent, platform: NodeJS.Platform) {
  if (namesEqual(entry.name, "plugins", platform)) {
    return true;
  }
  if (namesEqual(entry.name, PROGRAM_DATA_VERSION_FILE, platform) && !entry.isDirectory()) {
    return true;
  }
  return false;
}

export function listProgramDataRemovalTargets(
  programRoot: string,
  platform: NodeJS.Platform = process.platform
) {
  if (!fs.existsSync(programRoot)) {
    return [];
  }

  return fs
    .readdirSync(programRoot, { withFileTypes: true })
    .filter((entry) => !isPreservedProgramDataEntry(entry, platform))
    .map((entry) => path.join(programRoot, entry.name));
}

function parsePosixProcesses(output: string): ProcessInfo[] {
  return output
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+([\s\S]*)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        identity: match[2].trim()
      };
    })
    .filter((item): item is ProcessInfo => Boolean(item && item.pid > 0 && item.identity));
}

function parseWindowsProcesses(output: string): ProcessInfo[] {
  if (!output.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records
      .map((record) => {
        if (!record || typeof record !== "object") {
          return null;
        }
        const item = record as Record<string, unknown>;
        const pid = typeof item.ProcessId === "number"
          ? item.ProcessId
          : Number.parseInt(String(item.ProcessId ?? ""), 10);
        const identity = [
          typeof item.ExecutablePath === "string" ? item.ExecutablePath : "",
          typeof item.CommandLine === "string" ? item.CommandLine : ""
        ].filter(Boolean).join("\n");
        return { pid, identity };
      })
      .filter((item): item is ProcessInfo => Boolean(item && item.pid > 0 && item.identity));
  } catch {
    return [];
  }
}

function listProcesses(platform: NodeJS.Platform, spawnSyncImpl: typeof spawnSync): ProcessInfo[] {
  try {
    if (platform === "win32") {
      const command = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"
      ].join("; ");
      const result = spawnSyncImpl(windowsPowerShellPath(), ["-NoProfile", "-Command", command], {
        encoding: "utf8",
        env: buildServiceEnv(),
        timeout: 5000
      });
      if (result.status !== 0 || result.error) {
        return [];
      }
      return parseWindowsProcesses(result.stdout);
    }

    const result = spawnSyncImpl("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: 3000
    });
    if (result.status !== 0 || result.error) {
      return [];
    }
    return parsePosixProcesses(result.stdout);
  } catch {
    return [];
  }
}

function normalizeComparablePath(value: string, platform: NodeJS.Platform) {
  const pathApi = pathApiForPlatform(platform);
  const normalized = pathApi.normalize(value).replace(/\\/gu, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathBoundary(value: string, index: number) {
  if (index < 0 || index >= value.length) {
    return true;
  }
  return /[\s"'/:]/u.test(value[index]);
}

function processIdentityMatchesRoot(identity: string, root: string, platform: NodeJS.Platform) {
  const normalizedIdentity = normalizeComparablePath(identity, platform);
  const normalizedRoot = normalizeComparablePath(root, platform).replace(/\/$/u, "");
  let index = normalizedIdentity.indexOf(normalizedRoot);
  while (index !== -1) {
    const afterIndex = index + normalizedRoot.length;
    if (isPathBoundary(normalizedIdentity, afterIndex)) {
      return true;
    }
    index = normalizedIdentity.indexOf(normalizedRoot, index + 1);
  }
  return false;
}

function stopProcessesUnderRoots(
  roots: string[],
  options: Required<Pick<CleanupOptions, "platform" | "spawnSyncImpl" | "terminateProcessTreeImpl" | "listProcessesImpl">>
) {
  const pids = options
    .listProcessesImpl(options.platform, options.spawnSyncImpl)
    .filter((processInfo) =>
      processInfo.pid !== process.pid &&
      roots.some((root) => processIdentityMatchesRoot(processInfo.identity, root, options.platform))
    )
    .map((processInfo) => processInfo.pid);

  const stoppedPids: number[] = [];
  for (const pid of [...new Set(pids)]) {
    options.terminateProcessTreeImpl(pid, { platform: options.platform });
    stoppedPids.push(pid);
  }
  return stoppedPids;
}

function removeProgramDataTargets(targets: string[]) {
  const removedPaths: string[] = [];
  const failedPaths: CleanupFailure[] = [];

  for (const targetPath of targets) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removedPaths.push(targetPath);
    } catch (error) {
      failedPaths.push({
        path: targetPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { removedPaths, failedPaths };
}

export function cleanupProgramDataForVersion(
  app: App,
  currentVersion: string,
  options: CleanupOptions = {}
): ProgramDataVersionCleanupResult {
  const platform = options.platform ?? process.platform;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const terminateProcessTreeImpl = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const listProcessesImpl = options.listProcessesImpl ?? listProcesses;
  const programRoot = getProgramsRoot(app);
  const pluginsRoot = getPluginsRoot(app);
  const versionPath = path.join(programRoot, PROGRAM_DATA_VERSION_FILE);
  const normalizedCurrentVersion = normalizeProgramDataVersion(currentVersion);
  const previousVersion = readProgramDataVersion(versionPath);

  fs.mkdirSync(pluginsRoot, { recursive: true });

  const baseResult = {
    programRoot,
    pluginsRoot,
    versionPath,
    currentVersion: normalizedCurrentVersion,
    previousVersion,
    removedPaths: [] as string[],
    failedPaths: [] as CleanupFailure[],
    stoppedPids: [] as number[]
  };

  if (!normalizedCurrentVersion) {
    return {
      ...baseResult,
      cleaned: false,
      skipped: true,
      failedPaths: [{ path: versionPath, message: "current version is empty" }]
    };
  }

  if (previousVersion === normalizedCurrentVersion) {
    return {
      ...baseResult,
      cleaned: false,
      skipped: true
    };
  }

  const removalTargets = listProgramDataRemovalTargets(programRoot, platform);
  const stoppedPids = removalTargets.length > 0
    ? stopProcessesUnderRoots(removalTargets, {
      platform,
      spawnSyncImpl,
      terminateProcessTreeImpl,
      listProcessesImpl
    })
    : [];
  const { removedPaths, failedPaths } = removeProgramDataTargets(removalTargets);

  if (failedPaths.length === 0) {
    try {
      fs.writeFileSync(versionPath, `${normalizedCurrentVersion}\n`, "utf8");
    } catch (error) {
      failedPaths.push({
        path: versionPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ...baseResult,
    cleaned: failedPaths.length === 0,
    skipped: false,
    removedPaths,
    failedPaths,
    stoppedPids
  };
}

export const __testInternals = {
  listProgramDataRemovalTargets,
  normalizeProgramDataVersion,
  parsePosixProcesses,
  parseWindowsProcesses
};
