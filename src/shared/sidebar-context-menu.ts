export const SIDEBAR_CONTEXT_MENU_POPUP_CHANNEL =
  "sidebarContextMenu.popup";

export type SidebarContextMenuActionId =
  | "group.sort-by-time"
  | "group.sort-by-name"
  | "group.new-project"
  | "group.new-chat"
  | "group.add-website"
  | "group.import-webapp"
  | "agent.open-workspace"
  | "agent.edit"
  | "chat.export"
  | "chat.rename"
  | "chat.archive"
  | "chat.delete"
  | "web.close"
  | "web.open-in-workspace"
  | "web.open-in-window"
  | "web.export"
  | "web.remove";

export type SidebarContextMenuTarget =
  | {
      kind: "group";
      groupId: "assistants" | "chats" | "webs";
      menuScope: "all" | "sort";
      sortMode: "byName" | "byTime";
      canCreateProject: boolean;
      canCreateChat: boolean;
    }
  | {
      kind: "agent";
      canOpenWorkspace: boolean;
    }
  | {
      kind: "chat";
    }
  | {
      kind: "web";
      webKind: "website" | "webapp";
      openMode: "dialog" | "window";
      canClose: boolean;
      canOpenAlternative: boolean;
      canExport: boolean;
      canRemove: boolean;
      showRemove: boolean;
    };

export type SidebarContextMenuPopupRequest = {
  x: number;
  y: number;
  target: SidebarContextMenuTarget;
};

export type SidebarContextMenuPopupResult = {
  actionId: SidebarContextMenuActionId | null;
};
