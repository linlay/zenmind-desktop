import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { ServiceDefinition } from "../../manifest-utils";
import { getBuiltinAssetsRoot } from "../../builtin-loader";
import { listArchiveEntries } from "../../archive-utils";

const bundleValidationCache = new Map<string, { key: string; missingEntries: string[] }>();
const syncedAssetManifestCache = new Map<string, { key: string; services: SyncedAssetManifestService[] }>();

type SyncedAssetManifestService = {
  id?: unknown;
  version?: unknown;
  assetFileName?: unknown;
  assetSignature?: unknown;
};

function getAssetPath(app: App, service: ServiceDefinition) {
  if (!service.desktop.assetFileName) {
    throw new Error(`桌面端内置资源缺少 assetFileName：${service.id}`);
  }
  return path.join(getBuiltinAssetsRoot(app), service.id, service.desktop.assetFileName);
}

export function computeAssetSignature(assetPath: string) {
  const stat = fs.statSync(assetPath);
  const hash = createHash("sha256")
    .update(fs.readFileSync(assetPath))
    .digest("hex");
  return `${stat.size}:${hash}`;
}

export function moveExtractedBuiltinRoot(extractedRoot: string, finalInstallDir: string) {
  try {
    fs.renameSync(extractedRoot, finalInstallDir);
    return;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EXDEV") {
      throw error;
    }
  }

  fs.cpSync(extractedRoot, finalInstallDir, { recursive: true, force: true });
  fs.rmSync(extractedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function readSyncedBuiltinAssetManifest(app: App) {
  const manifestPath = path.join(getBuiltinAssetsRoot(app), "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const stat = fs.statSync(manifestPath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = syncedAssetManifestCache.get(manifestPath);
    if (cached && cached.key === cacheKey) {
      return cached.services;
    }

    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { services?: unknown };
    const services = Array.isArray(parsed.services)
      ? parsed.services.filter((item): item is SyncedAssetManifestService => Boolean(item) && typeof item === "object")
      : [];
    syncedAssetManifestCache.set(manifestPath, {
      key: cacheKey,
      services
    });
    return services;
  } catch {
    return [];
  }
}

function readSyncedBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  const assetFileName = service.desktop.assetFileName;
  if (!assetFileName) {
    return undefined;
  }

  const match = readSyncedBuiltinAssetManifest(app).find((entry) =>
    entry.id === service.id &&
    entry.version === service.version &&
    entry.assetFileName === assetFileName &&
    typeof entry.assetSignature === "string" &&
    entry.assetSignature.trim().length > 0
  );

  return typeof match?.assetSignature === "string" ? match.assetSignature : undefined;
}

export function readBuiltinAssetSignature(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return undefined;
  }
  const syncedSignature = readSyncedBuiltinAssetSignature(app, service);
  if (syncedSignature) {
    return syncedSignature;
  }
  const assetPath = getOptionalBundleAssetPath(app, service);
  return assetPath ? computeAssetSignature(assetPath) : undefined;
}

export function listMissingRuntimeFiles(service: ServiceDefinition, installDir: string) {
  return service.runtime.requiredPaths.filter((relativePath) => !fs.existsSync(path.join(installDir, relativePath)));
}

export function isInstallHealthy(service: ServiceDefinition, installDir: string) {
  return listMissingRuntimeFiles(service, installDir).length === 0;
}

function listTarEntries(archivePath: string) {
  return listArchiveEntries(archivePath);
}

export function listMissingBundleEntries(service: ServiceDefinition, archivePath: string) {
  const stat = fs.statSync(archivePath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = bundleValidationCache.get(archivePath);
  if (cached && cached.key === cacheKey) {
    return cached.missingEntries;
  }

  const entries = listTarEntries(archivePath);
  const missingEntries = service.runtime.requiredPaths.filter((relativePath) => {
    const normalizedRelativePath = relativePath.replace(/\\/g, "/");
    const expectedPath = `${service.desktop.bundleTopLevelDir}/${normalizedRelativePath}`;
    if (entries.has(expectedPath) || entries.has(`${expectedPath}/`)) {
      return false;
    }
    const backslashPath = expectedPath.replace(/\//g, "\\");
    if (entries.has(backslashPath) || entries.has(`${backslashPath}\\`)) {
      return false;
    }
    const prefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    const backslashPrefix = backslashPath.endsWith("\\") ? backslashPath : `${backslashPath}\\`;
    return ![...entries].some(
      (entry) => entry.startsWith(prefix) || entry.startsWith(backslashPrefix)
    );
  });
  bundleValidationCache.set(archivePath, {
    key: cacheKey,
    missingEntries
  });
  return missingEntries;
}

export function ensureArchiveHealthy(service: ServiceDefinition, archivePath: string, sourceLabel: string) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`${sourceLabel}缺失：${archivePath}`);
  }
  if (!archivePath.toLowerCase().endsWith(".zip")) {
    throw new Error(`${sourceLabel}必须是 .zip 包：${archivePath}`);
  }

  const missingEntries = listMissingBundleEntries(service, archivePath);
  if (missingEntries.length > 0) {
    throw new Error(`${sourceLabel}不完整，缺少：${missingEntries.join(", ")}`);
  }

  return archivePath;
}

export function ensureBundleAssetHealthy(app: App, service: ServiceDefinition) {
  return ensureArchiveHealthy(service, getAssetPath(app, service), "桌面端内置资源");
}

export function getOptionalBundleAssetPath(app: App, service: ServiceDefinition) {
  try {
    return ensureBundleAssetHealthy(app, service);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[service-manager] builtin asset unavailable for ${service.id}; using installed service when possible: ${message}`
    );
    return null;
  }
}
