export const CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL =
  "chatWorkPanel.tabContextMenu.popup";

export type ChatWorkPanelTabContextMenuActionId = "copy-url";

export type ChatWorkPanelTabContextMenuPopupRequest = {
  x: number;
  y: number;
};

export type ChatWorkPanelTabContextMenuPopupResult = {
  actionId: ChatWorkPanelTabContextMenuActionId | null;
};
