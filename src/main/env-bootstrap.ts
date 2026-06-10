import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import JSZip from "jszip";
import { APP_BRAND } from "../shared/generated/brand";

export type EnvRootConflictDecision = "migrate" | "keep" | "cancel";

type AppPathReader = Pick<App, "getPath">;
type AppVersionReader = Partial<Pick<App, "getAppPath" | "getVersion">>;
type AppPackageReader = Partial<Pick<App, "isPackaged">>;

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

const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-market"] as const;
const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");
const BUNDLED_ENV_RESOURCES_DIR_NAME = "env";
const ENV_ZIP_FILE_NAME = "env.zip";
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
  const pathApi = pathApiForResolvedRoot(platform, homePath);
  return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName));
}

export function runtimeRootExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  try {
    return fs.existsSync(root) && fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function runtimeEnvExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveRuntimeRoot(app, platform);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return true;
  }
  return ENV_RUNTIME_DIRS.some((dirName) => {
    const targetPath = path.join(root, dirName);
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    } catch {
      return false;
    }
  });
}

export function shouldRequireEnvZipImport(input: {
  platform?: NodeJS.Platform;
  runtimeEnvExistedAtStartup: boolean;
}) {
  const platform = input.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && !input.runtimeEnvExistedAtStartup;
}

function bundledResourcesRoot(app: AppPackageReader, resourcesRootOverride?: string) {
  if (resourcesRootOverride) {
    return resourcesRootOverride;
  }
  return app.isPackaged
    ? process.resourcesPath
    : path.join(process.cwd(), "build", "resources");
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
  const resourcesRoot = bundledResourcesRoot(app, resourcesRootOverride);
  if (platform === "darwin") {
    return path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME, ENV_ZIP_FILE_NAME);
  }
  if (platform === "win32") {
    return path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME, ENV_ZIP_FILE_NAME);
  }
  return null;
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
    options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader)
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
    throw createRuntimeEnvResetFailure("当前平台不支持从内置 env.zip 重置运行环境。", {});
  }

  const runtimeRoot = resolveRuntimeRoot(app, platform);
  if (!sourceZipPath || !fileExists(sourceZipPath)) {
    throw createRuntimeEnvResetFailure("安装包内置 env.zip 不存在，无法重置运行环境。", {
      runtimeRoot,
      sourceZipPath: sourceZipPath ?? undefined
    });
  }

  let backupPath: string | undefined;
  try {
    if (fs.existsSync(runtimeRoot)) {
      if (!fs.statSync(runtimeRoot).isDirectory()) {
        throw new Error(`运行环境路径不是目录：${runtimeRoot}`);
      }
      backupPath = generateBackupDirName(runtimeRoot, platform, options.nowSeconds);
      migrateOldRootToBackup(platform, runtimeRoot, backupPath);
    }

    const importResult = await importEnvZipToRuntime(
      app,
      sourceZipPath,
      platform,
      options.expectedDesktopVersion ?? resolveDesktopVersion(app as AppVersionReader)
    );
    return {
      ...importResult,
      backupPath,
      sourceZipPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createRuntimeEnvResetFailure(`运行环境重置失败：${message}`, {
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
    throw new Error(`env.zip 包含不安全路径：${relativePath}`);
  }
  return normalized;
}

function isNestedEnvWrapperSegment(segment: string) {
  const normalized = segment.trim().toLowerCase();
  return (
    normalized === ENV_ZIP_ROOT_DIR_NAME ||
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
    throw new Error(`env.zip 必须解压为唯一顶层 env/ 目录，发现路径：${entryName}`);
  }
  if (segments.length === 1) {
    return null;
  }
  if (isNestedEnvWrapperSegment(segments[1] ?? "")) {
    throw new Error(`env.zip 只能剥离一层 env/，发现嵌套环境目录：${entryName}`);
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
    throw new Error(`env.zip 包含越界路径：${relativePath}`);
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

  throw new Error("无法读取 Desktop VERSION。");
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
    throw new Error("Desktop VERSION 为空，无法校验 env.zip。");
  }

  const versionEntry = entries.find(
    (entry) => !entry.directory && entry.relativePath === VERSION_FILE_NAME
  );
  if (!versionEntry) {
    throw new Error("env.zip 缺少 VERSION 文件。");
  }

  const envVersion = normalizeVersion(await versionEntry.entry.async("string"));
  if (!envVersion) {
    throw new Error("env.zip VERSION 为空。");
  }
  if (envVersion !== normalizedExpectedVersion) {
    throw new Error(`env.zip VERSION 不匹配：期望 ${normalizedExpectedVersion}，实际 ${envVersion}。`);
  }
}

function writeEnvImportMarker(targetRoot: string, result: Omit<EnvZipImportResult, "targetRoot">) {
  const markerPath = path.join(targetRoot, ENV_IMPORT_MARKER_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      importedAt: new Date().toISOString(),
      copiedFiles: result.copiedFiles,
      skippedFiles: result.skippedFiles,
      overwrittenFiles: result.overwrittenFiles
    }, null, 2)}\n`,
    "utf8"
  );
}

export async function importEnvZipToRuntime(
  app: AppPathReader,
  zipPath: string,
  platform: NodeJS.Platform = process.platform,
  expectedDesktopVersion: string = resolveDesktopVersion(app as AppVersionReader)
): Promise<EnvZipImportResult> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") {
    throw new Error("首次安装只能导入 env.zip。");
  }

  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const entries = normalizeZipEntries(zip);
  await validateEnvZipVersion(entries, expectedDesktopVersion);
  const targetRoot = resolveRuntimeRoot(app, platform);
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
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, await entry.entry.async("nodebuffer"));
    copiedFiles += 1;
  }

  if (copiedFiles + skippedFiles === 0) {
    throw new Error("env.zip 内没有可导入的文件。");
  }

  writeEnvImportMarker(targetRoot, {
    copiedFiles,
    skippedFiles,
    overwrittenFiles,
    createdDirectories
  });

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
    throw new Error(`旧环境备份目录已存在：${backupPath}`);
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
  if (input.platform !== "darwin" && input.platform !== "win32") {
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
