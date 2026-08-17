export const CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL =
  "chatWorkPanel.tabContextMenu.popup";

export type ChatWorkPanelTabContextMenuActionId =
  | "reload"
  | "copy-url"
  | "toggle-fullscreen";

export type ChatWorkPanelTabContextMenuPopupRequest =
  | {
      mode: "copy-url";
      x: number;
      y: number;
    }
  | {
      mode: "work-panel";
      x: number;
      y: number;
      canCopyUrl: boolean;
      isFullscreen: boolean;
    };

export type ChatWorkPanelTabContextMenuPopupResult = {
  actionId: ChatWorkPanelTabContextMenuActionId | null;
};
