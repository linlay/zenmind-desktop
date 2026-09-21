import {
  EnvZipImportResult,
  InitialEnvPackageRecord,
  ENV_IMPORT_MARKER_RELATIVE_PATH,
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
  validateEnvZipVersion,
  resolveSafeTargetPath,
  restoreImportedShellScriptPermissions
} from "./runtime-env-archive";
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
