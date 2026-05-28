import {
  isDesktopPetSupportedPlatform,
  sanitizeDesktopPetBoundAgentKey,
  sanitizeDesktopPetAppearanceId,
  saveDesktopPetSettings,
  toDesktopPetSettings
} from "../copilot/pet-copilot/desktop-pet";

export interface DesktopPetSettingsInput {
  boundAgentKey?: unknown;
  appearanceId?: unknown;
  enabled?: unknown;
}

export function registerDesktopPetIpcHandlers(ipcMain: any, options: any) {
  ipcMain.handle("desktopPet.getSettings", async () => {
    return toDesktopPetSettings(options.getSettings());
  });

  ipcMain.handle("desktopPet.getState", async () => {
    const settings = options.getSettings();
    if (settings.enabled) {
      options.scheduleStatusRefresh(0);
    }
    return options.refreshState();
  });

  ipcMain.handle("desktopPet.saveSettings", async (_event: any, input: DesktopPetSettingsInput) => {
    const platform = options.platform;
    if (!isDesktopPetSupportedPlatform(platform)) {
      return options.refreshState();
    }
    const desktopPetSettings = options.getSettings();
    const nextBoundAgentKey = typeof input.boundAgentKey === "string"
      ? sanitizeDesktopPetBoundAgentKey(input.boundAgentKey)
      : desktopPetSettings.boundAgentKey;
    const nextAppearanceId = typeof input.appearanceId === "string"
      ? sanitizeDesktopPetAppearanceId(input.appearanceId)
      : desktopPetSettings.appearanceId;
    const boundAgentChanged = nextBoundAgentKey !== desktopPetSettings.boundAgentKey;
    const appearanceChanged = nextAppearanceId !== desktopPetSettings.appearanceId;
    if (boundAgentChanged || appearanceChanged) {
      const nextSettings = saveDesktopPetSettings(options.app, {
        boundAgentKey: nextBoundAgentKey,
        appearanceId: nextAppearanceId
      }, platform);
      options.saveSettingsInState(nextSettings);
    }
    if (boundAgentChanged) {
      options.setAgentStatus(null);
      options.clearActiveRuns();
    }
    if (typeof input.enabled === "boolean") {
      if (input.enabled) {
        options.showWindow();
      } else {
        options.hideWindow(true);
      }
    }
    if (boundAgentChanged) {
      options.scheduleStatusRefresh(0);
    }
    return options.refreshState();
  });

  ipcMain.handle("desktopPet.show", async () => options.showWindow());
  ipcMain.handle("desktopPet.hide", async () => options.hideWindow(true));
  ipcMain.handle("desktopPet.openAssistant", async () => options.openAssistant());

  ipcMain.handle("desktopPet.moveBy", async (event: any, delta: { x?: unknown; y?: unknown }) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false };
    }
    return options.moveWindowBy(delta);
  });

  ipcMain.handle("desktopPet.beginDrag", async (event: any, point: { x?: unknown; y?: unknown }) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false };
    }
    return options.beginDrag(point);
  });

  ipcMain.handle("desktopPet.endDrag", async (event: any) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false, moved: false };
    }
    return options.endDrag();
  });

  ipcMain.handle("desktopPet.setPreviewExpanded", async (event: any, expanded: boolean) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false };
    }
    options.setPreviewExpanded(expanded);
    options.refreshState();
    return { ok: true };
  });

  ipcMain.handle("desktopPet.dismissPreview", async (event: any) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false };
    }
    return options.dismissPreview();
  });

  ipcMain.handle("desktopPet.setMouseInteractive", async (event: any, interactive: boolean) => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false };
    }
    return options.setMouseInteractive(interactive);
  });
}
