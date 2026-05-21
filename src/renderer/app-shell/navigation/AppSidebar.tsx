import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import {
  CustomSidebarIcon,
  SidebarIllustration,
  type SidebarIllustrationKind,
} from "../../components/BrandMark";
import type {
  AssistantNavAgentItem,
  AssistantNavChatItem,
  CustomSidebarItem,
} from "../../../shared/contracts";
import {
  createCustomSidebarNavOrderKey,
  type SidebarNavOrderItemKey,
} from "./sidebarNavOrder";
import { AgentIcon } from "./AgentIcon";
import { Collapse } from "../../components/Collapse";

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
    {
      orderKey: "control-center",
      to: "/control-center",
      label: "控制中心",
      icon: "control",
    },
    { orderKey: "market", to: "/market", label: "功能市场", icon: "market" },
    { orderKey: "settings", to: "/settings", label: "设置", icon: "settings" },
  ],
  [{ orderKey: "help", to: "/help", label: "帮助", icon: "help" }],
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
    assistants:
      typeof record.assistants === "boolean"
        ? record.assistants
        : defaultSidebarGroupState.assistants,
    websites:
      typeof record.websites === "boolean"
        ? record.websites
        : defaultSidebarGroupState.websites,
  };
}

function readInitialSidebarGroupState() {
  if (typeof window === "undefined") {
    return defaultSidebarGroupState;
  }
  try {
    const savedValue = window.localStorage.getItem(
      SIDEBAR_GROUP_STATE_STORAGE_KEY,
    );
    return savedValue
      ? normalizeSidebarGroupState(JSON.parse(savedValue))
      : defaultSidebarGroupState;
  } catch {
    return defaultSidebarGroupState;
  }
}

function getRoutePathname(route: string) {
  return route.split("?")[0] || "/";
}

function getRouteEmbedPath(route: string) {
  const queryIndex = route.indexOf("?");
  if (queryIndex < 0) {
    return "";
  }
  try {
    return (
      new URLSearchParams(route.slice(queryIndex + 1))
        .get("embedPath")
        ?.trim() ?? ""
    );
  } catch {
    return "";
  }
}

function readAgentInfoFromWebclientPath(pathWithQuery: string) {
  const normalized = pathWithQuery.trim();
  if (!normalized) {
    return { agentKey: "", chatId: "" };
  }
  try {
    const url = new URL(normalized, "http://agent-webclient.local");
    const match = /^\/agent\/([^/?#]+)/u.exec(url.pathname);
    return {
      agentKey: match?.[1] ? decodeURIComponent(match[1]) : "",
      chatId: url.searchParams.get("chatId")?.trim() ?? "",
    };
  } catch {
    return { agentKey: "", chatId: "" };
  }
}

function readAgentRouteInfo(route: string) {
  const embeddedInfo = readAgentInfoFromWebclientPath(getRouteEmbedPath(route));
  if (embeddedInfo.agentKey || embeddedInfo.chatId) {
    return embeddedInfo;
  }
  const directInfo = readAgentInfoFromWebclientPath(route);
  if (directInfo.agentKey || directInfo.chatId) {
    return directInfo;
  }
  const queryIndex = route.indexOf("?");
  if (queryIndex < 0) {
    return { agentKey: "", chatId: "" };
  }
  try {
    const searchParams = new URLSearchParams(route.slice(queryIndex + 1));
    return {
      agentKey: searchParams.get("agentKey")?.trim() ?? "",
      chatId: searchParams.get("chatId")?.trim() ?? "",
    };
  } catch {
    return { agentKey: "", chatId: "" };
  }
}

function createAgentRoute(agentKey: string) {
  return `/agent/${encodeURIComponent(agentKey)}`;
}

function createAgentChatRoute(agentKey: string, chatId: string) {
  const params = new URLSearchParams();
  params.set("chatId", chatId.trim());
  return `${createAgentRoute(agentKey)}?${params.toString()}`;
}

function createAgentNewChatRoute(agentKey: string) {
  return createAgentRoute(agentKey);
}

function createAgentDefaultRoute(agent: AssistantNavAgentItem) {
  const firstChatId = agent.recentChats[0]?.chatId || agent.latestChatId || "";
  return firstChatId
    ? createAgentChatRoute(agent.agentKey, firstChatId)
    : createAgentRoute(agent.agentKey);
}

function createAgentHistoryRoute(agentKey: string) {
  const params = new URLSearchParams();
  params.set("history", "1");
  params.set("historyRequest", String(Date.now()));
  return `${createAgentRoute(agentKey)}?${params.toString()}`;
}

function summarizeAgentStatus(
  items: AssistantNavAgentItem[],
): SidebarStatusSummary {
  return {
    unreadCount: items.reduce(
      (total, item) => total + Math.max(0, item.unreadCount),
      0,
    ),
    pendingCount: items.filter((item) => item.hasPendingAwaiting).length,
  };
}

function formatUnreadCount(value: number) {
  if (value <= 0) {
    return "";
  }
  return value > 99 ? "99+" : String(value);
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function formatLocalTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function formatMonthDay(date: Date): string {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function formatYearMonth(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}
function formatAssistantChatTime(updatedAt: string) {
  if (!updatedAt) {
    return "";
  }

  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) {
    return "--";
  }

  const nowDate: Date = new Date();
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate);
  if (Number.isNaN(now.getTime())) {
    return formatYearMonth(updatedDate);
  }

  // 今天：显示 HH:mm
  if (toLocalDateKey(updatedDate) === toLocalDateKey(now)) {
    return formatLocalTime(updatedDate);
  }

  // 今年但不是今天：显示 MM-dd
  if (updatedDate.getFullYear() === now.getFullYear()) {
    return formatMonthDay(updatedDate);
  }

  // 跨年：显示 YYYY-MM
  return formatYearMonth(updatedDate);
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
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(
    readInitialSidebarGroupState,
  );
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuPosition, setToolMenuPosition] =
    useState<ToolMenuPosition | null>(null);
  const [expandedAssistantAgentKey, setExpandedAssistantAgentKey] =
    useState("");
  const [assistantChatMenu, setAssistantChatMenu] =
    useState<AssistantChatMenuState | null>(null);
  const lastAutoExpandedAssistantAgentKeyRef = useRef("");
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const assistantChatMenuRef = useRef<HTMLDivElement | null>(null);
  const currentRouteAgentInfo = readAgentRouteInfo(currentRoute);
  const pendingRouteAgentInfo = pendingPath
    ? readAgentRouteInfo(pendingPath)
    : { agentKey: "", chatId: "" };
  const currentAgentKey = currentRouteAgentInfo.agentKey;
  const currentChatId = currentRouteAgentInfo.chatId;
  const pendingAgentKey = pendingRouteAgentInfo.agentKey;
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
        const leftIndex =
          orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex =
          orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
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
      if (
        toolMenuTriggerRef.current?.contains(target) ||
        toolMenuPanelRef.current?.contains(target)
      ) {
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
      if (
        target instanceof Node &&
        assistantChatMenuRef.current?.contains(target)
      ) {
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
    const matched = assistantNavAgents.find(
      (agent) => agent.agentKey === currentAgentKey,
    );
    if (!matched) {
      lastAutoExpandedAssistantAgentKeyRef.current = "";
      return;
    }
    if (expandedAssistantAgentKey) {
      if (expandedAssistantAgentKey === matched.agentKey) {
        lastAutoExpandedAssistantAgentKeyRef.current = matched.agentKey;
      }
      return;
    }
    if (lastAutoExpandedAssistantAgentKeyRef.current === matched.agentKey) {
      return;
    }
    lastAutoExpandedAssistantAgentKeyRef.current = matched.agentKey;
    setExpandedAssistantAgentKey(matched.agentKey);
  }, [assistantNavAgents, currentAgentKey, expandedAssistantAgentKey]);

  function handleItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    targetPath: string,
  ) {
    const targetPathname = getRoutePathname(targetPath);
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (
      targetPath === currentRoute ||
      (!targetPath.includes("?") && targetPathname === currentPathname)
    ) {
      event.preventDefault();
      return;
    }

    if (onRequestNavigate) {
      event.preventDefault();
      if (!onRequestNavigate(targetPath)) {
        return;
      }
      onNavigateItem?.();
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
    requestNavigate(createAgentDefaultRoute(agent));
  }

  function handleAssistantNewChat(
    event: MouseEvent<HTMLElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setExpandedAssistantAgentKey(agent.agentKey);
    requestNavigate(createAgentNewChatRoute(agent.agentKey));
  }

  async function handleAssistantMarkAllRead(
    event: MouseEvent<HTMLElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    await window.electronAPI.assistant.markAgentChatsRead(agent.agentKey);
  }

  function handleAssistantOpenChat(chat: AssistantNavChatItem) {
    requestNavigate(
      createAgentChatRoute(chat.agentKey || currentAgentKey, chat.chatId),
    );
  }

  function handleAssistantOpenChatMenu(
    event: MouseEvent<HTMLButtonElement>,
    chat: AssistantNavChatItem,
  ) {
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
    const targetAgentKey = readAgentRouteInfo(targetPath).agentKey;
    const activeAgentKey =
      pendingPath === targetPath ? pendingAgentKey : currentAgentKey;
    return targetAgentKey === activeAgentKey;
  }

  function isAssistantGroupActive() {
    return (
      currentPathname === "/service/agent-webclient" ||
      currentPathname.startsWith("/agent/") ||
      Boolean(
        pendingPath?.startsWith("/service/agent-webclient") ||
        pendingPath?.startsWith("/agent/"),
      )
    );
  }

  function isWebsiteGroupActive() {
    return (
      currentPathname.startsWith("/custom-sidebar/") ||
      Boolean(pendingPath?.startsWith("/custom-sidebar/"))
    );
  }

  function renderStatusBadges(summary: SidebarStatusSummary, className = "") {
    const unreadLabel = formatUnreadCount(summary.unreadCount);
    if (summary.pendingCount <= 0 && !unreadLabel) {
      return null;
    }
    return (
      <span
        className={["sidebar-status-badges", className]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      >
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

  function renderSidebarChildLink(
    item: SidebarNavItem & { status?: SidebarStatusSummary },
  ) {
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
        {item.status
          ? renderStatusBadges(item.status, "sidebar-child-status")
          : null}
      </NavLink>
    );
  }

  function renderAssistantChatRow(
    chat: AssistantNavChatItem,
    activeChatId: string,
  ) {
    const isActive = activeChatId === chat.chatId;
    const action = !chat.isRead ? "unread" : "time";
    return (
      <button
        type="button"
        key={chat.chatId}
        className={[
          "assistant-worker-chat-item",
          "worker-chat-item",
          isActive ? "is-active" : "",
          !chat.isRead ? "is-unread" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => handleAssistantOpenChat(chat)}
      >
        <span className="worker-chat-item-head">
          <span className="worker-chat-name">
            {chat.lastRunContent || chat.chatName || "暂无预览"}
          </span>
          {chat.hasPendingAwaiting ? (
            <span className="chat-awaiting-status">等待审批</span>
          ) : null}
          <span className="assistant-worker-chat-action" data-action={action}>
            <span
              className="assistant-worker-unread-dot chat-unread-dot is-unread"
              aria-label="未读"
            />
            <span className="worker-panel-time-label">
              {formatAssistantChatTime(chat.updatedAt)}
            </span>
            <span
              className="worker-chat-loading assistant-material-icon is-loading"
              aria-hidden="true"
            />
          </span>
          <button
            type="button"
            className="assistant-worker-chat-menu-button chat-actions-trigger"
            aria-label="会话更多操作"
            title="更多"
            onClick={(event) => handleAssistantOpenChatMenu(event, chat)}
          >
            <span
              className="assistant-material-icon is-more"
              aria-hidden="true"
            />
          </button>
        </span>
      </button>
    );
  }

  function renderAssistantAgent(agent: AssistantNavAgentItem) {
    const expanded = expandedAssistantAgentKey === agent.agentKey;
    const selected =
      currentAgentKey === agent.agentKey || pendingAgentKey === agent.agentKey;
    const recentChats = (agent.recentChats ?? []).slice(0, 5);
    const chatCount = Math.max(0, agent.chatCount, recentChats.length);
    const unreadCount = Math.max(
      0,
      agent.unreadCount || agent.unreadChatCount || 0,
    );
    const latestPreview =
      agent.latestPreview || (chatCount > 0 ? "" : "暂无会话");
    const activeChatId = currentChatId || "";
    return (
      <Collapse
        key={agent.agentKey}
        className="assistant-worker-collapse-item"
        expanded={expanded}
        onExpand={(val) =>
          setExpandedAssistantAgentKey(val ? agent.agentKey : "")
        }
        header={
          <div
            className="assistant-worker-header"
            onClick={() => handleAssistantAgentHeaderClick(agent)}
          >
            <span className="assistant-worker-header-text">
              <span
                className={[
                  "worker-panel-header",
                  selected ? "is-active" : "",
                  recentChats.length > 0 ? "" : "is-empty",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <AgentIcon
                  icon={agent.icon}
                  className="worker-panel-icon"
                  size={32}
                  type="agent"
                />
                <span className="assistant-worker-main worker-panel-main">
                  <span className="worker-panel-header-body">
                    <span className="assistant-worker-name">
                      <span>{agent.displayName}</span>
                      <span className="worker-panel-role">
                        {agent.role || "--"}
                      </span>
                    </span>
                    {unreadCount > 0 ? (
                      <span className="assistant-worker-badge">
                        {formatUnreadCount(unreadCount)}
                      </span>
                    ) : null}
                    <span className="assistant-worker-actions">
                      {unreadCount > 0 ? (
                        <button
                          type="button"
                          className="worker-panel-new assistant-worker-icon-button"
                          aria-label={`全部已读 ${agent.displayName}`}
                          title="全部已读"
                          onClick={(event) =>
                            void handleAssistantMarkAllRead(event, agent)
                          }
                        >
                          <span
                            className="assistant-material-icon is-done-all"
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="worker-panel-new assistant-worker-icon-button"
                        aria-label={`新建对话 ${agent.displayName}`}
                        title="新建对话"
                        onClick={(event) =>
                          handleAssistantNewChat(event, agent)
                        }
                      >
                        <span
                          className="assistant-material-icon is-add"
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  </span>
                  <span className="worker-panel-preview">
                    <span className="assistant-worker-preview">
                      {latestPreview}
                    </span>
                    {agent.hasPendingAwaiting ? (
                      <span className="chat-awaiting-status">等待审批</span>
                    ) : null}
                    <span className="worker-panel-time-label">
                      {formatAssistantChatTime(
                        agent.recentChats?.[0]?.updatedAt,
                      )}
                    </span>
                  </span>
                </span>
              </span>
            </span>
          </div>
        }
      >
        <div className="worker-chat-preview-list">
          <div className="worker-chat-divider"></div>
          {recentChats.length > 0 ? (
            recentChats.map((chat) =>
              renderAssistantChatRow(chat, activeChatId),
            )
          ) : chatCount === 0 ? (
            <div className="status-line">暂无会话</div>
          ) : null}
          {chatCount > recentChats.length ? (
            <button
              type="button"
              className="worker-chat-more assistant-worker-more"
              onClick={(event) => {
                event.stopPropagation();
                requestNavigate(createAgentHistoryRoute(agent.agentKey));
              }}
            >
              查看更多（共 {chatCount} 条
              {unreadCount > 0 ? `，未读 ${unreadCount} 条` : ""}）
            </button>
          ) : null}
        </div>
      </Collapse>
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
        ]
          .filter(Boolean)
          .join(" ")
      : ["sidebar-group-heading", args.active ? "is-active" : ""]
          .filter(Boolean)
          .join(" ");
    return (
      <Collapse
        key={args.groupId}
        expanded={expanded}
        onExpand={() => toggleSidebarGroup(args.groupId)}
        className={["sidebar-nav-group", args.active ? "is-active" : ""]
          .filter(Boolean)
          .join(" ")}
        header={
          <button
            type="button"
            className={groupTriggerClassName}
            aria-expanded={!isCollapsed && expanded}
            aria-label={args.label}
            title={args.label}
          >
            <FolderIcon expanded={expanded} width={24} />
            <span className="sidebar-group-heading-main">
              {isCollapsed ? (
                <span className="sidebar-link-icon">
                  <SidebarIllustration kind={args.icon} />
                </span>
              ) : null}
              <span className="sidebar-link-label">{args.label}</span>
              {args.status && !expanded
                ? renderStatusBadges(args.status, "sidebar-group-status")
                : null}
            </span>
          </button>
        }
      >
        <div
          className="sidebar-group-children"
          role="group"
          aria-label={args.label}
        >
          {args.groupId === "assistants" ? (
            <div className="assistant-worker-collapse worker-collapse">
              {assistantNavAgents.length > 0 ? (
                assistantNavAgents.map((agent) => renderAssistantAgent(agent))
              ) : (
                <div className="status-line">暂无智能体</div>
              )}
            </div>
          ) : (
            args.children.map((item) => renderSidebarChildLink(item))
          )}
        </div>
      </Collapse>
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
        className={() =>
          getSidebarLinkClassName(item.to, "sidebar-tool-menu-item")
        }
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
          isCollapsed
            ? "is-from-collapsed-sidebar"
            : "is-from-expanded-sidebar",
        ]
          .filter(Boolean)
          .join(" ")}
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
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantExportChat(chat)}
        >
          <span aria-hidden="true">↓</span>
          <span>导出</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantRenameChat(chat)}
        >
          <span aria-hidden="true">✎</span>
          <span>重命名</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantArchiveChat(chat)}
        >
          <span aria-hidden="true">□</span>
          <span>归档</span>
        </button>
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
                ]
                  .filter(Boolean)
                  .join(" ")}
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
                fixedToolItems.some((item) => isRouteActive(item.to))
                  ? "sidebar-link-active"
                  : "",
                toolMenuOpen ? "is-open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              ref={toolMenuTriggerRef}
              onClick={handleToolMenuTriggerClick}
              aria-label="打开设置"
              aria-haspopup="menu"
              aria-expanded={toolMenuOpen}
              title="设置"
            >
              <span className="sidebar-link-icon">
                <SidebarIllustration kind="control" />
              </span>
              <span className="sidebar-link-label">设置</span>
              <span className="sidebar-link-label-collapsed" aria-hidden="true">
                {getCollapsedSidebarLabel("设置")}
              </span>
            </button>
          </div>
          {renderToolMenu()}
          {renderAssistantChatMenu()}
        </div>
      </div>
    </aside>
  );
}

const FolderIcon: React.FC<
  React.SVGProps<SVGSVGElement> & { expanded?: boolean }
> = (props) => {
  const { expanded, ...restProps } = props;
  return expanded ? (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="currentColor"
      {...restProps}
    >
      <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z" />
    </svg>
  ) : (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="currentColor"
      {...restProps}
    >
      <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z" />
    </svg>
  );
};
