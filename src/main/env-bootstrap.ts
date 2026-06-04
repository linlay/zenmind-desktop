import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import JSZip from "jszip";
import { APP_BRAND } from "../shared/generated/brand";

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

function isEnvArchiveWrapperDir(dirName: string) {
  const normalizedDirName = dirName.trim().toLowerCase();
  return (
    ENV_ARCHIVE_WRAPPER_DIRS.has(normalizedDirName) ||
    /^zenmind-env[-_].+/u.test(normalizedDirName)
  );
}

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
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
      skippedFiles: result.skippedFiles
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
    createdDirectories
  });

  return {
    targetRoot,
    copiedFiles,
    skippedFiles,
    createdDirectories
  };
}
