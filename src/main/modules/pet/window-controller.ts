import type { DesktopPetSettingsLike, DesktopPetBounds } from "./controller-model";
import type { DesktopPetWindowMode } from "./desktop-pet";
import type { DesktopPetLocalStatus } from "./pet-model";
import { isDesktopPetSupportedPlatform } from "./pet-settings";

export interface DesktopPetWindowControllerOptions {
  platform: string;
  createWindow: (options: any) => any;
  getSettings: () => DesktopPetSettingsLike;
  saveSettings: (settings: Partial<DesktopPetSettingsLike>) => void;
  getMode: () => DesktopPetWindowMode;
  getBounds: () => DesktopPetBounds;
  isHandlingQuit: () => boolean;
  loadRendererRoute: (window: any, route: string) => Promise<void>;
  buildContextMenu: (appearanceId: string, window: any) => any;
  endDrag: () => void;
  clearIdleResetTimer: () => void;
  clearPreviewRefreshTimer: () => void;
  clearPreview: () => void;
  refreshState: (patch?: Partial<DesktopPetLocalStatus>) => any;
  setMouseInteractive: (interactive: boolean) => void;
  onWindowMove?: () => void;
}

export interface DesktopPetWindowController {
  getWindow(): any | null;
  setWindow(window: any): void;
  createWindow(): any;
  showWindow(): any;
  hideWindow(): any;
  isVisible(): boolean;
}

export function createDesktopPetWindowController(
  options: DesktopPetWindowControllerOptions
): DesktopPetWindowController {
  let window: any = null;

  function getWindow() {
    return window;
  }

  function setWindow(win: any) {
    window = win;
  }

  function isVisible() {
    return Boolean(
      window &&
      !window.isDestroyed() &&
      window.isVisible()
    );
  }

  function createWindow() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return null;
    }
    if (window && !window.isDestroyed()) {
      return window;
    }

    window = options.createWindow(options.getBounds());

    window.on("move", () => {
      if (options.onWindowMove) {
        options.onWindowMove();
      }
    });

    window.on("show", () => {
      options.setMouseInteractive(false);
      options.refreshState();
    });

    window.on("hide", () => {
      options.setMouseInteractive(false);
      if (!options.isHandlingQuit() && options.getSettings().enabled) {
        hideWindow();
        return;
      }
      options.refreshState();
    });

    window.on("close", (event: any) => {
      if (options.isHandlingQuit()) {
        return;
      }
      event.preventDefault();
      hideWindow();
    });

    window.on("closed", () => {
      options.endDrag();
      window = null;
      options.setMouseInteractive(true);
      if (!options.isHandlingQuit() && options.getSettings().enabled) {
        options.clearIdleResetTimer();
        options.clearPreviewRefreshTimer();
        options.clearPreview();
        options.saveSettings({
          enabled: false,
          unreadCount: 0
        });
      }
      options.refreshState();
    });

    if (window.webContents) {
      window.webContents.on("context-menu", (event: any, params: any) => {
        options.endDrag();
        if (!window || window.isDestroyed()) {
          return;
        }
        const menu = options.buildContextMenu(options.getSettings().appearanceId, window);
        if (menu && typeof menu.popup === "function") {
          menu.popup({
            window,
            x: params.x,
            y: params.y
          });
        }
      });
    }

    const createdWindow = window;
    options.loadRendererRoute(createdWindow, "/desktop-pet").catch((error) => {
      console.error("failed to load desktop pet renderer", error);
      if (window === createdWindow && !createdWindow.isDestroyed()) {
        hideWindow();
      }
    });

    return window;
  }

  function showWindow() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return hideWindow();
    }
    try {
      const targetWindow = createWindow();
      if (!targetWindow || targetWindow.isDestroyed()) {
        throw new Error("Desktop pet window was not created.");
      }

      const bounds = options.getBounds();
      targetWindow.setBounds(bounds, true);
      targetWindow.showInactive();
      targetWindow.moveTop();
      if (!targetWindow.isVisible()) {
        throw new Error("Desktop pet window did not become visible.");
      }
      options.saveSettings({
        enabled: true
      });
      return options.refreshState();
    } catch (error) {
      console.error("failed to show desktop pet window", error);
      return hideWindow();
    }
  }

  function hideWindow() {
    options.endDrag();
    options.setMouseInteractive(false);
    options.clearIdleResetTimer();
    options.clearPreviewRefreshTimer();
    options.clearPreview();
    options.saveSettings({
      enabled: false,
      unreadCount: 0
    });
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    return options.refreshState({
      unreadCount: 0
    });
  }

  return {
    getWindow,
    setWindow,
    createWindow,
    showWindow,
    hideWindow,
    isVisible
  };
}
