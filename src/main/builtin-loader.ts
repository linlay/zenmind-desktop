import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { Manifest } from "../shared/contracts";
import { readManifestFromArchive } from "./manifest-utils";
import { clearServices, registerService } from "./service-registry";

const manifestCache = new Map<string, { key: string; manifest: Manifest }>();

function isPackaged(app: App) {
  return app.isPackaged;
}

export function getBuiltinAssetsRoot(app: App) {
  if (process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT) {
    return process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  }
  return isPackaged(app)
    ? path.join(process.resourcesPath, "services")
    : path.join(process.cwd(), "build", "resources", "services");
}

function listBuiltinArchivePaths(root: string) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const extension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const archivePaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceDir = path.join(root, entry.name);
    for (const asset of fs.readdirSync(serviceDir, { withFileTypes: true })) {
      if (!asset.isFile() || !asset.name.endsWith(extension)) {
        continue;
      }
      archivePaths.push(path.join(serviceDir, asset.name));
    }
  }

  archivePaths.sort((left, right) => left.localeCompare(right));
  return archivePaths;
}

function readCachedManifest(tarPath: string) {
  const stat = fs.statSync(tarPath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = manifestCache.get(tarPath);
  if (cached && cached.key === cacheKey) {
    return cached.manifest;
  }

  const manifest = readManifestFromArchive(tarPath);
  manifestCache.set(tarPath, {
    key: cacheKey,
    manifest
  });
  return manifest;
}

function getCurrentManifestOs() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function isPlatformMatch(manifestOs: string) {
  return manifestOs.trim().toLowerCase() === getCurrentManifestOs();
}

export function loadBuiltinServices(app: App) {
  clearServices("builtin");

  const builtinAssetsRoot = getBuiltinAssetsRoot(app);
  const loaded = [];
  for (const tarPath of listBuiltinArchivePaths(builtinAssetsRoot)) {
    const manifest = readCachedManifest(tarPath);
    if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
      continue;
    }
    const definition = registerService(manifest, {
      defaultKind: "builtin",
      desktop: {
        assetFileName: path.basename(tarPath)
      }
    });
    if (definition.kind === "builtin") {
      loaded.push(definition);
    }
  }

  return loaded;
}
