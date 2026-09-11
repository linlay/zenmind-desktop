import fs from "node:fs";
import path from "node:path";

type DesktopPathApp = {
  getPath: (name: "desktop" | "downloads" | "home") => string;
};

type AvailablePathOptions = {
  platform?: NodeJS.Platform | string;
  fsAccess?: (filePath: string, mode?: number) => Promise<unknown>;
  now?: () => number;
};

export function sanitizeDownloadFilename(filename: string, fallback: string) {
  const normalized = filename.trim() || fallback;
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").slice(0, 180) || fallback;
}

export function getPlatformPath(platform: NodeJS.Platform | string = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function getAssistantExportDefaultPath(
  app: DesktopPathApp,
  filename: string,
  platform: NodeJS.Platform | string = process.platform
) {
  const safeFilename = sanitizeDownloadFilename(filename, "chat-export.json");
  const baseDir = platform === "win32" || platform === "darwin"
    ? app.getPath("downloads")
    : app.getPath("home");
  return getPlatformPath(platform).join(baseDir, safeFilename);
}

export function getDesktopDownloadDefaultPath(
  app: DesktopPathApp | undefined,
  filename: string,
  platform: NodeJS.Platform | string = process.platform
) {
  const safeFilename = sanitizeDownloadFilename(filename, "download");
  const baseDir = platform === "win32" || platform === "darwin"
    ? app?.getPath("downloads")
    : app?.getPath("home");
  if (!baseDir) {
    throw new Error("downloads_path_unavailable");
  }
  return getPlatformPath(platform).join(baseDir, safeFilename);
}

export function getSandboxImageExportDefaultPath(
  app: DesktopPathApp,
  platform: NodeJS.Platform | string,
  imageRef: string
) {
  const safeFilename = sanitizeDownloadFilename(`${imageRef || "sandbox-image"}.tar`, "sandbox-image.tar");
  const baseDir = platform === "win32" || platform === "darwin"
    ? app.getPath("desktop")
    : app.getPath("home");
  return getPlatformPath(platform).join(baseDir, safeFilename);
}

export async function getAvailableFilePath(targetPath: string, options: AvailablePathOptions = {}) {
  const platformPath = getPlatformPath(options.platform);
  const parsedPath = platformPath.parse(targetPath);
  const fsAccess = options.fsAccess || fs.promises.access;
  for (let index = 0; index < 1000; index += 1) {
    const candidatePath =
      index === 0
        ? targetPath
        : platformPath.join(parsedPath.dir, `${parsedPath.name} (${index})${parsedPath.ext}`);
    try {
      await fsAccess(candidatePath, fs.constants.F_OK);
    } catch {
      return candidatePath;
    }
  }
  return platformPath.join(parsedPath.dir, `${parsedPath.name}-${options.now?.() ?? Date.now()}${parsedPath.ext}`);
}
