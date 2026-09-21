import {
  AppPathReader,
  ENV_INITIAL_PACKAGE_RELATIVE_PATH,
  AppPackageReader,
  ValidatedBundledEnvUpgradeInput,
  AppVersionReader
} from "./runtime-env-contracts";
import path from "node:path";
import { resolveRuntimeRoot, resolveDesktopVersion, fileExists } from "./runtime-env-paths";
import fs from "node:fs";
import {
  normalizeVersion,
  assertStrictArchiveEntry,
  normalizeZipEntries,
  validateEnvZipVersion,
  isRecord,
  sha256Hex
} from "./runtime-env-archive";
import { t } from "./runtime-environment-translator";
import { resolveBundledEnvPackage, validateBundledEnvPackageManifest } from "./runtime-env-bundle";
import JSZip from "jszip";
import { readProviderRegisterUpgradeInput } from "./runtime-environment-provider-register";

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
    desktopInit,
    providerRegister: await readProviderRegisterUpgradeInput(zip)
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
    desktopInit,
    providerRegister: await readProviderRegisterUpgradeInput(zip)
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
