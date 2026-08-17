import { cleanupPublicBrandIconArtifacts, writeGeneratedBrandFiles } from "./brand-artifacts.mjs";
import { loadBrandConfig, resolveBrandId } from "./brand-model.mjs";
import { currentBrandBuildTarget } from "./brand-paths.mjs";
import { writeElectronBuilderConfig } from "./brand-packaging.mjs";
import {
  writeInstallerInclude,
  writeMacUninstallScript,
  writeSafeRepairScript
} from "./brand-installers.mjs";

export * from "./brand-model.mjs";
export * from "./brand-paths.mjs";
export * from "./brand-artifacts.mjs";
export * from "./brand-packaging.mjs";
export * from "./brand-installers.mjs";

export function syncBrandArtifacts({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  target = currentBrandBuildTarget()
} = {}) {
  const brand = loadBrandConfig(rootDir, brandId);

  writeGeneratedBrandFiles(rootDir, brand);
  writeElectronBuilderConfig(rootDir, brand, target);
  writeInstallerInclude(rootDir, brand);
  writeSafeRepairScript(rootDir, brand);
  writeMacUninstallScript(rootDir, brand);
  cleanupPublicBrandIconArtifacts(rootDir);

  return brand;
}
