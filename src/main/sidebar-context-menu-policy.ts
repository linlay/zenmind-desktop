import type {
  SidebarContextMenuActionId,
  SidebarContextMenuPopupRequest,
  SidebarContextMenuTarget
} from "../shared/sidebar-context-menu";

export type SidebarContextMenuPolicyActionItem = {
  id: SidebarContextMenuActionId;
  enabled: boolean;
  type?: "normal" | "radio";
  checked?: boolean;
};

export type SidebarContextMenuSubmenuId = "chat.exportMenu";

export type SidebarContextMenuPolicyItem =
  | (SidebarContextMenuPolicyActionItem & { group: number })
  | {
      id: SidebarContextMenuSubmenuId;
      group: number;
      enabled: boolean;
      submenu: SidebarContextMenuPolicyActionItem[];
    };

const MAX_COORDINATE = 100_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function normalizeSidebarContextMenuRequest(
  value: unknown
): SidebarContextMenuPopupRequest | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["x", "y", "target"])) {
    return null;
  }
  if (
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    Math.abs(Number(value.x)) > MAX_COORDINATE ||
    Math.abs(Number(value.y)) > MAX_COORDINATE ||
    !isPlainObject(value.target)
  ) {
    return null;
  }

  const target = value.target;
  let normalizedTarget: SidebarContextMenuTarget;
  if (target.kind === "group") {
    if (
      !hasOnlyKeys(target, [
        "kind",
        "groupId",
        "canCreateProject",
        "canCreateChat",
        "chatSortMode",
        "chatOrderingSupported",
        "menuScope"
      ]) ||
      !["assistants", "chats", "webs"].includes(String(target.groupId)) ||
      !isBoolean(target.canCreateProject) ||
      !isBoolean(target.canCreateChat) ||
      !["recent", "manual"].includes(String(target.chatSortMode)) ||
      !isBoolean(target.chatOrderingSupported) ||
      (target.menuScope !== undefined && target.menuScope !== "sort")
    ) {
      return null;
    }
    normalizedTarget = {
      kind: "group",
      groupId: target.groupId as "assistants" | "chats" | "webs",
      canCreateProject: target.canCreateProject,
      canCreateChat: target.canCreateChat,
      chatSortMode: target.chatSortMode as "recent" | "manual",
      chatOrderingSupported: target.chatOrderingSupported,
      ...(target.menuScope === "sort" ? { menuScope: "sort" as const } : {})
    };
  } else if (target.kind === "agent") {
    if (
      !hasOnlyKeys(target, ["kind", "canRevealWorkspace", "canOpenProjectEditor"]) ||
      !isBoolean(target.canRevealWorkspace) ||
      !isBoolean(target.canOpenProjectEditor)
    ) {
      return null;
    }
    normalizedTarget = {
      kind: "agent",
      canRevealWorkspace: target.canRevealWorkspace,
      canOpenProjectEditor: target.canOpenProjectEditor
    };
  } else if (target.kind === "chat") {
    if (!hasOnlyKeys(target, ["kind", "workPanelOpen"]) || !isBoolean(target.workPanelOpen)) {
      return null;
    }
    normalizedTarget = { kind: "chat", workPanelOpen: target.workPanelOpen };
  } else if (target.kind === "web") {
    if (
      !hasOnlyKeys(target, [
        "kind",
        "webKind",
        "openMode",
        "canClose",
        "canOpenAlternative",
        "canExport",
        "canRemove",
        "showRemove"
      ]) ||
      !["website", "webapp"].includes(String(target.webKind)) ||
      !["dialog", "window"].includes(String(target.openMode)) ||
      !isBoolean(target.canClose) ||
      !isBoolean(target.canOpenAlternative) ||
      !isBoolean(target.canExport) ||
      !isBoolean(target.canRemove) ||
      !isBoolean(target.showRemove)
    ) {
      return null;
    }
    normalizedTarget = {
      kind: "web",
      webKind: target.webKind as "website" | "webapp",
      openMode: target.openMode as "dialog" | "window",
      canClose: target.canClose,
      canOpenAlternative: target.canOpenAlternative,
      canExport: target.canExport,
      canRemove: target.canRemove,
      showRemove: target.showRemove
    };
  } else {
    return null;
  }

  return {
    x: Math.round(Number(value.x)),
    y: Math.round(Number(value.y)),
    target: normalizedTarget
  };
}

export function buildSidebarContextMenuPolicy(
  target: SidebarContextMenuTarget
): SidebarContextMenuPolicyItem[] {
  if (target.kind === "group") {
    if (target.groupId === "assistants") {
      return [{
        id: "group.new-project",
        group: 0,
        enabled: target.canCreateProject
      }];
    }
    if (target.groupId === "chats") {
      const sortItems: SidebarContextMenuPolicyItem[] = [
        {
          id: "group.chat-sort-recent",
          group: 0,
          enabled: target.chatOrderingSupported,
          type: "radio",
          checked: target.chatSortMode === "recent"
        },
        {
          id: "group.chat-sort-manual",
          group: 0,
          enabled: target.chatOrderingSupported,
          type: "radio",
          checked: target.chatSortMode === "manual"
        }
      ];
      if (target.menuScope === "sort") {
        return sortItems;
      }
      return [
        ...sortItems,
        {
          id: "group.new-chat",
          group: 1,
          enabled: target.canCreateChat
        }
      ];
    }
    return [
      { id: "group.add-website", group: 0, enabled: true },
      { id: "group.import-webapp", group: 0, enabled: true }
    ];
  }

  if (target.kind === "agent") {
    return [
      {
        id: "agent.reveal-workspace",
        group: 0,
        enabled: target.canRevealWorkspace
      },
      {
        id: "agent.open-project-editor",
        group: 0,
        enabled: target.canOpenProjectEditor
      },
      { id: "agent.edit", group: 0, enabled: true }
    ];
  }

  if (target.kind === "chat") {
    return [
      {
        id: target.workPanelOpen ? "chat.workPanel.close" : "chat.workPanel.open",
        group: 0,
        enabled: true
      },
      {
        id: "chat.exportMenu",
        group: 1,
        enabled: true,
        submenu: [
          { id: "chat.export", enabled: true },
          { id: "chat.exportHtml", enabled: true }
        ]
      },
      { id: "chat.share", group: 1, enabled: true },
      { id: "chat.rename", group: 1, enabled: true },
      { id: "chat.archive", group: 2, enabled: true },
      { id: "chat.delete", group: 2, enabled: true },
      { id: "chat.info", group: 3, enabled: true }
    ];
  }

  const items: SidebarContextMenuPolicyItem[] = [
    { id: "web.close", group: 0, enabled: target.canClose }
  ];
  if (target.webKind === "webapp") {
    items.push(
      {
        id:
          target.openMode === "dialog"
            ? "web.open-in-workspace"
            : "web.open-in-window",
        group: 1,
        enabled: target.canOpenAlternative
      },
      { id: "web.export", group: 1, enabled: target.canExport }
    );
    if (target.showRemove) {
      items.push({
        id: "web.remove",
        group: 2,
        enabled: target.canRemove
      });
    }
  }
  return items;
}
