import {
  BrowserWindow as ElectronBrowserWindow,
  Menu as ElectronMenu,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent
} from "electron";
import {
  CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL,
  CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL,
  CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL,
  type ChatWorkPanelOpenLocalResourceResult,
  type ChatWorkPanelRevealLocalResourceResult,
  type ChatWorkPanelTabContextMenuActionId,
  type ChatWorkPanelTabContextMenuProfile,
  type ChatWorkPanelTabContextMenuPopupRequest,
  type ChatWorkPanelTabContextMenuPopupResult
} from "../../shared/chat-work-panel-tab-context-menu";
import {
  normalizeChatWorkPanelOpenLocalResourceRequest,
  openChatWorkPanelResourceInDefaultApp,
  revealChatWorkPanelResourceInFileManager,
  toChatWorkPanelLocalResourceActionResult,
} from "../chat-work-panel-resource-open";
import { t } from "../i18n/main-i18n";

type ChatWorkPanelTabContextMenuHandlerOptions = {
  getMainWindow(): BrowserWindow | null;
  app?: Electron.App;
  platform?: NodeJS.Platform | string;
  openLocalResource?: (
    request: Parameters<typeof openChatWorkPanelResourceInDefaultApp>[0],
  ) => Promise<ChatWorkPanelOpenLocalResourceResult>;
  revealLocalResource?: (
    request: Parameters<typeof revealChatWorkPanelResourceInFileManager>[0],
  ) => Promise<ChatWorkPanelRevealLocalResourceResult>;
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
    (keys.length === 7 || keys.length === 8) &&
    keys.includes("mode") &&
    keys.includes("x") &&
    keys.includes("y") &&
    keys.includes("profile") &&
    keys.includes("isFullscreen") &&
    (keys.length === 7 || keys.includes("reviewMode")) &&
    keys.includes("canClose") &&
    keys.includes("canCloseOthers") &&
    typeof value.profile === "string" &&
    WORK_PANEL_CONTEXT_MENU_PROFILES.has(value.profile as ChatWorkPanelTabContextMenuProfile) &&
    typeof value.isFullscreen === "boolean" &&
    (value.reviewMode === undefined || value.reviewMode === "unavailable" || value.reviewMode === "inactive" || value.reviewMode === "active") &&
    typeof value.canClose === "boolean" &&
    typeof value.canCloseOthers === "boolean"
  ) {
    return {
      mode: "work-panel",
      x: Math.round(value.x),
      y: Math.round(value.y),
      profile: value.profile as ChatWorkPanelTabContextMenuProfile,
      isFullscreen: value.isFullscreen,
      ...(value.reviewMode === "inactive" || value.reviewMode === "active"
        ? { reviewMode: value.reviewMode }
        : {}),
      canClose: value.canClose,
      canCloseOthers: value.canCloseOthers
    };
  }
  return null;
}

function buildWorkPanelTemplate(
  request: Extract<ChatWorkPanelTabContextMenuPopupRequest, { mode: "work-panel" }>,
  settle: (actionId: ChatWorkPanelTabContextMenuActionId | null) => void,
  platform: NodeJS.Platform | string,
) {
  const click = (actionId: ChatWorkPanelTabContextMenuActionId) => () => settle(actionId);
  const resourceProfile = request.profile === "artifact" || request.profile === "reference";
  const currentTabItems = [
    ...(!request.reviewMode || request.reviewMode === "unavailable"
      ? []
      : [{
          id: "toggle-review",
          label: t(request.reviewMode === "active"
            ? "chatWorkPanel.tabContextMenu.exitReview"
            : "chatWorkPanel.tabContextMenu.enterReview"),
          click: click("toggle-review")
        }]),
    {
      id: "toggle-fullscreen",
      label: t(request.isFullscreen
        ? "chatWorkPanel.tabContextMenu.exitFullscreen"
        : "chatWorkPanel.tabContextMenu.enterFullscreen"),
      click: click("toggle-fullscreen")
    },
    {
      id: "reload",
      label: t(resourceProfile
        ? "chatWorkPanel.tabContextMenu.reloadPreview"
        : "webviewContextMenu.page.reload"),
      click: click("reload")
    },
    ...(request.profile === "web"
      ? [{
          id: "copy-url",
          label: t("webviewContextMenu.page.copy-url"),
          click: click("copy-url")
        }]
      : [])
  ];
  const crossEnvironmentItems = resourceProfile
    ? [
        {
          id: "download-resource",
          label: t(request.profile === "artifact"
            ? "chatWorkPanel.tabContextMenu.downloadArtifact"
            : "chatWorkPanel.tabContextMenu.downloadReference"),
          click: click("download-resource")
        },
        {
          id: "open-resource-default-app",
          label: t("chatWorkPanel.tabContextMenu.openInDefaultApp"),
          click: click("open-resource-default-app")
        },
        {
          id: "reveal-resource",
          label: t(platform === "darwin"
            ? "chatWorkPanel.tabContextMenu.revealInFinder"
            : platform === "win32"
              ? "chatWorkPanel.tabContextMenu.revealInExplorer"
              : "chatWorkPanel.tabContextMenu.revealInFileManager"),
          click: click("reveal-resource")
        },
        {
          id: "copy-title",
          label: t("chatWorkPanel.tabContextMenu.copyFilename"),
          click: click("copy-title")
        }
      ]
    : [];
  const closeItems = [
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
  const groups = [currentTabItems, crossEnvironmentItems, closeItems]
    .filter((group) => group.length > 0);
  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: "separator" as const }, ...group]
  );
}

export function registerChatWorkPanelTabContextMenuIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  options: ChatWorkPanelTabContextMenuHandlerOptions
) {
  const BrowserWindow = options.BrowserWindow ?? ElectronBrowserWindow;
  const Menu = options.Menu ?? ElectronMenu;

  ipcMain.handle(
    CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL,
    async (event: IpcMainInvokeEvent, value: unknown): Promise<ChatWorkPanelOpenLocalResourceResult> => {
      const request = normalizeChatWorkPanelOpenLocalResourceRequest(value);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const mainWindow = options.getMainWindow();
      if (
        !request ||
        !ownerWindow ||
        !mainWindow ||
        ownerWindow !== mainWindow ||
        ownerWindow.isDestroyed()
      ) {
        return toChatWorkPanelLocalResourceActionResult(
          { ok: false, code: "invalid_request" },
          "openDefault",
        );
      }
      if (options.openLocalResource) {
        return toChatWorkPanelLocalResourceActionResult(
          await options.openLocalResource(request),
          "openDefault",
        );
      }
      if (!options.app) {
        return toChatWorkPanelLocalResourceActionResult(
          { ok: false, code: "open_failed" },
          "openDefault",
        );
      }
      return toChatWorkPanelLocalResourceActionResult(
        await openChatWorkPanelResourceInDefaultApp(request, {
          app: options.app,
          platform: options.platform,
        }),
        "openDefault",
      );
    },
  );

  ipcMain.handle(
    CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL,
    async (event: IpcMainInvokeEvent, value: unknown): Promise<ChatWorkPanelRevealLocalResourceResult> => {
      const request = normalizeChatWorkPanelOpenLocalResourceRequest(value);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const mainWindow = options.getMainWindow();
      if (
        !request ||
        !ownerWindow ||
        !mainWindow ||
        ownerWindow !== mainWindow ||
        ownerWindow.isDestroyed()
      ) {
        return toChatWorkPanelLocalResourceActionResult(
          { ok: false, code: "invalid_request" },
          "reveal",
        );
      }
      if (options.revealLocalResource) {
        return toChatWorkPanelLocalResourceActionResult(
          await options.revealLocalResource(request),
          "reveal",
        );
      }
      if (!options.app) {
        return toChatWorkPanelLocalResourceActionResult(
          { ok: false, code: "open_failed" },
          "reveal",
        );
      }
      return toChatWorkPanelLocalResourceActionResult(
        await revealChatWorkPanelResourceInFileManager(request, {
          app: options.app,
          platform: options.platform,
        }),
        "reveal",
      );
    },
  );

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
          : buildWorkPanelTemplate(request, settle, options.platform ?? process.platform));
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
