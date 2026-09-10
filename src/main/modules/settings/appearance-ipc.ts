import path from "node:path";
import { dialog, nativeImage, type App, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { getDesktopConfigRoot, getRuntimeDataRoot } from "../../infrastructure/filesystem/user-paths";
import type { DesktopSkinResult, DesktopSkinView } from "../../../shared/desktop-appearance";
import { BackgroundImageError, normalizeBackgroundImage } from "./appearance-images";
import { createDesktopSkinStore } from "./appearance-store";

export function getBackgroundDialogOptions(platform: NodeJS.Platform): OpenDialogOptions {
  const filters = [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }];
  // macOS resolves Finder aliases through its picker. Windows avoids adding a
  // wallpaper import to Explorer's recent documents; no shell thumbnails used.
  if (platform === "darwin") return { filters, properties: ["openFile"] };
  if (platform === "win32") return { filters, properties: ["openFile", "dontAddToRecent"] };
  return { filters, properties: ["openFile"] };
}

export function registerAppearanceIpcHandlers(ipcMain: IpcMain, options: {
  app: App;
  platform?: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
}) {
  const platform = options.platform ?? process.platform;
  // Paths inherit the explicit macOS/Windows data-root policy. This module owns
  // only its leaf directory; service config and original images are untouched.
  const store = createDesktopSkinStore({
    configRoot: getDesktopConfigRoot(options.app, platform),
    assetsRoot: path.join(getRuntimeDataRoot(options.app, platform), "desktop", "appearance"),
    normalizeImage: (data) => normalizeBackgroundImage(data, (buffer) => nativeImage.createFromBuffer(buffer))
  });
  let operations: Promise<unknown> = Promise.resolve();
  function assertOwner(event: IpcMainInvokeEvent) {
    const owner = options.getMainWindow();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame) throw new Error("Desktop appearance requires the main window.");
    return owner;
  }
  function register(channel: string, operation: (event: IpcMainInvokeEvent, input: unknown) => Promise<{ settings: DesktopSkinView; cancelled?: boolean }> | { settings: DesktopSkinView; cancelled?: boolean }) {
    ipcMain.handle(channel, (event, input): Promise<DesktopSkinResult> => {
      assertOwner(event);
      const result = operations.then(async (): Promise<DesktopSkinResult> => {
        assertOwner(event);
        try { return { ok: true, ...await operation(event, input) }; }
        catch (error) {
          return { ok: false, error: error instanceof BackgroundImageError ? error.code : "storageFailed" };
        }
      });
      operations = result.catch(() => undefined);
      return result;
    });
  }
  register("settings.getDesktopSkin", () => ({ settings: store.read() }));
  register("settings.setDesktopSkin", (_event, id) => ({ settings: store.setSkin(id) }));
  register("settings.resetDesktopBackground", () => ({ settings: store.resetBackground() }));
  register("settings.importDesktopBackground", async (event) => {
    const selected = await dialog.showOpenDialog(assertOwner(event), getBackgroundDialogOptions(platform));
    assertOwner(event);
    if (selected.canceled || !selected.filePaths[0]) return { settings: store.read(), cancelled: true };
    return { settings: store.importFile(selected.filePaths[0]) };
  });
}
