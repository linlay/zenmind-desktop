import { spawn } from "node:child_process";
import process from "node:process";

const WINDOWS_TASKKILL_TIMEOUT_MS = 4_000;
const WINDOWS_CHILD_EXIT_TIMEOUT_MS = 4_000;

function childHasExited(child) {
  return child?.exitCode != null || child?.signalCode != null;
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (exited) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);

    child.once?.("exit", onExit);
    child.once?.("close", onExit);
    timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
  });
}

function waitForCommandExit(child, timeoutMs) {
  if (!child || typeof child.once !== "function") {
    return Promise.resolve({
      ok: false,
      message: "taskkill did not return a child process"
    });
  }
  if (childHasExited(child)) {
    return Promise.resolve({
      ok: child.exitCode === 0,
      code: child.exitCode,
      signal: child.signalCode
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      resolve(result);
    };
    const onError = (error) => finish({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
    const onExit = (code, signal) => finish({
      ok: code === 0,
      code,
      signal
    });

    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onExit);
    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // The timeout result below remains authoritative.
      }
      finish({
        ok: false,
        timedOut: true,
        message: `taskkill timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
  });
}

function commandFailureMessage(result) {
  if (result.message) {
    return result.message;
  }
  if (result.signal) {
    return `taskkill exited from signal ${result.signal}`;
  }
  return `taskkill exited with code ${result.code ?? -1}`;
}

export async function terminateTrackedDevProcess(record, options = {}) {
  const child = record?.child;
  const name = record?.name || "unknown";
  const pid = child?.pid;
  if (childHasExited(child)) {
    return { ok: true, name, pid, skipped: true };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      ok: false,
      name,
      pid,
      message: "tracked process has no valid pid"
    };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      const requested = child.kill("SIGTERM");
      if (requested || childHasExited(child)) {
        return { ok: true, name, pid };
      }
      return {
        ok: false,
        name,
        pid,
        message: "SIGTERM was not delivered"
      };
    } catch (error) {
      if (childHasExited(child)) {
        return { ok: true, name, pid };
      }
      return {
        ok: false,
        name,
        pid,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const taskkillTimeoutMs = options.taskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS;
  const childExitTimeoutMs = options.childExitTimeoutMs ?? WINDOWS_CHILD_EXIT_TIMEOUT_MS;
  const childExitPromise = waitForChildExit(child, childExitTimeoutMs);
  let taskkillResult;
  try {
    const killer = spawnImpl(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true }
    );
    taskkillResult = await waitForCommandExit(killer, taskkillTimeoutMs);
  } catch (error) {
    taskkillResult = {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const childExited = await childExitPromise;
  if (childExited) {
    // A non-zero taskkill result can race with the process exiting naturally.
    return { ok: true, name, pid };
  }
  return {
    ok: false,
    name,
    pid,
    message: taskkillResult.ok
      ? `process tree did not exit within ${childExitTimeoutMs}ms`
      : commandFailureMessage(taskkillResult)
  };
}

export function createDevShutdownCoordinator(options) {
  const records = options.records;
  const platform = options.platform ?? process.platform;
  const exitImpl = options.exitImpl ?? process.exit.bind(process);
  const logger = options.logger ?? console;
  const terminateImpl = options.terminateImpl ?? terminateTrackedDevProcess;
  let requestedExitCode = 0;
  let shutdownPromise = null;

  return function shutdown(code = 0) {
    const normalizedCode = Number.isInteger(code) && code >= 0 ? code : 1;
    if (normalizedCode !== 0 && requestedExitCode === 0) {
      requestedExitCode = normalizedCode;
    }
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const results = await Promise.all([...records].map(async (record) => {
        try {
          return await terminateImpl(record, {
            platform,
            ...(options.terminateOptions ?? {})
          });
        } catch (error) {
          return {
            ok: false,
            name: record?.name || "unknown",
            pid: record?.child?.pid,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }));
      const failures = results.filter((result) => !result.ok);
      for (const failure of failures) {
        logger.error(
          `[dev] failed to stop ${failure.name} process tree pid=${failure.pid ?? "unknown"}: ` +
            failure.message
        );
      }
      const exitCode = failures.length > 0 ? 1 : requestedExitCode;
      exitImpl(exitCode);
      return exitCode;
    })();
    return shutdownPromise;
  };
}

export const __testInternals = {
  WINDOWS_TASKKILL_TIMEOUT_MS,
  WINDOWS_CHILD_EXIT_TIMEOUT_MS,
  childHasExited,
  waitForChildExit,
  waitForCommandExit
};
