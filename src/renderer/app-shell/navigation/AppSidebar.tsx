import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  DeleteOutlined,
  LeftOutlined,
  RightOutlined,
  SearchOutlined,
  SortAscendingOutlined,
} from "@ant-design/icons";
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
  DesktopSsoStatus,
  ServiceState,
  WebEntry,
  WebsiteDeleteResult,
  WebsiteEntry,
  WebsiteInput,
  WebsiteResult,
  WebsiteUpdateInput,
} from "../../../shared/contracts";
import {
  createWebNavOrderKey,
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
import { PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/brand";
import { BUILTIN_BROWSER_ROUTE } from "../../../shared/browser-surfaces";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../../../shared/service-webview-bridge";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";
import type {
  SettingsSectionGroupId,
  SettingsSectionId,
} from "../../../shared/settings-sections";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";

type SidebarNavItem = {
  orderKey: SidebarNavOrderItemKey;
  to: string;
  label: string;
  collapsedLabel?: string;
  icon: SidebarIllustrationKind;
  webItem?: WebEntry;
};

type SidebarToolItem = Omit<SidebarNavItem, "orderKey"> & {
  orderKey: string;
};

type SidebarPrimaryEntry = SidebarNavItem & {
  entryType?: "link" | "assistants" | "webs";
};

type SidebarGroupId = "assistants" | "webs";

type SidebarGroupState = Record<SidebarGroupId, boolean>;

const SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  labelKey: TranslationKey;
}> = [
  { id: "personal", labelKey: "settings.group.personal" },
  { id: "integrations", labelKey: "settings.group.integrations" },
  { id: "system", labelKey: "settings.group.system" },
];

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

type CoderAcpProxyOption = {
  serviceId: string;
  acpProxyId: string;
  label: string;
};

type RunningCoderAcpProxyOption = CoderAcpProxyOption & {
  statusLabel: string;
};

type CreateProjectType = "coder" | "kbase";
type KbaseVectorStore = "local" | "remote";

type CreateProjectDialogState = {
  name: string;
  workspaceDir: string;
  projectType: CreateProjectType;
  useAcp: boolean;
  options: RunningCoderAcpProxyOption[];
  selectedAcpProxyId: string;
  kbaseVectorStore: KbaseVectorStore;
  pending: boolean;
  error: string;
};

const SIDEBAR_GROUP_STATE_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-groups`;
const SIDEBAR_ASSISTANT_SORT_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-assistant-sort`;

const defaultSidebarGroupState: SidebarGroupState = {
  assistants: true,
  webs: true,
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

const kanbanNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
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

const websGroupNavItemBase: Omit<SidebarPrimaryEntry, "label"> = {
  orderKey: "group:webs",
  to: "",
  icon: "website",
  entryType: "webs",
};

const fixedToolRowsBase: Array<
  Array<
    Omit<SidebarToolItem, "label"> & {
      labelKey:
        | "nav.agents"
        | "nav.archives"
        | "nav.registries"
        | "nav.market"
        | "nav.settings";
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
      orderKey: "archives",
      to: "/archives",
      labelKey: "nav.archives",
      icon: "archive",
    },
    {
      orderKey: "registries",
      to: "/registries",
      labelKey: "nav.registries",
      icon: "service",
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
      orderKey: "settings",
      to: "/settings",
      labelKey: "nav.settings",
      icon: "settings",
    },
  ],
];

type AccountMenuAvatarProps = {
  avatarUrl?: string;
  label: string;
};

function getAccountMenuAvatarFallback(label: string) {
  return Array.from(label.trim())[0]?.toUpperCase() || "?";
}

function AccountMenuAvatar({ avatarUrl = "", label }: AccountMenuAvatarProps) {
  const imageSource = avatarUrl.trim();
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageSource]);

  return (
    <span className="sidebar-account-menu-avatar" aria-hidden="true">
      {imageSource && !imageFailed ? (
        <img
          className="sidebar-account-menu-avatar-image"
          src={imageSource}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="sidebar-account-menu-avatar-fallback">
          {getAccountMenuAvatarFallback(label)}
        </span>
      )}
    </span>
  );
}

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
  const record = candidate as Partial<Record<SidebarGroupId | "websites", unknown>>;
  return {
    assistants:
      typeof record.assistants === "boolean"
        ? record.assistants
        : defaultSidebarGroupState.assistants,
    webs:
      typeof record.webs === "boolean"
        ? record.webs
        : typeof record.websites === "boolean"
          ? record.websites
          : defaultSidebarGroupState.webs,
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
  t: TranslateFunction,
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
        statusLabel: service.statusLabel || t("controlCenter.status.running"),
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

  // Today: HH:mm.
  if (toLocalDateKey(updatedDate) === toLocalDateKey(now)) {
    return formatLocalTime(updatedDate);
  }

  // Same year but not today: MM-dd.
  if (updatedDate.getFullYear() === now.getFullYear()) {
    return formatMonthDay(updatedDate);
  }

  // Different year: YYYY-MM.
  return formatYearMonth(updatedDate);
}

function isAssistantRunningPreview(value: string) {
  const normalized = value.trim().toLowerCase();
  return [
    "\u601d\u8003\u4e2d",
    "\u601d\u8003\u4e2d...",
    "thinking",
    "thinking...",
  ].includes(normalized);
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
      return "kanban.run.awaitingApproval";
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
  t: TranslateFunction;
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
        <path
          d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm200-80h360v-560H400v560Z"
          fill="currentColor"
        />
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
  t,
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
      aria-label={isCollapsed ? t("nav.sidebar.expand") : t("nav.sidebar.collapse")}
      title={isCollapsed ? t("nav.sidebar.expand") : t("nav.sidebar.collapse")}
      aria-expanded={!isCollapsed}
      onClick={onToggleCollapsed}
    >
      <SidebarCollapseToggleIcon isCollapsed={isCollapsed} />
    </button>
  );
}

type SettingsSidebarSection = {
  id: SettingsSectionId;
  group: SettingsSectionGroupId;
  label: string;
  description: string;
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
  marketEnabled?: boolean;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  websiteNavOrder?: SidebarNavOrderItemKey[];
  webItems: WebEntry[];
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
  onRefreshDesktopSsoStatus?: () => Promise<void> | void;
  onRefreshAssistantNavAgents?: () => Promise<void> | void;
  onRefreshCopilotAgentOptions?: () => Promise<void> | void;
  onCreateWebsiteItem?: (
    input: WebsiteInput,
  ) => Promise<WebsiteResult>;
  onUpdateWebsiteItem?: (
    id: string,
    input: WebsiteUpdateInput,
  ) => Promise<WebsiteResult>;
  onDeleteWebsiteItem?: (id: string) => Promise<WebsiteDeleteResult>;
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
  marketEnabled = true,
  sidebarNavOrder,
  websiteNavOrder = [],
  webItems,
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
  onRefreshDesktopSsoStatus,
  onRefreshAssistantNavAgents,
  onRefreshCopilotAgentOptions,
  onCreateWebsiteItem,
  onUpdateWebsiteItem,
  onDeleteWebsiteItem,
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
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [expandedAssistantAgentKey, setExpandedAssistantAgentKey] =
    useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectDialog, setCreateProjectDialog] =
    useState<CreateProjectDialogState | null>(null);
  const [websiteDialogOpen, setWebsiteDialogOpen] = useState(false);
  const [websiteLabel, setWebsiteLabel] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [websiteAgentKey, setWebsiteAgentKey] = useState("");
  const [websiteCreatePending, setWebsiteCreatePending] = useState(false);
  const [websiteCreateError, setWebsiteCreateError] = useState("");
  const [websiteEditingItem, setWebsiteEditingItem] =
    useState<WebsiteEntry | null>(null);
  const [websiteDeletePendingId, setWebsiteDeletePendingId] = useState("");
  const [assistantChatMenu, setAssistantChatMenu] =
    useState<AssistantChatMenuState | null>(null);
  const [assistantChatRenameDialog, setAssistantChatRenameDialog] =
    useState<AssistantChatRenameDialogState | null>(null);
  const [agentMenu, setAgentMenu] = useState<{
    agent: AssistantNavAgentItem;
    x: number;
    y: number;
  } | null>(null);
  const lastAutoExpandedAssistantAgentKeyRef = useRef("");
  const lastRouteAgentInfoRef = useRef(readAgentRouteInfo(currentRoute));
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuOpenRequestIdRef = useRef(0);
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

  const normalizedSettingsSearchQuery = settingsSearchQuery.trim().toLocaleLowerCase();
  const groupedSettingsSections = useMemo(
    () =>
      SETTINGS_SECTION_GROUPS.map((group) => {
        const sections = settingsSections.filter((section) => {
          if (section.group !== group.id) {
            return false;
          }
          if (!normalizedSettingsSearchQuery) {
            return true;
          }
          return [section.label, section.description].some((value) =>
            value.toLocaleLowerCase().includes(normalizedSettingsSearchQuery),
          );
        });
        return { ...group, sections };
      }).filter((group) => group.sections.length > 0),
    [normalizedSettingsSearchQuery, settingsSections],
  );

  const webNavItems: SidebarNavItem[] = useMemo(() => {
    const orderIndex = new Map(
      websiteNavOrder.map((key, index) => [key, index] as const),
    );
    return webItems
      .map((item) => ({
        orderKey: createWebNavOrderKey(item.entryKey),
        to: `/webs/${item.entryKey}`,
        label: item.label,
        icon: "website" as const,
        webItem: item,
      }))
      .sort((left, right) => {
        const leftIndex =
          orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex =
          orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [webItems, websiteNavOrder]);

  const navItems: SidebarPrimaryEntry[] = sortSidebarNavItems(
    [
      {
        ...kanbanNavItemBase,
        label: t("nav.kanban"),
        collapsedLabel: t("nav.kanbanCollapsed"),
      },
      { ...schedulesNavItemBase, label: t("nav.schedules"), collapsedLabel: t("nav.schedulesCollapsed") },
      {
        ...assistantGroupNavItemBase,
        label: t("nav.assistants"),
        collapsedLabel: t("nav.assistantsCollapsed"),
      },
      {
        ...websGroupNavItemBase,
        label: t("nav.websites"),
        collapsedLabel: t("nav.websitesCollapsed"),
      },
    ].filter((item) => sidebarNavOrder.includes(item.orderKey)),
    sidebarNavOrder,
  );
  const fixedToolRows: SidebarToolItem[][] = fixedToolRowsBase
    .map((row) =>
      row
        .filter((item) => item.orderKey !== "market" || marketEnabled)
        .map(({ labelKey, ...item }) => ({ ...item, label: t(labelKey) })),
    )
    .filter((row) => row.length > 0);
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
        closeWebsiteDialog();
      }
    }
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [websiteCreatePending, websiteDialogOpen]);

  useEffect(() => {
    const currentDialog = assistantChatRenameDialog;
    if (!currentDialog) {
      return undefined;
    }
    const canCloseDialog = !currentDialog.pending;

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && canCloseDialog) {
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

    void webview.executeJavaScript(script, true).catch((error: unknown) => {
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

  async function handleCreateProject(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (creatingProject || createProjectDialog) {
      return;
    }
    setCreatingProject(true);
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
          t,
        );
      } catch (error) {
        console.warn("[assistant] failed to list ACP proxy services", error);
      }
      setCreateProjectDialog({
        name: getWorkspaceNameFromPath(selection.path),
        workspaceDir: selection.path,
        projectType: "coder",
        useAcp: false,
        options: runningAcpProxies,
        selectedAcpProxyId: runningAcpProxies[0]?.acpProxyId ?? "",
        kbaseVectorStore: "local",
        pending: false,
        error: "",
      });
    } catch (error) {
      console.warn("[assistant] failed to prepare project", error);
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleSubmitCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dialog = createProjectDialog;
    if (!dialog || dialog.pending) {
      return;
    }
    const name = dialog.name.trim();
    if (!name) {
      setCreateProjectDialog({
        ...dialog,
        error: t("sidebar.project.nameRequired"),
      });
      return;
    }
    if (dialog.projectType === "kbase") {
      setCreateProjectDialog({
        ...dialog,
        error: t("sidebar.project.kbaseNotImplemented"),
      });
      return;
    }
    const selectedAcpProxy =
      dialog.useAcp && dialog.selectedAcpProxyId
        ? dialog.options.find(
            (option) => option.acpProxyId === dialog.selectedAcpProxyId,
          )
        : null;
    if (dialog.useAcp && !selectedAcpProxy) {
      setCreateProjectDialog({
        ...dialog,
        error: t("sidebar.project.acpRequired"),
      });
      return;
    }
    setCreateProjectDialog({ ...dialog, pending: true, error: "" });
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
        setCreateProjectDialog({
          ...dialog,
          pending: false,
          error: result.message || t("sidebar.project.createCoderFailed"),
        });
        return;
      }
      setCreateProjectDialog(null);
      await onRefreshAssistantNavAgents?.();
      if (result.agentKey) {
        setExpandedAssistantAgentKey(result.agentKey);
        requestNavigate(createAgentRoute(result.agentKey));
      }
    } catch (error) {
      console.warn("[assistant] failed to create CODER project", error);
      setCreateProjectDialog({
        ...dialog,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function resetWebsiteDialogState() {
    setWebsiteEditingItem(null);
    setWebsiteLabel("");
    setWebsiteUrl("");
    setWebsiteAgentKey("");
    setWebsiteCreateError("");
  }

  function closeWebsiteDialog() {
    setWebsiteDialogOpen(false);
    resetWebsiteDialogState();
  }

  function openWebsiteDialog(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    resetWebsiteDialogState();
    setWebsiteDialogOpen(true);
    void onRefreshCopilotAgentOptions?.();
  }

  function openWebsiteEditDialog(
    event: MouseEvent<HTMLElement>,
    item: WebsiteEntry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setWebsiteEditingItem(item);
    setWebsiteLabel(item.label);
    setWebsiteUrl(item.url);
    setWebsiteAgentKey(item.agentKey || "");
    setWebsiteCreateError("");
    setWebsiteDialogOpen(true);
    void onRefreshCopilotAgentOptions?.();
  }

  async function handleSaveWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (websiteCreatePending) {
      return;
    }
    setWebsiteCreatePending(true);
    setWebsiteCreateError("");
    try {
      let result: WebsiteResult | null = null;
      if (websiteEditingItem && onUpdateWebsiteItem) {
        result = await onUpdateWebsiteItem(websiteEditingItem.id, {
          label: websiteLabel,
          url: websiteUrl,
          agentKey: websiteAgentKey,
        });
      } else if (!websiteEditingItem && onCreateWebsiteItem) {
        result = await onCreateWebsiteItem({
          label: websiteLabel,
          url: websiteUrl,
          agentKey: websiteAgentKey,
        });
      }
      if (!result) {
        return;
      }
      if (!result.ok || !result.item) {
        setWebsiteCreateError(
          result.message ||
            t(websiteEditingItem ? "sidebar.website.updateFailed" : "sidebar.website.addFailed"),
        );
        return;
      }
      closeWebsiteDialog();
      setSidebarGroupState((current) => ({ ...current, webs: true }));
      if (!websiteEditingItem) {
        requestNavigate(`/webs/${result.item.entryKey}`);
      }
    } catch (error) {
      setWebsiteCreateError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWebsiteCreatePending(false);
    }
  }

  async function handleDeleteWebsiteItem(
    event: MouseEvent<HTMLElement>,
    item: WebsiteEntry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (websiteDeletePendingId || !onDeleteWebsiteItem) {
      return;
    }
    if (!window.confirm(t("sidebar.website.deleteConfirm", { name: item.label }))) {
      return;
    }
    setWebsiteDeletePendingId(item.id);
    try {
      const result = await onDeleteWebsiteItem(item.id);
      if (!result.ok) {
        window.alert(result.message || t("sidebar.website.deleteFailed"));
        return;
      }
      if (
        currentPathname === `/webs/${item.entryKey}` ||
        pendingPath === `/webs/${item.entryKey}`
      ) {
        requestNavigate(BUILTIN_BROWSER_ROUTE);
      }
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : t("sidebar.website.deleteFailed"),
      );
    } finally {
      setWebsiteDeletePendingId("");
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

  async function handleAssistantOpenChat(chat: AssistantNavChatItem) {
    if (!chat.isRead) {
      const assistantApi = window.electronAPI.assistant as typeof window.electronAPI.assistant & {
        markChatRead?: (
          chatId: string,
          runId?: string,
        ) => ReturnType<typeof window.electronAPI.assistant.markAgentChatsRead>;
      };
      const markChatRead = assistantApi.markChatRead;
      const markReadRequest =
        typeof markChatRead === "function"
          ? markChatRead(chat.chatId, chat.lastRunId || undefined)
          : window.electronAPI.assistant.markAgentChatsRead(chat.agentKey || currentAgentKey);
      void markReadRequest.catch((error: unknown) => {
        console.warn("[assistant] failed to mark chat read", error);
      });
    }
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
        window.alert(result.message || t("sidebar.chat.exportFailed"));
        return;
      }
      if (result.filePath) {
        window.alert(t("sidebar.chat.exportedTo", { path: result.filePath }));
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("sidebar.chat.exportFailed"));
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
        current ? { ...current, error: t("sidebar.chat.nameRequired") } : current,
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
        throw new Error(result.message || t("sidebar.chat.renameFailed"));
      }
      setAssistantChatRenameDialog(null);
      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      setAssistantChatRenameDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: error instanceof Error ? error.message : t("sidebar.chat.renameFailed"),
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
    if (!window.confirm(t("sidebar.chat.deleteConfirm", { name: chatLabel }))) {
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

  function isFixedToolRouteActive(targetPath: string) {
    const targetPathname = getRoutePathname(targetPath);
    const pendingPathname = pendingPath ? getRoutePathname(pendingPath) : "";
    if (targetPathname === "/agents") {
      return (
        currentPathname === targetPathname ||
        currentPathname.startsWith(`${targetPathname}/`) ||
        pendingPathname === targetPathname ||
        pendingPathname.startsWith(`${targetPathname}/`)
      );
    }
    return currentPathname === targetPathname || pendingPathname === targetPathname;
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
      currentPathname.startsWith("/webs/") ||
      Boolean(pendingPath?.startsWith("/webs/"))
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
            {t("sidebar.assistants.awaitingStatus.question")}{summary.pendingCount > 1 ? summary.pendingCount : ""}
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
    const websiteItem = item.webItem?.kind === "website" ? item.webItem : null;
    if (websiteItem) {
      const deleting = websiteDeletePendingId === websiteItem.id;
      return (
        <div
          key={item.to}
          className={[
            "sidebar-website-child-row",
            deleting ? "is-deleting" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <NavLink
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
          <span className="sidebar-website-child-actions">
            <Tooltip content={t("sidebar.website.edit")}>
              <button
                type="button"
                className="assistant-worker-icon-button sidebar-website-child-action"
                aria-label={t("sidebar.website.edit")}
                title={t("sidebar.website.edit")}
                disabled={websiteCreatePending || deleting}
                onClick={(event) => openWebsiteEditDialog(event, websiteItem)}
              >
                <EditSquareIcon width={14} />
              </button>
            </Tooltip>
            <Tooltip content={t("sidebar.website.delete")}>
              <button
                type="button"
                className="assistant-worker-icon-button sidebar-website-child-action is-danger"
                aria-label={t("sidebar.website.delete")}
                title={t("sidebar.website.delete")}
                disabled={deleting || websiteCreatePending}
                onClick={(event) => void handleDeleteWebsiteItem(event, websiteItem)}
              >
                {deleting ? (
                  <span
                    className="assistant-material-icon is-loading"
                    aria-hidden="true"
                  />
                ) : (
                  <DeleteOutlined aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </span>
        </div>
      );
    }
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
        ? chat.chatName || t("sidebar.chat.noPreview")
        : chat.lastRunContent || chat.chatName || t("sidebar.chat.noPreview");
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
            aria-label={!chat.isRead ? t("sidebar.chat.unread") : undefined}
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
            aria-label={t("sidebar.chat.moreActions")}
            title={t("common.more")}
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
        ? previewChat.chatName || t("sidebar.chat.noPreview")
        : previewChat.lastRunContent || previewChat.chatName || t("sidebar.chat.noPreview")
      : agent.latestPreview || (chatCount > 0 ? "" : t("sidebar.agent.noChats"));
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
                        <Tooltip content={t("sidebar.agent.markAllRead")}>
                          <button
                            type="button"
                            className="assistant-worker-icon-button"
                            aria-label={t("sidebar.agent.markAllReadFor", { name: agent.displayName })}
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
                      <Tooltip content={t("sidebar.agent.newChat")}>
                        <button
                          type="button"
                          className="assistant-worker-icon-button"
                          aria-label={t("sidebar.agent.newChatFor", { name: agent.displayName })}
                          onClick={(event) =>
                            handleAssistantNewChat(event, agent)
                          }
                        >
                          <EditSquareIcon width={16} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t("sidebar.agent.moreActions")}>
                        <button
                          type="button"
                          className="assistant-worker-icon-button"
                          aria-label={t("sidebar.agent.moreActionsFor", { name: agent.displayName })}
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
                          previewStatus === "awaiting" ? t("sidebar.agent.awaiting") : t("sidebar.agent.running")
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
            <div className="status-line">{t("sidebar.agent.noChats")}</div>
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
              {t("sidebar.chat.viewMore", {
                count: chatCount,
                unread: unreadCount > 0 ? t("sidebar.chat.unreadSuffix", { count: unreadCount }) : ""
              })}
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
      args.groupId === "webs" ? "sidebar-website-children" : "",
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
              <Tooltip content={t("sidebar.project.new")}>
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-assistant-project-button"
                  aria-label={t("sidebar.project.new")}
                  title={t("sidebar.project.new")}
                  disabled={creatingProject || Boolean(createProjectDialog)}
                  onClick={handleCreateProject}
                >
                  {creatingProject ? (
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
            {args.groupId === "webs" ? (
              <Tooltip content={t("sidebar.website.new")}>
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-website-add-button"
                  aria-label={t("sidebar.website.new")}
                  title={t("sidebar.website.new")}
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
    if (item.entryType === "webs") {
      return renderSidebarGroup({
        groupId: "webs",
        label: item.label,
        collapsedLabel: item.collapsedLabel,
        icon: item.icon,
        active: isWebsiteGroupActive(),
        children: webNavItems,
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
          [
            "sidebar-link",
            "sidebar-tool-menu-item",
            isFixedToolRouteActive(item.to) ? "sidebar-link-active" : "",
          ]
            .filter(Boolean)
            .join(" ")
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

  function renderSettingsToolRow(item: SidebarToolItem) {
    const helpLabel = t("nav.help");
    return (
      <div
        className="sidebar-settings-tool-row"
        key={item.to}
        role="group"
        aria-label={item.label}
      >
        {renderToolLink(item)}
        <NavLink
          to="/help"
          onClick={(event) => handleToolItemClick(event, "/help")}
          aria-label={helpLabel}
          title={helpLabel}
          role="menuitem"
          className={() =>
            [
              "sidebar-settings-help-link",
              isFixedToolRouteActive("/help") ? "sidebar-link-active" : "",
            ]
              .filter(Boolean)
              .join(" ")
          }
        >
          <span aria-hidden="true">?</span>
        </NavLink>
      </div>
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
        <div
          className={[
            "sidebar-account-menu-item",
            "sidebar-account-menu-user",
            "sidebar-account-menu-user-with-action",
          ]
            .filter(Boolean)
            .join(" ")}
          role="group"
          aria-label={desktopSsoUserLabel}
          title={desktopSsoUserLabel}
        >
          <AccountMenuAvatar
            avatarUrl={desktopSsoStatus.user?.avatarUrl}
            label={desktopSsoUserLabel}
          />
          <span className="sidebar-account-menu-label">{desktopSsoUserLabel}</span>
          <button
            type="button"
            className="sidebar-account-menu-logout"
            onClick={handleDesktopSsoLogoutClick}
            disabled={desktopSsoBusy}
            role="menuitem"
            aria-label={desktopSsoLogoutLabel}
            title={desktopSsoLogoutLabel}
          >
            <span className="sidebar-account-menu-logout-label">
              {desktopSsoLogoutLabel}
            </span>
          </button>
        </div>
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

  function handleToolMenuOpenChange(open: boolean) {
    const requestId = toolMenuOpenRequestIdRef.current + 1;
    toolMenuOpenRequestIdRef.current = requestId;
    if (!open) {
      setToolMenuOpen(false);
      return;
    }

    const refreshResult = onRefreshDesktopSsoStatus?.();
    if (!refreshResult) {
      setToolMenuOpen(true);
      return;
    }

    Promise.resolve(refreshResult)
      .catch(() => undefined)
      .finally(() => {
        if (toolMenuOpenRequestIdRef.current === requestId) {
          setToolMenuOpen(true);
        }
      });
  }

  function renderToolMenu() {
    const shouldRenderDesktopSsoAccount = desktopSsoStatus?.configured === true;
    const topToolItems = fixedToolItems.filter((item) =>
      item.to === "/agents" || item.to === "/archives" || item.to === "/registries" || item.to === "/market"
    );

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
        {shouldRenderDesktopSsoAccount ? (
          <>
            {renderAccountMenuUserItem()}
            <div className="sidebar-account-menu-divider" aria-hidden="true" />
          </>
        ) : null}
        {topToolItems.map((item) => renderToolLink(item))}
        <div className="sidebar-account-menu-divider" aria-hidden="true" />
        {settingsToolItem ? renderSettingsToolRow(settingsToolItem) : null}
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
      return t("sidebar.agent.workspaceUnavailable");
    }
    if (workspaceDir === "@chat") {
      return t("sidebar.agent.workspaceMissing");
    }
    if (agent.workspaceDirExists === false) {
      return t("sidebar.agent.workspaceNotFound");
    }
    return "";
  }

  function isCoderAgent(agent: AssistantNavAgentItem) {
    return agent.agentType === "coder";
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

  function handleEditAgent(agent: AssistantNavAgentItem) {
    setAgentMenu(null);
    requestNavigate(createAgentEditRoute(agent));
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
        aria-label={t("sidebar.chat.actions")}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantExportChat(chat)}
        >
          <span aria-hidden="true">↓</span>
          <span>{t("sidebar.chat.export")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantRenameChat(chat)}
        >
          <span aria-hidden="true">✎</span>
          <span>{t("sidebar.chat.rename")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantArchiveChat(chat)}
        >
          <span aria-hidden="true">□</span>
          <span>{t("sidebar.chat.archive")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleAssistantDeleteChat(chat)}
        >
          <span aria-hidden="true">×</span>
          <span>{t("sidebar.chat.delete")}</span>
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
            <strong id="sidebar-chat-rename-dialog-title">{t("sidebar.chat.renameTitle")}</strong>
            <button
              type="button"
              className="sidebar-agent-dialog-close"
              aria-label={t("common.close")}
              disabled={assistantChatRenameDialog.pending}
              onClick={() => setAssistantChatRenameDialog(null)}
            >
              ×
            </button>
          </div>
          <label className="sidebar-agent-dialog-field">
            <span>{t("externalWebview.name")}</span>
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
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="sidebar-agent-primary-button"
              disabled={assistantChatRenameDialog.pending}
            >
              {assistantChatRenameDialog.pending ? t("sidebar.common.processing") : t("common.save")}
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
    const openWorkspaceDisabledReason = getOpenWorkspaceDisabledReason(agent);
    return createPortal(
      <div
        ref={agentMenuRef}
        className="assistant-chat-actions-menu"
        style={{ left: agentMenu.x, top: agentMenu.y }}
        role="menu"
        aria-label={t("sidebar.agent.actions")}
      >
        <button
          type="button"
          role="menuitem"
          disabled={Boolean(openWorkspaceDisabledReason)}
          aria-disabled={Boolean(openWorkspaceDisabledReason)}
          title={openWorkspaceDisabledReason || agent.workspaceDir}
          onClick={() => void handleOpenWorkspace(agent)}
        >
          <span>{t("sidebar.agent.openWorkspace")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => handleEditAgent(agent)}
        >
          <span>{t("sidebar.agent.edit")}</span>
        </button>
      </div>,
      document.body,
    );
  }

  function renderCreateProjectDialog() {
    if (!createProjectDialog || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        className="sidebar-website-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!createProjectDialog.pending) {
            setCreateProjectDialog(null);
          }
        }}
      >
        <form
          className="sidebar-website-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-create-project-dialog-title"
          onSubmit={(event) => void handleSubmitCreateProject(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-website-dialog-head">
            <strong id="sidebar-create-project-dialog-title">{t("sidebar.project.createTitle")}</strong>
            <button
              type="button"
              className="sidebar-website-dialog-close"
              aria-label={t("common.close")}
              disabled={createProjectDialog.pending}
              onClick={() => setCreateProjectDialog(null)}
            >
              ×
            </button>
          </div>
          <label className="sidebar-website-dialog-field">
            <span>{t("sidebar.project.name")}</span>
            <input
              value={createProjectDialog.name}
              onChange={(event) =>
                setCreateProjectDialog((current) =>
                  current
                    ? {
                        ...current,
                        name: event.target.value,
                        error: "",
                      }
                    : current,
                )
              }
              disabled={createProjectDialog.pending}
              autoFocus
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>{t("sidebar.project.directory")}</span>
            <input
              className="sidebar-website-dialog-readonly-input"
              value={createProjectDialog.workspaceDir}
              readOnly
              disabled
              aria-disabled="true"
            />
          </label>
          <div className="sidebar-website-dialog-field">
            <span>{t("sidebar.project.type")}</span>
            <div
              className="sidebar-project-option-grid"
              role="radiogroup"
              aria-label={t("sidebar.project.type")}
            >
              <label>
                <input
                  type="radio"
                  name="create-project-type"
                  value="coder"
                  checked={createProjectDialog.projectType === "coder"}
                  onChange={() =>
                    setCreateProjectDialog((current) =>
                      current
                        ? {
                            ...current,
                            projectType: "coder",
                            error: "",
                          }
                        : current,
                    )
                  }
                  disabled={createProjectDialog.pending}
                />
                <span>{t("sidebar.project.coder")}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="create-project-type"
                  value="kbase"
                  checked={createProjectDialog.projectType === "kbase"}
                  onChange={() =>
                    setCreateProjectDialog((current) =>
                      current
                        ? {
                            ...current,
                            projectType: "kbase",
                            error: "",
                          }
                        : current,
                    )
                  }
                  disabled={createProjectDialog.pending}
                />
                <span>{t("sidebar.project.kbase")}</span>
              </label>
            </div>
          </div>
          {createProjectDialog.projectType === "coder" ? (
            <div className="sidebar-website-dialog-field">
              <label className="sidebar-project-checkbox-row">
                <input
                  type="checkbox"
                  checked={createProjectDialog.useAcp}
                  onChange={(event) => {
                    const useAcp = event.target.checked;
                    setCreateProjectDialog((current) =>
                      current
                        ? {
                            ...current,
                            useAcp,
                            selectedAcpProxyId: useAcp
                              ? current.selectedAcpProxyId ||
                                current.options[0]?.acpProxyId ||
                                ""
                              : current.selectedAcpProxyId,
                            error: "",
                          }
                        : current,
                    );
                  }}
                  disabled={createProjectDialog.pending}
                />
                <span>{t("sidebar.project.useAcp")}</span>
              </label>
            </div>
          ) : null}
          {createProjectDialog.projectType === "coder" && createProjectDialog.useAcp ? (
            <label className="sidebar-website-dialog-field">
              <span>{t("sidebar.project.acpProxy")}</span>
              <select
                value={createProjectDialog.selectedAcpProxyId}
                onChange={(event) =>
                  setCreateProjectDialog((current) =>
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
                  createProjectDialog.pending ||
                  createProjectDialog.options.length === 0
                }
              >
                {createProjectDialog.options.length === 0 ? (
                  <option value="">{t("sidebar.project.noRunningAcp")}</option>
                ) : null}
                {createProjectDialog.options.map((option) => (
                  <option value={option.acpProxyId} key={option.serviceId}>
                    {option.label} · {option.statusLabel}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {createProjectDialog.projectType === "kbase" ? (
            <div className="sidebar-website-dialog-field">
              <span>{t("sidebar.project.vectorStore")}</span>
              <div
                className="sidebar-project-option-grid"
                role="radiogroup"
                aria-label={t("sidebar.project.vectorStore")}
              >
                <label>
                  <input
                    type="radio"
                    name="kbase-vector-store"
                    value="local"
                    checked={createProjectDialog.kbaseVectorStore === "local"}
                    onChange={() =>
                      setCreateProjectDialog((current) =>
                        current
                          ? {
                              ...current,
                              kbaseVectorStore: "local",
                              error: "",
                            }
                          : current,
                      )
                    }
                    disabled={createProjectDialog.pending}
                  />
                  <span>{t("sidebar.project.localVectorStore")}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="kbase-vector-store"
                    value="remote"
                    checked={createProjectDialog.kbaseVectorStore === "remote"}
                    onChange={() =>
                      setCreateProjectDialog((current) =>
                        current
                          ? {
                              ...current,
                              kbaseVectorStore: "remote",
                              error: "",
                            }
                          : current,
                      )
                    }
                    disabled={createProjectDialog.pending}
                  />
                  <span>{t("sidebar.project.remoteVectorStore")}</span>
                </label>
              </div>
            </div>
          ) : null}
          {createProjectDialog.error ? (
            <div className="sidebar-website-dialog-error" role="alert">
              {createProjectDialog.error}
            </div>
          ) : null}
          <div className="sidebar-website-dialog-actions">
            <button
              type="button"
              className="sidebar-website-secondary-button"
              disabled={createProjectDialog.pending}
              onClick={() => setCreateProjectDialog(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="sidebar-website-primary-button"
              disabled={createProjectDialog.pending}
            >
              {createProjectDialog.pending ? t("sidebar.project.creating") : t("sidebar.project.create")}
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
    const websiteDialogEditing = Boolean(websiteEditingItem);
    const websiteDialogTitle = websiteDialogEditing
      ? t("sidebar.website.editTitle")
      : t("sidebar.website.title");
    const websiteSubmitLabel = websiteDialogEditing
      ? websiteCreatePending
        ? t("sidebar.website.saving")
        : t("common.save")
      : websiteCreatePending
        ? t("sidebar.website.adding")
        : t("sidebar.website.add");

    return createPortal(
      <div
        className="sidebar-website-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!websiteCreatePending) {
            closeWebsiteDialog();
          }
        }}
      >
        <form
          className="sidebar-website-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-website-dialog-title"
          onSubmit={(event) => void handleSaveWebsite(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-website-dialog-head">
            <strong id="sidebar-website-dialog-title">{websiteDialogTitle}</strong>
            <button
              type="button"
              className="sidebar-website-dialog-close"
              aria-label={t("common.close")}
              disabled={websiteCreatePending}
              onClick={closeWebsiteDialog}
            >
              ×
            </button>
          </div>
          <label className="sidebar-website-dialog-field">
            <span>{t("sidebar.website.name")}</span>
            <input
              value={websiteLabel}
              onChange={(event) => setWebsiteLabel(event.target.value)}
              placeholder={t("sidebar.website.namePlaceholder")}
              maxLength={24}
              autoFocus
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>{t("sidebar.website.url")}</span>
            <input
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              placeholder="example.com"
              required
            />
          </label>
          <label className="sidebar-website-dialog-field">
            <span>{t("sidebar.website.sideAssistant")}</span>
            <select
              value={websiteAgentKey}
              onChange={(event) => setWebsiteAgentKey(event.target.value)}
              disabled={websiteCreatePending}
            >
              <option value="">{t("sidebar.website.defaultAssistant")}</option>
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
              onClick={closeWebsiteDialog}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="sidebar-website-primary-button"
              disabled={websiteCreatePending}
            >
              {websiteSubmitLabel}
            </button>
          </div>
        </form>
      </div>,
      document.body,
    );
  }

  function getSettingsSectionIcon(sectionId: SettingsSectionId): SidebarIllustrationKind {
    switch (sectionId) {
      case "usage":
        return "settings";
      case "general":
        return "settings";
      case "appearance":
        return "appearance";
      case "kanban":
        return "futures";
      case "assistant":
        return "assistant";
      case "market":
        return "market";
      case "control":
        return "control";
      case "tunnelHub":
        return "service";
      case "navigation":
        return "sidebar-assistant-closed";
      case "websites":
        return "website";
      case "about":
        return "about";
      case "debug":
        return "settings";
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
        <label className="sidebar-settings-search" aria-label={t("settings.searchAriaLabel")}>
          <span className="sidebar-settings-search-icon" aria-hidden="true">
            <SearchOutlined />
          </span>
          <input
            type="search"
            value={settingsSearchQuery}
            placeholder={t("settings.searchPlaceholder")}
            onChange={(event) => setSettingsSearchQuery(event.currentTarget.value)}
          />
        </label>
        <nav className="sidebar-settings-directory" aria-label={t("settings.directory")}>
          {groupedSettingsSections.length > 0 ? (
            groupedSettingsSections.map((group) => (
              <div className="settings-section-group" key={group.id}>
                <div className="settings-section-group-heading">
                  {t(group.labelKey)}
                </div>
                <div className="settings-section-group-items">
                  {group.sections.map((section) => {
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
                </div>
              </div>
            ))
          ) : (
            <div className="sidebar-settings-empty" role="status">
              {t("settings.searchNoResults")}
            </div>
          )}
        </nav>
      </div>
    );
  }

  const shouldRenderCollapsed = isCollapsed && !isSettingsMode;
  const activeFixedToolItem = fixedToolItems.find((item) =>
    isFixedToolRouteActive(item.to),
  );
  const settingsToolTriggerLabel = t("nav.settings");

  return (
    <aside className={shouldRenderCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="sidebar-chrome">
        <div className={chromeToolbarClassName}>
          <div className="sidebar-top-actions">
            {!isSettingsMode ? (
            <SidebarCollapseToggle
              className="sidebar-collapsed-toggle-button"
              isCollapsed={isCollapsed}
              variant="compact"
              onToggleCollapsed={onToggleCollapsed}
              t={t}
            />
            ) : null}
            {!isSettingsMode ? (
            <div className="sidebar-history-controls">
              <button
                type="button"
                className="sidebar-history-button"
                aria-label={t("sidebar.navigation.back")}
                title={t("sidebar.navigation.back")}
                disabled={!sidebarNavigationCanGoBack}
                onClick={onSidebarNavigateBack}
              >
                <LeftOutlined aria-hidden="true" />
              </button>
              <button
                type="button"
                className="sidebar-history-button"
                aria-label={t("sidebar.navigation.forward")}
                title={t("sidebar.navigation.forward")}
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
                    ? t("sidebar.copilot.unavailableForPage", { appName: PRODUCT_NAME })
                    : assistantDockOpen
                      ? t("sidebar.copilot.close", { appName: PRODUCT_NAME })
                      : t("sidebar.copilot.open", { appName: PRODUCT_NAME })
                }
                aria-disabled={assistantLauncherDisabled}
                aria-pressed={assistantDockOpen}
                disabled={assistantLauncherDisabled}
                title={t("sidebar.copilot.title")}
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
              onOpenChange={handleToolMenuOpenChange}
              className="sidebar-tool-menu-popover"
            >
              <button
                type="button"
                className={[
                  "sidebar-link",
                  "sidebar-link-utility",
                  "sidebar-tool-menu-trigger",
                  activeFixedToolItem
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
                <span className="sidebar-link-label">{settingsToolTriggerLabel}</span>
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
          {renderCreateProjectDialog()}
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
