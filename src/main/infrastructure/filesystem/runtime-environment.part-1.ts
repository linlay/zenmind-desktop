import fs from "node:fs";

import { createHash } from "node:crypto";

import os from "node:os";

import path from "node:path";

import type { App } from "electron";

import JSZip from "jszip";

import { APP_BRAND } from "../../../shared/brand";

import { resolveRuntimeRootPath } from "./runtime-root";

import { isDesktopDevelopmentRuntime } from "../electron/development-runtime";

import { t } from "./runtime-environment-translator";

export type EnvRootConflictDecision = "migrate" | "keep" | "cancel";

export type AppPathReader = Pick<App, "getPath">;

export type AppVersionReader = Partial<Pick<App, "getAppPath" | "getVersion">>;

export type AppPackageReader = Partial<Pick<App, "getAppPath" | "isPackaged">>;

export type EnvZipEntry = {
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

export type InitialEnvPackageSource = "manual" | "bundled" | "reset";

export type InitialEnvPackageManifest = {
  schemaVersion: 1;
  source: InitialEnvPackageSource;
  sourcePath: string;
  desktopVersion: string;
  sha256: string;
  size: number;
  storedAt: string;
  envZipRelativePath: string;
};

export type InitialEnvPackageRecord = {
  relativePath: string;
  manifestRelativePath: string;
  sha256: string;
  source: InitialEnvPackageSource;
  storedAt: string;
};

export type BundledEnvZipImportResult = EnvZipImportResult & {
  sourceZipPath: string;
};

export type ValidatedBundledEnvUpgradeInput = {
  sourceZipPath: string;
  previousSourceZipPath?: string;
  desktopVersion: string;
  sha256: string;
  size: number;
  desktopInit: Record<string, unknown>;
};

export type RuntimeEnvResetResult = BundledEnvZipImportResult & {
  backupPath?: string;
};

export type RuntimeEnvResetFailure = Error & {
  runtimeRoot?: string;
  backupPath?: string;
  sourceZipPath?: string;
};

export const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-center", "tools"] as const;

export const REMOVED_SKILLS_MARKET_DIR_NAME = "skills-market";

export const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");

export const ENV_AGENT_DEFINITION_FILE_NAME = "agent.yml";

export const BUNDLED_ENV_RESOURCES_DIR_NAME = "env";

export const ENV_ZIP_FILE_NAME = "env.zip";

export const ENV_ZIP_MANIFEST_FILE_NAME = "manifest.json";

export const ENV_INITIAL_DATA_RELATIVE_DIR = path.join(".desktop", "data", "env-initial");

export const ENV_INITIAL_PACKAGE_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_ZIP_FILE_NAME);

export const ENV_INITIAL_MANIFEST_FILE_NAME = "manifest.json";

export const ENV_INITIAL_MANIFEST_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_INITIAL_MANIFEST_FILE_NAME);

export const VERSION_FILE_NAME = "VERSION";

export const ENV_ZIP_ROOT_DIR_NAME = "env";

export type BundledEnvManifest = {
  bundled: boolean;
  fileName: string | null;
  version?: string;
  size?: number;
  sha256?: string;
};

export type BundledEnvPackage = {
  zipPath: string;
  manifest?: BundledEnvManifest;
};

export function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  if (platform === "win32") {
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  return path.posix;
}

export function pathApiForResolvedRoot(platform: NodeJS.Platform | undefined, rootPath: string) {
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

export function getHomePath(app: AppPathReader) {
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
  if (!runtimeRootExists(app, platform)) {
    return false;
  }
  if (fs.existsSync(path.join(root, ENV_IMPORT_MARKER_RELATIVE_PATH))) {
    return false;
  }
  return !hasRuntimeAgentDefinitions(root);
}

export function hasDirectoryEntries(dirPath: string) {
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

export function hasRuntimeAgentDefinitions(root: string) {
  const agentsRoot = path.join(root, "agents");
  try {
    return fs.existsSync(agentsRoot) &&
      fs.statSync(agentsRoot).isDirectory() &&
      hasFileNamed(agentsRoot, ENV_AGENT_DEFINITION_FILE_NAME);
  } catch {
    return false;
  }
}

export function hasFileNamed(dirPath: string, fileName: string) {
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

export function pushUniquePath(candidates: string[], candidate: string | undefined) {
  if (!candidate) {
    return;
  }
  const normalized = path.resolve(candidate);
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
}

export function getPackagedAppPath(app: AppPackageReader) {
  try {
    return typeof app.getAppPath === "function" ? app.getAppPath() : "";
  } catch {
    return "";
  }
}

export function bundledResourcesRootCandidates(app: AppPackageReader, resourcesRootOverride?: string) {
  const candidates: string[] = [];
  pushUniquePath(candidates, resourcesRootOverride);

  const isDevelopmentRuntime = isDesktopDevelopmentRuntime(app);
  if (app.isPackaged && !isDevelopmentRuntime) {
    pushUniquePath(candidates, process.resourcesPath);

    const appPath = getPackagedAppPath(app);
    if (appPath) {
      pushUniquePath(candidates, path.dirname(appPath));
    }

    if (process.execPath) {
      pushUniquePath(candidates, path.join(path.dirname(process.execPath), "resources"));
    }
  } else if (!resourcesRootOverride) {
    // Development resources are brand-scoped. Packaged applications must never
    // honor this environment override and remain confined to their app bundle.
    pushUniquePath(candidates, process.env.DESKTOP_DEV_RESOURCES_ROOT);
    pushUniquePath(candidates, path.join(process.cwd(), "build", "resources"));
  }

  return candidates;
}

export function fileExists(filePath: string) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function supportsBundledEnvResources(app: AppPackageReader, platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32" || isDesktopDevelopmentRuntime(app, { platform });
}

export function resolveBundledEnvZipPath(
  app: AppPackageReader,
  platform: NodeJS.Platform = process.platform,
  resourcesRootOverride?: string
) {
  if (!supportsBundledEnvResources(app, platform)) {
    return null;
  }

  const candidates = bundledResourcesRootCandidates(app, resourcesRootOverride)
    .map((resourcesRoot) => path.join(resourcesRoot, BUNDLED_ENV_RESOURCES_DIR_NAME, ENV_ZIP_FILE_NAME));
  return candidates.find(fileExists) ?? candidates[0] ?? null;
}

export function normalizeArchiveEntryName(entryName: string) {
  let normalized = entryName.replace(/\\/gu, "/").replace(/^\/+/u, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function entrySegments(entryName: string) {
  return normalizeArchiveEntryName(entryName).split("/").filter(Boolean);
}

export function shouldSkipArchiveEntry(entryName: string) {
  const segments = entrySegments(entryName);
  if (segments.length === 0) {
    return true;
  }
  return segments[0] === "__MACOSX" || segments[segments.length - 1] === ".DS_Store";
}

export function normalizeSafeRelativePath(relativePath: string) {
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

export function isNestedEnvWrapperSegment(segment: string) {
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

export function normalizeEnvZipEntryRelativePath(entryName: string) {
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

export function resolveSafeTargetPath(targetRoot: string, relativePath: string) {
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

export function normalizeVersion(value: string) {
  return value.trim().replace(/^v/iu, "");
}

export function readVersionFileIfExists(filePath: string) {
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

export function toPosixRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

export function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function writeFileModeBestEffort(filePath: string, mode: number) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // File permissions are best-effort across packaged platforms and filesystems.
  }
}

export function restoreImportedShellScriptPermissions(filePath: string, platform: NodeJS.Platform) {
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

export async function persistInitialEnvPackage(input: {
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

export function normalizeZipEntries(zip: JSZip) {
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

export async function validateEnvZipVersion(entries: EnvZipEntry[], expectedDesktopVersion: string) {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
