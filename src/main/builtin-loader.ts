import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { Manifest } from "../shared/contracts";
import { readManifestFile, readManifestFromArchive } from "./manifest-utils";
import { clearServices, registerService } from "./services/service-registry";
import { beginStartupTiming } from "./startup-timing";
import { getServicesRoot } from "./user-paths";

const manifestCache = new Map<string, { key: string; manifest: Manifest }>();

function isPackaged(app: App) {
  return app.isPackaged;
}

export function getBuiltinAssetsRoot(app: App) {
  if (process.env.DESKTOP_BUILTIN_ASSETS_ROOT) {
    return process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
  }
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

function listInstalledBuiltinManifestPaths(app: App) {
  const servicesRoot = getServicesRoot(app);
  if (!fs.existsSync(servicesRoot)) {
    return [];
  }

  const manifestPaths: string[] = [];
  for (const serviceEntry of fs.readdirSync(servicesRoot, { withFileTypes: true })) {
    if (!serviceEntry.isDirectory()) {
      continue;
    }
    const serviceRoot = path.join(servicesRoot, serviceEntry.name);
    for (const versionEntry of fs.readdirSync(serviceRoot, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(serviceRoot, versionEntry.name, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        manifestPaths.push(manifestPath);
      }
    }
  }

  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

function loadInstalledBuiltinServices(app: App, ignoredServiceIds: Set<string> = new Set()) {
  const latestByServiceId = new Map<string, { manifestPath: string; manifest: Manifest }>();

  for (const manifestPath of listInstalledBuiltinManifestPaths(app)) {
    try {
      const manifest = readManifestFile(manifestPath);
      if (manifest.kind !== "builtin") {
        continue;
      }
      if (ignoredServiceIds.has(manifest.id)) {
        continue;
      }
      if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
        continue;
      }
      const current = latestByServiceId.get(manifest.id);
      if (!current || manifest.version.localeCompare(current.manifest.version) > 0) {
        latestByServiceId.set(manifest.id, { manifestPath, manifest });
      }
    } catch (error) {
      console.warn(`[builtin-loader] failed to read installed builtin manifest ${manifestPath}`, error);
    }
  }

  const loaded = [];
  for (const { manifestPath, manifest } of latestByServiceId.values()) {
    try {
      loaded.push(registerService(manifest, { defaultKind: "builtin" }));
    } catch (error) {
      console.warn(`[builtin-loader] failed to register installed builtin manifest ${manifestPath}`, error);
    }
  }

  return loaded.sort((left, right) => left.id.localeCompare(right.id));
}

export function loadBuiltinServices(app: App) {
  const timing = beginStartupTiming("loadBuiltinServices");
  let loadedCount = 0;
  try {
    clearServices("builtin");

    const builtinAssetsRoot = getBuiltinAssetsRoot(app);
    const loaded = [];
    const loadedServiceIds = new Set<string>();
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
        loadedServiceIds.add(definition.id);
      }
    }

    loaded.push(...loadInstalledBuiltinServices(app, loadedServiceIds));
    const sorted = loaded.sort((left, right) => left.id.localeCompare(right.id));
    loadedCount = sorted.length;
    return sorted;
  } finally {
    timing.end({ count: loadedCount });
  }
}
