import type { TunnelHubAgentSettingsInput } from "../../shared/contracts";
import { readTunnelHubAgentSettings, saveTunnelHubAgentSettings } from "../tunnel-hub-agent-settings";

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
}

export function setNativeThemeSource(nativeTheme: { themeSource: string }, themeMode: string) {
  nativeTheme.themeSource = themeMode === "dark" ? "dark" : themeMode === "system" ? "system" : "light";
  return {
    ok: true,
    themeSource: nativeTheme.themeSource
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
    emitLocaleChanged
  } = options;

  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => platform);
  ipcMain.handle("settings.getAppInfo", async () => getAppInfo?.() ?? {
    productName: app.name ?? "",
    version: typeof app.getVersion === "function" ? app.getVersion() : "",
    buildTime: ""
  });
  ipcMain.handle("settings.getTunnelHubAgentSettings", async () => readTunnelHubAgentSettings(app));
  ipcMain.handle("settings.saveTunnelHubAgentSettings", async (_event: any, input: TunnelHubAgentSettingsInput) =>
    saveTunnelHubAgentSettings(app, input)
  );
  ipcMain.handle("settings.resetRuntimeEnv", async () => {
    if (!resetRuntimeEnv) {
      return {
        ok: false,
        message: "运行环境重置功能不可用。",
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
          ? `运行环境已重置。旧目录已备份到：${result.backupPath}。请重启应用。`
          : "运行环境已重置。请重启应用。",
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
  ipcMain.handle("settings.setNativeThemeSource", async (_event: any, themeMode: string) =>
    setNativeThemeSource(nativeTheme, themeMode)
  );
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
}
