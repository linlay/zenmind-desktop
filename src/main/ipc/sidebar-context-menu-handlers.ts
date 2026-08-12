import {
  BrowserWindow as ElectronBrowserWindow,
  Menu as ElectronMenu,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import type { TranslationKey } from "../../shared/i18n";
import {
  SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL,
  type SidebarContextMenuActionId,
  type SidebarContextMenuPopupResult
} from "../../shared/sidebar-context-menu";
import { t } from "../i18n/main-i18n";
import {
  buildSidebarContextMenuPolicy,
  normalizeSidebarContextMenuRequest
} from "../sidebar-context-menu-policy";

const LABEL_KEYS: Record<SidebarContextMenuActionId, TranslationKey> = {
  "group.sort-by-time": "sidebar.assistants.sortByTime",
  "group.sort-by-name": "sidebar.assistants.sortByName",
  "group.new-project": "sidebar.project.new",
  "group.new-chat": "sidebar.chats.newChat",
  "group.add-website": "sidebar.website.new",
  "group.import-webapp": "sidebar.webapp.import",
  "agent.open-workspace": "sidebar.agent.openWorkspace",
  "agent.open-project": "sidebar.agent.openProject",
  "agent.edit": "sidebar.agent.edit",
  "chat.export": "sidebar.chat.export",
  "chat.share": "sidebar.chat.share",
  "chat.rename": "sidebar.chat.rename",
  "chat.workPanel.open": "sidebar.chat.workPanel.open",
  "chat.workPanel.close": "sidebar.chat.workPanel.close",
  "chat.archive": "sidebar.chat.archive",
  "chat.delete": "sidebar.chat.delete",
  "web.close": "sidebar.website.close",
  "web.open-in-workspace": "sidebar.webapp.openInWorkspace",
  "web.open-in-window": "sidebar.webapp.openInWindow",
  "web.export": "sidebar.webapp.export",
  "web.remove": "sidebar.webapp.remove"
};

type SidebarContextMenuHandlerOptions = {
  getMainWindow(): BrowserWindow | null;
  BrowserWindow?: Pick<typeof ElectronBrowserWindow, "fromWebContents">;
  Menu?: Pick<typeof ElectronMenu, "buildFromTemplate">;
};

export function registerSidebarContextMenuIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  options: SidebarContextMenuHandlerOptions
) {
  const BrowserWindow = options.BrowserWindow ?? ElectronBrowserWindow;
  const Menu = options.Menu ?? ElectronMenu;

  ipcMain.handle(
    SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      value: unknown
    ): Promise<SidebarContextMenuPopupResult> => {
      const request = normalizeSidebarContextMenuRequest(value);
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

      const policy = buildSidebarContextMenuPolicy(request.target);
      if (policy.length === 0) {
        return { actionId: null };
      }

      return await new Promise<SidebarContextMenuPopupResult>((resolve) => {
        let settled = false;
        const settle = (actionId: SidebarContextMenuActionId | null) => {
          if (settled) return;
          settled = true;
          resolve({ actionId });
        };
        const template: MenuItemConstructorOptions[] = [];
        let previousGroup: number | null = null;
        for (const item of policy) {
          if (previousGroup !== null && previousGroup !== item.group) {
            template.push({ type: "separator" });
          }
          previousGroup = item.group;
          template.push({
            id: item.id,
            label: t(LABEL_KEYS[item.id]),
            type: item.type,
            checked: item.checked,
            enabled: item.enabled,
            click: () => settle(item.id)
          });
        }

        const menu = Menu.buildFromTemplate(template);
        const contentBounds = ownerWindow.getContentBounds();
        const relativeX = Math.min(
          Math.max(request.x, 0),
          Math.max(contentBounds.width - 1, 0)
        );
        const relativeY = Math.min(
          Math.max(request.y, 0),
          Math.max(contentBounds.height - 1, 0)
        );
        menu.popup({
          window: ownerWindow,
          x: relativeX,
          y: relativeY,
          callback: () => settle(null)
        });
      });
    }
  );
}
