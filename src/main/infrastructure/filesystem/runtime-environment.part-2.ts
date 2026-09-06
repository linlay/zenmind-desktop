import fs from "node:fs";

import { createHash } from "node:crypto";

import os from "node:os";

import path from "node:path";

import type { App } from "electron";

import JSZip from "jszip";

import { APP_BRAND } from "../../../shared/brand";

import { resolveRuntimeRootPath } from "./runtime-root";

import { isDesktopDevelopmentRuntime } from "../electron/development-runtime";

import { AppPackageReader, AppPathReader, AppVersionReader, BUNDLED_ENV_RESOURCES_DIR_NAME, BundledEnvManifest, BundledEnvPackage, BundledEnvZipImportResult, ENV_IMPORT_MARKER_RELATIVE_PATH, ENV_INITIAL_PACKAGE_RELATIVE_PATH, ENV_ZIP_FILE_NAME, ENV_ZIP_MANIFEST_FILE_NAME, ENV_ZIP_ROOT_DIR_NAME, EnvZipImportResult, InitialEnvPackageRecord, InitialEnvPackageSource, RuntimeEnvResetFailure, RuntimeEnvResetResult, ValidatedBundledEnvUpgradeInput, bundledResourcesRootCandidates, entrySegments, fileExists, isRecord, normalizeEnvZipEntryRelativePath, normalizeVersion, normalizeZipEntries, pathApiForResolvedRoot, persistInitialEnvPackage, resolveDesktopVersion, resolveRuntimeRoot, resolveSafeTargetPath, restoreImportedShellScriptPermissions, sha256Hex, supportsBundledEnvResources, validateEnvZipVersion } from "./runtime-environment.part-1";

import { t } from "./runtime-environment-translator";

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

export function assertStrictArchiveEntry(entry: JSZip.JSZipObject) {
  const originalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
  if (originalName.includes("\\") || originalName.includes("\0")) {
    throw new Error(t("envBootstrap.unsafePath", { path: originalName }));
  }
  const segments = entrySegments(originalName);
  if (segments.length === 0 || segments[0] !== ENV_ZIP_ROOT_DIR_NAME) {
    throw new Error(t("envBootstrap.rootDirRequired", { path: originalName }));
  }
  normalizeEnvZipEntryRelativePath(originalName);

  const rawPermissions = entry.unixPermissions;
  const permissions = typeof rawPermissions === "string"
    ? Number.parseInt(rawPermissions, 8)
    : rawPermissions;
  if (typeof permissions !== "number") {
    return;
  }
  const fileType = permissions & 0o170000;
  if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
    throw new Error(t("envBootstrap.resourceSyncSymlink", { path: originalName }));
  }
}

export function resolvePreviousRuntimeResourceSource(app: AppPathReader, platform: NodeJS.Platform) {
  const previousSource = path.join(resolveRuntimeRoot(app, platform), ENV_INITIAL_PACKAGE_RELATIVE_PATH);
  try {
    const stat = fs.lstatSync(previousSource);
    return !stat.isSymbolicLink() && stat.isFile() ? previousSource : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function validateBundledEnvForDesktopVersionUpgrade(
  app: AppPathReader & AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  options: {
    resourcesRoot?: string;
    expectedDesktopVersion?: string;
  } = {}
): Promise<ValidatedBundledEnvUpgradeInput> {
  const desktopVersion = normalizeVersion(
    options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader)
  );
  if (!desktopVersion) {
    throw new Error(t("envBootstrap.desktopVersionEmpty"));
  }
  const bundledPackage = resolveBundledEnvPackage(app, platform, options.resourcesRoot);
  if (!bundledPackage) {
    throw new Error(t("envBootstrap.bundledEnvZipMissing"));
  }
  const sourceStat = fs.lstatSync(bundledPackage.zipPath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(t("envBootstrap.resourceSyncTypeConflict", { path: bundledPackage.zipPath }));
  }
  if (
    !bundledPackage.manifest ||
    typeof bundledPackage.manifest.version !== "string" ||
    typeof bundledPackage.manifest.size !== "number" ||
    typeof bundledPackage.manifest.sha256 !== "string"
  ) {
    throw new Error(`Bundled env manifest must declare version, size, and sha256: ${bundledPackage.zipPath}`);
  }

  const zipBuffer = await fs.promises.readFile(bundledPackage.zipPath);
  validateBundledEnvPackageManifest(bundledPackage, zipBuffer, desktopVersion);
  const zip = await JSZip.loadAsync(zipBuffer);
  for (const entry of Object.values(zip.files)) {
    assertStrictArchiveEntry(entry);
  }
  const entries = normalizeZipEntries(zip);
  await validateEnvZipVersion(entries, desktopVersion);
  const desktopInitEntry = entries.find(
    (entry) => !entry.directory && entry.relativePath === "desktop-init.json"
  );
  if (!desktopInitEntry) {
    throw new Error("Bundled env.zip requires env/desktop-init.json for a Desktop version change.");
  }
  let desktopInit: unknown;
  try {
    desktopInit = JSON.parse(await desktopInitEntry.entry.async("string")) as unknown;
  } catch (error) {
    throw new Error(`Bundled desktop-init.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(desktopInit)) {
    throw new Error("Bundled desktop-init.json must be a JSON object.");
  }

  const previousSourceZipPath = resolvePreviousRuntimeResourceSource(app, platform);
  return {
    sourceZipPath: bundledPackage.zipPath,
    ...(previousSourceZipPath ? { previousSourceZipPath } : {}),
    desktopVersion,
    sha256: sha256Hex(zipBuffer),
    size: zipBuffer.byteLength,
    desktopInit
  };
}

export async function validateEnvZipForDesktopManualImport(
  app: AppPathReader,
  zipPath: string,
  expectedDesktopVersion: string,
  platform: NodeJS.Platform = process.platform
): Promise<ValidatedBundledEnvUpgradeInput> {
  return validateSelectedEnvZipForDesktopVersionUpgrade(
    app,
    zipPath,
    expectedDesktopVersion,
    platform,
    "manual-import"
  );
}

export async function validateSelectedEnvZipForDesktopVersionUpgrade(
  app: AppPathReader,
  zipPath: string,
  expectedDesktopVersion: string,
  platform: NodeJS.Platform = process.platform,
  purpose: "version-change" | "manual-import" = "version-change"
): Promise<ValidatedBundledEnvUpgradeInput> {
  const desktopVersion = normalizeVersion(expectedDesktopVersion);
  if (!desktopVersion) {
    throw new Error(t("envBootstrap.desktopVersionEmpty"));
  }
  const sourcePath = path.resolve(zipPath);
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(t("envBootstrap.resourceSyncTypeConflict", { path: sourcePath }));
  }
  const zipBuffer = await fs.promises.readFile(sourcePath);
  const zip = await JSZip.loadAsync(zipBuffer);
  for (const entry of Object.values(zip.files)) {
    assertStrictArchiveEntry(entry);
  }
  const entries = normalizeZipEntries(zip);
  await validateEnvZipVersion(entries, desktopVersion);
  const desktopInitEntry = entries.find(
    (entry) => !entry.directory && entry.relativePath === "desktop-init.json"
  );
  if (!desktopInitEntry) {
    throw new Error(purpose === "manual-import"
      ? "env.zip requires env/desktop-init.json for manual import into an existing runtime."
      : "env.zip requires env/desktop-init.json for a Desktop version change.");
  }
  let desktopInit: unknown;
  try {
    desktopInit = JSON.parse(await desktopInitEntry.entry.async("string")) as unknown;
  } catch (error) {
    throw new Error(`desktop-init.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(desktopInit)) {
    throw new Error("desktop-init.json must be a JSON object.");
  }
  const previousSourceZipPath = resolvePreviousRuntimeResourceSource(app, platform);
  return {
    sourceZipPath: sourcePath,
    ...(previousSourceZipPath ? { previousSourceZipPath } : {}),
    desktopVersion,
    sha256: sha256Hex(zipBuffer),
    size: zipBuffer.byteLength,
    desktopInit
  };
}

export async function stageValidatedDesktopVersionUpgradeInput(
  validated: ValidatedBundledEnvUpgradeInput,
  inputDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<ValidatedBundledEnvUpgradeInput> {
  fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    fs.chmodSync(inputDir, 0o700);
  }

  const targetPath = path.join(inputDir, `env-${validated.sha256.toLowerCase()}.zip`);
  if (fileExists(targetPath)) {
    const existingBuffer = await fs.promises.readFile(targetPath);
    if (
      existingBuffer.byteLength !== validated.size ||
      sha256Hex(existingBuffer) !== validated.sha256.toLowerCase()
    ) {
      // This is a content-addressed file owned by the current Desktop upgrade
      // transaction. A corrupt partial can be replaced by the same validated SHA.
      fs.rmSync(targetPath, { force: true });
    } else {
      return { ...validated, sourceZipPath: targetPath };
    }
  }

  const temporaryPath = path.join(inputDir, `.env-${validated.sha256}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.copyFile(validated.sourceZipPath, temporaryPath);
    if (platform !== "win32") {
      fs.chmodSync(temporaryPath, 0o600);
    }
    const stagedBuffer = await fs.promises.readFile(temporaryPath);
    if (
      stagedBuffer.byteLength !== validated.size ||
      sha256Hex(stagedBuffer) !== validated.sha256.toLowerCase()
    ) {
      throw new Error(`staged env.zip failed its integrity check: ${temporaryPath}`);
    }
    fs.renameSync(temporaryPath, targetPath);
    return { ...validated, sourceZipPath: targetPath };
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function writeEnvImportMarker(
  targetRoot: string,
  result: Omit<EnvZipImportResult, "targetRoot">,
  initialEnvPackage?: InitialEnvPackageRecord
) {
  const markerPath = path.join(targetRoot, ENV_IMPORT_MARKER_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      importedAt: new Date().toISOString(),
      copiedFiles: result.copiedFiles,
      skippedFiles: result.skippedFiles,
      overwrittenFiles: result.overwrittenFiles,
      ...(initialEnvPackage ? { initialEnvPackage } : {})
    }, null, 2)}\n`,
    "utf8"
  );
}

export async function importEnvZipToRuntime(
  app: AppPathReader,
  zipPath: string,
  platform: NodeJS.Platform = process.platform,
  expectedDesktopVersion: string = resolveDesktopVersion(app as AppVersionReader),
  options: {
    source?: InitialEnvPackageSource;
  } = {}
): Promise<EnvZipImportResult> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") {
    throw new Error(t("envBootstrap.firstInstallZipOnly"));
  }

  const targetRoot = resolveRuntimeRoot(app, platform);

  const zipBuffer = await fs.promises.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = normalizeZipEntries(zip);
  await validateEnvZipVersion(entries, expectedDesktopVersion);
  let copiedFiles = 0;
  let skippedFiles = 0;
  const overwrittenFiles = 0;
  let createdDirectories = 0;

  fs.mkdirSync(targetRoot, { recursive: true });

  for (const entry of entries) {
    const targetPath = resolveSafeTargetPath(targetRoot, entry.relativePath);
    if (entry.directory) {
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
        createdDirectories += 1;
      }
      continue;
    }

    if (fs.existsSync(targetPath)) {
      skippedFiles += 1;
      restoreImportedShellScriptPermissions(targetPath, platform);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, await entry.entry.async("nodebuffer"));
    restoreImportedShellScriptPermissions(targetPath, platform);
    copiedFiles += 1;
  }

  if (copiedFiles + skippedFiles === 0) {
    throw new Error(t("envBootstrap.emptyImport"));
  }

  const initialEnvPackage = await persistInitialEnvPackage({
    targetRoot,
    zipPath,
    zipBuffer,
    source: options.source ?? "manual",
    desktopVersion: expectedDesktopVersion
  });

  writeEnvImportMarker(targetRoot, {
    copiedFiles,
    skippedFiles,
    overwrittenFiles,
    createdDirectories
  }, initialEnvPackage);

  return {
    targetRoot,
    copiedFiles,
    skippedFiles,
    overwrittenFiles,
    createdDirectories
  };
}

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

export function bundledEnvZipExists(
  app: AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  resourcesRootOverride?: string
) {
  try {
    return resolveBundledEnvPackage(app, platform, resourcesRootOverride) !== null;
  } catch {
    // A declared bundle with an invalid manifest or a missing payload must still
    // enter strict validation so the concrete packaging error is reported.
    return true;
  }
}

export async function importBundledEnvZipToRuntime(
  app: AppPathReader & AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  options: {
    resourcesRoot?: string;
    expectedDesktopVersion?: string;
  } = {}
): Promise<BundledEnvZipImportResult | null> {
  const bundledPackage = resolveBundledEnvPackage(app, platform, options.resourcesRoot);
  if (!bundledPackage) {
    return null;
  }

  const desktopVersion = options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader);
  const zipBuffer = await fs.promises.readFile(bundledPackage.zipPath);
  validateBundledEnvPackageManifest(bundledPackage, zipBuffer, desktopVersion);

  const result = await importEnvZipToRuntime(
    app,
    bundledPackage.zipPath,
    platform,
    desktopVersion,
    { source: "bundled" }
  );
  return {
    ...result,
    sourceZipPath: bundledPackage.zipPath
  };
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
