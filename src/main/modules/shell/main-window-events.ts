import type { MainWindowLifecycleEventsLike } from "./window-model";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { DesktopGlobalSearchShortcut } from "../../../shared/contracts/desktop-api";
import { toggleMainRendererDevTools } from "./main-window-options";

export function configureMainWindowLifecycleEvents<TWindow extends MainWindowLifecycleEventsLike>(
  targetWindow: TWindow,
  options: {
    platform: DesktopPlatform;
    lifecycle: {
      applyAppearance(targetWindow: TWindow): void;
      hideForClose(targetWindow: TWindow): void;
      cancelPendingClose(): void;
      isGlobalSearchOverlayVisible?(): boolean;
      isWindowControlsMasked?(): boolean;
    };
    isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
    isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
    isDesktopCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
    resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
    isHandlingQuit(): boolean;
    requestAppQuit(): void;
    clearWindow(targetWindow: TWindow): void;
    restoreFloatingWindowsForFullscreen?: () => void;
  }
) {
  function sendWindowState() {
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send("desktopShell.windowStateChanged", {
      isFullScreen: targetWindow.isFullScreen(),
      isMaximized: targetWindow.isMaximized(),
      windowControlsMasked: options.lifecycle.isWindowControlsMasked?.() ?? false
    });
  }

  targetWindow.once("ready-to-show", () => {
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.show();
    targetWindow.focus();
    sendWindowState();
  });

  targetWindow.on("enter-full-screen", () => {
    options.lifecycle.applyAppearance(targetWindow);
    options.restoreFloatingWindowsForFullscreen?.();
    sendWindowState();
  });

  targetWindow.on("leave-full-screen", () => {
    options.lifecycle.applyAppearance(targetWindow);
    options.restoreFloatingWindowsForFullscreen?.();
    sendWindowState();
  });

  targetWindow.on("maximize", sendWindowState);
  targetWindow.on("unmaximize", sendWindowState);

  targetWindow.webContents.on("before-input-event", (event, input) => {
    const globalSearchCommandShortcut = options.lifecycle.isGlobalSearchOverlayVisible?.()
      ? options.resolveGlobalSearchCommandShortcut?.(options.platform, input) ?? null
      : null;
    if (globalSearchCommandShortcut) {
      event.preventDefault();
      targetWindow.webContents.send("app.globalSearchShortcut", globalSearchCommandShortcut);
      return;
    }

    if (options.isGlobalSearchShortcut?.(options.platform, input)) {
      event.preventDefault();
      targetWindow.webContents.send("app.openGlobalSearch", { source: "main" });
      return;
    }

    if (options.isDesktopCloseShortcut?.(options.platform, input)) {
      event.preventDefault();
      targetWindow.webContents.send("app.closeShortcut", {
        guestId: null,
        fallbackToWindowClose: true
      });
      return;
    }

    if (!options.isDevToolsShortcut(options.platform, input)) {
      return;
    }

    event.preventDefault();
    toggleMainRendererDevTools(targetWindow.webContents);
  });

  targetWindow.on("close", (event) => {
    if (options.isHandlingQuit()) {
      return;
    }
    event.preventDefault();
    if (targetWindow.isDestroyed()) {
      return;
    }
    if (options.platform === "win32") {
      options.requestAppQuit();
      return;
    }
    options.lifecycle.hideForClose(targetWindow);
  });

  targetWindow.on("closed", () => {
    options.lifecycle.cancelPendingClose();
    options.clearWindow(targetWindow);
  });
}
