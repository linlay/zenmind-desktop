import type { AppearanceRuntime } from "./appearance-runtime";
import type { InstalledDesktopSkinId } from "../../../shared/desktop-appearance";

/** Market uses the same owner/queue/store transaction as appearance IPC. */
export function createSkinMarketPort(runtime: AppearanceRuntime) {
  return {
    listInstalled: () => runtime.run(store => store.listInstalledPackages()),
    installArchive: (file: string, expected: { id: string; version: string }, assertOwner: () => void, onCommitted: (id: InstalledDesktopSkinId) => void) =>
      runtime.run(async store => {
        assertOwner();
        const result = await store.importPackage(file, assertOwner, expected);
        try { assertOwner(); onCommitted(result.importedSkinId); }
        catch (error) { store.removePackage(result.importedSkinId); throw error; }
        return result.importedSkinId;
      }, true)
  };
}
export type SkinMarketPort = ReturnType<typeof createSkinMarketPort>;
