import path from "node:path";
import { shell, type App } from "electron";
import type { DesktopPetImportResult, DesktopPetState } from "../../../shared/contracts";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";
import { installLocalPetPackage, installPetPackage, PetPackageError, type PetMarketIdentity } from "./pet-package";
import { resolveRemovablePetPath } from "./remove-package";

export function isDesktopPetArchivePath(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(value) && !value.slice(2).includes(":") && path.win32.isAbsolute(value) && path.win32.extname(value).toLowerCase() === ".zip";
  if (platform === "darwin") return path.posix.isAbsolute(value) && !value.startsWith("//") && path.posix.extname(value).toLowerCase() === ".zip";
  return false;
}

// One runtime-owned queue for picker/drop/action imports and IPC removal.
export function createPetPackageService(options: {
  app: App;
  platform: NodeJS.Platform;
  refreshState: () => DesktopPetState;
  onRemoved?: (appearanceId: string) => void;
  trashItem?: (path: string) => Promise<void>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }
  return {
    run,
    installMarketPackage(source: string, identity: PetMarketIdentity, onCommitted: (appearanceId: string) => void, assertOwner = () => {}) {
      return run(async () => {
        assertOwner();
        if (!isDesktopPetArchivePath(source, options.platform)) throw new PetPackageError("invalidPackage");
        const id = await installPetPackage(source, getDesktopPetsDataRoot(options.app, options.platform), { market: identity, onCommitted, assertOwner });
        options.refreshState();
        return id;
      });
    },
    removePackage(appearanceId: string, assertOwner = () => {}, onRemoved = options.onRemoved) {
      return run(async () => {
        assertOwner();
        if (options.platform !== "darwin" && options.platform !== "win32") throw new PetPackageError("invalidPackage");
        const target = resolveRemovablePetPath(options.app, appearanceId);
        // macOS Trash and Windows Recycle Bin are both provided by Electron.
        await (options.trashItem ?? shell.trashItem)(target);
        onRemoved?.(appearanceId);
        return options.refreshState();
      });
    },
    importPackage(source: unknown, assertOwner = () => {}): Promise<DesktopPetImportResult> {
      return run(async () => {
        assertOwner();
        if (!isDesktopPetArchivePath(source, options.platform)) throw new PetPackageError("invalidPackage");
        const importedAppearanceId = await installLocalPetPackage(source, getDesktopPetsDataRoot(options.app, options.platform), assertOwner);
        return { ok: true, importedAppearanceId, state: options.refreshState() };
      });
    }
  };
}
export type PetPackageService = ReturnType<typeof createPetPackageService>;
