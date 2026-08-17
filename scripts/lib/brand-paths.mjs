import path from "node:path";
import { BRAND_BUILD_ROOT_DIR, BRAND_RUNTIME_ASSET_DIR_NAME, normalizeBrandId, resolveBrandId } from "./brand-model.mjs";

export function electronBuilderConfigPath(rootDir = process.cwd(), brandId = resolveBrandId()) {
  return path.join(rootDir, brandBuildRelativePath(brandId, "electron-builder.json"));
}

export function normalizeBrandBuildTarget(target = currentBrandBuildTarget()) {
  return {
    os: normalizeTargetOs(target.os ?? process.platform),
    arch: normalizeTargetArch(target.arch ?? process.arch)
  };
}

export function brandBuildTargetKey(target = currentBrandBuildTarget()) {
  const normalized = normalizeBrandBuildTarget(target);
  return `${normalized.os}-${normalized.arch}`;
}

export function currentBrandBuildTarget() {
  return {
    os: normalizeTargetOs(process.platform),
    arch: normalizeTargetArch(process.arch)
  };
}

export function brandBuildRelativePath(brandOrId, ...segments) {
  return [BRAND_BUILD_ROOT_DIR, brandIdValue(brandOrId), ...segments].join("/");
}

export function brandBuildRoot(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId));
}

export function brandGeneratedDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "generated"));
}

export function brandRuntimeAssetDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, BRAND_RUNTIME_ASSET_DIR_NAME));
}

export function brandIconDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "icons"));
}

export function brandInstallerDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "installer"));
}

export function brandResourcesDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "resources"));
}

export function brandRendererDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "renderer"));
}

export function brandBundleDir(rootDir, brandOrId) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "bundle"));
}

export function brandBundleElectronDir(rootDir, brandOrId) {
  return path.join(brandBundleDir(rootDir, brandOrId), "dist-electron");
}

export function brandStageAppDir(rootDir, brandOrId, target = currentBrandBuildTarget()) {
  return path.join(rootDir, brandBuildRelativePath(brandOrId, "app", brandBuildTargetKey(target)));
}

function brandIdValue(brandOrId) {
  return normalizeBrandId(typeof brandOrId === "string" ? brandOrId : brandOrId?.id);
}

function normalizeTargetOs(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "darwin":
    case "linux":
    case "win32":
      return normalized;
    case "windows":
      return "win32";
    default:
      throw new Error(`unsupported target os: ${value}`);
  }
}

function normalizeTargetArch(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "x64":
    case "arm64":
      return normalized;
    case "amd64":
      return "x64";
    default:
      throw new Error(`unsupported target arch: ${value}`);
  }
}
