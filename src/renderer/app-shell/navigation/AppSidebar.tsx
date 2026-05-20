import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import {
  CustomSidebarIcon,
  SidebarIllustration,
  type SidebarIllustrationKind,
} from "../../components/BrandMark";
import type { AssistantNavAgentItem, AssistantNavChatItem, CustomSidebarItem } from "../../../shared/contracts";
import {
  createCustomSidebarNavOrderKey,
  type SidebarNavOrderItemKey,
} from "./sidebarNavOrder";

type SidebarNavItem = {
  orderKey: SidebarNavOrderItemKey;
  to: string;
  label: string;
  icon: SidebarIllustrationKind;
  iconId?: string;
};

type SidebarToolItem = Omit<SidebarNavItem, "orderKey"> & {
  orderKey: string;
};

type SidebarPrimaryEntry = SidebarNavItem & {
  entryType?: "link" | "assistants" | "websites";
};

type SidebarGroupId = "assistants" | "websites";

type SidebarGroupState = Record<SidebarGroupId, boolean>;

type SidebarStatusSummary = {
  unreadCount: number;
  pendingCount: number;
};

type ToolMenuPosition = {
  top: number;
  left: number;
};

type AssistantChatMenuState = {
  chat: AssistantNavChatItem;
  x: number;
  y: number;
};

type AssistantHistoryState = {
  agent: AssistantNavAgentItem;
  search: string;
};

const SIDEBAR_GROUP_STATE_STORAGE_KEY = "zenmind-desktop.sidebar-groups";

const defaultSidebarGroupState: SidebarGroupState = {
  assistants: true,
  websites: true,
};

const taskBoardNavItem: SidebarPrimaryEntry = {
  orderKey: "kanban",
  to: "/kanban",
  label: "任务看板",
  icon: "futures",
};

const assistantGroupNavItem: SidebarPrimaryEntry = {
  orderKey: "group:assistants",
  to: "",
  label: "智能助理",
  icon: "assistant",
  entryType: "assistants",
};

const websitesGroupNavItem: SidebarPrimaryEntry = {
  orderKey: "group:websites",
  to: "",
  label: "内嵌网站",
  icon: "website",
  entryType: "websites",
};

const fixedToolRows: SidebarToolItem[][] = [
  [
    { orderKey: "agents", to: "/agents", label: "智能体", icon: "agent" },
    {
      orderKey: "schedules",
      to: "/schedules",
      label: "自动化",
      icon: "schedule",
    },
    { orderKey: "memory", to: "/memory", label: "记忆管理", icon: "memory" },
  ],
  [
    { orderKey: "control-center", to: "/control-center", label: "控制中心", icon: "control" },
    { orderKey: "market", to: "/market", label: "功能市场", icon: "market" },
    { orderKey: "settings", to: "/settings", label: "设置", icon: "settings" },
  ],
  [
    { orderKey: "help", to: "/help", label: "帮助", icon: "help" },
  ],
];

const fixedToolItems = fixedToolRows.flat();

function getCollapsedSidebarLabel(label: string) {
  const Segmenter =
    typeof Intl === "undefined"
      ? undefined
      : (
          Intl as unknown as {
            Segmenter?: new (
              locale: string,
              options: { granularity: "grapheme" },
            ) => { segment(input: string): Iterable<{ segment: string }> };
          }
        ).Segmenter;

  if (Segmenter) {
    const segments = new Segmenter("zh-CN", {
      granularity: "grapheme",
    }).segment(label);
    return Array.from(segments, ({ segment }) => segment)
      .slice(0, 5)
      .join("");
  }

  return Array.from(label).slice(0, 5).join("");
}

function normalizeSidebarGroupState(candidate: unknown): SidebarGroupState {
  if (!candidate || typeof candidate !== "object") {
    return defaultSidebarGroupState;
  }
  const record = candidate as Partial<Record<SidebarGroupId, unknown>>;
  return {
    assistants: typeof record.assistants === "boolean" ? record.assistants : defaultSidebarGroupState.assistants,
    websites: typeof record.websites === "boolean" ? record.websites : defaultSidebarGroupState.websites,
  };
}

function readInitialSidebarGroupState() {
  if (typeof window === "undefined") {
    return defaultSidebarGroupState;
  }
  try {
    const savedValue = window.localStorage.getItem(SIDEBAR_GROUP_STATE_STORAGE_KEY);
    return savedValue ? normalizeSidebarGroupState(JSON.parse(savedValue)) : defaultSidebarGroupState;
  } catch {
    return defaultSidebarGroupState;
  }
}

function getRoutePathname(route: string) {
  return route.split("?")[0] || "/";
}

function getRouteAgentKey(route: string) {
  const queryIndex = route.indexOf("?");
  if (queryIndex < 0) {
    return "";
  }
  try {
    return new URLSearchParams(route.slice(queryIndex + 1)).get("agentKey")?.trim() ?? "";
  } catch {
    return "";
  }
}

function createAgentRoute(agentKey: string) {
  return `/service/agent-webclient?agentKey=${encodeURIComponent(agentKey)}`;
}

function createAgentChatRoute(agentKey: string, chatId: string) {
  return `/service/agent-webclient?agentKey=${encodeURIComponent(agentKey)}&chatId=${encodeURIComponent(chatId)}`;
}

function createAgentNewChatRoute(agentKey: string) {
  return `/service/agent-webclient?agentKey=${encodeURIComponent(agentKey)}&newChat=1&nonce=${Date.now().toString(36)}`;
}

function summarizeAgentStatus(items: AssistantNavAgentItem[]): SidebarStatusSummary {
  return {
    unreadCount: items.reduce((total, item) => total + Math.max(0, item.unreadCount), 0),
    pendingCount: items.filter((item) => item.hasPendingAwaiting).length,
  };
}

function createAgentStatusSummary(item: AssistantNavAgentItem): SidebarStatusSummary {
  return {
    unreadCount: Math.max(0, item.unreadCount),
    pendingCount: item.hasPendingAwaiting ? 1 : 0,
  };
}

function formatUnreadCount(value: number) {
  if (value <= 0) {
    return "";
  }
  return value > 99 ? "99+" : String(value);
}

function formatAssistantChatTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(new Date(timestamp));
}

type SidebarCollapseToggleVariant = "compact" | "nav";

type SidebarCollapseToggleProps = {
  isCollapsed: boolean;
  variant: SidebarCollapseToggleVariant;
  className?: string;
  onToggleCollapsed?: () => void;
};

function SidebarCollapseToggleIcon({ isCollapsed }: { isCollapsed: boolean }) {
  if (isCollapsed) {
    return (
      <span
        className="app-sidebar-collapse-button-icon app-sidebar-collapse-button-icon-chevron"
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className="app-sidebar-collapse-button-icon app-sidebar-collapse-button-icon-panel"
      viewBox="0 -960 960 960"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm120-80v-560H200v560h120Zm80 0h360v-560H400v560Zm-80 0H200h120Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SidebarCollapseToggle({
  isCollapsed,
  variant,
  onToggleCollapsed,
  className,
}: SidebarCollapseToggleProps) {
  return (
    <button
      type="button"
      className={[
        "app-sidebar-collapse-button",
        className ? className : "",
        variant === "compact" ? "is-compact" : "is-nav",
        isCollapsed ? "is-collapsed-state" : "is-expanded-state",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
      title={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
      aria-expanded={!isCollapsed}
      onClick={onToggleCollapsed}
    >
      <SidebarCollapseToggleIcon isCollapsed={isCollapsed} />
    </button>
  );
}

type AppSidebarProps = {
  isCollapsed: boolean;
  isMac: boolean;
  isWindows: boolean;
  currentPathname: string;
  currentRoute: string;
  pendingPath?: string | null;
  assistantDockOpen?: boolean;
  assistantLauncherDisabled?: boolean;
  assistantLauncherVisible?: boolean;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  customSidebarNavOrder?: SidebarNavOrderItemKey[];
  customSidebarItems: CustomSidebarItem[];
  assistantNavAgents?: AssistantNavAgentItem[];
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onRequestNavigate?: (targetPath: string) => boolean;
  onNavigateItem?: () => void;
  onToggleCollapsed?: () => void;
};

export function AppSidebar({
  isCollapsed,
  isMac,
  isWindows,
  currentPathname,
  currentRoute,
  pendingPath,
  assistantDockOpen = false,
  assistantLauncherDisabled = false,
  assistantLauncherVisible = true,
  sidebarNavOrder,
  customSidebarNavOrder = [],
  customSidebarItems,
  assistantNavAgents = [],
  onOpenAssistantDock,
  onCloseAssistantDock,
  onRequestNavigate,
  onNavigateItem,
  onToggleCollapsed,
}: AppSidebarProps) {
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(readInitialSidebarGroupState);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuPosition, setToolMenuPosition] = useState<ToolMenuPosition | null>(null);
  const [expandedAssistantAgentKey, setExpandedAssistantAgentKey] = useState("");
  const [assistantChatMenu, setAssistantChatMenu] = useState<AssistantChatMenuState | null>(null);
  const [assistantHistory, setAssistantHistory] = useState<AssistantHistoryState | null>(null);
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const assistantChatMenuRef = useRef<HTMLDivElement | null>(null);
  const currentAgentKey = getRouteAgentKey(currentRoute);
  const pendingAgentKey = pendingPath ? getRouteAgentKey(pendingPath) : "";
  const assistantStatusSummary = useMemo(
    () => summarizeAgentStatus(assistantNavAgents),
    [assistantNavAgents],
  );

  const customItems: SidebarNavItem[] = useMemo(() => {
    const orderIndex = new Map(
      customSidebarNavOrder.map((key, index) => [key, index] as const),
    );
    return customSidebarItems
      .map((item) => ({
        orderKey: createCustomSidebarNavOrderKey(item.id),
        to: `/custom-sidebar/${item.id}`,
        label: item.label,
        icon: "website" as const,
        iconId: item.iconId,
      }))
      .sort((left, right) => {
        const leftIndex = orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [customSidebarItems, customSidebarNavOrder]);

  const navItems = [
    taskBoardNavItem,
    assistantGroupNavItem,
    websitesGroupNavItem,
  ];
  const chromeToolbarClassName = [
    "sidebar-chrome-toolbar",
    isMac ? "is-mac" : isWindows ? "is-windows" : "is-default",
  ].join(" ");

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_GROUP_STATE_STORAGE_KEY,
        JSON.stringify(sidebarGroupState),
      );
    } catch {
      // Ignore localStorage failures in restricted renderer contexts.
    }
  }, [sidebarGroupState]);

  useEffect(() => {
    if (!toolMenuOpen) {
      return undefined;
    }

    function updateToolMenuPosition() {
      const triggerRect = toolMenuTriggerRef.current?.getBoundingClientRect();
      if (!triggerRect) {
        return;
      }
      const panelWidth = toolMenuPanelRef.current?.offsetWidth ?? 228;
      const panelHeight = toolMenuPanelRef.current?.offsetHeight ?? 174;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 8;
      const left = isCollapsed
        ? Math.min(viewportWidth - panelWidth - gap, triggerRect.right + gap)
        : Math.min(viewportWidth - panelWidth - gap, triggerRect.left);
      const top = isCollapsed
        ? Math.min(viewportHeight - panelHeight - gap, triggerRect.top)
        : triggerRect.top - panelHeight - gap;
      setToolMenuPosition({
        left: Math.max(gap, left),
        top: Math.max(gap, top),
      });
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (toolMenuTriggerRef.current?.contains(target) || toolMenuPanelRef.current?.contains(target)) {
        return;
      }
      setToolMenuOpen(false);
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setToolMenuOpen(false);
        toolMenuTriggerRef.current?.focus();
      }
    }

    updateToolMenuPosition();
    const frame = window.requestAnimationFrame(updateToolMenuPosition);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    window.addEventListener("resize", updateToolMenuPosition);
    window.addEventListener("scroll", updateToolMenuPosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      window.removeEventListener("resize", updateToolMenuPosition);
      window.removeEventListener("scroll", updateToolMenuPosition, true);
    };
  }, [isCollapsed, toolMenuOpen]);

  useEffect(() => {
    if (!assistantChatMenu) {
      return undefined;
    }
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && assistantChatMenuRef.current?.contains(target)) {
        return;
      }
      setAssistantChatMenu(null);
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAssistantChatMenu(null);
      }
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [assistantChatMenu]);

  useEffect(() => {
    if (!expandedAssistantAgentKey && assistantNavAgents.length > 0) {
      const matched = assistantNavAgents.find((agent) => agent.agentKey === currentAgentKey);
      if (matched) {
        setExpandedAssistantAgentKey(matched.agentKey);
      }
    }
  }, [assistantNavAgents, currentAgentKey, expandedAssistantAgentKey]);

  function handleItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    targetPath: string,
  ) {
    const targetPathname = getRoutePathname(targetPath);
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (targetPath === currentRoute || (!targetPath.includes("?") && targetPathname === currentPathname)) {
      event.preventDefault();
      return;
    }

    if (onRequestNavigate && !onRequestNavigate(targetPath)) {
      event.preventDefault();
      return;
    }

    onNavigateItem?.();
  }

  function handleToolItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    targetPath: string,
  ) {
    handleItemClick(event, targetPath);
    setToolMenuOpen(false);
  }

  function requestNavigate(targetPath: string) {
    if (targetPath === currentRoute) {
      return;
    }
    if (onRequestNavigate && !onRequestNavigate(targetPath)) {
      return;
    }
    onNavigateItem?.();
  }

  function handleAssistantAgentHeaderClick(agent: AssistantNavAgentItem) {
    setExpandedAssistantAgentKey((current) => current === agent.agentKey ? "" : agent.agentKey);
    requestNavigate(createAgentRoute(agent.agentKey));
  }

  function handleAssistantNewChat(event: MouseEvent<HTMLElement>, agent: AssistantNavAgentItem) {
    event.preventDefault();
    event.stopPropagation();
    setExpandedAssistantAgentKey(agent.agentKey);
    requestNavigate(createAgentNewChatRoute(agent.agentKey));
  }

  async function handleAssistantMarkAllRead(event: MouseEvent<HTMLElement>, agent: AssistantNavAgentItem) {
    event.preventDefault();
    event.stopPropagation();
    await window.electronAPI.assistant.markAgentChatsRead(agent.agentKey);
  }

  function handleAssistantOpenChat(chat: AssistantNavChatItem) {
    requestNavigate(createAgentChatRoute(chat.agentKey || currentAgentKey, chat.chatId));
  }

  function handleAssistantOpenChatMenu(event: MouseEvent<HTMLButtonElement>, chat: AssistantNavChatItem) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setAssistantChatMenu({
      chat,
      x: Math.min(window.innerWidth - 180, Math.max(8, rect.right - 170)),
      y: Math.min(window.innerHeight - 132, Math.max(8, rect.bottom + 4)),
    });
  }

  async function handleAssistantExportChat(chat: AssistantNavChatItem) {
    setAssistantChatMenu(null);
    await window.electronAPI.assistant.exportChat(chat.chatId);
  }

  async function handleAssistantRenameChat(chat: AssistantNavChatItem) {
    setAssistantChatMenu(null);
    const nextName = window.prompt("重命名会话", chat.chatName);
    if (!nextName?.trim()) {
      return;
    }
    await window.electronAPI.assistant.renameChat(chat.chatId, nextName.trim());
  }

  async function handleAssistantArchiveChat(chat: AssistantNavChatItem) {
    setAssistantChatMenu(null);
    await window.electronAPI.assistant.archiveChat(chat.chatId);
  }

  function handleAssistantDockClick() {
    if (assistantLauncherDisabled) {
      return;
    }
    if (assistantDockOpen) {
      onCloseAssistantDock?.();
    } else {
      onOpenAssistantDock?.();
    }
    onNavigateItem?.();
  }

  function handleToolMenuTriggerClick() {
    setToolMenuOpen((current) => !current);
  }

  function toggleSidebarGroup(groupId: SidebarGroupId) {
    setSidebarGroupState((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
  }

  function isRouteActive(targetPath: string) {
    const targetPathname = getRoutePathname(targetPath);
    if (targetPathname !== currentPathname && pendingPath !== targetPath) {
      return false;
    }
    if (targetPathname !== "/service/agent-webclient") {
      return targetPathname === currentPathname || pendingPath === targetPath;
    }
    const targetAgentKey = getRouteAgentKey(targetPath);
    const activeAgentKey = pendingPath === targetPath ? pendingAgentKey : currentAgentKey;
    return targetAgentKey === activeAgentKey;
  }

  function isAssistantGroupActive() {
    return currentPathname === "/service/agent-webclient" || Boolean(pendingPath?.startsWith("/service/agent-webclient"));
  }

  function isWebsiteGroupActive() {
    return currentPathname.startsWith("/custom-sidebar/") || Boolean(pendingPath?.startsWith("/custom-sidebar/"));
  }

  function renderStatusBadges(summary: SidebarStatusSummary, className = "") {
    const unreadLabel = formatUnreadCount(summary.unreadCount);
    if (summary.pendingCount <= 0 && !unreadLabel) {
      return null;
    }
    return (
      <span className={["sidebar-status-badges", className].filter(Boolean).join(" ")} aria-hidden="true">
        {summary.pendingCount > 0 ? (
          <span className="sidebar-status-badge is-pending">
            待{summary.pendingCount > 1 ? summary.pendingCount : ""}
          </span>
        ) : null}
        {unreadLabel ? (
          <span className="sidebar-status-badge is-unread">{unreadLabel}</span>
        ) : null}
      </span>
    );
  }

  function getSidebarLinkClassName(targetPath: string, extraClassName = "") {
    return [
      "sidebar-link",
      extraClassName,
      isRouteActive(targetPath) ? "sidebar-link-active" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function renderSidebarLink(item: SidebarNavItem, extraClassName = "") {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, extraClassName)}
      >
        <span className="sidebar-link-icon">
          {item.iconId ? (
            <CustomSidebarIcon iconId={item.iconId} />
          ) : (
            <SidebarIllustration kind={item.icon} />
          )}
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        <span className="sidebar-link-label-collapsed" aria-hidden="true">
          {getCollapsedSidebarLabel(item.label)}
        </span>
      </NavLink>
    );
  }

  function renderSidebarChildLink(item: SidebarNavItem & { status?: SidebarStatusSummary }) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, "sidebar-child-link")}
      >
        <span className="sidebar-link-icon">
          {item.iconId ? (
            <CustomSidebarIcon iconId={item.iconId} />
          ) : (
            <SidebarIllustration kind={item.icon} />
          )}
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        {item.status ? renderStatusBadges(item.status, "sidebar-child-status") : null}
      </NavLink>
    );
  }

  function renderAssistantAgentIcon(agent: AssistantNavAgentItem, extraClassName = "") {
    if (typeof agent.icon === "object" && agent.icon?.color) {
      return (
        <span
          className={["assistant-worker-avatar", extraClassName].filter(Boolean).join(" ")}
          style={{ backgroundColor: agent.icon.color }}
          aria-hidden="true"
        >
          {(agent.icon.name || agent.displayName || agent.agentKey).slice(0, 1).toUpperCase()}
        </span>
      );
    }
    return (
      <span className={["assistant-worker-avatar", extraClassName].filter(Boolean).join(" ")} aria-hidden="true">
        <SidebarIllustration kind="agent" />
      </span>
    );
  }

  function renderAssistantChatRow(chat: AssistantNavChatItem, activeChatId: string) {
    const isActive = activeChatId === chat.chatId;
    return (
      <button
        type="button"
        key={chat.chatId}
        className={[
          "assistant-worker-chat-item",
          "worker-chat-item",
          isActive ? "is-active" : "",
          !chat.isRead ? "is-unread" : "",
        ].filter(Boolean).join(" ")}
        onClick={() => handleAssistantOpenChat(chat)}
      >
        <span className="assistant-worker-chat-title">
          {chat.lastRunContent || chat.chatName || "暂无预览"}
        </span>
        {chat.hasPendingAwaiting ? (
          <span className="chat-awaiting-status">等待审批</span>
        ) : null}
        <span className="assistant-worker-chat-meta">
          {!chat.isRead ? <span className="assistant-worker-unread-dot" aria-label="未读" /> : null}
          <span className="assistant-worker-time">{formatAssistantChatTime(chat.updatedAt)}</span>
          <button
            type="button"
            className="assistant-worker-chat-menu-button"
            aria-label="会话更多操作"
            title="更多"
            onClick={(event) => handleAssistantOpenChatMenu(event, chat)}
          >
            ⋮
          </button>
        </span>
      </button>
    );
  }

  function renderAssistantAgent(agent: AssistantNavAgentItem) {
    const expanded = expandedAssistantAgentKey === agent.agentKey;
    const selected = currentAgentKey === agent.agentKey || pendingAgentKey === agent.agentKey;
    const recentChats = agent.recentChats ?? [];
    const unreadCount = Math.max(0, agent.unreadCount || agent.unreadChatCount || 0);
    return (
      <div
        key={agent.agentKey}
        className={[
          "assistant-worker-collapse-item",
          "worker-collapse-item",
          "ant-collapse-item",
          expanded ? "ant-collapse-item-active" : "",
          selected ? "is-selected" : "",
        ].filter(Boolean).join(" ")}
      >
        <div
          className="ant-collapse-header assistant-worker-header"
          role="tab"
          aria-expanded={expanded}
          aria-disabled="false"
          tabIndex={0}
          onClick={() => handleAssistantAgentHeaderClick(agent)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleAssistantAgentHeaderClick(agent);
            }
          }}
        >
          <span className="ant-collapse-header-text assistant-worker-header-text">
            <span className="worker-panel-header">
              {renderAssistantAgentIcon(agent, "worker-panel-icon")}
              <span className="assistant-worker-main">
                <span className="worker-panel-header-body">
                  <span className="assistant-worker-name">{agent.displayName}</span>
                  <span className="worker-panel-role">{agent.role || "--"}</span>
                </span>
                <span className="worker-panel-preview">
                  <span className="assistant-worker-preview">{agent.latestPreview || "暂无会话"}</span>
                  {agent.hasPendingAwaiting ? <span className="chat-awaiting-status">等待审批</span> : null}
                  <span className="worker-panel-time-label">{formatAssistantChatTime(agent.updatedAt)}</span>
                </span>
              </span>
              {unreadCount > 0 && !expanded ? (
                <span className="sidebar-status-badge is-unread">{formatUnreadCount(unreadCount)}</span>
              ) : null}
              <span className="assistant-worker-actions">
                {unreadCount > 0 ? (
                  <button
                    type="button"
                    className="worker-panel-new assistant-worker-icon-button"
                    aria-label={`全部已读 ${agent.displayName}`}
                    title="全部已读"
                    onClick={(event) => void handleAssistantMarkAllRead(event, agent)}
                  >
                    ✓✓
                  </button>
                ) : null}
                <button
                  type="button"
                  className="worker-panel-new assistant-worker-icon-button"
                  aria-label={`新建对话 ${agent.displayName}`}
                  title="新建对话"
                  onClick={(event) => handleAssistantNewChat(event, agent)}
                >
                  ＋
                </button>
              </span>
            </span>
          </span>
        </div>
        {expanded ? (
          <div className="ant-collapse-content assistant-worker-content">
            <div className="ant-collapse-content-box worker-chat-preview-list">
              <div className="worker-chat-divider" />
              {recentChats.length > 0 ? (
                recentChats.map((chat) => renderAssistantChatRow(chat, agent.latestChatId || ""))
              ) : (
                <div className="status-line">暂无相关会话</div>
              )}
              {Math.max(agent.chatCount, recentChats.length) > 5 ? (
                <button
                  type="button"
                  className="worker-chat-more assistant-worker-more"
                  onClick={(event) => {
                    event.stopPropagation();
                    setAssistantHistory({ agent, search: "" });
                  }}
                >
                  查看更多（共 {Math.max(agent.chatCount, recentChats.length)} 条{unreadCount > 0 ? `，未读 ${unreadCount} 条` : ""}）
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderSidebarGroup(args: {
    groupId: SidebarGroupId;
    label: string;
    icon: SidebarIllustrationKind;
    active: boolean;
    status?: SidebarStatusSummary;
    children: Array<SidebarNavItem & { status?: SidebarStatusSummary }>;
  }) {
    const expanded = sidebarGroupState[args.groupId];
    const groupTriggerClassName = isCollapsed
      ? [
          "sidebar-link",
          "sidebar-group-trigger",
          args.active ? "sidebar-link-active" : "",
        ].filter(Boolean).join(" ")
      : [
          "sidebar-group-heading",
          args.active ? "is-active" : "",
        ].filter(Boolean).join(" ");
    return (
      <div
        key={args.groupId}
        className={[
          "sidebar-nav-group",
          expanded ? "is-expanded" : "is-collapsed",
          args.active ? "is-active" : "",
        ].filter(Boolean).join(" ")}
      >
        <button
          type="button"
          className={groupTriggerClassName}
          onClick={() => toggleSidebarGroup(args.groupId)}
          aria-expanded={!isCollapsed && expanded}
          aria-label={args.label}
          title={args.label}
        >
          <span className="sidebar-group-heading-main">
            <span className="sidebar-link-icon">
              <SidebarIllustration kind={args.icon} />
            </span>
            <span className="sidebar-link-label">{args.label}</span>
            {args.status ? renderStatusBadges(args.status, "sidebar-group-status") : null}
          </span>
          {!isCollapsed ? <span className="sidebar-group-divider" aria-hidden="true" /> : null}
          <span className="sidebar-group-chevron" aria-hidden="true" />
        </button>
        {!isCollapsed && expanded ? (
          <div className="sidebar-group-children" role="group" aria-label={args.label}>
            {args.groupId === "assistants"
              ? (
                  <div className="assistant-worker-collapse worker-collapse">
                    {assistantNavAgents.length > 0
                      ? assistantNavAgents.map((agent) => renderAssistantAgent(agent))
                      : <div className="status-line">暂无智能体</div>}
                  </div>
                )
              : args.children.map((item) => renderSidebarChildLink(item))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderPrimaryNavEntry(item: SidebarPrimaryEntry) {
    if (item.entryType === "assistants") {
      return renderSidebarGroup({
        groupId: "assistants",
        label: item.label,
        icon: item.icon,
        active: isAssistantGroupActive(),
        status: assistantStatusSummary,
        children: [],
      });
    }
    if (item.entryType === "websites") {
      return renderSidebarGroup({
        groupId: "websites",
        label: item.label,
        icon: item.icon,
        active: isWebsiteGroupActive(),
        children: customItems,
      });
    }
    return renderSidebarLink(item);
  }

  function renderToolLink(item: SidebarToolItem) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleToolItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        role="menuitem"
        className={() => getSidebarLinkClassName(item.to, "sidebar-tool-menu-item")}
      >
        <span className="sidebar-link-icon">
          <SidebarIllustration kind={item.icon} />
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        <span className="sidebar-link-label-collapsed" aria-hidden="true">
          {getCollapsedSidebarLabel(item.label)}
        </span>
      </NavLink>
    );
  }

  function renderToolMenu() {
    if (!toolMenuOpen || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        ref={toolMenuPanelRef}
        className={[
          "sidebar-tool-menu",
          isCollapsed ? "is-from-collapsed-sidebar" : "is-from-expanded-sidebar",
        ].filter(Boolean).join(" ")}
        style={{
          left: `${toolMenuPosition?.left ?? -9999}px`,
          top: `${toolMenuPosition?.top ?? -9999}px`,
        }}
        role="menu"
        aria-label="固定工具区"
      >
        {fixedToolItems.map((item) => renderToolLink(item))}
      </div>,
      document.body,
    );
  }

  function renderAssistantChatMenu() {
    if (!assistantChatMenu || typeof document === "undefined") {
      return null;
    }
    const chat = assistantChatMenu.chat;
    return createPortal(
      <div
        ref={assistantChatMenuRef}
        className="assistant-chat-actions-menu"
        style={{ left: assistantChatMenu.x, top: assistantChatMenu.y }}
        role="menu"
        aria-label="会话操作"
      >
        <button type="button" role="menuitem" onClick={() => void handleAssistantExportChat(chat)}>
          <span aria-hidden="true">↓</span>
          <span>导出</span>
        </button>
        <button type="button" role="menuitem" onClick={() => void handleAssistantRenameChat(chat)}>
          <span aria-hidden="true">✎</span>
          <span>重命名</span>
        </button>
        <button type="button" role="menuitem" onClick={() => void handleAssistantArchiveChat(chat)}>
          <span aria-hidden="true">□</span>
          <span>归档</span>
        </button>
      </div>,
      document.body,
    );
  }

  function renderAssistantHistory() {
    if (!assistantHistory || typeof document === "undefined") {
      return null;
    }
    const agent = assistantHistory.agent;
    const search = assistantHistory.search.trim().toLowerCase();
    const rows = (agent.recentChats ?? []).filter((chat) => {
      if (!search) {
        return true;
      }
      return [chat.chatName, chat.lastRunContent, chat.chatId].join(" ").toLowerCase().includes(search);
    });
    return createPortal(
      <div className="assistant-history-overlay" role="presentation" onMouseDown={() => setAssistantHistory(null)}>
        <section
          className="assistant-history-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${agent.displayName} 会话历史`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="assistant-history-header">
            <strong>智能体历史 · {agent.displayName}</strong>
            <span>共 {agent.chatCount} 条会话</span>
            <button type="button" aria-label="关闭历史" onClick={() => setAssistantHistory(null)}>×</button>
          </header>
          <input
            value={assistantHistory.search}
            placeholder="搜索会话..."
            onChange={(event) => setAssistantHistory({ agent, search: event.target.value })}
          />
          <div className="assistant-history-list">
            {rows.length > 0 ? rows.map((chat) => renderAssistantChatRow(chat, agent.latestChatId || "")) : (
              <div className="status-line">暂无会话</div>
            )}
          </div>
        </section>
      </div>,
      document.body,
    );
  }

  return (
    <aside className={isCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="sidebar-chrome">
        <div className="sidebar-chrome-drag-region" aria-hidden="true" />
        <div className={chromeToolbarClassName}>
          <div className="sidebar-top-actions">
            <SidebarCollapseToggle
              className="sidebar-collapsed-toggle-button"
              isCollapsed={isCollapsed}
              variant="compact"
              onToggleCollapsed={onToggleCollapsed}
            />
            {assistantLauncherVisible ? (
              <button
                type="button"
                className={[
                  "app-sidebar-collapse-button",
                  "sidebar-assistant-top-button",
                  "is-compact",
                  assistantDockOpen ? "is-assistant-open" : "",
                  assistantLauncherDisabled ? "is-disabled" : "",
                  isCollapsed ? "is-collapsed-state" : "is-expanded-state",
                ].filter(Boolean).join(" ")}
                onClick={handleAssistantDockClick}
                aria-label={
                  assistantLauncherDisabled
                    ? "当前页面不可开启 ZenMind 助手"
                    : assistantDockOpen
                      ? "关闭 ZenMind 助手"
                      : "打开 ZenMind 助手"
                }
                aria-disabled={assistantLauncherDisabled}
                aria-pressed={assistantDockOpen}
                disabled={assistantLauncherDisabled}
                title="侧边助手"
              >
                <span className="app-sidebar-collapse-button-icon sidebar-assistant-top-button-icon">
                  <SidebarIllustration
                    kind={
                      assistantDockOpen
                        ? "sidebar-assistant-open"
                        : "sidebar-assistant-closed"
                    }
                  />
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Primary Navigation">
        {navItems.map((item) => renderPrimaryNavEntry(item))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-divider" aria-hidden="true" />
        <div className="sidebar-footer-actions">
          <div className="sidebar-tool-menu-anchor">
            <button
              type="button"
              className={[
                "sidebar-link",
                "sidebar-link-utility",
                "sidebar-tool-menu-trigger",
                fixedToolItems.some((item) => isRouteActive(item.to)) ? "sidebar-link-active" : "",
                toolMenuOpen ? "is-open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              ref={toolMenuTriggerRef}
              onClick={handleToolMenuTriggerClick}
              aria-label="打开固定工具区"
              aria-haspopup="menu"
              aria-expanded={toolMenuOpen}
              title="工具"
            >
              <span className="sidebar-link-icon">
                <SidebarIllustration kind="control" />
              </span>
              <span className="sidebar-link-label">工具</span>
              <span className="sidebar-link-label-collapsed" aria-hidden="true">
                {getCollapsedSidebarLabel("工具")}
              </span>
            </button>
          </div>
          {renderToolMenu()}
          {renderAssistantChatMenu()}
          {renderAssistantHistory()}
        </div>
      </div>
    </aside>
  );
}
