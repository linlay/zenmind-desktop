import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import JSZip from "jszip";
import { APP_BRAND } from "../shared/brand";
import { t } from "./i18n/main-i18n";
import { resolveRuntimeRootPath } from "./runtime-root";

export type EnvRootConflictDecision = "migrate" | "keep" | "cancel";

type AppPathReader = Pick<App, "getPath">;
type AppVersionReader = Partial<Pick<App, "getAppPath" | "getVersion">>;
type AppPackageReader = Partial<Pick<App, "getAppPath" | "isPackaged">>;

type EnvZipEntry = {
  relativePath: string;
  directory: boolean;
  entry: JSZip.JSZipObject;
};

export type EnvZipImportResult = {
  targetRoot: string;
  copiedFiles: number;
  skippedFiles: number;
  overwrittenFiles: number;
  createdDirectories: number;
};

type InitialEnvPackageSource = "manual" | "bundled" | "reset";

type InitialEnvPackageManifest = {
  schemaVersion: 1;
  source: InitialEnvPackageSource;
  sourcePath: string;
  desktopVersion: string;
  sha256: string;
  size: number;
  storedAt: string;
  envZipRelativePath: string;
};

type InitialEnvPackageRecord = {
  relativePath: string;
  manifestRelativePath: string;
  sha256: string;
  source: InitialEnvPackageSource;
  storedAt: string;
};

export type BundledEnvZipImportResult = EnvZipImportResult & {
  sourceZipPath: string;
};

export type RuntimeEnvResetResult = BundledEnvZipImportResult & {
  backupPath?: string;
};

export type RuntimeEnvResetFailure = Error & {
  runtimeRoot?: string;
  backupPath?: string;
  sourceZipPath?: string;
};

const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-center"] as const;
const REMOVED_SKILLS_MARKET_DIR_NAME = "skills-market";
const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");
const ENV_AGENT_DEFINITION_FILE_NAME = "agent.yml";
const BUNDLED_ENV_RESOURCES_DIR_NAME = "env";
const ENV_ZIP_FILE_NAME = "env.zip";
const ENV_INITIAL_DATA_RELATIVE_DIR = path.join(".desktop", "data", "env-initial");
const ENV_INITIAL_PACKAGE_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_ZIP_FILE_NAME);
const ENV_INITIAL_MANIFEST_FILE_NAME = "manifest.json";
const ENV_INITIAL_MANIFEST_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_INITIAL_MANIFEST_FILE_NAME);
const VERSION_FILE_NAME = "VERSION";
const ENV_ZIP_ROOT_DIR_NAME = "env";

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  if (platform === "win32") {
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  return path.posix;
}

function pathApiForResolvedRoot(platform: NodeJS.Platform | undefined, rootPath: string) {
  if (platform === "win32") {
    // Cross-platform tests inject POSIX temp directories while simulating Windows behavior.
    if (path.posix.isAbsolute(rootPath)) {
      return path.posix;
    }
    return path.win32;
  }
  if (platform === "darwin") {
    if (path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)) {
      return path.win32;
    }
    return path.posix;
  }
  return path.posix;
}

function getHomePath(app: AppPathReader) {
  try {
    const homePath = app.getPath("home");
    if (typeof homePath === "string" && homePath.trim()) {
      return homePath;
    }
  } catch {
    // Fall back to Node's user home when Electron cannot provide one yet.
  }
  return process.env.HOME || os.homedir();
}

export function resolveRuntimeRoot(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const homePath = getHomePath(app);
  return resolveRuntimeRootPath({ platform, homePath });
}

export function runtimeRootExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  try {
    return fs.existsSync(root) && fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function hasBusinessDataInRemovedSkillsMarketDir(dirPath: string): boolean {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" && entry.isFile()) {
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (hasBusinessDataInRemovedSkillsMarketDir(path.join(dirPath, entry.name))) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

function removeEmptyRemovedSkillsMarketDir(dirPath: string) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.name === ".DS_Store" && entry.isFile()) {
      fs.unlinkSync(entryPath);
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeEmptyRemovedSkillsMarketDir(entryPath);
      continue;
    }
    throw new Error(t("envBootstrap.removedSkillsMarketRuntime", { path: dirPath }));
  }
  fs.rmdirSync(dirPath);
}

export function prepareRemovedSkillsMarketRuntimeDir(root: string) {
  const removedPath = path.join(root, REMOVED_SKILLS_MARKET_DIR_NAME);
  if (!fs.existsSync(removedPath)) {
    return;
  }
  const stat = fs.lstatSync(removedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || hasBusinessDataInRemovedSkillsMarketDir(removedPath)) {
    throw new Error(t("envBootstrap.removedSkillsMarketRuntime", { path: removedPath }));
  }
  removeEmptyRemovedSkillsMarketDir(removedPath);
}

export function runtimeEnvExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  prepareRemovedSkillsMarketRuntimeDir(root);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return true;
  }
  return ENV_RUNTIME_DIRS.some((dirName) => {
    const targetPath = path.join(root, dirName);
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() && hasDirectoryEntries(targetPath);
    } catch {
      return false;
    }
  });
}

export function runtimeEnvNeedsBundledSeedRefresh(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  if (platform !== "darwin" && platform !== "win32") {
    return false;
  }
  const root = resolveRuntimeRoot(app, platform);
  prepareRemovedSkillsMarketRuntimeDir(root);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return false;
  }
  return !hasRuntimeAgentDefinitions(root);
}

function hasDirectoryEntries(dirPath: string) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        return true;
      }
    }
  }
  return false;
}

function hasRuntimeAgentDefinitions(root: string) {
  const agentsRoot = path.join(root, "agents");
  try {
    return fs.existsSync(agentsRoot) &&
      fs.statSync(agentsRoot).isDirectory() &&
      hasFileNamed(agentsRoot, ENV_AGENT_DEFINITION_FILE_NAME);
  } catch {
    return false;
  }
}

function hasFileNamed(dirPath: string, fileName: string) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        return true;
      }
    }
  }
  return false;
}

export function shouldRequireEnvZipImport(input: {
  platform?: NodeJS.Platform;
  runtimeEnvExistedAtStartup: boolean;
}) {
  const platform = input.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && !input.runtimeEnvExistedAtStartup;
}

function pushUniquePath(candidates: string[], candidate: string | undefined) {
  if (!candidate) {
    return;
  }
  const normalized = path.resolve(candidate);
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
}

function getPackagedAppPath(app: AppPackageReader) {
  try {
    return typeof app.getAppPath === "function" ? app.getAppPath() : "";
  } catch {
    return "";
  }
}

function bundledResourcesRootCandidates(app: AppPackageReader, resourcesRootOverride?: string) {
  const candidates: string[] = [];
  pushUniquePath(candidates, resourcesRootOverride);

  if (app.isPackaged) {
    pushUniquePath(candidates, process.resourcesPath);

    const appPath = getPackagedAppPath(app);
    if (appPath) {
      pushUniquePath(candidates, path.dirname(appPath));
    }

    if (process.execPath) {
      pushUniquePath(candidates, path.join(path.dirname(process.execPath), "resources"));
    }
  } else if (!resourcesRootOverride) {
    pushUniquePath(candidates, path.join(process.cwd(), "build", "resources"));
  }

  return candidates;
}

function fileExists(filePath: string) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveBundledEnvZipPath(
  app: AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  resourcesRootOverride?: string
) {
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  const candidates = bundledResourcesRootCandidates(app, resourcesRootOverride)
    .map((resourcesRoot) => path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME, ENV_ZIP_FILE_NAME));
  return candidates.find(fileExists) ?? candidates[0] ?? null;
}

export function bundledEnvZipExists(
  app: AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  resourcesRootOverride?: string
) {
  const zipPath = resolveBundledEnvZipPath(app, platform, resourcesRootOverride);
  return Boolean(zipPath && fileExists(zipPath));
}

export async function importBundledEnvZipToRuntime(
  app: AppPathReader & AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  options: {
    resourcesRoot?: string;
    expectedDesktopVersion?: string;
  } = {}
): Promise<BundledEnvZipImportResult | null> {
  const zipPath = resolveBundledEnvZipPath(app, platform, options.resourcesRoot);
  if (!zipPath || !fileExists(zipPath)) {
    return null;
  }

  const result = await importEnvZipToRuntime(
    app,
    zipPath,
    platform,
    options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader),
    { source: "bundled" }
  );
  return {
    ...result,
    sourceZipPath: zipPath
  };
}

function createRuntimeEnvResetFailure(
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
  let sourceZipPath: string | null = null;
  if (platform === "darwin") {
    sourceZipPath = resolveBundledEnvZipPath(app, "darwin", options.resourcesRoot);
  } else if (platform === "win32") {
    sourceZipPath = resolveBundledEnvZipPath(app, "win32", options.resourcesRoot);
  } else {
    throw createRuntimeEnvResetFailure(t("envBootstrap.resetUnsupportedPlatform"), {});
  }

  const runtimeRoot = resolveRuntimeRoot(app, platform);
  if (!sourceZipPath || !fileExists(sourceZipPath)) {
    throw createRuntimeEnvResetFailure(t("envBootstrap.bundledEnvZipMissing"), {
      runtimeRoot,
      sourceZipPath: sourceZipPath ?? undefined
    });
  }

  let backupPath: string | undefined;
  try {
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
      options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader),
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

function normalizeArchiveEntryName(entryName: string) {
  let normalized = entryName.replace(/\\/gu, "/").replace(/^\/+/u, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function entrySegments(entryName: string) {
  return normalizeArchiveEntryName(entryName).split("/").filter(Boolean);
}

function shouldSkipArchiveEntry(entryName: string) {
  const segments = entrySegments(entryName);
  if (segments.length === 0) {
    return true;
  }
  return segments[0] === "__MACOSX" || segments[segments.length - 1] === ".DS_Store";
}

function normalizeSafeRelativePath(relativePath: string) {
  const normalized = path.posix.normalize(relativePath.replace(/\\/gu, "/"));
  if (
    !normalized ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(t("envBootstrap.unsafePath", { path: relativePath }));
  }
  return normalized;
}

function isNestedEnvWrapperSegment(segment: string) {
  const normalized = segment.trim().toLowerCase();
  const runtimeRootDirName = APP_BRAND.paths.runtimeRootDirName.trim().toLowerCase();
  const runtimeRootName = runtimeRootDirName.replace(/^\./u, "");
  return (
    normalized === ENV_ZIP_ROOT_DIR_NAME ||
    normalized === runtimeRootDirName ||
    normalized === runtimeRootName ||
    normalized === ".zenmind" ||
    normalized === "zenmind" ||
    normalized === "zenmind-env" ||
    /^zenmind-env[-_].+/u.test(normalized)
  );
}

function normalizeEnvZipEntryRelativePath(entryName: string) {
  const segments = entrySegments(entryName);
  if (segments.length === 0) {
    return null;
  }
  if (segments[0] !== ENV_ZIP_ROOT_DIR_NAME) {
    throw new Error(t("envBootstrap.rootDirRequired", { path: entryName }));
  }
  if (segments.length === 1) {
    return null;
  }
  if (segments[1]?.toLowerCase() === REMOVED_SKILLS_MARKET_DIR_NAME) {
    throw new Error(t("envBootstrap.removedSkillsMarketArchive", { path: entryName }));
  }
  if (isNestedEnvWrapperSegment(segments[1] ?? "")) {
    throw new Error(t("envBootstrap.nestedRoot", { path: entryName }));
  }
  return normalizeSafeRelativePath(segments.slice(1).join("/"));
}

function resolveSafeTargetPath(targetRoot: string, relativePath: string) {
  const targetRootResolved = path.resolve(targetRoot);
  const targetPath = path.resolve(targetRootResolved, relativePath);
  const rootWithSeparator = targetRootResolved.endsWith(path.sep)
    ? targetRootResolved
    : `${targetRootResolved}${path.sep}`;

  if (targetPath !== targetRootResolved && !targetPath.startsWith(rootWithSeparator)) {
    throw new Error(t("envBootstrap.outsidePath", { path: relativePath }));
  }

  return targetPath;
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/iu, "");
}

function readVersionFileIfExists(filePath: string) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    const version = normalizeVersion(fs.readFileSync(filePath, "utf8"));
    return version || null;
  } catch {
    return null;
  }
}

function toPosixRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeFileModeBestEffort(filePath: string, mode: number) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // File permissions are best-effort across packaged platforms and filesystems.
  }
}

function restoreImportedShellScriptPermissions(filePath: string, platform: NodeJS.Platform) {
  const isPosixShellPlatform = platform === "darwin" || platform === "linux";
  if (!isPosixShellPlatform || path.extname(filePath).toLowerCase() !== ".sh") {
    return;
  }

  // JSZip writes a fresh file with the host default mode and does not reliably
  // preserve the source ZIP's executable bit. env.zip carries user-invoked
  // bootstrap and maintenance scripts, so restore the POSIX executable mode
  // after both a copy and a skipped existing-file import.
  fs.chmodSync(filePath, 0o755);
}

async function persistInitialEnvPackage(input: {
  targetRoot: string;
  zipPath: string;
  zipBuffer: Buffer;
  source: InitialEnvPackageSource;
  desktopVersion: string;
}): Promise<InitialEnvPackageRecord> {
  const storedAt = new Date().toISOString();
  const sha256 = sha256Hex(input.zipBuffer);
  const packagePath = path.join(input.targetRoot, ENV_INITIAL_PACKAGE_RELATIVE_PATH);
  const manifestPath = path.join(input.targetRoot, ENV_INITIAL_MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  if (path.resolve(input.zipPath) !== path.resolve(packagePath)) {
    await fs.promises.writeFile(packagePath, input.zipBuffer);
  }
  writeFileModeBestEffort(packagePath, 0o600);
  const manifest: InitialEnvPackageManifest = {
    schemaVersion: 1,
    source: input.source,
    sourcePath: input.zipPath,
    desktopVersion: normalizeVersion(input.desktopVersion),
    sha256,
    size: input.zipBuffer.byteLength,
    storedAt,
    envZipRelativePath: ENV_ZIP_FILE_NAME
  };
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    relativePath: toPosixRelativePath(ENV_INITIAL_PACKAGE_RELATIVE_PATH),
    manifestRelativePath: toPosixRelativePath(ENV_INITIAL_MANIFEST_RELATIVE_PATH),
    sha256,
    source: input.source,
    storedAt
  };
}

export function resolveDesktopVersion(app: AppVersionReader = {}) {
  const candidateRoots = [
    typeof app.getAppPath === "function" ? app.getAppPath() : "",
    process.cwd()
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidateRoot of candidateRoots) {
    const version = readVersionFileIfExists(path.join(candidateRoot, VERSION_FILE_NAME));
    if (version) {
      return version;
    }
  }

  if (typeof app.getVersion === "function") {
    const version = normalizeVersion(app.getVersion());
    if (version) {
      return version;
    }
  }

  throw new Error(t("envBootstrap.versionReadFailed"));
}

function normalizeZipEntries(zip: JSZip) {
  const zipObjects = Object.values(zip.files);
  const usableEntries = zipObjects.filter((entry) => !shouldSkipArchiveEntry(entry.name));

  const entries: EnvZipEntry[] = [];
  for (const entry of usableEntries) {
    const relativePath = normalizeEnvZipEntryRelativePath(entry.name);
    if (!relativePath) {
      continue;
    }
    entries.push({
      relativePath,
      directory: entry.dir,
      entry
    });
  }

  return entries;
}

async function validateEnvZipVersion(entries: EnvZipEntry[], expectedDesktopVersion: string) {
  const normalizedExpectedVersion = normalizeVersion(expectedDesktopVersion);
  if (!normalizedExpectedVersion) {
    throw new Error(t("envBootstrap.desktopVersionEmpty"));
  }

  const versionEntry = entries.find(
    (entry) => !entry.directory && entry.relativePath === VERSION_FILE_NAME
  );
  if (!versionEntry) {
    throw new Error(t("envBootstrap.versionFileMissing"));
  }

  const envVersion = normalizeVersion(await versionEntry.entry.async("string"));
  if (!envVersion) {
    throw new Error(t("envBootstrap.envVersionEmpty"));
  }
  if (envVersion !== normalizedExpectedVersion) {
    throw new Error(t("envBootstrap.versionMismatch", { expected: normalizedExpectedVersion, actual: envVersion }));
  }
}

function writeEnvImportMarker(
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
  prepareRemovedSkillsMarketRuntimeDir(targetRoot);

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
