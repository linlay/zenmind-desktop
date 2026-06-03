import { spawnSync } from "node:child_process";
import {
  buildServiceEnv
} from "./command-env";
import {
  IS_WINDOWS,
  windowsPowerShellPath
} from "./command-runner";
import {
  buildProcessTreePids,
  parseProcessTreeRowsFromPs,
  parseProcessTreeRowsFromWindowsPowerShell
} from "./process-tree";

export type TerminateProcessTreeOptions = {
  platform?: NodeJS.Platform | string;
  isProcessRunningImpl?: (pid: number | null) => boolean;
  spawnSyncImpl?: typeof spawnSync;
  listProcessTreePidsImpl?: typeof listProcessTreePids;
  terminateProcessListImpl?: typeof terminateProcessList;
};

export function isProcessRunning(pid: number | null) {
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

export function listProcessTreePids(rootPid: number) {
  return buildProcessTreePids(rootPid, readProcessTreeRows());
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

export function terminateProcess(pid: number) {
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

export function terminateProcessList(pids: number[]) {
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

export function terminateProcessTree(rootPid: number, options: TerminateProcessTreeOptions = {}) {
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
