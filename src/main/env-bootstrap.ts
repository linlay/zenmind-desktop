import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import JSZip from "jszip";

type AppPathReader = Pick<App, "getPath">;

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

const ENV_ARCHIVE_WRAPPER_DIRS = new Set([".zenmind", "zenmind", "zenmind-env", "env"]);
const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-market"] as const;
const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");

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

export function resolveHomeZenmindRoot(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.resolve(pathApi.join(getHomePath(app), ".zenmind"));
}

export function homeZenmindRootExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveHomeZenmindRoot(app, platform);
  try {
    return fs.existsSync(root) && fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function homeZenmindEnvExists(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const root = resolveHomeZenmindRoot(app, platform);
  if (!homeZenmindRootExists(app, platform)) {
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
  homeZenmindEnvExistedAtStartup: boolean;
}) {
  const platform = input.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && !input.homeZenmindEnvExistedAtStartup;
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

export async function importEnvZipToZenmind(
  app: AppPathReader,
  zipPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<EnvZipImportResult> {
  if (path.extname(zipPath).toLowerCase() !== ".zip") {
    throw new Error("首次安装只能导入 env.zip。");
  }

  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const entries = normalizeZipEntries(zip);
  const targetRoot = resolveHomeZenmindRoot(app, platform);
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
