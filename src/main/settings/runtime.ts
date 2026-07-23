import type { App, BrowserWindow } from "electron";
import type { MainAppState } from "../app-state";
import { initializeMainI18n } from "../i18n/main-i18n";
import {
  isDesktopPetSupportedPlatform,
  readDesktopPetStoredState
} from "../assistant/pet/desktop-pet";
import { getDesktopSsoStatus } from "../oidc-sso";

export type SettingsRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  state: MainAppState;
  getLogViewerWindow: () => BrowserWindow | null;
  buildApplicationMenu: () => void;
  refreshTrayContextMenu: () => void;
  refreshDesktopPetState: () => void;
  showDesktopPetWindow: () => void;
  hideDesktopPetWindow: (disable?: boolean) => void;
  broadcastDesktopSsoStatus: (status: ReturnType<typeof getDesktopSsoStatus>) => void;
  notifyServicesChanged: () => void;
  emitKanbanChanged: () => void;
  refreshDesktopActionBridge: () => void;
};

export function createSettingsRuntime(options: SettingsRuntimeOptions) {
  function emitLocaleChanged(settings: unknown) {
    for (const targetWindow of [
      options.state.mainWindow,
      options.state.desktopPetWindow,
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
      options.state.mainWindow,
      options.state.desktopPetWindow,
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

    options.state.desktopPetSettings = readDesktopPetStoredState(options.app, options.platform);
    options.refreshDesktopPetState();
    if (isDesktopPetSupportedPlatform(options.platform) && options.state.desktopPetSettings.enabled) {
      void options.showDesktopPetWindow();
    } else {
      options.hideDesktopPetWindow(false);
    }

    options.broadcastDesktopSsoStatus(getDesktopSsoStatus(options.app));
    options.notifyServicesChanged();
    options.emitKanbanChanged();
    options.refreshDesktopActionBridge();
    emitDesktopConfigChanged(reason);
  }

  return {
    emitLocaleChanged,
    emitDesktopConfigChanged,
    refreshDesktopRuntimeConfigFromCanonicalFiles
  };
}

export type SettingsRuntime = ReturnType<typeof createSettingsRuntime>;
