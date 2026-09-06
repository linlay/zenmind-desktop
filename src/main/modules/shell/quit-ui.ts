import type { BrowserWindow } from "electron";

export interface QuitUiDependencies {
  getAllWindows: () => Array<{
    isDestroyed: () => boolean;
    isVisible: () => boolean;
    isMinimized?: () => boolean;
    restore?: () => void;
    show?: () => void;
    hide: () => void;
  }>;
  keepVisibleWindow?: {
    isDestroyed: () => boolean;
    isVisible: () => boolean;
    isMinimized?: () => boolean;
    restore?: () => void;
    show?: () => void;
    hide: () => void;
  } | null;
  destroyTray: () => void;
}

export function prepareQuitUi({ getAllWindows, keepVisibleWindow, destroyTray }: QuitUiDependencies) {
  for (const targetWindow of getAllWindows()) {
    if (targetWindow === keepVisibleWindow && !targetWindow.isDestroyed()) {
      if (targetWindow.isMinimized?.()) {
        targetWindow.restore?.();
      }
      if (!targetWindow.isVisible()) {
        targetWindow.show?.();
      }
      continue;
    }
    if (!targetWindow.isDestroyed() && targetWindow.isVisible()) {
      targetWindow.hide();
    }
  }
  destroyTray();
}
