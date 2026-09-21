import path from "node:path";
import { t } from "./runtime-environment-translator";
import { APP_BRAND } from "../../../shared/brand";
import { ENV_ZIP_ROOT_DIR_NAME, REMOVED_SKILLS_MARKET_DIR_NAME, EnvZipEntry, VERSION_FILE_NAME } from "./runtime-env-contracts";
import fs from "node:fs";
import { createHash } from "node:crypto";
import JSZip from "jszip";

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
