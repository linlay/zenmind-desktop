import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot } from "../../infrastructure/filesystem/profile-store";
import { isDesktopSkinId, type DesktopSkinView } from "../../../shared/desktop-appearance";
import { BackgroundImageError, inspectBackgroundImage, MAX_BACKGROUND_INPUT_BYTES, MAX_BACKGROUND_STORED_BYTES } from "./appearance-images";

import { readBoundedFile } from "./appearance-files";
import { createSkinPackageStore } from "./skin-package-store";
import { isBuiltinDesktopSkinId, isInstalledDesktopSkinId, type DesktopSkinSelectionOptions } from "../../../shared/desktop-appearance";

type Options = {
  configRoot: string;
  assetsRoot: string;
  makePreview?: (data: Buffer) => Buffer;
  normalizeImage: (data: Buffer) => { data: Buffer; width: number; height: number };
};

export function createDesktopSkinStore(options: Options) {
  const packages = createSkinPackageStore({ root: path.join(options.assetsRoot, "skins"), normalizeImage: options.normalizeImage, makePreview: options.makePreview });
  const profile = () => readDesktopProfileFromRoot(options.configRoot);
  const assetPath = (id: string) => path.join(options.assetsRoot, `${id}.png`);
  function read(): DesktopSkinView {
    const { skinId, background } = profile().appearance;
    packages.recoverRemovals(skinId);
    let backgroundDataUrl: string | null = null;
    if (background) {
      try {
        const data = readBoundedFile(assetPath(background.id), MAX_BACKGROUND_STORED_BYTES);
        const size = inspectBackgroundImage(data);
        if (size.width === background.width && size.height === background.height) {
          backgroundDataUrl = `data:image/png;base64,${data.toString("base64")}`;
        }
      } catch { /* A missing/corrupt asset never prevents loading the skin. */ }
    }
    const installedSkins = packages.list();
    return { skinId, background, backgroundDataUrl, packageApiVersion: 1,
      ...(installedSkins.length || isInstalledDesktopSkinId(skinId) ? { installedSkins, installedSkin: packages.resolve(skinId) } : {})
    };
  }
  function removeAsset(id: string | undefined) {
    if (!id) return;
    try { fs.unlinkSync(assetPath(id)); } catch { /* Old owned assets may be cleaned up later. */ }
  }
  return {
    read,
    setSkin(id: unknown, selection: DesktopSkinSelectionOptions = {}) {
      if (!isDesktopSkinId(id) || (!isBuiltinDesktopSkinId(id) && !packages.resolve(id))) throw new Error("Unknown desktop skin.");
      const previous = profile().appearance.background;
      const reset = isInstalledDesktopSkinId(id) && selection.keepBackground !== true;
      updateDesktopProfileInRoot(options.configRoot, { appearance: { skinId: id, ...(reset ? { background: null } : {}) } });
      if (reset) removeAsset(previous?.id);
      return read();
    },
    async importPackage(filePath: string, assertOwner: () => void = () => {}) {
      const importedSkinId = await packages.install(filePath, assertOwner);
      return { settings: read(), importedSkinId };
    },
    removePackage(id: unknown) {
      if (!isInstalledDesktopSkinId(id)) throw new Error("Unknown desktop skin.");
      packages.remove(id, () => {
        if (profile().appearance.skinId === id) updateDesktopProfileInRoot(options.configRoot, { appearance: { skinId: "default" } });
      });
      return read();
    },
    importFile(filePath: string) {
      const data = readBoundedFile(filePath, MAX_BACKGROUND_INPUT_BYTES);
      inspectBackgroundImage(data);
      const normalized = options.normalizeImage(data);
      const id = randomBytes(16).toString("hex");
      fs.mkdirSync(options.assetsRoot, { recursive: true });
      const target = assetPath(id);
      const previous = profile().appearance.background;
      try {
        fs.writeFileSync(target, normalized.data, { flag: "wx" });
        updateDesktopProfileInRoot(options.configRoot, { appearance: { background: {
          id, name: path.basename(filePath), width: normalized.width, height: normalized.height
        } } });
      } catch (error) {
        removeAsset(id);
        throw error;
      }
      removeAsset(previous?.id);
      return read();
    },
    resetBackground() {
      const previous = profile().appearance.background;
      updateDesktopProfileInRoot(options.configRoot, { appearance: { background: null } });
      removeAsset(previous?.id);
      return read();
    }
  };
}
