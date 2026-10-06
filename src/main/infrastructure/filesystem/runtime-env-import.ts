import {
  EnvZipImportResult,
  InitialEnvPackageRecord,
  ENV_IMPORT_MARKER_RELATIVE_PATH,
  ENV_IMPORT_PENDING_RELATIVE_PATH,
  AppPathReader,
  AppVersionReader,
  InitialEnvPackageSource,
  AppPackageReader,
  BundledEnvZipImportResult
} from "./runtime-env-contracts";
import path from "node:path";
import fs from "node:fs";
import { resolveDesktopVersion, resolveRuntimeRoot } from "./runtime-env-paths";
import { t } from "./runtime-environment-translator";
import JSZip from "jszip";
import {
  normalizeZipEntries,
  assertStrictArchiveEntry,
  shouldSkipArchiveEntry,
  validateEnvZipVersion,
  resolveSafeTargetPath,
  restoreImportedShellScriptPermissions
} from "./runtime-env-archive";
import { ENV_IMPORT_METADATA_PATHS, inspectEnvImportTarget, publishRuntimeEnvImport } from "./runtime-env-publication";
import { persistInitialEnvPackage } from "./runtime-env-seed";
import { resolveBundledEnvPackage, validateBundledEnvPackageManifest } from "./runtime-env-bundle";

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
  const zipBuffer = await fs.promises.readFile(zipPath);
  return importValidatedEnvBuffer(app, zipPath, zipBuffer, platform, expectedDesktopVersion, options.source ?? "manual");
}

async function importValidatedEnvBuffer(
  app: AppPathReader,
  zipPath: string,
  zipBuffer: Buffer,
  platform: NodeJS.Platform,
  expectedDesktopVersion: string,
  source: InitialEnvPackageSource,
  targetRoot = resolveRuntimeRoot(app, platform)
): Promise<EnvZipImportResult> {
  const pendingPath = path.join(targetRoot, ENV_IMPORT_PENDING_RELATIVE_PATH);
  inspectEnvImportTarget(targetRoot, ENV_IMPORT_PENDING_RELATIVE_PATH, false);
  if (fs.existsSync(pendingPath)) {
    throw new Error(`An interrupted runtime import requires recovery; preserved pending state: ${pendingPath}`);
  }
  const zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
  for (const entry of Object.values(zip.files)) {
    if (!shouldSkipArchiveEntry(entry.name)) assertStrictArchiveEntry(entry);
  }
  const entries = normalizeZipEntries(zip);
  await validateEnvZipVersion(entries, expectedDesktopVersion);
  const reservedPaths = [...ENV_IMPORT_METADATA_PATHS, ENV_IMPORT_PENDING_RELATIVE_PATH]
    .map((value) => value.split(path.sep).join("/"));
  for (const entry of entries) {
    const relativePath = entry.relativePath;
    if (reservedPaths.some((reserved) => relativePath.toLowerCase() === reserved.toLowerCase() ||
        relativePath.toLowerCase().startsWith(`${reserved.toLowerCase()}/`))) {
      throw new Error(`env.zip contains Desktop-owned import metadata: ${relativePath}`);
    }
    if (platform === "win32" && relativePath.split("/").some((segment) =>
      /[<>:"|?*]|[. ]$/u.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
      throw new Error(`env.zip contains an unsafe Windows path: ${relativePath}`);
    }
    inspectEnvImportTarget(targetRoot, relativePath, entry.directory);
  }
  for (const relativePath of ENV_IMPORT_METADATA_PATHS) inspectEnvImportTarget(targetRoot, relativePath, false);
  if (!entries.some((entry) => !entry.directory)) throw new Error(t("envBootstrap.emptyImport"));

  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(path.dirname(targetRoot), ".desktop-env-import-"));
  if (platform !== "win32") fs.chmodSync(stageRoot, 0o700);
  const result: EnvZipImportResult = { targetRoot, copiedFiles: 0, skippedFiles: 0, overwrittenFiles: 0, createdDirectories: 0 };
  try {
    // Decode every file before touching runtime contents, including skipped files.
    for (const entry of entries) {
      const stagedPath = resolveSafeTargetPath(stageRoot, entry.relativePath);
      if (entry.directory) {
        fs.mkdirSync(stagedPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        await fs.promises.writeFile(stagedPath, await entry.entry.async("nodebuffer"), { flag: "wx" });
        restoreImportedShellScriptPermissions(stagedPath, platform);
      }
    }
    const initialEnvPackage = await persistInitialEnvPackage({
      targetRoot: stageRoot,
      zipPath,
      zipBuffer,
      source,
      desktopVersion: expectedDesktopVersion
    });
    // Count before publication so the staged completion marker contains final file stats.
    const copiedFiles = entries.filter((entry) => !entry.directory &&
      !inspectEnvImportTarget(targetRoot, entry.relativePath, false)).length;
    const skippedFiles = entries.filter((entry) => !entry.directory).length - copiedFiles;
    writeEnvImportMarker(stageRoot, { ...result, copiedFiles, skippedFiles }, initialEnvPackage);
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
  publishRuntimeEnvImport({ targetRoot, stageRoot, entries, platform, result });
  return result;
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
    targetRoot?: string;
    source?: InitialEnvPackageSource;
  } = {}
): Promise<BundledEnvZipImportResult | null> {
  const bundledPackage = resolveBundledEnvPackage(app, platform, options.resourcesRoot);
  if (!bundledPackage) {
    return null;
  }

  const desktopVersion = options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader);
  const zipBuffer = await fs.promises.readFile(bundledPackage.zipPath);
  validateBundledEnvPackageManifest(bundledPackage, zipBuffer, desktopVersion);

  const result = await importValidatedEnvBuffer(
    app,
    bundledPackage.zipPath,
    zipBuffer,
    platform,
    desktopVersion,
    options.source ?? "bundled",
    options.targetRoot
  );
  return {
    ...result,
    sourceZipPath: bundledPackage.zipPath
  };
}
