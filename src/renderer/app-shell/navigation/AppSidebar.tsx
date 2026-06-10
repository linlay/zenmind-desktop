import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { LeftOutlined, RightOutlined, SortAscendingOutlined } from "@ant-design/icons";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import {
  SidebarIllustration,
  type SidebarIllustrationKind,
} from "../../components/BrandMark";
import type {
  AssistantCreateCoderProjectRequest,
  AssistantNavAgentItem,
  AssistantNavChatItem,
  CustomSidebarItem,
  CustomSidebarItemInput,
  CustomSidebarItemResult,
  DesktopSsoStatus,
  ServiceState,
} from "../../../shared/contracts";
import {
  createCustomSidebarNavOrderKey,
  sortSidebarNavItems,
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
import { PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/generated/brand";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../../../shared/service-webview-bridge";
import type { SettingsSectionId } from "../../../shared/settings-sections";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";

type SidebarNavItem = {
  orderKey: SidebarNavOrderItemKey;
  to: string;
  label: string;
  collapsedLabel?: string;
  icon: SidebarIllustrationKind;
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

type AssistantNavSortMode = "byName" | "byTime";

type AssistantChatMenuState = {
  chat: AssistantNavChatItem;
  x: number;
  y: number;
};

type AssistantChatRenameDialogState = {
  chat: AssistantNavChatItem;
  value: string;
  pending: boolean;
  error: string;
};

type AgentSelectionOptions = {
  preferNewChat?: boolean;
};

type NavigateOptions = {
  retriggerAgentRoute?: boolean;
};

type AgentDialogState = {
  kind: "rename" | "delete";
  agent: AssistantNavAgentItem;
  value: string;
  pending: boolean;
  error: string;
};

type CoderAcpProxyOption = {
  serviceId: string;
  acpProxyId: string;
  label: string;
};

type RunningCoderAcpProxyOption = CoderAcpProxyOption & {
  statusLabel: string;
};

type CoderProjectProgrammingMode = "builtin" | "acp";

type CoderAcpProjectDialogState = {
  name: string;
  workspaceDir: string;
  programmingMode: CoderProjectProgrammingMode;
  options: RunningCoderAcpProxyOption[];
  selectedAcpProxyId: string;
  pending: boolean;
  error: string;
};

const SIDEBAR_GROUP_STATE_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-groups`;
const SIDEBAR_ASSISTANT_SORT_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-assistant-sort`;

const defaultSidebarGroupState: SidebarGroupState = {
  assistants: true,
  websites: true,
};

const CODER_ACP_PROXY_SERVICE_OPTIONS: CoderAcpProxyOption[] = [
  {
    serviceId: "proxy-acp-claudecode",
    acpProxyId: "claude",
    label: "Claude Code ACP Proxy",
  },
  {
    serviceId: "proxy-acp-codex",
    acpProxyId: "codex",
    label: "Codex ACP Proxy",
  },
];

const taskBoardNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "kanban",
  to: "/kanban",
  icon: "futures",
};

const schedulesNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "schedules",
  to: "/automations",
  icon: "schedule",
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
      orderKey: "market",
      to: "/market",
      labelKey: "nav.market",
      icon: "market",
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

function normalizeAssistantNavSortMode(value: unknown): AssistantNavSortMode {
  return value === "byName" || value === "byTime" ? value : "byTime";
}

function readInitialAssistantNavSortMode(): AssistantNavSortMode {
  if (typeof window === "undefined") {
    return "byTime";
  }
  try {
    return normalizeAssistantNavSortMode(
      window.localStorage.getItem(SIDEBAR_ASSISTANT_SORT_STORAGE_KEY),
    );
  } catch {
    return "byTime";
  }
}

function getRunningCoderAcpProxyOptions(
  services: ServiceState[],
): RunningCoderAcpProxyOption[] {
  const servicesById = new Map(services.map((service) => [service.id, service]));
  return CODER_ACP_PROXY_SERVICE_OPTIONS.flatMap((option) => {
    const service = servicesById.get(option.serviceId);
    if (!service || service.status !== "running") {
      return [];
    }
    return [
      {
        ...option,
        statusLabel: service.statusLabel || "运行中",
      },
    ];
  });
}

function getWorkspaceNameFromPath(workspaceDir: string) {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
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
    return { agentKey: "", chatId: "", historyRequested: false };
  }
  try {
    const url = new URL(normalized, "http://agent-webclient.local");
    const match = /^\/agent\/([^/?#]+)/u.exec(url.pathname);
    return {
      agentKey: match?.[1] ? decodeURIComponent(match[1]) : "",
      chatId: url.searchParams.get("chatId")?.trim() ?? "",
      historyRequested: url.searchParams.get("history")?.trim() === "1",
    };
  } catch {
    return { agentKey: "", chatId: "", historyRequested: false };
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
    return { agentKey: "", chatId: "", historyRequested: false };
  }
  try {
    const searchParams = new URLSearchParams(route.slice(queryIndex + 1));
    return {
      agentKey: searchParams.get("agentKey")?.trim() ?? "",
      chatId: searchParams.get("chatId")?.trim() ?? "",
      historyRequested: searchParams.get("history")?.trim() === "1",
    };
  } catch {
    return { agentKey: "", chatId: "", historyRequested: false };
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

function createAgentSelectionRoute(
  agent: AssistantNavAgentItem,
  options: AgentSelectionOptions = {},
) {
  const attentionChat = getAssistantAttentionChat(agent);
  const attentionChatId = attentionChat?.chatId.trim() ?? "";
  if (attentionChatId) {
    return createAgentChatRoute(agent.agentKey, attentionChatId);
  }

  if (!options.preferNewChat) {
    return createAgentDefaultRoute(agent);
  }

  return createAgentNewChatRoute(agent.agentKey);
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

function isAssistantRunningPreview(value: string) {
  const normalized = value.trim();
  return normalized === "思考中" || normalized === "思考中...";
}

function toAssistantSortTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function readAssistantAgentLatestTimestamp(agent: AssistantNavAgentItem) {
  const latestChat = getAssistantNavAgentRecentChats(agent)[0];
  if (latestChat) {
    return toAssistantSortTimestamp(latestChat.updatedAt);
  }
  return agent.latestChatId ? toAssistantSortTimestamp(agent.updatedAt) : 0;
}

function compareAssistantAgentsByTime(
  left: AssistantNavAgentItem,
  right: AssistantNavAgentItem,
) {
  const rightTime = readAssistantAgentLatestTimestamp(right);
  const leftTime = readAssistantAgentLatestTimestamp(left);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  return compareAssistantAgentsByName(left, right);
}

function compareAssistantAgentsByName(
  left: AssistantNavAgentItem,
  right: AssistantNavAgentItem,
) {
  const displayNameComparison = left.displayName.localeCompare(
    right.displayName,
    "zh-CN",
  );
  if (displayNameComparison !== 0) {
    return displayNameComparison;
  }
  return left.agentKey.localeCompare(right.agentKey);
}

function sortAssistantNavAgentsForMode(
  items: AssistantNavAgentItem[],
  sortMode: AssistantNavSortMode,
) {
  const compare =
    sortMode === "byName"
      ? compareAssistantAgentsByName
      : compareAssistantAgentsByTime;
  return [...items].sort(compare);
}

function getAssistantAwaitingStatusKey(
  mode?: AssistantNavChatItem["awaitingMode"],
) {
  switch (mode) {
    case "plan":
      return "sidebar.assistants.awaitingStatus.plan";
    case "question":
      return "sidebar.assistants.awaitingStatus.question";
    case "approval":
      return "sidebar.assistants.awaitingStatus.approval";
    case "form":
      return "sidebar.assistants.awaitingStatus.form";
    default:
      return "taskBoard.run.awaitingApproval";
  }
}

function getAssistantAttentionChat(agent: AssistantNavAgentItem) {
  const recentChats = getAssistantNavAgentRecentChats(agent).slice(0, 5);
  return (
    recentChats.find((chat) => chat.hasPendingAwaiting === true) ||
    recentChats.find((chat) => chat.hasActiveRun === true) ||
    recentChats.find((chat) => chat.isRead === false) ||
    null
  );
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
        className="app-sidebar-collapse-button-icon-chevron"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 -960 960 960"
        width="16px"
        height="16px"
      >
        <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm200-80h360v-560H400v560Z" />
      </svg>
    );
  }

  return (
    <svg
      className="app-sidebar-collapse-button-icon-panel"
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

type SettingsSidebarSection = {
  id: SettingsSectionId;
  label: string;
};

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
  sidebarNavigationCanGoBack?: boolean;
  sidebarNavigationCanGoForward?: boolean;
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
  onSidebarNavigateBack?: () => void;
  onSidebarNavigateForward?: () => void;
  onNavigateItem?: () => void;
  onToggleCollapsed?: () => void;
  isSettingsMode?: boolean;
  settingsSections?: SettingsSidebarSection[];
  activeSettingsSectionId?: SettingsSectionId | null;
  onSelectSettingsSection?: (sectionId: SettingsSectionId) => void;
  onExitSettingsMode?: () => void;
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
  sidebarNavigationCanGoBack = false,
  sidebarNavigationCanGoForward = false,
  onOpenAssistantDock,
  onCloseAssistantDock,
  onDesktopSsoLogin,
  onDesktopSsoLogout,
  onRefreshAssistantNavAgents,
  onRefreshCopilotAgentOptions,
  onCreateCustomSidebarItem,
  onRequestNavigate,
  onSidebarNavigateBack,
  onSidebarNavigateForward,
  onNavigateItem,
  onToggleCollapsed,
  isSettingsMode = false,
  settingsSections = [],
  activeSettingsSectionId = null,
  onSelectSettingsSection,
  onExitSettingsMode,
}: AppSidebarProps) {
  const { t } = useI18n();
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(
    readInitialSidebarGroupState,
  );
  const [assistantNavSortMode, setAssistantNavSortMode] =
    useState<AssistantNavSortMode>(readInitialAssistantNavSortMode);
  const [assistantSortMenuOpen, setAssistantSortMenuOpen] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [expandedAssistantAgentKey, setExpandedAssistantAgentKey] =
    useState("");
  const [creatingCoderProject, setCreatingCoderProject] = useState(false);
  const [coderAcpProjectDialog, setCoderAcpProjectDialog] =
    useState<CoderAcpProjectDialogState | null>(null);
  const [websiteDialogOpen, setWebsiteDialogOpen] = useState(false);
  const [websiteLabel, setWebsiteLabel] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [websiteAgentKey, setWebsiteAgentKey] = useState("");
  const [websiteCreatePending, setWebsiteCreatePending] = useState(false);
  const [websiteCreateError, setWebsiteCreateError] = useState("");
  const [assistantChatMenu, setAssistantChatMenu] =
    useState<AssistantChatMenuState | null>(null);
  const [assistantChatRenameDialog, setAssistantChatRenameDialog] =
    useState<AssistantChatRenameDialogState | null>(null);
  const [agentMenu, setAgentMenu] = useState<{
    agent: AssistantNavAgentItem;
    x: number;
    y: number;
  } | null>(null);
  const [agentDialog, setAgentDialog] = useState<AgentDialogState | null>(null);
  const lastAutoExpandedAssistantAgentKeyRef = useRef("");
  const lastRouteAgentInfoRef = useRef(readAgentRouteInfo(currentRoute));
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assistantChatMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const currentRouteAgentInfo = readAgentRouteInfo(currentRoute);
  const pendingRouteAgentInfo = pendingPath
    ? readAgentRouteInfo(pendingPath)
    : { agentKey: "", chatId: "", historyRequested: false };
  const currentAgentKey = currentRouteAgentInfo.agentKey;
  const currentChatId = currentRouteAgentInfo.chatId;
  const pendingAgentKey = pendingRouteAgentInfo.agentKey;
  const pendingChatId = pendingRouteAgentInfo.chatId;
  const activeSidebarAgentKey = pendingPath ? pendingAgentKey : currentAgentKey;
  const assistantStatusSummary = useMemo(
    () => summarizeAgentStatus(assistantNavAgents),
    [assistantNavAgents],
  );
  const sortedAssistantNavAgents = useMemo(
    () => sortAssistantNavAgentsForMode(assistantNavAgents, assistantNavSortMode),
    [assistantNavAgents, assistantNavSortMode],
  );
  const assistantNavSortLabel =
    assistantNavSortMode === "byName"
      ? t("sidebar.assistants.sortByName")
      : t("sidebar.assistants.sortByTime");

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
      }))
      .sort((left, right) => {
        const leftIndex =
          orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex =
          orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [customSidebarItems, customSidebarNavOrder]);

  const navItems: SidebarPrimaryEntry[] = sortSidebarNavItems(
    [
      {
        ...taskBoardNavItemBase,
        label: t("nav.taskBoard"),
        collapsedLabel: t("nav.taskBoardCollapsed"),
      },
      { ...schedulesNavItemBase, label: t("nav.schedules"), collapsedLabel: t("nav.schedulesCollapsed") },
      {
        ...assistantGroupNavItemBase,
        label: t("nav.assistants"),
        collapsedLabel: t("nav.assistantsCollapsed"),
      },
      {
        ...websitesGroupNavItemBase,
        label: t("nav.embeddedWebsites"),
        collapsedLabel: t("nav.embeddedWebsitesCollapsed"),
      },
    ],
    sidebarNavOrder,
  );
  const fixedToolRows: SidebarToolItem[][] = fixedToolRowsBase.map((row) =>
    row.map(({ labelKey, ...item }) => ({ ...item, label: t(labelKey) })),
  );
  const fixedToolItems = fixedToolRows.flat();
  const settingsToolItem = fixedToolItems.find((item) => item.to === "/settings");
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
    try {
      window.localStorage.setItem(
        SIDEBAR_ASSISTANT_SORT_STORAGE_KEY,
        assistantNavSortMode,
      );
    } catch {
      // Ignore localStorage failures in restricted renderer contexts.
    }
  }, [assistantNavSortMode]);

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
    if (!agentDialog) {
      return undefined;
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !agentDialog.pending) {
        setAgentDialog(null);
      }
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [agentDialog]);

  useEffect(() => {
    if (!assistantChatRenameDialog) {
      return undefined;
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !assistantChatRenameDialog.pending) {
        setAssistantChatRenameDialog(null);
      }
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [assistantChatRenameDialog]);

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
      if (target instanceof Node && agentMenuRef.current?.contains(target)) {
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
    const previousRouteAgentInfo = lastRouteAgentInfoRef.current;
    lastRouteAgentInfoRef.current = currentRouteAgentInfo;
    if (
      previousRouteAgentInfo.historyRequested &&
      !currentRouteAgentInfo.historyRequested &&
      currentAgentKey &&
      currentChatId &&
      previousRouteAgentInfo.agentKey === currentAgentKey &&
      expandedAssistantAgentKey === currentAgentKey &&
      (!pendingPath || pendingRouteAgentInfo.historyRequested)
    ) {
      lastAutoExpandedAssistantAgentKeyRef.current = currentAgentKey;
      setExpandedAssistantAgentKey("");
      return;
    }
  }, [
    currentAgentKey,
    currentChatId,
    currentRouteAgentInfo,
    expandedAssistantAgentKey,
    pendingPath,
    pendingRouteAgentInfo.historyRequested,
  ]);

  useEffect(() => {
    const matched = assistantNavAgents.find(
      (agent) => agent.agentKey === activeSidebarAgentKey,
    );
    if (!matched) {
      lastAutoExpandedAssistantAgentKeyRef.current = "";
      return;
    }
    const activeAgentChanged =
      lastAutoExpandedAssistantAgentKeyRef.current !== matched.agentKey;
    if (activeAgentChanged) {
      lastAutoExpandedAssistantAgentKeyRef.current = matched.agentKey;
      setExpandedAssistantAgentKey(matched.agentKey);
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
  }, [assistantNavAgents, activeSidebarAgentKey, expandedAssistantAgentKey]);

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

  function dispatchAgentRouteActionToActiveWebview(targetPath: string) {
    const { agentKey, chatId, historyRequested } = readAgentRouteInfo(targetPath);
    if (!agentKey) {
      return false;
    }

    const webview = getActivePluginSurfaceWebviewRef()?.current;
    if (!webview) {
      return false;
    }

    if (historyRequested) {
      try {
        webview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
          action: "openChatHistory",
          data: {
            workerKey: `agent:${agentKey}`,
            agentKey,
          },
        });
        return true;
      } catch (error) {
        console.warn("[assistant] failed to open agent history", error);
        return false;
      }
    }

    const eventName = chatId
      ? "agent:load-chat"
      : "agent:start-new-conversation";
    const detail = chatId
      ? {
          chatId,
          focusComposerOnComplete: true,
        }
      : {
          agentKey,
          preserveWorkerContext: true,
          focusComposerOnComplete: true,
        };
    const script = [
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, {`,
      `  detail: ${JSON.stringify(detail)}`,
      "}));",
      "true;",
    ].join("\n");

    void webview.executeJavaScript(script, true).catch((error) => {
      console.warn("[assistant] failed to retrigger agent route", error);
    });
    return true;
  }

  function requestNavigate(targetPath: string, options: NavigateOptions = {}) {
    if (options.retriggerAgentRoute) {
      const targetAgentInfo = readAgentRouteInfo(targetPath);
      if (targetPath === currentRoute || targetAgentInfo.historyRequested) {
        dispatchAgentRouteActionToActiveWebview(targetPath);
      }
    }

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
    if (creatingCoderProject || coderAcpProjectDialog) {
      return;
    }
    setCreatingCoderProject(true);
    try {
      const selection =
        await window.electronAPI.desktopDialog.selectDirectory();
      if (!selection.ok || !selection.path) {
        return;
      }
      let runningAcpProxies: RunningCoderAcpProxyOption[] = [];
      try {
        runningAcpProxies = getRunningCoderAcpProxyOptions(
          await window.electronAPI.services.list(),
        );
      } catch (error) {
        console.warn("[assistant] failed to list CODER ACP proxy services", error);
      }
      setCoderAcpProjectDialog({
        name: getWorkspaceNameFromPath(selection.path),
        workspaceDir: selection.path,
        programmingMode: "builtin",
        options: runningAcpProxies,
        selectedAcpProxyId: runningAcpProxies[0]?.acpProxyId ?? "",
        pending: false,
        error: "",
      });
    } catch (error) {
      console.warn("[assistant] failed to prepare CODER project", error);
    } finally {
      setCreatingCoderProject(false);
    }
  }

  async function handleSubmitCoderAcpProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dialog = coderAcpProjectDialog;
    if (!dialog || dialog.pending) {
      return;
    }
    const name = dialog.name.trim();
    if (!name) {
      setCoderAcpProjectDialog({
        ...dialog,
        error: "请输入项目名称。",
      });
      return;
    }
    const selectedAcpProxy =
      dialog.programmingMode === "acp" && dialog.selectedAcpProxyId
        ? dialog.options.find(
            (option) => option.acpProxyId === dialog.selectedAcpProxyId,
          )
        : null;
    if (dialog.programmingMode === "acp" && !selectedAcpProxy) {
      setCoderAcpProjectDialog({
        ...dialog,
        error: "请选择一个正在运行的 ACP 工具，或切换为内置编程。",
      });
      return;
    }
    setCoderAcpProjectDialog({ ...dialog, pending: true, error: "" });
    try {
      const createInput: AssistantCreateCoderProjectRequest = {
        name,
        workspaceDir: dialog.workspaceDir,
      };
      if (selectedAcpProxy) {
        createInput.acpProxyId = selectedAcpProxy.acpProxyId;
      }
      const result =
        await window.electronAPI.assistant.createCoderProject(createInput);
      if (!result.ok) {
        setCoderAcpProjectDialog({
          ...dialog,
          pending: false,
          error: result.message || "创建 CODER 智能体失败。",
        });
        return;
      }
      setCoderAcpProjectDialog(null);
      await onRefreshAssistantNavAgents?.();
      if (result.agentKey) {
        setExpandedAssistantAgentKey(result.agentKey);
        requestNavigate(createAgentRoute(result.agentKey));
      }
    } catch (error) {
      console.warn("[assistant] failed to create CODER project", error);
      setCoderAcpProjectDialog({
        ...dialog,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
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

  function handleAssistantAgentExpand(
    agent: AssistantNavAgentItem,
    expanded: boolean,
  ) {
    setExpandedAssistantAgentKey(expanded ? agent.agentKey : "");
    if (!expanded) {
      return;
    }
    requestNavigate(
      createAgentSelectionRoute(agent, { preferNewChat: !isCollapsed }),
      {
        retriggerAgentRoute: true,
      },
    );
  }

  function handleAssistantNewChat(
    event: MouseEvent<HTMLElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setExpandedAssistantAgentKey(agent.agentKey);
    requestNavigate(createAgentNewChatRoute(agent.agentKey), {
      retriggerAgentRoute: true,
    });
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
    try {
      const result = await window.electronAPI.assistant.exportChat(chat.chatId);
      if (!result.ok) {
        window.alert(result.message || "导出会话失败。");
        return;
      }
      if (result.filePath) {
        window.alert(`已导出到：\n${result.filePath}`);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "导出会话失败。");
    }
  }

  function handleAssistantRenameChat(chat: AssistantNavChatItem) {
    setAssistantChatMenu(null);
    setAssistantChatRenameDialog({
      chat,
      value: chat.chatName,
      pending: false,
      error: "",
    });
  }

  async function handleConfirmRenameChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assistantChatRenameDialog || assistantChatRenameDialog.pending) {
      return;
    }
    const nextName = assistantChatRenameDialog.value.trim();
    if (!nextName) {
      setAssistantChatRenameDialog((current) =>
        current ? { ...current, error: "请输入会话名称。" } : current,
      );
      return;
    }
    setAssistantChatRenameDialog((current) =>
      current ? { ...current, pending: true, error: "" } : current,
    );
    try {
      const result = await window.electronAPI.assistant.renameChat(
        assistantChatRenameDialog.chat.chatId,
        nextName,
      );
      if (!result.ok) {
        throw new Error(result.message || "重命名会话失败。");
      }
      setAssistantChatRenameDialog(null);
      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      setAssistantChatRenameDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: error instanceof Error ? error.message : "重命名会话失败。",
            }
          : current,
      );
    }
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

  function getActiveSidebarAgentKey() {
    return activeSidebarAgentKey;
  }

  function getActiveSidebarChatId(agentKey: string) {
    const activeAgentKey = getActiveSidebarAgentKey();
    if (activeAgentKey !== agentKey) {
      return "";
    }
    const routeChatId = pendingPath ? pendingChatId : currentChatId;
    if (routeChatId) {
      return routeChatId;
    }
    const agent = assistantNavAgents.find((item) => item.agentKey === agentKey);
    return agent?.latestChatId || getAssistantNavAgentRecentChats(agent)[0]?.chatId || "";
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

  function renderAssistantSortMenu() {
    const options: Array<{ mode: AssistantNavSortMode; label: string }> = [
      { mode: "byTime", label: t("sidebar.assistants.sortByTime") },
      { mode: "byName", label: t("sidebar.assistants.sortByName") },
    ];
    return (
      <div
        className="sidebar-assistant-sort-menu"
        role="menu"
        aria-label={t("sidebar.assistants.sortMenu")}
      >
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={[
              "sidebar-assistant-sort-item",
              assistantNavSortMode === option.mode ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="menuitemradio"
            aria-checked={assistantNavSortMode === option.mode}
            onClick={() => {
              setAssistantNavSortMode(option.mode);
              setAssistantSortMenuOpen(false);
            }}
          >
            <span>{option.label}</span>
            {assistantNavSortMode === option.mode ? (
              <span
                className="sidebar-assistant-sort-check"
                aria-hidden="true"
              />
            ) : null}
          </button>
        ))}
      </div>
    );
  }

  function renderAssistantSortButton() {
    return (
      <Popover
        open={assistantSortMenuOpen}
        onOpenChange={setAssistantSortMenuOpen}
        placement="bottom-end"
        content={renderAssistantSortMenu()}
      >
        <button
          type="button"
          className="assistant-worker-icon-button sidebar-assistant-sort-button"
          aria-label={t("sidebar.assistants.sort")}
          title={assistantNavSortLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <SortAscendingOutlined aria-hidden="true" />
        </button>
      </Popover>
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
    const visibleLabel =
      isCollapsed && item.collapsedLabel ? item.collapsedLabel : item.label;
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
          <SidebarIllustration kind={item.icon} />
        </span>
        <span className="sidebar-link-label">{visibleLabel}</span>
      </NavLink>
    );
  }

  function renderSidebarChildLink(
    item: SidebarNavItem & { status?: SidebarStatusSummary },
  ) {
    const showIcon = !item.orderKey.startsWith("custom:");
    const extraClassName = showIcon
      ? "sidebar-child-link"
      : "sidebar-child-link sidebar-custom-child-link";
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, extraClassName)}
      >
        {showIcon ? (
          <span className="sidebar-link-icon">
            <SidebarIllustration kind={item.icon} />
          </span>
        ) : null}
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
    const action = chat.hasPendingAwaiting
      ? "awaiting"
      : chat.hasActiveRun
      ? "loading"
      : "time";
    const previewText =
      chat.hasActiveRun && isAssistantRunningPreview(chat.lastRunContent)
        ? chat.chatName || "暂无预览"
        : chat.lastRunContent || chat.chatName || "暂无预览";
    return (
      <button
        type="button"
        key={chat.chatId}
        className={[
          "assistant-worker-chat-item",
          isActive ? "is-active" : "",
          !chat.isRead ? "is-unread" : "",
          chat.hasPendingAwaiting ? "has-awaiting" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={isActive ? "page" : undefined}
        onClick={() => handleAssistantOpenChat(chat)}
      >
        <span className="worker-chat-item-head">
          <span
            className={[
              "assistant-worker-unread-dot",
              "chat-unread-dot",
              !chat.isRead ? "is-unread" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={!chat.isRead ? "未读" : undefined}
            aria-hidden={chat.isRead ? "true" : undefined}
          />
          <span className="worker-chat-name">{previewText}</span>
          {chat.hasPendingAwaiting ? (
            <span className="chat-awaiting-status">
              {t(getAssistantAwaitingStatusKey(chat.awaitingMode))}
            </span>
          ) : null}
          <span className="assistant-worker-chat-action" data-action={action}>
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
    const selected = getActiveSidebarAgentKey() === agent.agentKey;
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
    const awaitingChat = recentChats.find(
      (chat) => chat.hasPendingAwaiting === true,
    );
    const activeRunChat = recentChats.find(
      (chat) => chat.hasActiveRun === true,
    );
    const previewChat = awaitingChat || activeRunChat || recentChats[0] || null;
    const previewText = previewChat
      ? previewChat.hasActiveRun &&
        isAssistantRunningPreview(previewChat.lastRunContent)
        ? previewChat.chatName || "暂无预览"
        : previewChat.lastRunContent || previewChat.chatName || "暂无预览"
      : agent.latestPreview || (chatCount > 0 ? "" : "暂无会话");
    const previewStatus =
      awaitingChat || agent.hasPendingAwaiting
        ? "awaiting"
        : activeRunChat
          ? "running"
          : "";
    const activeChatId = getActiveSidebarChatId(agent.agentKey);
    return (
      <Collapse
        key={agent.agentKey}
        className="assistant-worker-collapse-item"
        expanded={expanded}
        onExpand={(val) => handleAssistantAgentExpand(agent, val)}
        header={
          <div className="assistant-worker-header">
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
                      {agent.mode !== "CODER" && (
                        <span className="worker-panel-role">
                          {agent.role || "--"}
                        </span>
                      )}
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
                          onClick={(event) => handleOpenAgentMenu(event, agent)}
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
                      {previewText}
                    </span>
                    {previewStatus === "awaiting" ? (
                      <span className="chat-awaiting-status">
                        {t(
                          getAssistantAwaitingStatusKey(
                            awaitingChat?.awaitingMode,
                          ),
                        )}
                      </span>
                    ) : null}
                    {previewStatus ? (
                      <span
                        className="assistant-material-icon is-loading sidebar-assistant-preview-loading"
                        aria-label={
                          previewStatus === "awaiting" ? "等待中" : "运行中"
                        }
                      />
                    ) : null}
                    {!previewStatus && previewChat ? (
                      <span className="worker-panel-time-label">
                        {formatAssistantChatTime(previewChat.updatedAt)}
                      </span>
                    ) : null}
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
                requestNavigate(createAgentHistoryRoute(agent.agentKey), {
                  retriggerAgentRoute: true,
                });
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
    collapsedLabel?: string;
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
    const visibleLabel =
      isCollapsed && args.collapsedLabel ? args.collapsedLabel : args.label;
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
                <div className="sidebar-assistant-popover-tools">
                  <span className="sidebar-assistant-sort-label">
                    {assistantNavSortLabel}
                  </span>
                  {renderAssistantSortButton()}
                </div>
                {sortedAssistantNavAgents.length > 0 ? (
                  sortedAssistantNavAgents.map((agent) =>
                    renderAssistantAgent(agent),
                  )
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
            <span className="sidebar-link-label">{visibleLabel}</span>
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
              renderAssistantSortButton()
            ) : null}
            {args.groupId === "assistants" ? (
              <Tooltip content="新增项目">
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-assistant-project-button"
                  aria-label="新增项目"
                  title="新增项目"
                  disabled={creatingCoderProject || Boolean(coderAcpProjectDialog)}
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
              {sortedAssistantNavAgents.length > 0 ? (
                sortedAssistantNavAgents.map((agent) =>
                  renderAssistantAgent(agent),
                )
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
        collapsedLabel: item.collapsedLabel,
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
        collapsedLabel: item.collapsedLabel,
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

  function renderAccountMenuIcon(kind: "account") {
    return (
      <span
        className={`sidebar-account-menu-icon is-${kind}`}
        aria-hidden="true"
      />
    );
  }

  function renderAccountMenuUserItem() {
    const desktopSsoUserLabel = getDesktopSsoUserLabel();
    const desktopSsoActionLabel = getDesktopSsoActionLabel();
    const desktopSsoLogoutLabel = t("sidebar.sso.signOut");

    if (desktopSsoStatus?.authenticated) {
      return (
        <button
          type="button"
          className={[
            "sidebar-account-menu-item",
            "sidebar-account-menu-action",
            "sidebar-account-menu-user",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={handleDesktopSsoLogoutClick}
          disabled={desktopSsoBusy}
          role="menuitem"
          aria-label={desktopSsoLogoutLabel}
          title={desktopSsoUserLabel}
        >
          {renderAccountMenuIcon("account")}
          <span className="sidebar-account-menu-label">{desktopSsoLogoutLabel}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        className={[
          "sidebar-account-menu-item",
          "sidebar-account-menu-action",
          "sidebar-account-menu-user",
          desktopSsoStatus?.pending ? "is-pending" : "",
          desktopSsoStatus?.error ? "is-error" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={handleDesktopSsoMenuActionClick}
        disabled={desktopSsoBusy}
        role="menuitem"
        aria-label={desktopSsoActionLabel}
        title={desktopSsoActionLabel}
      >
        {renderAccountMenuIcon("account")}
        <span className="sidebar-account-menu-label">
          {desktopSsoBusy ? t("sidebar.sso.busy") : desktopSsoUserLabel}
        </span>
      </button>
    );
  }

  function getDesktopSsoUserLabel() {
    if (!desktopSsoStatus) {
      return t("sidebar.sso.signIn");
    }
    if (desktopSsoStatus.authenticated) {
      return (
        desktopSsoStatus.user?.name?.trim() ||
        desktopSsoStatus.user?.email?.trim() ||
        t("sidebar.sso.signedIn")
      );
    }
    return desktopSsoStatus.pending
      ? t("sidebar.sso.signingIn")
      : t("sidebar.sso.signIn");
  }

  function getDesktopSsoActionLabel() {
    return desktopSsoStatus?.pending
      ? t("sidebar.sso.reopen")
      : t("sidebar.sso.signIn");
  }

  function handleDesktopSsoMenuActionClick() {
    onDesktopSsoLogin?.();
    setToolMenuOpen(false);
  }

  function handleDesktopSsoLogoutClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (desktopSsoBusy) {
      return;
    }
    if (!window.confirm(t("sidebar.sso.confirmSignOut"))) {
      return;
    }
    onDesktopSsoLogout?.();
    setToolMenuOpen(false);
  }

  function renderToolMenu() {
    const topToolItems = fixedToolItems.filter((item) =>
      item.to === "/agents" || item.to === "/market"
    );
    const middleToolItems = fixedToolItems.filter((item) =>
      item.to === "/control-center" || item.to === "/help"
    );
    const settingsToolItems = fixedToolItems.filter((item) => item.to === "/settings");

    return (
      <div
        className={[
          "sidebar-tool-menu",
          "sidebar-account-menu",
          isCollapsed
            ? "is-from-collapsed-sidebar"
            : "is-from-expanded-sidebar",
        ]
          .filter(Boolean)
          .join(" ")}
        role="menu"
        aria-label={t("nav.sidebar.fixedTools")}
      >
        {topToolItems.map((item) => renderToolLink(item))}
        <div className="sidebar-account-menu-divider" aria-hidden="true" />
        {middleToolItems.map((item) => renderToolLink(item))}
        <div className="sidebar-account-menu-divider" aria-hidden="true" />
        {settingsToolItems.map((item) => renderToolLink(item))}
        {renderAccountMenuUserItem()}
      </div>
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

  function isCoderAgent(agent: AssistantNavAgentItem) {
    return agent.agentType === "coder";
  }

  function asPlainRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function readActionResultRecord(response: unknown) {
    const record = asPlainRecord(response);
    return asPlainRecord(record.result);
  }

  function readAgentDetailRecord(value: unknown) {
    const result = readActionResultRecord(value);
    const nestedAgent = asPlainRecord(result.agent);
    return Object.keys(nestedAgent).length > 0 ? nestedAgent : result;
  }

  function buildAgentDefinitionForRename(
    detail: Record<string, unknown>,
    agent: AssistantNavAgentItem,
    nextName: string,
  ) {
    const currentDefinition = asPlainRecord(detail.definition);
    const definition =
      Object.keys(currentDefinition).length > 0
        ? { ...currentDefinition }
        : (
            [
              "key",
              "mode",
              "icon",
              "workspace",
              "runtimeConfig",
              "model",
              "modelConfig",
              "tools",
              "toolConfig",
              "visibility",
              "prompts",
              "soulPrompt",
              "agentsPrompt",
            ] as const
          ).reduce<Record<string, unknown>>((next, key) => {
            if (detail[key] !== undefined) {
              next[key] = detail[key];
            }
            return next;
          }, {});

    if (!definition.key) {
      definition.key = agent.agentKey;
    }
    if (!definition.mode && agent.mode) {
      definition.mode = agent.mode;
    }
    if (!definition.icon && agent.icon) {
      definition.icon = agent.icon;
    }
    if (
      !definition.workspace &&
      agent.workspaceDir &&
      agent.workspaceDir !== "@chat"
    ) {
      definition.workspace = { root: agent.workspaceDir };
    }
    if (
      !definition.runtimeConfig &&
      agent.workspaceDir &&
      agent.workspaceDir !== "@chat"
    ) {
      definition.runtimeConfig = { workspaceRoot: agent.workspaceDir };
    }
    definition.name = nextName;

    return definition.mode ? definition : null;
  }

  function createAgentEditRoute(agent: AssistantNavAgentItem) {
    return `/agents/${encodeURIComponent(agent.agentKey)}`;
  }

  async function handleOpenWorkspace(agent: AssistantNavAgentItem) {
    const disabledReason = getOpenWorkspaceDisabledReason(agent);
    if (disabledReason) {
      return;
    }
    setAgentMenu(null);
    if (agent.workspaceDir) {
      await openWorkspaceDirectory(agent.workspaceDir, agent.agentKey);
    }
  }

  async function openWorkspaceDirectory(
    workspaceDir: string,
    _agentKey: string,
  ) {
    await window.electronAPI.desktopShell.openPath(workspaceDir);
  }

  async function handleRenameAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    setAgentDialog({
      kind: "rename",
      agent,
      value: agent.displayName,
      pending: false,
      error: "",
    });
  }

  function handleEditAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    requestNavigate(createAgentEditRoute(agent));
  }

  function handleDeleteAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    setAgentDialog({
      kind: "delete",
      agent,
      value: agent.displayName,
      pending: false,
      error: "",
    });
  }

  async function handleConfirmRenameAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentDialog || agentDialog.kind !== "rename" || agentDialog.pending) {
      return;
    }
    const nextName = agentDialog.value.trim();
    if (!nextName) {
      setAgentDialog((current) =>
        current ? { ...current, error: "请输入智能体名称。" } : current,
      );
      return;
    }
    const targetAgent = agentDialog.agent;
    setAgentDialog((current) =>
      current ? { ...current, pending: true, error: "" } : current,
    );
    try {
      const detailResponse = await window.electronAPI.desktopActions.call({
        action: "desktop.agents.getAgentDetail",
        args: { key: targetAgent.agentKey },
      });
      if (!detailResponse.ok) {
        throw new Error(
          detailResponse.error?.message || "读取智能体详情失败。",
        );
      }
      const definition = buildAgentDefinitionForRename(
        readAgentDetailRecord(detailResponse),
        targetAgent,
        nextName,
      );
      if (!definition) {
        throw new Error("智能体详情不完整，无法安全修改名称。");
      }
      const updateResponse = await window.electronAPI.desktopActions.call({
        action: "desktop.agents.updateAgent",
        args: {
          key: targetAgent.agentKey,
          definition,
        },
      });
      if (!updateResponse.ok) {
        throw new Error(
          updateResponse.error?.message || "修改智能体名称失败。",
        );
      }
      setAgentDialog(null);
      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      setAgentDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  async function handleConfirmDeleteAgent() {
    if (!agentDialog || agentDialog.kind !== "delete" || agentDialog.pending) {
      return;
    }
    const targetAgent = agentDialog.agent;
    setAgentDialog((current) =>
      current ? { ...current, pending: true, error: "" } : current,
    );
    try {
      const response = await window.electronAPI.desktopActions.call({
        action: "desktop.agents.deleteAgent",
        args: { key: targetAgent.agentKey },
      });
      if (!response.ok) {
        throw new Error(response.error?.message || "删除智能体失败。");
      }
      setAgentDialog(null);
      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      setAgentDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
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

  function renderAssistantChatRenameDialog() {
    if (!assistantChatRenameDialog || typeof document === "undefined") {
      return null;
    }
    return createPortal(
      <div
        className="sidebar-agent-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!assistantChatRenameDialog.pending) {
            setAssistantChatRenameDialog(null);
          }
        }}
      >
        <form
          className="sidebar-agent-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-chat-rename-dialog-title"
          onSubmit={(event) => void handleConfirmRenameChat(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-agent-dialog-head">
            <strong id="sidebar-chat-rename-dialog-title">重命名会话</strong>
            <button
              type="button"
              className="sidebar-agent-dialog-close"
              aria-label="关闭"
              disabled={assistantChatRenameDialog.pending}
              onClick={() => setAssistantChatRenameDialog(null)}
            >
              ×
            </button>
          </div>
          <label className="sidebar-agent-dialog-field">
            <span>名称</span>
            <input
              value={assistantChatRenameDialog.value}
              onChange={(event) =>
                setAssistantChatRenameDialog((current) =>
                  current
                    ? { ...current, value: event.target.value, error: "" }
                    : current,
                )
              }
              disabled={assistantChatRenameDialog.pending}
              maxLength={120}
              autoFocus
            />
          </label>
          {assistantChatRenameDialog.error ? (
            <div className="sidebar-agent-dialog-error" role="alert">
              {assistantChatRenameDialog.error}
            </div>
          ) : null}
          <div className="sidebar-agent-dialog-actions">
            <button
              type="button"
              className="sidebar-agent-secondary-button"
              disabled={assistantChatRenameDialog.pending}
              onClick={() => setAssistantChatRenameDialog(null)}
            >
              取消
            </button>
            <button
              type="submit"
              className="sidebar-agent-primary-button"
              disabled={assistantChatRenameDialog.pending}
            >
              {assistantChatRenameDialog.pending ? "处理中..." : "保存"}
            </button>
          </div>
        </form>
      </div>,
      document.body,
    );
  }

  function renderAgentMenu() {
    if (!agentMenu || typeof document === "undefined") {
      return null;
    }
    const agent = agentMenu.agent;
    const coderAgent = agent.agentType === "coder";
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
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleRenameAgent(agent)}
        >
          <span>修改名称</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => handleEditAgent(agent)}
        >
          <span>编辑智能体</span>
        </button>
        {coderAgent ? (
          <button
            type="button"
            className="is-danger"
            role="menuitem"
            onClick={() => handleDeleteAgent(agent)}
          >
            <span>删除智能体</span>
          </button>
        ) : null}
      </div>,
      document.body,
    );
  }

  function renderAgentDialog() {
    if (!agentDialog || typeof document === "undefined") {
      return null;
    }
    const isRename = agentDialog.kind === "rename";
    const title = isRename ? "修改名称" : "删除智能体";
    return createPortal(
      <div
        className="sidebar-agent-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!agentDialog.pending) {
            setAgentDialog(null);
          }
        }}
      >
        <form
          className="sidebar-agent-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-agent-dialog-title"
          onSubmit={
            isRename
              ? (event) => void handleConfirmRenameAgent(event)
              : (event) => {
                  event.preventDefault();
                  void handleConfirmDeleteAgent();
                }
          }
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-agent-dialog-head">
            <strong id="sidebar-agent-dialog-title">{title}</strong>
            <button
              type="button"
              className="sidebar-agent-dialog-close"
              aria-label="关闭"
              disabled={agentDialog.pending}
              onClick={() => setAgentDialog(null)}
            >
              ×
            </button>
          </div>
          {isRename ? (
            <label className="sidebar-agent-dialog-field">
              <span>名称</span>
              <input
                value={agentDialog.value}
                onChange={(event) =>
                  setAgentDialog((current) =>
                    current
                      ? { ...current, value: event.target.value, error: "" }
                      : current,
                  )
                }
                disabled={agentDialog.pending}
                maxLength={80}
                autoFocus
              />
            </label>
          ) : (
            <p className="sidebar-agent-dialog-copy">
              确定要删除“{agentDialog.agent.displayName}”吗？此操作无法撤销。
            </p>
          )}
          {agentDialog.error ? (
            <div className="sidebar-agent-dialog-error" role="alert">
              {agentDialog.error}
            </div>
          ) : null}
          <div className="sidebar-agent-dialog-actions">
            <button
              type="button"
              className="sidebar-agent-secondary-button"
              disabled={agentDialog.pending}
              onClick={() => setAgentDialog(null)}
            >
              取消
            </button>
            <button
              type="submit"
              className={
                isRename
                  ? "sidebar-agent-primary-button"
                  : "sidebar-agent-danger-button"
              }
              disabled={agentDialog.pending}
            >
              {agentDialog.pending ? "处理中..." : isRename ? "保存" : "删除"}
            </button>
          </div>
        </form>
      </div>,
      document.body,
    );
  }

  function renderCoderAcpProjectDialog() {
    if (!coderAcpProjectDialog || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        className="sidebar-website-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!coderAcpProjectDialog.pending) {
            setCoderAcpProjectDialog(null);
          }
        }}
      >
        <form
          className="sidebar-website-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-coder-acp-dialog-title"
          onSubmit={(event) => void handleSubmitCoderAcpProject(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-website-dialog-head">
            <strong id="sidebar-coder-acp-dialog-title">创建 CODER 项目</strong>
            <button
              type="button"
              className="sidebar-website-dialog-close"
              aria-label="关闭"
              disabled={coderAcpProjectDialog.pending}
              onClick={() => setCoderAcpProjectDialog(null)}
            >
              ×
            </button>
          </div>
          <label className="sidebar-website-dialog-field">
            <span>项目名称</span>
            <input
              value={coderAcpProjectDialog.name}
              onChange={(event) =>
                setCoderAcpProjectDialog((current) =>
                  current
                    ? {
                        ...current,
                        name: event.target.value,
                        error: "",
                      }
                    : current,
                )
              }
              disabled={coderAcpProjectDialog.pending}
              autoFocus
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>项目目录</span>
            <input value={coderAcpProjectDialog.workspaceDir} readOnly />
          </label>
          <div className="sidebar-website-dialog-field">
            <span>编程方式</span>
            <div
              className="sidebar-coder-programming-mode"
              role="radiogroup"
              aria-label="编程方式"
            >
              <label>
                <input
                  type="radio"
                  name="coder-programming-mode"
                  value="builtin"
                  checked={coderAcpProjectDialog.programmingMode === "builtin"}
                  onChange={() =>
                    setCoderAcpProjectDialog((current) =>
                      current
                        ? {
                            ...current,
                            programmingMode: "builtin",
                            error: "",
                          }
                        : current,
                    )
                  }
                  disabled={coderAcpProjectDialog.pending}
                />
                <span>内置编程</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="coder-programming-mode"
                  value="acp"
                  checked={coderAcpProjectDialog.programmingMode === "acp"}
                  onChange={() =>
                    setCoderAcpProjectDialog((current) =>
                      current
                        ? {
                            ...current,
                            programmingMode: "acp",
                            selectedAcpProxyId:
                              current.selectedAcpProxyId ||
                              current.options[0]?.acpProxyId ||
                              "",
                            error: "",
                          }
                        : current,
                    )
                  }
                  disabled={coderAcpProjectDialog.pending}
                />
                <span>ACP 代理编程</span>
              </label>
            </div>
          </div>
          {coderAcpProjectDialog.programmingMode === "acp" ? (
            <label className="sidebar-website-dialog-field">
              <span>ACP 工具</span>
              <select
                value={coderAcpProjectDialog.selectedAcpProxyId}
                onChange={(event) =>
                  setCoderAcpProjectDialog((current) =>
                    current
                      ? {
                          ...current,
                          selectedAcpProxyId: event.target.value,
                          error: "",
                        }
                      : current,
                  )
                }
                disabled={
                  coderAcpProjectDialog.pending ||
                  coderAcpProjectDialog.options.length === 0
                }
              >
                {coderAcpProjectDialog.options.length === 0 ? (
                  <option value="">暂无正在运行的 ACP 工具</option>
                ) : null}
                {coderAcpProjectDialog.options.map((option) => (
                  <option value={option.acpProxyId} key={option.serviceId}>
                    {option.label} · {option.statusLabel}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {coderAcpProjectDialog.error ? (
            <div className="sidebar-website-dialog-error" role="alert">
              {coderAcpProjectDialog.error}
            </div>
          ) : null}
          <div className="sidebar-website-dialog-actions">
            <button
              type="button"
              className="sidebar-website-secondary-button"
              disabled={coderAcpProjectDialog.pending}
              onClick={() => setCoderAcpProjectDialog(null)}
            >
              取消
            </button>
            <button
              type="submit"
              className="sidebar-website-primary-button"
              disabled={coderAcpProjectDialog.pending}
            >
              {coderAcpProjectDialog.pending ? "创建中..." : "创建"}
            </button>
          </div>
        </form>
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

  function getSettingsSectionIcon(sectionId: SettingsSectionId): SidebarIllustrationKind {
    switch (sectionId) {
      case "appearance":
        return "appearance";
      case "control":
        return "control";
      case "navigation":
        return "sidebar-assistant-closed";
      case "quickAssistant":
        return "assistant";
      case "embeddedWebsites":
        return "website";
      case "dataRoot":
        return "service";
      case "memory":
        return "memory";
      case "about":
        return "about";
      default:
        return "settings";
    }
  }

  function renderSettingsNav() {
    return (
      <div className="sidebar-settings-nav">
        <button
          type="button"
          className="sidebar-link sidebar-link-utility sidebar-settings-back"
          onClick={() => onExitSettingsMode?.()}
        >
          <span className="sidebar-link-icon" aria-hidden="true">
            <LeftOutlined />
          </span>
          <span className="sidebar-link-label">{t("settings.backToApp")}</span>
        </button>
        <nav className="sidebar-settings-directory" aria-label={t("settings.directory")}>
          {settingsSections.map((section) => {
            const targetPath = buildSettingsSectionPath(section.id);
            const isActive = activeSettingsSectionId === section.id;
            return (
              <NavLink
                key={section.id}
                to={targetPath}
                className={({ isActive: routeActive }) =>
                  [
                    "sidebar-link",
                    routeActive || isActive ? "sidebar-link-active" : "",
                    pendingPath === targetPath ? "is-pending" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
                onClick={(event) => {
                  event.preventDefault();
                  onSelectSettingsSection?.(section.id);
                }}
              >
                <span className="sidebar-link-icon" aria-hidden="true">
                  <SidebarIllustration kind={getSettingsSectionIcon(section.id)} />
                </span>
                <span className="sidebar-link-label">{section.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    );
  }

  const shouldRenderCollapsed = isCollapsed && !isSettingsMode;

  return (
    <aside className={shouldRenderCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="sidebar-chrome">
        <div className="sidebar-chrome-drag-region" aria-hidden="true" />
        <div className={chromeToolbarClassName}>
          <div className="sidebar-top-actions">
            {!isSettingsMode ? (
            <SidebarCollapseToggle
              className="sidebar-collapsed-toggle-button"
              isCollapsed={isCollapsed}
              variant="compact"
              onToggleCollapsed={onToggleCollapsed}
            />
            ) : null}
            {!isSettingsMode ? (
            <div className="sidebar-history-controls">
              <button
                type="button"
                className="sidebar-history-button"
                aria-label="后退"
                title="后退"
                disabled={!sidebarNavigationCanGoBack}
                onClick={onSidebarNavigateBack}
              >
                <LeftOutlined aria-hidden="true" />
              </button>
              <button
                type="button"
                className="sidebar-history-button"
                aria-label="前进"
                title="前进"
                disabled={!sidebarNavigationCanGoForward}
                onClick={onSidebarNavigateForward}
              >
                <RightOutlined aria-hidden="true" />
              </button>
            </div>
            ) : null}
            {!isSettingsMode && assistantLauncherVisible ? (
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
                    ? `当前页面不可开启 ${PRODUCT_NAME} 助手`
                    : assistantDockOpen
                      ? `关闭 ${PRODUCT_NAME} 助手`
                      : `打开 ${PRODUCT_NAME} 助手`
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
        {isSettingsMode ? renderSettingsNav() : navItems.map((item) => renderPrimaryNavEntry(item))}
      </nav>

      {!isSettingsMode ? (
      <div className="sidebar-footer">
        <div className="sidebar-footer-divider" aria-hidden="true" />
        <div className="sidebar-footer-actions">
          <div className="sidebar-tool-menu-anchor">
            <Popover
              placement="top-start"
              content={renderToolMenu()}
              open={toolMenuOpen}
              onOpenChange={setToolMenuOpen}
              className="sidebar-tool-menu-popover"
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
                  <SidebarIllustration kind="settings" />
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
          {renderAssistantChatMenu()}
          {renderAssistantChatRenameDialog()}
          {renderAgentMenu()}
          {renderAgentDialog()}
          {renderCoderAcpProjectDialog()}
          {renderWebsiteDialog()}
        </div>
      </div>
      ) : null}
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
