import type {
  DesktopGeneralSettings,
  DesktopGeneralSettingsInput,
  DesktopWsServerState,
  TunnelHubSettingsInput,
  TunnelHubSettingsResult
} from "../../shared/contracts";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_WS_URL
} from "../../shared/desktop-ws";
import { readTunnelHubSettings, saveTunnelHubSettings } from "../tunnel-hub-settings";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot, type DesktopThemePreference } from "../desktop-profile-store";
import { getDesktopConfigRoot } from "../user-paths";
import { readWebOrderKeys, writeWebOrderKeys } from "../webs/order-store";
import { t } from "../i18n/main-i18n";

export interface SettingsIpcHandlerOptions {
  app: any;
  platform?: string;
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
  emitLocaleChanged: (settings: any) => void;
  createAppPairingPayload?: (app: any) => Promise<any>;
  onGeneralSettingsChanged?: (settings: DesktopGeneralSettings) => void;
  getDesktopWsServerRuntimeState?: () => Omit<DesktopWsServerState, "enabled">;
  startDesktopWsServer?: () => Promise<Omit<DesktopWsServerState, "enabled">>;
  stopDesktopWsServer?: () => Promise<Omit<DesktopWsServerState, "enabled">>;
  applyTunnelHubSettings?: (input: TunnelHubSettingsInput) => Promise<TunnelHubSettingsResult>;
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
    emitLocaleChanged,
    createAppPairingPayload,
    onGeneralSettingsChanged,
    getDesktopWsServerRuntimeState,
    startDesktopWsServer,
    stopDesktopWsServer,
    applyTunnelHubSettings
  } = options;

  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => platform);
  ipcMain.handle("settings.getAppInfo", async () => getAppInfo?.() ?? {
    productName: app.name ?? "",
    version: typeof app.getVersion === "function" ? app.getVersion() : "",
    buildTime: ""
  });
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
            preventSleepWhileRunning: current.general.preventSleepWhileRunning,
            desktopWsServerEnabled: true
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
        preventSleepWhileRunning: current.general.preventSleepWhileRunning,
        desktopWsServerEnabled: false
      }
    });
    onGeneralSettingsChanged?.(profile.general);
    return desktopWsServerState(false, runtimeState, message);
  });
  ipcMain.handle("settings.saveGeneralSettings", async (_event: any, input: DesktopGeneralSettingsInput) => {
    const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
    const profile = updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
      general: {
        preventSleepWhileRunning: typeof input?.preventSleepWhileRunning === "boolean"
          ? input.preventSleepWhileRunning
          : current.general.preventSleepWhileRunning,
        desktopWsServerEnabled: current.general.desktopWsServerEnabled
      }
    });
    onGeneralSettingsChanged?.(profile.general);
    return profile.general;
  });
  ipcMain.handle("settings.getTunnelHubSettings", async () => readTunnelHubSettings(app));
  ipcMain.handle("settings.saveTunnelHubSettings", async (_event: any, input: TunnelHubSettingsInput) =>
    applyTunnelHubSettings ? applyTunnelHubSettings(input) : saveTunnelHubSettings(app, input)
  );
  ipcMain.handle("settings.resetRuntimeEnv", async () => {
    if (!resetRuntimeEnv) {
      return {
        ok: false,
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
    return createAppPairingPayload(app);
  });
}
