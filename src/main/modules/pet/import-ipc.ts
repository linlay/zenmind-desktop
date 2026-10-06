import { resolveRemovablePetPath } from "./remove-package";
import path from "node:path";
import { dialog, shell, type App, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import type { DesktopPetImportResult, DesktopPetRemoveResult, DesktopPetState } from "../../../shared/contracts";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";
import { installLocalPetPackage, PetPackageError } from "./pet-package";
export function petImportDialogOptions(platform: NodeJS.Platform): OpenDialogOptions {
  const filters = [{ name: "Desktop Pet ZIP", extensions: ["zip"] }];
  // Windows avoids adding imported packages to Explorer recent documents.
  if (platform === "darwin")
    return { filters, properties: ["openFile"] };
  if (platform === "win32")
    return { filters, properties: ["openFile", "dontAddToRecent"] };
  return { filters, properties: ["openFile"] };
}
export function registerPetImportIpcHandlers(ipcMain: IpcMain, options: {
  app: App;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  refreshState: () => DesktopPetState;
  onRemoved: (appearanceId: string) => void;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  function owner(event: IpcMainInvokeEvent) {
    const win = options.getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error("Pet import requires the main window.");
    return win;
  }
  ipcMain.handle("desktopPet.removePackage", (event, appearanceId): Promise<DesktopPetRemoveResult> => {
    owner(event);
    const run = async (): Promise<DesktopPetRemoveResult> => {
      try {
        owner(event);
        if (options.platform !== "darwin" && options.platform !== "win32") throw new Error("Unsupported platform");
        const target = resolveRemovablePetPath(options.app, appearanceId);
        // Electron uses Trash on macOS and Recycle Bin on Windows; no permanent rm fallback.
        await shell.trashItem(target);
        options.onRemoved(appearanceId);
        return { ok: true, state: options.refreshState() };
      } catch {
        return { ok: false, error: "removeFailed" };
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => { });
    return result;
  });
  for (const kind of ["Package", "DroppedPackage"] as const) {
    ipcMain.handle(`desktopPet.import${kind}`, (event, input): Promise<DesktopPetImportResult> => {
      owner(event);
      const run = async (): Promise<DesktopPetImportResult> => {
        try {
          owner(event);
          if (options.platform !== "darwin" && options.platform !== "win32")
            throw new PetPackageError("invalidPackage");
          let source: unknown = input;
          if (kind !== "DroppedPackage") {
            const selected = await dialog.showOpenDialog(owner(event), petImportDialogOptions(options.platform));
            owner(event);
            if (selected.canceled || !selected.filePaths[0])
              return { ok: true, cancelled: true, state: options.refreshState() };
            source = selected.filePaths[0];
          }
          // Drops never open a picker or accept renderer-supplied relative paths.
          if (typeof source !== "string" || !path.isAbsolute(source) || path.extname(source).toLowerCase() !== ".zip")
            throw new PetPackageError("invalidPackage");
          const importedAppearanceId = await installLocalPetPackage(source, getDesktopPetsDataRoot(options.app, options.platform), () => { owner(event); });
          return { ok: true, importedAppearanceId, state: options.refreshState() };
        }
        catch (error) {
          return { ok: false, error: error instanceof PetPackageError ? error.code : "storageFailed" };
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => { });
      return result;
    });
  }
}
