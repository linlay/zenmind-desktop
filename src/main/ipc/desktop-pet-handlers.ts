import {
  isDesktopPetSupportedPlatform,
  sanitizeDesktopPetAppearanceId,
  saveDesktopPetSettings,
  toDesktopPetSettings
} from "../assistant/pet/desktop-pet";
import { t } from "../i18n/main-i18n";

export interface DesktopPetSettingsInput {
  boundAgentKey?: unknown;
  appearanceId?: unknown;
  enabled?: unknown;
}

export interface DesktopPetOpenTaskChatInput {
  agentKey?: unknown;
  chatId?: unknown;
}

export interface DesktopPetReplyMessageInput {
  chatId?: unknown;
  agentKey?: unknown;
  message?: unknown;
}

export interface DesktopPetDismissMessageInput {
  chatId?: unknown;
  runId?: unknown;
  updatedAt?: unknown;
}

export interface DesktopPetWindowModeInput {
  mode?: unknown;
}

export function registerDesktopPetIpcHandlers(ipcMain: any, options: any) {
  function isPetWindowSender(event: any) {
    const win = options.getWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  }

  function isPetSurfaceSender(event: any) {
    const win = options.getWindow();
    const panelWin = typeof options.getPanelWindow === "function" ? options.getPanelWindow() : null;
    return Boolean(
      (win && !win.isDestroyed() && event.sender === win.webContents) ||
      (panelWin && !panelWin.isDestroyed() && event.sender === panelWin.webContents)
    );
  }

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
    const nextAppearanceId = typeof input.appearanceId === "string"
      ? sanitizeDesktopPetAppearanceId(input.appearanceId)
      : desktopPetSettings.appearanceId;
    const appearanceChanged = nextAppearanceId !== desktopPetSettings.appearanceId;
    if (appearanceChanged) {
      const nextSettings = saveDesktopPetSettings(options.app, {
        appearanceId: nextAppearanceId
      }, platform);
      options.saveSettingsInState(nextSettings);
    }
    if (typeof input.enabled === "boolean") {
      if (input.enabled) {
        options.showWindow();
      } else {
        options.hideWindow(true);
      }
    }
    return options.refreshState();
  });

  ipcMain.handle("desktopPet.show", async () => options.showWindow());
  ipcMain.handle("desktopPet.hide", async () => options.hideWindow(true));
  ipcMain.handle("desktopPet.openAssistant", async () => options.openAssistant());
  ipcMain.handle("desktopPet.openTaskChat", async (_event: any, input: DesktopPetOpenTaskChatInput) =>
    options.openTaskChat(input)
  );

  ipcMain.handle("desktopPet.moveBy", async (event: any, delta: { x?: unknown; y?: unknown }) => {
    if (!isPetWindowSender(event)) {
      return { ok: false };
    }
    return options.moveWindowBy(delta);
  });

  ipcMain.handle("desktopPet.beginDrag", async (event: any, point: { x?: unknown; y?: unknown }) => {
    if (!isPetWindowSender(event)) {
      return { ok: false };
    }
    return options.beginDrag(point);
  });

  ipcMain.handle("desktopPet.endDrag", async (event: any) => {
    if (!isPetWindowSender(event)) {
      return { ok: false, moved: false };
    }
    return options.endDrag();
  });

  ipcMain.handle("desktopPet.setPreviewExpanded", async (event: any, expanded: boolean) => {
    if (!isPetSurfaceSender(event)) {
      return { ok: false };
    }
    options.setPreviewExpanded(expanded);
    options.refreshState();
    return { ok: true };
  });

  ipcMain.handle("desktopPet.dismissPreview", async (event: any) => {
    if (!isPetSurfaceSender(event)) {
      return { ok: false };
    }
    return options.dismissPreview();
  });

  ipcMain.handle("desktopPet.setMouseInteractive", async (event: any, interactive: boolean) => {
    if (!isPetWindowSender(event)) {
      return { ok: false };
    }
    return options.setMouseInteractive(interactive);
  });

  ipcMain.handle("desktopPet.setWindowMode", async (event: any, mode: unknown) => {
    if (!isPetSurfaceSender(event)) {
      return { ok: false };
    }
    return options.setWindowMode(mode);
  });

  ipcMain.handle("desktopPet.replyMessage", async (event: any, input: DesktopPetReplyMessageInput) => {
    if (!isPetSurfaceSender(event)) {
      return { ok: false, message: t("desktopPet.windowUnavailable") };
    }
    return options.replyMessage(input);
  });

  ipcMain.handle("desktopPet.dismissMessage", async (event: any, input: DesktopPetDismissMessageInput) => {
    if (!isPetSurfaceSender(event)) {
      return { ok: false };
    }
    return options.dismissMessage(input);
  });
}
