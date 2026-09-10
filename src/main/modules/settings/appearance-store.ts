import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot } from "../../infrastructure/filesystem/profile-store";
import { isDesktopSkinId, type DesktopSkinView } from "../../../shared/desktop-appearance";
import { BackgroundImageError, inspectBackgroundImage, MAX_BACKGROUND_INPUT_BYTES, MAX_BACKGROUND_STORED_BYTES } from "./appearance-images";

type Options = {
  configRoot: string;
  assetsRoot: string;
  normalizeImage: (data: Buffer) => { data: Buffer; width: number; height: number };
};

function readBoundedFile(filePath: string, limit: number) {
  if (!fs.lstatSync(filePath).isFile()) throw new BackgroundImageError("invalidImage");
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new BackgroundImageError("invalidImage");
    if (stat.size > limit) throw new BackgroundImageError("imageTooLarge");
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, null);
      if (!count) break;
      read += count;
    }
    if (read > stat.size) throw new BackgroundImageError("imageTooLarge");
    return buffer.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

export function createDesktopSkinStore(options: Options) {
  const profile = () => readDesktopProfileFromRoot(options.configRoot);
  const assetPath = (id: string) => path.join(options.assetsRoot, `${id}.png`);
  function read(): DesktopSkinView {
    const { skinId, background } = profile().appearance;
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
    return { skinId, background, backgroundDataUrl };
  }
  function removeAsset(id: string | undefined) {
    if (!id) return;
    try { fs.unlinkSync(assetPath(id)); } catch { /* Old owned assets may be cleaned up later. */ }
  }
  return {
    read,
    setSkin(id: unknown) {
      if (!isDesktopSkinId(id)) throw new Error("Unknown desktop skin.");
      updateDesktopProfileInRoot(options.configRoot, { appearance: { skinId: id } });
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
