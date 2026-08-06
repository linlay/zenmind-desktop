import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId, ServiceKind } from "../shared/contracts";
import { APP_BRAND } from "../shared/brand";
import { resolveRuntimeRootPath } from "./runtime-root";

const DESKTOP_DIRS = [
  "config",
  "data",
  "state",
  "logs",
  "cache",
  "secrets",
  "profiles"
] as const;
export const DESKTOP_SSO_ACCESS_TOKEN_FILE_NAME = "sso-access-token.txt";
type DesktopRootOptions = {
  platform?: NodeJS.Platform;
  homePath: string;
  registryDataRootPath?: string;
};

type ApplicationSupportRootOptions = {
  platform?: NodeJS.Platform;
  appDataPath: string;
};

function pathApiForRoot(platform: NodeJS.Platform | undefined, rootPath: string) {
  if (platform === "win32") {
    return path.posix.isAbsolute(rootPath) ? path.posix : path.win32;
  }
  if (path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)) {
    return path.win32;
  }
  return path.posix;
}

function resolveDesktopRoot({
  platform = process.platform,
  homePath,
  registryDataRootPath
}: DesktopRootOptions) {
  const rootPath = resolveRuntimeRootPath({ platform, homePath, registryDataRootPath });
  const pathApi = pathApiForRoot(platform, rootPath);
  const desktopDataSubdir = APP_BRAND.paths.desktopDataSubdir;
  return pathApi.resolve(pathApi.join(rootPath, desktopDataSubdir));
}

function resolveApplicationSupportRoot({
  platform = process.platform,
  appDataPath
}: ApplicationSupportRootOptions) {
  const pathApi = pathApiForRoot(platform, appDataPath);
  const programDataDirName = APP_BRAND.paths.programDataDirName;
  if (platform === "win32") {
    return pathApi.resolve(pathApi.join(appDataPath, programDataDirName));
  }
  if (platform === "darwin") {
    return pathApi.resolve(pathApi.join(appDataPath, programDataDirName));
  }
  return pathApi.resolve(pathApi.join(appDataPath, programDataDirName));
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

function getAppDataPath(app: Pick<App, "getPath">) {
  const appDataPath = tryGetAppPath(app, "appData");
  if (appDataPath) {
    return appDataPath;
  }
  const homePath = getHomePath(app);
  if (process.platform === "win32") {
    return path.join(homePath, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(homePath, "Library", "Application Support");
  }
  return path.join(homePath, ".config");
}

function getDesktopRootPath(app: Pick<App, "getPath">, platform: NodeJS.Platform = process.platform) {
  return resolveDesktopRoot({
    platform,
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
  ensureDirectory(path.join(dataRoot, "config", "desktop"));
  ensureDirectory(path.join(dataRoot, "config", "services"));
  ensureDirectory(path.join(dataRoot, "config", "plugins"));
  ensureDirectory(path.join(dataRoot, "config", "webs"));
  ensureDirectory(path.join(dataRoot, "data", "services"));
  ensureDirectory(path.join(dataRoot, "data", "plugins"));
  ensureDirectory(path.join(dataRoot, "data", "pets"));
  ensureDirectory(path.join(dataRoot, "data", "webs"));
  ensureDirectory(path.join(dataRoot, "data", "webs", "websites"));
  ensureDirectory(path.join(dataRoot, "data", "webs", "webapps"));
  ensureDirectory(path.join(dataRoot, "data", "webs", "webapp-data"));
  ensureDirectory(path.join(dataRoot, "data", "env-initial"));
  ensureDirectory(path.join(dataRoot, "state", "desktop"));
  ensureDirectory(path.join(dataRoot, "state", "services"));
  ensureDirectory(path.join(dataRoot, "state", "webs"));
  ensureDirectory(path.join(dataRoot, "state", "webs", "webapps"));
  ensureDirectory(path.join(dataRoot, "logs", "services"));
  ensureDirectory(path.join(dataRoot, "logs", "plugins"));
  ensureDirectory(path.join(dataRoot, "logs", "desktop"));
  ensureDirectory(path.join(dataRoot, "logs", "webs"));
  ensureDirectory(path.join(dataRoot, "logs", "webs", "webapps"));
  ensureDirectory(path.join(dataRoot, "cache", "marketplace"));
  ensureDirectory(path.join(dataRoot, "profiles", "electron"));
}

function kindDirectoryName(kind: ServiceKind) {
  return kind === "plugin" ? "plugins" : "services";
}

export function getDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  const dataRoot = getDesktopRootPath(app, platform);
  ensureDirectory(dataRoot);
  return dataRoot;
}

export const getDesktopRoot = getDataRoot;

export function desktopDataRootExists(app: App) {
  return fs.existsSync(getDesktopRootPath(app));
}

export function ensureDataRoot(app: App) {
  const dataRoot = getDesktopRootPath(app);
  ensureDesktopDirs(dataRoot);
  return dataRoot;
}

export function getProgramsRoot(app: App) {
  const programsRoot = getApplicationSupportRoot(app);
  ensureDirectory(programsRoot);
  return programsRoot;
}

export function getServicesRoot(app: App) {
  return path.join(getProgramsRoot(app), "services");
}

export function getPluginsRoot(app: App) {
  return path.join(getProgramsRoot(app), "plugins");
}

export function getConfigRoot(app: App) {
  return path.join(getDataRoot(app), "config");
}

export function getDesktopConfigRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "config", "desktop");
}

export function getDesktopPetSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "pet.json");
}

export function getAssistantSettingsRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return getDesktopConfigRoot(app, platform);
}

export function getServiceConfigRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "config", kindDirectoryName(kind), serviceId);
}

export function getRuntimeDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "data");
}

export function getDesktopPetsDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getRuntimeDataRoot(app, platform), "pets");
}

export function getDesktopWebsDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getRuntimeDataRoot(app, platform), "webs");
}

export function getDesktopWebsitesDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsDataRoot(app, platform), "websites");
}

export function getDesktopWebappsDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsDataRoot(app, platform), "webapps");
}

export function getDesktopWebappDataRoot(
  app: App,
  webappId: string,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopWebsDataRoot(app, platform), "webapp-data", webappId);
}

export function getDesktopWebappInstallStagingRoot(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopWebsDataRoot(app, platform), ".staging");
}

export function getDesktopWebappInstallBackupRoot(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopWebsDataRoot(app, platform), ".backup");
}

export function getDesktopWebsConfigRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "config", "webs");
}

export function getDesktopWebsitesConfigRoot(app: App) {
  return getDesktopWebsConfigRoot(app);
}

export function getDesktopWebsStateRoot(app: App) {
  return path.join(getDataRoot(app), "state", "webs");
}

export function getDesktopWebappsStateRoot(app: App) {
  return path.join(getDesktopWebsStateRoot(app), "webapps");
}

export function getDesktopWebappStateRoot(app: App, webappId: string) {
  return path.join(getDesktopWebappsStateRoot(app), webappId);
}

export function getDesktopWebsLogsRoot(app: App) {
  return path.join(getDataRoot(app), "logs", "webs");
}

export function getDesktopWebappsLogsRoot(app: App) {
  return path.join(getDesktopWebsLogsRoot(app), "webapps");
}

export function getDesktopWebappLogsRoot(app: App, webappId: string) {
  return path.join(getDesktopWebappsLogsRoot(app), webappId);
}

export function getDesktopInitialEnvDataRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getRuntimeDataRoot(app, platform), "env-initial");
}

export function getServiceDataRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin") {
  return path.join(getDataRoot(app), "data", kindDirectoryName(kind), serviceId);
}

export function getApplicationSupportRoot(app: App) {
  const applicationSupportRoot = resolveApplicationSupportRoot({
    platform: process.platform,
    appDataPath: getAppDataPath(app)
  });
  ensureDirectory(applicationSupportRoot);
  return applicationSupportRoot;
}

export function getAssistantTempRoot(app: App) {
  const tempRoot = tryGetAppPath(app, "temp") || os.tmpdir();
  return path.join(tempRoot, APP_BRAND.packageName, "assistant");
}

export function getStateRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "state");
}

export function getDesktopStateRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "state", "desktop");
}

function resolveDesktopSsoAccessTokenFilePath(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform
) {
  const pathApi = pathApiForRoot(platform, dataRoot);
  return pathApi.join(dataRoot, "state", "desktop", DESKTOP_SSO_ACCESS_TOKEN_FILE_NAME);
}

export function getDesktopSsoAccessTokenFilePath(
  app: Pick<App, "getPath">,
  platform: NodeJS.Platform = process.platform
) {
  return resolveDesktopSsoAccessTokenFilePath(getDataRoot(app as App, platform), platform);
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

export function getMarketplaceConfigRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "config", "marketplace");
}

export function getMarketplaceStateRoot(app: App) {
  return path.join(getDataRoot(app), "state", "marketplace");
}

export function getSecretsRoot(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDataRoot(app, platform), "secrets");
}

export const getCredentialsRoot = getSecretsRoot;

export function getProfilesRoot(app: App) {
  return path.join(getDataRoot(app), "profiles");
}

export function getElectronUserDataRoot(app: App) {
  return path.join(getProfilesRoot(app), "electron");
}

export const __testInternals = {
  DESKTOP_DIRS,
  resolveDesktopRoot,
  resolveApplicationSupportRoot,
  resolveDesktopSsoAccessTokenFilePath
};
