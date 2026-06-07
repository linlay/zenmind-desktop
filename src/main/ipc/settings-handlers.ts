export interface SettingsIpcHandlerOptions {
  app: any;
  platform?: string;
  nativeTheme: { themeSource: string };
  getDataRoot: (app: any) => string;
  initializeMainI18n: (app: any) => any;
  isSupportedLocale: (locale: unknown) => boolean;
  setMainLocale: (app: any, locale: any) => any;
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
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    buildApplicationMenu,
    refreshTrayContextMenu,
    emitLocaleChanged
  } = options;

  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => platform);
  ipcMain.handle("settings.getAppInfo", async () => ({
    version: app.getVersion()
  }));
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
