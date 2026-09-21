import type { MainWindowLike, RendererDiagnosticReporter } from "./window-model";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { NativeTheme } from "electron";
import { MAC_FULLSCREEN_CLOSE_DELAY_MS, MAC_FULLSCREEN_CLOSE_FALLBACK_MS } from "./window-model";
import { resolveWindowsBackgroundColor } from "./main-window-options";

export type MainWindowLifecycleControllerOptions<TWindow extends MainWindowLike> = {
  platform: DesktopPlatform;
  getWindow(): TWindow | null;
  createWindow(): TWindow;
  clearWindow(targetWindow: TWindow): void;
  nativeTheme?: Pick<NativeTheme, "shouldUseDarkColors">;
  isSidebarTranslucencyEnabled?: () => boolean;
  reportRendererDiagnostic?: RendererDiagnosticReporter;
};

export function createMainWindowLifecycleController<TWindow extends MainWindowLike>(
  options: MainWindowLifecycleControllerOptions<TWindow>
) {
  let pendingCloseCancel: (() => void) | null = null;
  let globalSearchOverlayVisible = false;
  const webviewModalOverlaySources = new Set<string>();

  function isWindowControlsMasked() {
    return globalSearchOverlayVisible || webviewModalOverlaySources.size > 0;
  }

  function publishWindowState(targetWindow: TWindow | null) {
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.webContents) {
      return;
    }
    targetWindow.webContents.send("desktopShell.windowStateChanged", {
      isFullScreen: targetWindow.isFullScreen(),
      isMaximized: targetWindow.isMaximized(),
      windowControlsMasked: isWindowControlsMasked()
    });
  }

  function cancelPendingClose() {
    pendingCloseCancel?.();
    pendingCloseCancel = null;
  }

  function hideImmediately(targetWindow: TWindow) {
    pendingCloseCancel = null;
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.hide();
  }

  function hideDarwinForClose(targetWindow: TWindow) {
    if (!targetWindow.isFullScreen()) {
      hideImmediately(targetWindow);
      return;
    }

    cancelPendingClose();

    let completed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let scheduleDestroy: () => void;
    const clearPendingClose = () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      if (!targetWindow.isDestroyed()) {
        targetWindow.off("leave-full-screen", scheduleDestroy);
      }
      pendingCloseCancel = null;
    };
    const scheduleTimer = (callback: () => void, timeoutMs: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, timeoutMs);
      timers.add(timer);
    };
    const destroyWindow = () => {
      if (completed) {
        return;
      }
      completed = true;
      clearPendingClose();
      targetWindow.destroy();
    };
    scheduleDestroy = () => {
      scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_DELAY_MS);
    };

    pendingCloseCancel = () => {
      if (completed) {
        return;
      }
      completed = true;
      clearPendingClose();
    };

    targetWindow.once("leave-full-screen", scheduleDestroy);
    scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_FALLBACK_MS);
    targetWindow.setFullScreen(false);
  }

  function hideWindowsForClose(targetWindow: TWindow) {
    if (targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }
    hideImmediately(targetWindow);
  }

  function hideForClose(targetWindow: TWindow) {
    if (options.platform === "darwin") {
      hideDarwinForClose(targetWindow);
      return;
    }
    if (options.platform === "win32") {
      hideWindowsForClose(targetWindow);
      return;
    }
    hideImmediately(targetWindow);
  }

  function shouldRecreateDarwinWindowForActivation(targetWindow: TWindow) {
    if (options.platform !== "darwin") {
      return false;
    }
    return Boolean(pendingCloseCancel);
  }

  function discardDarwinWindowForActivation(targetWindow: TWindow) {
    cancelPendingClose();
    if (!targetWindow.isDestroyed()) {
      targetWindow.destroy();
    }
    options.clearWindow(targetWindow);
  }

  function getWindowForActivation() {
    const existingWindow = options.getWindow();
    const activeWindow = existingWindow && !existingWindow.isDestroyed() ? existingWindow : null;
    if (!activeWindow) {
      return options.createWindow();
    }
    if (shouldRecreateDarwinWindowForActivation(activeWindow)) {
      discardDarwinWindowForActivation(activeWindow);
      return options.createWindow();
    }
    return activeWindow;
  }

  function normalizeBeforeShow(targetWindow: TWindow) {
    cancelPendingClose();
    if (options.platform === "darwin") {
      return;
    }
    if (options.platform === "win32" && targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }
  }

  function applyAppearance(targetWindow: TWindow | null) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    if (options.platform === "darwin") {
      const useSidebarTranslucency =
        (options.isSidebarTranslucencyEnabled?.() ?? true) && !targetWindow.isFullScreen();
      targetWindow.setVibrancy(useSidebarTranslucency ? "under-window" : null);
      targetWindow.setBackgroundColor(useSidebarTranslucency ? "#00000000" : "#FFFFFF");
      return;
    }
    if (options.platform === "win32") {
      const shouldUseDarkColors = options.nativeTheme?.shouldUseDarkColors ?? false;
      targetWindow.setBackgroundColor(resolveWindowsBackgroundColor(shouldUseDarkColors));
      return;
    }
    targetWindow.setBackgroundColor("#FFFFFF");
  }

  function setGlobalSearchOverlayVisible(visible: boolean) {
    globalSearchOverlayVisible = visible;
    const targetWindow = options.getWindow();
    applyAppearance(targetWindow);
    publishWindowState(targetWindow);
  }

  function isGlobalSearchOverlayVisible() {
    return globalSearchOverlayVisible;
  }

  function setWebviewModalOverlayVisible(sourceId: string, visible: boolean) {
    const normalizedSourceId = sourceId.trim();
    if (!normalizedSourceId) {
      return;
    }
    if (visible) {
      if (webviewModalOverlaySources.has(normalizedSourceId)) {
        return;
      }
      webviewModalOverlaySources.add(normalizedSourceId);
    } else if (!webviewModalOverlaySources.delete(normalizedSourceId)) {
      return;
    }
    const targetWindow = options.getWindow();
    applyAppearance(targetWindow);
    publishWindowState(targetWindow);
  }

  function attachRendererDiagnostics(targetWindow: TWindow) {
    const reporter = options.reportRendererDiagnostic;
    const contents = targetWindow.webContents;
    if (!reporter || !contents) {
      return;
    }
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level < 2) {
        return;
      }
      reporter("console-message", {
        diagnosticLevel: level === 2 ? "warn" : "error",
        platform: options.platform,
        consoleLevel: level,
        message,
        line,
        sourceId
      });
    });
  }

  return {
    applyAppearance,
    attachRendererDiagnostics,
    cancelPendingClose,
    getWindowForActivation,
    hideForClose,
    isGlobalSearchOverlayVisible,
    isWindowControlsMasked,
    normalizeBeforeShow,
    setGlobalSearchOverlayVisible,
    setWebviewModalOverlayVisible
  };
}

export type MainWindowLifecycleController = ReturnType<typeof createMainWindowLifecycleController>;
