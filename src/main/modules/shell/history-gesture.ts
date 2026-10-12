import type { IpcMainEvent, WebContents } from "electron";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import { DESKTOP_HISTORY_GESTURE_CHANNEL, DESKTOP_HISTORY_GESTURE_IDLE_MS, DESKTOP_HISTORY_GESTURE_PROGRESS_CHANNEL, readDesktopHistoryGestureProgress } from "../../../shared/desktop-history-gesture";

type HistoryWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
};
type GestureContents = {
  mainFrame?: WebContents["mainFrame"];
  on(event: string, listener: (...args: any[]) => void): unknown;
};
const gestures = new WeakMap<HistoryWindow, { lastSampleAt: number; consumed: boolean }>();

export function configureDesktopHistoryGesture(
  contents: GestureContents,
  options: { platform: DesktopPlatform; getMainWindow(): HistoryWindow | null },
) {
  if (options.platform !== "darwin") return;
  contents.on("ipc-message", (event: IpcMainEvent, channel: string, payload: unknown) => {
    if (channel !== DESKTOP_HISTORY_GESTURE_CHANNEL) return;
    const sample = readDesktopHistoryGestureProgress(payload);
    if (sample === undefined) return;
    const owner = options.getMainWindow();
    if (!owner || owner.isDestroyed() || event.sender !== contents ||
        !event.senderFrame || event.senderFrame !== contents.mainFrame) return;
    const now = performance.now();
    let gesture = gestures.get(owner);
    if (!gesture || now - gesture.lastSampleAt > DESKTOP_HISTORY_GESTURE_IDLE_MS) {
      gesture = { lastSampleAt: now, consumed: false };
      gestures.set(owner, gesture);
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
