import type { App, BrowserWindow } from "electron";
import { initializeMainI18n } from "../../support/i18n/main-i18n";
import { getDesktopSsoStatus } from "../identity";

export type SettingsRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  getDesktopPetWindow: () => BrowserWindow | null;
  getLogViewerWindow: () => BrowserWindow | null;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  reloadDesktopPetSettings: () => void;
  getDesktopPetEnabled: () => boolean;
  isDesktopPetSupported: () => boolean;
  showDesktopPetWindow: () => void;
  hideDesktopPetWindow: () => void;
  broadcastDesktopSsoStatus: (status: ReturnType<typeof getDesktopSsoStatus>) => void;
  notifyServicesChanged: () => void;
  emitKanbanChanged: () => void;
  refreshDesktopActionBridge: () => void;
  refreshEnterpriseChat: () => void;
};

export function createSettingsRuntime(options: SettingsRuntimeOptions) {
  function emitLocaleChanged(settings: unknown) {
    for (const targetWindow of [
      options.getMainWindow(),
      options.getDesktopPetWindow(),
      options.getLogViewerWindow()
    ]) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("settings.localeChanged", settings);
    }
  }

  function emitDesktopConfigChanged(reason: string) {
    const event = {
      reason,
      changedAt: new Date().toISOString()
    };
    for (const targetWindow of [
      options.getMainWindow(),
      options.getDesktopPetWindow(),
      options.getLogViewerWindow()
    ]) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("settings.desktopConfigChanged", event);
    }
  }

  function refreshDesktopRuntimeConfigFromCanonicalFiles(reason: string) {
    const settings = initializeMainI18n(options.app);
    options.buildApplicationMenu();
    options.refreshTrayContextMenu();
    emitLocaleChanged(settings);

    options.reloadDesktopPetSettings();
    if (options.isDesktopPetSupported() && options.getDesktopPetEnabled()) {
      void options.showDesktopPetWindow();
    } else {
      options.hideDesktopPetWindow();
    }

    options.broadcastDesktopSsoStatus(getDesktopSsoStatus(options.app));
    options.notifyServicesChanged();
    options.emitKanbanChanged();
    options.refreshDesktopActionBridge();
    options.refreshEnterpriseChat();
    emitDesktopConfigChanged(reason);
  }

  return {
    emitLocaleChanged,
    emitDesktopConfigChanged,
    refreshDesktopRuntimeConfigFromCanonicalFiles
  };
}

export type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
