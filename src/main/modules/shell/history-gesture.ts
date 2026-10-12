import type { InputEvent, IpcMainEvent, WebContents } from "electron";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import { DESKTOP_HISTORY_GESTURE_CHANNEL, DESKTOP_HISTORY_GESTURE_RESET_CHANNEL, DESKTOP_HISTORY_GESTURE_IDLE_MS, DESKTOP_HISTORY_GESTURE_PROGRESS_CHANNEL, readDesktopHistoryGestureProgress } from "../../../shared/desktop-history-gesture";

type HistoryWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
};
type GestureContents = {
  mainFrame?: WebContents["mainFrame"];
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(channel: string, ...args: unknown[]): void;
};
type GestureState = {
  lastSampleAt: number;
  consumed: boolean;
  nativeActive: boolean;
  resetId: number;
  ready: Set<GestureContents> | null;
};
const gestures = new WeakMap<HistoryWindow, GestureState>();
const sources = new WeakMap<HistoryWindow, Set<GestureContents>>();

function getGesture(owner: HistoryWindow): GestureState {
  let gesture = gestures.get(owner);
  if (!gesture) {
    gesture = { lastSampleAt: Number.NEGATIVE_INFINITY, consumed: false, nativeActive: false, resetId: 0, ready: null };
    gestures.set(owner, gesture);
  }
  return gesture;
}

export function configureDesktopHistoryGesture(
  contents: GestureContents,
  options: { platform: DesktopPlatform; getMainWindow(): HistoryWindow | null },
) {
  if (options.platform !== "darwin") return;
  const owner = options.getMainWindow();
  if (!owner || owner.isDestroyed()) return;
  let windowSources = sources.get(owner);
  if (!windowSources) {
    windowSources = new Set();
    sources.set(owner, windowSources);
  }
  windowSources.add(contents);
  contents.on("destroyed", () => windowSources.delete(contents));

  contents.on("input-event", (_event: unknown, input: InputEvent) => {
    // The root receives the window's scroll sequence, including guest bubbling.
    // Guest begin/end events are duplicates and can arrive late after a switch.
    if (owner.isDestroyed() || contents !== owner.webContents) return;
    const gesture = getGesture(owner);
    const now = performance.now();
    if (input.type === "gestureScrollBegin" &&
        (!gesture.nativeActive || now - gesture.lastSampleAt > DESKTOP_HISTORY_GESTURE_IDLE_MS)) {
      gesture.nativeActive = true;
      gesture.consumed = false;
      gesture.lastSampleAt = now;
      gesture.resetId += 1;
      gesture.ready = new Set();
      // Reset every retained preload, since the pointer can stay in place while
      // navigation exposes a guest that still has the previous swipe's buffer.
      for (const source of windowSources) source.send(DESKTOP_HISTORY_GESTURE_RESET_CHANNEL, gesture.resetId);
    } else if (input.type === "gestureScrollEnd") {
      gesture.nativeActive = false;
      // Keep the consumed guard until the next begin: final DOM wheel events
      // may still be queued when Chromium reports the native end.
      if (!gesture.consumed) owner.webContents.send(DESKTOP_HISTORY_GESTURE_PROGRESS_CHANNEL, null);
    }
  });
  contents.on("ipc-message", (event: IpcMainEvent, channel: string, payload: unknown) => {
    if (channel !== DESKTOP_HISTORY_GESTURE_CHANNEL && channel !== DESKTOP_HISTORY_GESTURE_RESET_CHANNEL) return;
    if (owner.isDestroyed() || options.getMainWindow() !== owner || event.sender !== contents ||
        !event.senderFrame || event.senderFrame !== contents.mainFrame) return;
    const gesture = getGesture(owner);
    if (channel === DESKTOP_HISTORY_GESTURE_RESET_CHANNEL) {
      if (gesture.ready && payload === gesture.resetId) gesture.ready.add(contents);
      return;
    }
    const sample = readDesktopHistoryGestureProgress(payload);
    // Reset acknowledgements share the sample IPC stream, so samples queued
    // before that preload reset cannot contaminate the new distance buffer.
    if (sample === undefined || (gesture.ready && !gesture.ready.has(contents))) return;
    const now = performance.now();
    if (!gesture.nativeActive && now - gesture.lastSampleAt > DESKTOP_HISTORY_GESTURE_IDLE_MS) {
      gesture.consumed = false;
    }
    gesture.lastSampleAt = now;
    if (!gesture.consumed) {
      owner.webContents.send(DESKTOP_HISTORY_GESTURE_PROGRESS_CHANNEL, sample);
      if (sample?.committed) {
        gesture.consumed = true;
        owner.webContents.send("app.historyNavigation", sample.direction);
      }
    }
  });
}
