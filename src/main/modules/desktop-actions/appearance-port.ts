import type { DesktopSkinView, DesktopSkinSelectionOptions, InstalledDesktopSkinId } from "../../../shared/desktop-appearance";

// A narrow port injected by the composition root; actions do not depend on
// settings IPC, stores or other settings-module dependencies.
type SkinOperations = {
  read(): DesktopSkinView;
  setSkin(id: unknown, selection?: DesktopSkinSelectionOptions): DesktopSkinView;
  importPackage(filePath: string): Promise<{ settings: DesktopSkinView; importedSkinId: InstalledDesktopSkinId }>;
  removePackage(id: unknown): DesktopSkinView;
};

export type DesktopAppearancePort = {
  run<T>(operation: (store: SkinOperations) => T | Promise<T>, changed?: boolean | ((value: T) => boolean)): Promise<T>;
};
