import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
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
  CustomSidebarItemInput,
  CustomSidebarItemResult,
  DesktopSsoStatus,
} from "../../../shared/contracts";
import {
  createCustomSidebarNavOrderKey,
  type SidebarNavOrderItemKey,
} from "./sidebarNavOrder";
import { AgentIcon } from "./AgentIcon";
import { Collapse } from "../../components/Collapse";
import { Tooltip } from "../../components/Tooltip";
import { Popover } from "../../components/Popover";
import { useI18n } from "../../i18n/useI18n";
import {
  getAssistantNavAgentNonNegativeInteger,
  getAssistantNavAgentRecentChats,
} from "../../assistantNavigation";
import { getActivePluginSurfaceWebviewRef } from "../../services/pluginSurfaceWebviewRefs";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../../../shared/service-webview-bridge";

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

const taskBoardNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "kanban",
  to: "/kanban",
  icon: "futures",
};

const assistantGroupNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "group:assistants",
  to: "",
  icon: "assistant",
  entryType: "assistants",
};

const websitesGroupNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "group:websites",
  to: "",
  icon: "website",
  entryType: "websites",
};

const fixedToolRowsBase: Array<
  Array<
    Omit<SidebarToolItem, "label"> & {
      labelKey:
        | "nav.agents"
        | "nav.schedules"
        | "nav.memory"
        | "nav.controlCenter"
        | "nav.market"
        | "nav.settings"
        | "nav.help";
    }
  >
> = [
  [
    {
      orderKey: "agents",
      to: "/agents",
      labelKey: "nav.agents",
      icon: "agent",
    },
    {
      orderKey: "schedules",
      to: "/schedules",
      labelKey: "nav.schedules",
      icon: "schedule",
    },
    {
      orderKey: "memory",
      to: "/memory",
      labelKey: "nav.memory",
      icon: "memory",
    },
  ],
  [
    {
      orderKey: "control-center",
      to: "/control-center",
      labelKey: "nav.controlCenter",
      icon: "control",
    },
    {
      orderKey: "market",
      to: "/market",
      labelKey: "nav.market",
      icon: "market",
    },
    {
      orderKey: "settings",
      to: "/settings",
      labelKey: "nav.settings",
      icon: "settings",
    },
  ],
  [{ orderKey: "help", to: "/help", labelKey: "nav.help", icon: "help" }],
];

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
  const firstChatId =
    getAssistantNavAgentRecentChats(agent)[0]?.chatId ||
    agent.latestChatId ||
    "";
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
      (total, item) =>
        total + getAssistantNavAgentNonNegativeInteger(item.unreadCount),
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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 -960 960 960"
        fill="currentColor"
        width="16px"
      >
        <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm200-80h360v-560H400v560Z" />
      </svg>
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
  assistantNavAgentsLoaded?: boolean;
  copilotAgentOptions?: AssistantNavAgentItem[];
  desktopSsoStatus?: DesktopSsoStatus | null;
  desktopSsoBusy?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onDesktopSsoLogin?: () => void;
  onDesktopSsoLogout?: () => void;
  onRefreshAssistantNavAgents?: () => Promise<void> | void;
  onRefreshCopilotAgentOptions?: () => Promise<void> | void;
  onCreateCustomSidebarItem?: (
    input: CustomSidebarItemInput,
  ) => Promise<CustomSidebarItemResult>;
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
  assistantNavAgentsLoaded = true,
  copilotAgentOptions = [],
  desktopSsoStatus = null,
  desktopSsoBusy = false,
  onOpenAssistantDock,
  onCloseAssistantDock,
  onDesktopSsoLogin,
  onDesktopSsoLogout,
  onRefreshAssistantNavAgents,
  onRefreshCopilotAgentOptions,
  onCreateCustomSidebarItem,
  onRequestNavigate,
  onNavigateItem,
  onToggleCollapsed,
}: AppSidebarProps) {
  const { t } = useI18n();
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(
    readInitialSidebarGroupState,
  );
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [expandedAssistantAgentKey, setExpandedAssistantAgentKey] =
    useState("");
  const [creatingCoderProject, setCreatingCoderProject] = useState(false);
  const [websiteDialogOpen, setWebsiteDialogOpen] = useState(false);
  const [websiteLabel, setWebsiteLabel] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [websiteAgentKey, setWebsiteAgentKey] = useState("");
  const [websiteCreatePending, setWebsiteCreatePending] = useState(false);
  const [websiteCreateError, setWebsiteCreateError] = useState("");
  const [assistantChatMenu, setAssistantChatMenu] =
    useState<AssistantChatMenuState | null>(null);
  const [agentMenu, setAgentMenu] = useState<{
    agent: AssistantNavAgentItem;
    x: number;
    y: number;
  } | null>(null);
  const lastAutoExpandedAssistantAgentKeyRef = useRef("");
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assistantChatMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const currentRouteAgentInfo = readAgentRouteInfo(currentRoute);
  const pendingRouteAgentInfo = pendingPath
    ? readAgentRouteInfo(pendingPath)
    : { agentKey: "", chatId: "" };
  const currentAgentKey = currentRouteAgentInfo.agentKey;
  const currentChatId = currentRouteAgentInfo.chatId;
  const pendingAgentKey = pendingRouteAgentInfo.agentKey;
  const shouldRenderDesktopSso = desktopSsoStatus?.configured === true;
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

  const navItems: SidebarPrimaryEntry[] = [
    { ...taskBoardNavItemBase, label: t("nav.taskBoard") },
    { ...assistantGroupNavItemBase, label: t("nav.assistants") },
    { ...websitesGroupNavItemBase, label: t("nav.embeddedWebsites") },
  ];
  const fixedToolRows: SidebarToolItem[][] = fixedToolRowsBase.map((row) =>
    row.map(({ labelKey, ...item }) => ({ ...item, label: t(labelKey) })),
  );
  const fixedToolItems = fixedToolRows.flat();
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
    if (!websiteDialogOpen) {
      return undefined;
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !websiteCreatePending) {
        setWebsiteDialogOpen(false);
      }
    }
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [websiteCreatePending, websiteDialogOpen]);

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
    if (!agentMenu) {
      return undefined;
    }
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        agentMenuRef.current?.contains(target)
      ) {
        return;
      }
      setAgentMenu(null);
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAgentMenu(null);
      }
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [agentMenu]);

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

  async function handleCreateCoderProject(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (creatingCoderProject) {
      return;
    }
    setCreatingCoderProject(true);
    try {
      const selection =
        await window.electronAPI.desktopDialog.selectDirectory();
      if (!selection.ok || !selection.path) {
        return;
      }
      const result = await window.electronAPI.assistant.createCoderProject({
        workspaceDir: selection.path,
      });
      if (!result.ok) {
        console.warn(
          "[assistant] failed to create CODER project",
          result.message,
        );
        return;
      }
      await onRefreshAssistantNavAgents?.();
      if (result.agentKey) {
        setExpandedAssistantAgentKey(result.agentKey);
        requestNavigate(createAgentRoute(result.agentKey));
      }
    } catch (error) {
      console.warn("[assistant] failed to create CODER project", error);
    } finally {
      setCreatingCoderProject(false);
    }
  }

  function openWebsiteDialog(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setWebsiteLabel("");
    setWebsiteUrl("");
    setWebsiteAgentKey("");
    setWebsiteCreateError("");
    setWebsiteDialogOpen(true);
    void onRefreshCopilotAgentOptions?.();
  }

  async function handleCreateWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (websiteCreatePending || !onCreateCustomSidebarItem) {
      return;
    }
    setWebsiteCreatePending(true);
    setWebsiteCreateError("");
    try {
      const result = await onCreateCustomSidebarItem({
        label: websiteLabel,
        url: websiteUrl,
        agentKey: websiteAgentKey,
      });
      if (!result.ok || !result.item) {
        setWebsiteCreateError(result.message || "添加内嵌网站失败。");
        return;
      }
      setWebsiteDialogOpen(false);
      setWebsiteLabel("");
      setWebsiteUrl("");
      setWebsiteAgentKey("");
      setSidebarGroupState((current) => ({ ...current, websites: true }));
      requestNavigate(`/custom-sidebar/${result.item.id}`);
    } catch (error) {
      setWebsiteCreateError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWebsiteCreatePending(false);
    }
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
      y: Math.min(window.innerHeight - 172, Math.max(8, rect.bottom + 4)),
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

  async function handleAssistantDeleteChat(chat: AssistantNavChatItem) {
    setAssistantChatMenu(null);
    const chatLabel = chat.chatName?.trim() || chat.chatId;
    if (!window.confirm(`确定要删除会话“${chatLabel}”吗？`)) {
      return;
    }
    await window.electronAPI.assistant.deleteChat(chat.chatId);
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
            <span className="chat-awaiting-status">
              {t("taskBoard.run.awaitingApproval")}
            </span>
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
            className="assistant-worker-chat-menu-button"
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
    const recentChats = getAssistantNavAgentRecentChats(agent).slice(0, 5);
    const chatCount = Math.max(
      0,
      getAssistantNavAgentNonNegativeInteger(agent.chatCount),
      recentChats.length,
    );
    const unreadCount = Math.max(
      0,
      getAssistantNavAgentNonNegativeInteger(agent.unreadCount),
      getAssistantNavAgentNonNegativeInteger(agent.unreadChatCount),
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
                  size={selected ? 20 : 32}
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
                        <Tooltip content="全部已读">
                          <button
                            type="button"
                            className="assistant-worker-icon-button"
                            aria-label={`全部已读 ${agent.displayName}`}
                            onClick={(event) =>
                              void handleAssistantMarkAllRead(event, agent)
                            }
                          >
                            <span
                              className="assistant-material-icon is-done-all"
                              aria-hidden="true"
                            />
                          </button>
                        </Tooltip>
                      ) : null}
                      <Tooltip content="新建对话">
                        <button
                          type="button"
                          className="assistant-worker-icon-button"
                          aria-label={`新建对话 ${agent.displayName}`}
                          onClick={(event) =>
                            handleAssistantNewChat(event, agent)
                          }
                        >
                          <EditSquareIcon width={16} />
                        </button>
                      </Tooltip>
                      <Tooltip content="更多操作">
                        <button
                          type="button"
                          className="assistant-worker-icon-button"
                          aria-label={`更多操作 ${agent.displayName}`}
                          onClick={(event) =>
                            handleOpenAgentMenu(event, agent)
                          }
                        >
                          <span
                            className="assistant-material-icon is-more"
                            aria-hidden="true"
                          />
                        </button>
                      </Tooltip>
                    </span>
                  </span>
                  <span className="worker-panel-preview">
                    <span className="assistant-worker-preview">
                      {latestPreview}
                    </span>
                    {agent.hasPendingAwaiting ? (
                      <span className="chat-awaiting-status">
                        {t("taskBoard.run.awaitingApproval")}
                      </span>
                    ) : null}
                    <span className="worker-panel-time-label">
                      {formatAssistantChatTime(
                        getAssistantNavAgentRecentChats(agent)[0]?.updatedAt,
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
                const webviewRef = getActivePluginSurfaceWebviewRef()?.current;
                if (webviewRef) {
                  webviewRef.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
                    action: "openChatHistory",
                    data: {
                      agentKey: agent.agentKey,
                    },
                  });
                } else {
                  requestNavigate(createAgentHistoryRoute(agent.agentKey));
                }
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
    const groupChildrenClassName = [
      "sidebar-group-children",
      args.groupId === "websites" ? "sidebar-website-children" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return isCollapsed ? (
      <Popover
        placement="right-start"
        content={
          <div
            className={`${groupChildrenClassName} worker-popover-content`}
            role="group"
            aria-label={args.label}
          >
            {args.groupId === "assistants" ? (
              <div className="assistant-worker-collapse worker-collapse">
                {assistantNavAgents.length > 0 ? (
                  assistantNavAgents.map((agent) => renderAssistantAgent(agent))
                ) : assistantNavAgentsLoaded ? (
                  <div className="status-line">
                    {t("sidebar.assistants.empty")}
                  </div>
                ) : null}
              </div>
            ) : (
              args.children.map((item) => renderSidebarChildLink(item))
            )}
          </div>
        }
      >
        <button className={groupTriggerClassName}>
          <span className="sidebar-group-heading-main">
            <span className="sidebar-link-icon">
              <SidebarIllustration kind={args.icon} />
            </span>
            <span className="sidebar-link-label">{args.label}</span>
            {args.status && !expanded
              ? renderStatusBadges(args.status, "sidebar-group-status")
              : null}
          </span>
        </button>
      </Popover>
    ) : (
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
            <span className="sidebar-group-heading-main">
              <span className="sidebar-link-label">{args.label}</span>
              <ArrowIcon
                className="sidebar-group-heading-arrow"
                expanded={expanded}
                width={18}
              />
              {args.status && !expanded
                ? renderStatusBadges(args.status, "sidebar-group-status")
                : null}
            </span>
            {args.groupId === "assistants" ? (
              <Tooltip content="新增项目">
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-assistant-project-button"
                  aria-label="新增项目"
                  title="新增项目"
                  disabled={creatingCoderProject}
                  onClick={handleCreateCoderProject}
                >
                  {creatingCoderProject ? (
                    <span
                      className="assistant-material-icon is-loading"
                      aria-hidden="true"
                    />
                  ) : (
                    <AddIcon width={16} />
                  )}
                </button>
              </Tooltip>
            ) : null}
            {args.groupId === "websites" ? (
              <Tooltip content="新增内嵌网站">
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-website-add-button"
                  aria-label="新增内嵌网站"
                  title="新增内嵌网站"
                  onClick={openWebsiteDialog}
                >
                  <AddIcon width={16} />
                </button>
              </Tooltip>
            ) : null}
          </button>
        }
      >
        <div
          className={groupChildrenClassName}
          role="group"
          aria-label={args.label}
        >
          {args.groupId === "assistants" ? (
            <div className="assistant-worker-collapse worker-collapse">
              {assistantNavAgents.length > 0 ? (
                assistantNavAgents.map((agent) => renderAssistantAgent(agent))
              ) : assistantNavAgentsLoaded ? (
                <div className="status-line">
                  {t("sidebar.assistants.empty")}
                </div>
              ) : null}
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
    return (
      <div
        className={[
          "sidebar-tool-menu",
          isCollapsed
            ? "is-from-collapsed-sidebar"
            : "is-from-expanded-sidebar",
        ]
          .filter(Boolean)
          .join(" ")}
        role="menu"
        aria-label={t("nav.sidebar.fixedTools")}
      >
        {fixedToolItems.map((item) => renderToolLink(item))}
      </div>
    );
  }

  function handleDesktopSsoEntryClick() {
    if (!desktopSsoStatus) {
      return;
    }
    if (desktopSsoStatus.authenticated) {
      const confirmed = window.confirm(t("sidebar.sso.confirmSignOut"));
      if (!confirmed) {
        return;
      }
      onDesktopSsoLogout?.();
      return;
    }
    onDesktopSsoLogin?.();
  }

  function renderDesktopSsoEntry() {
    if (!shouldRenderDesktopSso || !desktopSsoStatus) {
      return null;
    }

    const desktopSsoUserLabel = desktopSsoStatus.authenticated
      ? desktopSsoStatus.user?.name ||
        desktopSsoStatus.user?.email ||
        desktopSsoStatus.user?.sub ||
        t("sidebar.sso.signedIn")
      : desktopSsoStatus.pending
        ? t("sidebar.sso.signingIn")
        : t("sidebar.sso.signedOut");
    const desktopSsoActionLabel = desktopSsoStatus.authenticated
      ? t("sidebar.sso.signOut")
      : desktopSsoStatus.pending
        ? t("sidebar.sso.reopen")
        : t("sidebar.sso.signIn");
    const desktopSsoClassName = [
      "sidebar-sso-entry",
      desktopSsoStatus.authenticated ? "is-authenticated" : "",
      desktopSsoStatus.pending ? "is-pending" : "",
      desktopSsoStatus.error ? "is-error" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        type="button"
        className={desktopSsoClassName}
        onClick={handleDesktopSsoEntryClick}
        disabled={desktopSsoBusy}
        aria-label={desktopSsoActionLabel}
        title={desktopSsoActionLabel}
      >
        <span className="sidebar-sso-dot" aria-hidden="true" />
        <span className="sidebar-sso-copy">
          <span className="sidebar-sso-title">{desktopSsoUserLabel}</span>
        </span>
        <span className="sidebar-sso-action" aria-hidden="true">
          {desktopSsoBusy ? t("sidebar.sso.busy") : desktopSsoActionLabel}
        </span>
      </button>
    );
  }

  function handleOpenAgentMenu(
    event: MouseEvent<HTMLButtonElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setAgentMenu({
      agent,
      x: Math.min(window.innerWidth - 180, Math.max(8, rect.right - 170)),
      y: Math.min(window.innerHeight - 140, Math.max(8, rect.bottom + 4)),
    });
  }

  function getOpenWorkspaceDisabledReason(agent: AssistantNavAgentItem) {
    const workspaceDir = agent.workspaceDir?.trim() ?? "";
    if (!workspaceDir) {
      return "工作目录不可用";
    }
    if (workspaceDir === "@chat") {
      return "当前智能体没有本地工作目录";
    }
    if (agent.workspaceDirExists === false) {
      return "工作目录不存在";
    }
    return "";
  }

  async function handleOpenWorkspace(agent: AssistantNavAgentItem) {
    const disabledReason = getOpenWorkspaceDisabledReason(agent);
    if (disabledReason) {
      return;
    }
    setAgentMenu(null);
    if (agent.workspaceDir) {
      await window.electronAPI.desktopShell.openPath(agent.workspaceDir);
    }
  }

  async function handleRenameAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    const nextName = window.prompt("修改名称", agent.displayName);
    if (!nextName?.trim()) {
      return;
    }
    try {
      await window.electronAPI.desktopActions.call({
        action: "desktop.agents.updateAgent",
        args: {
          key: agent.agentKey,
          definition: { name: nextName.trim() },
        },
      });
      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      console.warn("[assistant] failed to rename agent", error);
    }
  }

  function handleEditAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    const webviewRef = getActivePluginSurfaceWebviewRef()?.current;
    if (webviewRef) {
      webviewRef.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
        action: "navigate",
        data: {
          path: `/agents/${encodeURIComponent(agent.agentKey)}`,
        },
      });
    } else {
      requestNavigate("/agents");
    }
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
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantDeleteChat(chat)}
        >
          <span aria-hidden="true">×</span>
          <span>删除</span>
        </button>
      </div>,
      document.body,
    );
  }

  function renderAgentMenu() {
    if (!agentMenu || typeof document === "undefined") {
      return null;
    }
    const agent = agentMenu.agent;
    const isCoder = agent.mode === "CODER";
    const openWorkspaceDisabledReason = getOpenWorkspaceDisabledReason(agent);
    return createPortal(
      <div
        ref={agentMenuRef}
        className="assistant-chat-actions-menu"
        style={{ left: agentMenu.x, top: agentMenu.y }}
        role="menu"
        aria-label="智能体操作"
      >
        <button
          type="button"
          role="menuitem"
          disabled={Boolean(openWorkspaceDisabledReason)}
          aria-disabled={Boolean(openWorkspaceDisabledReason)}
          title={openWorkspaceDisabledReason || agent.workspaceDir}
          onClick={() => void handleOpenWorkspace(agent)}
        >
          <span>打开工作目录</span>
        </button>
        {isCoder ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleRenameAgent(agent)}
          >
            <span>修改名称</span>
          </button>
        ) : null}
        <button
          type="button"
          role="menuitem"
          onClick={() => handleEditAgent(agent)}
        >
          <span>编辑智能体</span>
        </button>
      </div>,
      document.body,
    );
  }

  function renderWebsiteDialog() {
    if (!websiteDialogOpen || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        className="sidebar-website-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!websiteCreatePending) {
            setWebsiteDialogOpen(false);
          }
        }}
      >
        <form
          className="sidebar-website-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-website-dialog-title"
          onSubmit={(event) => void handleCreateWebsite(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-website-dialog-head">
            <strong id="sidebar-website-dialog-title">新增内嵌网站</strong>
            <button
              type="button"
              className="sidebar-website-dialog-close"
              aria-label="关闭"
              disabled={websiteCreatePending}
              onClick={() => setWebsiteDialogOpen(false)}
            >
              ×
            </button>
          </div>
          <label className="sidebar-website-dialog-field">
            <span>网站名</span>
            <input
              value={websiteLabel}
              onChange={(event) => setWebsiteLabel(event.target.value)}
              placeholder="例如：知识库"
              maxLength={24}
              autoFocus
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>网页地址</span>
            <input
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              placeholder="example.com"
              required
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>侧边智能助手</span>
            <select
              value={websiteAgentKey}
              onChange={(event) => setWebsiteAgentKey(event.target.value)}
              disabled={websiteCreatePending}
            >
              <option value="">默认助手</option>
              {copilotAgentOptions.map((agent) => (
                <option value={agent.agentKey} key={agent.agentKey}>
                  {agent.displayName}
                  {agent.role ? ` · ${agent.role}` : ""}
                </option>
              ))}
            </select>
          </label>
          {websiteCreateError ? (
            <div className="sidebar-website-dialog-error" role="alert">
              {websiteCreateError}
            </div>
          ) : null}
          <div className="sidebar-website-dialog-actions">
            <button
              type="button"
              className="sidebar-website-secondary-button"
              disabled={websiteCreatePending}
              onClick={() => setWebsiteDialogOpen(false)}
            >
              取消
            </button>
            <button
              type="submit"
              className="sidebar-website-primary-button"
              disabled={websiteCreatePending}
            >
              {websiteCreatePending ? "添加中..." : "添加"}
            </button>
          </div>
        </form>
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
            <Popover
              placement="top-start"
              content={renderToolMenu()}
              open={toolMenuOpen}
              onOpenChange={setToolMenuOpen}
            >
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
                aria-label={t("nav.sidebar.openSettings")}
                aria-haspopup="menu"
                aria-expanded={toolMenuOpen}
                title={t("nav.settings")}
              >
                <span className="sidebar-link-icon">
                  <SidebarIllustration kind="control" />
                </span>
                <span className="sidebar-link-label">{t("nav.settings")}</span>
                <span
                  className="sidebar-link-label-collapsed"
                  aria-hidden="true"
                >
                  {getCollapsedSidebarLabel(t("nav.settings"))}
                </span>
              </button>
            </Popover>
          </div>
          {renderDesktopSsoEntry()}
          {renderAssistantChatMenu()}
          {renderAgentMenu()}
          {renderWebsiteDialog()}
        </div>
      </div>
    </aside>
  );
}

const ArrowIcon: React.FC<
  React.SVGProps<SVGSVGElement> & { expanded?: boolean }
> = (props) => {
  const { expanded, style, ...restProps } = props;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="currentColor"
      {...restProps}
      style={{
        transition: "transform 0.3s",
        transform: `rotate(${expanded ? 90 : 0}deg)`,
        ...style,
      }}
    >
      <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" />
    </svg>
  );
};

const EditSquareIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="currentColor"
      {...props}
    >
      <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h357l-80 80H200v560h560v-278l80-80v358q0 33-23.5 56.5T760-120H200Zm280-360ZM360-360v-170l367-367q12-12 27-18t30-6q16 0 30.5 6t26.5 18l56 57q11 12 17 26.5t6 29.5q0 15-5.5 29.5T897-728L530-360H360Zm481-424-56-56 56 56ZM440-440h56l232-232-28-28-29-28-231 231v57Zm260-260-29-28 29 28 28 28-28-28Z" />
    </svg>
  );
};

const AddIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      height="24px"
      viewBox="0 -960 960 960"
      width="24px"
      fill="currentColor"
      {...props}
    >
      <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z" />
    </svg>
  );
};
