import fs from "node:fs";
import path from "node:path";

import type { ServiceRevealPathOptions, ServiceRevealPathResult } from "../shared/contracts";
import { t } from "./i18n/main-i18n";

type RevealPlatform = NodeJS.Platform;
type RevealTargetType = NonNullable<ServiceRevealPathOptions["targetType"]>;

export interface RevealPathDeps {
  existsSync?: (targetPath: string) => boolean;
  statSync?: (targetPath: string) => { isDirectory: () => boolean };
  showItemInFolder: (targetPath: string) => void;
  openPath: (targetPath: string) => Promise<string>;
  platform?: RevealPlatform;
}

function isAbsoluteForPlatform(targetPath: string, platform: RevealPlatform) {
  if (platform === "win32") {
    return path.win32.isAbsolute(targetPath);
  }
  return path.posix.isAbsolute(targetPath);
}

function dirnameForPlatform(targetPath: string, platform: RevealPlatform) {
  if (platform === "win32") {
    return path.win32.dirname(targetPath);
  }
  return path.posix.dirname(targetPath);
}

function normalizeTargetType(value: ServiceRevealPathOptions["targetType"] | undefined): RevealTargetType | "auto" {
  if (value === "file" || value === "directory") {
    return value;
  }
  return "auto";
}

async function openDirectory(
  targetPath: string,
  deps: Required<Pick<RevealPathDeps, "openPath">>
): Promise<ServiceRevealPathResult> {
  const error = await deps.openPath(targetPath);
  if (error) {
    return {
      ok: false,
      path: targetPath,
      message: error
    };
  }

  return {
    ok: true,
    path: targetPath,
    message: t("revealPath.openedDirectory")
  };
}

export async function revealPathInFileManager(
  targetPath: string,
  options: ServiceRevealPathOptions = {},
  deps: RevealPathDeps
): Promise<ServiceRevealPathResult> {
  const platform = deps.platform ?? process.platform;
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const normalizedPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    return {
      ok: false,
      path: "",
      message: t("revealPath.pathRequired")
    };
  }
  if (!isAbsoluteForPlatform(normalizedPath, platform)) {
    return {
      ok: false,
      path: normalizedPath,
      message: t("revealPath.absolutePathRequired")
    };
  }

  const existsSync = deps.existsSync ?? fs.existsSync;
  const statSync = deps.statSync ?? fs.statSync;
  const requestedTargetType = normalizeTargetType(options.targetType);
  const exists = existsSync(normalizedPath);

  if (exists) {
    const isDirectory = requestedTargetType === "directory" || statSync(normalizedPath).isDirectory();
    if (isDirectory) {
      if (isWindows) {
        return openDirectory(normalizedPath, deps);
      }
      if (isMac) {
        return openDirectory(normalizedPath, deps);
      }
      return openDirectory(normalizedPath, deps);
    }

    deps.showItemInFolder(normalizedPath);
    const message = isWindows
      ? t("revealPath.shownInExplorer")
      : isMac
        ? t("revealPath.shownInFinder")
        : t("revealPath.shownInFileManager");
    return {
      ok: true,
      path: normalizedPath,
      message
    };
  }

  if (requestedTargetType === "file") {
    const parentDir = dirnameForPlatform(normalizedPath, platform);
    if (parentDir && parentDir !== normalizedPath && existsSync(parentDir)) {
      const opened = await openDirectory(parentDir, deps);
      if (!opened.ok) {
        return opened;
      }
      return {
        ok: true,
        path: parentDir,
        message: t("revealPath.openedParentDirectory")
      };
    }
    return {
      ok: false,
      path: normalizedPath,
      message: t("revealPath.parentDirectoryMissing")
    };
  }

  return {
    ok: false,
    path: normalizedPath,
    message: requestedTargetType === "directory" ? t("revealPath.directoryMissing") : t("revealPath.pathMissing")
  };
}
