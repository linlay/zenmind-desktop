import { pathApiForResolvedRoot, resolveRuntimeRoot, fileExists, resolveDesktopVersion } from "./runtime-env-paths";
import fs from "node:fs";
import { t } from "./runtime-environment-translator";
import {
  RuntimeEnvResetFailure,
  AppPathReader,
  AppPackageReader,
  RuntimeEnvResetResult,
  BundledEnvPackage,
  AppVersionReader
} from "./runtime-env-contracts";
import { resolveBundledEnvPackage, validateBundledEnvPackageManifest } from "./runtime-env-bundle";
import { importEnvZipToRuntime } from "./runtime-env-import";

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

export function createRuntimeEnvResetFailure(
  message: string,
  metadata: {
    runtimeRoot?: string;
    backupPath?: string;
    sourceZipPath?: string;
  },
  cause?: unknown
): RuntimeEnvResetFailure {
  const error = new Error(message) as RuntimeEnvResetFailure;
  error.runtimeRoot = metadata.runtimeRoot;
  error.backupPath = metadata.backupPath;
  error.sourceZipPath = metadata.sourceZipPath;
  if (cause) {
    (error as RuntimeEnvResetFailure & { cause?: unknown }).cause = cause;
  }
  return error;
}

export async function resetBundledRuntimeEnv(
  app: AppPathReader & AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  options: {
    resourcesRoot?: string;
    expectedDesktopVersion?: string;
    nowSeconds?: number;
  } = {}
): Promise<RuntimeEnvResetResult> {
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  if (platform !== "darwin" && platform !== "win32") {
    throw createRuntimeEnvResetFailure(t("envBootstrap.resetUnsupportedPlatform"), {});
  }
  let bundledPackage: BundledEnvPackage | null = null;
  try {
    if (platform === "darwin") {
      bundledPackage = resolveBundledEnvPackage(app, "darwin", options.resourcesRoot);
    } else {
      bundledPackage = resolveBundledEnvPackage(app, "win32", options.resourcesRoot);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createRuntimeEnvResetFailure(t("envBootstrap.resetFailed", { message }), { runtimeRoot }, error);
  }

  const sourceZipPath = bundledPackage?.zipPath ?? null;
  if (!bundledPackage || !sourceZipPath || !fileExists(sourceZipPath)) {
    throw createRuntimeEnvResetFailure(t("envBootstrap.bundledEnvZipMissing"), {
      runtimeRoot,
      sourceZipPath: sourceZipPath ?? undefined
    });
  }

  let backupPath: string | undefined;
  try {
    const desktopVersion = options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader);
    const zipBuffer = await fs.promises.readFile(sourceZipPath);
    validateBundledEnvPackageManifest(bundledPackage, zipBuffer, desktopVersion);
    if (fs.existsSync(runtimeRoot)) {
      if (!fs.statSync(runtimeRoot).isDirectory()) {
        throw new Error(t("envBootstrap.runtimeRootNotDirectory", { path: runtimeRoot }));
      }
      backupPath = generateBackupDirName(runtimeRoot, platform, options.nowSeconds);
      migrateOldRootToBackup(platform, runtimeRoot, backupPath);
    }

    const importResult = await importEnvZipToRuntime(
      app,
      sourceZipPath,
      platform,
      desktopVersion,
      { source: "reset" }
    );
    return {
      ...importResult,
      backupPath,
      sourceZipPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createRuntimeEnvResetFailure(t("envBootstrap.resetFailed", { message }), {
      runtimeRoot,
      backupPath,
      sourceZipPath
    }, error);
  }
}
