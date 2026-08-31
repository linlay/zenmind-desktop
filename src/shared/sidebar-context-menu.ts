export const SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL =
  "sidebarContextMenu.popup";

export type SidebarContextMenuActionId =
  | "group.new-project"
  | "group.new-chat"
  | "group.chat-sort-recent"
  | "group.chat-sort-manual"
  | "group.add-website"
  | "group.import-webapp"
  | "agent.reveal-workspace"
  | "agent.open-project-editor"
  | "agent.edit"
  | "chat.export"
  | "chat.exportHtml"
  | "chat.share"
  | "chat.rename"
  | "chat.workPanel.open"
  | "chat.workPanel.close"
  | "chat.archive"
  | "chat.delete"
  | "chat.info"
  | "web.close"
  | "web.open-in-workspace"
  | "web.open-in-window"
  | "web.copy-share-url"
  | "web.open-publish-settings"
  | "web.export"
  | "web.remove";

type SidebarWebContextMenuTargetBase = {
  kind: "web";
  openMode: "dialog" | "window";
  canClose: boolean;
  canOpenAlternative: boolean;
  canExport: boolean;
  canRemove: boolean;
  showRemove: boolean;
};

export type SidebarContextMenuTarget =
  | {
      kind: "group";
      groupId: "assistants" | "chats" | "webs";
      canCreateProject: boolean;
      canCreateChat: boolean;
      chatSortMode: "recent" | "manual";
      chatOrderingSupported: boolean;
      menuScope?: "sort";
    }
  | {
      kind: "agent";
      canRevealWorkspace: boolean;
      canOpenProjectEditor: boolean;
    }
  | {
      kind: "chat";
      workPanelOpen: boolean;
    }
  | (SidebarWebContextMenuTargetBase & {
      webKind: "website";
    })
  | (SidebarWebContextMenuTargetBase & {
      webKind: "webapp";
      hasPublicShareUrl: boolean;
    });

export type SidebarContextMenuPopupRequest = {
  x: number;
  y: number;
  target: SidebarContextMenuTarget;
};

export type SidebarContextMenuPopupResult = {
  actionId: SidebarContextMenuActionId | null;
};
