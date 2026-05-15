import fs from "node:fs";
import path from "node:path";

import type { ServiceRevealPathOptions, ServiceRevealPathResult } from "../shared/contracts";

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
    message: "已打开目录。"
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
      message: "缺少要打开的路径。"
    };
  }
  if (!isAbsoluteForPlatform(normalizedPath, platform)) {
    return {
      ok: false,
      path: normalizedPath,
      message: "只能打开绝对路径。"
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
    return {
      ok: true,
      path: normalizedPath,
      message: isWindows ? "已在 Explorer 中显示。" : isMac ? "已在 Finder 中显示。" : "已在文件管理器中显示。"
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
        message: "目标文件尚未创建，已打开所在目录。"
      };
    }
    return {
      ok: false,
      path: normalizedPath,
      message: "目标文件尚未创建，所在目录也不存在。"
    };
  }

  return {
    ok: false,
    path: normalizedPath,
    message: requestedTargetType === "directory" ? "目录不存在。" : "路径不存在。"
  };
}
