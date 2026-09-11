import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import type { App } from "electron";
import type { ServiceId } from "../../../../shared/contracts";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { getAllServices } from "../service-registry";
import {
  getInstallDir,
  getServiceLayout,
  type ServiceLayout
} from "./layout";
import {
  buildServiceEnv
} from "./command-env";
import {
  IS_WINDOWS,
  windowsPowerShellPath
} from "./command-runner";
import {
  isProcessRunning,
  listProcessTreePids,
  terminateProcess,
  terminateProcessList,
  terminateProcessTree
} from "./process-cleanup";
import {
  buildProcessTreePids,
  type ProcessTreeRow
} from "./process-tree";
import {
  matchProcessInstallDir,
  pidMatchesInstallDir
} from "./process-identity";
import {
  parsePort
} from "./service-network";
import {
  getManagedPidFilePaths,
  readPid,
  removePidFile,
  resolveRuntimePath,
  uniqueNonEmptyPaths
} from "./pid-files";

export type ManagedRootPid = {
  pid: number;
  serviceId: ServiceId;
  installDir?: string;
  pidFilePaths: string[];
};

export type ManagedProcessCleanupTarget = ManagedRootPid & {
  treePids: number[];
};

export type ManagedProcessCleanupTargets = {
  roots: ManagedRootPid[];
  stalePidFilePaths: string[];
};

export type ManagedServiceStopState = {
  mainPidFilePath: string;
  managedMainPid: number | null;
  port: number;
  managedPortPids: number[];
};

export type ForceCleanupManagedProcessesOptions = {
  platform?: NodeJS.Platform | string;
  collectManagedProcessCleanupTargetsImpl?: (app: App) => ManagedProcessCleanupTargets;
  terminateProcessTreeImpl?: typeof terminateProcessTree;
  terminateProcessListImpl?: typeof terminateProcessList;
  terminateCapturedProcessTreeImpl?: (
    rootPid: number,
    capturedPids: number[]
  ) => Promise<boolean>;
  listProcessTreePidsImpl?: typeof listProcessTreePids;
  isProcessRunningImpl?: (pid: number | null) => boolean;
  pidMatchesInstallDirImpl?: typeof pidMatchesInstallDir;
  removePidFileImpl?: typeof removePidFile;
  consoleError?: (message: string) => void;
  maxConcurrency?: number;
};

export type ForceCleanupManagedProcessesResult = {
  ok: boolean;
  failures: Array<{
    serviceId: ServiceId;
    rootPid: number;
    pids: number[];
  }>;
  survivors: number[];
};

export function listListeningPids(port: number) {
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

export function detectManagedServicePid(installDir: string, port: number) {
  for (const pid of listListeningPids(port)) {
    if (pidMatchesInstallDir(pid, installDir)) {
      return pid;
    }
  }
  return null;
}

function addManagedRootPid(
  roots: Map<number, ManagedRootPid>,
  serviceId: ServiceId,
  pid: number | null,
  installDir: string,
  pidFilePath = "",
  options: { skipInstallDirCheck?: boolean } = {}
) {
  if (!pid || (!options.skipInstallDirCheck && !pidMatchesInstallDir(pid, installDir))) {
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

export function collectManagedProcessCleanupTargets(app: App): ManagedProcessCleanupTargets {
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
      if (!isProcessRunning(pid)) {
        stalePidFilePaths.add(pidFilePath);
        continue;
      }
      const match = matchProcessInstallDir(pid, installDir);
      if (match === "mismatched") {
        stalePidFilePaths.add(pidFilePath);
        continue;
      }
      if (match === "unknown") {
        continue;
      }
      addManagedRootPid(roots, service.id, pid, installDir, pidFilePath, { skipInstallDirCheck: true });
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

export function collectManagedRootPids(app: App) {
  return collectManagedProcessCleanupTargets(app).roots;
}

export function captureManagedProcessCleanupSnapshot(app: App) {
  return collectManagedRootPids(app).map((root): ManagedProcessCleanupTarget => ({
    ...root,
    treePids: listProcessTreePids(root.pid)
  }));
}

type ManagedProcessInventoryRow = ProcessTreeRow & {
  identity: string;
};

function runInventoryCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "process inventory failed").trim()));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

function parseWindowsManagedProcessInventory(stdout: string): ManagedProcessInventoryRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.flatMap((entry) => {
    const value = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const pid = Number(value.ProcessId);
    const ppid = Number(value.ParentProcessId);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid) || ppid < 0) {
      return [];
    }
    return [{
      pid,
      ppid,
      identity: [value.ExecutablePath, value.CommandLine]
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    }];
  });
}

function parsePosixManagedProcessInventory(stdout: string): ManagedProcessInventoryRow[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) {
      return [];
    }
    return [{
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      identity: match[3]
    }];
  });
}

function inventoryIdentityMatchesInstallDir(
  identity: string,
  installDir: string,
  platform: NodeJS.Platform | string
) {
  const normalizedIdentity = identity.replace(/\\/gu, "/");
  const normalizedInstallDir = path.normalize(installDir).replace(/\\/gu, "/");
  return platform === "win32"
    ? normalizedIdentity.toLowerCase().includes(normalizedInstallDir.toLowerCase())
    : normalizedIdentity.includes(normalizedInstallDir);
}

export async function captureManagedProcessCleanupSnapshotAsync(
  app: App,
  platform: NodeJS.Platform | string = process.platform
) {
  const inventory = platform === "win32"
    ? parseWindowsManagedProcessInventory(await runInventoryCommand(
        windowsPowerShellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | " +
            "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
        ],
        3500
      ))
    : parsePosixManagedProcessInventory(await runInventoryCommand(
        "ps",
        ["-axo", "pid=,ppid=,command="],
        3000
      ));
  const rows: ProcessTreeRow[] = inventory.map(({ pid, ppid }) => ({ pid, ppid }));
  const targets: ManagedProcessCleanupTarget[] = [];

  for (const service of getAllServices()) {
    const installDir = getInstallDir(app, service);
    if (!fs.existsSync(installDir)) {
      continue;
    }
    const matchedRows = inventory.filter((row) =>
      inventoryIdentityMatchesInstallDir(row.identity, installDir, platform)
    );
    const matchedPids = new Set(matchedRows.map((row) => row.pid));
    for (const root of matchedRows.filter((row) => !matchedPids.has(row.ppid))) {
      const layout = getServiceLayout(app, service);
      const pidFilePaths = getManagedPidFilePaths(service, layout)
        .filter((pidFilePath) => readPid(pidFilePath) === root.pid);
      targets.push({
        pid: root.pid,
        serviceId: service.id,
        installDir,
        pidFilePaths,
        treePids: buildProcessTreePids(root.pid, rows)
      });
    }
  }

  return targets;
}

export function mergeCleanupTargets(targets: ManagedProcessCleanupTarget[], roots: ManagedRootPid[]) {
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

async function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  task: (item: T) => Promise<R>
) {
  if (items.length === 0) {
    return [] as R[];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(maxConcurrency))
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index]);
      }
    })
  );
  return results;
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
  const terminateCapturedProcessTreeImpl = options.terminateCapturedProcessTreeImpl;
  const listProcessTreePidsImpl = options.listProcessTreePidsImpl ?? listProcessTreePids;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const pidMatchesInstallDirImpl = options.pidMatchesInstallDirImpl ?? pidMatchesInstallDir;
  const removePidFileImpl = options.removePidFileImpl ?? removePidFile;
  const consoleError = options.consoleError ?? console.error;
  const platform = options.platform ?? process.platform;
  const maxConcurrency = options.maxConcurrency ?? 8;
  const collected = collectManagedProcessCleanupTargetsImpl(app);
  const roots = mergeCleanupTargets(snapshot, collected.roots);
  const failureMessages: string[] = [];
  const cleanupFailures: ForceCleanupManagedProcessesResult["failures"] = [];
  const survivors = new Set<number>();

  for (const stalePidFilePath of collected.stalePidFilePaths) {
    removePidFileImpl(stalePidFilePath);
  }

  const rootResults = await mapWithConcurrency(roots, maxConcurrency, async (root) => {
    const treePids = buildCleanupTreePids(root, listProcessTreePidsImpl);
    let terminated = false;
    try {
      terminated = terminateCapturedProcessTreeImpl
        ? await terminateCapturedProcessTreeImpl(root.pid, treePids)
        : platform === "win32"
          ? terminateProcessTreeImpl(root.pid, {
            platform,
            isProcessRunningImpl,
            listProcessTreePidsImpl,
            terminateProcessListImpl
          })
          : terminateProcessListImpl(treePids);
    } catch (error) {
      consoleError(
        `failed to terminate managed process tree for ${root.serviceId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (terminated || shouldRemoveManagedPidFile(root, isProcessRunningImpl, pidMatchesInstallDirImpl)) {
      for (const pidFilePath of root.pidFilePaths) {
        removePidFileImpl(pidFilePath);
      }
    }

    const remainingPids = treePids.filter((pid) => isProcessRunningImpl(pid));
    return { root, remainingPids };
  });

  for (const { root, remainingPids } of rootResults) {
    if (remainingPids.length > 0) {
      remainingPids.forEach((pid) => survivors.add(pid));
      cleanupFailures.push({
        serviceId: root.serviceId,
        rootPid: root.pid,
        pids: remainingPids
      });
      failureMessages.push(`${root.serviceId}: PID ${remainingPids.join(", ")}`);
    }
  }

  if (failureMessages.length > 0) {
    consoleError(`failed to force-clean managed service processes: ${failureMessages.join("; ")}`);
  }

  return {
    ok: cleanupFailures.length === 0,
    failures: cleanupFailures,
    survivors: [...survivors].sort((left, right) => left - right)
  };
}

export function collectManagedServiceStopState(
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
  _service: ServiceDefinition,
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

export function forceStopServiceInstallDir(
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

export function ensureManagedServiceStoppedForPlatform(
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
