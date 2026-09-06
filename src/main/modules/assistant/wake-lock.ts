import { powerSaveBlocker } from "electron";

export type AssistantRunWakeLockOptions = {
  isEnabled?: () => boolean;
};

export function createAssistantRunWakeLock(
  platform: NodeJS.Platform,
  options: AssistantRunWakeLockOptions = {}
) {
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const blockerType = (() => {
    // Keep platform branches explicit because sleep-prevention behavior is OS-sensitive.
    if (isMac) {
      return "prevent-app-suspension" as const;
    }
    if (isWindows) {
      return "prevent-app-suspension" as const;
    }
    return null;
  })();
  let blockerId: number | null = null;
  let requested = false;

  function isEnabled() {
    try {
      return options.isEnabled?.() ?? true;
    } catch (error) {
      console.warn("[assistant] failed to read wake lock setting", error);
      return true;
    }
  }

  function startBlockerIfNeeded() {
    if (!blockerType || !requested || !isEnabled()) {
      return;
    }
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      return;
    }
    blockerId = powerSaveBlocker.start(blockerType);
  }

  function stopBlockerIfNeeded() {
    if (blockerId === null) {
      return;
    }
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
  }

  function sync() {
    if (requested && isEnabled()) {
      startBlockerIfNeeded();
      return;
    }
    stopBlockerIfNeeded();
  }

  return {
    acquire() {
      requested = true;
      startBlockerIfNeeded();
    },
    release() {
      requested = false;
      stopBlockerIfNeeded();
    },
    sync
  };
}

export type AssistantRunWakeLock = ReturnType<typeof createAssistantRunWakeLock>;
