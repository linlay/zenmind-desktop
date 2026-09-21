import {
  BundledEnvManifest,
  ENV_ZIP_FILE_NAME,
  AppPackageReader,
  BundledEnvPackage,
  BUNDLED_ENV_RESOURCES_DIR_NAME,
  ENV_ZIP_MANIFEST_FILE_NAME
} from "./runtime-env-contracts";
import { fileExists, supportsBundledEnvResources, bundledResourcesRootCandidates } from "./runtime-env-paths";
import fs from "node:fs";
import { isRecord, normalizeVersion, sha256Hex } from "./runtime-env-archive";
import { t } from "./runtime-environment-translator";
import path from "node:path";

export function readBundledEnvManifest(manifestPath: string): BundledEnvManifest | null {
  if (!fileExists(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.bundled !== "boolean") {
      throw new Error("invalid bundled flag");
    }
    const fileName = parsed.fileName;
    if (parsed.bundled) {
      if (fileName !== ENV_ZIP_FILE_NAME) {
        throw new Error("invalid file name");
      }
    } else if (fileName !== null) {
      throw new Error("unbundled manifest must not name a package");
    }
    if (parsed.version !== undefined && typeof parsed.version !== "string") {
      throw new Error("invalid version");
    }
    if (parsed.size !== undefined && (
      typeof parsed.size !== "number" ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size < 0
    )) {
      throw new Error("invalid size");
    }
    if (parsed.sha256 !== undefined && (
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(parsed.sha256)
    )) {
      throw new Error("invalid sha256");
    }
    return {
      bundled: parsed.bundled,
      fileName: parsed.bundled ? ENV_ZIP_FILE_NAME : null,
      ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
      ...(typeof parsed.size === "number" ? { size: parsed.size } : {}),
      ...(typeof parsed.sha256 === "string" ? { sha256: parsed.sha256.toLowerCase() } : {})
    };
  } catch {
    throw new Error(t("envBootstrap.resourceSyncManifestInvalid", { path: manifestPath }));
  }
}

export function resolveBundledEnvPackage(
  app: AppPackageReader,
  platform: NodeJS.Platform,
  resourcesRootOverride?: string
): BundledEnvPackage | null {
  if (!supportsBundledEnvResources(app, platform)) {
    return null;
  }

  const roots = bundledResourcesRootCandidates(app, resourcesRootOverride);
  for (const resourcesRoot of roots) {
    const envRoot = path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME);
    const manifestPath = path.join(envRoot, ENV_ZIP_MANIFEST_FILE_NAME);
    const manifest = readBundledEnvManifest(manifestPath);
    const zipPath = path.join(envRoot, ENV_ZIP_FILE_NAME);
    if (manifest) {
      if (!manifest.bundled) {
        return null;
      }
      if (!fileExists(zipPath)) {
        throw new Error(t("envBootstrap.resourceSyncBundleMissing", { path: zipPath }));
      }
      return { zipPath, manifest };
    }
    if (fileExists(zipPath)) {
      return { zipPath };
    }
  }
  return null;
}

export function validateBundledEnvPackageManifest(
  bundledPackage: BundledEnvPackage,
  zipBuffer: Buffer,
  expectedDesktopVersion: string
) {
  const manifest = bundledPackage.manifest;
  if (!manifest) {
    return;
  }
  if (
    manifest.version !== undefined &&
    normalizeVersion(manifest.version) !== normalizeVersion(expectedDesktopVersion)
  ) {
    throw new Error(t("envBootstrap.versionMismatch", {
      expected: normalizeVersion(expectedDesktopVersion),
      actual: normalizeVersion(manifest.version)
    }));
  }
  if (manifest.size !== undefined && manifest.size !== zipBuffer.byteLength) {
    throw new Error(t("envBootstrap.resourceSyncIntegrity", { path: bundledPackage.zipPath }));
  }
  if (manifest.sha256 !== undefined && manifest.sha256 !== sha256Hex(zipBuffer)) {
    throw new Error(t("envBootstrap.resourceSyncIntegrity", { path: bundledPackage.zipPath }));
  }
}
