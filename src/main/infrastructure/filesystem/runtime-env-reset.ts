import { pathApiForResolvedRoot } from "./runtime-env-paths";
import fs from "node:fs";
import { t } from "./runtime-environment-translator";

export function generateBackupDirName(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const pathApi = pathApiForResolvedRoot(platform, rootPath);
  const dirName = pathApi.basename(rootPath);
  const parentDir = pathApi.dirname(rootPath);
  let backupName = `${dirName}-${nowSeconds}`;
  let backupPath = pathApi.join(parentDir, backupName);
  let counter = 0;
  while (fs.existsSync(backupPath)) {
    counter += 1;
    backupName = `${dirName}-${nowSeconds}-${counter}`;
    backupPath = pathApi.join(parentDir, backupName);
  }
  return backupPath;
}

export function migrateOldRootToBackup(
  platform: NodeJS.Platform,
  rootPath: string,
  backupPath = generateBackupDirName(rootPath, platform)
): string {
  if (fs.existsSync(backupPath)) {
    throw new Error(t("envBootstrap.backupExists", { path: backupPath }));
  }
  fs.renameSync(rootPath, backupPath);
  return backupPath;
}

export function shouldPromptEnvRootConflict(input: {
  platform: NodeJS.Platform;
  isFirstDesktopInstall: boolean;
  bundledEnvZipExists: boolean;
  runtimeRootExistedAtStartup: boolean;
}): boolean {
  if (input.platform !== "darwin") {
    return false;
  }
  if (!input.isFirstDesktopInstall) {
    return false;
  }
  if (!input.bundledEnvZipExists) {
    return false;
  }
  if (!input.runtimeRootExistedAtStartup) {
    return false;
  }
  return true;
}
