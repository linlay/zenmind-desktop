import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";

const MANAGED_DATA_DIRS = ["services", "plugins", "credentials"] as const;

type DefaultDataRootOptions = {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  userDataPath: string;
  execPath?: string;
};

function resolveDefaultDataRoot({
  platform = process.platform,
  isPackaged = false,
  userDataPath,
  execPath = process.execPath
}: DefaultDataRootOptions) {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "win32" && isPackaged) {
    return pathApi.join(pathApi.dirname(execPath), "data");
  }
  return pathApi.resolve(userDataPath);
}

function getDefaultDataRoot(app: App) {
  return resolveDefaultDataRoot({
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged
  });
}

function ensureDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureManagedDataDirs(dataRoot: string) {
  ensureDirectory(dataRoot);
  for (const dirName of MANAGED_DATA_DIRS) {
    ensureDirectory(path.join(dataRoot, dirName));
  }
}

export function getDataRoot(app: App) {
  const dataRoot = getDefaultDataRoot(app);
  ensureDirectory(dataRoot);
  return dataRoot;
}

export function ensureDataRoot(app: App) {
  const dataRoot = getDefaultDataRoot(app);
  ensureManagedDataDirs(dataRoot);
  return dataRoot;
}

export function getServicesRoot(app: App) {
  return path.join(getDataRoot(app), "services");
}

export function getPluginsRoot(app: App) {
  return path.join(getDataRoot(app), "plugins");
}

export function getCredentialsRoot(app: App) {
  return path.join(getDataRoot(app), "credentials");
}

export const __testInternals = {
  MANAGED_DATA_DIRS,
  resolveDefaultDataRoot
};
