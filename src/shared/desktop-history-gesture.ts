import type { DesktopHistoryGestureProgress } from "./contracts/desktop-api";

export const DESKTOP_HISTORY_GESTURE_CHANNEL = "desktopShell.historyGesture";
export const DESKTOP_HISTORY_GESTURE_RESET_CHANNEL = "desktopShell.historyGestureReset";
export const DESKTOP_HISTORY_GESTURE_PROGRESS_CHANNEL = "app.historyGestureProgress";
export const DESKTOP_HISTORY_GESTURE_IDLE_MS = 320;
export const DESKTOP_HISTORY_GESTURE_THRESHOLD = 120;

export function readDesktopHistoryGestureProgress(value: unknown): DesktopHistoryGestureProgress | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sample = value as Record<string, unknown>;
  if (Object.keys(sample).length !== 3 ||
      (sample.direction !== "back" && sample.direction !== "forward") ||
      typeof sample.progress !== "number" || !Number.isFinite(sample.progress) ||
      sample.progress < 0 || sample.progress > 1 || typeof sample.committed !== "boolean" ||
      (sample.committed && sample.progress !== 1)) return undefined;
  return { direction: sample.direction, progress: sample.progress, committed: sample.committed };
}
