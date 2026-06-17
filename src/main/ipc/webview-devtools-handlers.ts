import { webContents as electronWebContents } from "electron";
import type { IpcMain } from "electron";
import { t } from "../i18n/main-i18n";

function readWebContentsId(value: unknown) {
  const webContentsId = Number(value);
  return Number.isFinite(webContentsId) && webContentsId > 0 ? webContentsId : 0;
}

export function openWebviewDevToolsById(
  rawWebContentsId: unknown,
  options: {
    webContents?: Pick<typeof electronWebContents, "fromId">;
  } = {}
) {
  const webContentsId = readWebContentsId(rawWebContentsId);
  if (!webContentsId) {
    return { ok: false, message: t("webviewDevTools.unavailable") };
  }

  const webContents = options.webContents || electronWebContents;
  const targetContents = webContents.fromId(webContentsId);
  if (!targetContents || targetContents.isDestroyed()) {
    return { ok: false, message: t("webviewDevTools.closed") };
  }
  if (targetContents.getType() !== "webview") {
    return { ok: false, message: t("webviewDevTools.notWebview") };
  }

  targetContents.openDevTools({ mode: "detach" });
  return { ok: true };
}

export function registerWebviewDevToolsIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  options: {
    webContents?: Pick<typeof electronWebContents, "fromId">;
  } = {}
) {
  ipcMain.handle("webview.openDevTools", async (_event, webContentsId) =>
    openWebviewDevToolsById(webContentsId, options)
  );
}
