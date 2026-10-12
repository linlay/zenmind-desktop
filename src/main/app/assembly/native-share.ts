import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { readAgentWebclientNewChatSource } from "../../../shared/canonical-chat-sync";
import { NATIVE_SHARE_READ_CHANNEL, type NativeShareReadResult, type NativeShareTarget } from "../../../shared/native-share";

export function isNativeShareTargetRoute(value: string, target: NativeShareTarget): boolean {
  try {
    const url = new URL(value, "http://desktop.local");
    const route = url.hash.startsWith("#/") ? new URL(url.hash.slice(1), "http://desktop.local") : url;
    const source = readAgentWebclientNewChatSource(route.href);
    return Boolean(source && source.agentKey === target.agentKey && source.newChat === target.newChat &&
      route.searchParams.getAll("shareBatch").length === 1 && route.searchParams.get("shareBatch") === target.batchId);
  } catch { return false; }
}

/** Only the trusted main-window top frame may forward the live Chat's request. */
export function registerNativeShareIpc(ports: {
  platform: NodeJS.Platform;
  ipcMain: Pick<IpcMain, "handle">;
  getMainWindow(): BrowserWindow | null;
  read(request: unknown): Promise<NativeShareReadResult>;
}) {
  ports.ipcMain.handle(NATIVE_SHARE_READ_CHANNEL, async (event: IpcMainInvokeEvent, request: unknown) => {
    const window = ports.getMainWindow();
    if (ports.platform !== "darwin" || !window || window.isDestroyed() || window.webContents.isDestroyed() ||
      event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, code: "stale_target", message: "Shared files are only available to their active chat." };
    }
    return ports.read(request);
  });
}
