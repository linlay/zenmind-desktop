import type {
  SidebarContextMenuActionId,
  SidebarContextMenuPopupRequest,
  SidebarContextMenuTarget
} from "../shared/sidebar-context-menu";

export type SidebarContextMenuPolicyItem = {
  id: SidebarContextMenuActionId;
  group: number;
  enabled: boolean;
  type?: "normal" | "radio";
  checked?: boolean;
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
        "menuScope",
        "sortMode",
        "canCreateProject",
        "canCreateChat"
      ]) ||
      !["assistants", "chats", "webs"].includes(String(target.groupId)) ||
      !["all", "sort"].includes(String(target.menuScope)) ||
      (target.menuScope === "sort" && target.groupId !== "assistants") ||
      !["byName", "byTime"].includes(String(target.sortMode)) ||
      !isBoolean(target.canCreateProject) ||
      !isBoolean(target.canCreateChat)
    ) {
      return null;
    }
    normalizedTarget = {
      kind: "group",
      groupId: target.groupId as "assistants" | "chats" | "webs",
      menuScope: target.menuScope as "all" | "sort",
      sortMode: target.sortMode as "byName" | "byTime",
      canCreateProject: target.canCreateProject,
      canCreateChat: target.canCreateChat
    };
  } else if (target.kind === "agent") {
    if (
      !hasOnlyKeys(target, ["kind", "canOpenWorkspace"]) ||
      !isBoolean(target.canOpenWorkspace)
    ) {
      return null;
    }
    normalizedTarget = {
      kind: "agent",
      canOpenWorkspace: target.canOpenWorkspace
    };
  } else if (target.kind === "chat") {
    if (!hasOnlyKeys(target, ["kind"])) {
      return null;
    }
    normalizedTarget = { kind: "chat" };
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
      const items: SidebarContextMenuPolicyItem[] = [
        {
          id: "group.sort-by-time",
          group: 0,
          enabled: true,
          type: "radio",
          checked: target.sortMode === "byTime"
        },
        {
          id: "group.sort-by-name",
          group: 0,
          enabled: true,
          type: "radio",
          checked: target.sortMode === "byName"
        }
      ];
      if (target.menuScope === "all") {
        items.push({
          id: "group.new-project",
          group: 1,
          enabled: target.canCreateProject
        });
      }
      return items;
    }
    if (target.groupId === "chats") {
      return [
        {
          id: "group.new-chat",
          group: 0,
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
        id: "agent.open-workspace",
        group: 0,
        enabled: target.canOpenWorkspace
      },
      { id: "agent.edit", group: 0, enabled: true }
    ];
  }

  if (target.kind === "chat") {
    return [
      { id: "chat.export", group: 0, enabled: true },
      { id: "chat.rename", group: 0, enabled: true },
      { id: "chat.archive", group: 1, enabled: true },
      { id: "chat.delete", group: 1, enabled: true }
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
