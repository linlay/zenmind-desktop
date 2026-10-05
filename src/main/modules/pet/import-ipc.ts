import path from "node:path";
import { dialog, type App, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import type { DesktopPetImportResult, DesktopPetState } from "../../../shared/contracts";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";
import { installLocalPetPackage, PetPackageError } from "./pet-package";
export function petImportDialogOptions(platform: NodeJS.Platform, folder: boolean): OpenDialogOptions {
  const filters = folder ? undefined : [{ name: "Desktop Pet ZIP", extensions: ["zip"] }];
  // Finder cannot combine file/folder selection consistently with Explorer; use separate pickers.
  if (platform === "darwin")
    return { filters, properties: [folder ? "openDirectory" : "openFile"] };
  if (platform === "win32")
    return { filters, properties: [folder ? "openDirectory" : "openFile", "dontAddToRecent"] };
  return { filters, properties: [folder ? "openDirectory" : "openFile"] };
}
export function registerPetImportIpcHandlers(ipcMain: IpcMain, options: {
  app: App;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  refreshState: () => DesktopPetState;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  function owner(event: IpcMainInvokeEvent) {
    const win = options.getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error("Pet import requires the main window.");
    return win;
  }
  for (const kind of ["Package", "Folder", "DroppedPackage"] as const) {
    ipcMain.handle(`desktopPet.import${kind}`, (event, input): Promise<DesktopPetImportResult> => {
      owner(event);
      const run = async (): Promise<DesktopPetImportResult> => {
        try {
          owner(event);
          if (options.platform !== "darwin" && options.platform !== "win32")
            throw new PetPackageError("invalidPackage");
          let source: unknown = input;
          if (kind !== "DroppedPackage") {
            const selected = await dialog.showOpenDialog(owner(event), petImportDialogOptions(options.platform, kind === "Folder"));
            owner(event);
            if (selected.canceled || !selected.filePaths[0])
              return { ok: true, cancelled: true, state: options.refreshState() };
            source = selected.filePaths[0];
          }
          // Drops never open a picker or accept renderer-supplied relative paths.
          if (typeof source !== "string" || !path.isAbsolute(source))
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
