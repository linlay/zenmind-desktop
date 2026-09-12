import type { BrowserWindow, MenuItemConstructorOptions, Rectangle, WebContents } from "electron";
import { t } from "../../../support/i18n/main-i18n";

// These controls belong to the host window. WebApp pages receive no window IPC.
export function createWebappWindowTools(window: BrowserWindow, platform = process.platform) {
  let regularBounds: Rectangle | null = null;
  let regularMinimum: number[] | null = null;

  return (editable: boolean): MenuItemConstructorOptions[] => [
    ...(editable ? [
      { role: "undo" as const }, { role: "redo" as const }, { type: "separator" as const },
      { role: "cut" as const }, { role: "copy" as const }, { role: "paste" as const },
      { role: "selectAll" as const }, { type: "separator" as const }
    ] : [{ role: "copy" as const }, { type: "separator" as const }]),
    {
      label: t("webapp.window.alwaysOnTop"),
      type: "checkbox",
      checked: window.isAlwaysOnTop(),
      click: () => {
        if (window.isDestroyed()) return;
        const enabled = !window.isAlwaysOnTop();
        if (platform === "darwin") {
          // Floating level follows native utility windows on macOS.
          window.setAlwaysOnTop(enabled, "floating");
        } else if (platform === "win32") {
          // Windows uses the regular topmost window band.
          window.setAlwaysOnTop(enabled, "normal");
        } else {
          window.setAlwaysOnTop(enabled);
        }
      }
    },
    {
      label: t("webapp.window.compact"),
      type: "checkbox",
      checked: regularBounds !== null,
      enabled: !window.isFullScreen(),
      click: () => {
        if (window.isDestroyed() || window.isFullScreen()) return;
        if (regularBounds) {
          window.setMinimumSize(regularMinimum![0]!, regularMinimum![1]!);
          window.setBounds(regularBounds);
          regularBounds = null;
          regularMinimum = null;
          return;
        }
        regularBounds = window.getNormalBounds();
        regularMinimum = window.getMinimumSize();
        if (window.isMaximized()) window.unmaximize();
        window.setMinimumSize(340, 360);
        window.setSize(420, 540);
      }
    }
  ];
}

export function attachWebappWindowCloseGuard(
  window: BrowserWindow,
  contents: WebContents,
  bypass: () => boolean,
  confirmDiscard: () => boolean
) {
  let closeRequested = false;
  window.on("close", (event) => {
    if (bypass() || contents.isDestroyed()) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    // BrowserWindow's shell cannot evaluate the child WebContentsView's dirty state.
    contents.close({ waitForBeforeUnload: true });
  });
  contents.on("will-prevent-unload", (event) => {
    if (bypass() || confirmDiscard()) {
      event.preventDefault();
    } else {
      closeRequested = false;
    }
  });
  contents.once("destroyed", () => {
    if (closeRequested && !window.isDestroyed()) window.close();
  });
}
