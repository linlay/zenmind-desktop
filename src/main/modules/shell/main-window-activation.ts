import type { MainWindowActivationLike } from "./window-model";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { App } from "electron";

export type MainWindowActivationControllerOptions<TWindow extends MainWindowActivationLike> = {
  platform: DesktopPlatform;
  lifecycle: {
    getWindowForActivation(): TWindow | null;
    normalizeBeforeShow(targetWindow: TWindow): void;
  };
  ensureDockIdentity(): void;
  focusApp?: Pick<App, "focus">["focus"];
};

export function createMainWindowActivationController<TWindow extends MainWindowActivationLike>(
  options: MainWindowActivationControllerOptions<TWindow>
) {
  function activateMainWindow() {
    const targetWindow = options.lifecycle.getWindowForActivation();
    if (!targetWindow || targetWindow.isDestroyed()) {
      return null;
    }

    options.lifecycle.normalizeBeforeShow(targetWindow);

    if (options.platform === "darwin" && targetWindow.isFullScreen()) {
      options.focusApp?.({ steal: true });
      targetWindow.focus();
      return targetWindow;
    }

    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.show();
    targetWindow.focus();
    return targetWindow;
  }

  function sendNavigationAfterLoad(targetWindow: TWindow, targetPath: string) {
    const sendNavigate = () => {
      if (!targetWindow.isDestroyed()) {
        targetWindow.webContents.send("app.navigate", targetPath);
      }
    };

    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", sendNavigate);
      return;
    }

    sendNavigate();
  }

  function navigateMainWindow(targetPath: string) {
    const targetWindow = activateMainWindow();
    if (!targetWindow) {
      return;
    }

    sendNavigationAfterLoad(targetWindow, targetPath);
  }

  function showMainWindow(targetPath?: string) {
    options.ensureDockIdentity();
    const targetWindow = activateMainWindow();
    if (!targetWindow || !targetPath) {
      return;
    }

    sendNavigationAfterLoad(targetWindow, targetPath);
  }

  return {
    navigateMainWindow,
    showMainWindow
  };
}
