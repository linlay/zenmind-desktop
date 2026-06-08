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

const ENV_ARCHIVE_WRAPPER_DIRS = new Set([".zenmind", "zenmind", "zenmind-env", "env"]);
const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-market"] as const;
const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");
const BUNDLED_ENV_RESOURCES_DIR_NAME = "env";
const ENV_ZIP_FILE_NAME = "env.zip";
const VERSION_FILE_NAME = "VERSION";

type EnvZipImportOptions = {
  shouldOverwriteExistingFile?: (relativePath: string) => boolean;
};

function isEnvArchiveWrapperDir(dirName: string) {
  const normalizedDirName = dirName.trim().toLowerCase();
  return (
    ENV_ARCHIVE_WRAPPER_DIRS.has(normalizedDirName) ||
    /^zenmind-env[-_].+/u.test(normalizedDirName)
  );
}

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path.posix;
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
  const pathApi = pathApiForPlatform(platform);
  return pathApi.resolve(pathApi.join(getHomePath(app), APP_BRAND.paths.runtimeRootDirName));
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

function runtimeSeedPathExists(root: string, relativePath: string) {
  try {
    const targetPath = path.join(root, relativePath);
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

export function runtimeEnvNeedsBundledSeedRefresh(
  app: AppPathReader,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "darwin" && platform !== "win32") {
    return false;
  }
  const root = resolveRuntimeRoot(app, platform);
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  return (
    runtimeSeedPathExists(root, path.join("agents", "bootstrap")) ||
    runtimeSeedPathExists(root, path.join("owner", "BOOTSTRAP.md"))
  );
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
    refreshRuntimeSeedFiles?: boolean;
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
    {
      shouldOverwriteExistingFile: options.refreshRuntimeSeedFiles
        ? isRefreshableRuntimeSeedPath
        : undefined
    }
  );
  return {
    ...result,
    sourceZipPath: zipPath
  };
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

function countWrapperSegments(fileNames: string[]) {
  let strippedNames = fileNames.map(normalizeArchiveEntryName);
  let wrapperDepth = 0;

  while (strippedNames.length > 0) {
    const segments = strippedNames.map((entryName) => entryName.split("/").filter(Boolean));
    const firstSegment = segments[0]?.[0] ?? "";
    if (
      !firstSegment ||
      !isEnvArchiveWrapperDir(firstSegment) ||
      !segments.every((entrySegmentsValue) =>
        entrySegmentsValue[0] === firstSegment && entrySegmentsValue.length > 1
      )
    ) {
      break;
    }

    wrapperDepth += 1;
    strippedNames = segments.map((entrySegmentsValue) => entrySegmentsValue.slice(1).join("/"));
  }

  return wrapperDepth;
}

function stripWrapperSegments(entryName: string, wrapperDepth: number) {
  const segments = entrySegments(entryName).slice(wrapperDepth);
  return segments.join("/");
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

function isRefreshableRuntimeSeedPath(relativePath: string) {
  const segments = normalizeSafeRelativePath(relativePath).split("/");
  if (segments[0] === "agents" && segments[1] === "bootstrap") {
    return true;
  }
  if (segments[0] === "agents" && typeof segments[1] === "string" && segments[1].endsWith(".bootstrap")) {
    return true;
  }
  if (segments[0] === "registries" && (segments[1] === "providers" || segments[1] === "models")) {
    return true;
  }
  return false;
}

function isProviderRegistryPath(relativePath: string) {
  const segments = normalizeSafeRelativePath(relativePath).split("/");
  return segments[0] === "registries" && segments[1] === "providers" && /\.ya?ml$/iu.test(segments[2] ?? "");
}

function extractTopLevelYamlScalar(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^(${escapedKey}\\s*:\\s*)(.*)$`, "imu").exec(content);
  if (!match) {
    return null;
  }
  const rawValue = match[2].trim();
  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1).trim();
  }
  return rawValue;
}

function looksLikePlaceholderApiKey(apiKey: string | null) {
  if (!apiKey?.trim()) {
    return true;
  }
  const normalized = apiKey.trim().toLowerCase();
  return /(?:your|example|demo|placeholder|replace[-_\s]*me|change[-_\s]*me|xxx)/iu.test(normalized);
}

function replaceOrInsertTopLevelYamlScalar(content: string, key: string, value: string) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:`, "iu");
  const existingIndex = lines.findIndex((line) => keyPattern.test(line));
  if (existingIndex >= 0) {
    const indent = /^\s*/u.exec(lines[existingIndex])?.[0] ?? "";
    lines[existingIndex] = `${indent}${key}: ${value}`;
    return `${lines.join(newline)}${newline}`;
  }

  const baseUrlIndex = lines.findIndex((line) => /^\s*baseUrl\s*:/iu.test(line));
  const providerKeyIndex = lines.findIndex((line) => /^\s*key\s*:/iu.test(line));
  const insertIndex = baseUrlIndex >= 0 ? baseUrlIndex + 1 : providerKeyIndex >= 0 ? providerKeyIndex + 1 : lines.length;
  lines.splice(insertIndex, 0, `${key}: ${value}`);
  return `${lines.join(newline)}${newline}`;
}

function mergeProviderRegistrySeedContent(existingContent: string, bundledContent: string) {
  const existingApiKey = extractTopLevelYamlScalar(existingContent, "apiKey");
  const bundledApiKey = extractTopLevelYamlScalar(bundledContent, "apiKey");
  if (existingApiKey === null || looksLikePlaceholderApiKey(existingApiKey) || !looksLikePlaceholderApiKey(bundledApiKey)) {
    return bundledContent;
  }
  return replaceOrInsertTopLevelYamlScalar(bundledContent, "apiKey", existingApiKey);
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
  const fileNames = usableEntries
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  const wrapperDepth = countWrapperSegments(fileNames);

  const entries: EnvZipEntry[] = [];
  for (const entry of usableEntries) {
    const strippedPath = stripWrapperSegments(entry.name, wrapperDepth);
    if (!strippedPath) {
      continue;
    }
    entries.push({
      relativePath: normalizeSafeRelativePath(strippedPath),
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
  expectedDesktopVersion: string = resolveDesktopVersion(app as AppVersionReader),
  options: EnvZipImportOptions = {}
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
  let overwrittenFiles = 0;
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
      if (!options.shouldOverwriteExistingFile?.(entry.relativePath)) {
        skippedFiles += 1;
        continue;
      }
      const targetStat = await fs.promises.stat(targetPath).catch(() => null);
      if (targetStat?.isDirectory()) {
        skippedFiles += 1;
        continue;
      }
      const content = await entry.entry.async("nodebuffer");
      if (isProviderRegistryPath(entry.relativePath)) {
        const existingContent = await fs.promises.readFile(targetPath, "utf8");
        await fs.promises.writeFile(
          targetPath,
          mergeProviderRegistrySeedContent(existingContent, content.toString("utf8")),
          "utf8"
        );
      } else {
        await fs.promises.writeFile(targetPath, content);
      }
      overwrittenFiles += 1;
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const content = await entry.entry.async("nodebuffer");
    await fs.promises.writeFile(targetPath, content);
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
  const pathApi = pathApiForPlatform(platform);
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
