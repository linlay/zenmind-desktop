import {
  BrowserWindow as ElectronBrowserWindow,
  Menu as ElectronMenu,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent
} from "electron";
import {
  CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL,
  type ChatWorkPanelTabContextMenuActionId,
  type ChatWorkPanelTabContextMenuPopupRequest,
  type ChatWorkPanelTabContextMenuPopupResult
} from "../../shared/chat-work-panel-tab-context-menu";
import { t } from "../i18n/main-i18n";

type ChatWorkPanelTabContextMenuHandlerOptions = {
  getMainWindow(): BrowserWindow | null;
  BrowserWindow?: Pick<typeof ElectronBrowserWindow, "fromWebContents">;
  Menu?: Pick<typeof ElectronMenu, "buildFromTemplate">;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeChatWorkPanelTabContextMenuRequest(
  value: unknown
): ChatWorkPanelTabContextMenuPopupRequest | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    return null;
  }
  if (
    value.mode === "copy-url" &&
    keys.length === 3 &&
    keys.includes("mode") &&
    keys.includes("x") &&
    keys.includes("y")
  ) {
    return { mode: "copy-url", x: Math.round(value.x), y: Math.round(value.y) };
  }
  if (
    value.mode === "work-panel" &&
    keys.length === 5 &&
    keys.includes("mode") &&
    keys.includes("x") &&
    keys.includes("y") &&
    keys.includes("canCopyUrl") &&
    keys.includes("isFullscreen") &&
    typeof value.canCopyUrl === "boolean" &&
    typeof value.isFullscreen === "boolean"
  ) {
    return {
      mode: "work-panel",
      x: Math.round(value.x),
      y: Math.round(value.y),
      canCopyUrl: value.canCopyUrl,
      isFullscreen: value.isFullscreen
    };
  }
  return null;
}

export function registerChatWorkPanelTabContextMenuIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  options: ChatWorkPanelTabContextMenuHandlerOptions
) {
  const BrowserWindow = options.BrowserWindow ?? ElectronBrowserWindow;
  const Menu = options.Menu ?? ElectronMenu;

  ipcMain.handle(
    CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      value: unknown
    ): Promise<ChatWorkPanelTabContextMenuPopupResult> => {
      const request = normalizeChatWorkPanelTabContextMenuRequest(value);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const mainWindow = options.getMainWindow();
      if (
        !request ||
        !ownerWindow ||
        !mainWindow ||
        ownerWindow !== mainWindow ||
        ownerWindow.isDestroyed()
      ) {
        return { actionId: null };
      }

      return await new Promise<ChatWorkPanelTabContextMenuPopupResult>((resolve) => {
        let settled = false;
        const settle = (actionId: ChatWorkPanelTabContextMenuActionId | null) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({ actionId });
        };
        const menu = Menu.buildFromTemplate(request.mode === "copy-url"
          ? [{
              id: "copy-url",
              label: t("webviewContextMenu.page.copy-url"),
              click: () => settle("copy-url")
            }]
          : [
              {
                id: "reload",
                label: t("webviewContextMenu.page.reload"),
                click: () => settle("reload")
              },
              {
                id: "copy-url",
                label: t("webviewContextMenu.page.copy-url"),
                enabled: request.canCopyUrl,
                click: () => settle("copy-url")
              },
              { type: "separator" },
              {
                id: "toggle-fullscreen",
                label: t(request.isFullscreen
                  ? "chatWorkPanel.tabContextMenu.exitFullscreen"
                  : "chatWorkPanel.tabContextMenu.enterFullscreen"),
                click: () => settle("toggle-fullscreen")
              }
            ]);
        const contentBounds = ownerWindow.getContentBounds();
        menu.popup({
          window: ownerWindow,
          x: Math.min(Math.max(request.x, 0), Math.max(contentBounds.width - 1, 0)),
          y: Math.min(Math.max(request.y, 0), Math.max(contentBounds.height - 1, 0)),
          callback: () => settle(null)
        });
      });
    }
  );
}
