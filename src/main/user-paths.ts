import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId, ServiceKind } from "../shared/contracts";

export type DesktopDataLayoutMode = "layered" | "legacy";

const LAYERED_DESKTOP_DIRS = [
  "programs",
  "config",
  "data",
  "state",
  "logs",
  "cache",
  "secrets",
  "profiles"
] as const;
const LEGACY_MANAGED_DATA_DIRS = ["services", "plugins", "credentials"] as const;
const LEGACY_DATA_MARKERS = [
  "services",
  "plugins",
  "credentials",
  "assistant",
  "settings",
  "desktop-pet",
  "marketplace",
  ".zenmind-desktop"
] as const;

type DefaultDesktopRootOptions = {
  platform?: NodeJS.Platform;
  homePath: string;
};

type LegacyDesktopRootOptions = {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  appDataPath?: string;
  userDataPath?: string;
  execPath?: string;
};

type DesktopLayoutResolutionOptions = DefaultDesktopRootOptions & LegacyDesktopRootOptions;

export type DesktopDataLayout = {
  mode: DesktopDataLayoutMode;
  root: string;
  defaultRoot: string;
  legacyRoot: string;
};

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

function resolveDefaultDesktopRoot({
  platform = process.platform,
  homePath
}: DefaultDesktopRootOptions) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(homePath, ".zenmind", ".desktop");
}

function resolveLegacyDesktopRoot({
  platform = process.platform,
  isPackaged = false,
  appDataPath,
  userDataPath,
  execPath = process.execPath
}: LegacyDesktopRootOptions) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "win32" && isPackaged) {
    return pathApi.join(pathApi.dirname(execPath), "data");
  }
  if (appDataPath) {
    return pathApi.join(appDataPath, "zenmind-desktop");
  }
  if (userDataPath) {
    return pathApi.resolve(userDataPath);
  }
  return pathApi.join(os.homedir(), ".zenmind-desktop");
}

function directoryHasAnyMarker(root: string, markers: readonly string[]) {
  return markers.some((marker) => fs.existsSync(path.join(root, marker)));
}

function isExistingLayeredRoot(root: string) {
  return fs.existsSync(root);
}

function isExistingLegacyRoot(root: string) {
  return directoryHasAnyMarker(root, LEGACY_DATA_MARKERS);
}

function resolveDesktopDataLayoutFromPaths(options: DesktopLayoutResolutionOptions): DesktopDataLayout {
  const pathApi = pathApiForPlatform(options.platform);
  const defaultRoot = pathApi.resolve(resolveDefaultDesktopRoot(options));
  const legacyRoot = pathApi.resolve(resolveLegacyDesktopRoot(options));
  const legacyUserDataRoot = options.userDataPath ? pathApi.resolve(options.userDataPath) : "";

  if (isExistingLayeredRoot(defaultRoot)) {
    return {
      mode: "layered",
      root: defaultRoot,
      defaultRoot,
      legacyRoot
    };
  }

  if (isExistingLegacyRoot(legacyRoot)) {
    return {
      mode: "legacy",
      root: legacyRoot,
      defaultRoot,
      legacyRoot
    };
  }

  if (legacyUserDataRoot && legacyUserDataRoot !== legacyRoot && isExistingLegacyRoot(legacyUserDataRoot)) {
    return {
      mode: "legacy",
      root: legacyUserDataRoot,
      defaultRoot,
      legacyRoot: legacyUserDataRoot
    };
  }

  return {
    mode: "layered",
    root: defaultRoot,
    defaultRoot,
    legacyRoot
  };
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
  const appData = tryGetAppPath(app, "appData");
  if (appData) {
    return appData;
  }

  const userData = tryGetAppPath(app, "userData");
  if (userData) {
    return path.dirname(userData);
  }

  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(getHomePath(app), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return path.join(getHomePath(app), "Library", "Application Support");
  }

  return path.join(getHomePath(app), ".config");
}

function resolveDesktopDataLayout(app: Pick<App, "getPath" | "isPackaged">): DesktopDataLayout {
  return resolveDesktopDataLayoutFromPaths({
    platform: process.platform,
    homePath: getHomePath(app),
    appDataPath: getAppDataPath(app),
    userDataPath: tryGetAppPath(app, "userData"),
    isPackaged: app.isPackaged,
    execPath: process.execPath
  });
}

function ensureDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureLegacyDataDirs(dataRoot: string) {
  ensureDirectory(dataRoot);
  for (const dirName of LEGACY_MANAGED_DATA_DIRS) {
    ensureDirectory(path.join(dataRoot, dirName));
  }
}

function ensureLayeredDataDirs(dataRoot: string) {
  ensureDirectory(dataRoot);
  for (const dirName of LAYERED_DESKTOP_DIRS) {
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

function ensureActiveDataDirs(layout: DesktopDataLayout) {
  if (layout.mode === "layered") {
    ensureLayeredDataDirs(layout.root);
    return;
  }
  ensureLegacyDataDirs(layout.root);
}

function getLayeredOrLegacyPath(
  app: App,
  layered: (root: string) => string,
  legacy: (root: string) => string
) {
  const layout = resolveDesktopDataLayout(app);
  return layout.mode === "layered" ? layered(layout.root) : legacy(layout.root);
}

function kindDirectoryName(kind: ServiceKind) {
  return kind === "plugin" ? "plugins" : "services";
}

export function getDesktopDataLayout(app: App) {
  return resolveDesktopDataLayout(app);
}

export function getDesktopDataLayoutMode(app: App) {
  return resolveDesktopDataLayout(app).mode;
}

export function usesLayeredDesktopDataLayout(app: App) {
  return resolveDesktopDataLayout(app).mode === "layered";
}

export function getDataRoot(app: App) {
  const layout = resolveDesktopDataLayout(app);
  ensureDirectory(layout.root);
  return layout.root;
}

export const getDesktopRoot = getDataRoot;

export function ensureDataRoot(app: App) {
  const layout = resolveDesktopDataLayout(app);
  ensureActiveDataDirs(layout);
  return layout.root;
}

export function getProgramsRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "programs"), (root) => root);
}

export function getServicesRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "programs", "services"), (root) => path.join(root, "services"));
}

export function getPluginsRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "programs", "plugins"), (root) => path.join(root, "plugins"));
}

export function getConfigRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "config"), (root) => root);
}

export function getDesktopConfigRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "config", "desktop"), (root) => path.join(root, "settings"));
}

export function getDesktopPetSettingsPath(app: App) {
  return getLayeredOrLegacyPath(
    app,
    (root) => path.join(root, "config", "desktop", "desktop-pet.json"),
    (root) => path.join(root, "desktop-pet", "state.json")
  );
}

export function getAssistantSettingsRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "config", "desktop"), (root) => path.join(root, "assistant"));
}

export function getServiceConfigRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin", legacyInstallDir = "") {
  return getLayeredOrLegacyPath(
    app,
    (root) => path.join(root, "config", kindDirectoryName(kind), serviceId),
    (root) => legacyInstallDir || path.join(root, kindDirectoryName(kind), serviceId)
  );
}

export function getRuntimeDataRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "data"), (root) => root);
}

export function getServiceDataRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin", legacyInstallDir = "") {
  return getLayeredOrLegacyPath(
    app,
    (root) => path.join(root, "data", kindDirectoryName(kind), serviceId),
    () => legacyInstallDir
  );
}

export function getAssistantDataRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "data", "assistant"), (root) => path.join(root, "assistant"));
}

export function getStateRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "state"), (root) => path.join(root, ".zenmind-desktop"));
}

export function getDesktopStateRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "state", "desktop"), (root) => path.join(root, ".zenmind-desktop"));
}

export function getServiceStateRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin", legacyInstallDir = "") {
  return getLayeredOrLegacyPath(
    app,
    (root) => path.join(root, "state", kindDirectoryName(kind), serviceId),
    () => legacyInstallDir ? path.join(legacyInstallDir, ".zenmind-desktop") : ""
  );
}

export function getLogsRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "logs"), (root) => root);
}

export function getServiceLogsRoot(app: App, serviceId: ServiceId, kind: ServiceKind = "builtin", legacyInstallDir = "") {
  return getLayeredOrLegacyPath(
    app,
    (root) => path.join(root, "logs", kindDirectoryName(kind), serviceId),
    () => legacyInstallDir ? path.join(legacyInstallDir, "run") : ""
  );
}

export function getCacheRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "cache"), (root) => root);
}

export function getMarketplaceCacheRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "cache", "marketplace"), (root) => path.join(root, "marketplace"));
}

export function getMarketplaceConfigRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "config", "marketplace"), (root) => path.join(root, "marketplace"));
}

export function getMarketplaceStateRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "state", "marketplace"), (root) => path.join(root, "marketplace"));
}

export function getSecretsRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "secrets"), (root) => path.join(root, "credentials"));
}

export const getCredentialsRoot = getSecretsRoot;

export function getProfilesRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "profiles"), (root) => root);
}

export function getElectronUserDataRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "profiles", "electron"), (root) => root);
}

export function getControlledChromeProfileRoot(app: App) {
  return getLayeredOrLegacyPath(app, (root) => path.join(root, "profiles", "controlled-system-chrome"), (root) => path.join(root, "controlled-system-chrome"));
}

export const __testInternals = {
  LEGACY_DATA_MARKERS,
  LEGACY_MANAGED_DATA_DIRS,
  LAYERED_DESKTOP_DIRS,
  resolveDefaultDesktopRoot,
  resolveLegacyDesktopRoot,
  resolveDesktopDataLayoutFromPaths
};
