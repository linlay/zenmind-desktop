import { webContents as electronWebContents } from "electron";
import type { IpcMain } from "electron";
import {
  normalizeDebugSurfaceRegistration,
  readDebugWebContentsId
} from "../debug/surface-registration";

export function registerDebugIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  options: {
    openViewer: () => unknown;
    closeViewer: () => unknown;
    debugEventStore: {
      listEvents: () => unknown;
      clearEvents: () => void;
      getSurface: (webContentsId: number) => unknown;
    };
    webviewDebugManager: {
      registerSurface: (metadata: any) => unknown;
      unregisterSurface: (webContentsId: number) => void;
    };
    webContents?: Pick<typeof electronWebContents, "fromId">;
  }
) {
  const webContents = options.webContents || electronWebContents;

  ipcMain.handle("debug.openViewer", async () => options.openViewer());
  ipcMain.handle("debug.closeViewer", async () => options.closeViewer());
  ipcMain.handle("debug.listEvents", async () => options.debugEventStore.listEvents());
  ipcMain.handle("debug.clearEvents", async () => {
    options.debugEventStore.clearEvents();
    return { ok: true };
  });
  ipcMain.handle("debug.registerWebviewSurface", async (_event, metadata) => {
    options.webviewDebugManager.registerSurface(normalizeDebugSurfaceRegistration(metadata));
    return { ok: true };
  });
  ipcMain.handle("debug.unregisterWebviewSurface", async (_event, webContentsId) => {
    options.webviewDebugManager.unregisterSurface(readDebugWebContentsId(webContentsId));
    return { ok: true };
  });
  ipcMain.handle("debug.openWebviewDevTools", async (_event, rawWebContentsId) => {
    const webContentsId = readDebugWebContentsId(rawWebContentsId);
    if (!options.debugEventStore.getSurface(webContentsId)) {
      return { ok: false, message: "未找到对应的内嵌网页。" };
    }
    const targetContents = webContents.fromId(webContentsId);
    if (!targetContents || targetContents.isDestroyed()) {
      return { ok: false, message: "内嵌网页已关闭。" };
    }
    targetContents.openDevTools({ mode: "detach" });
    return { ok: true };
  });
}
