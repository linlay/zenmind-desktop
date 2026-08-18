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
  type ChatWorkPanelTabContextMenuProfile,
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

const WORK_PANEL_CONTEXT_MENU_PROFILES = new Set<ChatWorkPanelTabContextMenuProfile>([
  "default",
  "web",
  "artifact",
  "reference"
]);

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
    keys.length === 7 &&
    keys.includes("mode") &&
    keys.includes("x") &&
    keys.includes("y") &&
    keys.includes("profile") &&
    keys.includes("isFullscreen") &&
    keys.includes("canClose") &&
    keys.includes("canCloseOthers") &&
    typeof value.profile === "string" &&
    WORK_PANEL_CONTEXT_MENU_PROFILES.has(value.profile as ChatWorkPanelTabContextMenuProfile) &&
    typeof value.isFullscreen === "boolean" &&
    typeof value.canClose === "boolean" &&
    typeof value.canCloseOthers === "boolean"
  ) {
    return {
      mode: "work-panel",
      x: Math.round(value.x),
      y: Math.round(value.y),
      profile: value.profile as ChatWorkPanelTabContextMenuProfile,
      isFullscreen: value.isFullscreen,
      canClose: value.canClose,
      canCloseOthers: value.canCloseOthers
    };
  }
  return null;
}

function buildWorkPanelTemplate(
  request: Extract<ChatWorkPanelTabContextMenuPopupRequest, { mode: "work-panel" }>,
  settle: (actionId: ChatWorkPanelTabContextMenuActionId | null) => void
) {
  const click = (actionId: ChatWorkPanelTabContextMenuActionId) => () => settle(actionId);
  const leadingItems = request.profile === "web"
    ? [
        {
          id: "reload",
          label: t("webviewContextMenu.page.reload"),
          click: click("reload")
        },
        {
          id: "copy-url",
          label: t("webviewContextMenu.page.copy-url"),
          click: click("copy-url")
        }
      ]
    : request.profile === "artifact" || request.profile === "reference"
      ? [
          {
            id: "download-resource",
            label: t(request.profile === "artifact"
              ? "chatWorkPanel.tabContextMenu.downloadArtifact"
              : "chatWorkPanel.tabContextMenu.downloadReference"),
            click: click("download-resource")
          },
          {
            id: "copy-title",
            label: t("chatWorkPanel.tabContextMenu.copyFilename"),
            click: click("copy-title")
          },
          { type: "separator" as const },
          {
            id: "reload",
            label: t("chatWorkPanel.tabContextMenu.reloadPreview"),
            click: click("reload")
          }
        ]
      : [
          {
            id: "reload",
            label: t("webviewContextMenu.page.reload"),
            click: click("reload")
          }
        ];
  return [
    ...leadingItems,
    { type: "separator" as const },
    {
      id: "toggle-fullscreen",
      label: t(request.isFullscreen
        ? "chatWorkPanel.tabContextMenu.exitFullscreen"
        : "chatWorkPanel.tabContextMenu.enterFullscreen"),
      click: click("toggle-fullscreen")
    },
    { type: "separator" as const },
    {
      id: "close-tab",
      label: t("chatWorkPanel.tabContextMenu.closeTab"),
      enabled: request.canClose,
      click: click("close-tab")
    },
    {
      id: "close-other-tabs",
      label: t("chatWorkPanel.tabContextMenu.closeOtherTabs"),
      enabled: request.canCloseOthers,
      click: click("close-other-tabs")
    }
  ];
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
          : buildWorkPanelTemplate(request, settle));
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
