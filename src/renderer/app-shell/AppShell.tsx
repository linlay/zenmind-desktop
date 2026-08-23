import { createElement, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from "react-router-dom";
import { AppSidebar } from "./navigation/AppSidebar";
import {
  isCapabilityNavigationRoute,
  resolveSidebarMode,
} from "./navigation/capabilityNavigation";
import type { WebsiteFaviconCache } from "../components/Favicon";
import { SidebarActionIcon } from "../components/BrandMark";
import { DesktopGlobalSearchOverlay } from "./search/DesktopGlobalSearchOverlay";
import { DesktopActionConfirmationDialog } from "./DesktopActionConfirmationDialog";
import { DesktopShutdownOverlay } from "./DesktopShutdownOverlay";
import { ChatHistoryDialog } from "./history/ChatHistoryDialog";
import { BuiltinBrowserSurfaceHost, EmptyWebSurfaceRoute, WebRouteFallback, WebSurfaceHost, ExternalItemRoute, ServiceWebviewSurfaceHost } from "./embedded-surfaces/EmbeddedSurfaceHosts";
import { EmptyContentSurface } from "./EmptyContentSurface";
import { StartupLoadingScreen } from "./startup/StartupGate";
import { EnvImportOverlay } from "./startup/EnvImportOverlay";
import { AgentWebclientCopilotDock } from "../copilot/sidebar-copilot/AgentWebclientCopilotDock";
import {
  clearCopilotDockSessionSnapshot,
  readCopilotDockSessionSnapshot,
  writeCopilotDockSessionSnapshot,
  type CopilotDockContextSession,
  type CopilotDockSessionSnapshot
} from "../copilot/sidebar-copilot/copilotDockSession";
import { DebugModeContext } from "../debug/DebugModeContext";
import { useServices } from "../services/ServicesContext";
import { getAssistantPageContext } from "../copilot/page-context/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "../services/currentPageContext";
import {
  registerDesktopActionProviderForScope,
  setDesktopActionTranslator,
  startDesktopActionRendererBridge
} from "../services/desktopActionRegistry";
import { readWebSurfaceState } from "../services/webSurfaceStateRegistry";
import type { AssistantHistoryChatItem, AssistantNavAgentItem, AssistantNavAgentItemsResult, AssistantNavChatItem, AssistantNavigationListOptions, AssistantSettingsPublic, AssistantWorkerOpenRequest, DesktopActionConfirmationDecision, DesktopActionConfirmationRequest, DesktopSsoEmbeddedLoginRequest, DesktopSsoStatus, ServiceId, ShutdownProgress, StartupRestoreState, WebappDeleteResult, WebappEntry, WebappExportResult, WebappImportResult, WebEntry, WebEntryKey, WebappRuntimeState, WebsiteEntry, WebsiteInput, WebsiteResult } from "../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  isDesktopCopilotPageKey
} from "../../shared/assistant-settings";
import {
  resolveDesktopCopilotPreference
} from "../../shared/page-copilot";
import { shouldShowStartupProgressCard } from "../../shared/startup-gate";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../shared/browser-surfaces";
import {
  createServiceSurfaceIdentity,
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity,
  resolveLegacyFixedSurfaceId
} from "../../shared/surface-identity";
import { STORAGE_NAMESPACE } from "../../shared/brand";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_MAX_WIDTH,
  normalizeSidebarLayoutState,
  resolveRenderedSidebarWidth,
  resolveSidebarLayoutStateFromDrag,
  toggleSidebarLayoutState,
  type SidebarLayoutState
} from "../../shared/sidebar-layout";
import {
  WORK_PANEL_MIN_WIDTH,
  WORK_PANEL_RESIZE_STEP,
  clampWorkPanelWidth,
  normalizeStoredWorkPanelWidth,
  resolveDefaultWorkPanelWidth,
  resolveWorkPanelMaxWidth,
  resolveWorkPanelWidthFromDrag,
} from "../../shared/work-panel-layout";
import {
  COPILOT_DOCK_MIN_WIDTH,
  COPILOT_DOCK_RESIZE_STEP,
  clampCopilotDockWidth,
  normalizeStoredCopilotDockWidth,
  resolveCopilotDockMaxWidth,
  resolveCopilotDockWidthFromDrag,
  resolveRenderedCopilotDockWidth,
  shouldOverlayCopilotDock,
} from "../../shared/copilot-dock-layout";
import { getServiceDisplayName } from "../service-display";
import {
  createWebNavOrderKey,
  createDefaultSidebarNavOrderItems,
  normalizeSidebarNavOrder,
  type SidebarNavOrderItem,
  type SidebarNavOrderItemKey
} from "./navigation/sidebarNavOrder";
import { useI18n } from "../i18n/useI18n";
import {
  buildLocalizedSettingsSections,
  getVisibleSettingsSections,
  type SettingsSectionId
} from "../settingsPageSections";
import {
  buildSettingsSectionPath,
  getDefaultSettingsSectionPath,
  isSettingsRoute as matchSettingsRoute,
  resolveSettingsSectionId
} from "../settings/settingsRoutes";
import {
  isAssistantNavChatAgent,
  normalizeAssistantNavAgentItemsResult,
  normalizeAssistantNavAgents,
  resolveAssistantNavChatRuntimeAgent,
  resolveFirstInstallBootstrapNavigationTarget,
} from "../assistantNavigation";
import {
  AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS,
  AGENT_WEBCLIENT_ROUTE_DEFINITIONS,
  AGENT_WEBCLIENT_SERVICE_ID,
  AGENT_WEBCLIENT_TARGET_PATH,
  createAgentWebclientAgentPath,
  createAgentWebclientBusinessSearch,
  createAgentWebclientCopilotPath,
  createAgentWebclientManagementPath,
  createAgentWebclientOverviewPath,
  createAgentWebclientProjectPath,
  createAgentWebclientRoute,
  findAgentWebclientRouteDefinition,
  isEmbeddedAgentWebclientRoute,
  type AgentWebclientResolvedRoute
} from "../../shared/agent-webclient-routes";
import { decodeRoutePathSegment } from "../../shared/route-path";
import { I18N_KEYS, isSupportedLocale, type TranslationKey } from "../../shared/i18n";
import { EnterpriseChatFloatingPanel } from "../enterprise-chat/EnterpriseChatFloatingPanel";
import { WorkPanelHost } from "../work-panel/WorkPanelHost";
import {
  ProjectFloatingWebviews,
  type ProjectFloatingWebviewEntry,
} from "./project/ProjectFloatingWebviews";
import {
  EMPTY_WORK_PANEL_STATE,
  reduceWorkPanelCommand,
  type WorkPanelCommand,
  type WorkPanelState,
} from "../../shared/work-panel";

type ThemePreference = "light" | "dark" | "system";
type ResolvedThemeMode = "light" | "dark";
type AgentChatFocusRequest = {
  id: number;
  sourceRoute: string;
  targetRoute: string;
};
type ChatHistoryDialogRequest = {
  id: number;
  agentKey: string;
};
type WebappRuntimeViewState = {
  status: "idle" | "starting" | "running" | "blocked" | "error";
  webUrl: string;
  message: string;
  state: WebappRuntimeState | null;
};

type WebappNavigationEntry = WebappEntry & {
  url: string;
  chrome: "app";
  runtimeStatus: WebappRuntimeViewState["status"];
  runtimeMessage: string;
};

type WebNavigationEntry = WebsiteEntry | WebappNavigationEntry;

type ExternalExperimentalItem = {
  id: string;
  kind?: "website" | "webapp";
  label: string;
  url: string;
  chrome?: "browser" | "app";
  runtimeStatus?: WebappRuntimeViewState["status"];
  runtimeMessage?: string;
};

const EMPTY_WEB_SURFACE_ROUTE = "/webs";

function resolveAssistantNavDisplayItems(result: AssistantNavAgentItemsResult) {
  const activityItems = Array.isArray(result.activityItems) ? result.activityItems : [];
  return activityItems.length > 0 ? activityItems : result.items;
}

function getChatNavigationAgentOptions(items: AssistantNavAgentItem[]) {
  return items.filter(isAssistantNavChatAgent);
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark") {
      return "dark";
    }
    if (savedTheme === "system") {
      return "system";
    }
    return "light";
  } catch {
    return "light";
  }
}

function normalizeDesktopAppVersion(version: string) {
  const normalized = version.trim().replace(/^v/iu, "");
  return normalized ? `v${normalized}` : "";
}

function resolveThemePreference(preference: ThemePreference): ResolvedThemeMode {
  if (preference === "system") {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }
  return preference;
}

const HelpPage = lazy(() =>
  import("../pages/HelpPage").then((module) => ({ default: module.HelpPage }))
);
const FunctionalMarketPage = lazy(() =>
  import("../pages/functional-market").then((module) => ({ default: module.FunctionalMarketPage }))
);
const PluginSettingsPage = lazy(() =>
  import("../pages/plugin/PluginSettingsPage").then((module) => ({ default: module.PluginSettingsPage }))
);
const SettingsPage = lazy(() =>
  import("../pages/settings/SettingsPage").then((module) => ({ default: module.SettingsPage }))
);
const KanbanPage = lazy(() =>
  import("../pages/kanban/KanbanPage").then((module) => ({ default: module.KanbanPage }))
);

const THEME_STORAGE_KEY = `${STORAGE_NAMESPACE}.theme`;
const SIDEBAR_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar`;
const SIDEBAR_NAV_ORDER_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-nav-order`;
const WEB_GROUP_ORDER_STORAGE_KEY = `${STORAGE_NAMESPACE}.web-group-order`;
const WORK_PANEL_WIDTH_STORAGE_KEY = `${STORAGE_NAMESPACE}.work-panel-width`;
const COPILOT_DOCK_WIDTH_STORAGE_KEY = `${STORAGE_NAMESPACE}.copilot-dock-width`;
const SETTINGS_SIDEBAR_WIDTH = 200;
const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
const LEGACY_AGENT_WEBCLIENT_SERVICE_PATH = "/service/agent-webclient";
const SIDEBAR_NAVIGATION_LOCK_MS = 900;
const STARTUP_SERVICE_IDS = ["identity-center", "agent-platform", "agent-webclient"] as const;
const STARTUP_LOADING_TIMEOUT_MS = 45000;

const STARTUP_STATUS_REFRESH_MS = 1500;
const REPORTED_LEGACY_PUBLIC_SURFACE_IDS = new Set<string>();
function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function LegacyAgentWebclientServiceRouteRedirect() {
  const location = useLocation();
  const embedPath = readAgentWebclientRouteEmbedPath(location.search);
  return embedPath ? null : <Navigate to={ASSISTANT_TARGET_PATH} replace />;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function createUnavailableDesktopSsoStatus(message: string): DesktopSsoStatus {
  return {
    configured: true,
    authenticated: false,
    pending: false,
    user: null,
    completedSteps: {
      session: false,
      userInfo: false,
      accessToken: false,
    },
    message,
    error: "Desktop SSO preload API unavailable.",
    updatedAt: new Date().toISOString()
  };
}

function isCompleteDesktopSsoLogin(status: DesktopSsoStatus) {
  return status.authenticated &&
    status.completedSteps.session &&
    status.completedSteps.userInfo &&
    status.completedSteps.accessToken &&
    !status.error;
}

function getDesktopSsoApi() {
  return window.electronAPI.sso;
}

function readStoredSidebarNavOrder(storageKey: string): SidebarNavOrderItemKey[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const savedValue = window.localStorage.getItem(storageKey);
    const parsed = savedValue ? JSON.parse(savedValue) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is SidebarNavOrderItemKey => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function isKanbanNavigationPath(targetPath: string) {
  return /^\/kanban(?:[/?#]|$)/.test(targetPath);
}

function getKanbanAwareFallbackPath(kanbanEnabled: boolean) {
  return kanbanEnabled ? "/kanban" : "/control-center";
}

function resolveKanbanAwareNavigationPath(targetPath: string, kanbanEnabled: boolean) {
  return !kanbanEnabled && isKanbanNavigationPath(targetPath) ? "/control-center" : targetPath;
}

function isSettingsRedirectRoute(targetPath: string) {
  return (targetPath.split("?")[0] || "/") === "/control-center";
}

function getSecondarySidebarExitFallbackPath(
  kanbanEnabled: boolean,
  chatAgentKey = "",
) {
  if (kanbanEnabled) {
    return "/kanban";
  }
  const normalizedChatAgentKey = chatAgentKey.trim();
  return normalizedChatAgentKey
    ? createAgentNewChatRoute(normalizedChatAgentKey)
    : "/";
}

function isSecondarySidebarRoute(targetPath: string) {
  const targetPathname = targetPath.split("?")[0] || "/";
  return (
    isSettingsRedirectRoute(targetPath) ||
    matchSettingsRoute(targetPathname) ||
    isCapabilityNavigationRoute(targetPathname)
  );
}

function resolveSecondarySidebarExitTargetPath(
  targetPath: string,
  kanbanEnabled: boolean,
  chatAgentKey = "",
) {
  const targetPathname = targetPath.split("?")[0] || "/";
  if (
    !targetPath ||
    isSecondarySidebarRoute(targetPath) ||
    (!kanbanEnabled && isKanbanNavigationPath(targetPath))
  ) {
    return getSecondarySidebarExitFallbackPath(
      kanbanEnabled,
      chatAgentKey,
    );
  }
  return targetPath;
}

function removeSecondarySidebarRoutesFromHistory(history: string[]) {
  return history.filter((item) => !isSecondarySidebarRoute(item));
}

function isMarketSettingsVisible(settings: { enabled?: boolean; apiBaseUrl?: string } | null | undefined) {
  return settings?.enabled === true;
}

function readInitialWebGroupOrder(): SidebarNavOrderItemKey[] {
  const savedGroupOrder = readStoredSidebarNavOrder(WEB_GROUP_ORDER_STORAGE_KEY);
  if (savedGroupOrder.length > 0) {
    return savedGroupOrder;
  }
  return readStoredSidebarNavOrder(SIDEBAR_NAV_ORDER_STORAGE_KEY)
    .map((key) => key.startsWith("custom:") ? `website:${key.slice("custom:".length)}` as SidebarNavOrderItemKey : key)
    .filter((key) => key.startsWith("website:") || key.startsWith("webapp:"));
}

function normalizeWebGroupOrder(
  candidate: SidebarNavOrderItemKey[],
  webItems: WebEntry[]
) {
  const availableKeys = new Set(webItems.map((item) => createWebNavOrderKey(item.entryKey)));
  const normalized = candidate.filter((key) => availableKeys.has(key));
  for (const item of webItems) {
    const key = createWebNavOrderKey(item.entryKey);
    if (!normalized.includes(key)) {
      normalized.push(key);
    }
  }
  return normalized;
}

export const EXTERNAL_EXPERIMENTAL_ITEMS: readonly ExternalExperimentalItem[] = [];

function mergeWebsiteItems(currentItems: WebEntry[], nextWebsiteItems: WebsiteEntry[]) {
  const nextWebsiteByEntryKey = new Map(nextWebsiteItems.map((item) => [item.entryKey, item]));
  const mergedItems: WebEntry[] = [];

  for (const item of currentItems) {
    if (item.kind !== "website") {
      mergedItems.push(item);
      continue;
    }

    const nextWebsiteItem = nextWebsiteByEntryKey.get(item.entryKey);
    if (nextWebsiteItem) {
      mergedItems.push(nextWebsiteItem);
      nextWebsiteByEntryKey.delete(item.entryKey);
    }
  }

  for (const item of nextWebsiteItems) {
    if (nextWebsiteByEntryKey.has(item.entryKey)) {
      mergedItems.push(item);
    }
  }

  return mergedItems;
}

type SidebarResizeDragState = {
  initialState: SidebarLayoutState;
  startClientX: number;
};

type WorkPanelResizeDragState = {
  initialWidth: number;
  pointerId: number;
  startClientX: number;
};

type CopilotDockResizeDragState = {
  initialWidth: number;
  pointerId: number;
  startClientX: number;
};

type SidebarNavigationHistory = {
  back: string[];
  forward: string[];
};

function inferDesktopPlatform() {
  if (typeof navigator === "undefined") {
    return "";
  }
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X")) {
    return "darwin";
  }
  if (userAgent.includes("Windows")) {
    return "win32";
  }
  return "";
}

function createFallbackStartupRestoreState(): StartupRestoreState {
  return {
    mode: "restore",
    phase: "idle",
    serviceOrder: [...STARTUP_SERVICE_IDS],
    currentServiceId: null,
    failedServiceId: null,
    message: "",
    updatedAt: "",
    services: STARTUP_SERVICE_IDS.map((serviceId) => ({
      serviceId,
      phase: "pending"
    }))
  };
}

const BROWSER_CHROME_DRAG_BLOCK_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role=\"button\"]",
  "[role=\"tab\"]",
  "[contenteditable=\"true\"]",
  ".external-webview-tab",
  ".external-webview-toolbar-location"
].join(",");

const SIDEBAR_DRAG_BLOCK_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role=\"button\"]",
  "[role=\"menuitem\"]",
  "[contenteditable=\"true\"]"
].join(",");

function resolveWindowDragTarget(target: Element | null) {
  const dragRegion = target?.closest(".app-window-drag-region");
  if (dragRegion) {
    return dragRegion;
  }

  const sidebarShell = target?.closest(".app-sidebar-shell");
  if (sidebarShell && !target?.closest(SIDEBAR_DRAG_BLOCK_SELECTOR)) {
    return sidebarShell;
  }

  const browserChrome = target?.closest(".external-webview-browser-chrome");
  if (!browserChrome || target?.closest(BROWSER_CHROME_DRAG_BLOCK_SELECTOR)) {
    return null;
  }
  if (browserChrome.closest(".external-webview-page.is-inactive-surface")) {
    return null;
  }

  return browserChrome;
}

export function AppShell() {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { services, loading: servicesLoading, error: servicesError, refresh: refreshServices } = useServices();
  const sidebarNavigationUnlockTimerRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<SidebarResizeDragState | null>(null);
  const workPanelResizeStateRef = useRef<WorkPanelResizeDragState | null>(null);
  const workPanelResizeCleanupRef = useRef<(() => void) | null>(null);
  const copilotDockResizeStateRef = useRef<CopilotDockResizeDragState | null>(null);
  const copilotDockResizeCleanupRef = useRef<(() => void) | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const appContentRef = useRef<HTMLDivElement | null>(null);
  const windowDragEndRef = useRef<(() => void) | null>(null);
  const pendingAssistantDockOpenRequestRef = useRef<{ contextKey: string; embedPath: string } | null>(null);
  const assistantDockSessionsRef = useRef<Record<string, CopilotDockContextSession>>({});
  const pendingCopilotRestoreRef = useRef<CopilotDockSessionSnapshot | null>(null);
  const copilotRestoreInitializedRef = useRef(false);
  const copilotRestoreAttemptedRef = useRef(false);
  if (!copilotRestoreInitializedRef.current) {
    pendingCopilotRestoreRef.current = readCopilotDockSessionSnapshot();
    copilotRestoreInitializedRef.current = true;
  }
  const bootstrapInitialNavigationDoneRef = useRef(false);
  const firstInstallBootstrapNavigationRequestRef = useRef<Promise<{ shouldOpen: boolean }> | null>(null);
  const lastPrimaryRouteRef = useRef("/kanban");
  const aboutSettingsClickCountRef = useRef(0);
  const refreshServicesRef = useRef(refreshServices);
  const assistantNavAgentsRefreshIdRef = useRef(0);
  const chatDefaultAgentMigrationRef = useRef("");
  const [desktopPlatform, setDesktopPlatform] = useState(inferDesktopPlatform);
  const [windowFullScreen, setWindowFullScreen] = useState(false);
  const [workPanelFullscreenOwnerChatId, setWorkPanelFullscreenOwnerChatId] =
    useState<string | null>(null);
  const workPanelFullscreenOwnerChatIdRef = useRef<string | null>(null);
  const workPanelEnteredNativeFullscreenRef = useRef(false);
  const workPanelFullscreenTransitionPendingRef = useRef(false);
  const [shutdownProgress, setShutdownProgress] = useState<ShutdownProgress | null>(null);
  const [desktopAppVersion, setDesktopAppVersion] = useState("");
  const [themeMode, setThemeMode] = useState<ThemePreference>(() => readStoredThemePreference());
  const [themePreferenceLoaded, setThemePreferenceLoaded] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedThemeMode>(() => resolveThemePreference(readStoredThemePreference()));
  const [sidebarState, setSidebarState] = useState<SidebarLayoutState>(() => {
    if (typeof window === "undefined") {
      return normalizeSidebarLayoutState(null);
    }
    try {
      const savedValue = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (!savedValue) {
        return normalizeSidebarLayoutState(null);
      }
      return normalizeSidebarLayoutState(JSON.parse(savedValue));
    } catch {
      return normalizeSidebarLayoutState(null);
    }
  });
  const [sidebarNavOrder, setSidebarNavOrder] = useState<SidebarNavOrderItemKey[]>(() =>
    readStoredSidebarNavOrder(SIDEBAR_NAV_ORDER_STORAGE_KEY)
  );
  const [kanbanEnabled, setKanbanEnabled] = useState(true);
  const [kanbanSettingsLoaded, setKanbanSettingsLoaded] = useState(false);
  const [marketEnabled, setMarketEnabled] = useState(false);
  const [marketSettingsLoaded, setMarketSettingsLoaded] = useState(false);
  const [debugSettingsUnlocked, setDebugSettingsUnlocked] = useState(false);
  const [webGroupOrder, setWebGroupOrder] = useState<SidebarNavOrderItemKey[]>(readInitialWebGroupOrder);
  const [navigationPreferencesLoaded, setNavigationPreferencesLoaded] = useState(false);
  const [assistantDockSessions, setAssistantDockSessions] = useState<Record<string, CopilotDockContextSession>>({});
  const [assistantDockOpenRequest, setAssistantDockOpenRequest] = useState<AssistantWorkerOpenRequest | null>(null);
  const [, setAssistantRunningRunId] = useState<string | null>(null);
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [firstInstallBootstrapNavigationRequested, setFirstInstallBootstrapNavigationRequested] =
    useState<boolean | null>(null);
  const [assistantNavAgents, setAssistantNavAgents] = useState<AssistantNavAgentItem[]>([]);
  const [assistantNavChatItems, setAssistantNavChatItems] = useState<AssistantNavChatItem[]>([]);
  const [assistantNavChatItemsHasMore, setAssistantNavChatItemsHasMore] = useState(false);
  const [projectFloatingWebviews, setProjectFloatingWebviews] =
    useState<ProjectFloatingWebviewEntry[]>([]);
  const projectFloatingFocusRequestIdRef = useRef(0);
  const [workPanelState, setWorkPanelState] = useState<WorkPanelState>(EMPTY_WORK_PANEL_STATE);
  const workPanelStateRef = useRef<WorkPanelState>(EMPTY_WORK_PANEL_STATE);
  const [assistantNavAgentsLoaded, setAssistantNavAgentsLoaded] = useState(false);
  const [chatNavAgentOptions, setChatNavAgentOptions] = useState<AssistantNavAgentItem[]>([]);
  const chatRuntimeAgent = useMemo(
    () => resolveAssistantNavChatRuntimeAgent(chatNavAgentOptions, {
      defaultChatAgentKey: assistantSettings?.chatDefaultAgentKey,
      bootstrapAgentKey: assistantSettings?.bootstrapAgentKey,
      bootstrapNavigationRequested: firstInstallBootstrapNavigationRequested === true,
    }),
    [
      assistantSettings?.bootstrapAgentKey,
      assistantSettings?.chatDefaultAgentKey,
      firstInstallBootstrapNavigationRequested,
      chatNavAgentOptions,
    ],
  );
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const chatHistoryDialogRequestIdRef = useRef(0);
  const [chatHistoryDialog, setChatHistoryDialog] =
    useState<ChatHistoryDialogRequest | null>(null);
  const agentChatFocusRequestIdRef = useRef(0);
  const [pendingAgentChatFocusRequest, setPendingAgentChatFocusRequest] =
    useState<AgentChatFocusRequest | null>(null);
  const [desktopActionConfirmation, setDesktopActionConfirmation] =
    useState<DesktopActionConfirmationRequest | null>(null);
  const [copilotAgentOptions, setCopilotAgentOptions] = useState<AssistantNavAgentItem[]>([]);
  const [nativeDialogVisible, setNativeDialogVisible] = useState(false);
  const [desktopSsoStatus, setDesktopSsoStatus] = useState<DesktopSsoStatus | null>(null);
  const [desktopSsoBusy, setDesktopSsoBusy] = useState(false);
  const [desktopSsoLoginDialog, setDesktopSsoLoginDialog] = useState<DesktopSsoEmbeddedLoginRequest | null>(null);
  const [desktopSsoLoginSettled, setDesktopSsoLoginSettled] = useState(false);
  const [webItems, setWebItems] = useState<WebEntry[]>([]);
  const [webItemsLoaded, setWebItemsLoaded] = useState(false);
  const [webappRuntimeById, setWebappRuntimeById] = useState<Record<string, WebappRuntimeViewState>>({});
  const [faviconCache, setFaviconCache] = useState<WebsiteFaviconCache>({});
  const webItemsRef = useRef<WebEntry[]>([]);
  const activeWebEntryKeyRef = useRef<WebEntryKey | null>(null);
  const webappStartInFlightRef = useRef<Set<string>>(new Set());
  const webappStopInFlightRef = useRef<Set<string>>(new Set());
  const websiteAgentSyncRequestRef = useRef("");
  const marketSettingsRefreshIdRef = useRef(0);
  const [pendingSidebarNavigationPath, setPendingSidebarNavigationPath] = useState<string | null>(null);
  const [sidebarNavigationHistory, setSidebarNavigationHistory] = useState<SidebarNavigationHistory>({
    back: [],
    forward: []
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isWorkPanelResizing, setIsWorkPanelResizing] = useState(false);
  const [isCopilotDockResizing, setIsCopilotDockResizing] = useState(false);
  const [appShellWidth, setAppShellWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth
  );
  const [appContentWidth, setAppContentWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth
  );
  const [preferredWorkPanelWidth, setPreferredWorkPanelWidth] = useState(() => {
    const fallbackWidth = resolveDefaultWorkPanelWidth(
      typeof window === "undefined" ? 1440 : window.innerWidth,
    );
    if (typeof window === "undefined") return fallbackWidth;
    try {
      const savedValue = window.localStorage.getItem(WORK_PANEL_WIDTH_STORAGE_KEY);
      return normalizeStoredWorkPanelWidth(savedValue ? JSON.parse(savedValue) : null, fallbackWidth);
    } catch {
      return fallbackWidth;
    }
  });
  const [preferredCopilotDockWidth, setPreferredCopilotDockWidth] = useState(() => {
    if (typeof window === "undefined") {
      return normalizeStoredCopilotDockWidth(null);
    }
    try {
      const savedValue = window.localStorage.getItem(COPILOT_DOCK_WIDTH_STORAGE_KEY);
      return normalizeStoredCopilotDockWidth(savedValue ? JSON.parse(savedValue) : null);
    } catch {
      return normalizeStoredCopilotDockWidth(null);
    }
  });
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [startupCardDismissed, setStartupCardDismissed] = useState(false);
  const [startupRestoreState, setStartupRestoreState] = useState<StartupRestoreState | null>(null);
  const [envImportBusy, setEnvImportBusy] = useState(false);
  const [envImportError, setEnvImportError] = useState("");
  const desktopActionConfirmationRef = useRef<DesktopActionConfirmationRequest | null>(null);
  const rawActiveAgentWebclientRoute = resolveAgentWebclientRoute(location.pathname, location.search, copilotAgentOptions);
  const rawActiveAgentWebclientRouteLabelKey = rawActiveAgentWebclientRoute?.labelKey;
  const activeAgentWebclientRoute = rawActiveAgentWebclientRoute
    ? {
        ...rawActiveAgentWebclientRoute,
        label: rawActiveAgentWebclientRouteLabelKey &&
          I18N_KEYS.includes(rawActiveAgentWebclientRouteLabelKey as TranslationKey)
          ? t(rawActiveAgentWebclientRouteLabelKey as TranslationKey)
          : rawActiveAgentWebclientRoute.label ?? rawActiveAgentWebclientRouteLabelKey
      }
    : null;
  const activeEmbeddedAgentWebclientRoute = isEmbeddedAgentWebclientRoute(activeAgentWebclientRoute)
    ? activeAgentWebclientRoute
    : null;
  const activeChatRouteInfo = readAgentRouteInfo(`${location.pathname}${location.search}`);
  const activeChatWorkPanelChatId = activeEmbeddedAgentWebclientRoute?.kind === "chat" && activeChatRouteInfo.chatId
    ? activeChatRouteInfo.chatId
    : null;
  const activeChatWorkPanelVisible = Boolean(
    activeChatWorkPanelChatId &&
    workPanelState.visibleOwnerChatIds.includes(activeChatWorkPanelChatId)
  );
  const showMainChatWorkPanelToggle = activeEmbeddedAgentWebclientRoute?.kind === "chat";
  const workPanelMaxWidth = resolveWorkPanelMaxWidth(appContentWidth || undefined);
  const renderedWorkPanelWidth = clampWorkPanelWidth(
    preferredWorkPanelWidth,
    appContentWidth || undefined,
  );
  const bareAgentWebclientServiceRoute = isBareAgentWebclientServiceRoute(location.pathname, location.search);
  const activeServiceId = activeEmbeddedAgentWebclientRoute
    ? AGENT_WEBCLIENT_SERVICE_ID
    : bareAgentWebclientServiceRoute
      ? null
      : resolveServiceSurfaceRouteId(location.pathname);
  const activeWebEntryKey = resolveWebRouteEntryKey(location.pathname);
  activeWebEntryKeyRef.current = activeWebEntryKey;
  const [mountedServiceIds, setMountedServiceIds] = useState<string[]>(() =>
    activeServiceId ? [activeServiceId] : []
  );
  const [mountedWebEntryKeys, setMountedWebEntryKeys] = useState<WebEntryKey[]>(() =>
    activeWebEntryKey ? [activeWebEntryKey] : []
  );
  const [builtinBrowserSurfaceMounted, setBuiltinBrowserSurfaceMounted] = useState(
    () => location.pathname === BUILTIN_BROWSER_ROUTE
  );
  const usesEmbeddedSurface =
    Boolean(activeEmbeddedAgentWebclientRoute) ||
    (!bareAgentWebclientServiceRoute && location.pathname.startsWith("/service/")) ||
    location.pathname.startsWith("/plugin/") ||
    location.pathname.startsWith("/plugin-settings/") ||
    location.pathname.startsWith("/external/") ||
    location.pathname === BUILTIN_BROWSER_ROUTE ||
    location.pathname === EMPTY_WEB_SURFACE_ROUTE ||
    location.pathname === "/help" ||
    location.pathname.startsWith("/webs/");
  const usesBuiltinBrowserSurface = location.pathname === BUILTIN_BROWSER_ROUTE;
  const shouldMountBuiltinBrowserSurface =
    location.pathname === EMPTY_WEB_SURFACE_ROUTE
      ? false
      : builtinBrowserSurfaceMounted || usesBuiltinBrowserSurface;
  const usesServiceWebviewSurface =
    Boolean(activeEmbeddedAgentWebclientRoute) ||
    (!bareAgentWebclientServiceRoute && location.pathname.startsWith("/service/")) ||
    location.pathname.startsWith("/plugin/") ||
    location.pathname.startsWith("/plugin-settings/");
  const isKanbanRoute = location.pathname === "/kanban";
  const isMarketRoute = location.pathname === "/market";
  const usesStandardBaseSurface =
    isKanbanRoute ||
    location.pathname === "/control-center" ||
    location.pathname === "/market" ||
    location.pathname === "/help" ||
    matchSettingsRoute(location.pathname);
  const isMac = desktopPlatform === "darwin";
  const isWindows = desktopPlatform === "win32";
  const isSettingsRoute = matchSettingsRoute(location.pathname);
  const sidebarMode = resolveSidebarMode(location.pathname);
  const isSecondarySidebarMode = sidebarMode !== "primary";
  const currentRoute = `${location.pathname}${location.search}`;
  const activeAgentChatFocusRequestId =
    !globalSearchOpen &&
    !chatHistoryDialog &&
    pendingAgentChatFocusRequest?.targetRoute === currentRoute
      ? pendingAgentChatFocusRequest.id
      : null;
  const settingsSectionDefinitions = useMemo(
    () => buildLocalizedSettingsSections({
      isWindows,
      desktopPetSupported: isMac || isWindows,
      debugVisible: debugSettingsUnlocked,
      t
    }),
    [debugSettingsUnlocked, isMac, isWindows, t]
  );
  const visibleSettingsSections = useMemo(
    () => getVisibleSettingsSections(settingsSectionDefinitions),
    [settingsSectionDefinitions]
  );
  const visibleSettingsSectionIds = useMemo(
    () => visibleSettingsSections.map((section) => section.id),
    [visibleSettingsSections]
  );
  const activeSettingsSectionId = resolveSettingsSectionId(location.pathname, visibleSettingsSectionIds);

  const clearWorkPanelFullscreen = useCallback(() => {
    workPanelFullscreenOwnerChatIdRef.current = null;
    workPanelEnteredNativeFullscreenRef.current = false;
    setWorkPanelFullscreenOwnerChatId(null);
  }, []);

  useEffect(() => {
    window.electronAPI.desktopShell.setWorkPanelFullscreenActive(
      Boolean(workPanelFullscreenOwnerChatId)
    );
  }, [workPanelFullscreenOwnerChatId]);

  useEffect(() => () => {
    window.electronAPI.desktopShell.setWorkPanelFullscreenActive(false);
  }, []);

  useEffect(() => {
    const desktopShell = window.electronAPI.desktopShell;
    if (!desktopShell.getWindowState || !desktopShell.onWindowStateChanged) {
      return undefined;
    }

    let active = true;
    void desktopShell.getWindowState().then((result) => {
      if (active && result.ok) {
        setWindowFullScreen(result.isFullScreen);
        if (!result.isFullScreen && workPanelFullscreenOwnerChatIdRef.current) {
          clearWorkPanelFullscreen();
        }
      }
    }).catch(() => undefined);

    const unsubscribe = desktopShell.onWindowStateChanged((state) => {
      if (active) {
        setWindowFullScreen(state.isFullScreen);
        if (!state.isFullScreen && workPanelFullscreenOwnerChatIdRef.current) {
          clearWorkPanelFullscreen();
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [clearWorkPanelFullscreen]);

  const changeWorkPanelFullscreen = useCallback(async (ownerChatId: string | null) => {
    const currentOwnerChatId = workPanelFullscreenOwnerChatIdRef.current;
    if (ownerChatId) {
      if (currentOwnerChatId === ownerChatId) return true;
      if (currentOwnerChatId || workPanelFullscreenTransitionPendingRef.current) return false;

      workPanelFullscreenTransitionPendingRef.current = true;
      try {
        const currentWindowState = await window.electronAPI.desktopShell.getWindowState();
        if (!currentWindowState.ok) return false;
        setWindowFullScreen(currentWindowState.isFullScreen);

        let enteredNativeFullscreen = false;
        if (!currentWindowState.isFullScreen) {
          const transition = await window.electronAPI.desktopShell.setWindowFullScreen(true);
          if (!transition.ok || !transition.isFullScreen) return false;
          setWindowFullScreen(true);
          enteredNativeFullscreen = true;
        }

        workPanelEnteredNativeFullscreenRef.current = enteredNativeFullscreen;
        workPanelFullscreenOwnerChatIdRef.current = ownerChatId;
        setWorkPanelFullscreenOwnerChatId(ownerChatId);
        return true;
      } catch {
        return false;
      } finally {
        workPanelFullscreenTransitionPendingRef.current = false;
      }
    }

    if (!currentOwnerChatId) return true;
    if (workPanelFullscreenTransitionPendingRef.current) return false;
    if (!workPanelEnteredNativeFullscreenRef.current) {
      clearWorkPanelFullscreen();
      return true;
    }

    workPanelFullscreenTransitionPendingRef.current = true;
    try {
      const transition = await window.electronAPI.desktopShell.setWindowFullScreen(false);
      if (!transition.ok && transition.isFullScreen) return false;
      setWindowFullScreen(false);
      clearWorkPanelFullscreen();
      return true;
    } catch {
      return false;
    } finally {
      workPanelFullscreenTransitionPendingRef.current = false;
    }
  }, [clearWorkPanelFullscreen]);

  const forceExitWorkPanelFullscreen = useCallback(() => {
    if (!workPanelFullscreenOwnerChatIdRef.current) return;
    const shouldExitNativeFullscreen = workPanelEnteredNativeFullscreenRef.current;
    clearWorkPanelFullscreen();
    if (!shouldExitNativeFullscreen) return;
    void window.electronAPI.desktopShell.setWindowFullScreen(false)
      .then((result) => {
        setWindowFullScreen(result.isFullScreen);
      })
      .catch(() => undefined);
  }, [clearWorkPanelFullscreen]);

  const startupServices = STARTUP_SERVICE_IDS.map((serviceId) =>
    services.find((service) => service.id === serviceId) ?? null
  );
  const startupAllReady =
    !servicesLoading &&
    startupServices.every((service) => service?.status === "running");
  const agentPlatformRunning = services.some((service) =>
    service.id === "agent-platform" &&
    service.status === "running"
  );
  const resolvedStartupRestoreState = startupRestoreState ?? createFallbackStartupRestoreState();
  const showStartupCard =
    !startupCardDismissed &&
    shouldShowStartupProgressCard(startupRestoreState, startupAllReady, location.pathname);
  const shouldPollStartup = startupRestoreState === null || showStartupCard;
  const showsEmptyContentSurface = location.pathname === "/";
  const webItemMap = useMemo(() => {
    return new Map<WebEntryKey, WebNavigationEntry>(webItems.map((item) => {
      if (item.kind === "webapp") {
        const runtime = webappRuntimeById[item.id];
        return [item.entryKey, {
          ...item,
          url: runtime?.webUrl ?? "",
          chrome: "app",
          runtimeStatus: runtime?.status ?? "idle",
          runtimeMessage: runtime?.message ?? ""
        }] as const;
      }
      return [item.entryKey, item] as const;
    }));
  }, [webItems, webappRuntimeById]);
  const currentCopilotPreference = resolveDesktopCopilotPreference(assistantSettings?.desktopCopilotPages, location.pathname);
  const activeWebEntry = activeWebEntryKey ? webItemMap.get(activeWebEntryKey) ?? null : null;
  const webOpenEntryKeys = useMemo(() => {
    const openKeys = new Set<WebEntryKey>(mountedWebEntryKeys);
    if (activeWebEntryKey) {
      openKeys.add(activeWebEntryKey);
    }
    for (const item of webItems) {
      if (item.kind !== "webapp") {
        continue;
      }
      const runtime = webappRuntimeById[item.id];
      if (
        runtime?.status === "starting" ||
        runtime?.status === "running" ||
        runtime?.status === "error"
      ) {
        openKeys.add(item.entryKey);
      }
    }
    return [...openKeys];
  }, [activeWebEntryKey, mountedWebEntryKeys, webItems, webappRuntimeById]);
  const webRunningEntryKeys = useMemo(
    () =>
      webItems
        .filter(
          (item) =>
            item.kind === "webapp" &&
            webappRuntimeById[item.id]?.status === "running",
        )
        .map((item) => item.entryKey),
    [webItems, webappRuntimeById],
  );
  const usesBrowserChromeSurface = usesBuiltinBrowserSurface || activeWebEntry?.kind === "website";
  const resolvedCopilotAgentKey = activeWebEntry
    ? activeWebEntry.copilotAgentKey || assistantSettings?.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY
    : currentCopilotPreference?.agentKey || assistantSettings?.desktopHelperAgentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const assistantLauncherVisible = currentCopilotPreference?.enabled !== false;
  const isAgentWebclientMainRoute =
    location.pathname === ASSISTANT_TARGET_PATH ||
    isSingleAgentWebclientRoute(location.pathname) ||
    isCopilotAgentWebclientRoute(location.pathname);
  const currentCopilotContextKey = activeWebEntryKey || (
    location.pathname === BUILTIN_BROWSER_ROUTE
      ? BUILTIN_BROWSER_SURFACE_ID
      : `desktop-route:${location.pathname}`
  );
  const currentCopilotParentSurfaceId = activeWebEntry && activeWebEntryKey
    ? createWebEntrySurfaceIdentity(activeWebEntry.kind, activeWebEntryKey).surfaceId
    : location.pathname === BUILTIN_BROWSER_ROUTE
      ? BUILTIN_BROWSER_SURFACE_ID
      : activeServiceId
        ? activeServiceId === AGENT_WEBCLIENT_SERVICE_ID && activeEmbeddedAgentWebclientRoute?.kind === "chat"
          ? createSurfaceIdentity("main-chat").surfaceId
          : activeServiceId === AGENT_WEBCLIENT_SERVICE_ID && activeEmbeddedAgentWebclientRoute?.kind === "copilot"
            ? createSurfaceIdentity("copilot-chat").surfaceId
            : createServiceSurfaceIdentity(activeServiceId).surfaceId
        : undefined;
  const currentCopilotSession = assistantDockSessions[currentCopilotContextKey] ?? null;
  const assistantDockOpen = Boolean(currentCopilotSession);
  const assistantCopilotOpen = assistantDockOpen && assistantLauncherVisible && !isAgentWebclientMainRoute;
  const currentAssistantDockOpenRequest =
    pendingAssistantDockOpenRequestRef.current?.contextKey === currentCopilotContextKey
      ? assistantDockOpenRequest
      : null;
  const sidebarCollapsed = sidebarState.mode === "collapsed";
  const renderedSidebarWidth = resolveRenderedSidebarWidth(sidebarState);
  const effectiveSidebarCollapsed = sidebarCollapsed && !isSecondarySidebarMode;
  const effectiveSidebarWidth = isSecondarySidebarMode
    ? SETTINGS_SIDEBAR_WIDTH
    : renderedSidebarWidth;
  const copilotDockAvailableWidth = Math.max(0, appShellWidth - effectiveSidebarWidth);
  const copilotDockOverlayMode = shouldOverlayCopilotDock(copilotDockAvailableWidth);
  const copilotDockMaxWidth = resolveCopilotDockMaxWidth(copilotDockAvailableWidth);
  const renderedCopilotDockWidth = resolveRenderedCopilotDockWidth(
    preferredCopilotDockWidth,
    copilotDockAvailableWidth,
  );
  const copilotDockNativeDialogVisible =
    nativeDialogVisible || Boolean(desktopActionConfirmation) || Boolean(chatHistoryDialog);
  const availableSidebarNavOrderItems = useMemo<SidebarNavOrderItem[]>(() => {
    return createDefaultSidebarNavOrderItems({
      kanbanEnabled,
      serviceItems: [],
      experimentalItems: [],
      webItems: []
    }).map((item) => {
      if (item.key === "kanban") return { ...item, label: t("nav.kanban") };
      if (item.key === "schedules") return { ...item, label: t("nav.schedules") };
      if (item.key === "group:assistants") return { ...item, label: t("nav.assistants") };
      if (item.key === "group:webs") return { ...item, label: t("nav.websites") };
      return item;
    });
  }, [kanbanEnabled, t]);
  const normalizedSidebarNavOrder = useMemo(
    () => normalizeSidebarNavOrder(sidebarNavOrder, availableSidebarNavOrderItems),
    [availableSidebarNavOrderItems, sidebarNavOrder]
  );
  const normalizedWebGroupOrder = useMemo(
    () => normalizeWebGroupOrder(webGroupOrder, webItems),
    [webGroupOrder, webItems]
  );
  async function refreshWebItems() {
    const result = await window.electronAPI.webs.list();
    if (result.ok) {
      updateWebItems(result.items);
      await refreshWebappRuntimeStates(result.items);
    }
    return result;
  }

  async function refreshWebappRuntimeStates(items: WebEntry[]) {
    const webapps = items.filter((item) => item.kind === "webapp");
    if (webapps.length === 0) {
      return;
    }

    const statuses = await Promise.all(webapps.map(async (item) => ({
      id: item.id,
      result: await window.electronAPI.webs.webapps.getStatus(item.id)
    })));

    setWebappRuntimeById((current) => {
      let changed = false;
      const next = { ...current };
      for (const { id, result } of statuses) {
        if (!result.ok || !result.state) {
          continue;
        }
        const status = result.state.status === "stopped" ? "idle" : result.state.status;
        const previous = current[id];
        if (
          previous?.status === status &&
          previous.webUrl === result.state.webUrl &&
          previous.message === result.message &&
          previous.state?.updatedAt === result.state.updatedAt
        ) {
          continue;
        }
        changed = true;
        next[id] = {
          status,
          webUrl: result.state.webUrl,
          message: result.message || result.state.message,
          state: result.state
        };
      }
      return changed ? next : current;
    });
  }

  async function createWebsiteItem(input: WebsiteInput): Promise<WebsiteResult> {
    const result = await window.electronAPI.webs.websites.add(input);
    await refreshWebItems().catch(() => undefined);
    return result;
  }

  async function importWebappItem(): Promise<WebappImportResult> {
    const result = await window.electronAPI.webs.webapps.import();
    if (result.ok) {
      updateWebItems(result.items);
    } else {
      await refreshWebItems().catch(() => undefined);
    }
    return result;
  }

  async function exportWebappItem(item: WebEntry): Promise<WebappExportResult> {
    if (item.kind !== "webapp") {
      return {
        ok: false,
        item: null,
        path: "",
        message: t("webapp.notFound")
      };
    }
    return window.electronAPI.webs.webapps.export(item.id);
  }

  async function removeWebappItem(item: WebEntry): Promise<WebappDeleteResult> {
    if (item.kind !== "webapp") {
      return {
        ok: false,
        item: null,
        items: [],
        message: t("webapp.notFound")
      };
    }

    const wasActive = activeWebEntryKey === item.entryKey;
    if (wasActive) {
      requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
    }
    setMountedWebEntryKeys((current) =>
      current.filter((entryKey) => entryKey !== item.entryKey)
    );

    const result = await window.electronAPI.webs.webapps.uninstall(item.id);
    if (result.ok) {
      setWebappRuntimeById((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } else {
      setMountedWebEntryKeys((current) =>
        current.includes(item.entryKey) ? current : [...current, item.entryKey]
      );
      if (wasActive) {
        requestSidebarNavigation(`/webs/${item.entryKey}`);
      }
    }
    await refreshWebItems().catch(() => undefined);
    return result;
  }

  function updateWebItems(items: WebEntry[]) {
    webItemsRef.current = items;
    setWebItems(items);
    setWebItemsLoaded(true);
    setWebGroupOrder((currentOrder) => normalizeWebGroupOrder(currentOrder, items));
    setFaviconCache((prev) => {
      const websiteUrls = new Map<string, string>(
        items
          .filter((item): item is WebsiteEntry => item.kind === "website")
          .map((item) => [item.entryKey, item.url]),
      );
      let changed = false;
      const next: Record<string, WebsiteFaviconCache[string]> = {};
      for (const [entryKey, cacheEntry] of Object.entries(prev)) {
        if (websiteUrls.get(entryKey) === cacheEntry.websiteUrl) {
          next[entryKey] = cacheEntry;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  async function handleCloseWebEntry(item: WebEntry) {
    if (activeWebEntryKey === item.entryKey) {
      requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
    }
    if (item.kind === "webapp") {
      webappStopInFlightRef.current.add(item.id);
      try {
        const result = await window.electronAPI.webs.webapps.stop(item.id);
        setWebappRuntimeById((current) => ({
          ...current,
          [item.id]: {
            status: result.ok ? "idle" : "error",
            webUrl: result.state?.webUrl ?? "",
            message: result.message,
            state: result.state
          }
        }));
        if (!result.ok) {
          throw new Error(result.message);
        }
      } finally {
        webappStopInFlightRef.current.delete(item.id);
      }
    }

    setMountedWebEntryKeys((current) =>
      current.filter((entryKey) => entryKey !== item.entryKey)
    );
  }

  async function handleOpenWebappWindow(item: WebappEntry) {
    if (webappStartInFlightRef.current.has(item.id)) {
      return;
    }

    webappStartInFlightRef.current.add(item.id);
    try {
      if (item.openMode !== "dialog") {
        const preferenceResult = await window.electronAPI.webs.webapps.update(
          item.id,
          { openMode: "dialog" }
        );
        if (!preferenceResult.ok) {
          throw new Error(preferenceResult.message);
        }
        updateWebItems(preferenceResult.items);
      }

      setMountedWebEntryKeys((current) =>
        current.filter((entryKey) => entryKey !== item.entryKey)
      );
      if (activeWebEntryKey === item.entryKey) {
        requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
      }
      setWebappRuntimeById((current) => ({
        ...current,
        [item.id]: {
          status: "starting",
          webUrl: current[item.id]?.webUrl ?? "",
          message: t("webapp.starting"),
          state: current[item.id]?.state ?? null
        }
      }));

      const result = await window.electronAPI.webs.webapps.openWindow(item.id);
      setWebappRuntimeById((current) => ({
        ...current,
        [item.id]: {
          status: result.ok && result.state?.webUrl ? "running" : "error",
          webUrl: result.state?.webUrl ?? "",
          message: result.message,
          state: result.state
        }
      }));
    } catch (error) {
      setWebappRuntimeById((current) => ({
        ...current,
        [item.id]: {
          status: "error",
          webUrl: "",
          message: error instanceof Error ? error.message : String(error),
          state: null
        }
      }));
    } finally {
      webappStartInFlightRef.current.delete(item.id);
    }
  }

  async function handleOpenWebappWorkspace(item: WebappEntry) {
    if (webappStartInFlightRef.current.has(item.id)) {
      return;
    }

    webappStartInFlightRef.current.add(item.id);
    try {
      if (item.openMode !== "workspace") {
        const preferenceResult = await window.electronAPI.webs.webapps.update(
          item.id,
          { openMode: "workspace" }
        );
        if (!preferenceResult.ok) {
          throw new Error(preferenceResult.message);
        }
        updateWebItems(preferenceResult.items);
      }

      setMountedWebEntryKeys((current) =>
        current.includes(item.entryKey)
          ? current
          : [...current, item.entryKey]
      );
      requestSidebarNavigation(`/webs/${item.entryKey}`);
    } catch (error) {
      setWebappRuntimeById((current) => {
        const existing = current[item.id];
        return {
          ...current,
          [item.id]: {
            status: existing?.status ?? "error",
            webUrl: existing?.webUrl ?? "",
            message: error instanceof Error ? error.message : String(error),
            state: existing?.state ?? null
          }
        };
      });
    } finally {
      webappStartInFlightRef.current.delete(item.id);
    }
  }

  const handleWebsiteFaviconDiscovered = useCallback(
    (entryKey: string, websiteUrl: string, faviconUrl: string) => {
      const website = webItemsRef.current.find(
        (item): item is WebsiteEntry =>
          item.kind === "website" &&
          item.entryKey === entryKey &&
          item.url === websiteUrl,
      );
      if (!website) {
        return;
      }

      void window.electronAPI.webs.websites.cacheFavicon({
        id: website.id,
        websiteUrl,
        faviconUrl,
      }).then((result) => {
        if (!result.ok || !result.faviconUrl) {
          return;
        }
        setFaviconCache((prev) => {
          const currentWebsite = webItemsRef.current.find(
            (item): item is WebsiteEntry =>
              item.kind === "website" &&
              item.entryKey === entryKey &&
              item.url === websiteUrl,
          );
          if (!currentWebsite) {
            return prev;
          }
          const current = prev[entryKey];
          if (
            current?.websiteUrl === websiteUrl &&
            current.faviconUrl === result.faviconUrl
          ) {
            return prev;
          }
          return {
            ...prev,
            [entryKey]: { websiteUrl, faviconUrl: result.faviconUrl },
          };
        });
      }).catch(() => {
        // A failed favicon cache should leave the site's monogram untouched.
      });
    },
    [],
  );

  function handleCopilotSelectedAgentKeyChange(agentKey: string) {
    const normalizedAgentKey = agentKey.trim();
    if (!normalizedAgentKey || activeWebEntry?.kind !== "website") {
      return;
    }
    if (normalizedAgentKey === resolvedCopilotAgentKey) {
      return;
    }
    if (!copilotAgentOptions.some((agent) => agent.agentKey.trim() === normalizedAgentKey)) {
      return;
    }

    const requestKey = `${activeWebEntry.id}:${normalizedAgentKey}`;
    if (websiteAgentSyncRequestRef.current === requestKey) {
      return;
    }

    const websiteId = activeWebEntry.id;
    websiteAgentSyncRequestRef.current = requestKey;
    void window.electronAPI.webs.websites
      .update(websiteId, { copilotAgentKey: normalizedAgentKey })
      .then((result) => {
        if (!result.ok) {
          console.warn("[webs] failed to save website copilot agent", result.message);
          return;
        }
        updateWebItems(mergeWebsiteItems(webItems, result.items));
      })
      .catch((reason) => {
        console.warn(
          "[webs] failed to save website copilot agent",
          reason instanceof Error ? reason.message : String(reason)
        );
      })
      .finally(() => {
        if (websiteAgentSyncRequestRef.current === requestKey) {
          websiteAgentSyncRequestRef.current = "";
        }
      });
  }

  function handleSettingsWebappRuntimeStateChange(id: string, state: WebappRuntimeState | null, message = "") {
    const webappId = id.trim();
    if (!webappId) {
      return;
    }
    setWebappRuntimeById((current) => {
      if (!state) {
        const next = { ...current };
        delete next[webappId];
        return next;
      }
      return {
        ...current,
        [webappId]: {
          status: state.status === "stopped" ? "idle" : state.status,
          webUrl: state.webUrl,
          message: message || state.message,
          state
        }
      };
    });
  }

  async function refreshAssistantNavAgents(options?: AssistantNavigationListOptions) {
    const refreshId = assistantNavAgentsRefreshIdRef.current + 1;
    assistantNavAgentsRefreshIdRef.current = refreshId;
    try {
      const result = await window.electronAPI.assistant.listNavigationAgents(options);
      if (assistantNavAgentsRefreshIdRef.current === refreshId) {
        if (!result.ok) {
          return;
        }
        const nextResult = normalizeAssistantNavAgentItemsResult(result);
        const navigationItems = normalizeAssistantNavAgents(nextResult.items);
        const nextItems = normalizeAssistantNavAgents(resolveAssistantNavDisplayItems(nextResult));
        setAssistantNavAgentsLoaded(true);
        setChatNavAgentOptions(getChatNavigationAgentOptions(navigationItems));
        setAssistantNavAgents(nextItems);
        setAssistantNavChatItems(nextResult.chatItems);
        setAssistantNavChatItemsHasMore(nextResult.chatItemsHasMore);
      }
    } catch {
      // Keep the current live list while agent-platform is still warming up.
    }
  }

  async function refreshCopilotAgentOptions() {
    try {
      const result = await window.electronAPI.assistant.listCopilotAgents();
      if (!result.ok) {
        return;
      }
      setCopilotAgentOptions(normalizeAssistantNavAgents(result.items));
    } catch {
      // Keep the current picker list while agent-platform is still warming up.
    }
  }

  function refreshAssistantNavAgentsAfterStartupReady(nextState: StartupRestoreState) {
    if (nextState.phase === "succeeded") {
      void refreshAssistantNavAgents();
      void refreshCopilotAgentOptions();
    }
  }

  useEffect(() => {
    let cancelled = false;
    void refreshAssistantNavAgents();
    void refreshCopilotAgentOptions();
    const unsubscribe = window.electronAPI.assistant.onNavigationAgentsChanged((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      assistantNavAgentsRefreshIdRef.current += 1;
      const nextResult = normalizeAssistantNavAgentItemsResult(result);
      setAssistantNavAgentsLoaded(true);
      setChatNavAgentOptions(getChatNavigationAgentOptions(nextResult.items));
      setAssistantNavAgents(normalizeAssistantNavAgents(resolveAssistantNavDisplayItems(nextResult)));
      setAssistantNavChatItems(nextResult.chatItems);
      setAssistantNavChatItemsHasMore(nextResult.chatItemsHasMore);
    });

    return () => {
      cancelled = true;
      assistantNavAgentsRefreshIdRef.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!assistantSettings) {
      return;
    }
    const bootstrapAgentKey = assistantSettings.bootstrapAgentKey.trim();
    if (bootstrapAgentKey) {
      chatDefaultAgentMigrationRef.current = "";
      return;
    }
    const fallbackAgentKey = chatNavAgentOptions[0]?.agentKey.trim() ?? "";
    const currentAgentKey = assistantSettings?.chatDefaultAgentKey.trim() ?? "";
    if (
      !fallbackAgentKey ||
      chatNavAgentOptions.some((agent) => agent.agentKey === currentAgentKey)
    ) {
      return;
    }

    const migrationKey = `${currentAgentKey}:${fallbackAgentKey}`;
    if (chatDefaultAgentMigrationRef.current === migrationKey) {
      return;
    }
    chatDefaultAgentMigrationRef.current = migrationKey;
    void window.electronAPI.assistant
      .saveSettings({ chatDefaultAgentKey: fallbackAgentKey })
      .then((nextSettings) => {
        setAssistantSettings(nextSettings);
      })
      .catch(() => {
        if (chatDefaultAgentMigrationRef.current === migrationKey) {
          chatDefaultAgentMigrationRef.current = "";
        }
      });
  }, [assistantSettings?.bootstrapAgentKey, assistantSettings?.chatDefaultAgentKey, chatNavAgentOptions]);

  useEffect(() => {
    if (
      bootstrapInitialNavigationDoneRef.current ||
      !assistantNavAgentsLoaded ||
      !assistantSettings ||
      firstInstallBootstrapNavigationRequested !== true
    ) {
      return;
    }

    const target = resolveFirstInstallBootstrapNavigationTarget(
      chatNavAgentOptions,
      assistantNavChatItems,
      {
        defaultChatAgentKey: assistantSettings.chatDefaultAgentKey,
        bootstrapAgentKey: assistantSettings.bootstrapAgentKey,
        bootstrapChatId: assistantSettings.bootstrapChatId,
      },
    );
    if (!target) {
      return;
    }
    const targetRoute = target.chatId
      ? createAgentChatRoute(target.agentKey, target.chatId)
      : createAgentNewChatRoute(target.agentKey);
    const currentRoute = `${location.pathname}${location.search}`;

    bootstrapInitialNavigationDoneRef.current = true;
    if (currentRoute !== targetRoute) {
      navigate(targetRoute, { replace: true });
    }
  }, [
    assistantNavAgentsLoaded,
    assistantNavChatItems,
    assistantSettings,
    chatRuntimeAgent,
    chatNavAgentOptions,
    firstInstallBootstrapNavigationRequested,
    location.pathname,
    location.search,
    navigate,
  ]);

  useEffect(() => {
    if (
      bootstrapInitialNavigationDoneRef.current ||
      firstInstallBootstrapNavigationRequested !== false ||
      location.pathname !== "/" ||
      !assistantNavAgentsLoaded ||
      !assistantSettings ||
      !chatRuntimeAgent.agent
    ) {
      return;
    }
    navigate(createAgentNewChatRoute(chatRuntimeAgent.agent.agentKey), { replace: true });
  }, [
    assistantNavAgentsLoaded,
    assistantSettings,
    chatRuntimeAgent.agent,
    firstInstallBootstrapNavigationRequested,
    location.pathname,
    navigate,
  ]);

  useEffect(() => {
    if (!isSingleAgentWebclientRoute(location.pathname)) {
      return;
    }
    let routeChatId = "";
    try {
      routeChatId = new URLSearchParams(location.search).get("chatId")?.trim() ?? "";
    } catch {
      routeChatId = "";
    }
    if (!routeChatId) {
      return;
    }
    void refreshAssistantNavAgents();
  }, [currentRoute]);

  useEffect(() => {
    if (agentPlatformRunning) {
      void refreshAssistantNavAgents();
      void refreshCopilotAgentOptions();
    }
  }, [agentPlatformRunning]);

  async function refreshStartupRestoreState() {
    const nextState = await window.electronAPI.services.getStartupRestoreState();
    setStartupRestoreState(nextState);
    return nextState;
  }

  async function refreshAssistantSettingsFromCanonical() {
    try {
      const settings = await window.electronAPI.assistant.getSettings();
      setAssistantSettings(settings);
    } catch {
      // Keep the last usable settings if the bridge is not ready yet.
    }
  }

  async function saveChatsDefaultAgent(agentKey: string) {
    const normalizedAgentKey = agentKey.trim();
    if (!chatNavAgentOptions.some((agent) => agent.agentKey === normalizedAgentKey)) {
      throw new Error(t("sidebar.chats.defaultAgentUnavailable"));
    }
    const settings = await window.electronAPI.assistant.saveSettings({
      chatDefaultAgentKey: normalizedAgentKey,
    });
    setAssistantSettings(settings);
  }

  async function refreshThemePreferenceFromCanonical() {
    try {
      const profileTheme = await window.electronAPI.settings.getThemePreference();
      if (isThemePreference(profileTheme)) {
        setThemeMode(profileTheme);
      }
    } catch {
      // Keep the current theme if settings are temporarily unavailable.
    } finally {
      setThemePreferenceLoaded(true);
    }
  }

  async function refreshNavigationPreferencesFromCanonical() {
    try {
      const preferences = await window.electronAPI.settings.getNavigationPreferences();
      if (Array.isArray(preferences?.mainOrder)) {
        setSidebarNavOrder(preferences.mainOrder as SidebarNavOrderItemKey[]);
      }
      if (Array.isArray(preferences?.webOrder)) {
        setWebGroupOrder(preferences.webOrder as SidebarNavOrderItemKey[]);
      }
    } catch {
      // Keep the current navigation order if settings are temporarily unavailable.
    } finally {
      setNavigationPreferencesLoaded(true);
    }
  }

  async function refreshKanbanSettingsFromCanonical() {
    try {
      const result = await window.electronAPI.kanban.getSettings();
      setKanbanEnabled(result.settings.enabled);
    } catch {
      // Keep the current Kanban visibility if settings are temporarily unavailable.
    } finally {
      setKanbanSettingsLoaded(true);
    }
  }

  function refreshDesktopShellConfigFromCanonical() {
    void refreshThemePreferenceFromCanonical();
    void refreshNavigationPreferencesFromCanonical();
    void refreshKanbanSettingsFromCanonical();
    void refreshMarketSettingsVisibility();
    void refreshAssistantSettingsFromCanonical();
    void refreshDesktopSsoStatus();
    void refreshServicesRef.current();
    refreshWebItems().catch(() => undefined);
    void refreshAssistantNavAgents();
    void refreshCopilotAgentOptions();
  }

  function openAssistantDock(request?: AssistantWorkerOpenRequest) {
    if (isAgentWebclientMainRoute) {
      return;
    }
    if (request) {
      setAssistantDockOpenRequest(request);
    } else {
      setAssistantDockOpenRequest(null);
    }
    const requestedAgentKey = (request?.agentKey ?? request?.workerKey ?? resolvedCopilotAgentKey)
      .trim()
      .replace(/^agent:/u, "");
    const requestedChatId = request?.chatId?.trim() ?? "";
    const params = new URLSearchParams();
    if (requestedChatId) {
      params.set("chatId", requestedChatId);
    }
    const embedPath = createAgentWebclientCopilotPath(requestedAgentKey, params);
    pendingAssistantDockOpenRequestRef.current = request
      ? { contextKey: currentCopilotContextKey, embedPath }
      : null;
    updateCopilotDockContextSession(currentCopilotContextKey, {
      embedPath,
      agentKey: requestedAgentKey,
      ...(requestedChatId ? { chatId: requestedChatId } : {})
    });
  }

  function closeAssistantDock() {
    setAssistantDockOpenRequest(null);
    pendingAssistantDockOpenRequestRef.current = null;
    updateCopilotDockContextSession(currentCopilotContextKey, null);
  }

  function handleCopilotCurrentEmbedPathChange(embedPath: string, agentKey: string, chatId?: string) {
    if (!assistantDockOpen) {
      return;
    }
    updateCopilotDockContextSession(currentCopilotContextKey, {
      embedPath,
      agentKey,
      ...(chatId ? { chatId } : {})
    });
    const pendingRequest = pendingAssistantDockOpenRequestRef.current;
    if (
      pendingRequest?.contextKey === currentCopilotContextKey &&
      pendingRequest.embedPath === embedPath
    ) {
      pendingAssistantDockOpenRequestRef.current = null;
      setAssistantDockOpenRequest(null);
    }
  }

  function updateCopilotDockContextSession(
    contextKey: string,
    session: CopilotDockContextSession | null
  ) {
    const nextSessions = { ...assistantDockSessionsRef.current };
    if (session) {
      nextSessions[contextKey] = session;
    } else {
      delete nextSessions[contextKey];
    }
    assistantDockSessionsRef.current = nextSessions;
    setAssistantDockSessions(nextSessions);
    if (Object.keys(nextSessions).length === 0) {
      clearCopilotDockSessionSnapshot();
      return;
    }
    writeCopilotDockSessionSnapshot({ contexts: nextSessions });
  }

  async function handleEnvImport() {
    setEnvImportBusy(true);
    setEnvImportError("");
    try {
      const result = await window.electronAPI.services.importEnvZip();
      if (!result.ok) {
        setEnvImportError(result.message);
      }
    } catch (err) {
      setEnvImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnvImportBusy(false);
    }
  }

  async function handleDesktopSsoLogin() {
    const ssoApi = getDesktopSsoApi();
    if (!ssoApi) {
      setDesktopSsoStatus(createUnavailableDesktopSsoStatus(t("startup.ssoUnavailable")));
      return;
    }
    setDesktopSsoLoginSettled(false);
    setDesktopSsoBusy(true);
    try {
      const result = await ssoApi.startLogin();
      setDesktopSsoStatus(result.status);
      if (!result.status.pending && !isCompleteDesktopSsoLogin(result.status)) {
        setDesktopSsoLoginSettled(true);
      }
    } finally {
      setDesktopSsoBusy(false);
    }
  }

  async function handleDesktopSsoLogout() {
    const ssoApi = getDesktopSsoApi();
    if (!ssoApi) {
      setDesktopSsoStatus(createUnavailableDesktopSsoStatus(t("startup.ssoUnavailable")));
      return;
    }
    setDesktopSsoBusy(true);
    try {
      const result = await ssoApi.logout();
      setDesktopSsoStatus(result.status);
    } finally {
      setDesktopSsoBusy(false);
    }
  }

  async function handleDesktopSsoLoginDialogClose() {
    setDesktopSsoLoginDialog(null);
    setDesktopSsoLoginSettled(false);
    if (!desktopSsoStatus?.pending) {
      return;
    }
    const ssoApi = getDesktopSsoApi();
    if (!ssoApi) {
      setDesktopSsoStatus(createUnavailableDesktopSsoStatus(t("startup.ssoUnavailable")));
      return;
    }
    try {
      const result = await ssoApi.cancelLogin();
      setDesktopSsoStatus(result.status);
    } catch {
      await refreshDesktopSsoStatus().catch(() => undefined);
    }
  }

  async function refreshDesktopSsoStatus() {
    const ssoApi = getDesktopSsoApi();
    if (!ssoApi) {
      setDesktopSsoStatus(createUnavailableDesktopSsoStatus(t("startup.ssoUnavailable")));
      return;
    }
    const status = await ssoApi.getStatus();
    setDesktopSsoStatus(status);
  }

  useEffect(() => {
    startDesktopActionRendererBridge();
  }, []);

  useEffect(() => {
    let active = true;
    void window.electronAPI.settings.getAppInfo().then((appInfo) => {
      if (active) {
        setDesktopAppVersion(normalizeDesktopAppVersion(appInfo.version));
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => window.electronAPI.desktopShell.onShutdownProgress((progress) => {
    if (progress.phase === "preparing") {
      workPanelStateRef.current = EMPTY_WORK_PANEL_STATE;
      setWorkPanelState(EMPTY_WORK_PANEL_STATE);
      if (activeWebEntryKeyRef.current?.startsWith("webapp:")) {
        requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
      }
      setMountedWebEntryKeys((current) =>
        current.filter((entryKey) => !entryKey.startsWith("webapp:"))
      );
    }
    setShutdownProgress(progress);
  }), []);

  useEffect(() => {
    setDesktopActionTranslator(t);
  }, [t]);

  useEffect(() => {
    desktopActionConfirmationRef.current = desktopActionConfirmation;
  }, [desktopActionConfirmation]);

  useEffect(() => window.electronAPI.desktopActions.onConfirm((request) => {
    const previousRequest = desktopActionConfirmationRef.current;
    if (previousRequest && previousRequest.requestId !== request.requestId) {
      void window.electronAPI.desktopActions.respondConfirmation({
        requestId: previousRequest.requestId,
        decision: previousRequest.cancelDecision
      }).catch(() => undefined);
    }
    desktopActionConfirmationRef.current = request;
    setDesktopActionConfirmation(request);
  }), []);

  const handleDesktopActionConfirmationDecision = useCallback((decision: DesktopActionConfirmationDecision) => {
    const request = desktopActionConfirmationRef.current;
    if (!request) {
      return;
    }
    desktopActionConfirmationRef.current = null;
    setDesktopActionConfirmation(null);
    void window.electronAPI.desktopActions.respondConfirmation({
      requestId: request.requestId,
      decision
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    firstInstallBootstrapNavigationRequestRef.current ??=
      window.electronAPI.assistant.consumeFirstInstallBootstrapNavigation();
    Promise.all([
      window.electronAPI.assistant.getSettings(),
      firstInstallBootstrapNavigationRequestRef.current,
    ])
      .then(([settings, bootstrapNavigation]) => {
        if (!cancelled) {
          setAssistantSettings(settings);
          setFirstInstallBootstrapNavigationRequested(bootstrapNavigation.shouldOpen === true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (copilotRestoreAttemptedRef.current || !assistantSettings) {
      return;
    }
    copilotRestoreAttemptedRef.current = true;
    const snapshot = pendingCopilotRestoreRef.current;
    pendingCopilotRestoreRef.current = null;
    if (!snapshot) {
      return;
    }
    pendingAssistantDockOpenRequestRef.current = null;
    setAssistantDockOpenRequest(null);
    assistantDockSessionsRef.current = snapshot.contexts;
    setAssistantDockSessions(snapshot.contexts);
  }, [assistantSettings]);

  useEffect(() => {
    if (
      pendingAssistantDockOpenRequestRef.current &&
      pendingAssistantDockOpenRequestRef.current.contextKey !== currentCopilotContextKey
    ) {
      pendingAssistantDockOpenRequestRef.current = null;
      setAssistantDockOpenRequest(null);
    }
  }, [currentCopilotContextKey]);

  useEffect(() => {
    return window.electronAPI.onNavigate((targetPath) => {
      navigate(targetPath);
    });
  }, [navigate]);

  useEffect(() => {
    return window.electronAPI.onOpenGlobalSearch(() => {
      setGlobalSearchOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!pendingAgentChatFocusRequest || globalSearchOpen) {
      return;
    }
    if (
      currentRoute === pendingAgentChatFocusRequest.sourceRoute ||
      currentRoute === pendingAgentChatFocusRequest.targetRoute
    ) {
      return;
    }
    setPendingAgentChatFocusRequest((current) =>
      current?.id === pendingAgentChatFocusRequest.id ? null : current
    );
  }, [currentRoute, globalSearchOpen, pendingAgentChatFocusRequest]);

  useEffect(() => {
    return window.electronAPI.onOpenAssistantWorker((request) => {
      openAssistantDock(request);
    });
  }, [location.pathname]);

  useEffect(() => {
    return window.electronAPI.onNativeDialogVisibility((state) => {
      setNativeDialogVisible(state.platform === "darwin" && state.open);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ssoApi = getDesktopSsoApi();
    if (!ssoApi) {
      setDesktopSsoStatus(createUnavailableDesktopSsoStatus(t("startup.ssoUnavailable")));
      return () => {
        cancelled = true;
      };
    }
    ssoApi
      .getStatus()
      .then((status) => {
        if (!cancelled) {
          setDesktopSsoStatus(status);
        }
      })
      .catch(() => undefined);
    const dispose = ssoApi.onStatusChanged((status) => {
      setDesktopSsoStatus(status);
      if (status.pending) {
        setDesktopSsoLoginSettled(false);
      } else if (isCompleteDesktopSsoLogin(status)) {
        setDesktopSsoLoginDialog(null);
        setDesktopSsoLoginSettled(false);
      } else {
        setDesktopSsoLoginSettled(true);
      }
    });
    const disposeEmbeddedLoginOpen = ssoApi.onEmbeddedLoginOpen((request) => {
      setDesktopSsoLoginSettled(false);
      setDesktopSsoLoginDialog(request);
    });

    return () => {
      cancelled = true;
      dispose();
      disposeEmbeddedLoginOpen();
    };
  }, []);

  useEffect(() => {
    refreshWebItems().catch(() => undefined);
  }, []);

  async function refreshMarketSettingsVisibility() {
    const requestId = marketSettingsRefreshIdRef.current + 1;
    marketSettingsRefreshIdRef.current = requestId;
    try {
      const settings = await window.electronAPI.market.getSettings();
      if (marketSettingsRefreshIdRef.current !== requestId) {
        return;
      }
      setMarketEnabled(isMarketSettingsVisible(settings));
    } catch {
      if (marketSettingsRefreshIdRef.current !== requestId) {
        return;
      }
      setMarketEnabled(false);
    } finally {
      if (marketSettingsRefreshIdRef.current === requestId) {
        setMarketSettingsLoaded(true);
      }
    }
  }

  useEffect(() => {
    return window.electronAPI.onServicesChanged(() => {
      void refreshMarketSettingsVisibility();
      refreshWebItems().catch(() => undefined);
      void refreshAssistantNavAgents();
      void refreshCopilotAgentOptions();
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.webs.onChanged((event) => {
      if (event.phase === "disposing" && event.webappId) {
        const entryKey: WebEntryKey = `webapp:${event.webappId}`;
        if (activeWebEntryKeyRef.current === entryKey) {
          requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
        }
        setMountedWebEntryKeys((current) =>
          current.filter((currentEntryKey) => currentEntryKey !== entryKey)
        );
        return;
      }
      refreshWebItems().catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.settings.onDesktopConfigChanged(() => {
      refreshDesktopShellConfigFromCanonical();
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.settings
      .getPlatform()
      .then((platform) => {
        if (!cancelled) {
          setDesktopPlatform(platform);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (startupRestoreState?.mode !== "bootstrap") {
      setStartupCardDismissed(false);
      return;
    }

    if (
      startupRestoreState.phase === "idle" ||
      startupRestoreState.phase === "running"
    ) {
      setStartupCardDismissed(false);
    }
  }, [startupRestoreState]);

  useEffect(() => {
    refreshServicesRef.current = refreshServices;
  }, [refreshServices]);

  useEffect(() => {
    let cancelled = false;

    refreshStartupRestoreState()
      .then((nextState) => {
        if (cancelled) {
          return;
        }
        setStartupRestoreState(nextState);
        refreshAssistantNavAgentsAfterStartupReady(nextState);
      })
      .catch(() => undefined);

    const removeListener = window.electronAPI.onStartupRestoreState((nextState) => {
      if (cancelled) {
        return;
      }
      setStartupRestoreState(nextState);
      refreshAssistantNavAgentsAfterStartupReady(nextState);
    });

    return () => {
      cancelled = true;
      removeListener();
    };
  }, []);

  useEffect(() => {
    if (!shouldPollStartup) {
      setStartupTimedOut(false);
      return;
    }
    void refreshServicesRef.current();
    const refreshInterval = window.setInterval(() => {
      void refreshServicesRef.current();
    }, STARTUP_STATUS_REFRESH_MS);
    const startupStateInterval = window.setInterval(() => {
      void refreshStartupRestoreState().catch(() => undefined);
    }, STARTUP_STATUS_REFRESH_MS);
    const timer = window.setTimeout(() => {
      setStartupTimedOut(true);
    }, STARTUP_LOADING_TIMEOUT_MS);
    return () => {
      window.clearInterval(refreshInterval);
      window.clearInterval(startupStateInterval);
      window.clearTimeout(timer);
    };
  }, [shouldPollStartup]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.settings.getThemePreference()
      .then((profileTheme) => {
        if (!cancelled && isThemePreference(profileTheme)) {
          setThemeMode(profileTheme);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setThemePreferenceLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const resolved = resolveThemePreference(themeMode);
    setResolvedTheme(resolved);
    document.documentElement.dataset.theme = resolved;
    if (themePreferenceLoaded) {
      window.electronAPI.settings.setNativeThemeSource(themeMode).catch(() => undefined);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore persistence failures and keep the in-memory theme switch usable.
    }

    if (themeMode !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      const nextResolved = media.matches ? "dark" : "light";
      setResolvedTheme(nextResolved);
      document.documentElement.dataset.theme = nextResolved;
    };
    media.addEventListener("change", handleSystemThemeChange);
    return () => {
      media.removeEventListener("change", handleSystemThemeChange);
    };
  }, [themeMode, themePreferenceLoaded]);

  useEffect(() => {
    const shouldApply = isMac;
    document.body.classList.toggle("mac-translucent-sidebar-body", shouldApply);

    return () => {
      document.body.classList.remove("mac-translucent-sidebar-body");
    };
  }, [isMac]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.settings.getNavigationPreferences()
      .then((preferences) => {
        if (cancelled) {
          return;
        }
        if (Array.isArray(preferences?.mainOrder)) {
          setSidebarNavOrder(preferences.mainOrder as SidebarNavOrderItemKey[]);
        }
        if (Array.isArray(preferences?.webOrder)) {
          setWebGroupOrder(preferences.webOrder as SidebarNavOrderItemKey[]);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setNavigationPreferencesLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.kanban.getSettings()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setKanbanEnabled(result.settings.enabled);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setKanbanSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshMarketSettingsVisibility();
    return () => {
      marketSettingsRefreshIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!navigationPreferencesLoaded || !kanbanSettingsLoaded) {
      return;
    }
    try {
      window.localStorage.setItem(
        SIDEBAR_NAV_ORDER_STORAGE_KEY,
        JSON.stringify(normalizedSidebarNavOrder)
      );
    } catch {
      // Ignore persistence failures and keep the in-memory navigation order usable.
    }
    window.electronAPI.settings.saveNavigationPreferences({
      mainOrder: normalizedSidebarNavOrder
    }).catch(() => undefined);
  }, [kanbanSettingsLoaded, navigationPreferencesLoaded, normalizedSidebarNavOrder]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WEB_GROUP_ORDER_STORAGE_KEY,
        JSON.stringify(normalizedWebGroupOrder)
      );
    } catch {
      // Ignore persistence failures and keep the in-memory web order usable.
    }
    if (navigationPreferencesLoaded) {
      window.electronAPI.settings.saveNavigationPreferences({
        webOrder: normalizedWebGroupOrder
      }).catch(() => undefined);
    }
  }, [navigationPreferencesLoaded, normalizedWebGroupOrder]);

  useEffect(() => {
    document.body.classList.toggle("embedded-surface-body", usesEmbeddedSurface);
    return () => {
      document.body.classList.remove("embedded-surface-body");
    };
  }, [usesEmbeddedSurface]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(sidebarState));
    } catch {
      // Ignore persistence failures and keep the in-memory sidebar state usable.
    }
  }, [sidebarState]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORK_PANEL_WIDTH_STORAGE_KEY,
        JSON.stringify(preferredWorkPanelWidth),
      );
    } catch {
      // Ignore persistence failures and keep the in-memory WorkPanel width usable.
    }
  }, [preferredWorkPanelWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COPILOT_DOCK_WIDTH_STORAGE_KEY,
        JSON.stringify(preferredCopilotDockWidth),
      );
    } catch {
      // Ignore persistence failures and keep the in-memory Copilot Dock width usable.
    }
  }, [preferredCopilotDockWidth]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const updateWidth = () => setAppShellWidth(Math.round(shell.getBoundingClientRect().width));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const content = appContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const updateWidth = () => setAppContentWidth(Math.round(content.getBoundingClientRect().width));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarResizeStateRef.current = null;
    workPanelResizeCleanupRef.current?.();
    workPanelResizeStateRef.current = null;
    copilotDockResizeCleanupRef.current?.();
    copilotDockResizeStateRef.current = null;
  }, []);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    const finishSidebarResize = () => {
      sidebarResizeStateRef.current = null;
      setIsSidebarResizing(false);
    };

    const handleWindowPointerMove = (event: PointerEvent) => {
      const dragState = sidebarResizeStateRef.current;
      if (!dragState) {
        return;
      }

      const nextState = resolveSidebarLayoutStateFromDrag({
        initialState: dragState.initialState,
        deltaX: event.clientX - dragState.startClientX
      });

      setSidebarState((current) =>
        current.mode === nextState.mode &&
        current.expandedWidth === nextState.expandedWidth
          ? current
          : nextState
      );
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", finishSidebarResize);
    window.addEventListener("pointercancel", finishSidebarResize);
    window.addEventListener("blur", finishSidebarResize);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", finishSidebarResize);
      window.removeEventListener("pointercancel", finishSidebarResize);
      window.removeEventListener("blur", finishSidebarResize);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    if (activeChatWorkPanelVisible) return;
    workPanelResizeCleanupRef.current?.();
  }, [activeChatWorkPanelVisible]);

  useEffect(() => {
    const ownerChatId = workPanelFullscreenOwnerChatId;
    if (!ownerChatId) return;
    const workspaceStillVisible =
      activeChatWorkPanelChatId === ownerChatId &&
      workPanelState.visibleOwnerChatIds.includes(ownerChatId) &&
      workPanelState.workspaces.some((workspace) => workspace.ownerChatId === ownerChatId);
    if (!workspaceStillVisible) {
      forceExitWorkPanelFullscreen();
    }
  }, [
    activeChatWorkPanelChatId,
    forceExitWorkPanelFullscreen,
    workPanelFullscreenOwnerChatId,
    workPanelState.visibleOwnerChatIds,
    workPanelState.workspaces,
  ]);

  useEffect(() => {
    if (assistantCopilotOpen && !copilotDockOverlayMode && !copilotDockNativeDialogVisible) {
      return;
    }
    copilotDockResizeCleanupRef.current?.();
  }, [assistantCopilotOpen, copilotDockNativeDialogVisible, copilotDockOverlayMode]);

  useEffect(() => {
    if (!pendingSidebarNavigationPath) {
      return;
    }

    if (currentRoute !== pendingSidebarNavigationPath) {
      return;
    }

    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, 220);
  }, [currentRoute, pendingSidebarNavigationPath]);

  useEffect(() => {
    if (!activeServiceId) {
      return;
    }

    setMountedServiceIds((current) =>
      current.includes(activeServiceId) ? current : [...current, activeServiceId]
    );
  }, [activeServiceId]);

  useEffect(() => {
    if (!activeWebEntryKey) {
      return;
    }

    setMountedWebEntryKeys((current) =>
      current.includes(activeWebEntryKey)
        ? current
        : [...current, activeWebEntryKey]
    );
  }, [activeWebEntryKey]);

  useEffect(() => {
    const requestedWebappEntryKey = activeWebEntryKey;
    if (!requestedWebappEntryKey) {
      return;
    }
    const item = webItems.find((candidate) => candidate.entryKey === requestedWebappEntryKey);
    if (!item || item.kind !== "webapp") {
      return;
    }
    const runtime = webappRuntimeById[item.id];
    if (runtime?.status === "starting" || runtime?.status === "running" || runtime?.status === "error") {
      return;
    }
    if (webappStartInFlightRef.current.has(item.id)) {
      return;
    }
    if (webappStopInFlightRef.current.has(item.id)) {
      return;
    }

    webappStartInFlightRef.current.add(item.id);
    setWebappRuntimeById((current) => ({
      ...current,
      [item.id]: {
        status: "starting",
        webUrl: current[item.id]?.webUrl ?? "",
        message: t("webapp.starting"),
        state: current[item.id]?.state ?? null
      }
    }));
    window.electronAPI.webs.webapps.start(item.id)
      .then((result) => {
        setWebappRuntimeById((current) => ({
          ...current,
          [item.id]: {
            status: result.ok && result.state?.webUrl ? "running" : "error",
            webUrl: result.state?.webUrl ?? "",
            message: result.message,
            state: result.state
          }
        }));
      })
      .catch((error) => {
        setWebappRuntimeById((current) => ({
          ...current,
          [item.id]: {
            status: "error",
            webUrl: "",
            message: error instanceof Error ? error.message : String(error),
            state: null
          }
        }));
      })
      .finally(() => {
        webappStartInFlightRef.current.delete(item.id);
      });
  }, [activeWebEntryKey, webItems, webappRuntimeById]);

  useEffect(() => {
    if (!usesBuiltinBrowserSurface) {
      return;
    }

    setBuiltinBrowserSurfaceMounted(true);
  }, [usesBuiltinBrowserSurface]);

  useEffect(() => {
    if (!webItemsLoaded) {
      return;
    }

    const availableEntryKeys = new Set(webItems.map((item) => item.entryKey));
    setMountedWebEntryKeys((current) =>
      current.filter((entryKey) => availableEntryKeys.has(entryKey))
    );
  }, [webItems, webItemsLoaded]);

  function handleThemeModeChange(nextThemeMode: ThemePreference) {
    setThemeMode(nextThemeMode);
  }

  function toggleSidebarCollapsed() {
    setSidebarState((current) => toggleSidebarLayoutState(current));
  }

  function handleSidebarResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      isSidebarResizing ||
      isWorkPanelResizing ||
      isCopilotDockResizing ||
      isSecondarySidebarMode
    ) {
      return;
    }

    event.preventDefault();
    sidebarResizeStateRef.current = {
      initialState: sidebarState,
      startClientX: event.clientX
    };
    setIsSidebarResizing(true);
  }

  function handleWorkPanelResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || isSidebarResizing || isWorkPanelResizing || isCopilotDockResizing) return;
    event.preventDefault();
    workPanelResizeCleanupRef.current?.();
    const resizer = event.currentTarget;
    const dragState = {
      initialWidth: renderedWorkPanelWidth,
      pointerId: event.pointerId,
      startClientX: event.clientX,
    };
    workPanelResizeStateRef.current = dragState;
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // The overlay still keeps subsequent pointer events inside the renderer.
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== dragState.pointerId) return;
      if (pointerEvent.cancelable) pointerEvent.preventDefault();
      setPreferredWorkPanelWidth(resolveWorkPanelWidthFromDrag({
        initialWidth: dragState.initialWidth,
        startClientX: dragState.startClientX,
        currentClientX: pointerEvent.clientX,
        availableWidth: appContentWidth || undefined,
      }));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
      window.removeEventListener("blur", cleanup);
      if (workPanelResizeCleanupRef.current === cleanup) {
        workPanelResizeCleanupRef.current = null;
      }
      if (workPanelResizeStateRef.current?.pointerId === dragState.pointerId) {
        workPanelResizeStateRef.current = null;
      }
      setIsWorkPanelResizing(false);
      try {
        if (resizer.hasPointerCapture(dragState.pointerId)) {
          resizer.releasePointerCapture(dragState.pointerId);
        }
      } catch {
        // Pointer capture can already be gone after crossing an embedded surface.
      }
    };
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === dragState.pointerId) cleanup();
    };
    workPanelResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    window.addEventListener("blur", cleanup);
    setIsWorkPanelResizing(true);
  }

  function handleWorkPanelResizerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = renderedWorkPanelWidth + WORK_PANEL_RESIZE_STEP;
        break;
      case "ArrowRight":
        nextWidth = renderedWorkPanelWidth - WORK_PANEL_RESIZE_STEP;
        break;
      case "Home":
        nextWidth = WORK_PANEL_MIN_WIDTH;
        break;
      case "End":
        nextWidth = workPanelMaxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPreferredWorkPanelWidth(clampWorkPanelWidth(nextWidth, appContentWidth || undefined));
  }

  function handleCopilotDockResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      isSidebarResizing ||
      isWorkPanelResizing ||
      isCopilotDockResizing ||
      copilotDockOverlayMode ||
      copilotDockNativeDialogVisible
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    copilotDockResizeCleanupRef.current?.();
    const resizer = event.currentTarget;
    const dragState = {
      initialWidth: renderedCopilotDockWidth,
      pointerId: event.pointerId,
      startClientX: event.clientX,
    };
    copilotDockResizeStateRef.current = dragState;
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // The overlay still keeps subsequent pointer events inside the renderer.
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== dragState.pointerId) return;
      if (pointerEvent.cancelable) pointerEvent.preventDefault();
      setPreferredCopilotDockWidth(resolveCopilotDockWidthFromDrag({
        initialWidth: dragState.initialWidth,
        startClientX: dragState.startClientX,
        currentClientX: pointerEvent.clientX,
        availableWidth: copilotDockAvailableWidth,
      }));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
      window.removeEventListener("blur", cleanup);
      if (copilotDockResizeCleanupRef.current === cleanup) {
        copilotDockResizeCleanupRef.current = null;
      }
      if (copilotDockResizeStateRef.current?.pointerId === dragState.pointerId) {
        copilotDockResizeStateRef.current = null;
      }
      setIsCopilotDockResizing(false);
      try {
        if (resizer.hasPointerCapture(dragState.pointerId)) {
          resizer.releasePointerCapture(dragState.pointerId);
        }
      } catch {
        // Pointer capture can already be gone after crossing an embedded surface.
      }
    };
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === dragState.pointerId) cleanup();
    };
    copilotDockResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    window.addEventListener("blur", cleanup);
    setIsCopilotDockResizing(true);
  }

  function handleCopilotDockResizerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = renderedCopilotDockWidth + COPILOT_DOCK_RESIZE_STEP;
        break;
      case "ArrowRight":
        nextWidth = renderedCopilotDockWidth - COPILOT_DOCK_RESIZE_STEP;
        break;
      case "Home":
        nextWidth = COPILOT_DOCK_MIN_WIDTH;
        break;
      case "End":
        nextWidth = copilotDockMaxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPreferredCopilotDockWidth(clampCopilotDockWidth(
      nextWidth,
      copilotDockAvailableWidth,
    ));
  }

  function requestSidebarNavigation(targetPath: string) {
    targetPath = resolveKanbanAwareNavigationPath(targetPath, kanbanEnabled);
    if (targetPath === currentRoute) {
      return false;
    }

    setSidebarNavigationHistory((current) => ({
      back: [...current.back, currentRoute],
      forward: []
    }));
    setPendingSidebarNavigationPath(targetPath);
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, SIDEBAR_NAVIGATION_LOCK_MS);
    navigate(targetPath);
    return true;
  }

  function requestNavigationWithAgentChatFocus(targetPath: string) {
    const targetRoute = resolveNavigationRoute(targetPath);
    if (isSingleAgentWebclientRoute(resolveNavigationPathname(targetRoute))) {
      agentChatFocusRequestIdRef.current += 1;
      setPendingAgentChatFocusRequest({
        id: agentChatFocusRequestIdRef.current,
        sourceRoute: currentRoute,
        targetRoute,
      });
    }
    return requestSidebarNavigation(targetPath);
  }

  function openChatHistoryDialog(agentKey = "") {
    chatHistoryDialogRequestIdRef.current += 1;
    setChatHistoryDialog({
      id: chatHistoryDialogRequestIdRef.current,
      agentKey: agentKey.trim(),
    });
  }

  function openChatFromHistoryDialog(request: {
    agentKey: string;
    chatId: string;
  }) {
    setChatHistoryDialog(null);
    requestNavigationWithAgentChatFocus(createAgentWebclientRoute(request));
  }

  function handleAgentChatFocusRequestHandled(requestId: number) {
    setPendingAgentChatFocusRequest((current) =>
      current?.id === requestId ? null : current
    );
  }

  function navigateWithSidebarHistory(targetPath: string, direction: "back" | "forward") {
    targetPath = resolveKanbanAwareNavigationPath(targetPath, kanbanEnabled);
    if (targetPath === currentRoute) {
      return;
    }

    setSidebarNavigationHistory((current) => {
      if (direction === "back") {
        return {
          back: current.back.slice(0, -1),
          forward: [...current.forward, currentRoute]
        };
      }
      return {
        back: [...current.back, currentRoute],
        forward: current.forward.slice(0, -1)
      };
    });
    setPendingSidebarNavigationPath(targetPath);
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, SIDEBAR_NAVIGATION_LOCK_MS);
    navigate(targetPath);
  }

  function handleSidebarBackNavigation() {
    const targetPath = sidebarNavigationHistory.back.at(-1);
    if (!targetPath) {
      return;
    }
    navigateWithSidebarHistory(targetPath, "back");
  }

  function handleSidebarForwardNavigation() {
    const targetPath = sidebarNavigationHistory.forward.at(-1);
    if (!targetPath) {
      return;
    }
    navigateWithSidebarHistory(targetPath, "forward");
  }

  function handleSelectSettingsSection(sectionId: SettingsSectionId) {
    if (sectionId === "about" && !debugSettingsUnlocked) {
      aboutSettingsClickCountRef.current += 1;
      if (aboutSettingsClickCountRef.current >= 5) {
        setDebugSettingsUnlocked(true);
      }
    } else if (sectionId !== "about") {
      aboutSettingsClickCountRef.current = 0;
    }

    const targetPath = buildSettingsSectionPath(sectionId);
    if (targetPath === currentRoute) {
      return;
    }
    requestSidebarNavigation(targetPath);
  }

  function handleCloseDebugSettings() {
    aboutSettingsClickCountRef.current = 0;
    setDebugSettingsUnlocked(false);
    void window.electronAPI.desktopActions.closeWorkbench();

    const targetPath = buildSettingsSectionPath("about");
    setSidebarNavigationHistory((current) => ({
      back: current.back.at(-1) === targetPath ? current.back.slice(0, -1) : current.back,
      forward: []
    }));
    navigate(targetPath, { replace: true });
  }

  function handleExitSecondarySidebarMode() {
    const targetPath = resolveSecondarySidebarExitTargetPath(
      lastPrimaryRouteRef.current,
      kanbanEnabled,
      chatRuntimeAgent.agentKey,
    );
    if (targetPath === currentRoute) {
      return;
    }
    setSidebarNavigationHistory((current) => ({
      back: removeSecondarySidebarRoutesFromHistory(current.back),
      forward: []
    }));
    setPendingSidebarNavigationPath(targetPath);
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, SIDEBAR_NAVIGATION_LOCK_MS);
    navigate(targetPath, { replace: true });
  }

  useEffect(() => {
    if (isSecondarySidebarMode) {
      return;
    }
    lastPrimaryRouteRef.current = resolveSecondarySidebarExitTargetPath(
      currentRoute,
      kanbanEnabled,
      chatRuntimeAgent.agentKey,
    );
  }, [
    chatRuntimeAgent.agentKey,
    currentRoute,
    isSecondarySidebarMode,
    kanbanEnabled,
  ]);

  useEffect(() => {
    if (!isSettingsRoute || location.pathname !== "/settings") {
      return;
    }
    const normalizedSettingsPath = getDefaultSettingsSectionPath(visibleSettingsSectionIds);
    if (normalizedSettingsPath !== location.pathname) {
      navigate(normalizedSettingsPath, { replace: true });
    }
  }, [isSettingsRoute, location.pathname, navigate, visibleSettingsSectionIds]);

  useEffect(() => {
    if (!isSettingsRoute || !activeSettingsSectionId) {
      return;
    }
    const normalizedSettingsPath = buildSettingsSectionPath(activeSettingsSectionId);
    if (location.pathname !== normalizedSettingsPath) {
      navigate(normalizedSettingsPath, { replace: true });
    }
  }, [activeSettingsSectionId, isSettingsRoute, location.pathname, navigate]);

  const experimentalItemMap = new Map(EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => [item.id, item]));

  useEffect(() => {
    if (!usesStandardBaseSurface || isSettingsRoute) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const pageContext = await getAssistantPageContext();
      if (cancelled) {
        return;
      }
      publishCurrentPageContextSnapshot({
        route: currentRoute,
        pageKey: `native:${currentRoute}`,
        pageKind: "native",
        pageContext
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [currentRoute, isSettingsRoute, usesStandardBaseSurface]);

  useEffect(() => {
    function normalizeSurfaceTarget(value: unknown) {
      return String(value ?? "").trim().toLowerCase();
    }

    function getSurfaceTarget(args: Record<string, unknown>) {
      return normalizeSurfaceTarget(args.target || args.surfaceId || args.id || args.label || args.url || args.hostname);
    }

    function createSurfaceList() {
      const serviceSurfaces = services
        .filter((service) => service.status === "running" && service.frontendMode !== "none" && service.healthMeta.webUrl)
        .map((service) => ({
          ...createServiceSurfaceIdentity(service.id),
          id: createServiceSurfaceIdentity(service.id).surfaceId,
          kind: "service" as const,
          label: getServiceDisplayName(service.id, service.name, t),
          url: service.healthMeta.webUrl,
          route: service.id === "agent-webclient"
            ? activeAgentWebclientRoute?.routePath ?? ASSISTANT_TARGET_PATH
            : `/service/${service.id}`,
          active: activeServiceId === service.id
        }));

      return [
        {
          ...createSurfaceIdentity("browser"),
          id: BUILTIN_BROWSER_SURFACE_ID,
          kind: "browser" as const,
          label: BUILTIN_BROWSER_SURFACE_LABEL,
          url: BUILTIN_BROWSER_DEFAULT_URL,
          route: BUILTIN_BROWSER_ROUTE,
          active: location.pathname === BUILTIN_BROWSER_ROUTE
        },
        ...[...webItemMap.entries()].map(([entryKey, item]) => ({
          ...createWebEntrySurfaceIdentity(item.kind, entryKey),
          id: createWebEntrySurfaceIdentity(item.kind, entryKey).surfaceId,
          kind: item.kind,
          label: item.label,
          url: item.url,
          route: `/webs/${entryKey}`,
          active: activeWebEntryKey === entryKey
        })),
        ...serviceSurfaces
      ];
    }

    function resolvePublicSurfaceIdAlias(surfaceId: string) {
      const fixed = resolveLegacyFixedSurfaceId(surfaceId);
      if (fixed !== surfaceId) {
        reportLegacyPublicSurfaceId(surfaceId, fixed);
        return fixed;
      }
      const webItem = webItemMap.get(surfaceId as WebEntryKey);
      if (webItem) {
        const canonical = createWebEntrySurfaceIdentity(webItem.kind, surfaceId).surfaceId;
        reportLegacyPublicSurfaceId(surfaceId, canonical);
        return canonical;
      }
      if (services.some((service) => service.id === surfaceId)) {
        const canonical = createServiceSurfaceIdentity(surfaceId).surfaceId;
        reportLegacyPublicSurfaceId(surfaceId, canonical);
        return canonical;
      }
      return surfaceId;
    }

    function reportLegacyPublicSurfaceId(legacy: string, canonical: string) {
      if (!legacy || legacy === canonical || REPORTED_LEGACY_PUBLIC_SURFACE_IDS.has(legacy)) return;
      REPORTED_LEGACY_PUBLIC_SURFACE_IDS.add(legacy);
      console.warn(`[surface-identity] deprecated surfaceId "${legacy}" accepted; use "${canonical}"`);
    }

    function surfaceMatchesTarget(
      surface: ReturnType<typeof createSurfaceList>[number],
      target: string
    ) {
      if (!target) {
        return false;
      }
      const candidates = [
        surface.id,
        surface.label,
        surface.url,
        surface.route
      ];
      try {
        candidates.push(new URL(surface.url).hostname);
      } catch {
        // Ignore malformed stored URLs; custom sidebar storage sanitizes these.
      }
      return candidates.some((candidate) => {
        const normalizedCandidate = normalizeSurfaceTarget(candidate);
        return normalizedCandidate === target ||
          normalizedCandidate.includes(target) ||
          target.includes(normalizedCandidate);
      });
    }

    return registerDesktopActionProviderForScope("global", async (request) => {
      const args = request.args ?? {};

      switch (request.action) {
        case "desktop.web.listSurfaces":
          return { ok: true, result: { surfaces: createSurfaceList() } };
        case "desktop.web.getSurfaceState": {
          const requestedSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
          const surfaceId = resolvePublicSurfaceIdAlias(requestedSurfaceId);
          if (!surfaceId) {
            return {
              ok: false,
              error: {
                code: "invalid_args",
                message: "surfaceId is required"
              }
            };
          }
          const surface = createSurfaceList().find((candidate) => candidate.id === surfaceId);
          if (!surface) {
            return {
              ok: false,
              error: {
                code: "surface_not_found",
                message: t("desktopAction.surfaceNotFound"),
                details: { surfaceId }
              }
            };
          }
          const state = readWebSurfaceState(surfaceId);
          return state
            ? { ok: true, result: state }
            : {
                ok: true,
                result: {
                  surface: {
                    ...surface,
                    open: false
                  },
                  tabs: [],
                  activeTabId: null
                }
              };
        }
        case "desktop.web.activateSurface": {
          const target = getSurfaceTarget(args);
          const surface = createSurfaceList().find((candidate) => surfaceMatchesTarget(candidate, target));
          if (!surface) {
            return {
              ok: false,
              error: {
                code: "surface_not_found",
                message: t("desktopAction.surfaceNotFound"),
                details: { target, surfaces: createSurfaceList() }
              }
            };
          }
          navigate(surface.route);
          return { ok: true, result: { surface: { ...surface, active: true } } };
        }
        default:
          return null;
      }
    });
  }, [
    activeWebEntryKey,
    activeAgentWebclientRoute,
    activeServiceId,
    webItems,
    location.pathname,
    navigate,
    services
  ]);

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    const args = request.args ?? {};

    if (request.action === "desktop.theme.get") {
      return {
        ok: true,
        result: { themeMode, resolvedTheme }
      };
    }
    if (request.action !== "desktop.theme.set") {
      return null;
    }
    if (!isThemePreference(args.themeMode)) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "themeMode must be light, dark, or system."
        }
      };
    }
    const nextThemeMode = args.themeMode;
    await window.electronAPI.settings.setNativeThemeSource(nextThemeMode);
    setThemeMode(nextThemeMode);
    return {
      ok: true,
      result: {
        themeMode: nextThemeMode,
        resolvedTheme: resolveThemePreference(nextThemeMode)
      }
    };
  }), [resolvedTheme, themeMode]);

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    const args = request.args ?? {};

    if (request.action === "desktop.locale.get") {
      return {
        ok: true,
        result: await window.electronAPI.settings.getLocale()
      };
    }
    if (request.action !== "desktop.locale.set") {
      return null;
    }
    if (!isSupportedLocale(args.locale)) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "locale must be zh-CN or en-US."
        }
      };
    }
    await setLocale(args.locale);
    return {
      ok: true,
      result: await window.electronAPI.settings.getLocale()
    };
  }), [setLocale]);

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    const args = request.args ?? {};

    if (request.action === "desktop.copilot.getPagePreferences") {
      const [settings, agentOptions] = await Promise.all([
        window.electronAPI.assistant.getSettings(),
        window.electronAPI.assistant.listAgents()
      ]);
      setAssistantSettings(settings);
      return {
        ok: true,
        result: {
          desktopCopilotPages: settings.desktopCopilotPages,
          agentOptions
        }
      };
    }
    if (request.action !== "desktop.copilot.setPagePreference") {
      return null;
    }

    const pageKey = readString(args.pageKey);
    if (!isDesktopCopilotPageKey(pageKey)) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "pageKey must be controlCenter, market, help, agents, schedules, or skills."
        }
      };
    }
    const hasEnabled = hasOwn(args, "enabled");
    const hasAgentKey = hasOwn(args, "agentKey");
    if (!hasEnabled && !hasAgentKey) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "enabled or agentKey is required."
        }
      };
    }
    if (hasEnabled && typeof args.enabled !== "boolean") {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "enabled must be boolean."
        }
      };
    }
    if (hasAgentKey && typeof args.agentKey !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: "agentKey must be a string."
        }
      };
    }

    const [settings, agentOptions] = await Promise.all([
      window.electronAPI.assistant.getSettings(),
      window.electronAPI.assistant.listAgents()
    ]);
    const currentPreference = settings.desktopCopilotPages[pageKey];
    const nextPreference = {
      enabled: hasEnabled ? args.enabled as boolean : currentPreference.enabled,
      agentKey: hasAgentKey ? readString(args.agentKey) : currentPreference.agentKey
    };
    if (
      nextPreference.enabled &&
      !agentOptions.some((agent) => agent.agentKey === nextPreference.agentKey)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_agent",
          message: "An enabled Copilot page must reference an available agent.",
          details: {
            pageKey,
            agentKey: nextPreference.agentKey,
            agentOptions
          }
        }
      };
    }

    const nextSettings = await window.electronAPI.assistant.saveSettings({
      desktopCopilotPages: {
        [pageKey]: nextPreference
      }
    });
    setAssistantSettings(nextSettings);
    return {
      ok: true,
      result: {
        pageKey,
        preference: nextSettings.desktopCopilotPages[pageKey],
        desktopCopilotPages: nextSettings.desktopCopilotPages
      }
    };
  }), []);

  const handleWindowDragPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const dragTarget = resolveWindowDragTarget(target);
    if (!dragTarget) {
      return;
    }

    const desktopShell = window.electronAPI.desktopShell;
    if (!desktopShell.beginWindowDrag || !desktopShell.endWindowDrag) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    windowDragEndRef.current?.();

    const pointerId = event.pointerId;
    let ended = false;
    let pointerCaptureRestoreFrame: number | null = null;
    const finishDrag = () => {
      if (ended) {
        return;
      }
      ended = true;
      if (pointerCaptureRestoreFrame !== null) {
        window.cancelAnimationFrame(pointerCaptureRestoreFrame);
        pointerCaptureRestoreFrame = null;
      }
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", finishDrag, true);
      window.removeEventListener("mouseup", finishDragOnMouseUp, true);
      window.removeEventListener("blur", finishDragOnWindowBlur);
      dragTarget.removeEventListener("lostpointercapture", finishDragOnLostPointerCapture, true);
      try {
        if (dragTarget.hasPointerCapture(pointerId)) {
          dragTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Pointer capture can already be gone when the pointer leaves an embedded surface.
      }
      windowDragEndRef.current = null;
      void desktopShell.endWindowDrag().catch(() => undefined);
    };
    const finishDragOnMouseUp = (mouseEvent: globalThis.MouseEvent) => {
      if (mouseEvent.button === 0) {
        finishDrag();
      }
    };
    const finishDragOnWindowBlur = (blurEvent: globalThis.FocusEvent) => {
      // A focused <webview> also emits blur when the pointer returns to the host drag lane.
      // Only the Window's own blur should cancel the active drag.
      if (blurEvent.target === window) {
        finishDrag();
      }
    };
    const finishDragOnLostPointerCapture: EventListener = (captureEvent) => {
      const pointerEvent = captureEvent as globalThis.PointerEvent;
      // Window activation can drop capture while the first press is still held.
      // Restore it after focus settles so the eventual release still reaches this window.
      if (pointerEvent.buttons !== 0) {
        if (pointerCaptureRestoreFrame !== null) {
          window.cancelAnimationFrame(pointerCaptureRestoreFrame);
        }
        pointerCaptureRestoreFrame = window.requestAnimationFrame(() => {
          pointerCaptureRestoreFrame = null;
          if (ended) {
            return;
          }
          try {
            dragTarget.setPointerCapture(pointerId);
          } catch {
            // Window-level pointer/mouse release listeners and the main timeout remain as fallbacks.
          }
        });
        return;
      }
      finishDrag();
    };

    windowDragEndRef.current = finishDrag;
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", finishDrag, true);
    window.addEventListener("mouseup", finishDragOnMouseUp, true);
    window.addEventListener("blur", finishDragOnWindowBlur);
    dragTarget.addEventListener("lostpointercapture", finishDragOnLostPointerCapture, true);
    try {
      dragTarget.setPointerCapture(pointerId);
    } catch {
      // The main-process cursor loop still keeps the drag alive across webview boundaries.
    }

    void desktopShell.beginWindowDrag({ x: event.screenX, y: event.screenY }).then((result) => {
      if (!result?.ok) {
        finishDrag();
      }
    }).catch(finishDrag);
  }, []);

  useEffect(() => () => {
    windowDragEndRef.current?.();
  }, []);

  const appShellStyle = {
    "--app-sidebar-width": `${effectiveSidebarWidth}px`,
    "--chat-work-panel-width": `${renderedWorkPanelWidth}px`,
    "--assistant-dock-embedded-width": `${renderedCopilotDockWidth}px`,
  } as CSSProperties;
  const normalizedBootstrapAgentKey = assistantSettings?.bootstrapAgentKey.trim() ?? "";

  const dispatchWorkPanelCommand = useCallback((command: WorkPanelCommand) => {
    let currentState = workPanelStateRef.current;
    const isOverviewCommand = command.type === "openItem" &&
      command.descriptor.kind === "webclient" &&
      command.descriptor.module === "overview";
    const shouldEnsureOverview = command.type === "showWorkspace" ||
      (command.type === "openItem" && !isOverviewCommand);
    const currentWorkspace = currentState.workspaces.find(
      (workspace) => workspace.ownerChatId === command.ownerChatId,
    );
    const hasOverview = currentWorkspace?.items.some((item) =>
      item.descriptor.kind === "webclient" && item.descriptor.module === "overview",
    ) ?? false;

    if (shouldEnsureOverview && !hasOverview) {
      const descriptorAgentKey = command.type === "openItem" &&
        command.descriptor.kind === "webclient" &&
        "agentKey" in command.descriptor.context
        ? command.descriptor.context.agentKey.trim()
        : "";
      const routeAgentKey = activeChatRouteInfo.chatId === command.ownerChatId
        ? activeChatRouteInfo.agentKey.trim()
        : "";
      const previousActiveItemId = currentWorkspace?.activeItemId ?? null;
      const overviewAgentKey = descriptorAgentKey || routeAgentKey;
      const ensured = reduceWorkPanelCommand(currentState, {
        type: "openItem",
        ownerChatId: command.ownerChatId,
        descriptor: {
          kind: "webclient",
          module: "overview",
          route: createAgentWebclientOverviewPath({
            chatId: command.ownerChatId,
          }),
          context: {
            chatId: command.ownerChatId,
            agentKey: overviewAgentKey,
          },
          title: t("chatWorkPanel.overview"),
          pinned: true,
          closable: false,
        },
      });
      if (!ensured.ok) return ensured;
      currentState = ensured.nextState;
      if (command.type === "showWorkspace" && previousActiveItemId) {
        currentState = reduceWorkPanelCommand(currentState, {
          type: "activateItem",
          ownerChatId: command.ownerChatId,
          itemId: previousActiveItemId,
        }).nextState;
      }
    }

    const normalizedCommand = isOverviewCommand
      ? {
          ...command,
          descriptor: { ...command.descriptor, pinned: true as const, closable: false as const },
        }
      : command;
    const result = reduceWorkPanelCommand(currentState, normalizedCommand);
    if (result.nextState !== workPanelStateRef.current) {
      workPanelStateRef.current = result.nextState;
      setWorkPanelState(result.nextState);
    }
    return result;
  }, [activeChatRouteInfo.agentKey, activeChatRouteInfo.chatId, t]);

  const ensureChatWorkPanelWorkspace = useCallback((chatId: string, agentKey: string) => {
    const normalizedAgentKey = agentKey.trim();
    return dispatchWorkPanelCommand({
      type: "openItem",
      ownerChatId: chatId,
      descriptor: {
        kind: "webclient",
        module: "overview",
        route: createAgentWebclientOverviewPath({ chatId }),
        context: { chatId, agentKey: normalizedAgentKey },
        title: t("chatWorkPanel.overview"),
        pinned: true,
        closable: false,
      },
    });
  }, [dispatchWorkPanelCommand, t]);

  const closeChatWorkPanelWorkspace = useCallback((chatId: string, force = false) => {
    dispatchWorkPanelCommand({
      type: "closeWorkspace",
      ownerChatId: chatId,
      force,
    });
  }, [dispatchWorkPanelCommand]);

  const handleHistoryChatRemoved = useCallback((
    chat: AssistantHistoryChatItem,
    nextChat: AssistantHistoryChatItem | null,
  ) => {
    closeChatWorkPanelWorkspace(chat.chatId, true);
    if (activeChatRouteInfo.chatId === chat.chatId) {
      const ownerAgentKey = chat.agentKey || activeChatRouteInfo.agentKey.trim();
      const fallbackRoute = nextChat?.agentKey
        ? createAgentChatRoute(nextChat.agentKey, nextChat.chatId)
        : ownerAgentKey
          ? createAgentWebclientRoute({ agentKey: ownerAgentKey })
          : "/agents";
      requestNavigationWithAgentChatFocus(fallbackRoute);
    }
    void refreshAssistantNavAgents({ force: true });
  }, [activeChatRouteInfo.agentKey, activeChatRouteInfo.chatId, closeChatWorkPanelWorkspace, currentRoute]);

  const toggleMainChatWorkPanel = useCallback(() => {
    const chatId = activeChatWorkPanelChatId;
    if (!chatId) return;
    const currentState = workPanelStateRef.current;
    if (currentState.visibleOwnerChatIds.includes(chatId)) {
      dispatchWorkPanelCommand({ type: "hideWorkspace", ownerChatId: chatId });
      return;
    }
    if (currentState.workspaces.some((workspace) => workspace.ownerChatId === chatId)) {
      dispatchWorkPanelCommand({ type: "showWorkspace", ownerChatId: chatId });
      return;
    }
    const agentKey = activeChatRouteInfo.agentKey.trim();
    if (!agentKey) return;
    dispatchWorkPanelCommand({
      type: "openItem",
      ownerChatId: chatId,
      descriptor: {
        kind: "webclient",
        module: "overview",
        route: createAgentWebclientOverviewPath({ chatId }),
        context: { chatId, agentKey },
        title: t("chatWorkPanel.overview"),
        pinned: true,
        closable: false,
      },
    });
  }, [activeChatRouteInfo.agentKey, activeChatWorkPanelChatId, dispatchWorkPanelCommand, t]);

  const openChatWorkPanelFromSidebar = useCallback((chatId: string, agentKey: string) => {
    ensureChatWorkPanelWorkspace(chatId, agentKey);
    if (activeChatWorkPanelChatId !== chatId) {
      requestSidebarNavigation(createAgentChatRoute(agentKey, chatId));
    }
  }, [activeChatWorkPanelChatId, ensureChatWorkPanelWorkspace, requestSidebarNavigation]);

  const openAgentProjectEditorFromSidebar = useCallback((agent: AssistantNavAgentItem) => {
    const agentKey = agent.agentKey.trim();
    if (!agentKey) {
      return;
    }
    const routeInfo = readAgentRouteInfo(`${location.pathname}${location.search}`);
    const activeChatId = routeInfo.agentKey === agentKey ? routeInfo.chatId : "";
    const preferredChatId =
      activeChatId ||
      agent.latestChatId?.trim() ||
      agent.recentChats[0]?.chatId.trim() ||
      "";
    const preferredChat = [...agent.recentChats, ...assistantNavChatItems].find(
      (chat) =>
        (chat.agentKey.trim() || agentKey) === agentKey &&
        chat.chatId.trim() === preferredChatId,
    );
    projectFloatingFocusRequestIdRef.current += 1;
    const nextEntry: ProjectFloatingWebviewEntry = {
      agentKey,
      displayName: agent.displayName.trim() || agentKey,
      embedPath: createAgentWebclientProjectPath({
        agentKey,
        chatId: preferredChatId,
        runId: preferredChat?.lastRunId,
      }),
      focusRequestId: projectFloatingFocusRequestIdRef.current,
    };
    setProjectFloatingWebviews((current) => [
      ...current.filter((entry) => entry.agentKey !== agentKey),
      nextEntry,
    ]);
  }, [assistantNavChatItems, location.pathname, location.search]);

  const bringProjectFloatingWebviewToFront = useCallback((agentKey: string) => {
    setProjectFloatingWebviews((current) => {
      const index = current.findIndex((entry) => entry.agentKey === agentKey);
      if (index < 0 || index === current.length - 1) {
        return current;
      }
      const entry = current[index];
      return [
        ...current.slice(0, index),
        ...current.slice(index + 1),
        entry,
      ];
    });
  }, []);

  const closeProjectFloatingWebview = useCallback((agentKey: string) => {
    setProjectFloatingWebviews((current) =>
      current.filter((entry) => entry.agentKey !== agentKey),
    );
  }, []);

  const mainChatWorkPanelToggle = showMainChatWorkPanelToggle ? (
    <button
      type="button"
      className={`main-chat-work-panel-toggle${activeChatWorkPanelVisible ? " is-active" : ""}`}
      aria-label={t(activeChatWorkPanelVisible
        ? "sidebar.chat.workPanel.close"
        : "sidebar.chat.workPanel.open")}
      aria-pressed={activeChatWorkPanelVisible}
      disabled={!activeChatWorkPanelChatId}
      title={t(activeChatWorkPanelVisible
        ? "sidebar.chat.workPanel.close"
        : "sidebar.chat.workPanel.open")}
      onClick={toggleMainChatWorkPanel}
    >
      <SidebarActionIcon
        kind="sidebar_left"
        className="main-chat-work-panel-toggle-icon"
      />
    </button>
  ) : null;

  return (
    <DebugModeContext.Provider value={debugSettingsUnlocked}>
      <div
        ref={appShellRef}
        style={appShellStyle}
        onPointerDownCapture={handleWindowDragPointerDownCapture}
        className={[
        "app-shell",
        usesEmbeddedSurface ? "has-embedded-surface" : "",
        usesBuiltinBrowserSurface ? "has-builtin-browser-surface" : "",
        usesBrowserChromeSurface ? "has-browser-chrome-surface" : "",
        usesServiceWebviewSurface ? "has-service-webview-surface" : "",
        isKanbanRoute ? "has-kanban-controls" : "",
        isMarketRoute && marketEnabled ? "has-market-controls" : "",
        usesStandardBaseSurface ? "has-standard-base-surface" : "",
        showsEmptyContentSurface ? "has-empty-content-surface" : "",
        assistantCopilotOpen ? "has-assistant-dock" : "",
        assistantCopilotOpen ? "has-assistant-dock-full" : "",
        assistantCopilotOpen && copilotDockOverlayMode ? "has-assistant-dock-overlay" : "",
        activeChatWorkPanelVisible ? "has-chat-work-panel" : "",
        workPanelFullscreenOwnerChatId ? "is-work-panel-fullscreen" : "",
        showMainChatWorkPanelToggle ? "has-main-chat-work-panel-toggle" : "",
        isMac ? "is-mac-platform" : "",
        isWindows ? "is-windows-platform" : "",
        windowFullScreen ? "is-window-fullscreen" : "",
        effectiveSidebarCollapsed ? "is-sidebar-collapsed" : "",
        isSidebarResizing ? "is-sidebar-resizing" : "",
        isWorkPanelResizing ? "is-work-panel-resizing" : "",
        isCopilotDockResizing ? "is-copilot-dock-resizing" : "",
        isSecondarySidebarMode ? "is-secondary-sidebar-mode" : "",
        sidebarMode === "capabilities" ? "is-capabilities-mode" : "",
        isSettingsRoute ? "is-settings-mode" : "",
        "has-translucent-sidebar",
        isMac ? "is-mac-translucent-sidebar" : ""
      ].filter(Boolean).join(" ")}
    >
      <div className="app-window-drag-layer" aria-hidden="true">
        <div className="app-window-drag-region" />
      </div>
      <div className="app-window-controls-layer">
        {mainChatWorkPanelToggle}
      </div>
      <div className="app-sidebar-shell">
        <AppSidebar
          isCollapsed={effectiveSidebarCollapsed}
          isMac={isMac}
          isWindows={isWindows}
          currentPathname={location.pathname}
          currentRoute={currentRoute}
          pendingPath={pendingSidebarNavigationPath}
          assistantDockOpen={assistantCopilotOpen}
          assistantLauncherDisabled={isAgentWebclientMainRoute}
          assistantLauncherVisible={assistantLauncherVisible}
          marketEnabled={marketEnabled}
          sidebarNavOrder={normalizedSidebarNavOrder}
          websiteNavOrder={normalizedWebGroupOrder}
          webItems={webItems}
          webOpenEntryKeys={webOpenEntryKeys}
          webRunningEntryKeys={webRunningEntryKeys}
          faviconCache={faviconCache}
          assistantNavAgents={assistantNavAgents}
          assistantNavChatItems={assistantNavChatItems}
          assistantNavChatItemsHasMore={assistantNavChatItemsHasMore}
          chatWorkPanelOpenChatIds={workPanelState.workspaces.map((workspace) => workspace.ownerChatId)}
          assistantNavAgentsLoaded={assistantNavAgentsLoaded}
          websitesLoaded={webItemsLoaded}
          chatNavAgentOptions={chatNavAgentOptions}
          copilotAgentOptions={copilotAgentOptions}
          chatDefaultAgentKey={chatRuntimeAgent.agentKey}
          desktopSsoStatus={desktopSsoStatus}
          desktopSsoBusy={desktopSsoBusy}
          bootstrapActive={chatRuntimeAgent.bootstrapActive}
          bootstrapAgentKey={normalizedBootstrapAgentKey}
          bootstrapChatId={assistantSettings?.bootstrapChatId}
          sidebarNavigationCanGoBack={sidebarNavigationHistory.back.length > 0}
          sidebarNavigationCanGoForward={sidebarNavigationHistory.forward.length > 0}
          onOpenAssistantDock={() => openAssistantDock()}
          onCloseAssistantDock={closeAssistantDock}
          onDesktopSsoLogin={handleDesktopSsoLogin}
          onDesktopSsoLogout={handleDesktopSsoLogout}
          onRefreshDesktopSsoStatus={refreshDesktopSsoStatus}
          onRefreshAssistantNavAgents={refreshAssistantNavAgents}
          onOpenAgentProjectEditor={openAgentProjectEditorFromSidebar}
          onOpenChatWorkPanel={openChatWorkPanelFromSidebar}
          onOpenChatHistory={openChatHistoryDialog}
          onCloseChatWorkPanel={closeChatWorkPanelWorkspace}
          onChatsDefaultAgentChange={saveChatsDefaultAgent}
          onRefreshCopilotAgentOptions={refreshCopilotAgentOptions}
          onCreateWebsiteItem={createWebsiteItem}
          onImportWebappItem={importWebappItem}
          onOpenWebappWindow={(item) => {
            void handleOpenWebappWindow(item);
          }}
          onOpenWebappWorkspace={(item) => {
            void handleOpenWebappWorkspace(item);
          }}
          onCloseWebItem={handleCloseWebEntry}
          onExportWebappItem={exportWebappItem}
          onRemoveWebappItem={removeWebappItem}
          onRequestNavigate={requestSidebarNavigation}
          onRequestAgentChatNavigate={requestNavigationWithAgentChatFocus}
          onSidebarNavigateBack={handleSidebarBackNavigation}
          onSidebarNavigateForward={handleSidebarForwardNavigation}
          onNavigateItem={undefined}
          onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
          onToggleCollapsed={toggleSidebarCollapsed}
          sidebarMode={sidebarMode}
          settingsSections={visibleSettingsSections}
          activeSettingsSectionId={activeSettingsSectionId}
          onSelectSettingsSection={handleSelectSettingsSection}
          onExitSecondarySidebarMode={handleExitSecondarySidebarMode}
        />
      </div>
      <div
        className={[
          "app-sidebar-resizer",
          isSecondarySidebarMode ? "is-disabled" : "",
          isSidebarResizing ? "is-active" : ""
        ].filter(Boolean).join(" ")}
        role="separator"
        aria-label={t("nav.sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_EXPANDED_MAX_WIDTH}
        aria-valuenow={renderedSidebarWidth}
        aria-hidden={isSecondarySidebarMode ? true : undefined}
        aria-disabled={isSecondarySidebarMode ? true : undefined}
        onPointerDown={isSecondarySidebarMode ? undefined : handleSidebarResizerPointerDown}
      >
        <span className="app-sidebar-resizer-line" aria-hidden="true" />
      </div>
      <div ref={appContentRef} className="app-content">
        <main className="app-main">
          <ServiceWebviewSurfaceHost
            activeServiceId={activeServiceId}
            activeAgentWebclientRoute={activeEmbeddedAgentWebclientRoute}
            activeOwnerChatId={activeChatWorkPanelChatId}
            agentChatFocusRequestId={activeAgentChatFocusRequestId}
            hostTheme={resolvedTheme}
            mountedServiceIds={mountedServiceIds}
            onAgentChatFocusRequestHandled={handleAgentChatFocusRequestHandled}
          />
          <BuiltinBrowserSurfaceHost
            active={usesBuiltinBrowserSurface}
            mounted={shouldMountBuiltinBrowserSurface}
            onCloseSurface={() => {
              setBuiltinBrowserSurfaceMounted(false);
              requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
            }}
            assistantDockOpen={assistantCopilotOpen}
            onOpenAssistantDock={() => openAssistantDock()}
            onCloseAssistantDock={closeAssistantDock}
          />
          <WebSurfaceHost
            activeEntryKey={activeWebEntryKey}
            itemMap={webItemMap}
            mountedEntryKeys={mountedWebEntryKeys}
            onCloseWebItem={(entryKey) => {
              const item = webItemMap.get(entryKey);
              if (item) {
                void handleCloseWebEntry(item);
              }
            }}
            onWebsiteFaviconDiscovered={handleWebsiteFaviconDiscovered}
            assistantDockOpen={assistantCopilotOpen}
            onOpenAssistantDock={() => openAssistantDock()}
            onCloseAssistantDock={closeAssistantDock}
          />
          <Routes>
            <Route
              path="/"
              element={<EmptyContentSurface />}
            />
            <Route
              path="/kanban"
              element={
                !kanbanSettingsLoaded
                  ? null
                  : !kanbanEnabled
                    ? <Navigate to="/control-center" replace />
                    : <RouteSuspense><KanbanPage hostTheme={resolvedTheme} /></RouteSuspense>
              }
            />
            <Route path="/control-center" element={<Navigate to={buildSettingsSectionPath("control")} replace />} />
            <Route
              path="/settings"
              element={<Navigate to={getDefaultSettingsSectionPath(visibleSettingsSectionIds)} replace />}
            />
            <Route
              path="/settings/:sectionId"
              element={
                <RouteSuspense>
                  <SettingsPage
                    themeMode={themeMode}
                    onThemeModeChange={handleThemeModeChange}
                    isMac={isMac}
                    isWindows={isWindows}
                    sidebarNavOrder={normalizedSidebarNavOrder}
                    availableSidebarNavOrderItems={availableSidebarNavOrderItems}
                    onSidebarNavOrderChange={setSidebarNavOrder}
                    marketEnabled={marketEnabled}
                    onMarketEnabledChange={setMarketEnabled}
                    webItems={webItems}
                    onWebItemsRefresh={refreshWebItems}
                    onWebappRuntimeStateChange={handleSettingsWebappRuntimeStateChange}
                    onAssistantSettingsChange={setAssistantSettings}
                    debugVisible={debugSettingsUnlocked}
                    onCloseDebug={handleCloseDebugSettings}
                  />
                </RouteSuspense>
              }
            />
            <Route
              path="/assistant"
              element={<Navigate to={ASSISTANT_TARGET_PATH} replace />}
            />
            <Route
              path={LEGACY_AGENT_WEBCLIENT_SERVICE_PATH}
              element={<LegacyAgentWebclientServiceRouteRedirect />}
            />
            {AGENT_WEBCLIENT_ROUTE_DEFINITIONS.map((routeDefinition) => (
              <Route
                key={routeDefinition.key}
                path={routeDefinition.routePath}
                element={null}
              />
            ))}
            {AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS.map((routePattern) => (
              <Route
                key={routePattern}
                path={routePattern}
                element={null}
              />
            ))}
            <Route
              path="/external/:itemId"
              element={
                <ExternalItemRoute
                  itemMap={experimentalItemMap}
                  onCloseSurface={() => requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE)}
                  assistantDockOpen={assistantCopilotOpen}
                  onOpenAssistantDock={() => openAssistantDock()}
                  onCloseAssistantDock={closeAssistantDock}
                />
              }
            />
            <Route path={BUILTIN_BROWSER_ROUTE} element={null} />
            <Route path={EMPTY_WEB_SURFACE_ROUTE} element={<EmptyWebSurfaceRoute />} />
            <Route path="/webs/:entryKey" element={<WebRouteFallback itemMap={webItemMap} />} />
            <Route path="/service/:serviceId" element={null} />
            <Route path="/plugin/:pluginId" element={null} />
            <Route path="/plugin-settings/:pluginId" element={<RouteSuspense><PluginSettingsPage hostTheme={resolvedTheme} /></RouteSuspense>} />
            <Route
              path="/market"
              element={
                !marketSettingsLoaded
                  ? null
                  : marketEnabled
                    ? <RouteSuspense><FunctionalMarketPage /></RouteSuspense>
                    : <Navigate to="/control-center" replace />
              }
            />
            <Route path="/help" element={<RouteSuspense><HelpPage hostTheme={resolvedTheme} /></RouteSuspense>} />
          </Routes>
        </main>
        {activeChatWorkPanelVisible ? (
          <div
            className={`chat-work-panel-resizer${isWorkPanelResizing ? " is-active" : ""}`}
            role="separator"
            aria-label={t("chatWorkPanel.resize")}
            aria-orientation="vertical"
            aria-valuemin={WORK_PANEL_MIN_WIDTH}
            aria-valuemax={workPanelMaxWidth}
            aria-valuenow={renderedWorkPanelWidth}
            tabIndex={0}
            onKeyDown={handleWorkPanelResizerKeyDown}
            onPointerDown={handleWorkPanelResizerPointerDown}
          >
            <span className="chat-work-panel-resizer-line" aria-hidden="true" />
          </div>
        ) : null}
        <WorkPanelHost
          activeChatId={activeChatWorkPanelVisible ? activeChatWorkPanelChatId : null}
          state={workPanelState}
          dispatchCommand={dispatchWorkPanelCommand}
          fullscreenOwnerChatId={workPanelFullscreenOwnerChatId}
          onFullscreenChange={changeWorkPanelFullscreen}
          hasPanelToggle={activeChatWorkPanelVisible && showMainChatWorkPanelToggle}
          isMac={isMac}
          isWindows={isWindows}
        />
      </div>
      {isSidebarResizing || isWorkPanelResizing || isCopilotDockResizing ? (
        <div
          className={isCopilotDockResizing
            ? "copilot-dock-resize-overlay"
            : isWorkPanelResizing
              ? "chat-work-panel-resize-overlay"
              : "app-sidebar-resize-overlay"}
          aria-hidden="true"
        />
      ) : null}
      <AgentWebclientCopilotDock
        open={assistantCopilotOpen}
        hostTheme={resolvedTheme}
        nativeDialogVisible={copilotDockNativeDialogVisible}
        openRequest={currentAssistantDockOpenRequest}
        restoredEmbedPath={currentCopilotSession?.embedPath ?? ""}
        parentSurfaceId={currentCopilotParentSurfaceId}
        resolvedAgentKey={resolvedCopilotAgentKey}
        resize={assistantCopilotOpen && !copilotDockOverlayMode ? {
          active: isCopilotDockResizing,
          minWidth: COPILOT_DOCK_MIN_WIDTH,
          maxWidth: copilotDockMaxWidth,
          width: renderedCopilotDockWidth,
          onKeyDown: handleCopilotDockResizerKeyDown,
          onPointerDown: handleCopilotDockResizerPointerDown,
        } : undefined}
        onClose={closeAssistantDock}
        onRunningRunIdChange={setAssistantRunningRunId}
        onSelectedAgentKeyChange={handleCopilotSelectedAgentKeyChange}
        onCurrentEmbedPathChange={handleCopilotCurrentEmbedPathChange}
      />
      <EnterpriseChatFloatingPanel desktopSsoStatus={desktopSsoStatus} />
      <ProjectFloatingWebviews
        entries={projectFloatingWebviews}
        hostTheme={resolvedTheme}
        isMac={isMac}
        isWindows={isWindows}
        windowFullScreen={windowFullScreen}
        onBringToFront={bringProjectFloatingWebviewToFront}
        onClose={closeProjectFloatingWebview}
      />
      {desktopSsoLoginDialog ? (
        <div className="desktop-sso-login-modal-layer" role="presentation">
          <section
            className="desktop-sso-login-modal"
            role="dialog"
            aria-modal="true"
            aria-label={desktopSsoLoginDialog.label}
          >
            <header className="desktop-sso-login-modal-head">
              <strong>
                {desktopSsoLoginSettled ? t("sidebar.sso.resultTitle") : desktopSsoLoginDialog.label}
              </strong>
              <button
                type="button"
                className="desktop-sso-login-modal-close"
                aria-label={desktopSsoLoginSettled ? t("sidebar.sso.closeResult") : t("sidebar.sso.cancelLogin")}
                title={desktopSsoLoginSettled ? t("sidebar.sso.closeResult") : t("sidebar.sso.cancelLogin")}
                onClick={() => void handleDesktopSsoLoginDialogClose()}
              >
                <span aria-hidden="true">x</span>
              </button>
            </header>
            <div className="desktop-sso-login-modal-frame">
              {desktopSsoLoginSettled && desktopSsoStatus ? (
                <div className="desktop-sso-login-result" role="status">
                  <div className="desktop-sso-login-result-copy">
                    <strong>{desktopSsoStatus.message}</strong>
                    {desktopSsoStatus.error ? <p>{desktopSsoStatus.error}</p> : null}
                  </div>
                  <div className="desktop-sso-login-result-steps">
                    {([
                      ["session", t("sidebar.sso.sessionStep")],
                      ["userInfo", t("sidebar.sso.userInfoStep")],
                      ["accessToken", t("sidebar.sso.accessTokenStep")]
                    ] as const).map(([step, label]) => {
                      const completed = desktopSsoStatus.completedSteps[step];
                      return (
                        <div className="desktop-sso-login-result-step" key={step}>
                          <span>{label}</span>
                          <span className={completed ? "is-complete" : "is-incomplete"}>
                            {completed ? t("sidebar.sso.stepReady") : t("sidebar.sso.stepNotReady")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="desktop-sso-login-result-actions">
                    <button type="button" onClick={() => void handleDesktopSsoLogin()}>
                      {t("sidebar.sso.retry")}
                    </button>
                    <button type="button" onClick={() => void handleDesktopSsoLoginDialogClose()}>
                      {t("sidebar.sso.closeResult")}
                    </button>
                  </div>
                </div>
              ) : createElement("webview", {
                  key: `${desktopSsoLoginDialog.partition}:${desktopSsoLoginDialog.url}`,
                  src: desktopSsoLoginDialog.url,
                  title: desktopSsoLoginDialog.label,
                  className: "desktop-sso-login-webview",
                  partition: desktopSsoLoginDialog.partition,
                  useragent: desktopSsoLoginDialog.userAgent,
                  style: { width: "100%", height: "100%", border: "none" }
                })}
            </div>
          </section>
        </div>
      ) : null}
      {showStartupCard ? (
        <StartupLoadingScreen
          version={desktopAppVersion}
          servicesLoading={servicesLoading}
          servicesError={servicesError}
          startupServices={startupServices}
          startupRestoreState={resolvedStartupRestoreState}
          timedOut={startupTimedOut}
          onRefresh={() => {
            setStartupCardDismissed(false);
            void refreshServices();
            void refreshStartupRestoreState().catch(() => undefined);
          }}
          onOpenControlCenter={() => {
            setStartupCardDismissed(true);
            setStartupTimedOut(false);
            navigate("/control-center", {
              replace: true,
              state: resolvedStartupRestoreState.phase === "failed"
                ? {
                    startupFailure: {
                      serviceId: resolvedStartupRestoreState.failedServiceId,
                      message: resolvedStartupRestoreState.message
                    }
                  }
                : undefined
            });
          }}
        />
      ) : null}
      {resolvedStartupRestoreState.phase === "env-import-required" ? (
        <EnvImportOverlay
          errorMessage={envImportError || resolvedStartupRestoreState.message}
          busy={envImportBusy}
          request={resolvedStartupRestoreState.envImportRequest}
          onImport={handleEnvImport}
        />
      ) : null}
      <DesktopActionConfirmationDialog
        request={desktopActionConfirmation}
        onDecision={handleDesktopActionConfirmationDecision}
      />
      {chatHistoryDialog ? (
        <ChatHistoryDialog
          key={chatHistoryDialog.id}
          agentKey={chatHistoryDialog.agentKey}
          agents={assistantNavAgents}
          isMac={isMac}
          isWindows={isWindows}
          onClose={() => setChatHistoryDialog(null)}
          onOpenChat={openChatFromHistoryDialog}
          onChatRemoved={handleHistoryChatRemoved}
        />
      ) : null}
      <DesktopGlobalSearchOverlay
        open={globalSearchOpen}
        agents={assistantNavAgents}
        currentRoute={currentRoute}
        defaultChatAgentKey={chatRuntimeAgent.agentKey}
        shortcutPlatform={isMac ? "darwin" : isWindows ? "win32" : null}
        t={t}
        onClose={() => setGlobalSearchOpen(false)}
        onOpenHistory={() => openChatHistoryDialog()}
        onNavigate={requestNavigationWithAgentChatFocus}
      />
      <DesktopShutdownOverlay progress={shutdownProgress} version={desktopAppVersion} t={t} />
      </div>
    </DebugModeContext.Provider>
  );
}

function resolveServiceSurfaceRouteId(pathname: string) {
  return matchPath("/service/:serviceId", pathname)?.params.serviceId ??
    matchPath("/plugin/:pluginId", pathname)?.params.pluginId ??
    null;
}

function readAgentRouteInfo(route: string) {
  try {
    const url = new URL(route, "http://desktop.local");
    const match = url.pathname.match(/^\/agent\/([^/]+)$/);
    return {
      agentKey: decodeRoutePathSegment(match?.[1]) ?? "",
      chatId: url.searchParams.get("chatId")?.trim() ?? "",
    };
  } catch {
    return { agentKey: "", chatId: "" };
  }
}

function resolveNavigationPathname(targetPath: string) {
  try {
    return new URL(targetPath, "http://desktop.local").pathname;
  } catch {
    return "";
  }
}

function resolveNavigationRoute(targetPath: string) {
  try {
    const targetUrl = new URL(targetPath, "http://desktop.local");
    return `${targetUrl.pathname}${targetUrl.search}`;
  } catch {
    return "";
  }
}

function createAgentNewChatRoute(agentKey: string) {
  const params = new URLSearchParams();
  params.set("newChat", String(Date.now()));
  return createAgentWebclientAgentPath(agentKey, params);
}

function createAgentChatRoute(agentKey: string, chatId: string) {
  return createAgentWebclientRoute({ agentKey, chatId });
}

function resolveAgentWebclientRoute(
  pathname: string,
  search = "",
  copilotAgentOptions: AssistantNavAgentItem[] = []
): AgentWebclientResolvedRoute | null {
  const copilotRoute = resolveCopilotAgentWebclientRoute(pathname, search, copilotAgentOptions);
  if (copilotRoute) {
    return copilotRoute;
  }

  const staticRoute = findAgentWebclientRouteDefinition(pathname);
  if (staticRoute) {
    return staticRoute;
  }

  const skillManagementRoute = resolveSkillManagementWebclientRoute(pathname, search);
  if (skillManagementRoute) {
    return skillManagementRoute;
  }

  const agentManagementRoute = resolveAgentManagementWebclientRoute(pathname, search);
  if (agentManagementRoute) {
    return agentManagementRoute;
  }

  const agentRoute = resolveSingleAgentWebclientRoute(pathname, search);
  if (agentRoute) {
    return agentRoute;
  }

  if (pathname !== LEGACY_AGENT_WEBCLIENT_SERVICE_PATH) {
    return null;
  }

  const embedPath = readAgentWebclientRouteEmbedPath(search);
  if (!embedPath) {
    return null;
  }

  return {
    key: "assistant-target",
    routePath: `${LEGACY_AGENT_WEBCLIENT_SERVICE_PATH}${search}`,
    embedPath,
    labelKey: embedPath.startsWith("/agent/") ? "nav.assistants" : "nav.agents",
    kind: embedPath.startsWith("/agent/") ? "chat" : embedPath.startsWith("/copilot") ? "copilot" : "management",
    mode: "embedded"
  };
}

function readAgentWebclientRouteEmbedPath(search: string) {
  try {
    return new URLSearchParams(search).get("embedPath")?.trim() ?? "";
  } catch {
    return "";
  }
}

function isBareAgentWebclientServiceRoute(pathname: string, search: string) {
  return pathname === LEGACY_AGENT_WEBCLIENT_SERVICE_PATH && !readAgentWebclientRouteEmbedPath(search);
}

function isSingleAgentWebclientRoute(pathname: string) {
  return Boolean(matchPath("/agent/:agentKey", pathname));
}

function resolveSkillManagementWebclientRoute(pathname: string, search: string): AgentWebclientResolvedRoute | null {
  const match = matchPath("/skills/:skillKey", pathname);
  const encodedSkillKey = match?.params.skillKey?.trim() ?? "";
  const skillKey = decodeRoutePathSegment(encodedSkillKey);
  if (!skillKey) {
    return null;
  }

  return {
    key: "skills",
    routePath: `${pathname}${search}`,
    embedPath: `/skills/${encodeURIComponent(skillKey)}${search}`,
    labelKey: "nav.skills",
    kind: "management",
    mode: "embedded"
  };
}

function resolveAgentManagementWebclientRoute(pathname: string, search: string): AgentWebclientResolvedRoute | null {
  const match = matchPath("/agents/:agentKey", pathname);
  const encodedAgentKey = match?.params.agentKey?.trim() ?? "";
  const agentKey = decodeRoutePathSegment(encodedAgentKey);
  if (!agentKey) {
    return null;
  }

  return {
    key: "agents",
    routePath: `${pathname}${search}`,
    embedPath: createAgentWebclientManagementPath(agentKey, search),
    labelKey: "nav.agents",
    kind: "management",
    mode: "embedded"
  };
}

function isCopilotAgentWebclientRoute(pathname: string) {
  return pathname === "/copilot" || Boolean(matchPath("/copilot/:agentKey", pathname));
}

function getFirstCopilotAgentKey(copilotAgentOptions: AssistantNavAgentItem[]) {
  return copilotAgentOptions.find((agent) => agent.agentKey.trim())?.agentKey.trim() ?? "";
}

function resolveCopilotAgentWebclientRoute(
  pathname: string,
  search: string,
  copilotAgentOptions: AssistantNavAgentItem[]
): AgentWebclientResolvedRoute | null {
  const firstAgentKey = getFirstCopilotAgentKey(copilotAgentOptions);
  const match = matchPath("/copilot/:agentKey", pathname);
  const encodedRequestedAgentKey = match?.params.agentKey?.trim() ?? "";
  const requestedAgentKey = decodeRoutePathSegment(encodedRequestedAgentKey) ?? "";

  if (pathname !== "/copilot" && !requestedAgentKey) {
    return null;
  }

  const matchedAgentKey = requestedAgentKey && copilotAgentOptions.some((agent) => agent.agentKey === requestedAgentKey)
    ? requestedAgentKey
    : "";
  const targetAgentKey = matchedAgentKey || firstAgentKey || requestedAgentKey;
  const targetPath = createAgentWebclientCopilotPath(targetAgentKey, search);

  return {
    key: "copilot",
    routePath: `${pathname}${search}`,
    embedPath: targetPath,
    labelKey: "nav.assistants",
    kind: "copilot",
    mode: "embedded"
  };
}

function resolveSingleAgentWebclientRoute(pathname: string, search: string): AgentWebclientResolvedRoute | null {
  const match = matchPath("/agent/:agentKey", pathname);
  const encodedAgentKey = match?.params.agentKey?.trim() ?? "";
  const agentKey = decodeRoutePathSegment(encodedAgentKey);
  if (!agentKey) {
    return null;
  }

  const businessSearch = createAgentWebclientBusinessSearch(search);
  return {
    key: "agent-chat",
    routePath: `${pathname}${search}`,
    embedPath: createAgentWebclientAgentPath(agentKey, businessSearch),
    labelKey: "service.display.agentWebclient",
    kind: "chat",
    mode: "embedded"
  };
}

function isWebEntryKey(value: string): value is WebEntryKey {
  return value.startsWith("website:") || value.startsWith("webapp:");
}

function resolveWebRouteEntryKey(pathname: string): WebEntryKey | null {
  const entryKey = matchPath("/webs/:entryKey", pathname)?.params.entryKey ?? "";
  return isWebEntryKey(entryKey) ? entryKey : null;
}
