import type { BrowserWindow } from "electron";

type ShutdownWindowState = {
  mainWindow: BrowserWindow | null;
  desktopPetWindow: BrowserWindow | null;
};

type ShutdownDeadlineOptions = {
  timeoutMs: number;
  now?: () => number;
  consoleWarn?: (message: string) => void;
  consoleError?: (message: string, error?: unknown) => void;
};

export type ShutdownDeadlineResult = {
  timedOut: boolean;
  elapsedMs: number;
};

export function hideWindowsForShutdown(state: ShutdownWindowState) {
  for (const window of [state.mainWindow, state.desktopPetWindow]) {
    if (!window || window.isDestroyed() || !window.isVisible()) {
      continue;
    }
    window.hide();
  }
}

export async function runWithShutdownDeadline(
  cleanup: () => Promise<void>,
  options: ShutdownDeadlineOptions
): Promise<ShutdownDeadlineResult> {
  const startedAt = (options.now ?? Date.now)();
  const now = options.now ?? Date.now;
  const consoleWarn = options.consoleWarn ?? console.warn;
  const consoleError = options.consoleError ?? console.error;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const cleanupPromise = cleanup();
  cleanupPromise.catch((error) => {
    if (timedOut) {
      consoleError("[main] shutdown cleanup failed after deadline", error);
    }
  });

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, options.timeoutMs);
  });

  const result = await Promise.race([
    cleanupPromise.then(() => "cleanup" as const),
    timeoutPromise
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }

  const elapsedMs = now() - startedAt;
  if (result === "timeout") {
    consoleWarn(`[main] app shutdown cleanup timed out after ${elapsedMs}ms; continuing app quit`);
    return { timedOut: true, elapsedMs };
  }

  return { timedOut: false, elapsedMs };
}
