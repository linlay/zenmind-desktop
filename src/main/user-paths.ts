import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId, ServiceKind } from "../shared/contracts";

const DESKTOP_DIRS = [
  "programs",
  "config",
  "data",
  "state",
  "logs",
  "cache",
  "secrets",
  "profiles"
] as const;

type DesktopRootOptions = {
  platform?: NodeJS.Platform;
  homePath: string;
};

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

function resolveDesktopRootFromHome({
  platform = process.platform,
  homePath
}: DesktopRootOptions) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.resolve(pathApi.join(homePath, ".zenmind", ".desktop"));
}

function tryGetAppPath(app: Pick<App, "getPath">, name: Parameters<App["getPath"]>[0]) {
  try {
    const value = app.getPath(name);
    return typeof value === "string" && value.trim() ? value : "";
  } catch {
    return "";
  }
}

function getHomePath(app: Pick<App, "getPath">) {
  return tryGetAppPath(app, "home") || process.env.HOME || os.homedir();
}

function getDesktopRootPath(app: Pick<App, "getPath">) {
  return resolveDesktopRootFromHome({
    platform: process.platform,
    homePath: getHomePath(app)
  });
}

function ensureDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureDesktopDirs(dataRoot: string) {
  ensureDirectory(dataRoot);
  for (const dirName of DESKTOP_DIRS) {
    ensureDirectory(path.join(dataRoot, dirName));
  }
  ensureDirectory(path.join(dataRoot, "programs", "services"));
  ensureDirectory(path.join(dataRoot, "programs", "plugins"));
  ensureDirectory(path.join(dataRoot, "config", "desktop"));
  ensureDirectory(path.join(dataRoot, "config", "services"));
  ensureDirectory(path.join(dataRoot, "config", "plugins"));
  ensureDirectory(path.join(dataRoot, "data", "services"));
  ensureDirectory(path.join(dataRoot, "data", "plugins"));
  ensureDirectory(path.join(dataRoot, "state", "desktop"));
  ensureDirectory(path.join(dataRoot, "state", "services"));
  ensureDirectory(path.join(dataRoot, "logs", "services"));
  ensureDirectory(path.join(dataRoot, "logs", "plugins"));
  ensureDirectory(path.join(dataRoot, "cache", "marketplace"));
  ensureDirectory(path.join(dataRoot, "profiles", "electron"));
}

function kindDirectoryName(kind: ServiceKind) {
  return kind === "plugin" ? "plugins" : "services";
}

export function getDataRoot(app: App) {
  const dataRoot = getDesktopRootPath(app);
  ensureDirectory(dataRoot);
  return dataRoot;
}

export const getDesktopRoot = getDataRoot;

export function ensureDataRoot(app: App) {
  const dataRoot = getDesktopRootPath(app);
  ensureDesktopDirs(dataRoot);
  return dataRoot;
}

export function getProgramsRoot(app: App) {
  return path.join(getDataRoot(app), "programs");
}

export function getServicesRoot(app: App) {
  return path.join(getDataRoot(app), "programs", "services");
}

export function getPluginsRoot(app: App) {
  return path.join(getDataRoot(app), "programs", "plugins");
}

export function getConfigRoot(app: App) {
  return path.join(getDataRoot(app), "config");
}

export function getDesktopConfigRoot(app: App) {
  return path.join(getDataRoot(app), "config", "desktop");
}

export function getDesktopPetSettingsPath(app: App) {
  return path.join(getDesktopConfigRoot(app), "desktop-pet.json");
}

export function getAssistantSettingsRoot(app: App) {
  return getDesktopConfigRoot(app);
}

export function getServiceConfigRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "config", kindDirectoryName(kind), serviceId);
}

export function getRuntimeDataRoot(app: App) {
  return path.join(getDataRoot(app), "data");
}

export function getServiceDataRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "data", kindDirectoryName(kind), serviceId);
}

export function getAssistantDataRoot(app: App) {
  return path.join(getDataRoot(app), "data", "assistant");
}

export function getStateRoot(app: App) {
  return path.join(getDataRoot(app), "state");
}

export function getDesktopStateRoot(app: App) {
  return path.join(getDataRoot(app), "state", "desktop");
}

export function getServiceStateRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "state", kindDirectoryName(kind), serviceId);
}

export function getLogsRoot(app: App) {
  return path.join(getDataRoot(app), "logs");
}

export function getServiceLogsRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "logs", kindDirectoryName(kind), serviceId);
}

export function getCacheRoot(app: App) {
  return path.join(getDataRoot(app), "cache");
}

export function getMarketplaceCacheRoot(app: App) {
  return path.join(getDataRoot(app), "cache", "marketplace");
}

export function getMarketplaceConfigRoot(app: App) {
  return path.join(getDataRoot(app), "config", "marketplace");
}

export function getMarketplaceStateRoot(app: App) {
  return path.join(getDataRoot(app), "state", "marketplace");
}

export function getSecretsRoot(app: App) {
  return path.join(getDataRoot(app), "secrets");
}

export const getCredentialsRoot = getSecretsRoot;

export function getProfilesRoot(app: App) {
  return path.join(getDataRoot(app), "profiles");
}

export function getElectronUserDataRoot(app: App) {
  return path.join(getProfilesRoot(app), "electron");
}

export function getControlledChromeProfileRoot(app: App) {
  return path.join(getProfilesRoot(app), "controlled-system-chrome");
}

export const __testInternals = {
  DESKTOP_DIRS,
  resolveDesktopRootFromHome
};
