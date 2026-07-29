import { execFile, spawnSync } from "node:child_process";
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

function execFileAsync(
  command: string,
  args: string[],
  options: {
    timeout: number;
  }
) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: buildServiceEnv(),
      timeout: options.timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const status = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === "number"
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error
          ? 1
          : 0;
      resolve({
        status,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      });
    });
  });
}

async function readProcessTreeRowsAsync(platform: NodeJS.Platform | string = process.platform) {
  if (platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress"
    ].join("; ");
    const result = await execFileAsync(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 3000 }
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "Windows process snapshot failed.");
    }
    return parseProcessTreeRowsFromWindowsPowerShell(result.stdout);
  }

  const result = await execFileAsync("ps", ["-axo", "pid=,ppid="], { timeout: 3000 });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Process snapshot failed.");
  }
  return parseProcessTreeRowsFromPs(result.stdout);
}

export async function listProcessTreePidsAsync(
  rootPid: number,
  platform: NodeJS.Platform | string = process.platform
) {
  return buildProcessTreePids(rootPid, await readProcessTreeRowsAsync(platform));
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

  const capturedTreePids = listProcessTreePidsImpl(rootPid);
  const treePids = capturedTreePids.length > 0 ? capturedTreePids : [rootPid];

  if (platform === "win32") {
    try {
      const result = spawnSyncImpl("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
        encoding: "utf8",
        env: buildServiceEnv(),
        timeout: 5000
      });
      if (treePids.every((pid) => !isProcessRunningImpl(pid))) {
        return true;
      }
      if (result.status === 0) {
        return terminateProcessListImpl(treePids.filter((pid) => isProcessRunningImpl(pid)));
      }
    } catch {
      // Fall back to process table traversal below.
    }
  }

  return terminateProcessListImpl(treePids);
}

async function waitForProcessesExitAsync(
  pids: number[],
  timeoutMs: number,
  isProcessRunningImpl: (pid: number | null) => boolean
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessRunningImpl(pid))) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return pids.every((pid) => !isProcessRunningImpl(pid));
}

export async function requestWindowsProcessTreeExitAsync(
  rootPid: number,
  capturedPids: number[],
  options: {
    platform?: NodeJS.Platform | string;
    isProcessRunningImpl?: (pid: number | null) => boolean;
    runCommandImpl?: typeof execFileAsync;
    timeoutMs?: number;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const runCommandImpl = options.runCommandImpl ?? execFileAsync;
  const pids = [...new Set([...capturedPids, rootPid])]
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  if (pids.every((pid) => !isProcessRunningImpl(pid))) {
    return true;
  }

  await runCommandImpl(
    "taskkill.exe",
    ["/PID", String(rootPid), "/T"],
    { timeout: 1_000 }
  );
  return waitForProcessesExitAsync(
    pids,
    options.timeoutMs ?? 1_000,
    isProcessRunningImpl
  );
}

export async function terminateCapturedProcessTreeAsync(
  rootPid: number,
  capturedPids: number[],
  options: {
    platform?: NodeJS.Platform | string;
    isProcessRunningImpl?: (pid: number | null) => boolean;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  const isProcessRunningImpl = options.isProcessRunningImpl ?? isProcessRunning;
  const pids = [...new Set([...capturedPids, rootPid])]
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  if (pids.every((pid) => !isProcessRunningImpl(pid))) {
    return true;
  }

  if (platform === "win32") {
    await execFileAsync(
      "taskkill.exe",
      ["/PID", String(rootPid), "/T", "/F"],
      { timeout: 2000 }
    );
    if (await waitForProcessesExitAsync(pids, 800, isProcessRunningImpl)) {
      return true;
    }
    const remaining = pids.filter((pid) => isProcessRunningImpl(pid));
    await Promise.all(
      remaining.map((pid) =>
        execFileAsync("taskkill.exe", ["/PID", String(pid), "/F"], { timeout: 1000 })
      )
    );
    return waitForProcessesExitAsync(pids, 700, isProcessRunningImpl);
  }

  signalProcessList(pids, "SIGTERM");
  if (await waitForProcessesExitAsync(pids, 2000, isProcessRunningImpl)) {
    return true;
  }
  signalProcessList(pids, "SIGKILL");
  return waitForProcessesExitAsync(pids, 1000, isProcessRunningImpl);
}
