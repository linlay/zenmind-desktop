import { resolveRemovablePetPath } from "./remove-package";
import { dialog, shell, type App, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import type { DesktopPetImportResult, DesktopPetRemoveResult, DesktopPetState } from "../../../shared/contracts";
import { PetPackageError } from "./pet-package";
import type { PetPackageService } from "./package-service";
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
  packageService: PetPackageService;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  refreshState: () => DesktopPetState;
  onRemoved: (appearanceId: string) => void;
}) {
  const packages = options.packageService;
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
    return packages.run(run);
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
          return await packages.importPackage(source, () => { owner(event); });
        }
        catch (error) {
          return { ok: false, error: error instanceof PetPackageError ? error.code : "storageFailed" };
        }
      };
      return run();
    });
  }
}
