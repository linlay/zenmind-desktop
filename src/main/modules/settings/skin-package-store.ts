import { SKIN_VISUAL_LIMITS, isSkinVisualDataUrl, type SkinVisuals } from "../../../shared/contracts/agent-webclient-bridge";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isInstalledDesktopSkinId, type InstalledDesktopSkinId, type InstalledDesktopSkinSummary } from "../../../shared/desktop-appearance";
import type { DesktopSkinDefinition, DesktopSkinBackground } from "../../../shared/desktop-skin-definition";
import { parseSkinPackageManifest, resolveSkinPackageTokens, SKIN_PACKAGE_LIMITS as limits, SkinPackageError, type SkinPackageManifest } from "../../../shared/desktop-skin-package";
import { readSkinPackageArchive } from "./skin-package-archive";
import { readBoundedFile } from "./appearance-files";
import { inspectBackgroundImage, MAX_BACKGROUND_STORED_BYTES } from "./appearance-images";

const PREVIEW_BYTES = 128 * 1024;
export function createSkinPackageStore(options: {
  root: string;
  normalizeImage: (data: Buffer) => { data: Buffer; width: number; height: number };
  makePreview?: (data: Buffer) => Buffer;
}) {
  const directory = (id: InstalledDesktopSkinId) => path.join(options.root, id.slice(5));
  function readManifest(id: InstalledDesktopSkinId) {
    const dir = directory(id);
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Invalid skin directory.");
    const manifest = parseSkinPackageManifest(JSON.parse(readBoundedFile(path.join(dir, "skin.json"), limits.manifestBytes).toString("utf8")));
    // Installed filenames are generated, flat and independent of ZIP paths.
    for (const variant of Object.values(manifest.variants)) {
      if (variant.background && !/^image-\d{1,2}\.png$/.test(variant.background.path)) throw new Error("Invalid installed asset.");
    }
    for (const variant of Object.values(manifest.variants)) {
      if (Object.values(variant.visuals?.images ?? {}).some(name => !/^image-\d{1,2}\.png$/.test(name))) throw new Error("Invalid installed visual.");
    }
    if (manifest.preview && manifest.preview !== "preview.png") throw new Error("Invalid installed preview.");
    return manifest;
  }
  function ids(): InstalledDesktopSkinId[] {
    try {
      return fs.readdirSync(options.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
        .map((entry): InstalledDesktopSkinId => `pack:${entry.name}`).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  function readImage(id: InstalledDesktopSkinId, name: string, limit = MAX_BACKGROUND_STORED_BYTES) {
    try {
      const bytes = readBoundedFile(path.join(directory(id), name), limit);
      inspectBackgroundImage(bytes);
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch { return null; }
  }
  function list(): InstalledDesktopSkinSummary[] {
    return ids().slice(0, limits.installed).flatMap((id) => {
      try {
        const manifest = readManifest(id);
        return [{ id, name: manifest.name, version: manifest.version, author: manifest.author,
          previewDataUrl: manifest.preview ? readImage(id, manifest.preview, PREVIEW_BYTES) : null }];
      } catch { return []; }
    });
  }
  function resolve(id: unknown): DesktopSkinDefinition | null {
    if (!isInstalledDesktopSkinId(id)) return null;
    try {
      const manifest = readManifest(id);
      const backgrounds: Partial<Record<"light" | "dark", DesktopSkinBackground>> = {};
      const visuals: Partial<Record<"light" | "dark", SkinVisuals>> = {};
      const loadedVisuals = new Map<string, string | null>();
      let visualBytes = 0;
      for (const mode of ["light", "dark"] as const) {
        const visual = manifest.variants[mode].visuals;
        if (visual) {
          const images: SkinVisuals["images"] = {};
          for (const [slot, name] of Object.entries(visual.images)) {
            if (!loadedVisuals.has(name)) {
              const url = readImage(id, name, SKIN_VISUAL_LIMITS.assetBytes);
              visualBytes += url ? Math.ceil((url.length - 22) * 3 / 4) : 0;
              if (visualBytes > SKIN_VISUAL_LIMITS.totalBytes) throw new Error("Visual resources exceed limit.");
              loadedVisuals.set(name, isSkinVisualDataUrl(url) ? url : null);
            }
            const url = loadedVisuals.get(name);
            if (url) images[slot as keyof typeof images] = url;
          }
          visuals[mode] = { images, styles: visual.styles };
        }
        const background = manifest.variants[mode].background;
        const imageUrl = background && readImage(id, background.path);
        if (imageUrl) backgrounds[mode] = { imageUrl, position: background!.position };
      }
      return { id, name: manifest.name, version: manifest.version, author: manifest.author,
        tokens: { light: resolveSkinPackageTokens(manifest.variants.light.tokens), dark: resolveSkinPackageTokens(manifest.variants.dark.tokens) }, backgrounds, visuals };
    } catch { return null; }
  }
  return {
    list, resolve,
    recoverRemovals(selectedId: string) {
      let entries: string[];
      try { entries = fs.readdirSync(options.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const name of entries) {
        const match = /^\.remove-([a-f0-9]{32})$/.exec(name);
        if (!match) continue;
        const id: InstalledDesktopSkinId = `pack:${match[1]}`;
        const tombstone = path.join(options.root, name);
        if (!fs.lstatSync(tombstone).isDirectory()) continue;
        if (id === selectedId && !fs.existsSync(directory(id))) fs.renameSync(tombstone, directory(id));
        else { try { fs.rmSync(tombstone, { recursive: true, force: true }); } catch { /* Retry owned cleanup on the next read. */ } }
      }
    },
    async install(filePath: string, assertOwner: () => void): Promise<InstalledDesktopSkinId> {
      const { manifest, images } = await readSkinPackageArchive(filePath);
      const existing = ids();
      for (const id of existing) {
        let installed: SkinPackageManifest;
        try { installed = readManifest(id); } catch { continue; }
        if (installed.id === manifest.id && installed.version === manifest.version) throw new SkinPackageError("packageExists");
      }
      if (existing.length >= limits.installed) throw new SkinPackageError("tooManySkins");
      const files = new Map<string, Buffer>(), names = new Map<string, string>();
      const visualPaths = new Set(Object.values(manifest.variants).flatMap(variant => Object.values(variant.visuals?.images ?? {})));
      let visualBytes = 0;
      for (const [original, bytes] of images) {
        if (visualPaths.has(original)) {
          const size = inspectBackgroundImage(bytes);
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || size.width > SKIN_VISUAL_LIMITS.maxDimension || size.height > SKIN_VISUAL_LIMITS.maxDimension) throw new SkinPackageError("invalidPackage");
        }
        const normalized = options.normalizeImage(bytes);
        if (visualPaths.has(original)) {
          visualBytes += normalized.data.length;
          if (normalized.width > SKIN_VISUAL_LIMITS.maxDimension || normalized.height > SKIN_VISUAL_LIMITS.maxDimension || normalized.data.length > SKIN_VISUAL_LIMITS.assetBytes || visualBytes > SKIN_VISUAL_LIMITS.totalBytes) throw new SkinPackageError("packageTooLarge");
        }
        const name = `image-${names.size}.png`;
        names.set(original, name); files.set(name, normalized.data);
      }
      const previewSource = manifest.preview ?? manifest.variants.light.background?.path ?? manifest.variants.dark.background?.path;
      if (previewSource) {
        const bytes = files.get(names.get(previewSource)!)!;
        const preview = options.makePreview ? options.makePreview(bytes) : bytes;
        if (preview.length <= PREVIEW_BYTES) files.set("preview.png", preview);
      }
      const stored: SkinPackageManifest = { ...manifest, preview: files.has("preview.png") ? "preview.png" : undefined,
        variants: { light: { ...manifest.variants.light }, dark: { ...manifest.variants.dark } } };
      for (const mode of ["light", "dark"] as const) {
        const visual = stored.variants[mode].visuals;
        if (visual) stored.variants[mode].visuals = { styles: visual.styles, images: Object.fromEntries(Object.entries(visual.images).map(([slot, name]) => [slot, names.get(name)!])) };
        const background = stored.variants[mode].background;
        if (background) stored.variants[mode].background = { ...background, path: names.get(background.path)! };
      }
      assertOwner();
      fs.mkdirSync(options.root, { recursive: true });
      const id: InstalledDesktopSkinId = `pack:${randomBytes(16).toString("hex")}`;
      const temporary = fs.mkdtempSync(path.join(options.root, ".install-"));
      try {
        for (const [name, bytes] of files) fs.writeFileSync(path.join(temporary, name), bytes, { flag: "wx" });
        fs.writeFileSync(path.join(temporary, "skin.json"), JSON.stringify(stored), { flag: "wx" });
        // New immutable directories avoid replace-in-place rename differences
        // between Windows and macOS. No existing version is overwritten.
        fs.renameSync(temporary, directory(id));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      return id;
    },
    remove(id: InstalledDesktopSkinId, commit: () => void) {
      const dir = directory(id);
      const tombstone = path.join(options.root, `.remove-${id.slice(5)}`);
      try {
        if (!fs.lstatSync(dir).isDirectory()) throw new Error("Invalid skin directory.");
        fs.renameSync(dir, tombstone);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { commit(); return; } throw error; }
      try { commit(); }
      catch (error) { fs.renameSync(tombstone, dir); throw error; }
      try { fs.rmSync(tombstone, { recursive: true, force: true }); } catch { /* Committed deletion; recoverRemovals retries cleanup. */ }
    }
  };
}
