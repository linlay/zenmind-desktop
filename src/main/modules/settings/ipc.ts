import fs from "node:fs";
import path from "node:path";
import type {
  DesktopGeneralSettings,
  DesktopGeneralSettingsInput,
  DesktopStateFileName,
  DesktopStateFileSnapshot,
  DesktopStateSnapshot,
  DesktopUsageProfileResult,
  DesktopWsServerStartOptions,
  DesktopWsServerState,
  EnterpriseImSettings,
  TunnelHubSettingsInput,
  TunnelHubSettingsResult,
  TunnelHubRuntimeStatus
} from "../../../shared/contracts";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_WS_URL
} from "../../../shared/desktop-ws";
import { readTunnelHubSettings, saveTunnelHubSettings } from "../tunnel";
import {
  readEnterpriseImSettings,
  setEnterpriseImEnabled
} from "../enterprise-chat";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot, type DesktopThemePreference } from "../../infrastructure/filesystem/profile-store";
import { getDesktopConfigRoot, getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import { getDesktopDeviceInfo } from "../identity";
import { getDesktopDeviceIdentityInfo } from "../identity";
import { getDesktopUsageProfile } from "./usage-profile";
import { readWebOrderKeys, writeWebOrderKeys } from "../webs";
import { t } from "../../support/i18n/main-i18n";
import { requireEpochMillis } from "../../../shared/time-contract";

export interface SettingsIpcHandlerOptions {
  app: any;
  platform?: NodeJS.Platform;
  nativeTheme: { themeSource: string };
  getDataRoot: (app: any) => string;
  resetRuntimeEnv?: (app: any, platform: string) => Promise<{
    targetRoot: string;
    backupPath?: string;
    copiedFiles: number;
    skippedFiles: number;
    sourceZipPath: string;
  }>;
  initializeMainI18n: (app: any) => any;
  isSupportedLocale: (locale: unknown) => boolean;
  setMainLocale: (app: any, locale: any) => any;
  getAppInfo?: () => any;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  refreshMainWindowAppearance?: () => void;
  emitLocaleChanged: (settings: any) => void;
  createAppPairingPayload?: (app: any, options?: {
    getTunnelHubRuntimeStatus?: () => TunnelHubRuntimeStatus;
  }) => Promise<any>;
  getUsageProfile?: (app: any) => Promise<DesktopUsageProfileResult>;
  onGeneralSettingsChanged?: (settings: DesktopGeneralSettings) => void;
  onEnterpriseImSettingsChanged?: (settings: EnterpriseImSettings) => void;
  getDesktopWsServerRuntimeState?: () => Omit<DesktopWsServerState, "enabled">;
  startDesktopWsServer?: (options?: DesktopWsServerStartOptions) => Promise<Omit<DesktopWsServerState, "enabled">>;
  stopDesktopWsServer?: () => Promise<Omit<DesktopWsServerState, "enabled">>;
  applyTunnelHubSettings?: (input: TunnelHubSettingsInput) => Promise<TunnelHubSettingsResult>;
  getTunnelHubRuntimeStatus?: () => TunnelHubRuntimeStatus;
}

const DESKTOP_STATE_DEBUG_FILES: ReadonlyArray<{
  name: DesktopStateFileName;
  format: DesktopStateFileSnapshot["format"];
}> = [
  { name: "bootstrap.json", format: "json" },
  { name: "env-bootstrap.json", format: "json" },
  { name: "pet-state.json", format: "json" },
  { name: "sso-session.json", format: "json" },
  { name: "sso-access-token.txt", format: "text" }
];

function desktopStateFileSnapshot(
  rootPath: string,
  definition: (typeof DESKTOP_STATE_DEBUG_FILES)[number]
): DesktopStateFileSnapshot {
  const filePath = path.join(rootPath, definition.name);
  try {
    const stats = fs.statSync(filePath);
    const modifiedAt = requireEpochMillis(
      Math.trunc(stats.mtimeMs),
      `settings.desktopState.${definition.name}.modifiedAt`
    );
    if (!stats.isFile()) {
      return {
        ...definition,
        path: filePath,
        exists: true,
        size: stats.size,
        modifiedAt,
        content: "",
        error: "Expected a regular file."
      };
    }

    const rawContent = fs.readFileSync(filePath, "utf8");
    if (definition.format === "text") {
      return {
        ...definition,
        path: filePath,
        exists: true,
        size: stats.size,
        modifiedAt,
        content: rawContent
      };
    }

    try {
      return {
        ...definition,
        path: filePath,
        exists: true,
        size: stats.size,
        modifiedAt,
        content: JSON.stringify(JSON.parse(rawContent), null, 2)
      };
    } catch (error) {
      return {
        ...definition,
        path: filePath,
        exists: true,
        size: stats.size,
        modifiedAt,
        content: rawContent,
        error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") {
      return {
        ...definition,
        path: filePath,
        exists: false,
        size: 0,
        modifiedAt: null,
        content: ""
      };
    }
    return {
      ...definition,
      path: filePath,
      exists: fs.existsSync(filePath),
      size: 0,
      modifiedAt: null,
      content: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function getDesktopStateSnapshot(
  app: any,
  platform: NodeJS.Platform = process.platform
): DesktopStateSnapshot {
  const rootPath = getDesktopStateRoot(app, platform);
  return {
    rootPath,
    readAt: requireEpochMillis(Date.now(), "settings.desktopState.readAt"),
    files: DESKTOP_STATE_DEBUG_FILES.map((definition) =>
      desktopStateFileSnapshot(rootPath, definition)
    )
  };
}

export function setNativeThemeSource(nativeTheme: { themeSource: string }, themeMode: string) {
  nativeTheme.themeSource = themeMode === "dark" ? "dark" : themeMode === "system" ? "system" : "light";
  return {
    ok: true,
    themeSource: nativeTheme.themeSource
  };
}

function normalizeThemePreference(themeMode: unknown): DesktopThemePreference {
  return themeMode === "dark" || themeMode === "light" || themeMode === "system" ? themeMode : "system";
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function defaultDesktopWsServerRuntimeState(): Omit<DesktopWsServerState, "enabled"> {
  return {
    running: false,
    host: DESKTOP_WS_HOST,
    port: DESKTOP_WS_PORT,
    path: DESKTOP_WS_PATH,
    url: DESKTOP_WS_URL
  };
}

function desktopWsServerState(
  enabled: boolean,
  runtimeState: Omit<DesktopWsServerState, "enabled"> | undefined,
  message?: string
): DesktopWsServerState {
  return {
    ...defaultDesktopWsServerRuntimeState(),
    ...runtimeState,
    enabled,
    ...(message ? { message } : {})
  };
}

export function registerSettingsIpcHandlers(ipcMain: any, options: SettingsIpcHandlerOptions) {
  const {
    app,
    platform = process.platform,
    nativeTheme,
    getDataRoot,
    resetRuntimeEnv,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo,
    buildApplicationMenu,
    refreshTrayContextMenu,
    refreshMainWindowAppearance,
    emitLocaleChanged,
    createAppPairingPayload,
    getUsageProfile,
    onGeneralSettingsChanged,
    onEnterpriseImSettingsChanged,
    getDesktopWsServerRuntimeState,
    startDesktopWsServer,
    stopDesktopWsServer,
    applyTunnelHubSettings,
    getTunnelHubRuntimeStatus
  } = options;

  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => platform);
  ipcMain.handle("settings.getAppInfo", async () => getAppInfo?.() ?? {
    productName: app.name ?? "",
    version: typeof app.getVersion === "function" ? app.getVersion() : "",
    buildTime: ""
  });
  ipcMain.handle("settings.getDeviceIdentity", async () => getDesktopDeviceIdentityInfo(app));
  ipcMain.handle("settings.getDesktopStateSnapshot", async () =>
    getDesktopStateSnapshot(app, platform)
  );
  ipcMain.handle("settings.getUsageProfile", async () =>
    getUsageProfile ? getUsageProfile(app) : getDesktopUsageProfile(app)
  );
  ipcMain.handle("settings.getDesktopDeviceInfo", async () => getDesktopDeviceInfo(app));
  ipcMain.handle("settings.getGeneralSettings", async () =>
    readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general
  );
  ipcMain.handle("settings.getDesktopWsServerState", async () => {
    const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    return desktopWsServerState(profile.general.desktopWsServerEnabled, getDesktopWsServerRuntimeState?.());
  });
  ipcMain.handle("settings.setDesktopWsServerEnabled", async (_event: any, enabled: boolean) => {
    const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    const nextEnabled = enabled === true;
    if (nextEnabled) {
      if (!startDesktopWsServer) {
        return desktopWsServerState(false, getDesktopWsServerRuntimeState?.(), t("settings.debug.desktopWs.unavailable"));
      }
      try {
        const runtimeState = await startDesktopWsServer();
        const profile = updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
          general: {
            deviceName: current.general.deviceName,
            preventSleepWhileRunning: current.general.preventSleepWhileRunning,
            desktopWsServerEnabled: true,
            desktopActionConfirmationEnabled: current.general.desktopActionConfirmationEnabled
          }
        });
        onGeneralSettingsChanged?.(profile.general);
        return desktopWsServerState(true, runtimeState);
      } catch (error) {
        return desktopWsServerState(
          current.general.desktopWsServerEnabled,
          getDesktopWsServerRuntimeState?.(),
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    let runtimeState: Omit<DesktopWsServerState, "enabled"> | undefined;
    let message = "";
    try {
      runtimeState = stopDesktopWsServer ? await stopDesktopWsServer() : getDesktopWsServerRuntimeState?.();
    } catch (error) {
      runtimeState = getDesktopWsServerRuntimeState?.();
      message = error instanceof Error ? error.message : String(error);
    }
    const profile = updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        deviceName: current.general.deviceName,
        preventSleepWhileRunning: current.general.preventSleepWhileRunning,
        desktopWsServerEnabled: false,
        desktopActionConfirmationEnabled: current.general.desktopActionConfirmationEnabled
      }
    });
    onGeneralSettingsChanged?.(profile.general);
    return desktopWsServerState(false, runtimeState, message);
  });
  ipcMain.handle("settings.saveGeneralSettings", async (_event: any, input: DesktopGeneralSettingsInput) => {
    const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    const profile = updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        deviceName: typeof input?.deviceName === "string"
          ? input.deviceName
          : current.general.deviceName,
        preventSleepWhileRunning: typeof input?.preventSleepWhileRunning === "boolean"
          ? input.preventSleepWhileRunning
          : current.general.preventSleepWhileRunning,
        desktopActionConfirmationEnabled: typeof input?.desktopActionConfirmationEnabled === "boolean"
          ? input.desktopActionConfirmationEnabled
          : current.general.desktopActionConfirmationEnabled,
        desktopWsServerEnabled: current.general.desktopWsServerEnabled
      }
    });
    onGeneralSettingsChanged?.(profile.general);
    return profile.general;
  });
  ipcMain.handle("settings.getEnterpriseImSettings", async () =>
    readEnterpriseImSettings(app, platform)
  );
  ipcMain.handle("settings.setEnterpriseImEnabled", async (_event: any, enabled: boolean) => {
    const settings = setEnterpriseImEnabled(app, enabled, platform);
    onEnterpriseImSettingsChanged?.(settings);
    return settings;
  });
  ipcMain.handle("settings.getTunnelHubSettings", async () => readTunnelHubSettings(app));
  ipcMain.handle("settings.saveTunnelHubSettings", async (_event: any, input: TunnelHubSettingsInput) =>
    applyTunnelHubSettings ? applyTunnelHubSettings(input) : saveTunnelHubSettings(app, input)
  );
  ipcMain.handle("settings.resetRuntimeEnv", async () => {
    if (!resetRuntimeEnv) {
      return {
        ok: false,
        restartRequired: false,
        message: t("settings.reset.unavailable"),
        runtimeRoot: "",
        copiedFiles: 0,
        skippedFiles: 0
      };
    }

    try {
      const result = await resetRuntimeEnv(app, platform);
      return {
        ok: true,
        restartRequired: true,
        message: result.backupPath
          ? t("settings.reset.successWithBackup", { path: result.backupPath })
          : t("settings.reset.success"),
        runtimeRoot: result.targetRoot,
        backupPath: result.backupPath,
        copiedFiles: result.copiedFiles,
        skippedFiles: result.skippedFiles,
        sourceZipPath: result.sourceZipPath
      };
    } catch (error) {
      const detail = error && typeof error === "object"
        ? error as { runtimeRoot?: unknown; backupPath?: unknown; sourceZipPath?: unknown }
        : {};
      return {
        ok: false,
        restartRequired: false,
        message: error instanceof Error ? error.message : String(error),
        runtimeRoot: typeof detail.runtimeRoot === "string" ? detail.runtimeRoot : "",
        backupPath: typeof detail.backupPath === "string" ? detail.backupPath : undefined,
        copiedFiles: 0,
        skippedFiles: 0,
        sourceZipPath: typeof detail.sourceZipPath === "string" ? detail.sourceZipPath : undefined
      };
    }
  });
  ipcMain.handle("settings.getThemePreference", async () =>
    readDesktopProfileFromRoot(getDesktopConfigRoot(app)).appearance.theme
  );
  ipcMain.handle("settings.getNavigationPreferences", async () => {
    const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    return {
      ...profile.navigation,
      webOrder: readWebOrderKeys(app)
    };
  });
  ipcMain.handle("settings.saveNavigationPreferences", async (_event: any, input: any) => {
    const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    const webOrder = Array.isArray(input?.webOrder)
      ? writeWebOrderKeys(app, normalizeStringArray(input.webOrder))
      : readWebOrderKeys(app);
    const profile = updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      navigation: {
        mainOrder: Array.isArray(input?.mainOrder)
          ? normalizeStringArray(input.mainOrder)
          : current.navigation.mainOrder,
        webOrder,
        desktopCopilotPages: current.navigation.desktopCopilotPages
      }
    });
    return {
      ...profile.navigation,
      webOrder
    };
  });
  ipcMain.handle("settings.setNativeThemeSource", async (_event: any, themeMode: string) => {
    const normalizedThemeMode = normalizeThemePreference(themeMode);
    const result = setNativeThemeSource(nativeTheme, normalizedThemeMode);
    updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      appearance: {
        theme: normalizedThemeMode
      }
    });
    refreshMainWindowAppearance?.();
    return result;
  });
  ipcMain.handle("settings.getLocale", async () => initializeMainI18n(app));
  ipcMain.handle("settings.setLocale", async (_event: any, locale: unknown) => {
    if (!isSupportedLocale(locale)) {
      return initializeMainI18n(app);
    }
    const settings = setMainLocale(app, locale);
    buildApplicationMenu();
    refreshTrayContextMenu();
    emitLocaleChanged(settings);
    return settings;
  });
  ipcMain.handle("settings.createAppPairingPayload", async () => {
    if (!createAppPairingPayload) {
      return { ok: false, message: t("settings.mobilePairing.unavailable") };
    }
    return createAppPairingPayload(app, {
      getTunnelHubRuntimeStatus
    });
  });
}
