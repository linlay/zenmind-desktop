import fs from "node:fs";
import path from "node:path";
import { type App } from "electron";
import { type ChildProcess } from "node:child_process";
import { getLogPath } from "./runtime-state";
import {
  terminateProcessTree,
  listProcessTreePidsAsync,
  requestWindowsProcessTreeExitAsync,
  terminateCapturedProcessTreeAsync,
  isProcessRunning,
  delay
} from "../../services";

export function writeLogLine(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line.endsWith("\n") ? line : `${line}\n`}`, "utf8");
}

export function pipeChildLogs(app: App, webappId: string, child: ChildProcess) {
  const mainLogPath = getLogPath(app, webappId, "main");
  const errorLogPath = getLogPath(app, webappId, "error");
  fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => fs.appendFileSync(mainLogPath, chunk));
  child.stderr?.on("data", (chunk: Buffer) => fs.appendFileSync(errorLogPath, chunk));
}

export function terminateRuntimeProcessTree(pid: number) {
  const terminated = terminateProcessTree(pid);
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      const forceTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The detached process group has already exited.
        }
      }, 1_000);
      forceTimer.unref();
    } catch {
      // The process group has already exited or was created by an older runtime.
    }
  }
  return terminated;
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function terminateRuntimeChild(child: ChildProcess, shutdownTimeoutMs = 3_000) {
  const pid = child.pid;
  if (!pid) {
    return true;
  }
  const treePids = await listProcessTreePidsAsync(pid).catch(() => [pid]);
  const capturedPids = treePids.length > 0 ? treePids : [pid];
  if (process.platform === "win32") {
    const exitedGracefully = await requestWindowsProcessTreeExitAsync(
      pid,
      capturedPids
    );
    if (exitedGracefully) {
      return true;
    }
    const terminated = await terminateCapturedProcessTreeAsync(pid, capturedPids);
    return terminated && capturedPids.every((candidatePid) => !isProcessRunning(candidatePid));
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return terminateCapturedProcessTreeAsync(pid, capturedPids);
  }
  await waitForChildExit(child, shutdownTimeoutMs);
  const gracefulDeadline = Date.now() + shutdownTimeoutMs;
  while (Date.now() < gracefulDeadline && capturedPids.some((candidatePid) => isProcessRunning(candidatePid))) {
    await delay(100);
  }
  if (capturedPids.every((candidatePid) => !isProcessRunning(candidatePid))) {
    return true;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The detached process group has exited.
  }
  await waitForChildExit(child, 500);
  const forceDeadline = Date.now() + 500;
  while (Date.now() < forceDeadline && capturedPids.some((candidatePid) => isProcessRunning(candidatePid))) {
    await delay(100);
  }
  return capturedPids.every((candidatePid) => !isProcessRunning(candidatePid));
}
