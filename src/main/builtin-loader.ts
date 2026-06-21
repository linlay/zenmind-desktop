import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { Manifest } from "../shared/contracts";
import { readManifestFile, readManifestFromArchive } from "./manifest-utils";
import { clearServices, registerService } from "./services/service-registry";
import { beginStartupTiming } from "./startup-timing";
import { getServicesRoot } from "./user-paths";

const manifestCache = new Map<string, { key: string; manifest: Manifest }>();

type BuiltinAssetIndexEntry = {
  id: string;
  version: string;
  assetFileName: string;
  assetType?: "archive" | "directory";
};

function isPackaged(app: App) {
  return app.isPackaged;
}

export function getBuiltinAssetsRoot(app: App) {
  if (process.env.DESKTOP_BUILTIN_ASSETS_ROOT) {
    return process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
  }
  return isPackaged(app)
    ? path.join(process.resourcesPath, "services")
    : path.join(process.cwd(), "build", "resources", "services");
}

function archiveExtensionsForCurrentPlatform() {
  if (process.platform === "win32") {
    return [".zip"];
  }
  if (process.platform === "darwin") {
    return [".tar.gz", ".tgz"];
  }
  return [".tar.gz", ".tgz"];
}

function isArchiveAssetFileName(fileName: string) {
  const normalized = fileName.toLowerCase();
  return archiveExtensionsForCurrentPlatform().some((extension) => normalized.endsWith(extension));
}

function isDirectoryBuiltinAsset(assetPath: string) {
  return fs.existsSync(path.join(assetPath, "manifest.json"));
}

function listBuiltinAssetPaths(root: string) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const assetPaths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceDir = path.join(root, entry.name);
    for (const asset of fs.readdirSync(serviceDir, { withFileTypes: true })) {
      const assetPath = path.join(serviceDir, asset.name);
      if (asset.isDirectory() && isDirectoryBuiltinAsset(assetPath)) {
        assetPaths.push(assetPath);
        continue;
      }
      if (asset.isFile() && isArchiveAssetFileName(asset.name)) {
        assetPaths.push(assetPath);
      }
    }
  }

  assetPaths.sort((left, right) => left.localeCompare(right));
  return assetPaths;
}

function readBuiltinAssetIndex(root: string) {
  const indexPath = path.join(root, "manifest.json");
  const byAssetFileName = new Map<string, BuiltinAssetIndexEntry>();
  if (!fs.existsSync(indexPath)) {
    return byAssetFileName;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    const services = parsed && typeof parsed === "object" && Array.isArray((parsed as { services?: unknown }).services)
      ? (parsed as { services: unknown[] }).services
      : [];
    for (const item of services) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const version = typeof record.version === "string" ? record.version.trim() : "";
      const assetFileName = typeof record.assetFileName === "string" ? record.assetFileName.trim() : "";
      const assetType = record.assetType === "archive" || record.assetType === "directory"
        ? record.assetType
        : undefined;
      if (id && version && assetFileName) {
        byAssetFileName.set(assetFileName, { id, version, assetFileName, assetType });
      }
    }
  } catch (error) {
    console.warn(`[builtin-loader] failed to read builtin asset index ${indexPath}`, error);
  }

  return byAssetFileName;
}

function readCachedManifest(assetPath: string) {
  const statPath = fs.statSync(assetPath).isDirectory()
    ? path.join(assetPath, "manifest.json")
    : assetPath;
  const stat = fs.statSync(statPath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = manifestCache.get(assetPath);
  if (cached && cached.key === cacheKey) {
    return cached.manifest;
  }

  const manifest = fs.statSync(assetPath).isDirectory()
    ? readManifestFile(path.join(assetPath, "manifest.json"))
    : readManifestFromArchive(assetPath);
  manifestCache.set(assetPath, {
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

function normalizeBuiltinVersion(version: string) {
  return version
    .trim()
    .replace(/^v/iu, "")
    .split(".")
    .map((segment) => {
      const match = segment.match(/^(\d+)(.*)$/u);
      if (!match) {
        return { number: Number.NaN, suffix: segment };
      }
      return {
        number: Number.parseInt(match[1], 10),
        suffix: match[2] ?? ""
      };
    });
}

function compareBuiltinVersions(leftVersion: string, rightVersion: string) {
  const left = normalizeBuiltinVersion(leftVersion);
  const right = normalizeBuiltinVersion(rightVersion);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? { number: 0, suffix: "" };
    const rightPart = right[index] ?? { number: 0, suffix: "" };
    const leftNumber = Number.isFinite(leftPart.number) ? leftPart.number : -1;
    const rightNumber = Number.isFinite(rightPart.number) ? rightPart.number : -1;
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftPart.suffix !== rightPart.suffix) {
      return leftPart.suffix.localeCompare(rightPart.suffix);
    }
  }
  return 0;
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

function loadInstalledBuiltinServices(app: App) {
  const latestByServiceId = new Map<string, { manifestPath: string; manifest: Manifest }>();

  for (const manifestPath of listInstalledBuiltinManifestPaths(app)) {
    try {
      const manifest = readManifestFile(manifestPath);
      const manifestKind = manifest && typeof manifest === "object" && !Array.isArray(manifest)
        ? (manifest as { kind?: unknown }).kind
        : undefined;
      if (manifestKind !== "builtin") {
        continue;
      }
      if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
        continue;
      }
      const current = latestByServiceId.get(manifest.id);
      if (!current || compareBuiltinVersions(manifest.version, current.manifest.version) > 0) {
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
    const registeredByServiceId = new Map(
      loadInstalledBuiltinServices(app).map((definition) => [definition.id, definition])
    );
    const assetIndex = readBuiltinAssetIndex(builtinAssetsRoot);

    for (const assetPath of listBuiltinAssetPaths(builtinAssetsRoot)) {
      const assetFileName = path.basename(assetPath);
      const indexedAsset = assetIndex.get(assetFileName);
      const installed = indexedAsset ? registeredByServiceId.get(indexedAsset.id) : undefined;
      if (indexedAsset && installed && compareBuiltinVersions(installed.version, indexedAsset.version) > 0) {
        continue;
      }

      const manifest = readCachedManifest(assetPath);
      if (manifest.platform?.os && !isPlatformMatch(manifest.platform.os)) {
        continue;
      }
      const definition = registerService(manifest, {
        defaultKind: "builtin",
        desktop: {
          assetFileName
        }
      });
      if (definition.kind === "builtin") {
        registeredByServiceId.set(definition.id, definition);
      }
    }

    const sorted = [...registeredByServiceId.values()].sort((left, right) => left.id.localeCompare(right.id));
    loadedCount = sorted.length;
    return sorted;
  } finally {
    timing.end({ count: loadedCount });
  }
}
