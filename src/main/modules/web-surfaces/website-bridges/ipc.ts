import fs from "node:fs";
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import { WebsiteBridgeError, type WebsiteBridgeResult } from "../../../../shared/website-bridge";

export function websiteBridgeDialogOptions(platform: NodeJS.Platform): OpenDialogOptions {
  const filters = [{ name: "Website Bridge ZIP", extensions: ["zip"] }];
  if (platform === "win32") return { filters, properties: ["openFile", "dontAddToRecent"] };
  if (platform === "darwin") return { filters, properties: ["openFile"] };
  return { filters, properties: ["openFile"] };
}
export function registerWebsiteBridgeIpc(ipcMain: IpcMain, options: {
  getMainWindow(): BrowserWindow | null;
  browserSurfaces: BrowserSurfaceRegistry;
  platform?: NodeJS.Platform;
}) {
  const manager = options.browserSurfaces.websiteBridges;
  function owner(event: IpcMainInvokeEvent) {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Website bridge management requires the main window.");
    return window;
  }
  function register(channel: string, operation: (event: IpcMainInvokeEvent, input: any) => Promise<WebsiteBridgeResult> | WebsiteBridgeResult) {
    ipcMain.handle(channel, async (event, input): Promise<WebsiteBridgeResult> => {
      owner(event);
      try { return await operation(event, input); }
      catch (error) { return { ok: false, error: error instanceof WebsiteBridgeError ? error.code : "storageFailed" }; }
    });
  }
  register("settings.listWebsiteBridges", () => manager.list());
  register("settings.importWebsiteBridge", async (event, expectedId) => {
    const selected = await dialog.showOpenDialog(owner(event), websiteBridgeDialogOptions(options.platform ?? process.platform));
    owner(event);
    if (selected.canceled || !selected.filePaths[0]) { const result = manager.list(); return result.ok ? { ...result, cancelled: true } : result; }
    return manager.importFile(selected.filePaths[0], () => { owner(event); }, expectedId);
  });
  register("settings.setWebsiteBridgeEnabled", (event, input) => manager.setEnabled(input?.id, input?.enabled, () => { owner(event); }));
  register("settings.removeWebsiteBridge", (event, id) => manager.remove(id, () => { owner(event); }));
  register("settings.readWebsiteBridgeScript", (_event, input) => manager.readScript(input?.id, input?.script));
  register("settings.exportWebsiteBridge", async (event, id) => {
    const bytes = await manager.exportBytes(id);
    const selected = await dialog.showSaveDialog(owner(event), { defaultPath: `${id}.zip`, filters: [{ name: "Website Bridge ZIP", extensions: ["zip"] }] });
    owner(event);
    if (!selected.canceled && selected.filePath) fs.writeFileSync(selected.filePath, bytes);
    const result = manager.list(); return result.ok ? { ...result, cancelled: selected.canceled } : result;
  });
}
