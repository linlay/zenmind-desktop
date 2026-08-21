import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type Ref,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { CloseOutlined } from "@ant-design/icons";
import {
  SidebarActionIcon,
  SidebarIllustration,
  type SidebarIllustrationKind,
} from "../../components/BrandMark";
import { Favicon, type WebsiteFaviconCache } from "../../components/Favicon";
import { buildWebsiteFaviconUrl } from "../../../shared/website-favicon";
import type {
  AssistantCreateProjectRequest,
  AssistantNavAgentItem,
  AssistantNavChatItem,
  AssistantNavigationListOptions,
  DesktopSsoStatus,
  ServiceState,
  WebEntry,
  WebEntryKey,
  WebappDeleteResult,
  WebappExportResult,
  WebappImportResult,
  WebsiteInput,
  WebsiteResult,
  SidebarContextMenuActionId,
  SidebarContextMenuTarget,
} from "../../../shared/contracts";
import {
  formatEpochMillis,
  type EpochMilliseconds,
} from "../../../shared/time-contract";
import {
  createWebNavOrderKey,
  sortSidebarNavItems,
  type SidebarNavOrderItemKey,
} from "./sidebarNavOrder";
import { getAssistantWorkspaceName } from "./workspaceName";
import { AgentIcon } from "./AgentIcon";
import { Collapse } from "../../components/Collapse";
import { Tooltip } from "../../components/Tooltip";
import { Popover } from "../../components/Popover";
import { SettingsSidebarIcon } from "./SettingsSidebarIcon";
import { useI18n } from "../../i18n/useI18n";
import {
  getAssistantAwaitingStatusKey,
  getAssistantNavAgentAttentionChat,
  getAssistantNavAgentNonNegativeInteger,
  getAssistantNavAgentPreviewChats,
  getAssistantNavAgentRecentChats,
  getAssistantNavAgentSortedChats,
  isAssistantNavChatAgent,
  isAssistantNavProjectAgent,
} from "../../assistantNavigation";
import { getActiveServiceSurfaceWebviewRef } from "../../services/serviceSurfaceWebviewRefs";
import { PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/brand";
import {
  AGENT_WEBCLIENT_ROUTE_DEFINITIONS,
  createAgentWebclientAgentPath,
  createAgentWebclientManagementPath,
  createAgentWebclientRoute,
} from "../../../shared/agent-webclient-routes";
import { decodeRoutePathSegment } from "../../../shared/route-path";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../../../shared/service-webview-bridge";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";
import type {
  SettingsSectionGroupId,
  SettingsSectionId,
} from "../../../shared/settings-sections";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";
import { Flex, Modal } from "antd";
import {
  CAPABILITY_NAVIGATION_ITEMS,
  getCapabilityNavigationItem,
  type SidebarMode,
} from "./capabilityNavigation";
import { ConversationShareDialog } from "./ConversationShareDialog";
import { useConversationShareDialog } from "./useConversationShareDialog";
import { ChatInfoDialog } from "./ChatInfoDialog";
import { useChatInfoDialog } from "./useChatInfoDialog";

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

type SidebarChatsEntry = {
  orderKey: "chats";
  label: string;
  collapsedLabel?: string;
  icon: SidebarIllustrationKind;
  entryType: "chats";
};

type SidebarStandardPrimaryEntry = SidebarNavItem & {
  entryType?: "link" | "assistants" | "webs";
};

type SidebarPrimaryEntry = SidebarStandardPrimaryEntry | SidebarChatsEntry;

type SidebarGroupId = "assistants" | "chats" | "webs";

type SidebarContextMenuSubject =
  | {
      kind: "group";
      groupId: SidebarGroupId;
      menuScope?: "all" | "sort";
    }
  | { kind: "agent"; agentKey: string }
  | { kind: "chat"; chatId: string }
  | { kind: "web"; entryKey: string };

type SidebarGroupState = Record<SidebarGroupId, boolean>;

type SidebarNavigationOwner = "assistants" | "chats" | null;

type AgentRouteInfo = {
  agentKey: string;
  chatId: string;
  historyRequested: boolean;
  newChatRequested: boolean;
};

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

type MenuAnchorPoint = {
  x: number;
  y: number;
};

type SidebarFloatingMenuPosition = {
  anchorPoint: MenuAnchorPoint;
  horizontalAlign: "start" | "end";
  x: number;
  y: number;
  positioned: boolean;
};

type AssistantChatRenameDialogState = {
  chat: AssistantNavChatItem;
  value: string;
  pending: boolean;
  error: string;
};

type AssistantChatDeleteDialogState = {
  chat: AssistantNavChatItem;
  pending: boolean;
  error: string;
};

type AssistantChatRowOptions = {
  roving?: boolean;
  focusId?: string;
  navigationKind?: "chat" | "chats-chat";
  rowClassName?: string;
  itemClassName?: string;
  itemRef?: Ref<HTMLButtonElement>;
  rowRole?: "listitem";
  previewText?: string;
  wrapItem?: (item: ReactElement) => ReactNode;
};

type AgentSelectionOptions = {
  preferNewChat?: boolean;
};

type NavigateOptions = {
  retriggerAgentRoute?: boolean;
  focusAgentChat?: boolean;
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

type CreateProjectDialogState = {
  workspaceDir: string;
  projectType: CreateProjectType;
  useAcp: boolean;
  options: RunningCoderAcpProxyOption[];
  selectedAcpProxyId: string;
  pending: boolean;
  error: string;
};

type BootstrapGuideFloatingBubble = {
  id: "chat" | "tool-help";
  messageKey: TranslationKey;
  side: "left" | "right";
  style: CSSProperties;
};

type BootstrapGuideDismissedBubbles = {
  chat: boolean;
  help: boolean;
};

const SIDEBAR_GROUP_STATE_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-groups`;
const SIDEBAR_ASSISTANT_SORT_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-assistant-sort`;
const BOOTSTRAP_GUIDE_BUBBLE_WIDTH = 270;
const BOOTSTRAP_GUIDE_BUBBLE_GAP = 12;
const BOOTSTRAP_GUIDE_BUBBLE_MAX_VISIBLE_MS = 60_000;
const BOOTSTRAP_GUIDE_BUBBLE_VIEWPORT_MARGIN = 12;

function createInitialBootstrapGuideDismissedBubbles(): BootstrapGuideDismissedBubbles {
  return {
    chat: false,
    help: false,
  };
}

const defaultSidebarGroupState: SidebarGroupState = {
  assistants: true,
  chats: true,
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

const PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS = new Set<string>([
  "desktopAssistant",
  "webOperator",
]);
const HIDDEN_ASSISTANT_ROLE_MODES = new Set<string>(["CODER", "KBASE"]);
const CHATS_VISIBLE_LIMIT = 8;
const AGENT_WEBCLIENT_MANAGEMENT_ROUTE_PATHS: Set<string> = new Set(
  AGENT_WEBCLIENT_ROUTE_DEFINITIONS.filter(
    (routeDefinition) => routeDefinition.kind === "management",
  ).map((routeDefinition) => routeDefinition.routePath),
);

const kanbanNavItemBase: Omit<SidebarStandardPrimaryEntry, "label"> = {
  orderKey: "kanban",
  to: "/kanban",
  icon: "futures",
};

const schedulesNavItemBase: Omit<SidebarStandardPrimaryEntry, "label"> = {
  orderKey: "schedules",
  to: "/automations",
  icon: "schedule",
};

const chatsNavItemBase: Omit<SidebarChatsEntry, "label"> = {
  orderKey: "chats",
  icon: "chat",
  entryType: "chats",
};

function getAssistantAgentRoleLabel(agent: AssistantNavAgentItem) {
  const mode = agent.mode?.trim().toUpperCase() ?? "";
  if (HIDDEN_ASSISTANT_ROLE_MODES.has(mode)) {
    return "";
  }
  const role = agent.role?.trim() ?? "";
  if (!role || role === "--") {
    return "";
  }
  return role;
}

const assistantGroupNavItemBase: Omit<SidebarStandardPrimaryEntry, "label"> = {
  orderKey: "group:assistants",
  to: "",
  icon: "project",
  entryType: "assistants",
};

const websGroupNavItemBase: Omit<SidebarStandardPrimaryEntry, "label"> = {
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
        | "nav.mcpConnectors"
        | "nav.skills"
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
      orderKey: "skills",
      to: "/skills",
      labelKey: "nav.skills",
      icon: "skill",
    },
    {
      orderKey: "mcp-servers",
      to: "/mcp-servers",
      labelKey: "nav.mcpConnectors",
      icon: "connector",
    },
    {
      orderKey: "registries",
      to: "/registries",
      labelKey: "nav.registries",
      icon: "service",
    },
    {
      orderKey: "archives",
      to: "/archives",
      labelKey: "nav.archives",
      icon: "archive",
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
  const record = candidate as Partial<
    Record<SidebarGroupId | "websites", unknown>
  >;
  return {
    assistants:
      typeof record.assistants === "boolean"
        ? record.assistants
        : defaultSidebarGroupState.assistants,
    chats:
      typeof record.chats === "boolean"
        ? record.chats
        : defaultSidebarGroupState.chats,
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
  const servicesById = new Map(
    services.map((service) => [service.id, service]),
  );
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

function getRoutePathname(route: string) {
  return route.split("?")[0] || "/";
}

function isAgentWebclientManagementRoute(route: string) {
  return AGENT_WEBCLIENT_MANAGEMENT_ROUTE_PATHS.has(getRoutePathname(route));
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

const EMPTY_AGENT_ROUTE_INFO: AgentRouteInfo = {
  agentKey: "",
  chatId: "",
  historyRequested: false,
  newChatRequested: false,
};

function readAgentInfoFromWebclientPath(pathWithQuery: string): AgentRouteInfo {
  const normalized = pathWithQuery.trim();
  if (!normalized) {
    return EMPTY_AGENT_ROUTE_INFO;
  }
  try {
    const url = new URL(normalized, "http://agent-webclient.local");
    const match = /^\/agent\/([^/?#]+)/u.exec(url.pathname);
    return {
      agentKey: decodeRoutePathSegment(match?.[1]) ?? "",
      chatId: url.searchParams.get("chatId")?.trim() ?? "",
      historyRequested: url.searchParams.get("history")?.trim() === "1",
      newChatRequested: url.searchParams.has("newChat"),
    };
  } catch {
    return EMPTY_AGENT_ROUTE_INFO;
  }
}

function readAgentRouteInfo(route: string): AgentRouteInfo {
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
    return EMPTY_AGENT_ROUTE_INFO;
  }
  try {
    const searchParams = new URLSearchParams(route.slice(queryIndex + 1));
    return {
      agentKey: searchParams.get("agentKey")?.trim() ?? "",
      chatId: searchParams.get("chatId")?.trim() ?? "",
      historyRequested: searchParams.get("history")?.trim() === "1",
      newChatRequested: searchParams.has("newChat"),
    };
  } catch {
    return EMPTY_AGENT_ROUTE_INFO;
  }
}

function resolveSidebarNavigationOwner(
  routeInfo: AgentRouteInfo,
  agentsByKey: ReadonlyMap<string, AssistantNavAgentItem>,
  chatItems: readonly AssistantNavChatItem[],
  options: {
    bootstrapActive: boolean;
    bootstrapAgentKey: string;
    defaultChatAgentKey: string;
  },
): SidebarNavigationOwner {
  const agentKey = routeInfo.agentKey;
  if (!agentKey) {
    return null;
  }

  if (options.bootstrapActive && agentKey === options.bootstrapAgentKey) {
    return "chats";
  }

  const agent = agentsByKey.get(agentKey);
  if (isAssistantNavProjectAgent(agent)) {
    return "assistants";
  }
  if (isAssistantNavChatAgent(agent)) {
    return "chats";
  }

  if (
    routeInfo.chatId &&
    chatItems.some(
      (chat) => chat.agentKey === agentKey && chat.chatId === routeInfo.chatId,
    )
  ) {
    return "chats";
  }

  if (routeInfo.historyRequested) {
    return "assistants";
  }

  if (routeInfo.newChatRequested && agentKey === options.defaultChatAgentKey) {
    return "chats";
  }

  return null;
}

function createAgentRoute(agentKey: string) {
  return createAgentWebclientAgentPath(agentKey);
}

function createAgentChatRoute(agentKey: string, chatId: string) {
  return createAgentWebclientRoute({ agentKey, chatId });
}

function createAgentNewChatRoute(agentKey: string) {
  return `${createAgentRoute(agentKey)}?newChat=${Date.now()}`;
}

function createAgentDefaultRoute(agent: AssistantNavAgentItem) {
  const firstChatId =
    getAssistantNavAgentSortedChats(agent)[0]?.chatId ||
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
  const attentionChat = getAssistantNavAgentAttentionChat(agent);
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

function shouldShowAssistantInChats(agent: AssistantNavAgentItem) {
  return isAssistantNavChatAgent(agent);
}

function shouldShowAssistantInPrimaryNavigation(agent: AssistantNavAgentItem) {
  return (
    !PRIMARY_NAV_HIDDEN_ASSISTANT_AGENT_KEYS.has(agent.agentKey.trim()) &&
    isAssistantNavProjectAgent(agent)
  );
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
function formatAssistantChatTime(updatedAt?: EpochMilliseconds | null) {
  if (updatedAt === undefined || updatedAt === null) {
    return "";
  }

  const updatedDate = new Date(updatedAt);

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

function formatAssistantChatDateTime(value?: EpochMilliseconds | null) {
  if (value === undefined || value === null) {
    return "";
  }
  return formatEpochMillis(value);
}

function getAssistantChatDisplayText(
  chat: AssistantNavChatItem,
  t: TranslateFunction,
) {
  return chat.chatName || t("sidebar.chat.noPreview");
}

function readAssistantAgentLatestTimestamp(agent: AssistantNavAgentItem) {
  return agent.updatedAt ?? undefined;
}

function compareAssistantAgentsByTime(
  left: AssistantNavAgentItem,
  right: AssistantNavAgentItem,
) {
  const rightTime = readAssistantAgentLatestTimestamp(right);
  const leftTime = readAssistantAgentLatestTimestamp(left);
  if (
    rightTime !== undefined &&
    leftTime !== undefined &&
    rightTime !== leftTime
  ) {
    return rightTime - leftTime;
  }
  if (leftTime === undefined && rightTime !== undefined) {
    return 1;
  }
  if (leftTime !== undefined && rightTime === undefined) {
    return -1;
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

function createSidebarLinkFocusId(orderKey: SidebarNavOrderItemKey | string) {
  return `link:${orderKey}`;
}

function createSidebarGroupFocusId(groupId: SidebarGroupId) {
  return `group:${groupId}`;
}

function createSidebarAgentFocusId(agentKey: string) {
  return `agent:${agentKey}`;
}

function createSidebarAgentMoreFocusId(agentKey: string) {
  return `agent-more:${agentKey}`;
}

function createSidebarChatFocusId(chatId: string) {
  return `chat:${chatId}`;
}

function createSidebarChatsChatFocusId(chatId: string) {
  return `chats-chat:${chatId}`;
}

function createSidebarChatsMoreFocusId() {
  return "chats-more";
}

function createSidebarWebFocusId(entryKey: WebEntryKey | string) {
  return `web:${entryKey}`;
}

function createMenuPositionFromPoint(
  anchorPoint: MenuAnchorPoint,
  horizontalAlign: SidebarFloatingMenuPosition["horizontalAlign"] = "start",
): SidebarFloatingMenuPosition {
  return {
    anchorPoint,
    horizontalAlign,
    x: anchorPoint.x,
    y: anchorPoint.y,
    positioned: false,
  };
}

function getViewportClampedMenuPosition(
  position: SidebarFloatingMenuPosition,
  menu: HTMLElement,
) {
  const rect = menu.getBoundingClientRect();
  const viewportPadding = 8;
  const desiredLeft =
    position.horizontalAlign === "end"
      ? position.anchorPoint.x - rect.width
      : position.anchorPoint.x;
  const maxLeft = Math.max(
    viewportPadding,
    window.innerWidth - rect.width - viewportPadding,
  );
  const maxTop = Math.max(
    viewportPadding,
    window.innerHeight - rect.height - viewportPadding,
  );
  return {
    x: Math.round(
      Math.min(Math.max(desiredLeft, viewportPadding), maxLeft),
    ),
    y: Math.round(
      Math.min(Math.max(position.anchorPoint.y, viewportPadding), maxTop),
    ),
  };
}

type SidebarCollapseToggleVariant = "compact" | "nav";

type SidebarCollapseToggleProps = {
  isCollapsed: boolean;
  variant: SidebarCollapseToggleVariant;
  className?: string;
  onToggleCollapsed?: () => void;
  t: TranslateFunction;
};

function SidebarCollapseToggleIcon() {
  return (
    <SidebarActionIcon
      kind="sidebar_left"
      className="app-sidebar-collapse-button-icon-panel"
    />
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
      aria-label={
        isCollapsed ? t("nav.sidebar.expand") : t("nav.sidebar.collapse")
      }
      title={isCollapsed ? t("nav.sidebar.expand") : t("nav.sidebar.collapse")}
      aria-expanded={!isCollapsed}
      onClick={onToggleCollapsed}
    >
      <SidebarCollapseToggleIcon />
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
  assistantNavChatItems?: AssistantNavChatItem[];
  assistantNavChatItemsHasMore?: boolean;
  chatWorkPanelOpenChatIds?: string[];
  assistantNavAgentsLoaded?: boolean;
  websitesLoaded?: boolean;
  chatNavAgentOptions?: AssistantNavAgentItem[];
  copilotAgentOptions?: AssistantNavAgentItem[];
  chatDefaultAgentKey?: string;
  desktopSsoStatus?: DesktopSsoStatus | null;
  desktopSsoBusy?: boolean;
  bootstrapActive?: boolean;
  bootstrapAgentKey?: string;
  bootstrapChatId?: string;
  sidebarNavigationCanGoBack?: boolean;
  sidebarNavigationCanGoForward?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onDesktopSsoLogin?: () => void;
  onDesktopSsoLogout?: () => void;
  onRefreshDesktopSsoStatus?: () => Promise<void> | void;
  onRefreshAssistantNavAgents?: (
    options?: AssistantNavigationListOptions,
  ) => Promise<void> | void;
  onOpenAgentProjectEditor?: (agent: AssistantNavAgentItem) => void;
  onOpenChatWorkPanel?: (chatId: string, agentKey: string) => void;
  onCloseChatWorkPanel?: (chatId: string, force?: boolean) => void;
  onChatsDefaultAgentChange?: (agentKey: string) => Promise<void> | void;
  onRefreshCopilotAgentOptions?: () => Promise<void> | void;
  onCreateWebsiteItem?: (input: WebsiteInput) => Promise<WebsiteResult>;
  onImportWebappItem?: () => Promise<WebappImportResult>;
  onOpenWebappWindow?: (item: Extract<WebEntry, { kind: "webapp" }>) => void;
  onOpenWebappWorkspace?: (item: Extract<WebEntry, { kind: "webapp" }>) => void;
  webOpenEntryKeys?: WebEntryKey[];
  webRunningEntryKeys?: WebEntryKey[];
  faviconCache?: WebsiteFaviconCache;
  onCloseWebItem?: (item: WebEntry) => Promise<void> | void;
  onExportWebappItem?: (item: WebEntry) => Promise<WebappExportResult>;
  onRemoveWebappItem?: (item: WebEntry) => Promise<WebappDeleteResult>;
  onRequestNavigate?: (targetPath: string) => boolean;
  onRequestAgentChatNavigate?: (targetPath: string) => boolean;
  onSidebarNavigateBack?: () => void;
  onSidebarNavigateForward?: () => void;
  onNavigateItem?: () => void;
  onOpenGlobalSearch?: () => void;
  onToggleCollapsed?: () => void;
  sidebarMode?: SidebarMode;
  settingsSections?: SettingsSidebarSection[];
  activeSettingsSectionId?: SettingsSectionId | null;
  onSelectSettingsSection?: (sectionId: SettingsSectionId) => void;
  onExitSecondarySidebarMode?: () => void;
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
  assistantNavChatItems = [],
  assistantNavChatItemsHasMore = false,
  chatWorkPanelOpenChatIds = [],
  assistantNavAgentsLoaded = true,
  websitesLoaded = true,
  chatNavAgentOptions = [],
  copilotAgentOptions = [],
  chatDefaultAgentKey = "",
  desktopSsoStatus = null,
  desktopSsoBusy = false,
  bootstrapActive = false,
  bootstrapAgentKey = "",
  bootstrapChatId = "",
  sidebarNavigationCanGoBack = false,
  sidebarNavigationCanGoForward = false,
  onOpenAssistantDock,
  onCloseAssistantDock,
  onDesktopSsoLogin,
  onDesktopSsoLogout,
  onRefreshDesktopSsoStatus,
  onRefreshAssistantNavAgents,
  onOpenAgentProjectEditor,
  onOpenChatWorkPanel,
  onCloseChatWorkPanel,
  onChatsDefaultAgentChange,
  onRefreshCopilotAgentOptions,
  onCreateWebsiteItem,
  onImportWebappItem,
  onOpenWebappWindow,
  onOpenWebappWorkspace,
  webOpenEntryKeys = [],
  webRunningEntryKeys = [],
  faviconCache,
  onCloseWebItem,
  onExportWebappItem,
  onRemoveWebappItem,
  onRequestNavigate,
  onRequestAgentChatNavigate,
  onSidebarNavigateBack,
  onSidebarNavigateForward,
  onNavigateItem,
  onOpenGlobalSearch,
  onToggleCollapsed,
  sidebarMode = "primary",
  settingsSections = [],
  activeSettingsSectionId = null,
  onSelectSettingsSection,
  onExitSecondarySidebarMode,
}: AppSidebarProps) {
  const { t } = useI18n();
  const isPrimaryMode = sidebarMode === "primary";
  const isCapabilitiesMode = sidebarMode === "capabilities";
  const isSettingsMode = sidebarMode === "settings";
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(
    readInitialSidebarGroupState,
  );
  const [assistantNavSortMode, setAssistantNavSortMode] =
    useState<AssistantNavSortMode>(readInitialAssistantNavSortMode);
  const [refreshingAssistantNavAgents, setRefreshingAssistantNavAgents] =
    useState(false);
  const [chatDefaultAgentMenuOpen, setChatDefaultAgentMenuOpen] =
    useState(false);
  const [chatDefaultAgentMenuAnchorPoint, setChatDefaultAgentMenuAnchorPoint] =
    useState<MenuAnchorPoint | null>(null);
  const [
    chatDefaultAgentInlineMenuPosition,
    setChatDefaultAgentInlineMenuPosition,
  ] = useState<{ left: number; top: number } | null>(null);
  const [chatDefaultAgentPending, setChatDefaultAgentPending] = useState(false);
  const [chatDefaultAgentError, setChatDefaultAgentError] = useState("");
  const [sidebarNavFocusId, setSidebarNavFocusId] = useState("");
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [bootstrapGuideFloatingBubbles, setBootstrapGuideFloatingBubbles] =
    useState<BootstrapGuideFloatingBubble[]>([]);
  const [bootstrapGuideDismissedBubbles, setBootstrapGuideDismissedBubbles] =
    useState<BootstrapGuideDismissedBubbles>(
      createInitialBootstrapGuideDismissedBubbles,
    );
  const [bootstrapGuideCardDismissed, setBootstrapGuideCardDismissed] =
    useState(false);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [forcedActiveManagementRoute, setForcedActiveManagementRoute] =
    useState("");
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
  const [webClosePendingEntryKey, setWebClosePendingEntryKey] = useState("");
  const [webItemRemovePendingId, setWebItemRemovePendingId] = useState("");
  const [webItemExportPendingId, setWebItemExportPendingId] = useState("");
  const [webappImportFailure, setWebappImportFailure] = useState<{
    message: string;
    diagnostic?: WebappImportResult["diagnostic"];
  } | null>(null);
  const [assistantChatRenameDialog, setAssistantChatRenameDialog] =
    useState<AssistantChatRenameDialogState | null>(null);
  const [assistantChatDeleteDialog, setAssistantChatDeleteDialog] =
    useState<AssistantChatDeleteDialogState | null>(null);
  const conversationShareDialog = useConversationShareDialog(t);
  const chatInfoDialog = useChatInfoDialog(t);
  const lastAutoExpandedAssistantAgentKeyRef = useRef("");
  const lastRouteAgentInfoRef = useRef(readAgentRouteInfo(currentRoute));
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const toolMenuOpenRequestIdRef = useRef(0);
  const bootstrapGuideToolMenuAutoOpenedRef = useRef(false);
  const bootstrapGuideChatAnchorRef = useRef<HTMLButtonElement | null>(null);
  const bootstrapGuideToolHelpAnchorRef = useRef<HTMLAnchorElement | null>(
    null,
  );
  const chatDefaultAgentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const chatDefaultAgentPickerRef = useRef<HTMLDivElement | null>(null);
  const chatDefaultAgentMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarContextMenuRequestIdRef = useRef(0);
  const assistantNavAgentsRef = useRef(assistantNavAgents);
  const webItemsRef = useRef(webItems);
  assistantNavAgentsRef.current = assistantNavAgents;
  webItemsRef.current = webItems;
  const forcedActiveManagementPathname = forcedActiveManagementRoute
    ? getRoutePathname(forcedActiveManagementRoute)
    : "";
  const displayCurrentRoute = forcedActiveManagementRoute || currentRoute;
  const displayCurrentPathname =
    forcedActiveManagementPathname || currentPathname;
  const currentRouteAgentInfo = readAgentRouteInfo(displayCurrentRoute);
  const pendingRouteAgentInfo =
    pendingPath && !forcedActiveManagementRoute
      ? readAgentRouteInfo(pendingPath)
      : EMPTY_AGENT_ROUTE_INFO;
  const currentAgentKey = currentRouteAgentInfo.agentKey;
  const currentChatId = currentRouteAgentInfo.chatId;
  const pendingAgentKey = pendingRouteAgentInfo.agentKey;
  const activeNavigationRouteInfo = pendingAgentKey
    ? pendingRouteAgentInfo
    : currentRouteAgentInfo;
  const activeSidebarAgentKey = activeNavigationRouteInfo.agentKey;
  const activeSidebarChatId = activeNavigationRouteInfo.chatId;
  const normalizedBootstrapAgentKey = bootstrapAgentKey.trim();
  const normalizedBootstrapChatId = bootstrapChatId.trim();
  const showBootstrapChatGuide =
    bootstrapActive && !bootstrapGuideDismissedBubbles.chat;
  const showBootstrapHelpGuide =
    bootstrapActive && !bootstrapGuideDismissedBubbles.help;
  const showBootstrapGuideCard =
    bootstrapActive &&
    !bootstrapGuideCardDismissed &&
    isPrimaryMode &&
    !isCollapsed;
  const primaryAssistantNavAgents = useMemo(
    () => assistantNavAgents.filter(shouldShowAssistantInPrimaryNavigation),
    [assistantNavAgents],
  );
  const normalizedChatDefaultAgentKey = chatDefaultAgentKey.trim();
  const chatDefaultAgent = useMemo(
    () =>
      chatNavAgentOptions.find(
        (agent) => agent.agentKey === normalizedChatDefaultAgentKey,
      ) ?? null,
    [chatNavAgentOptions, normalizedChatDefaultAgentKey],
  );
  const resolvedChatDefaultAgent = chatDefaultAgent;
  const resolvedChatDefaultAgentKey =
    resolvedChatDefaultAgent?.agentKey.trim() ?? "";
  const sidebarChatItems = useMemo(
    () => assistantNavChatItems.slice(0, CHATS_VISIBLE_LIMIT),
    [assistantNavChatItems],
  );
  const chatNavigationAgentsByKey = useMemo(
    () =>
      new Map(
        [...assistantNavAgents, ...chatNavAgentOptions].map((agent) => [
          agent.agentKey,
          agent,
        ]),
      ),
    [assistantNavAgents, chatNavAgentOptions],
  );
  const navigationOwner = resolveSidebarNavigationOwner(
    activeNavigationRouteInfo,
    chatNavigationAgentsByKey,
    assistantNavChatItems,
    {
      bootstrapActive,
      bootstrapAgentKey: normalizedBootstrapAgentKey,
      defaultChatAgentKey: resolvedChatDefaultAgentKey,
    },
  );
  const chatStatusSummary = useMemo(
    () => ({
      unreadCount: sidebarChatItems.filter((chat) => !chat.isRead).length,
      pendingCount: sidebarChatItems.filter((chat) => chat.hasPendingAwaiting)
        .length,
    }),
    [sidebarChatItems],
  );
  const bootstrapSeedChatIndexed = Boolean(
    bootstrapActive &&
    normalizedBootstrapChatId &&
    sidebarChatItems.some(
      (chat) =>
        chat.chatId === normalizedBootstrapChatId &&
        chat.agentKey === normalizedBootstrapAgentKey,
    ),
  );
  const showBootstrapChatFallback = Boolean(
    bootstrapActive &&
    normalizedBootstrapAgentKey &&
    !bootstrapSeedChatIndexed,
  );
  const chatDefaultAgentAvailable = Boolean(resolvedChatDefaultAgentKey);
  const chatDefaultAgentUnavailable =
    assistantNavAgentsLoaded && !chatDefaultAgentAvailable;
  const sidebarContextMenuRuntimeRef = useRef({
    creatingProject,
    hasCreateProjectDialog: Boolean(createProjectDialog),
    resolvedChatDefaultAgentKey,
    chatDefaultAgentUnavailable,
    webOpenEntryKeys,
    webClosePendingEntryKey,
    webItemRemovePendingId,
    webItemExportPendingId,
    isCollapsed,
    onOpenAgentProjectEditor,
    onOpenWebappWorkspace,
    onOpenWebappWindow,
    onExportWebappItem,
  });
  sidebarContextMenuRuntimeRef.current = {
    creatingProject,
    hasCreateProjectDialog: Boolean(createProjectDialog),
    resolvedChatDefaultAgentKey,
    chatDefaultAgentUnavailable,
    webOpenEntryKeys,
    webClosePendingEntryKey,
    webItemRemovePendingId,
    webItemExportPendingId,
    isCollapsed,
    onOpenAgentProjectEditor,
    onOpenWebappWorkspace,
    onOpenWebappWindow,
    onExportWebappItem,
  };
  const chatsHistoryAvailable =
    assistantNavChatItemsHasMore &&
    Boolean(resolvedChatDefaultAgentKey) &&
    !chatDefaultAgentUnavailable;
  const activeChatsOverviewChatId = sidebarChatItems.some(
    (chat) => chat.chatId === activeSidebarChatId,
  )
    ? activeSidebarChatId
    : "";
  const assistantStatusSummary = useMemo(
    () => summarizeAgentStatus(primaryAssistantNavAgents),
    [primaryAssistantNavAgents],
  );
  const sortedAssistantNavAgents = useMemo(
    () =>
      sortAssistantNavAgentsForMode(
        primaryAssistantNavAgents,
        assistantNavSortMode,
      ),
    [primaryAssistantNavAgents, assistantNavSortMode],
  );
  const assistantNavSortLabel =
    assistantNavSortMode === "byName"
      ? t("sidebar.assistants.sortByName")
      : t("sidebar.assistants.sortByTime");

  const normalizedSettingsSearchQuery = settingsSearchQuery
    .trim()
    .toLocaleLowerCase();
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
      {
        ...schedulesNavItemBase,
        label: t("nav.schedules"),
        collapsedLabel: t("nav.schedulesCollapsed"),
      },
      {
        ...chatsNavItemBase,
        label: t("nav.chats"),
      },
      {
        ...assistantGroupNavItemBase,
        label: t("nav.assistants"),
      },
      {
        ...websGroupNavItemBase,
        label: t("nav.websites"),
      },
    ].filter((item) =>
      sidebarNavOrder.includes(item.orderKey),
    ) as SidebarPrimaryEntry[],
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
  const capabilityNavigationItems = CAPABILITY_NAVIGATION_ITEMS.map(
    (item) => ({ ...item, label: t(item.labelKey) }),
  );
  const settingsToolItem = fixedToolItems.find(
    (item) => item.to === "/settings",
  );
  const helpToolItem: SidebarToolItem = {
    orderKey: "help",
    to: "/help",
    label: t("nav.help"),
    icon: "help",
  };
  const chromeToolbarClassName = [
    "sidebar-chrome-toolbar",
    isMac ? "is-mac" : isWindows ? "is-windows" : "is-default",
  ].join(" ");
  const defaultSidebarNavFocusId = useMemo(() => {
    if (!isPrimaryMode) {
      return "";
    }

    const activeTopLevelItem = navItems.find((item) => {
      if (item.entryType) {
        return false;
      }
      return isRouteActive(item.to);
    });
    if (activeTopLevelItem) {
      return createSidebarLinkFocusId(activeTopLevelItem.orderKey);
    }

    if (navigationOwner === "chats") {
      if (!isCollapsed && sidebarGroupState.chats) {
        return activeChatsOverviewChatId
          ? createSidebarChatsChatFocusId(activeChatsOverviewChatId)
          : createSidebarGroupFocusId("chats");
      }
      return createSidebarGroupFocusId("chats");
    }

    if (navigationOwner === "assistants") {
      if (
        !isCollapsed &&
        sidebarGroupState.assistants &&
        activeSidebarAgentKey
      ) {
        return createSidebarAgentFocusId(activeSidebarAgentKey);
      }
      return createSidebarGroupFocusId("assistants");
    }

    if (isWebsiteGroupActive()) {
      const activeWebItem = webNavItems.find((item) => isRouteActive(item.to));
      if (!isCollapsed && sidebarGroupState.webs && activeWebItem?.webItem) {
        return createSidebarWebFocusId(activeWebItem.webItem.entryKey);
      }
      return createSidebarGroupFocusId("webs");
    }

    const firstItem = navItems[0];
    if (!firstItem) {
      return "";
    }
    if (firstItem.entryType === "assistants") {
      return createSidebarGroupFocusId("assistants");
    }
    if (firstItem.entryType === "chats") {
      return createSidebarGroupFocusId("chats");
    }
    if (firstItem.entryType === "webs") {
      return createSidebarGroupFocusId("webs");
    }
    return createSidebarLinkFocusId(firstItem.orderKey);
  }, [
    activeSidebarAgentKey,
    navigationOwner,
    currentPathname,
    currentRoute,
    isCollapsed,
    isPrimaryMode,
    navItems,
    pendingPath,
    sidebarGroupState.assistants,
    sidebarGroupState.chats,
    sidebarGroupState.webs,
    activeChatsOverviewChatId,
    webNavItems,
  ]);
  const resolvedSidebarNavFocusId =
    sidebarNavFocusId || defaultSidebarNavFocusId;

  useEffect(() => {
    if (!isSettingsMode) {
      setSettingsSearchQuery("");
    }
  }, [isSettingsMode]);

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
    const currentDialog = assistantChatDeleteDialog;
    if (!currentDialog) {
      return undefined;
    }
    const canCloseDialog = !currentDialog.pending;

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && canCloseDialog) {
        setAssistantChatDeleteDialog(null);
      }
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [assistantChatDeleteDialog]);

  useLayoutEffect(() => {
    if (
      !isCollapsed ||
      !chatDefaultAgentMenuOpen ||
      !chatDefaultAgentMenuAnchorPoint
    ) {
      setChatDefaultAgentInlineMenuPosition(null);
      return;
    }

    const picker = chatDefaultAgentPickerRef.current;
    const menu = chatDefaultAgentMenuRef.current;
    if (!picker || !menu) {
      return;
    }

    const pickerRect = picker.getBoundingClientRect();
    const position = getViewportClampedMenuPosition(
      createMenuPositionFromPoint(chatDefaultAgentMenuAnchorPoint),
      menu,
    );
    setChatDefaultAgentInlineMenuPosition({
      left: position.x - pickerRect.left,
      top: position.y - pickerRect.top,
    });
  }, [
    chatDefaultAgentMenuAnchorPoint,
    chatDefaultAgentMenuOpen,
    isCollapsed,
  ]);

  useEffect(() => {
    if (!bootstrapActive) {
      bootstrapGuideToolMenuAutoOpenedRef.current = false;
      setBootstrapGuideCardDismissed(false);
      setBootstrapGuideDismissedBubbles((current) =>
        current.chat || current.help
          ? createInitialBootstrapGuideDismissedBubbles()
          : current,
      );
      setBootstrapGuideFloatingBubbles([]);
      return;
    }
    if (isPrimaryMode && !bootstrapGuideToolMenuAutoOpenedRef.current) {
      bootstrapGuideToolMenuAutoOpenedRef.current = true;
      setToolMenuOpen(true);
    }
  }, [bootstrapActive, isPrimaryMode]);

  useEffect(() => {
    if (!bootstrapActive || typeof window === "undefined") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setBootstrapGuideDismissedBubbles({
        chat: true,
        help: true,
      });
      setBootstrapGuideFloatingBubbles([]);
    }, BOOTSTRAP_GUIDE_BUBBLE_MAX_VISIBLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [bootstrapActive]);

  useEffect(() => {
    if (!bootstrapActive || typeof window === "undefined") {
      setBootstrapGuideFloatingBubbles([]);
      return undefined;
    }

    let frameId = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        setBootstrapGuideFloatingBubbles(getBootstrapGuideFloatingBubbles());
      });
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.cancelAnimationFrame(frameId);
    };
  }, [
    bootstrapActive,
    bootstrapGuideDismissedBubbles.chat,
    bootstrapGuideDismissedBubbles.help,
    bootstrapSeedChatIndexed,
    isCollapsed,
    isPrimaryMode,
    normalizedBootstrapAgentKey,
    normalizedBootstrapChatId,
    toolMenuOpen,
  ]);

  useEffect(() => {
    if (!forcedActiveManagementRoute) {
      return;
    }
    if (isAgentWebclientManagementRoute(currentRoute)) {
      return;
    }
    setForcedActiveManagementRoute("");
  }, [currentRoute, forcedActiveManagementRoute]);

  useEffect(() => {
    if (!isPrimaryMode) {
      if (sidebarNavFocusId) {
        setSidebarNavFocusId("");
      }
      return;
    }

    const visibleItems = getVisibleSidebarRovingElements();
    if (visibleItems.length === 0) {
      return;
    }
    const hasResolvedItem = visibleItems.some(
      (item) => item.dataset.sidebarNavId === resolvedSidebarNavFocusId,
    );
    if (!hasResolvedItem) {
      setSidebarNavFocusId(visibleItems[0].dataset.sidebarNavId || "");
    }
  }, [
    expandedAssistantAgentKey,
    isCollapsed,
    isPrimaryMode,
    navItems,
    resolvedSidebarNavFocusId,
    sidebarGroupState.assistants,
    sidebarGroupState.chats,
    sidebarGroupState.webs,
    sidebarNavFocusId,
    sortedAssistantNavAgents,
    webNavItems,
  ]);

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
    const targetIsAgentWebclientManagementRoute =
      isAgentWebclientManagementRoute(targetPath);
    if (!targetIsAgentWebclientManagementRoute && forcedActiveManagementRoute) {
      setForcedActiveManagementRoute("");
    }
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (
      targetPath === currentRoute ||
      (!targetPath.includes("?") && targetPathname === currentPathname)
    ) {
      event.preventDefault();
      if (targetIsAgentWebclientManagementRoute) {
        setForcedActiveManagementRoute(targetPath);
        dispatchAgentWebclientRouteToActiveWebview(targetPath);
        onNavigateItem?.();
      }
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
    if (targetPath === "/help") {
      dismissBootstrapGuideBubble("help");
    }
    handleItemClick(event, targetPath);
    closeToolMenu();
  }

  function createBootstrapChatTargetRoute() {
    if (!normalizedBootstrapAgentKey) {
      return "";
    }
    return bootstrapSeedChatIndexed && normalizedBootstrapChatId
      ? createAgentChatRoute(
          normalizedBootstrapAgentKey,
          normalizedBootstrapChatId,
        )
      : createAgentNewChatRoute(normalizedBootstrapAgentKey);
  }

  function handleBootstrapGuideOpenChat() {
    const targetRoute = createBootstrapChatTargetRoute();
    if (!targetRoute) {
      return;
    }
    dismissBootstrapGuideBubble("chat");
    requestNavigate(targetRoute, { retriggerAgentRoute: true });
  }

  function handleBootstrapGuideOpenHelp() {
    dismissBootstrapGuideBubble("help");
    requestNavigate("/help");
    closeToolMenu();
  }

  function dispatchAgentWebclientRouteToActiveWebview(targetPath: string) {
    const targetAgentInfo = readAgentRouteInfo(targetPath);
    if (
      !isAgentWebclientManagementRoute(targetPath) &&
      !targetAgentInfo.agentKey
    ) {
      return false;
    }

    const webview = getActiveServiceSurfaceWebviewRef()?.current;
    if (!webview) {
      return false;
    }

    if (targetAgentInfo.historyRequested) {
      try {
        webview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
          action: "openChatHistory",
          data: {
            workerKey: `agent:${targetAgentInfo.agentKey}`,
            agentKey: targetAgentInfo.agentKey,
          },
        });
        return true;
      } catch (error) {
        console.warn("[assistant] failed to open agent history", error);
        return false;
      }
    }

    const script = `(() => {
      const target = new URL(${JSON.stringify(targetPath)}, window.location.href);
      const oldUrl = window.location.href;
      const nextPath = target.pathname + target.search + target.hash;
      const currentPath = window.location.pathname + window.location.search + window.location.hash;
      if (nextPath !== currentPath) {
        window.history.pushState(window.history.state, "", nextPath);
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
        if (new URL(oldUrl).hash !== target.hash) {
          window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: oldUrl, newURL: target.href }));
        }
      }
      true;
    })()`;

    void webview.executeJavaScript(script, true).catch((error: unknown) => {
      console.warn(
        "[assistant] failed to retrigger agent-webclient route",
        error,
      );
    });
    return true;
  }

  function requestNavigate(targetPath: string, options: NavigateOptions = {}) {
    if (options.retriggerAgentRoute) {
      const targetAgentInfo = readAgentRouteInfo(targetPath);
      if (
        targetPath === currentRoute ||
        targetAgentInfo.historyRequested ||
        targetAgentInfo.newChatRequested
      ) {
        dispatchAgentWebclientRouteToActiveWebview(targetPath);
      }
    }

    if (targetPath === currentRoute) {
      return;
    }
    const requestNavigation = options.focusAgentChat
      ? onRequestAgentChatNavigate ?? onRequestNavigate
      : onRequestNavigate;
    if (requestNavigation && !requestNavigation(targetPath)) {
      return;
    }
    onNavigateItem?.();
  }

  function getSidebarRovingItemProps(id: string, enabled = true) {
    if (!enabled || !isPrimaryMode) {
      return {};
    }
    return {
      "data-sidebar-roving-item": "true",
      "data-sidebar-nav-id": id,
      tabIndex: resolvedSidebarNavFocusId === id ? 0 : -1,
      onFocus: () => setSidebarNavFocusId(id),
    };
  }

  function getVisibleSidebarRovingElements() {
    const sidebarNav = sidebarNavRef.current;
    if (!sidebarNav) {
      return [];
    }
    return Array.from(
      sidebarNav.querySelectorAll<HTMLElement>(
        '[data-sidebar-roving-item="true"]',
      ),
    ).filter((element) => {
      if (element.closest('[aria-hidden="true"]')) {
        return false;
      }
      if (element instanceof HTMLButtonElement && element.disabled) {
        return false;
      }
      return true;
    });
  }

  function focusSidebarRovingElement(element: HTMLElement) {
    const focusId = element.dataset.sidebarNavId;
    if (focusId) {
      setSidebarNavFocusId(focusId);
    }
    element.focus();
  }

  function focusSidebarRovingItemById(focusId: string) {
    const element = getVisibleSidebarRovingElements().find(
      (item) => item.dataset.sidebarNavId === focusId,
    );
    if (!element) {
      return false;
    }
    focusSidebarRovingElement(element);
    return true;
  }

  function moveSidebarRovingFocus(
    currentElement: HTMLElement,
    direction: "first" | "last" | "next" | "previous",
  ) {
    const items = getVisibleSidebarRovingElements();
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(currentElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : 0;
    if (direction === "first") {
      nextIndex = 0;
    } else if (direction === "last") {
      nextIndex = items.length - 1;
    } else if (direction === "next") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
    } else {
      nextIndex =
        currentIndex >= 0
          ? (currentIndex - 1 + items.length) % items.length
          : items.length - 1;
    }
    focusSidebarRovingElement(items[nextIndex]);
  }

  function readSidebarGroupId(
    value: string | undefined,
  ): SidebarGroupId | null {
    return value === "assistants" || value === "chats" || value === "webs"
      ? value
      : null;
  }

  function findAssistantNavAgent(agentKey: string) {
    return (
      assistantNavAgentsRef.current.find(
        (agent) => agent.agentKey === agentKey,
      ) || null
    );
  }

  function findAssistantNavChat(chatId: string) {
    for (const agent of assistantNavAgentsRef.current) {
      const chat = getAssistantNavAgentRecentChats(agent).find(
        (item) => item.chatId === chatId,
      );
      if (chat) {
        return chat;
      }
    }
    return null;
  }

  function findWebItem(entryKey: string) {
    return (
      webItemsRef.current.find((item) => item.entryKey === entryKey) || null
    );
  }

  function getSidebarContextMenuTarget(
    subject: SidebarContextMenuSubject,
  ): SidebarContextMenuTarget | null {
    const runtime = sidebarContextMenuRuntimeRef.current;
    if (subject.kind === "group") {
      return {
        kind: "group",
        groupId: subject.groupId,
        menuScope: subject.menuScope ?? "all",
        sortMode: assistantNavSortMode,
        canCreateProject:
          !runtime.creatingProject && !runtime.hasCreateProjectDialog,
        canCreateChat:
          Boolean(runtime.resolvedChatDefaultAgentKey) &&
          !runtime.chatDefaultAgentUnavailable,
      };
    }
    if (subject.kind === "agent") {
      const agent = findAssistantNavAgent(subject.agentKey);
      return agent
        ? {
            kind: "agent",
            canRevealWorkspace: !getRevealWorkspaceDisabledReason(agent),
            canOpenProjectEditor:
              Boolean(runtime.onOpenAgentProjectEditor) &&
              canOpenAgentProjectEditor(agent),
          }
        : null;
    }
    if (subject.kind === "chat") {
      return findAssistantNavChat(subject.chatId)
        ? { kind: "chat", workPanelOpen: chatWorkPanelOpenChatIds.includes(subject.chatId) }
        : null;
    }

    const item = findWebItem(subject.entryKey);
    if (!item) {
      return null;
    }
    const isWebapp = item.kind === "webapp";
    return {
      kind: "web",
      webKind: item.kind,
      openMode:
        item.kind === "webapp" && item.openMode === "dialog"
          ? "dialog"
          : "window",
      canClose:
        runtime.webOpenEntryKeys.includes(item.entryKey) &&
        !runtime.webClosePendingEntryKey,
      canOpenAlternative: isWebapp
        ? item.openMode === "dialog"
          ? Boolean(runtime.onOpenWebappWorkspace)
          : Boolean(runtime.onOpenWebappWindow)
        : false,
      canExport:
        isWebapp &&
        Boolean(runtime.onExportWebappItem) &&
        !runtime.webItemExportPendingId,
      canRemove:
        isWebapp &&
        item.removable !== false &&
        !runtime.webItemRemovePendingId,
      showRemove: isWebapp && !runtime.isCollapsed,
    };
  }

  function isSidebarContextMenuActionEnabled(
    target: SidebarContextMenuTarget,
    actionId: SidebarContextMenuActionId,
  ) {
    if (target.kind === "group") {
      if (
        actionId === "group.sort-by-time" ||
        actionId === "group.sort-by-name"
      ) {
        return target.groupId === "assistants";
      }
      if (actionId === "group.new-project") {
        return target.groupId === "assistants" && target.canCreateProject;
      }
      if (actionId === "group.new-chat") {
        return target.groupId === "chats" && target.canCreateChat;
      }
      return (
        target.groupId === "webs" &&
        (actionId === "group.add-website" ||
          actionId === "group.import-webapp")
      );
    }
    if (target.kind === "agent") {
      return (
        actionId === "agent.edit" ||
        (actionId === "agent.reveal-workspace" && target.canRevealWorkspace) ||
        (actionId === "agent.open-project-editor" &&
          target.canOpenProjectEditor)
      );
    }
    if (target.kind === "chat") {
      return [
        "chat.export",
        "chat.share",
        "chat.rename",
        "chat.workPanel.open",
        "chat.workPanel.close",
        "chat.archive",
        "chat.delete",
        "chat.info",
      ].includes(actionId);
    }
    if (actionId === "web.close") return target.canClose;
    if (actionId === "web.open-in-workspace") {
      return (
        target.webKind === "webapp" &&
        target.openMode === "dialog" &&
        target.canOpenAlternative
      );
    }
    if (actionId === "web.open-in-window") {
      return (
        target.webKind === "webapp" &&
        target.openMode === "window" &&
        target.canOpenAlternative
      );
    }
    if (actionId === "web.export") {
      return target.webKind === "webapp" && target.canExport;
    }
    return (
      actionId === "web.remove" &&
      target.webKind === "webapp" &&
      target.showRemove &&
      target.canRemove
    );
  }

  async function executeSidebarContextMenuAction(
    subject: SidebarContextMenuSubject,
    actionId: SidebarContextMenuActionId,
  ) {
    const currentTarget = getSidebarContextMenuTarget(subject);
    if (
      !currentTarget ||
      !isSidebarContextMenuActionEnabled(currentTarget, actionId)
    ) {
      return;
    }
    if (subject.kind === "group") {
      if (actionId === "group.sort-by-time") {
        setAssistantNavSortMode("byTime");
      } else if (actionId === "group.sort-by-name") {
        setAssistantNavSortMode("byName");
      } else if (
        actionId === "group.new-project" &&
        currentTarget.kind === "group" &&
        currentTarget.canCreateProject
      ) {
        await beginCreateProject();
      } else if (actionId === "group.new-chat") {
        startChatsNewChat();
      } else if (actionId === "group.add-website") {
        showWebsiteDialog();
      } else if (actionId === "group.import-webapp") {
        await handleImportWebapp();
      }
      return;
    }

    if (subject.kind === "agent") {
      const agent = findAssistantNavAgent(subject.agentKey);
      if (!agent) return;
      if (
        actionId === "agent.reveal-workspace" &&
        !getRevealWorkspaceDisabledReason(agent)
      ) {
        await handleRevealWorkspace(agent);
      } else if (
        actionId === "agent.open-project-editor" &&
        canOpenAgentProjectEditor(agent)
      ) {
        sidebarContextMenuRuntimeRef.current.onOpenAgentProjectEditor?.(agent);
      } else if (actionId === "agent.edit") {
        handleEditAgent(agent);
      }
      return;
    }

    if (subject.kind === "chat") {
      const chat = findAssistantNavChat(subject.chatId);
      if (!chat) return;
      if (actionId === "chat.export") {
        await handleAssistantExportChat(chat);
      } else if (actionId === "chat.share") {
        conversationShareDialog.open(chat.chatId, chat.chatName);
      } else if (actionId === "chat.rename") {
        handleAssistantRenameChat(chat);
      } else if (actionId === "chat.workPanel.open") {
        onOpenChatWorkPanel?.(chat.chatId, chat.agentKey.trim() || currentAgentKey);
      } else if (actionId === "chat.workPanel.close") {
        onCloseChatWorkPanel?.(chat.chatId);
      } else if (actionId === "chat.archive") {
        await handleAssistantArchiveChat(chat);
      } else if (actionId === "chat.delete") {
        await handleAssistantDeleteChat(chat);
      } else if (actionId === "chat.info") {
        chatInfoDialog.open(chat);
      }
      return;
    }

    const item = findWebItem(subject.entryKey);
    if (!item) return;
    const runtime = sidebarContextMenuRuntimeRef.current;
    if (
      actionId === "web.close" &&
      runtime.webOpenEntryKeys.includes(item.entryKey) &&
      !runtime.webClosePendingEntryKey
    ) {
      await closeWebItem(item);
    } else if (
      actionId === "web.open-in-workspace" &&
      item.kind === "webapp" &&
      item.openMode === "dialog"
    ) {
      runtime.onOpenWebappWorkspace?.(item);
    } else if (
      actionId === "web.open-in-window" &&
      item.kind === "webapp" &&
      item.openMode !== "dialog"
    ) {
      runtime.onOpenWebappWindow?.(item);
    } else if (actionId === "web.export" && item.kind === "webapp") {
      await exportWebappItem(item);
    } else if (
      actionId === "web.remove" &&
      item.kind === "webapp" &&
      item.removable !== false
    ) {
      await removeWebappItem(item);
    }
  }

  function openNativeSidebarContextMenu(
    subject: SidebarContextMenuSubject,
    element: HTMLElement,
    point?: MenuAnchorPoint,
  ) {
    const target = getSidebarContextMenuTarget(subject);
    if (!target) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const anchorPoint = point ?? {
      x: rect.left + Math.min(16, Math.max(0, rect.width)),
      y: rect.bottom,
    };
    const requestId = sidebarContextMenuRequestIdRef.current + 1;
    sidebarContextMenuRequestIdRef.current = requestId;
    void window.electronAPI.sidebarContextMenu
      .popup({
        x: anchorPoint.x,
        y: anchorPoint.y,
        target,
      })
      .then((result) => {
        if (
          requestId !== sidebarContextMenuRequestIdRef.current ||
          !result.actionId
        ) {
          return;
        }
        return executeSidebarContextMenuAction(subject, result.actionId);
      })
      .catch((error) => {
        console.warn("[sidebar] failed to open native context menu", error);
      });
    return true;
  }

  function openSidebarRovingContextMenu(element: HTMLElement) {
    const kind = element.dataset.sidebarNavKind;
    if (kind === "group") {
      const groupId = readSidebarGroupId(element.dataset.sidebarGroupId);
      if (!groupId) {
        return false;
      }
      return openNativeSidebarContextMenu(
        { kind: "group", groupId },
        element,
      );
    }
    if (kind === "agent") {
      const agent = findAssistantNavAgent(
        element.dataset.sidebarAgentKey || "",
      );
      if (!agent) {
        return false;
      }
      return openNativeSidebarContextMenu(
        { kind: "agent", agentKey: agent.agentKey },
        element,
      );
    }
    if (kind === "chat" || kind === "chats-chat") {
      const chat = findAssistantNavChat(element.dataset.sidebarChatId || "");
      if (!chat) {
        return false;
      }
      return openNativeSidebarContextMenu(
        { kind: "chat", chatId: chat.chatId },
        element,
      );
    }
    if (kind === "web") {
      const item = findWebItem(element.dataset.sidebarWebEntryKey || "");
      if (!item) {
        return false;
      }
      return openNativeSidebarContextMenu(
        { kind: "web", entryKey: item.entryKey },
        element,
      );
    }
    return false;
  }

  function handleSidebarRovingArrowRight(element: HTMLElement) {
    const kind = element.dataset.sidebarNavKind;
    if (kind === "group") {
      const groupId = readSidebarGroupId(element.dataset.sidebarGroupId);
      if (!groupId) {
        return false;
      }
      if (isCollapsed) {
        element.click();
        return true;
      }
      if (!sidebarGroupState[groupId]) {
        setSidebarGroupState((current) => ({ ...current, [groupId]: true }));
        return true;
      }
      moveSidebarRovingFocus(element, "next");
      return true;
    }
    if (kind === "agent") {
      const agentKey = element.dataset.sidebarAgentKey || "";
      if (!agentKey) {
        return false;
      }
      if (expandedAssistantAgentKey !== agentKey) {
        const agent = findAssistantNavAgent(agentKey);
        if (agent) {
          handleAssistantAgentExpand(agent, true);
        } else {
          setExpandedAssistantAgentKey(agentKey);
        }
        return true;
      }
      moveSidebarRovingFocus(element, "next");
      return true;
    }
    return false;
  }

  function handleSidebarRovingArrowLeft(element: HTMLElement) {
    const kind = element.dataset.sidebarNavKind;
    if (kind === "group") {
      const groupId = readSidebarGroupId(element.dataset.sidebarGroupId);
      if (groupId && !isCollapsed && sidebarGroupState[groupId]) {
        setSidebarGroupState((current) => ({ ...current, [groupId]: false }));
        return true;
      }
      return false;
    }
    if (kind === "agent") {
      const agentKey = element.dataset.sidebarAgentKey || "";
      if (agentKey && expandedAssistantAgentKey === agentKey) {
        setExpandedAssistantAgentKey("");
        return true;
      }
      return false;
    }
    if (kind === "chats-chat") {
      return focusSidebarRovingItemById(createSidebarGroupFocusId("chats"));
    }
    if (kind === "chats-more") {
      return focusSidebarRovingItemById(createSidebarGroupFocusId("chats"));
    }
    if (kind === "chat" || kind === "agent-more") {
      const agentKey = element.dataset.sidebarAgentKey || "";
      return agentKey
        ? focusSidebarRovingItemById(createSidebarAgentFocusId(agentKey))
        : false;
    }
    if (kind === "web") {
      return focusSidebarRovingItemById(createSidebarGroupFocusId("webs"));
    }
    return false;
  }

  function getSidebarRovingEventElement(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const element = target.closest<HTMLElement>(
      '[data-sidebar-roving-item="true"]',
    );
    if (!element || !sidebarNavRef.current?.contains(element)) {
      return null;
    }
    return element;
  }

  function handleSidebarNavKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!isPrimaryMode) {
      return;
    }
    const currentElement = getSidebarRovingEventElement(event.target);
    if (!currentElement) {
      return;
    }

    if (event.key === "Escape") {
      closeToolMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSidebarRovingFocus(currentElement, "next");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSidebarRovingFocus(currentElement, "previous");
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveSidebarRovingFocus(currentElement, "first");
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveSidebarRovingFocus(currentElement, "last");
      return;
    }
    if (event.key === "ArrowRight") {
      if (handleSidebarRovingArrowRight(currentElement)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (handleSidebarRovingArrowLeft(currentElement)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === " " && currentElement instanceof HTMLAnchorElement) {
      event.preventDefault();
      currentElement.click();
      return;
    }
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      if (openSidebarRovingContextMenu(currentElement)) {
        event.preventDefault();
      }
    }
  }

  async function beginCreateProject() {
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
        workspaceDir: selection.path,
        projectType: "coder",
        useAcp: false,
        options: runningAcpProxies,
        selectedAcpProxyId: runningAcpProxies[0]?.acpProxyId ?? "",
        pending: false,
        error: "",
      });
    } catch (error) {
      console.warn("[assistant] failed to prepare project", error);
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleCreateProject(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    await beginCreateProject();
  }

  async function handleSubmitCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dialog = createProjectDialog;
    if (!dialog || dialog.pending) {
      return;
    }
    const selectedAcpProxy =
      dialog.projectType === "coder" &&
      dialog.useAcp &&
      dialog.selectedAcpProxyId
        ? dialog.options.find(
            (option) => option.acpProxyId === dialog.selectedAcpProxyId,
          )
        : null;
    if (dialog.projectType === "coder" && dialog.useAcp && !selectedAcpProxy) {
      setCreateProjectDialog({
        ...dialog,
        error: t("sidebar.project.acpRequired"),
      });
      return;
    }
    setCreateProjectDialog({ ...dialog, pending: true, error: "" });
    try {
      const createInput: AssistantCreateProjectRequest = {
        projectType: dialog.projectType,
        workspaceDir: dialog.workspaceDir,
      };
      if (selectedAcpProxy) {
        createInput.acpProxyId = selectedAcpProxy.acpProxyId;
      }
      const result =
        await window.electronAPI.assistant.createProject(createInput);
      if (!result.ok) {
        setCreateProjectDialog({
          ...dialog,
          pending: false,
          error: result.message || t("sidebar.project.createFailed"),
        });
        return;
      }
      setCreateProjectDialog(null);
      await onRefreshAssistantNavAgents?.();
      if (result.agentKey) {
        setExpandedAssistantAgentKey(result.agentKey);
        requestNavigate(createAgentNewChatRoute(result.agentKey));
      }
    } catch (error) {
      console.warn("[assistant] failed to create project", error);
      setCreateProjectDialog({
        ...dialog,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function resetWebsiteDialogState() {
    setWebsiteLabel("");
    setWebsiteUrl("");
    setWebsiteAgentKey("");
    setWebsiteCreateError("");
  }

  function closeWebsiteDialog() {
    setWebsiteDialogOpen(false);
    resetWebsiteDialogState();
  }

  function showWebsiteDialog() {
    resetWebsiteDialogState();
    setWebsiteDialogOpen(true);
    void onRefreshCopilotAgentOptions?.();
  }

  function openWebsiteDialog(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    showWebsiteDialog();
  }

  async function handleSaveWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (websiteCreatePending) {
      return;
    }
    setWebsiteCreatePending(true);
    setWebsiteCreateError("");
    try {
      const result = onCreateWebsiteItem
        ? await onCreateWebsiteItem({
            label: websiteLabel,
            url: websiteUrl,
            copilotAgentKey: websiteAgentKey,
          })
        : null;
      if (!result) {
        return;
      }
      if (!result.ok || !result.item) {
        setWebsiteCreateError(result.message || t("sidebar.website.addFailed"));
        return;
      }
      closeWebsiteDialog();
      setSidebarGroupState((current) => ({ ...current, webs: true }));
      requestNavigate(`/webs/${result.item.entryKey}`);
    } catch (error) {
      setWebsiteCreateError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWebsiteCreatePending(false);
    }
  }

  async function handleImportWebapp() {
    if (!onImportWebappItem) {
      return;
    }
    setWebappImportFailure(null);
    try {
      const result = await onImportWebappItem();
      if (!result.ok || !result.item) {
        const cancelled = !result.path && !result.diagnostic;
        if (!cancelled) {
          setWebappImportFailure({
            message: result.diagnostic?.message || result.message || t("sidebar.webapp.importFailed"),
            diagnostic: result.diagnostic,
          });
        }
        return;
      }
      setSidebarGroupState((current) => ({ ...current, webs: true }));
      requestNavigate(`/webs/${result.item.entryKey}`);
    } catch (error) {
      setWebappImportFailure({
        message: error instanceof Error ? error.message : t("sidebar.webapp.importFailed"),
      });
    }
  }

  function renderWebappImportFailureDialog() {
    return (
      <Modal
        centered
        className="sidebar-webapp-import-failure-modal"
        open={Boolean(webappImportFailure)}
        title={t("sidebar.webapp.importFailedTitle")}
        okText={t("common.close")}
        cancelButtonProps={{ style: { display: "none" } }}
        onOk={() => setWebappImportFailure(null)}
        onCancel={() => setWebappImportFailure(null)}
      >
        {webappImportFailure ? (
          <div className="sidebar-webapp-import-failure" role="alert">
            {webappImportFailure.diagnostic ? (
              <code>{`${webappImportFailure.diagnostic.stage}/${webappImportFailure.diagnostic.code}`}</code>
            ) : null}
            <p>{webappImportFailure.message}</p>
            {webappImportFailure.diagnostic?.suggestion ? (
              <p className="sidebar-webapp-import-failure-suggestion">
                {webappImportFailure.diagnostic.suggestion}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    );
  }

  async function closeWebItem(item: WebEntry) {
    if (webClosePendingEntryKey || !onCloseWebItem) {
      return;
    }
    setWebClosePendingEntryKey(item.entryKey);
    try {
      await onCloseWebItem(item);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : t("sidebar.website.closeFailed"),
      );
    } finally {
      setWebClosePendingEntryKey("");
    }
  }

  async function handleCloseWebItem(
    event: MouseEvent<HTMLElement>,
    item: WebEntry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    await closeWebItem(item);
  }

  async function removeWebappItem(item: WebEntry) {
    if (item.kind !== "webapp" || webItemRemovePendingId) {
      return;
    }
    if (item.removable === false) {
      window.alert(
        t("sidebar.webapp.managedNotRemovable", { name: item.label }),
      );
      return;
    }
    if (
      !window.confirm(t("sidebar.webapp.removeConfirm", { name: item.label }))
    ) {
      return;
    }
    if (!onRemoveWebappItem) {
      window.alert(t("sidebar.webapp.removeFailed"));
      return;
    }

    setWebItemRemovePendingId(item.id);
    try {
      const result = await onRemoveWebappItem(item);
      if (!result.ok) {
        window.alert(result.message || t("sidebar.webapp.removeFailed"));
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : t("sidebar.webapp.removeFailed"),
      );
    } finally {
      setWebItemRemovePendingId("");
    }
  }

  async function exportWebappItem(item: WebEntry) {
    if (item.kind !== "webapp" || webItemExportPendingId || !onExportWebappItem) {
      return;
    }
    setWebItemExportPendingId(item.id);
    try {
      const result = await onExportWebappItem(item);
      if (!result.ok && result.path) {
        window.alert(result.message || t("sidebar.webapp.exportFailed"));
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : t("sidebar.webapp.exportFailed"),
      );
    } finally {
      setWebItemExportPendingId("");
    }
  }

  function handleWebItemContextMenu(
    event: MouseEvent<HTMLElement>,
    item: WebEntry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "web", entryKey: item.entryKey },
      event.currentTarget,
      event.clientX === 0 && event.clientY === 0
        ? undefined
        : { x: event.clientX, y: event.clientY },
    );
  }

  function handleAssistantAgentExpand(
    agent: AssistantNavAgentItem,
    expanded: boolean,
  ) {
    setExpandedAssistantAgentKey(expanded ? agent.agentKey : "");
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
      focusAgentChat: true,
    });
  }

  function startChatsNewChat() {
    const runtime = sidebarContextMenuRuntimeRef.current;
    if (
      !runtime.resolvedChatDefaultAgentKey ||
      runtime.chatDefaultAgentUnavailable
    ) {
      return;
    }
    requestNavigate(
      createAgentNewChatRoute(runtime.resolvedChatDefaultAgentKey),
      { retriggerAgentRoute: true, focusAgentChat: true },
    );
  }

  function handleChatsNewChat(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    startChatsNewChat();
  }

  function focusChatsDefaultAgentMenuItem(index: number) {
    const items = Array.from(
      chatDefaultAgentMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-sidebar-chat-agent-key]",
      ) ?? [],
    );
    if (items.length === 0) {
      return;
    }
    const normalizedIndex =
      ((index % items.length) + items.length) % items.length;
    items[normalizedIndex]?.focus();
  }

  function openChatsDefaultAgentMenu(
    focusAgentKey = resolvedChatDefaultAgentKey,
  ) {
    setChatDefaultAgentMenuOpen(true);
    window.requestAnimationFrame(() => {
      const selectedIndex = chatNavAgentOptions.findIndex(
        (agent) => agent.agentKey === focusAgentKey,
      );
      focusChatsDefaultAgentMenuItem(selectedIndex >= 0 ? selectedIndex : 0);
    });
  }

  function closeChatsDefaultAgentMenu(restoreTriggerFocus = false) {
    setChatDefaultAgentMenuOpen(false);
    setChatDefaultAgentMenuAnchorPoint(null);
    setChatDefaultAgentInlineMenuPosition(null);
    if (restoreTriggerFocus) {
      window.requestAnimationFrame(() =>
        chatDefaultAgentTriggerRef.current?.focus(),
      );
    }
  }

  function handleChatsDefaultAgentTriggerClick(
    event: MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (chatDefaultAgentMenuOpen) {
      closeChatsDefaultAgentMenu();
      return;
    }
    setChatDefaultAgentMenuAnchorPoint(
      event.detail > 0 ? { x: event.clientX, y: event.clientY } : null,
    );
    openChatsDefaultAgentMenu();
  }

  function handleChatsDefaultAgentTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setChatDefaultAgentMenuAnchorPoint(null);
      const selectedIndex = chatNavAgentOptions.findIndex(
        (agent) => agent.agentKey === resolvedChatDefaultAgentKey,
      );
      openChatsDefaultAgentMenu(
        chatNavAgentOptions[
          selectedIndex < 0
            ? 0
            : event.key === "ArrowDown"
              ? Math.min(selectedIndex + 1, chatNavAgentOptions.length - 1)
              : Math.max(selectedIndex - 1, 0)
        ]?.agentKey,
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setChatDefaultAgentMenuAnchorPoint(null);
      if (chatDefaultAgentMenuOpen) {
        closeChatsDefaultAgentMenu();
      } else {
        openChatsDefaultAgentMenu();
      }
    }
  }

  function handleChatsDefaultAgentMenuKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeChatsDefaultAgentMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      chatDefaultAgentMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-sidebar-chat-agent-key]",
      ) ?? [],
    );
    const focusedItem =
      document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : undefined;
    const currentIndex = focusedItem ? items.indexOf(focusedItem) : -1;
    if (event.key === "Home") {
      focusChatsDefaultAgentMenuItem(0);
      return;
    }
    if (event.key === "End") {
      focusChatsDefaultAgentMenuItem(items.length - 1);
      return;
    }
    focusChatsDefaultAgentMenuItem(
      (currentIndex < 0 ? 0 : currentIndex) +
        (event.key === "ArrowDown" ? 1 : -1),
    );
  }

  async function handleChatsDefaultAgentChange(nextAgentKey: string) {
    const normalizedAgentKey = nextAgentKey.trim();
    if (
      !normalizedAgentKey ||
      !chatNavAgentOptions.some(
        (agent) => agent.agentKey === normalizedAgentKey,
      )
    ) {
      return;
    }
    if (normalizedAgentKey === resolvedChatDefaultAgentKey) {
      // 点击当前已选中的 agent：仅关闭菜单，避免菜单悬停且无任何反馈
      closeChatsDefaultAgentMenu();
      return;
    }

    setChatDefaultAgentError("");
    closeChatsDefaultAgentMenu();
    setChatDefaultAgentPending(true);
    try {
      await onChatsDefaultAgentChange?.(normalizedAgentKey);
    } catch {
      setChatDefaultAgentError(t("sidebar.chats.defaultAgentSaveFailed"));
    } finally {
      setChatDefaultAgentPending(false);
    }
  }

  function handleChatsOpenHistory(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!chatsHistoryAvailable || !resolvedChatDefaultAgentKey) {
      return;
    }
    requestNavigate(createAgentHistoryRoute(resolvedChatDefaultAgentKey), {
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
    if (!chat.agentKey) {
      return;
    }
    if (
      bootstrapActive &&
      normalizedBootstrapChatId &&
      chat.chatId === normalizedBootstrapChatId
    ) {
      dismissBootstrapGuideBubble("chat");
    }
    if (!chat.isRead && !chat.hasActiveRun) {
      const assistantApi = window.electronAPI
        .assistant as typeof window.electronAPI.assistant & {
        markChatRead?: (
          chatId: string,
          runId?: string,
        ) => ReturnType<typeof window.electronAPI.assistant.markAgentChatsRead>;
      };
      const markChatRead = assistantApi.markChatRead;
      const markReadRequest =
        typeof markChatRead === "function"
          ? markChatRead(chat.chatId, chat.lastRunId || undefined)
          : window.electronAPI.assistant.markAgentChatsRead(chat.agentKey);
      void markReadRequest.catch((error: unknown) => {
        console.warn("[assistant] failed to mark chat read", error);
      });
    }
    requestNavigate(createAgentChatRoute(chat.agentKey, chat.chatId), {
      retriggerAgentRoute: true,
    });
  }

  function handleAssistantOpenChatMenu(
    event: MouseEvent<HTMLButtonElement>,
    chat: AssistantNavChatItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "chat", chatId: chat.chatId },
      event.currentTarget,
      { x: event.clientX, y: event.clientY },
    );
  }

  function handleAssistantChatContextMenu(
    event: MouseEvent<HTMLElement>,
    chat: AssistantNavChatItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "chat", chatId: chat.chatId },
      event.currentTarget,
      event.clientX === 0 && event.clientY === 0
        ? undefined
        : { x: event.clientX, y: event.clientY },
    );
  }

  async function handleAssistantExportChat(chat: AssistantNavChatItem) {
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
      window.alert(
        error instanceof Error ? error.message : t("sidebar.chat.exportFailed"),
      );
    }
  }

  function handleAssistantRenameChat(chat: AssistantNavChatItem) {
    setAssistantChatRenameDialog({
      chat,
      value: chat.chatName,
      pending: false,
      error: "",
    });
  }

  function handleAssistantChatDoubleClick(
    event: MouseEvent<HTMLButtonElement>,
    chat: AssistantNavChatItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    handleAssistantRenameChat(chat);
  }

  async function handleConfirmRenameChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assistantChatRenameDialog || assistantChatRenameDialog.pending) {
      return;
    }
    const nextName = assistantChatRenameDialog.value.trim();
    if (!nextName) {
      setAssistantChatRenameDialog((current) =>
        current
          ? { ...current, error: t("sidebar.chat.nameRequired") }
          : current,
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
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.renameFailed"),
            }
          : current,
      );
    }
  }

  async function handleAssistantArchiveChat(chat: AssistantNavChatItem) {
    const result = await window.electronAPI.assistant.archiveChat(chat.chatId);
    if (!result?.ok) {
      window.alert(result?.message || t("sidebar.chat.archiveFailed"));
      return;
    }

    onCloseChatWorkPanel?.(chat.chatId, true);

    if (currentChatId === chat.chatId) {
      const agentKey = chat.agentKey.trim() || currentAgentKey;
      const currentAgent = assistantNavAgents.find(
        (agent) => agent.agentKey === agentKey,
      );
      const nextChat = currentAgent
        ? getAssistantNavAgentSortedChats(currentAgent).find(
            (candidate) => candidate.chatId !== chat.chatId,
          )
        : null;
      const nextRoute = nextChat
        ? createAgentChatRoute(agentKey, nextChat.chatId)
        : agentKey
          ? createAgentRoute(agentKey)
          : "/agents";
      onRequestNavigate?.(nextRoute);
    }

    await onRefreshAssistantNavAgents?.();
  }

  async function handleAssistantDeleteChat(chat: AssistantNavChatItem) {
    setAssistantChatDeleteDialog({
      chat,
      pending: false,
      error: "",
    });
  }

  async function handleConfirmDeleteChat() {
    if (!assistantChatDeleteDialog || assistantChatDeleteDialog.pending) {
      return;
    }
    const chat = assistantChatDeleteDialog.chat;
    setAssistantChatDeleteDialog((current) =>
      current ? { ...current, pending: true, error: "" } : current,
    );
    try {
      const result = await window.electronAPI.assistant.deleteChat(chat.chatId);
      if (!result.ok) {
        throw new Error(result.message || t("sidebar.chat.deleteFailed"));
      }
      setAssistantChatDeleteDialog(null);
      onCloseChatWorkPanel?.(chat.chatId, true);

      if (currentChatId === chat.chatId) {
        const agentKey = chat.agentKey.trim() || currentAgentKey;
        const currentAgent = assistantNavAgents.find(
          (agent) => agent.agentKey === agentKey,
        );
        const nextChat = currentAgent
          ? getAssistantNavAgentSortedChats(currentAgent).find(
              (candidate) => candidate.chatId !== chat.chatId,
            )
          : null;
        const nextRoute = nextChat
          ? createAgentChatRoute(agentKey, nextChat.chatId)
          : agentKey
            ? createAgentRoute(agentKey)
            : "/agents";
        onRequestNavigate?.(nextRoute);
      }

      await onRefreshAssistantNavAgents?.();
    } catch (error) {
      setAssistantChatDeleteDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error:
                error instanceof Error
                  ? error.message
                  : t("sidebar.chat.deleteFailed"),
            }
          : current,
      );
    }
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

  function handleSidebarGroupContextMenu(
    event: MouseEvent<HTMLElement>,
    groupId: SidebarGroupId,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "group", groupId },
      event.currentTarget,
      event.clientX === 0 && event.clientY === 0
        ? undefined
        : { x: event.clientX, y: event.clientY },
    );
  }

  function getActiveSidebarAgentKey() {
    return activeSidebarAgentKey;
  }

  function getActiveSidebarChatId(
    agentKey: string,
    chats: AssistantNavChatItem[] = [],
  ) {
    const routeChatId = activeSidebarChatId;
    if (routeChatId && chats.some((chat) => chat.chatId === routeChatId)) {
      return routeChatId;
    }
    const activeAgentKey = getActiveSidebarAgentKey();
    if (activeAgentKey !== agentKey) {
      return "";
    }
    if (routeChatId) {
      return routeChatId;
    }
    return "";
  }

  function isRouteActive(targetPath: string) {
    const targetPathname = getRoutePathname(targetPath);
    if (
      targetPathname !== displayCurrentPathname &&
      pendingPath !== targetPath
    ) {
      return false;
    }
    if (targetPathname !== "/service/agent-webclient") {
      return (
        targetPathname === displayCurrentPathname || pendingPath === targetPath
      );
    }
    const targetAgentKey = readAgentRouteInfo(targetPath).agentKey;
    const activeAgentKey =
      pendingPath === targetPath ? pendingAgentKey : currentAgentKey;
    return targetAgentKey === activeAgentKey;
  }

  function isFixedToolRouteActive(targetPath: string) {
    const targetPathname = getRoutePathname(targetPath);
    const pendingPathname = pendingPath ? getRoutePathname(pendingPath) : "";
    const targetCapabilityItem = getCapabilityNavigationItem(targetPathname);
    if (targetCapabilityItem?.to === targetPathname) {
      const activeCapabilityItem = getCapabilityNavigationItem(
        displayCurrentPathname,
      );
      const pendingCapabilityItem = getCapabilityNavigationItem(
        pendingPathname,
      );
      const selectedCapabilityItem =
        !forcedActiveManagementRoute && pendingCapabilityItem
          ? pendingCapabilityItem
          : activeCapabilityItem;
      return selectedCapabilityItem?.id === targetCapabilityItem.id;
    }
    return (
      displayCurrentPathname === targetPathname ||
      (!forcedActiveManagementRoute && pendingPathname === targetPathname)
    );
  }

  function isAssistantGroupActive() {
    return navigationOwner === "assistants";
  }

  function isChatsGroupActive() {
    return navigationOwner === "chats";
  }

  function isWebsiteGroupActive() {
    return (
      currentPathname.startsWith("/webs/") ||
      Boolean(pendingPath?.startsWith("/webs/"))
    );
  }

  function renderAssistantSortButton(options: { tabIndex?: number } = {}) {
    return (
      <button
        type="button"
        className="assistant-worker-icon-button sidebar-assistant-sort-button"
        aria-label={t("sidebar.assistants.sort")}
        title={assistantNavSortLabel}
        tabIndex={options.tabIndex}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openNativeSidebarContextMenu(
            {
              kind: "group",
              groupId: "assistants",
              menuScope: "sort",
            },
            event.currentTarget,
            event.detail > 0
              ? { x: event.clientX, y: event.clientY }
              : undefined,
          );
        }}
      >
        <SidebarActionIcon kind="sort" />
      </button>
    );
  }

  async function handleRefreshAssistantNavAgents(
    event: MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (refreshingAssistantNavAgents) {
      return;
    }
    setRefreshingAssistantNavAgents(true);
    try {
      await onRefreshAssistantNavAgents?.({ force: true });
    } finally {
      setRefreshingAssistantNavAgents(false);
    }
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
            {summary.pendingCount}
          </span>
        ) : null}
        {unreadLabel ? (
          <span className="sidebar-status-badge is-unread">{unreadLabel}</span>
        ) : null}
      </span>
    );
  }

  function renderSidebarGroupStatusBadges(status?: SidebarStatusSummary) {
    if (!status) {
      return null;
    }
    return renderStatusBadges(status, "sidebar-group-status");
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

  function renderSidebarLink(
    item: SidebarNavItem,
    extraClassName = "sidebar-primary-link",
  ) {
    const visibleLabel =
      isCollapsed && item.collapsedLabel ? item.collapsedLabel : item.label;
    const focusId = createSidebarLinkFocusId(item.orderKey);
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        {...getSidebarRovingItemProps(focusId)}
        data-sidebar-nav-kind="link"
        className={() => getSidebarLinkClassName(item.to, extraClassName)}
      >
        <span className="sidebar-link-icon">
          <SidebarIllustration
            kind={item.icon}
            variant={isCollapsed ? "rail" : "compact"}
          />
        </span>
        <span className="sidebar-link-label">{visibleLabel}</span>
      </NavLink>
    );
  }

  function renderChatsNewChatButton(options: { inPopover?: boolean } = {}) {
    const disabled =
      !resolvedChatDefaultAgentKey || chatDefaultAgentUnavailable;
    const label = disabled
      ? t("sidebar.chats.defaultAgentUnavailable")
      : t("sidebar.chats.newChat");
    return (
      <Tooltip content={label}>
        <button
          type="button"
          className={[
            "assistant-worker-icon-button",
            "sidebar-chats-new-button",
            options.inPopover ? "is-in-popover" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={t("sidebar.chats.newChat")}
          title={label}
          tabIndex={options.inPopover ? undefined : -1}
          disabled={disabled}
          onClick={handleChatsNewChat}
        >
          <SidebarActionIcon kind="new_chat" />
        </button>
      </Tooltip>
    );
  }

  function renderChatsHeaderActions(options: { inPopover?: boolean } = {}) {
    return renderChatsNewChatButton(options);
  }

  function renderChatsDefaultAgentPicker(
    options: { inPopover?: boolean } = {},
  ) {
    const selectedAgent =
      chatNavAgentOptions.find(
        (agent) => agent.agentKey === resolvedChatDefaultAgentKey,
      ) ?? null;
    const disabled =
      chatNavAgentOptions.length === 0 ||
      chatDefaultAgentPending ||
      !onChatsDefaultAgentChange;
    const menu = (
      <div
        ref={chatDefaultAgentMenuRef}
        className="sidebar-chats-agent-menu"
        style={
          options.inPopover && chatDefaultAgentMenuAnchorPoint
            ? chatDefaultAgentInlineMenuPosition
              ? chatDefaultAgentInlineMenuPosition
              : { visibility: "hidden" }
            : undefined
        }
        role="menu"
        aria-label={t("settings.chat.defaultAgent")}
        onKeyDown={handleChatsDefaultAgentMenuKeyDown}
      >
        <div className="sidebar-chats-agent-menu-label" role="presentation">
          {t("sidebar.chats.defaultAgentMenuLabel")}
        </div>
        {chatNavAgentOptions.map((agent) => (
          <button
            key={agent.agentKey}
            type="button"
            className={[
              "sidebar-chats-agent-option",
              agent.agentKey === resolvedChatDefaultAgentKey ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="menuitemradio"
            aria-checked={agent.agentKey === resolvedChatDefaultAgentKey}
            data-sidebar-chat-agent-key={agent.agentKey}
            disabled={chatDefaultAgentPending}
            onClick={() => void handleChatsDefaultAgentChange(agent.agentKey)}
          >
            <span className="sidebar-chats-agent-option-name">
              {agent.displayName}
            </span>
            {agent.role ? (
              <span className="sidebar-chats-agent-option-role">
                · {agent.role}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    );
    const trigger = (
      <button
        ref={chatDefaultAgentTriggerRef}
        type="button"
        className={[
          "sidebar-chats-agent-trigger",
          options.inPopover ? "is-in-popover" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={t("settings.chat.defaultAgent")}
        aria-haspopup="menu"
        aria-expanded={chatDefaultAgentMenuOpen}
        disabled={disabled}
        onClick={handleChatsDefaultAgentTriggerClick}
        onKeyDown={handleChatsDefaultAgentTriggerKeyDown}
      >
        <span className="sidebar-chats-agent-trigger-name">
          {selectedAgent?.displayName
            ? getCollapsedSidebarLabel(selectedAgent.displayName)
            : t("sidebar.chats.defaultAgentUnavailable")}
        </span>
        <span
          className="sidebar-chats-agent-trigger-caret"
          aria-hidden="true"
        />
      </button>
    );

    if (options.inPopover) {
      return (
        <div
          ref={chatDefaultAgentPickerRef}
          className="sidebar-chats-agent-picker is-in-popover"
        >
          {trigger}
          {chatDefaultAgentMenuOpen ? menu : null}
        </div>
      );
    }

    return (
      <Popover
        open={chatDefaultAgentMenuOpen}
        onOpenChange={(open) => {
          setChatDefaultAgentMenuOpen(open);
          if (!open) {
            setChatDefaultAgentMenuAnchorPoint(null);
          }
        }}
        anchorPoint={chatDefaultAgentMenuAnchorPoint}
        placement="bottom-start"
        className="sidebar-chats-agent-menu-popover sidebar-operation-menu-popover"
        content={menu}
      >
        {trigger}
      </Popover>
    );
  }

  function renderChatHoverCard(
    agent: AssistantNavAgentItem,
    chat: AssistantNavChatItem,
  ) {
    const askedAt = formatAssistantChatDateTime(chat.createdAt);
    const workspaceName = getAssistantWorkspaceName(
      agent.workspaceDir,
      agent.workspaceDirExists,
    );
    const statusLabels = [
      chat.hasActiveRun ? t("sidebar.agent.running") : "",
      chat.hasPendingAwaiting
        ? t(getAssistantAwaitingStatusKey(chat.awaitingMode))
        : "",
      !chat.isRead ? t("sidebar.chat.unread") : "",
    ].filter(Boolean);
    return (
      <div className="sidebar-chat-hover-card">
        <span className="sidebar-chat-hover-card-title">
          {getAssistantChatDisplayText(chat, t)}
        </span>
        <div className="sidebar-chat-hover-card-meta">
          <span>
            {t("sidebar.chats.card.agent", { name: agent.displayName })}
          </span>
          {askedAt ? (
            <span>{t("sidebar.chats.card.askedAt", { time: askedAt })}</span>
          ) : null}
        </div>
        {statusLabels.length > 0 ? (
          <div
            className="sidebar-chat-hover-card-statuses"
            aria-label={t("sidebar.chats.card.status")}
          >
            {statusLabels.map((label) => (
              <span className="sidebar-chat-hover-card-status" key={label}>
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {workspaceName ? (
          <div className="sidebar-chat-hover-card-context">
            <span>
              {t("sidebar.chats.card.workspace", { name: workspaceName })}
            </span>
            {agent.gitBranch ? (
              <span>
                {t("sidebar.chats.card.branch", { name: agent.gitBranch })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderProjectChatHoverCard(
    agent: AssistantNavAgentItem,
    chat: AssistantNavChatItem,
  ) {
    const askedAt = formatAssistantChatDateTime(chat.createdAt);
    const workspaceName = getAssistantWorkspaceName(
      agent.workspaceDir,
      agent.workspaceDirExists,
    );
    const statusLabels = [
      chat.hasActiveRun ? t("sidebar.agent.running") : "",
      chat.hasPendingAwaiting
        ? t(getAssistantAwaitingStatusKey(chat.awaitingMode))
        : "",
      !chat.isRead ? t("sidebar.chat.unread") : "",
    ].filter(Boolean);
    return (
      <div className="sidebar-project-chat-hover-card">
        <div className="sidebar-project-chat-hover-card-heading">
          <span className="sidebar-project-chat-hover-card-title">
            {getAssistantChatDisplayText(chat, t)}
          </span>
          {askedAt ? (
            <span className="sidebar-project-chat-hover-card-time">{askedAt}</span>
          ) : null}
        </div>
        {statusLabels.length > 0 ? (
          <div
            className="sidebar-project-chat-hover-card-statuses"
            aria-label={t("sidebar.chats.card.status")}
          >
            {statusLabels.map((label) => (
              <span className="sidebar-project-chat-hover-card-status" key={label}>
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {workspaceName ? (
          <div className="sidebar-project-chat-hover-card-context">
            <span className="sidebar-project-chat-hover-card-context-item">
              <svg
                className="sidebar-project-chat-hover-card-context-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l2 2H18.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
                <path d="M3.5 10h17" />
              </svg>
              <span>{workspaceName}</span>
            </span>
            {agent.gitBranch ? (
              <span>{agent.gitBranch}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function getChatHoverAgent(
    chat: AssistantNavChatItem,
  ): AssistantNavAgentItem {
    return (
      chatNavigationAgentsByKey.get(chat.agentKey) ?? {
        agentKey: chat.agentKey,
        displayName: chat.agentKey,
        role: "",
        unreadCount: 0,
        unreadChatCount: 0,
        chatCount: 0,
        hasPendingAwaiting: false,
        latestChatId: null,
        latestPreview: "",
        recentChats: [],
      }
    );
  }

  function renderChatsList(options: { roving?: boolean } = {}) {
    const roving = options.roving ?? true;
    const bootstrapFallbackActive =
      activeSidebarAgentKey === normalizedBootstrapAgentKey &&
      !activeSidebarChatId;
    return (
      <div className="sidebar-chats-list" role="list">
        {showBootstrapChatFallback ? (
          <div className="sidebar-chats-row" role="listitem">
            <button
              ref={bootstrapGuideChatAnchorRef}
              type="button"
              className={[
                "assistant-worker-chat-item",
                "sidebar-chats-item",
                "sidebar-chats-bootstrap-fallback",
                showBootstrapChatGuide ? "is-bootstrap-guide" : "",
                bootstrapFallbackActive ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-current={bootstrapFallbackActive ? "page" : undefined}
              onClick={handleBootstrapGuideOpenChat}
              {...getSidebarRovingItemProps(
                createSidebarChatsChatFocusId("bootstrap-fallback"),
                roving,
              )}
            >
              <span className="worker-chat-item-head">
                <span
                  className="assistant-worker-unread-dot chat-unread-dot"
                  aria-hidden="true"
                />
                <span className="worker-chat-name">
                  {t("sidebar.bootstrapChat.cta")}
                </span>
              </span>
            </button>
          </div>
        ) : null}
        {sidebarChatItems.length > 0 ? (
          sidebarChatItems.map((chat) => {
            const agent = getChatHoverAgent(chat);
            const isBootstrapSeedChat = Boolean(
              bootstrapActive &&
              normalizedBootstrapChatId &&
              chat.chatId === normalizedBootstrapChatId &&
              chat.agentKey === normalizedBootstrapAgentKey,
            );
            return renderAssistantChatRow(chat, activeSidebarChatId, {
              roving,
              focusId: createSidebarChatsChatFocusId(chat.chatId),
              navigationKind: "chats-chat",
              rowClassName: "sidebar-chats-row",
              itemClassName: [
                "sidebar-chats-item",
                isBootstrapSeedChat && showBootstrapChatGuide
                  ? "is-bootstrap-guide"
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
              itemRef: isBootstrapSeedChat
                ? bootstrapGuideChatAnchorRef
                : undefined,
              rowRole: "listitem",
              previewText: isBootstrapSeedChat
                ? chat.chatName || t("sidebar.bootstrapChat.cta")
                : undefined,
              wrapItem: (item) => (
                <Popover
                  trigger="hover"
                  placement="right-start"
                  closeOnOutsideClick={false}
                  shouldOpen={(trigger) => {
                    const title =
                      trigger.querySelector<HTMLElement>(".worker-chat-name");
                    return Boolean(
                      title && title.scrollWidth > title.clientWidth,
                    );
                  }}
                  className="sidebar-chat-hover-card-surface"
                  content={renderChatHoverCard(agent, chat)}
                >
                  {item}
                </Popover>
              ),
            });
          })
        ) : !showBootstrapChatFallback ? (
          chatDefaultAgentUnavailable ? (
            <div className="sidebar-empty-hint">
              {t("sidebar.chats.defaultAgentUnavailable")}
            </div>
          ) : (
            <div className="sidebar-empty-hint">{t("sidebar.chats.empty")}</div>
          )
        ) : null}
        {chatsHistoryAvailable ? (
          <button
            type="button"
            className="worker-chat-more assistant-worker-more sidebar-chats-more"
            {...getSidebarRovingItemProps(
              createSidebarChatsMoreFocusId(),
              roving,
            )}
            data-sidebar-nav-kind={roving ? "chats-more" : undefined}
            data-sidebar-agent-key={
              roving ? resolvedChatDefaultAgentKey : undefined
            }
            onClick={handleChatsOpenHistory}
          >
            {t("sidebar.chats.viewMoreHistory")}
          </button>
        ) : null}
        {chatDefaultAgentError ? (
          <div className="sidebar-chats-agent-error" role="alert">
            {chatDefaultAgentError}
          </div>
        ) : null}
      </div>
    );
  }

  function renderChatsEntry(item: SidebarChatsEntry) {
    return renderSidebarGroup({
      groupId: "chats",
      label: item.label,
      collapsedLabel: item.collapsedLabel,
      icon: item.icon,
      active: isChatsGroupActive(),
      status: chatStatusSummary,
      children: [],
      headerLabel: (
        <span className="sidebar-link-label" tabIndex={-1}>
          {item.label}
        </span>
      ),
      headerSupplement: renderChatsDefaultAgentPicker(),
      headerActions: renderChatsHeaderActions(),
      popoverHeader: (
        <div className="sidebar-chats-collapsed-head">
          <span>{item.label}</span>
          {renderChatsDefaultAgentPicker({ inPopover: true })}
          {renderChatsHeaderActions({ inPopover: true })}
        </div>
      ),
      renderChildren: ({ roving }) => renderChatsList({ roving }),
    });
  }

  function renderSidebarChildLink(
    item: SidebarNavItem & { status?: SidebarStatusSummary },
    options: { roving?: boolean } = {},
  ) {
    const roving = options.roving ?? true;
    const showIcon = !item.orderKey.startsWith("custom:");
    const extraClassName = showIcon
      ? "sidebar-child-link"
      : "sidebar-child-link sidebar-custom-child-link";
    const webItem = item.webItem ?? null;
    if (webItem) {
      const isOpen = webOpenEntryKeys.includes(webItem.entryKey);
      const isActive = isRouteActive(item.to);
      const closing = webClosePendingEntryKey === webItem.entryKey;
      const removePending =
        webItem.kind === "webapp" && webItemRemovePendingId === webItem.id;
      const showWebappAction = webItem.kind === "webapp";
      const isWebappRunning =
        showWebappAction && webRunningEntryKeys.includes(webItem.entryKey);
      const isWebsite = webItem.kind === "website";
      const cachedFaviconUrl =
        faviconCache?.[webItem.entryKey]?.faviconUrl ||
        buildWebsiteFaviconUrl(webItem.id);
      const webappActionLabel = t("sidebar.webapp.actions");
      const closeWebsiteLabel = t("sidebar.website.close");
      return (
        <div
          key={item.to}
          className={[
            "sidebar-website-child-row",
            isActive ? "is-active" : "",
            isOpen ? "is-open" : "",
            closing ? "is-closing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <NavLink
            to={item.to}
            onClick={(event) => {
              if (
                webItem.kind === "webapp" &&
                webItem.openMode === "dialog" &&
                onOpenWebappWindow
              ) {
                event.preventDefault();
                onOpenWebappWindow(webItem);
                onNavigateItem?.();
                return;
              }
              handleItemClick(event, item.to);
            }}
            onContextMenu={(event) => handleWebItemContextMenu(event, webItem)}
            aria-label={item.label}
            title={item.label}
            {...getSidebarRovingItemProps(
              createSidebarWebFocusId(webItem.entryKey),
              roving,
            )}
            data-sidebar-nav-kind={roving ? "web" : undefined}
            data-sidebar-web-entry-key={roving ? webItem.entryKey : undefined}
            className={() => getSidebarLinkClassName(item.to, extraClassName)}
          >
            {showIcon && isWebsite ? (
              <span className="sidebar-link-icon">
                <Favicon
                  className="sidebar-website-favicon"
                  title={item.label}
                  url={webItem.url}
                  faviconUrl={cachedFaviconUrl}
                  allowOriginFallback={false}
                />
              </span>
            ) : showIcon ? (
              <span className="sidebar-link-icon">
                <SidebarIllustration kind={item.icon} />
              </span>
            ) : null}
            <span className="sidebar-link-label">{item.label}</span>
            {item.status
              ? renderStatusBadges(item.status, "sidebar-child-status")
              : null}
          </NavLink>
          {isOpen && isWebsite ? (
            <Tooltip content={closeWebsiteLabel}>
              <button
                type="button"
                className={`assistant-worker-icon-button sidebar-website-status-action${closing ? " is-closing" : ""}`}
                aria-label={closeWebsiteLabel}
                title={closeWebsiteLabel}
                tabIndex={-1}
                disabled={Boolean(webClosePendingEntryKey)}
                onClick={(event) => void handleCloseWebItem(event, webItem)}
              >
                {closing ? (
                  <span
                    className="assistant-material-icon is-loading"
                    aria-hidden="true"
                  />
                ) : (
                  <>
                    <span
                      className="sidebar-website-status-dot"
                      aria-hidden="true"
                    />
                    <SidebarActionIcon
                      kind="close"
                      className="sidebar-website-status-close"
                    />
                  </>
                )}
              </button>
            </Tooltip>
          ) : null}
          {showWebappAction ? (
            <span className="sidebar-website-child-actions">
              {isWebappRunning ? (
                <span
                  className="sidebar-website-status-dot sidebar-webapp-status-dot"
                  aria-hidden="true"
                />
              ) : null}
              <Tooltip content={webappActionLabel}>
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-more-actions-button sidebar-website-child-action"
                  aria-label={webappActionLabel}
                  title={webappActionLabel}
                  tabIndex={-1}
                  disabled={Boolean(
                    webItemRemovePendingId || webClosePendingEntryKey,
                  )}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openNativeSidebarContextMenu(
                      { kind: "web", entryKey: webItem.entryKey },
                      event.currentTarget,
                      { x: event.clientX, y: event.clientY },
                    );
                  }}
                >
                  {closing || removePending ? (
                    <span
                      className="assistant-material-icon is-loading"
                      aria-hidden="true"
                    />
                  ) : (
                    <SidebarActionIcon kind="more_actions" />
                  )}
                </button>
              </Tooltip>
            </span>
          ) : null}
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
        {...getSidebarRovingItemProps(
          createSidebarLinkFocusId(item.orderKey),
          roving,
        )}
        data-sidebar-nav-kind={roving ? "link" : undefined}
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
    options: AssistantChatRowOptions = {},
  ) {
    const roving = options.roving ?? true;
    const isActive = activeChatId === chat.chatId;
    const action = chat.hasPendingAwaiting
      ? "awaiting"
      : chat.hasActiveRun
        ? "loading"
        : "time";
    const previewText =
      options.previewText ?? getAssistantChatDisplayText(chat, t);
    const focusId = options.focusId ?? createSidebarChatFocusId(chat.chatId);
    const navigationKind = options.navigationKind ?? "chat";
    const item = (
      <button
        ref={options.itemRef}
        type="button"
        className={[
          "assistant-worker-chat-item",
          options.itemClassName ?? "",
          isActive ? "is-active" : "",
          !chat.isRead ? "is-unread" : "",
          chat.hasPendingAwaiting ? "has-awaiting" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={isActive ? "page" : undefined}
        onClick={() => void handleAssistantOpenChat(chat)}
        onDoubleClick={(event) => handleAssistantChatDoubleClick(event, chat)}
        {...getSidebarRovingItemProps(focusId, roving)}
        data-sidebar-nav-kind={roving ? navigationKind : undefined}
        data-sidebar-agent-key={
          roving ? chat.agentKey || currentAgentKey : undefined
        }
        data-sidebar-chat-id={roving ? chat.chatId : undefined}
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
        </span>
      </button>
    );
    return (
      <div
        key={chat.chatId}
        className={[
          "assistant-worker-chat-row",
          options.rowClassName ?? "",
          action === "awaiting" || action === "loading"
            ? "has-status-action"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role={options.rowRole}
        onContextMenu={(event) => handleAssistantChatContextMenu(event, chat)}
      >
        {options.wrapItem ? options.wrapItem(item) : item}
        <button
          type="button"
          className="assistant-worker-chat-menu-button sidebar-more-actions-button"
          aria-label={t("sidebar.chat.moreActions")}
          title={t("common.more")}
          tabIndex={-1}
          onClick={(event) => handleAssistantOpenChatMenu(event, chat)}
        >
          <SidebarActionIcon kind="more_actions" />
        </button>
      </div>
    );
  }

  function renderAssistantAgent(
    agent: AssistantNavAgentItem,
    options: { roving?: boolean } = {},
  ) {
    const roving = options.roving ?? true;
    const allRecentChats = getAssistantNavAgentSortedChats(agent);
    const recentChats = getAssistantNavAgentPreviewChats(agent);
    const chatCount = Math.max(
      0,
      getAssistantNavAgentNonNegativeInteger(agent.chatCount),
      allRecentChats.length,
    );
    const unreadCount = Math.max(
      0,
      getAssistantNavAgentNonNegativeInteger(agent.unreadCount),
      getAssistantNavAgentNonNegativeInteger(agent.unreadChatCount),
    );
    const rowUnreadCount = allRecentChats.filter((chat) => !chat.isRead).length;
    const awaitingChats = allRecentChats.filter(
      (chat) => chat.hasPendingAwaiting === true,
    );
    const awaitingChat = awaitingChats[0] ?? null;
    const awaitingChatsCount = awaitingChats.length;
    const activeRunChat = allRecentChats.find(
      (chat) => chat.hasActiveRun === true,
    );
    const previewStatus =
      awaitingChat || agent.hasPendingAwaiting
        ? "awaiting"
        : activeRunChat
          ? "running"
          : "";
    const activeChatId = getActiveSidebarChatId(agent.agentKey, allRecentChats);
    const selected =
      getActiveSidebarAgentKey() === agent.agentKey || Boolean(activeChatId);
    const agentRole = getAssistantAgentRoleLabel(agent);
    return (
      <Collapse
        key={agent.agentKey}
        className={[
          "assistant-worker-collapse-item",
          selected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onExpand={(val) => handleAssistantAgentExpand(agent, val)}
        headerButtonProps={{
          className: "assistant-worker-header",
          onContextMenu: (event) => handleAgentContextMenu(event, agent),
          ...getSidebarRovingItemProps(
            createSidebarAgentFocusId(agent.agentKey),
            roving,
          ),
          "data-sidebar-nav-kind": roving ? "agent" : undefined,
          "data-sidebar-agent-key": roving ? agent.agentKey : undefined,
        }}
        header={
          <Flex gap={8} align="center" className="worker-panel-header">
            <AgentIcon icon={agent.icon} size={16} type="agent" />
            <Flex align="center" className="worker-panel-header-body">
              <span className="assistant-worker-name">
                <span>{agent.displayName}</span>
                {agentRole ? (
                  <span className="worker-panel-role">{agentRole}</span>
                ) : null}
              </span>
              <Flex align="center" gap={4}>
                {previewStatus ? (
                  <span
                    className="assistant-material-icon is-loading sidebar-assistant-preview-loading"
                    aria-label={
                      previewStatus === "awaiting"
                        ? t("sidebar.agent.awaiting")
                        : t("sidebar.agent.running")
                    }
                  />
                ) : null}
                {awaitingChatsCount > 0 ? (
                  <span className="chat-awaiting-status">
                    {awaitingChatsCount}
                  </span>
                ) : null}
                {unreadCount > 0 ? (
                  <div className="assistant-worker-badge">
                    {formatUnreadCount(unreadCount)}
                  </div>
                ) : null}
              </Flex>
            </Flex>
          </Flex>
        }
        headerActions={
          <span className="assistant-worker-actions">
            <Tooltip content={t("sidebar.agent.moreActions")}>
              <button
                type="button"
                className="assistant-worker-icon-button sidebar-more-actions-button sidebar-agent-more-actions-button"
                aria-label={t("sidebar.agent.moreActionsFor", {
                  name: agent.displayName,
                })}
                tabIndex={-1}
                onClick={(event) => handleOpenAgentMenu(event, agent)}
              >
                <SidebarActionIcon kind="more_actions" />
              </button>
            </Tooltip>
            <Tooltip content={t("sidebar.agent.newChat")}>
              <button
                type="button"
                className="assistant-worker-icon-button"
                aria-label={t("sidebar.agent.newChatFor", {
                  name: agent.displayName,
                })}
                tabIndex={-1}
                onClick={(event) => handleAssistantNewChat(event, agent)}
              >
                <SidebarActionIcon kind="new_chat" />
              </button>
            </Tooltip>
          </span>
        }
      >
        <Flex vertical gap={2} className="worker-chat-preview-list">
          {recentChats.length > 0 ? (
            recentChats.map((chat) =>
              renderAssistantChatRow(chat, activeChatId, {
                roving,
                wrapItem: (item) => (
                  <Popover
                    trigger="hover"
                    placement="right-start"
                    closeOnOutsideClick={false}
                    className="sidebar-project-chat-hover-card-surface"
                    content={renderProjectChatHoverCard(agent, chat)}
                  >
                    {item}
                  </Popover>
                ),
              }),
            )
          ) : chatCount === 0 ? (
            <div className="status-line">{t("sidebar.agent.noChats")}</div>
          ) : null}
          {chatCount > recentChats.length ? (
            <button
              type="button"
              className="worker-chat-more assistant-worker-more"
              {...getSidebarRovingItemProps(
                createSidebarAgentMoreFocusId(agent.agentKey),
                roving,
              )}
              data-sidebar-nav-kind={roving ? "agent-more" : undefined}
              data-sidebar-agent-key={roving ? agent.agentKey : undefined}
              onClick={(event) => {
                event.stopPropagation();
                requestNavigate(createAgentHistoryRoute(agent.agentKey), {
                  retriggerAgentRoute: true,
                });
              }}
            >
              {t("sidebar.chat.viewMore", {
                count: chatCount,
                unread:
                  rowUnreadCount > 0
                    ? t("sidebar.chat.unreadSuffix", { count: rowUnreadCount })
                    : "",
              })}
            </button>
          ) : null}
        </Flex>
      </Collapse>
    );
  }

  function renderSidebarGroup(args: {
    groupId: SidebarGroupId;
    label: string;
    collapsedLabel?: string;
    icon?: SidebarIllustrationKind;
    active: boolean;
    status?: SidebarStatusSummary;
    children: Array<SidebarNavItem & { status?: SidebarStatusSummary }>;
    headerLabel?: ReactNode;
    headerSupplement?: ReactNode;
    headerActions?: ReactNode;
    popoverHeader?: ReactNode;
    renderChildren?: (options: { roving: boolean }) => ReactNode;
  }) {
    const expanded = sidebarGroupState[args.groupId];
    const groupTriggerClassName = isCollapsed
      ? [
          "sidebar-link",
          "sidebar-group-trigger",
          "sidebar-primary-link",
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
            {args.popoverHeader}
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
                    renderAssistantAgent(agent, { roving: false }),
                  )
                ) : assistantNavAgentsLoaded ? (
                  <div className="sidebar-empty-hint">
                    {t("sidebar.assistants.empty")}
                  </div>
                ) : null}
              </div>
            ) : args.renderChildren ? (
              args.renderChildren({ roving: false })
            ) : (
              args.children.map((item) =>
                renderSidebarChildLink(item, { roving: false }),
              )
            )}
          </div>
        }
      >
        <button
          type="button"
          className={groupTriggerClassName}
          onContextMenu={(event) =>
            handleSidebarGroupContextMenu(event, args.groupId)
          }
          {...getSidebarRovingItemProps(
            createSidebarGroupFocusId(args.groupId),
          )}
          data-sidebar-nav-kind="group"
          data-sidebar-group-id={args.groupId}
        >
          <span className="sidebar-group-heading-main">
            {args.icon ? (
              <span className="sidebar-link-icon">
                <SidebarIllustration kind={args.icon} variant="rail" />
              </span>
            ) : null}
            {isCollapsed || !args.headerLabel ? (
              <span className="sidebar-link-label">{visibleLabel}</span>
            ) : (
              args.headerLabel
            )}
            {!expanded
              ? renderSidebarGroupStatusBadges(args.status)
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
        headerButtonProps={{
          className: groupTriggerClassName,
          "aria-label": args.label,
          title: args.headerLabel ? undefined : args.label,
          onContextMenu: (event) =>
            handleSidebarGroupContextMenu(event, args.groupId),
          ...getSidebarRovingItemProps(createSidebarGroupFocusId(args.groupId)),
          "data-sidebar-nav-kind": "group",
          "data-sidebar-group-id": args.groupId,
        }}
        headerSupplement={args.headerSupplement}
        header={
          <span className="sidebar-group-heading-main">
            {args.headerLabel ?? (
              <span className="sidebar-link-label">{args.label}</span>
            )}
            <ArrowIcon
              className="sidebar-group-heading-arrow"
              expanded={expanded}
              width={18}
            />
            {!expanded ? renderSidebarGroupStatusBadges(args.status) : null}
          </span>
        }
        headerActions={
          <>
            {args.headerActions}
            {args.groupId === "assistants"
              ? renderAssistantSortButton({ tabIndex: -1 })
              : null}
            {args.groupId === "assistants" ? (
              <Tooltip
                content={
                  refreshingAssistantNavAgents
                    ? t("sidebar.assistants.refreshing")
                    : t("sidebar.assistants.refresh")
                }
              >
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-assistant-refresh-button"
                  aria-label={t("sidebar.assistants.refresh")}
                  title={t("sidebar.assistants.refresh")}
                  tabIndex={-1}
                  disabled={refreshingAssistantNavAgents}
                  onClick={handleRefreshAssistantNavAgents}
                >
                  {refreshingAssistantNavAgents ? (
                    <span
                      className="assistant-material-icon is-loading"
                      aria-hidden="true"
                    />
                  ) : (
                    <SidebarActionIcon kind="refresh" />
                  )}
                </button>
              </Tooltip>
            ) : null}
            {args.groupId === "assistants" ? (
              <Tooltip content={t("sidebar.project.new")}>
                <button
                  type="button"
                  className="assistant-worker-icon-button sidebar-assistant-project-button"
                  aria-label={t("sidebar.project.new")}
                  title={t("sidebar.project.new")}
                  tabIndex={-1}
                  disabled={creatingProject || Boolean(createProjectDialog)}
                  onClick={handleCreateProject}
                >
                  {creatingProject ? (
                    <span
                      className="assistant-material-icon is-loading"
                      aria-hidden="true"
                    />
                  ) : (
                    <SidebarActionIcon kind="new_project" />
                  )}
                </button>
              </Tooltip>
            ) : null}
            {args.groupId === "webs" ? (
              <>
                <Tooltip content={t("sidebar.website.actions")}>
                  <button
                    type="button"
                    className="assistant-worker-icon-button sidebar-website-add-button"
                    aria-label={t("sidebar.website.actions")}
                    title={t("sidebar.website.actions")}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      openNativeSidebarContextMenu(
                        { kind: "group", groupId: "webs" },
                        event.currentTarget,
                        { x: event.clientX, y: event.clientY },
                      );
                    }}
                  >
                    <SidebarActionIcon kind="new_project" />
                  </button>
                </Tooltip>
              </>
            ) : null}
          </>
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
                <div className="sidebar-empty-hint">
                  {t("sidebar.assistants.empty")}
                </div>
              ) : null}
            </div>
          ) : args.renderChildren ? (
            args.renderChildren({ roving: true })
          ) : args.children.length > 0 ? (
            args.children.map((item) => renderSidebarChildLink(item))
          ) : args.groupId === "webs" && websitesLoaded ? (
            <div className="sidebar-empty-hint">
              {t("sidebar.websites.empty")}
            </div>
          ) : null}
        </div>
      </Collapse>
    );
  }

  function renderPrimaryNavEntry(item: SidebarPrimaryEntry) {
    if (item.entryType === "chats") {
      return renderChatsEntry(item);
    }
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

  function renderToolLink(
    item: SidebarToolItem,
    options: {
      bootstrapGuide?: boolean;
      anchorRef?: Ref<HTMLAnchorElement>;
    } = {},
  ) {
    return (
      <NavLink
        key={item.to}
        ref={options.anchorRef}
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
            options.bootstrapGuide ? "is-bootstrap-guide" : "",
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

  function renderBootstrapGuideFloatingBubbles() {
    if (
      !bootstrapActive ||
      typeof document === "undefined" ||
      bootstrapGuideFloatingBubbles.length === 0
    ) {
      return null;
    }

    const appShell = (
      bootstrapGuideChatAnchorRef.current ??
      bootstrapGuideToolHelpAnchorRef.current
    )?.closest(".app-shell");
    if (!appShell) {
      return null;
    }

    return createPortal(
      <div className="sidebar-bootstrap-guide-layer" aria-live="polite">
        {bootstrapGuideFloatingBubbles.map((bubble) => (
          <div
            key={bubble.id}
            className={[
              "sidebar-bootstrap-guide-bubble",
              `is-${bubble.id}`,
              `is-${bubble.side}`,
            ]
              .filter(Boolean)
              .join(" ")}
            style={bubble.style}
            role="note"
          >
            {t(bubble.messageKey, { appName: PRODUCT_NAME })}
          </div>
        ))}
      </div>,
      appShell,
    );
  }

  function renderBootstrapGuideCard() {
    if (!showBootstrapGuideCard) {
      return null;
    }

    return (
      <section
        className="sidebar-bootstrap-guide-card"
        aria-label={t("sidebar.bootstrapGuide.title")}
      >
        <div className="sidebar-bootstrap-guide-card-head">
          <strong>{t("sidebar.bootstrapGuide.title")}</strong>
          <button
            type="button"
            className="sidebar-bootstrap-guide-card-dismiss"
            aria-label={t("sidebar.bootstrapGuide.dismiss")}
            title={t("sidebar.bootstrapGuide.dismiss")}
            onClick={() => setBootstrapGuideCardDismissed(true)}
          >
            <CloseOutlined aria-hidden="true" />
          </button>
        </div>
        <ol className="sidebar-bootstrap-guide-steps">
          <li>
            <span aria-hidden="true">1</span>
            {t("sidebar.bootstrapGuide.stepChat")}
          </li>
          <li>
            <span aria-hidden="true">2</span>
            {t("sidebar.bootstrapGuide.stepProfile")}
          </li>
          <li>
            <span aria-hidden="true">3</span>
            {t("sidebar.bootstrapGuide.stepHelp")}
          </li>
        </ol>
        <div className="sidebar-bootstrap-guide-actions">
          <button type="button" onClick={handleBootstrapGuideOpenChat}>
            {t("sidebar.bootstrapGuide.actionChat")}
          </button>
          <button type="button" onClick={handleBootstrapGuideOpenHelp}>
            {t("sidebar.bootstrapGuide.actionHelp")}
          </button>
        </div>
      </section>
    );
  }

  function getBootstrapGuideFloatingBubbles(): BootstrapGuideFloatingBubble[] {
    const bubbles: BootstrapGuideFloatingBubble[] = [];
    if (!bootstrapGuideDismissedBubbles.chat) {
      const chatBubble = createBootstrapGuideFloatingBubble(
        bootstrapGuideChatAnchorRef.current,
        "chat",
        "sidebar.bootstrapGuide.chatMessage",
      );
      if (chatBubble) {
        bubbles.push(chatBubble);
      }
    }

    if (
      !bootstrapGuideDismissedBubbles.help &&
      isPrimaryMode &&
      toolMenuOpen
    ) {
      const helpBubble = createBootstrapGuideFloatingBubble(
        bootstrapGuideToolHelpAnchorRef.current,
        "tool-help",
        "sidebar.bootstrapGuide.helpMessage",
      );
      if (helpBubble) {
        bubbles.push(helpBubble);
      }
    }

    return bubbles;
  }

  function dismissBootstrapGuideBubble(
    bubble: keyof BootstrapGuideDismissedBubbles,
  ) {
    setBootstrapGuideFloatingBubbles((current) =>
      current.filter((item) =>
        bubble === "chat" ? item.id !== "chat" : item.id !== "tool-help",
      ),
    );
    setBootstrapGuideDismissedBubbles((current) =>
      current[bubble]
        ? current
        : {
            ...current,
            [bubble]: true,
          },
    );
  }

  function createBootstrapGuideFloatingBubble(
    anchor: HTMLElement | null,
    id: BootstrapGuideFloatingBubble["id"],
    messageKey: TranslationKey,
  ): BootstrapGuideFloatingBubble | null {
    if (!anchor?.isConnected || typeof window === "undefined") {
      return null;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = BOOTSTRAP_GUIDE_BUBBLE_VIEWPORT_MARGIN;
    const availableWidth = Math.max(160, viewportWidth - margin * 2);
    const width = Math.min(BOOTSTRAP_GUIDE_BUBBLE_WIDTH, availableWidth);
    const fitsRight =
      rect.right + BOOTSTRAP_GUIDE_BUBBLE_GAP + width <= viewportWidth - margin;
    const fitsLeft = rect.left - BOOTSTRAP_GUIDE_BUBBLE_GAP - width >= margin;
    const side: BootstrapGuideFloatingBubble["side"] =
      fitsRight || !fitsLeft ? "right" : "left";
    const left =
      side === "right"
        ? Math.min(
            rect.right + BOOTSTRAP_GUIDE_BUBBLE_GAP,
            viewportWidth - width - margin,
          )
        : Math.max(margin, rect.left - width - BOOTSTRAP_GUIDE_BUBBLE_GAP);
    const top = Math.min(
      Math.max(rect.top + rect.height / 2, margin + 44),
      viewportHeight - margin - 44,
    );

    return {
      id,
      messageKey,
      side,
      style: {
        left: Math.round(left),
        top: Math.round(top),
        width,
      },
    };
  }

  function renderAccountMenuIcon(kind: "login" | "logout") {
    return (
      <span
        className={`sidebar-account-menu-icon is-${kind}`}
        aria-hidden="true"
      >
        <SidebarIllustration kind={kind} />
      </span>
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
          <span className="sidebar-account-menu-user-copy">
            <span className="sidebar-account-menu-label">
              {desktopSsoUserLabel}
            </span>
            {desktopSsoStatus.pending ||
            desktopSsoStatus.error ||
            !desktopSsoStatus.completedSteps.userInfo ||
            !desktopSsoStatus.completedSteps.accessToken ? (
              <span className="sidebar-account-menu-status">
                {desktopSsoStatus.message}
              </span>
            ) : null}
          </span>
          <span className="sidebar-account-menu-user-actions">
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
          </span>
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
        {renderAccountMenuIcon(
          desktopSsoStatus?.authenticated ? "login" : "logout",
        )}
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
        desktopSsoStatus.user?.sub?.trim() ||
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

  function closeToolMenu() {
    setToolMenuOpen(false);
  }

  function handleDesktopSsoMenuActionClick() {
    onDesktopSsoLogin?.();
    closeToolMenu();
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
    closeToolMenu();
  }

  function handleToolMenuOpenChange(open: boolean) {
    const requestId = toolMenuOpenRequestIdRef.current + 1;
    toolMenuOpenRequestIdRef.current = requestId;
    if (!open) {
      closeToolMenu();
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
    const topToolItems = fixedToolItems.filter(
      (item) =>
        item.to === "/agents" ||
        item.to === "/archives" ||
        item.to === "/registries" ||
        item.to === "/market" ||
        item.to === "/mcp-servers" ||
        item.to === "/skills",
    );

    return (
      <div
        className={[
          "sidebar-tool-menu",
          "sidebar-account-menu",
          showBootstrapHelpGuide ? "has-bootstrap-guide" : "",
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
        {renderToolLink(helpToolItem, {
          anchorRef: bootstrapGuideToolHelpAnchorRef,
          bootstrapGuide: showBootstrapHelpGuide,
        })}
        {settingsToolItem ? renderToolLink(settingsToolItem) : null}
      </div>
    );
  }

  function handleOpenAgentMenu(
    event: MouseEvent<HTMLButtonElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "agent", agentKey: agent.agentKey },
      event.currentTarget,
      { x: event.clientX, y: event.clientY },
    );
  }

  function handleAgentContextMenu(
    event: MouseEvent<HTMLElement>,
    agent: AssistantNavAgentItem,
  ) {
    event.preventDefault();
    event.stopPropagation();
    openNativeSidebarContextMenu(
      { kind: "agent", agentKey: agent.agentKey },
      event.currentTarget,
      event.clientX === 0 && event.clientY === 0
        ? undefined
        : { x: event.clientX, y: event.clientY },
    );
  }

  function getRevealWorkspaceDisabledReason(agent: AssistantNavAgentItem) {
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
    return agent.mode?.trim().toUpperCase() === "CODER";
  }

  function canOpenAgentProjectEditor(agent: AssistantNavAgentItem) {
    const mode = agent.mode?.trim().toUpperCase() ?? "";
    if (mode === "KBASE") {
      return true;
    }
    return mode === "CODER" && !getRevealWorkspaceDisabledReason(agent);
  }

  function createAgentEditRoute(agent: AssistantNavAgentItem) {
    return createAgentWebclientManagementPath(agent.agentKey);
  }

  async function handleRevealWorkspace(agent: AssistantNavAgentItem) {
    const disabledReason = getRevealWorkspaceDisabledReason(agent);
    if (disabledReason) {
      return;
    }
    if (agent.workspaceDir) {
      await revealWorkspaceDirectory(agent.workspaceDir, agent.agentKey);
    }
  }

  async function revealWorkspaceDirectory(
    workspaceDir: string,
    _agentKey: string,
  ) {
    await window.electronAPI.desktopShell.revealPath(workspaceDir);
  }

  function handleEditAgent(agent: AssistantNavAgentItem) {
    requestNavigate(createAgentEditRoute(agent));
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
          className="sidebar-agent-dialog sidebar-chat-rename-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-chat-rename-dialog-title"
          onSubmit={(event) => void handleConfirmRenameChat(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-agent-dialog-head">
            <strong id="sidebar-chat-rename-dialog-title">
              {t("sidebar.chat.renameTitle")}
            </strong>
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
              {assistantChatRenameDialog.pending
                ? t("sidebar.common.processing")
                : t("common.save")}
            </button>
          </div>
        </form>
      </div>,
      document.body,
    );
  }

  function renderAssistantChatDeleteDialog() {
    if (!assistantChatDeleteDialog || typeof document === "undefined") {
      return null;
    }
    const chatLabel =
      assistantChatDeleteDialog.chat.chatName?.trim() ||
      assistantChatDeleteDialog.chat.chatId;
    return createPortal(
      <div
        className="sidebar-agent-dialog-layer"
        role="presentation"
        onMouseDown={() => {
          if (!assistantChatDeleteDialog.pending) {
            setAssistantChatDeleteDialog(null);
          }
        }}
      >
        <div
          className="sidebar-agent-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-chat-delete-dialog-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="sidebar-agent-dialog-head">
            <strong id="sidebar-chat-delete-dialog-title">
              {t("sidebar.chat.delete")}
            </strong>
            <button
              type="button"
              className="sidebar-agent-dialog-close"
              aria-label={t("common.close")}
              disabled={assistantChatDeleteDialog.pending}
              onClick={() => setAssistantChatDeleteDialog(null)}
            >
              ×
            </button>
          </div>
          <p className="sidebar-agent-dialog-message">
            {t("sidebar.chat.deleteConfirm", { name: chatLabel })}
          </p>
          {assistantChatDeleteDialog.error ? (
            <div className="sidebar-agent-dialog-error" role="alert">
              {assistantChatDeleteDialog.error}
            </div>
          ) : null}
          <div className="sidebar-agent-dialog-actions">
            <button
              type="button"
              className="sidebar-agent-secondary-button"
              disabled={assistantChatDeleteDialog.pending}
              onClick={() => setAssistantChatDeleteDialog(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="sidebar-agent-danger-button"
              disabled={assistantChatDeleteDialog.pending}
              onClick={() => void handleConfirmDeleteChat()}
            >
              {assistantChatDeleteDialog.pending
                ? t("sidebar.common.processing")
                : t("common.confirm")}
            </button>
          </div>
        </div>
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
            <strong id="sidebar-create-project-dialog-title">
              {t("sidebar.project.createTitle")}
            </strong>
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
                  autoFocus
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
          {createProjectDialog.projectType === "coder" &&
          createProjectDialog.useAcp ? (
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
              {createProjectDialog.pending
                ? t("sidebar.project.creating")
                : t("sidebar.project.create")}
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
    const websiteDialogTitle = t("sidebar.website.title");
    const websiteSubmitLabel = websiteCreatePending
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
            <strong id="sidebar-website-dialog-title">
              {websiteDialogTitle}
            </strong>
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
              {copilotAgentOptions.map((agent) => {
                const agentRole = getAssistantAgentRoleLabel(agent);
                return (
                  <option value={agent.agentKey} key={agent.agentKey}>
                    {agent.displayName}
                    {agentRole ? ` · ${agentRole}` : ""}
                  </option>
                );
              })}
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

  function renderSettingsNav() {
    return (
      <div className="sidebar-settings-nav">
        <button
          type="button"
          className="sidebar-link sidebar-link-utility sidebar-settings-back"
          onClick={() => onExitSecondarySidebarMode?.()}
        >
          <span className="sidebar-link-icon" aria-hidden="true">
            <SettingsSidebarIcon kind="back" />
          </span>
          <span className="sidebar-link-label">{t("settings.backToApp")}</span>
        </button>
        <label
          className="sidebar-settings-search"
          aria-label={t("settings.searchAriaLabel")}
        >
          <span className="sidebar-settings-search-icon" aria-hidden="true">
            <SettingsSidebarIcon kind="search" />
          </span>
          <input
            type="search"
            value={settingsSearchQuery}
            placeholder={t("settings.searchPlaceholder")}
            onChange={(event) =>
              setSettingsSearchQuery(event.currentTarget.value)
            }
          />
        </label>
        <nav
          className="sidebar-settings-directory"
          aria-label={t("settings.directory")}
        >
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
                            routeActive || isActive
                              ? "sidebar-link-active"
                              : "",
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
                          <SettingsSidebarIcon kind={section.id} />
                        </span>
                        <span className="sidebar-link-label">
                          {section.label}
                        </span>
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

  function renderCapabilitiesNav() {
    const activeCapabilityItem = getCapabilityNavigationItem(
      displayCurrentPathname,
    );
    const pendingCapabilityItem = getCapabilityNavigationItem(
      pendingPath ?? "",
    );
    const selectedCapabilityItem = pendingCapabilityItem ?? activeCapabilityItem;

    return (
      <div className="sidebar-settings-nav sidebar-capabilities-nav">
        <button
          type="button"
          className="sidebar-link sidebar-link-utility sidebar-settings-back"
          onClick={() => onExitSecondarySidebarMode?.()}
        >
          <span className="sidebar-link-icon" aria-hidden="true">
            <SettingsSidebarIcon kind="back" />
          </span>
          <span className="sidebar-link-label">{t("settings.backToApp")}</span>
        </button>
        <nav
          className="sidebar-settings-directory sidebar-capabilities-directory"
          aria-label={t("nav.capabilities")}
        >
          <div className="settings-section-group-items">
            {capabilityNavigationItems.map((item) => {
              const isActive = selectedCapabilityItem?.id === item.id;
              return (
                <NavLink
                  key={item.id}
                  to={item.to}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "sidebar-link",
                    isActive ? "sidebar-link-active" : "",
                    pendingCapabilityItem?.id === item.id ? "is-pending" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={(event) => handleToolItemClick(event, item.to)}
                >
                  <span className="sidebar-link-icon" aria-hidden="true">
                    <SidebarIllustration kind={item.icon} />
                  </span>
                  <span className="sidebar-link-label">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>
      </div>
    );
  }

  const shouldRenderCollapsed = isCollapsed && isPrimaryMode;
  const activeToolMenuItem =
    fixedToolItems.find((item) => isFixedToolRouteActive(item.to)) ??
    (isFixedToolRouteActive(helpToolItem.to) ? helpToolItem : undefined);
  const shouldRenderDesktopSsoTrigger =
    desktopSsoStatus?.configured === true;
  const shouldRenderDesktopSsoTriggerAvatar =
    shouldRenderDesktopSsoTrigger &&
    desktopSsoStatus.authenticated;
  const desktopSsoUserLabel = shouldRenderDesktopSsoTriggerAvatar
    ? getDesktopSsoUserLabel()
    : "";
  const shouldRenderActiveToolMenuLabel =
    shouldRenderDesktopSsoTriggerAvatar && Boolean(activeToolMenuItem);
  const toolMenuTriggerLabel = shouldRenderDesktopSsoTrigger
    ? desktopSsoStatus.authenticated
      ? activeToolMenuItem?.label || desktopSsoUserLabel
      : t("sidebar.sso.signedOut")
    : t("nav.settings");

  return (
    <>
      <aside
        className={
          shouldRenderCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"
        }
      >
        <div className="sidebar-chrome">
          <div className={chromeToolbarClassName}>
            <div className="sidebar-top-actions">
              {isPrimaryMode ? (
                <button
                  type="button"
                  className="app-sidebar-collapse-button sidebar-global-search-button is-compact"
                  aria-label={t("desktop.globalSearch.title")}
                  title={t("desktop.globalSearch.shortcutHint")}
                  onClick={onOpenGlobalSearch}
                >
                  <SettingsSidebarIcon kind="search" />
                </button>
              ) : null}
              {isPrimaryMode ? (
                <SidebarCollapseToggle
                  className="sidebar-collapsed-toggle-button"
                  isCollapsed={isCollapsed}
                  variant="compact"
                  onToggleCollapsed={onToggleCollapsed}
                  t={t}
                />
              ) : null}
              {isPrimaryMode ? (
                <div className="sidebar-history-controls">
                  <button
                    type="button"
                    className="sidebar-history-button"
                    aria-label={t("sidebar.navigation.back")}
                    title={t("sidebar.navigation.back")}
                    disabled={!sidebarNavigationCanGoBack}
                    onClick={onSidebarNavigateBack}
                  >
                    <SidebarActionIcon kind="back" />
                  </button>
                  <button
                    type="button"
                    className="sidebar-history-button"
                    aria-label={t("sidebar.navigation.forward")}
                    title={t("sidebar.navigation.forward")}
                    disabled={!sidebarNavigationCanGoForward}
                    onClick={onSidebarNavigateForward}
                  >
                    <SidebarActionIcon kind="forward" />
                  </button>
                </div>
              ) : null}
              {isPrimaryMode && assistantLauncherVisible ? (
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
                      ? t("sidebar.copilot.unavailableForPage", {
                          appName: PRODUCT_NAME,
                        })
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
                    <SidebarActionIcon kind="sidebar_right" />
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <nav
          ref={sidebarNavRef}
          className="sidebar-nav"
          aria-label={
            isCapabilitiesMode
              ? t("nav.capabilities")
              : isSettingsMode
                ? t("settings.directory")
                : t("nav.main")
          }
          data-sidebar-roving-container={isPrimaryMode ? "true" : undefined}
          onKeyDown={handleSidebarNavKeyDown}
        >
          {isSettingsMode
            ? renderSettingsNav()
            : isCapabilitiesMode
              ? renderCapabilitiesNav()
              : navItems.map((item) => renderPrimaryNavEntry(item))}
        </nav>
        {renderBootstrapGuideCard()}

        {isPrimaryMode ? (
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
                      activeToolMenuItem ? "sidebar-link-active" : "",
                      toolMenuOpen ? "is-open" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-label={t("nav.sidebar.openSettings")}
                    aria-haspopup="menu"
                    aria-expanded={toolMenuOpen}
                    title={t("nav.settings")}
                  >
                    {!shouldRenderDesktopSsoTrigger ? (
                      <span className="sidebar-link-icon">
                        <SidebarIllustration kind="settings" />
                      </span>
                    ) : shouldRenderDesktopSsoTriggerAvatar &&
                      !shouldRenderActiveToolMenuLabel ? (
                      <AccountMenuAvatar
                        avatarUrl={desktopSsoStatus.user?.avatarUrl}
                        label={desktopSsoUserLabel}
                      />
                    ) : null}
                    <span className="sidebar-link-label">
                      {toolMenuTriggerLabel}
                    </span>
                    {shouldRenderActiveToolMenuLabel ? (
                      <AccountMenuAvatar
                        avatarUrl={desktopSsoStatus.user?.avatarUrl}
                        label={desktopSsoUserLabel}
                      />
                    ) : null}
                    {shouldRenderDesktopSsoTrigger ? (
                      <span
                        className="sidebar-link-icon sidebar-tool-menu-trigger-settings-icon"
                        aria-hidden="true"
                      >
                        <SidebarIllustration kind="settings" />
                      </span>
                    ) : null}
                    <span
                      className="sidebar-link-label-collapsed"
                      aria-hidden="true"
                    >
                      {getCollapsedSidebarLabel(t("nav.settings"))}
                    </span>
                  </button>
                </Popover>
              </div>
              {renderAssistantChatRenameDialog()}
              {renderAssistantChatDeleteDialog()}
              <ConversationShareDialog
                state={conversationShareDialog.state}
                t={t}
                onClose={conversationShareDialog.close}
                onCreate={() => void conversationShareDialog.create()}
                onCopy={() => void conversationShareDialog.copy()}
                onRevoke={() => void conversationShareDialog.revoke()}
              />
              <ChatInfoDialog
                state={chatInfoDialog.state}
                t={t}
                onRetry={chatInfoDialog.retry}
                onClose={chatInfoDialog.close}
              />
              {renderCreateProjectDialog()}
              {renderWebsiteDialog()}
            </div>
          </div>
        ) : null}
      </aside>
      {renderWebappImportFailureDialog()}
      {renderBootstrapGuideFloatingBubbles()}
    </>
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
