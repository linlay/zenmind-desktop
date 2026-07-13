import { createElement, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from "react-router-dom";
import { AppSidebar } from "./navigation/AppSidebar";
import type { WebsiteFaviconCache } from "../components/Favicon";
import { DesktopGlobalSearchOverlay } from "./search/DesktopGlobalSearchOverlay";
import { DesktopActionConfirmationDialog } from "./DesktopActionConfirmationDialog";
import { BuiltinBrowserSurfaceHost, EmptyWebSurfaceRoute, WebRouteFallback, WebSurfaceHost, ExternalItemRoute, PluginSurfaceHost } from "./embedded-surfaces/EmbeddedSurfaceHosts";
import { StartupLoadingScreen, StartupRoutePlaceholder } from "./startup/StartupGate";
import { EnvImportOverlay } from "./startup/EnvImportOverlay";
import { AgentWebclientCopilotDock } from "../copilot/sidebar-copilot/AgentWebclientCopilotDock";
import { DebugModeContext } from "../debug/DebugModeContext";
import { useServices } from "../services/ServicesContext";
import { getAssistantPageContext } from "../copilot/page-context/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "../services/currentPageContext";
import {
  registerDesktopActionProviderForScope,
  setDesktopActionTranslator,
  startDesktopActionRendererBridge
} from "../services/desktopActionRegistry";
import type { AssistantNavAgentItem, AssistantNavAgentItemsResult, AssistantSettingsPublic, AssistantWorkerOpenRequest, DesktopActionConfirmationDecision, DesktopActionConfirmationRequest, DesktopSsoEmbeddedLoginRequest, DesktopSsoStatus, ServiceId, StartupRestoreState, WebappDeleteResult, WebappEntry, WebappImportResult, WebEntry, WebEntryKey, WebappRuntimeState, WebsiteEntry, WebsiteInput, WebsiteResult } from "../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_SHORTCUT,
  DESKTOP_COPILOT_PAGE_KEYS,
  normalizeQuickAssistantShortcut,
  type DesktopCopilotPageKey
} from "../../shared/assistant-settings";
import {
  resolveDesktopCopilotPreference,
  sanitizeDesktopCopilotPagePreferences
} from "../../shared/page-copilot";
import { shouldShowStartupProgressCard } from "../../shared/startup-gate";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../shared/browser-surfaces";
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
} from "../assistantNavigation";
import {
  AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS,
  AGENT_WEBCLIENT_ROUTE_DEFINITIONS,
  AGENT_WEBCLIENT_SERVICE_ID,
  AGENT_WEBCLIENT_TARGET_PATH,
  findAgentWebclientRouteDefinition,
  isEmbeddedAgentWebclientRoute,
  type AgentWebclientResolvedRoute
} from "../../shared/agent-webclient-routes";
import { I18N_KEYS, isSupportedLocale, type SupportedLocale, type TranslationKey } from "../../shared/i18n";

type ThemePreference = "light" | "dark" | "system";
type ResolvedThemeMode = "light" | "dark";
type WebappRuntimeViewState = {
  status: "idle" | "starting" | "running" | "error";
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
const SETTINGS_SIDEBAR_WIDTH = 200;
const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
const LEGACY_AGENT_WEBCLIENT_SERVICE_PATH = "/service/agent-webclient";
const SIDEBAR_NAVIGATION_LOCK_MS = 900;
const STARTUP_SERVICE_IDS = ["identity-center", "agent-platform", "agent-webclient"] as const;
const STARTUP_LOADING_TIMEOUT_MS = 45000;

const STARTUP_STATUS_REFRESH_MS = 1500;

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function LegacyAgentWebclientServiceRouteRedirect() {
  const location = useLocation();
  const embedPath = readAgentWebclientRouteEmbedPath(location.search);
  return embedPath ? null : <Navigate to={ASSISTANT_TARGET_PATH} replace />;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readSettingsPatch(args: Record<string, unknown>) {
  const patch = asRecord(args.patch);
  return Object.keys(patch).length > 0 ? patch : args;
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
    message,
    error: "Desktop SSO preload API unavailable.",
    updatedAt: new Date().toISOString()
  };
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

function getSettingsExitFallbackPath(kanbanEnabled: boolean) {
  return kanbanEnabled ? "/kanban" : ASSISTANT_TARGET_PATH;
}

function resolveSettingsExitTargetPath(targetPath: string, kanbanEnabled: boolean) {
  const fallbackPath = getSettingsExitFallbackPath(kanbanEnabled);
  const targetPathname = targetPath.split("?")[0] || "/";
  if (
    !targetPath ||
    isSettingsRedirectRoute(targetPath) ||
    matchSettingsRoute(targetPathname) ||
    (!kanbanEnabled && isKanbanNavigationPath(targetPath))
  ) {
    return fallbackPath;
  }
  return targetPath;
}

function removeSettingsRoutesFromHistory(history: string[]) {
  return history.filter((item) => !matchSettingsRoute(item.split("?")[0] || "/"));
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

function getDesktopCopilotPageLabel(pageKey: DesktopCopilotPageKey, t: ReturnType<typeof useI18n>["t"]) {
  switch (pageKey) {
    case "controlCenter":
      return t("nav.controlCenter");
    case "market":
      return t("nav.market");
    case "help":
      return t("nav.help");
    case "agents":
      return t("nav.agents");
    case "schedules":
      return t("nav.schedules");
    case "skills":
      return t("nav.skills");
  }
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
  const windowDragEndRef = useRef<(() => void) | null>(null);
  const assistantDockOpenRequestPathRef = useRef<string | null>(null);
  const bootstrapInitialNavigationDoneRef = useRef(false);
  const bootstrapHandoffNavigationDoneRef = useRef(false);
  const lastNonSettingsRouteRef = useRef("/kanban");
  const aboutSettingsClickCountRef = useRef(0);
  const refreshServicesRef = useRef(refreshServices);
  const assistantNavAgentsRefreshIdRef = useRef(0);
  const chatDefaultAgentMigrationRef = useRef("");
  const [desktopPlatform, setDesktopPlatform] = useState(inferDesktopPlatform);
  const [windowFullScreen, setWindowFullScreen] = useState(false);
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
  const [assistantDockOpenPath, setAssistantDockOpenPath] = useState<string | null>(null);
  const [assistantDockOpenRequest, setAssistantDockOpenRequest] = useState<AssistantWorkerOpenRequest | null>(null);
  const [assistantRunningRunId, setAssistantRunningRunId] = useState<string | null>(null);
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [assistantNavAgents, setAssistantNavAgents] = useState<AssistantNavAgentItem[]>([]);
  const [assistantNavAgentsLoaded, setAssistantNavAgentsLoaded] = useState(false);
  const [chatNavAgentOptions, setChatNavAgentOptions] = useState<AssistantNavAgentItem[]>([]);
  const chatRuntimeAgent = useMemo(
    () => resolveAssistantNavChatRuntimeAgent(chatNavAgentOptions, {
      defaultChatAgentKey: assistantSettings?.chatDefaultAgentKey,
      bootstrapAgentKey: assistantSettings?.bootstrapAgentKey,
    }),
    [
      assistantSettings?.bootstrapAgentKey,
      assistantSettings?.chatDefaultAgentKey,
      chatNavAgentOptions,
    ],
  );
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [desktopActionConfirmation, setDesktopActionConfirmation] =
    useState<DesktopActionConfirmationRequest | null>(null);
  const [copilotAgentOptions, setCopilotAgentOptions] = useState<AssistantNavAgentItem[]>([]);
  const [nativeDialogVisible, setNativeDialogVisible] = useState(false);
  const [desktopSsoStatus, setDesktopSsoStatus] = useState<DesktopSsoStatus | null>(null);
  const [desktopSsoBusy, setDesktopSsoBusy] = useState(false);
  const [desktopSsoLoginDialog, setDesktopSsoLoginDialog] = useState<DesktopSsoEmbeddedLoginRequest | null>(null);
  const [webItems, setWebItems] = useState<WebEntry[]>([]);
  const [webItemsLoaded, setWebItemsLoaded] = useState(false);
  const [webappRuntimeById, setWebappRuntimeById] = useState<Record<string, WebappRuntimeViewState>>({});
  const [faviconCache, setFaviconCache] = useState<WebsiteFaviconCache>({});
  const webItemsRef = useRef<WebEntry[]>([]);
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
  const bareAgentWebclientServiceRoute = isBareAgentWebclientServiceRoute(location.pathname, location.search);
  const activePluginId = activeEmbeddedAgentWebclientRoute
    ? AGENT_WEBCLIENT_SERVICE_ID
    : bareAgentWebclientServiceRoute
      ? null
      : resolvePluginRouteId(location.pathname);
  const activeWebEntryKey = resolveWebRouteEntryKey(location.pathname);
  const [mountedPluginIds, setMountedPluginIds] = useState<string[]>(() =>
    activePluginId ? [activePluginId] : []
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
    location.pathname.startsWith("/webs/");
  const usesBuiltinBrowserSurface = location.pathname === BUILTIN_BROWSER_ROUTE;
  const shouldMountBuiltinBrowserSurface =
    location.pathname === EMPTY_WEB_SURFACE_ROUTE
      ? false
      : builtinBrowserSurfaceMounted || usesBuiltinBrowserSurface;
  const usesPluginSurface =
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
  const currentRoute = `${location.pathname}${location.search}`;
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

  useEffect(() => {
    const desktopShell = window.electronAPI.desktopShell;
    if (!desktopShell.getWindowState || !desktopShell.onWindowStateChanged) {
      return undefined;
    }

    let active = true;
    void desktopShell.getWindowState().then((result) => {
      if (active && result.ok) {
        setWindowFullScreen(result.isFullScreen);
      }
    }).catch(() => undefined);

    const unsubscribe = desktopShell.onWindowStateChanged((state) => {
      if (active) {
        setWindowFullScreen(state.isFullScreen);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
  const usesBrowserChromeSurface = usesBuiltinBrowserSurface || activeWebEntry?.kind === "website";
  const websiteAgentKey = activeWebEntry?.agentKey || "";
  const resolvedCopilotAgentKey = websiteAgentKey || currentCopilotPreference?.agentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const assistantLauncherVisible = currentCopilotPreference?.enabled !== false;
  const isAgentWebclientMainRoute =
    location.pathname === ASSISTANT_TARGET_PATH ||
    isSingleAgentWebclientRoute(location.pathname) ||
    isCopilotAgentWebclientRoute(location.pathname);
  const assistantDockOpen = assistantDockOpenPath !== null;
  const assistantCopilotOpen = assistantDockOpen && assistantDockOpenPath === location.pathname && !isAgentWebclientMainRoute;
  const sidebarCollapsed = sidebarState.mode === "collapsed";
  const renderedSidebarWidth = resolveRenderedSidebarWidth(sidebarState);
  const effectiveSidebarCollapsed = sidebarCollapsed && !isSettingsRoute;
  const effectiveSidebarWidth = isSettingsRoute ? SETTINGS_SIDEBAR_WIDTH : renderedSidebarWidth;
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
    }
    return result;
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

  async function removeWebappItem(item: WebEntry): Promise<WebappDeleteResult> {
    if (item.kind !== "webapp") {
      return {
        ok: false,
        item: null,
        items: [],
        message: t("webapp.notFound")
      };
    }

    const result = await window.electronAPI.webs.webapps.remove(item.id);
    if (result.ok) {
      if (activeWebEntryKey === item.entryKey) {
        requestSidebarNavigation(EMPTY_WEB_SURFACE_ROUTE);
      }
      setMountedWebEntryKeys((current) =>
        current.filter((entryKey) => entryKey !== item.entryKey)
      );
      setWebappRuntimeById((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
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
      setFaviconCache((prev) => {
        const current = prev[entryKey];
        if (
          current?.websiteUrl === websiteUrl &&
          current.faviconUrl === faviconUrl
        ) {
          return prev;
        }
        return {
          ...prev,
          [entryKey]: { websiteUrl, faviconUrl },
        };
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
      .update(websiteId, { agentKey: normalizedAgentKey })
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

  async function refreshAssistantNavAgents() {
    const refreshId = assistantNavAgentsRefreshIdRef.current + 1;
    assistantNavAgentsRefreshIdRef.current = refreshId;
    try {
      const result = await window.electronAPI.assistant.listNavigationAgents();
      if (assistantNavAgentsRefreshIdRef.current === refreshId) {
        if (!result.ok) {
          return;
        }
        const navigationItems = normalizeAssistantNavAgents(result.items);
        const nextItems = normalizeAssistantNavAgents(resolveAssistantNavDisplayItems(result));
        setAssistantNavAgentsLoaded(true);
        setChatNavAgentOptions(getChatNavigationAgentOptions(navigationItems));
        setAssistantNavAgents(nextItems);
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
      !assistantSettings
    ) {
      return;
    }

    const bootstrapAgentKey = assistantSettings.bootstrapAgentKey.trim();
    const bootstrapAgent = chatRuntimeAgent.agent;
    if (!chatRuntimeAgent.bootstrapActive || !bootstrapAgentKey || !bootstrapAgent) {
      return;
    }

    const bootstrapChatId = assistantSettings.bootstrapChatId.trim();
    const seedChatIndexed = Boolean(
      bootstrapChatId &&
      bootstrapAgent.recentChats.some((chat) => chat.chatId === bootstrapChatId),
    );
    const targetRoute = seedChatIndexed
      ? createAgentChatRoute(bootstrapAgentKey, bootstrapChatId)
      : createAgentNewChatRoute(bootstrapAgentKey);
    const currentRoute = `${location.pathname}${location.search}`;

    bootstrapInitialNavigationDoneRef.current = true;
    if (currentRoute !== targetRoute) {
      navigate(targetRoute, { replace: true });
    }
  }, [
    assistantNavAgentsLoaded,
    assistantSettings,
    chatRuntimeAgent,
    chatNavAgentOptions,
    location.pathname,
    location.search,
    navigate,
  ]);

  useEffect(() => {
    if (!assistantNavAgentsLoaded || !assistantSettings) {
      return;
    }
    if (bootstrapHandoffNavigationDoneRef.current) {
      return;
    }
    const bootstrapAgentKey = assistantSettings.bootstrapAgentKey.trim();
    const defaultChatAgentKey = assistantSettings.chatDefaultAgentKey.trim();
    if (
      !bootstrapAgentKey ||
      !defaultChatAgentKey ||
      bootstrapAgentKey === defaultChatAgentKey ||
      !chatRuntimeAgent.defaultAgentAvailable
    ) {
      return;
    }

    const route = readAgentRouteInfo(`${location.pathname}${location.search}`);
    if (
      route.agentKey !== bootstrapAgentKey
    ) {
      return;
    }

    bootstrapHandoffNavigationDoneRef.current = true;
    navigate(createAgentNewChatRoute(defaultChatAgentKey), { replace: true });
  }, [
    assistantNavAgentsLoaded,
    assistantSettings?.bootstrapAgentKey,
    assistantSettings?.chatDefaultAgentKey,
    chatRuntimeAgent.defaultAgentAvailable,
    location.pathname,
    location.search,
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
      assistantDockOpenRequestPathRef.current = location.pathname;
      setAssistantDockOpenRequest(request);
    } else {
      assistantDockOpenRequestPathRef.current = null;
      setAssistantDockOpenRequest(null);
    }
    setAssistantDockOpenPath(location.pathname);
  }

  function closeAssistantDock() {
    setAssistantDockOpenPath(null);
    setAssistantDockOpenRequest(null);
    assistantDockOpenRequestPathRef.current = null;
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
    setDesktopSsoBusy(true);
    try {
      const result = await ssoApi.startLogin();
      setDesktopSsoStatus(result.status);
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
    window.electronAPI.assistant.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setAssistantSettings(settings);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentCopilotPreference?.enabled === false && assistantDockOpenPath === location.pathname && !assistantRunningRunId) {
      setAssistantDockOpenPath(null);
      setAssistantDockOpenRequest(null);
      assistantDockOpenRequestPathRef.current = null;
    }
  }, [assistantDockOpenPath, assistantRunningRunId, currentCopilotPreference?.enabled, location.pathname]);

  useEffect(() => {
    if (
      assistantDockOpenPath &&
      !isAgentWebclientMainRoute &&
      assistantDockOpenPath !== location.pathname
    ) {
      setAssistantDockOpenPath(null);
      setAssistantDockOpenRequest(null);
      assistantDockOpenRequestPathRef.current = null;
    }
  }, [assistantDockOpenPath, isAgentWebclientMainRoute, location.pathname]);

  useEffect(() => {
    if (!assistantDockOpenRequest) {
      assistantDockOpenRequestPathRef.current = null;
      return;
    }

    if (
      assistantDockOpenRequestPathRef.current &&
      assistantDockOpenRequestPathRef.current !== location.pathname
    ) {
      setAssistantDockOpenRequest(null);
      assistantDockOpenRequestPathRef.current = null;
    }
  }, [assistantDockOpenRequest, location.pathname]);

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
      if (!status.pending) {
        setDesktopSsoLoginDialog(null);
      }
    });
    const disposeEmbeddedLoginOpen = ssoApi.onEmbeddedLoginOpen((request) => {
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
    return window.electronAPI.webs.onChanged(() => {
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
    const shouldPollStartup = startupRestoreState === null || showStartupCard;
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
  }, [showStartupCard, startupRestoreState]);

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

  useEffect(() => () => {
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarResizeStateRef.current = null;
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
    if (!activePluginId) {
      return;
    }

    setMountedPluginIds((current) =>
      current.includes(activePluginId) ? current : [...current, activePluginId]
    );
  }, [activePluginId]);

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
    if (!activeWebEntryKey) {
      return;
    }
    const item = webItems.find((candidate) => candidate.entryKey === activeWebEntryKey);
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
    if (event.button !== 0 || isSidebarResizing || isSettingsRoute) {
      return;
    }

    event.preventDefault();
    sidebarResizeStateRef.current = {
      initialState: sidebarState,
      startClientX: event.clientX
    };
    setIsSidebarResizing(true);
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

  function handleExitSettingsMode() {
    const targetPath = resolveSettingsExitTargetPath(
      lastNonSettingsRouteRef.current || getSettingsExitFallbackPath(kanbanEnabled),
      kanbanEnabled
    );
    if (targetPath === currentRoute) {
      return;
    }
    setSidebarNavigationHistory((current) => ({
      back: removeSettingsRoutesFromHistory(current.back),
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
    if (isSettingsRoute) {
      return;
    }
    lastNonSettingsRouteRef.current = resolveSettingsExitTargetPath(currentRoute, kanbanEnabled);
  }, [currentRoute, isSettingsRoute, kanbanEnabled]);

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
          id: service.id,
          label: getServiceDisplayName(service.id, service.name, t),
          url: service.healthMeta.webUrl,
          route: service.id === "agent-webclient"
            ? activeAgentWebclientRoute?.routePath ?? ASSISTANT_TARGET_PATH
            : `/service/${service.id}`,
          active: activePluginId === service.id
        }));

      return [
        {
          id: BUILTIN_BROWSER_SURFACE_ID,
          label: BUILTIN_BROWSER_SURFACE_LABEL,
          url: BUILTIN_BROWSER_DEFAULT_URL,
          route: BUILTIN_BROWSER_ROUTE,
          active: location.pathname === BUILTIN_BROWSER_ROUTE
        },
        ...[...webItemMap.entries()].map(([entryKey, item]) => ({
          id: entryKey,
          label: item.label,
          url: item.url,
          route: `/webs/${entryKey}`,
          active: activeWebEntryKey === entryKey
        })),
        ...serviceSurfaces
      ];
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

    const settingSectionIds = [
      "general",
      "appearance",
      "usage",
      "quick",
      "copilot",
      "pet",
      "kanban",
      "market",
      "control",
      "web",
      "about"
    ] as const;
    const writableSettingFields = [
      "general.deviceName",
      "appearance.themeMode",
      "appearance.locale",
      "quick.enabled",
      "quick.agentKey",
      "copilot.desktopCopilotPages",
      "pet.enabled",
      "pet.boundAgentKey",
      "pet.appearanceId",
      "web.websites.add",
      "web.websites.update",
      "web.websites.remove"
    ];
    const readonlySettingFields = [
      "general.preventSleepWhileRunning",
      "general.desktopActionConfirmationEnabled",
      "kanban.remoteControlEnabled",
      "kanban.deviceAlias",
      "market.enabled",
      "market.apiBaseUrl",
      "usage.*",
      "about.*",
      "control.*",
      "token",
      "secret",
      "apiKey"
    ];
    const supportedSettingSections = new Set<string>(settingSectionIds);
    const supportedSettingFields = new Map<string, Set<string>>([
      ["general", new Set(["deviceName", "preventSleepWhileRunning", "desktopActionConfirmationEnabled"])],
      ["appearance", new Set(["themeMode", "locale"])],
      ["usage", new Set(["*"])],
      ["quick", new Set(["enabled", "agentKey"])],
      ["copilot", new Set(["desktopCopilotPages"])],
      ["pet", new Set(["enabled", "boundAgentKey", "appearanceId"])],
      ["kanban", new Set(["remoteControlEnabled", "deviceAlias"])],
      ["market", new Set(["enabled", "apiBaseUrl"])],
      ["control", new Set(["*"])],
      ["web", new Set(["websites"])],
      ["about", new Set(["*"])]
    ]);

    function settingError(error: unknown) {
      return {
        message: error instanceof Error ? error.message : String(error)
      };
    }

    async function readSettingSection(read: () => Promise<Record<string, unknown>>) {
      try {
        return {
          ok: true,
          ...await read()
        };
      } catch (error) {
        return {
          ok: false,
          error: settingError(error)
        };
      }
    }

    function sanitizeKanbanCloudConfig(cloud: Record<string, unknown>) {
      const token = readString(cloud.token);
      return {
        serverUrl: readString(cloud.serverUrl),
        remoteControlEnabled: cloud.remoteControlEnabled === true,
        deviceAlias: readString(cloud.deviceAlias),
        hasToken: Boolean(token),
        tokenPreview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : ""
      };
    }

    function sanitizeTunnelHubSettings(settings: Record<string, unknown>) {
      return {
        enabled: settings.enabled === true,
        relayUrl: readString(settings.relayUrl),
        deviceId: readString(settings.deviceId),
        hasRelayToken: settings.hasRelayToken === true,
        relayTokenPreview: readString(settings.relayTokenPreview),
        publicHost: readString(settings.publicHost),
        publicUrl: readString(settings.publicUrl),
        webSocketUrl: readString(settings.webSocketUrl),
        tlsInsecureSkipVerify: false,
        reconnectSeconds: typeof settings.reconnectSeconds === "number" ? settings.reconnectSeconds : null
      };
    }

    function getWebsiteOperations(webPatch: Record<string, unknown>) {
      const websites = asRecord(webPatch.websites);
      const toRecordList = (value: unknown) => Array.isArray(value)
        ? value.map(asRecord).filter((item) => Object.keys(item).length > 0)
        : Object.keys(asRecord(value)).length > 0
          ? [asRecord(value)]
          : [];
      const toRemoveList = (value: unknown) => Array.isArray(value)
        ? value.map((item) => typeof item === "string" ? { id: item.trim() } : asRecord(item))
        : typeof value === "string"
          ? [{ id: value.trim() }]
          : Object.keys(asRecord(value)).length > 0
            ? [asRecord(value)]
            : [];
      return {
        add: toRecordList(websites.add),
        update: toRecordList(websites.update),
        remove: toRemoveList(websites.remove)
      };
    }

    function isValidWebsiteUrl(value: unknown) {
      const raw = readString(value);
      if (!raw) {
        return false;
      }
      try {
        const parsed = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }

    function hasAgentKey(agentOptions: Array<{ agentKey: string }>, agentKey: string) {
      return agentOptions.some((agent) => agent.agentKey === agentKey);
    }

    async function readSettingValidationState() {
      const [
        generalSettings,
        assistantSettingsResult,
        assistantAgentsResult,
        desktopPetStateResult,
        kanbanSettingsResult,
        kanbanListResult,
        webListResult
      ] = await Promise.all([
        window.electronAPI.settings.getGeneralSettings(),
        window.electronAPI.assistant.getSettings(),
        window.electronAPI.assistant.listAgents(),
        window.electronAPI.desktopPet.getState(),
        window.electronAPI.kanban.getSettings(),
        window.electronAPI.kanban.listIssues(),
        window.electronAPI.webs.list()
      ]);
      setAssistantSettings(assistantSettingsResult);
      return {
        generalSettings,
        assistantSettings: assistantSettingsResult,
        assistantAgents: assistantAgentsResult,
        desktopPet: desktopPetStateResult,
        kanbanSettings: kanbanSettingsResult,
        kanbanList: kanbanListResult,
        webList: webListResult
      };
    }

    async function readSettingsState(sectionFilter?: readonly string[]) {
      const requestedSections = sectionFilter && sectionFilter.length > 0
        ? settingSectionIds.filter((section) => sectionFilter.includes(section))
        : settingSectionIds;
      const sectionEntries = await Promise.all(requestedSections.map(async (section) => {
        switch (section) {
          case "general":
            return [section, await readSettingSection(async () => {
              const [settings, deviceInfo] = await Promise.all([
                window.electronAPI.settings.getGeneralSettings(),
                window.electronAPI.settings.getDesktopDeviceInfo()
              ]);
              return { settings, deviceInfo };
            })] as const;
          case "appearance":
            return [section, await readSettingSection(async () => ({
              themeMode,
              resolvedTheme,
              sidebarTranslucencyEnabled: true,
              locale,
              localeSettings: await window.electronAPI.settings.getLocale()
            }))] as const;
          case "usage":
            return [section, await readSettingSection(async () => {
              const [profile, ssoStatus] = await Promise.allSettled([
                window.electronAPI.settings.getUsageProfile(),
                window.electronAPI.sso.getStatus()
              ]);
              return {
                profile: profile.status === "fulfilled" ? profile.value : null,
                profileError: profile.status === "rejected" ? settingError(profile.reason) : null,
                ssoStatus: ssoStatus.status === "fulfilled" ? ssoStatus.value : null,
                ssoError: ssoStatus.status === "rejected" ? settingError(ssoStatus.reason) : null
              };
            })] as const;
          case "quick":
            return [section, await readSettingSection(async () => {
              const [settings, agentOptions] = await Promise.all([
                window.electronAPI.assistant.getSettings(),
                window.electronAPI.assistant.listAgents()
              ]);
              setAssistantSettings(settings);
              return {
                enabled: settings.quickAssistantEnabled,
                agentKey: settings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
                shortcut: normalizeQuickAssistantShortcut(settings.quickAssistantShortcut),
                configured: settings.configured,
                source: settings.source,
                sourceLabel: settings.sourceLabel,
                agentOptions
              };
            })] as const;
          case "copilot":
            return [section, await readSettingSection(async () => {
              const [settings, agentOptions] = await Promise.all([
                window.electronAPI.assistant.getSettings(),
                window.electronAPI.assistant.listAgents()
              ]);
              setAssistantSettings(settings);
              return {
                desktopCopilotPages: settings.desktopCopilotPages,
                agentOptions
              };
            })] as const;
          case "pet":
            return [section, await readSettingSection(async () => {
              const state = await window.electronAPI.desktopPet.getState();
              return {
                supported: state.supported,
                enabled: state.enabled,
                visible: state.visible,
                boundAgentKey: state.boundAgentKey,
                appearanceId: state.appearanceId,
                appearanceOptions: state.appearanceOptions,
                agentOptions: state.agentOptions,
                state
              };
            })] as const;
          case "kanban":
            return [section, await readSettingSection(async () => {
              const [settingsResult, issueResult] = await Promise.all([
                window.electronAPI.kanban.getSettings(),
                window.electronAPI.kanban.listIssues()
              ]);
              return {
                enabled: settingsResult.settings.enabled,
                cloud: sanitizeKanbanCloudConfig(asRecord(settingsResult.settings.cloud)),
                connectionState: settingsResult.connectionState ?? issueResult.connectionState ?? "disabled",
                projects: issueResult.projects ?? [],
                remoteControlEnabled: settingsResult.settings.cloud.remoteControlEnabled,
                deviceAlias: settingsResult.settings.cloud.deviceAlias ?? ""
              };
            })] as const;
          case "market":
            return [section, await readSettingSection(async () => ({
              settings: await window.electronAPI.market.getSettings()
            }))] as const;
          case "control":
            return [section, await readSettingSection(async () => {
              const [tunnel, desktopWs, ssoStatus] = await Promise.allSettled([
                window.electronAPI.settings.getTunnelHubSettings(),
                window.electronAPI.settings.getDesktopWsServerState(),
                window.electronAPI.sso.getStatus()
              ]);
              return {
                tunnel: tunnel.status === "fulfilled" ? sanitizeTunnelHubSettings(asRecord(tunnel.value)) : null,
                tunnelError: tunnel.status === "rejected" ? settingError(tunnel.reason) : null,
                desktopWs: desktopWs.status === "fulfilled" ? desktopWs.value : null,
                desktopWsError: desktopWs.status === "rejected" ? settingError(desktopWs.reason) : null,
                mobilePairing: { available: Boolean(window.electronAPI.settings.createAppPairingPayload) },
                ssoStatus: ssoStatus.status === "fulfilled" ? ssoStatus.value : null
              };
            })] as const;
          case "web":
            return [section, await readSettingSection(async () => {
              const result = await window.electronAPI.webs.list();
              if (result.ok) {
                updateWebItems(result.items);
              }
              return {
                ...result,
                items: result.items.map((item) => item.kind === "webapp"
                  ? {
                      ...item,
                      runtime: webappRuntimeById[item.id] ?? null
                    }
                  : item)
              };
            })] as const;
          case "about":
          default:
            return [section, await readSettingSection(async () => {
              const [appInfo, platform, dataRoot, deviceIdentity] = await Promise.all([
                window.electronAPI.settings.getAppInfo(),
                window.electronAPI.settings.getPlatform(),
                window.electronAPI.settings.getDataRoot(),
                window.electronAPI.settings.getDeviceIdentity()
              ]);
              return {
                appInfo,
                platform,
                dataRoot,
                deviceIdentity
              };
            })] as const;
        }
      }));
      return {
        sections: Object.fromEntries(sectionEntries),
        meta: {
          readAt: new Date().toISOString(),
          readableSections: settingSectionIds,
          writableFields: writableSettingFields,
          readonlyFields: readonlySettingFields
        }
      };
    }

    async function validateSettingsPatch(patch: Record<string, unknown>) {
      const state = await readSettingValidationState();
      const issues: Array<{ field: string; message: string; value?: unknown }> = [];

      function addIssue(field: string, message: string, value?: unknown) {
        issues.push({ field, message, ...(value === undefined ? {} : { value }) });
      }

      function validateObjectSection(section: string) {
        const sectionPatch = asRecord(patch[section]);
        if (hasOwn(patch, section) && Object.keys(sectionPatch).length === 0) {
          addIssue(section, `${section} must be an object.`, patch[section]);
        }
        return sectionPatch;
      }

      for (const section of Object.keys(patch)) {
        if (!supportedSettingSections.has(section)) {
          addIssue(section, `Unsupported setting section: ${section}.`, patch[section]);
          continue;
        }
        const fields = supportedSettingFields.get(section);
        const sectionPatch = asRecord(patch[section]);
        if (!fields?.has("*")) {
          for (const field of Object.keys(sectionPatch)) {
            if (!fields?.has(field)) {
              addIssue(`${section}.${field}`, `Unsupported setting field: ${section}.${field}.`, sectionPatch[field]);
            }
          }
        } else if (Object.keys(sectionPatch).length > 0) {
          addIssue(section, `${section} is read-only.`, patch[section]);
        }
      }

      const generalPatch = validateObjectSection("general");
      if (hasOwn(generalPatch, "deviceName") && typeof generalPatch.deviceName !== "string") {
        addIssue("general.deviceName", "general.deviceName must be a string.", generalPatch.deviceName);
      }
      for (const readonlyField of ["preventSleepWhileRunning", "desktopActionConfirmationEnabled"]) {
        if (hasOwn(generalPatch, readonlyField)) {
          addIssue(`general.${readonlyField}`, `general.${readonlyField} is read-only.`, generalPatch[readonlyField]);
        }
      }

      const appearancePatch = validateObjectSection("appearance");
      if (hasOwn(appearancePatch, "themeMode") && !isThemePreference(appearancePatch.themeMode)) {
        addIssue("appearance.themeMode", "appearance.themeMode must be light, dark, or system.", appearancePatch.themeMode);
      }
      if (hasOwn(appearancePatch, "locale") && !isSupportedLocale(appearancePatch.locale)) {
        addIssue("appearance.locale", "appearance.locale is not supported.", appearancePatch.locale);
      }

      const quickPatch = validateObjectSection("quick");
      if (hasOwn(quickPatch, "enabled") && typeof quickPatch.enabled !== "boolean") {
        addIssue("quick.enabled", "quick.enabled must be boolean.", quickPatch.enabled);
      }
      if (hasOwn(quickPatch, "agentKey")) {
        const agentKey = readString(quickPatch.agentKey);
        if (typeof quickPatch.agentKey !== "string") {
          addIssue("quick.agentKey", "quick.agentKey must be a string.", quickPatch.agentKey);
        } else if (agentKey && !hasAgentKey(state.assistantAgents, agentKey)) {
          addIssue("quick.agentKey", t("settings.navigation.helperAgentInvalid"), quickPatch.agentKey);
        }
      }

      const copilotPatch = validateObjectSection("copilot");
      if (hasOwn(copilotPatch, "desktopCopilotPages")) {
        const nextPages = sanitizeDesktopCopilotPagePreferences({
          ...state.assistantSettings.desktopCopilotPages,
          ...asRecord(copilotPatch.desktopCopilotPages)
        });
        if (Object.keys(asRecord(copilotPatch.desktopCopilotPages)).length === 0) {
          addIssue("copilot.desktopCopilotPages", "copilot.desktopCopilotPages must be an object.", copilotPatch.desktopCopilotPages);
        }
        for (const pageKey of DESKTOP_COPILOT_PAGE_KEYS) {
          const preference = nextPages[pageKey];
          if (preference.enabled && !hasAgentKey(state.assistantAgents, preference.agentKey)) {
            addIssue(
              `copilot.desktopCopilotPages.${pageKey}.agentKey`,
              t("settings.navigation.copilotAgentUnavailable", { page: getDesktopCopilotPageLabel(pageKey, t) }),
              preference.agentKey
            );
          }
        }
      }

      const petPatch = validateObjectSection("pet");
      if (hasOwn(petPatch, "enabled") && typeof petPatch.enabled !== "boolean") {
        addIssue("pet.enabled", "pet.enabled must be boolean.", petPatch.enabled);
      }
      if (hasOwn(petPatch, "boundAgentKey")) {
        const agentKey = readString(petPatch.boundAgentKey);
        if (typeof petPatch.boundAgentKey !== "string") {
          addIssue("pet.boundAgentKey", "pet.boundAgentKey must be a string.", petPatch.boundAgentKey);
        } else if (agentKey && !hasAgentKey(state.desktopPet.agentOptions, agentKey)) {
          addIssue("pet.boundAgentKey", t("settings.navigation.helperAgentInvalid"), petPatch.boundAgentKey);
        }
      }
      if (hasOwn(petPatch, "appearanceId")) {
        const appearanceId = readString(petPatch.appearanceId);
        if (!state.desktopPet.appearanceOptions.some((appearance) => appearance.id === appearanceId)) {
          addIssue("pet.appearanceId", t("settings.desktopPet.enableUnavailable"), petPatch.appearanceId);
        }
      }

      const kanbanPatch = validateObjectSection("kanban");
      for (const readonlyField of ["remoteControlEnabled", "deviceAlias"]) {
        if (hasOwn(kanbanPatch, readonlyField)) {
          addIssue(`kanban.${readonlyField}`, `kanban.${readonlyField} is read-only.`, kanbanPatch[readonlyField]);
        }
      }

      const marketPatch = validateObjectSection("market");
      for (const readonlyField of ["enabled", "apiBaseUrl"]) {
        if (hasOwn(marketPatch, readonlyField)) {
          addIssue(`market.${readonlyField}`, `market.${readonlyField} is read-only.`, marketPatch[readonlyField]);
        }
      }

      for (const readonlySection of ["usage", "about", "control"]) {
        if (hasOwn(patch, readonlySection)) {
          addIssue(readonlySection, `${readonlySection} is read-only.`, patch[readonlySection]);
        }
      }

      const webPatch = validateObjectSection("web");
      const websiteOperations = getWebsiteOperations(webPatch);
      if (hasOwn(webPatch, "websites")) {
        const websitesPatch = asRecord(webPatch.websites);
        if (Object.keys(websitesPatch).length === 0) {
          addIssue("web.websites", "web.websites must be an object.", webPatch.websites);
        }
        for (const field of Object.keys(websitesPatch)) {
          if (!["add", "update", "remove"].includes(field)) {
            addIssue(`web.websites.${field}`, `Unsupported setting field: web.websites.${field}.`, websitesPatch[field]);
          }
        }
      }
      for (const item of websiteOperations.add) {
        if (!isValidWebsiteUrl(item.url)) {
          addIssue("web.websites.add.url", "web.websites.add.url must be a valid URL or hostname.", item.url);
        }
        const agentKey = readString(item.agentKey);
        if (agentKey && !hasAgentKey(state.assistantAgents, agentKey)) {
          addIssue("web.websites.add.agentKey", t("settings.navigation.helperAgentInvalid"), item.agentKey);
        }
      }
      for (const item of websiteOperations.update) {
        if (!readString(item.id)) {
          addIssue("web.websites.update.id", "web.websites.update.id is required.", item.id);
        }
        if (hasOwn(item, "url") && !isValidWebsiteUrl(item.url)) {
          addIssue("web.websites.update.url", "web.websites.update.url must be a valid URL or hostname.", item.url);
        }
        const agentKey = readString(item.agentKey);
        if (agentKey && !hasAgentKey(state.assistantAgents, agentKey)) {
          addIssue("web.websites.update.agentKey", t("settings.navigation.helperAgentInvalid"), item.agentKey);
        }
      }
      for (const item of websiteOperations.remove) {
        if (!readString(item.id)) {
          addIssue("web.websites.remove.id", "web.websites.remove.id is required.", item.id);
        }
      }

      return {
        valid: issues.length === 0,
        issues,
        state
      };
    }

    function createSettingsPreview(patch: Record<string, unknown>, state: Awaited<ReturnType<typeof readSettingValidationState>>) {
      const changes: Array<{ section: string; field: string; from: unknown; to: unknown }> = [];
      const generalPatch = asRecord(patch.general);
      const appearancePatch = asRecord(patch.appearance);
      const quickPatch = asRecord(patch.quick);
      const copilotPatch = asRecord(patch.copilot);
      const petPatch = asRecord(patch.pet);
      const kanbanPatch = asRecord(patch.kanban);
      const webPatch = asRecord(patch.web);
      const websiteOperations = getWebsiteOperations(webPatch);

      if (hasOwn(generalPatch, "deviceName")) {
        changes.push({ section: "general", field: "deviceName", from: state.generalSettings.deviceName, to: generalPatch.deviceName });
      }
      if (hasOwn(appearancePatch, "themeMode")) {
        changes.push({ section: "appearance", field: "themeMode", from: themeMode, to: appearancePatch.themeMode });
      }
      if (hasOwn(appearancePatch, "locale")) {
        changes.push({ section: "appearance", field: "locale", from: locale, to: appearancePatch.locale });
      }
      if (hasOwn(quickPatch, "enabled")) {
        changes.push({ section: "quick", field: "enabled", from: state.assistantSettings.quickAssistantEnabled, to: quickPatch.enabled });
      }
      if (hasOwn(quickPatch, "agentKey")) {
        changes.push({
          section: "quick",
          field: "agentKey",
          from: state.assistantSettings.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
          to: quickPatch.agentKey
        });
      }
      if (hasOwn(quickPatch, "shortcut")) {
        changes.push({
          section: "quick",
          field: "shortcut",
          from: normalizeQuickAssistantShortcut(state.assistantSettings.quickAssistantShortcut),
          to: normalizeQuickAssistantShortcut(quickPatch.shortcut)
        });
      }
      if (hasOwn(copilotPatch, "desktopCopilotPages")) {
        changes.push({
          section: "copilot",
          field: "desktopCopilotPages",
          from: state.assistantSettings.desktopCopilotPages,
          to: sanitizeDesktopCopilotPagePreferences({
            ...state.assistantSettings.desktopCopilotPages,
            ...asRecord(copilotPatch.desktopCopilotPages)
          })
        });
      }
      for (const field of ["enabled", "boundAgentKey", "appearanceId"]) {
        if (hasOwn(petPatch, field)) {
          changes.push({ section: "pet", field, from: state.desktopPet[field as keyof typeof state.desktopPet], to: petPatch[field] });
        }
      }
      for (const item of websiteOperations.add) {
        changes.push({ section: "web", field: "websites.add", from: null, to: item });
      }
      for (const item of websiteOperations.update) {
        changes.push({
          section: "web",
          field: "websites.update",
          from: state.webList.items.find((entry) => entry.kind === "website" && entry.id === readString(item.id)) ?? null,
          to: item
        });
      }
      for (const item of websiteOperations.remove) {
        changes.push({
          section: "web",
          field: "websites.remove",
          from: state.webList.items.find((entry) => entry.kind === "website" && entry.id === readString(item.id)) ?? null,
          to: null
        });
      }
      return { changes };
    }

    async function applySettingsPatch(patch: Record<string, unknown>, state: Awaited<ReturnType<typeof readSettingValidationState>>) {
      const affectedSections = new Set<string>();
      const generalPatch = asRecord(patch.general);
      const appearancePatch = asRecord(patch.appearance);
      const quickPatch = asRecord(patch.quick);
      const copilotPatch = asRecord(patch.copilot);
      const petPatch = asRecord(patch.pet);
      const kanbanPatch = asRecord(patch.kanban);
      const webPatch = asRecord(patch.web);
      const websiteOperations = getWebsiteOperations(webPatch);

      if (hasOwn(generalPatch, "deviceName")) {
        await window.electronAPI.settings.saveGeneralSettings({
          deviceName: readString(generalPatch.deviceName)
        });
        affectedSections.add("general");
      }
      if (isThemePreference(appearancePatch.themeMode)) {
        setThemeMode(appearancePatch.themeMode);
        await window.electronAPI.settings.setNativeThemeSource(appearancePatch.themeMode);
        affectedSections.add("appearance");
      }
      if (isSupportedLocale(appearancePatch.locale)) {
        await setLocale(appearancePatch.locale as SupportedLocale);
        affectedSections.add("appearance");
      }
      if (hasOwn(quickPatch, "enabled") || hasOwn(quickPatch, "agentKey") || hasOwn(quickPatch, "shortcut") || hasOwn(copilotPatch, "desktopCopilotPages")) {
        const nextSettings = await window.electronAPI.assistant.saveSettings({
          ...(typeof quickPatch.enabled === "boolean" ? { quickAssistantEnabled: quickPatch.enabled } : {}),
          ...(typeof quickPatch.agentKey === "string"
            ? { quickAssistantAgentKey: quickPatch.agentKey.trim() || DEFAULT_QUICK_ASSISTANT_AGENT_KEY }
            : {}),
          ...(typeof quickPatch.shortcut === "string"
            ? { quickAssistantShortcut: normalizeQuickAssistantShortcut(quickPatch.shortcut || DEFAULT_QUICK_ASSISTANT_SHORTCUT) }
            : {}),
          ...(hasOwn(copilotPatch, "desktopCopilotPages")
            ? {
                desktopCopilotPages: sanitizeDesktopCopilotPagePreferences({
                  ...state.assistantSettings.desktopCopilotPages,
                  ...asRecord(copilotPatch.desktopCopilotPages)
                })
              }
            : {})
        });
        setAssistantSettings(nextSettings);
        if (hasOwn(quickPatch, "enabled") || hasOwn(quickPatch, "agentKey") || hasOwn(quickPatch, "shortcut")) {
          affectedSections.add("quick");
        }
        if (hasOwn(copilotPatch, "desktopCopilotPages")) {
          affectedSections.add("copilot");
        }
      }
      if (Object.keys(petPatch).some((field) => ["enabled", "boundAgentKey", "appearanceId"].includes(field))) {
        await window.electronAPI.desktopPet.saveSettings({
          ...(typeof petPatch.enabled === "boolean" ? { enabled: petPatch.enabled } : {}),
          ...(typeof petPatch.boundAgentKey === "string" ? { boundAgentKey: petPatch.boundAgentKey.trim() } : {}),
          ...(typeof petPatch.appearanceId === "string" ? { appearanceId: petPatch.appearanceId.trim() } : {})
        });
        affectedSections.add("pet");
      }
      for (const item of websiteOperations.add) {
        const result = await window.electronAPI.webs.websites.add({
          label: readString(item.label),
          url: readString(item.url),
          ...(typeof item.agentKey === "string" ? { agentKey: item.agentKey.trim() } : {})
        });
        if (!result.ok) {
          throw new Error(result.message);
        }
        affectedSections.add("web");
      }
      for (const item of websiteOperations.update) {
        const id = readString(item.id);
        const result = await window.electronAPI.webs.websites.update(id, {
          ...(typeof item.label === "string" ? { label: item.label.trim() } : {}),
          ...(typeof item.url === "string" ? { url: item.url.trim() } : {}),
          ...(typeof item.agentKey === "string" ? { agentKey: item.agentKey.trim() } : {})
        });
        if (!result.ok) {
          throw new Error(result.message);
        }
        affectedSections.add("web");
      }
      for (const item of websiteOperations.remove) {
        const result = await window.electronAPI.webs.websites.remove(readString(item.id));
        if (!result.ok) {
          throw new Error(result.message);
        }
        affectedSections.add("web");
      }
      if (affectedSections.has("web")) {
        await refreshWebItems().catch(() => undefined);
      }
      return [...affectedSections];
    }

    return registerDesktopActionProviderForScope("global", async (request) => {
      const args = request.args ?? {};
      const patch = readSettingsPatch(args);

      switch (request.action) {
        case "desktop.setting.getState":
          return { ok: true, result: await readSettingsState() };
        case "desktop.setting.validatePatch": {
          const validation = await validateSettingsPatch(patch);
          return { ok: true, result: { valid: validation.valid, issues: validation.issues } };
        }
        case "desktop.setting.previewPatch": {
          const validation = await validateSettingsPatch(patch);
          return {
            ok: true,
            preview: {
              valid: validation.valid,
              issues: validation.issues,
              ...createSettingsPreview(patch, validation.state)
            }
          };
        }
        case "desktop.setting.applyPatch": {
          const validation = await validateSettingsPatch(patch);
          if (!validation.valid) {
            return {
              ok: false,
              error: {
                code: "invalid_settings_patch",
                message: t("desktopAction.invalidSettingsPatch"),
                details: validation.issues
              }
            };
          }
          const affectedSections = await applySettingsPatch(patch, validation.state);
          return {
            ok: true,
            result: {
              applied: true,
              affectedSections,
              state: await readSettingsState(affectedSections.length > 0 ? affectedSections : undefined)
            }
          };
        }
        case "desktop.web.listSurfaces":
          return { ok: true, result: { surfaces: createSurfaceList() } };
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
    activePluginId,
    webItems,
    location.pathname,
    navigate,
    locale,
    resolvedTheme,
    services,
    setLocale,
    themeMode,
    webappRuntimeById
  ]);

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
    const finishDrag = () => {
      if (ended) {
        return;
      }
      ended = true;
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", finishDrag, true);
      window.removeEventListener("blur", finishDrag, true);
      dragTarget.removeEventListener("lostpointercapture", finishDrag, true);
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

    windowDragEndRef.current = finishDrag;
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", finishDrag, true);
    window.addEventListener("blur", finishDrag, true);
    dragTarget.addEventListener("lostpointercapture", finishDrag, true);
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
    "--app-sidebar-width": `${effectiveSidebarWidth}px`
  } as CSSProperties;
  const globalSearchShortcutLabel = isMac ? "Cmd+K" : isWindows ? "Ctrl+K" : "";
  const normalizedBootstrapAgentKey = assistantSettings?.bootstrapAgentKey.trim() ?? "";

  return (
    <DebugModeContext.Provider value={debugSettingsUnlocked}>
      <div
        style={appShellStyle}
        onPointerDownCapture={handleWindowDragPointerDownCapture}
        className={[
        "app-shell",
        usesEmbeddedSurface ? "has-embedded-surface" : "",
        usesBuiltinBrowserSurface ? "has-builtin-browser-surface" : "",
        usesBrowserChromeSurface ? "has-browser-chrome-surface" : "",
        usesPluginSurface ? "has-plugin-surface" : "",
        isKanbanRoute ? "has-kanban-controls" : "",
        isMarketRoute && marketEnabled ? "has-market-controls" : "",
        usesStandardBaseSurface ? "has-standard-base-surface" : "",
        assistantCopilotOpen ? "has-assistant-dock" : "",
        assistantCopilotOpen ? "has-assistant-dock-full" : "",
        isMac ? "is-mac-platform" : "",
        isWindows ? "is-windows-platform" : "",
        windowFullScreen ? "is-window-fullscreen" : "",
        effectiveSidebarCollapsed ? "is-sidebar-collapsed" : "",
        isSidebarResizing ? "is-sidebar-resizing" : "",
        isSettingsRoute ? "is-settings-mode" : "",
        "has-translucent-sidebar",
        isMac ? "is-mac-translucent-sidebar" : ""
      ].filter(Boolean).join(" ")}
    >
      <div className="app-window-drag-layer" aria-hidden="true">
        <div className="app-window-drag-region" />
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
          faviconCache={faviconCache}
          assistantNavAgents={assistantNavAgents}
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
          onRefreshCopilotAgentOptions={refreshCopilotAgentOptions}
          onCreateWebsiteItem={createWebsiteItem}
          onImportWebappItem={importWebappItem}
          onCloseWebItem={handleCloseWebEntry}
          onRemoveWebappItem={removeWebappItem}
          onRequestNavigate={requestSidebarNavigation}
          onSidebarNavigateBack={handleSidebarBackNavigation}
          onSidebarNavigateForward={handleSidebarForwardNavigation}
          onNavigateItem={undefined}
          onToggleCollapsed={toggleSidebarCollapsed}
          isSettingsMode={isSettingsRoute}
          settingsSections={visibleSettingsSections}
          activeSettingsSectionId={activeSettingsSectionId}
          onSelectSettingsSection={handleSelectSettingsSection}
          onExitSettingsMode={handleExitSettingsMode}
        />
      </div>
      <div
        className={[
          "app-sidebar-resizer",
          isSettingsRoute ? "is-disabled" : "",
          isSidebarResizing ? "is-active" : ""
        ].filter(Boolean).join(" ")}
        role="separator"
        aria-label={t("nav.sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_EXPANDED_MAX_WIDTH}
        aria-valuenow={renderedSidebarWidth}
        aria-hidden={isSettingsRoute ? true : undefined}
        aria-disabled={isSettingsRoute ? true : undefined}
        onPointerDown={isSettingsRoute ? undefined : handleSidebarResizerPointerDown}
      >
        <span className="app-sidebar-resizer-line" aria-hidden="true" />
      </div>
      <div className="app-content">
        <main className="app-main">
          <PluginSurfaceHost
            activePluginId={activePluginId}
            activeAgentWebclientRoute={activeEmbeddedAgentWebclientRoute}
            hostTheme={resolvedTheme}
            mountedPluginIds={mountedPluginIds}
          />
          <BuiltinBrowserSurfaceHost
            active={usesBuiltinBrowserSurface}
            mounted={shouldMountBuiltinBrowserSurface}
            assistantDockOpen={assistantCopilotOpen}
            onOpenAssistantDock={() => openAssistantDock()}
            onCloseAssistantDock={closeAssistantDock}
          />
          <WebSurfaceHost
            activeEntryKey={activeWebEntryKey}
            itemMap={webItemMap}
            mountedEntryKeys={mountedWebEntryKeys}
            onWebsiteFaviconDiscovered={handleWebsiteFaviconDiscovered}
            assistantDockOpen={assistantCopilotOpen}
            onOpenAssistantDock={() => openAssistantDock()}
            onCloseAssistantDock={closeAssistantDock}
          />
          <Routes>
            <Route
              path="/"
              element={<StartupRoutePlaceholder />}
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
            <Route path="/help" element={<RouteSuspense><HelpPage isWindows={isWindows} /></RouteSuspense>} />
          </Routes>
        </main>
      </div>
      {isSidebarResizing ? (
        <div className="app-sidebar-resize-overlay" aria-hidden="true" />
      ) : null}
      <AgentWebclientCopilotDock
        open={assistantCopilotOpen}
        hostTheme={resolvedTheme}
        nativeDialogVisible={nativeDialogVisible || Boolean(desktopActionConfirmation)}
        openRequest={assistantDockOpenRequest}
        resolvedAgentKey={resolvedCopilotAgentKey}
        onRunningRunIdChange={setAssistantRunningRunId}
        onSelectedAgentKeyChange={handleCopilotSelectedAgentKeyChange}
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
              <strong>{desktopSsoLoginDialog.label}</strong>
              <button
                type="button"
                className="desktop-sso-login-modal-close"
                aria-label={t("sidebar.sso.cancelLogin")}
                title={t("sidebar.sso.cancelLogin")}
                onClick={() => void handleDesktopSsoLoginDialogClose()}
              >
                <span aria-hidden="true">x</span>
              </button>
            </header>
            <div className="desktop-sso-login-modal-frame">
              {createElement("webview", {
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
          onImport={handleEnvImport}
        />
      ) : null}
      <DesktopActionConfirmationDialog
        request={desktopActionConfirmation}
        onDecision={handleDesktopActionConfirmationDecision}
      />
      <DesktopGlobalSearchOverlay
        open={globalSearchOpen}
        agents={assistantNavAgents}
        currentRoute={currentRoute}
        shortcutLabel={globalSearchShortcutLabel}
        t={t}
        onClose={() => setGlobalSearchOpen(false)}
        onNavigate={requestSidebarNavigation}
      />
      </div>
    </DebugModeContext.Provider>
  );
}

function resolvePluginRouteId(pathname: string) {
  return matchPath("/service/:serviceId", pathname)?.params.serviceId ??
    matchPath("/plugin/:pluginId", pathname)?.params.pluginId ??
    null;
}

function readAgentRouteInfo(route: string) {
  try {
    const url = new URL(route, "http://desktop.local");
    const match = url.pathname.match(/^\/agent\/([^/]+)$/);
    return {
      agentKey: match?.[1] ? decodeURIComponent(match[1]) : "",
      chatId: url.searchParams.get("chatId")?.trim() ?? "",
    };
  } catch {
    return { agentKey: "", chatId: "" };
  }
}

function createAgentNewChatRoute(agentKey: string) {
  return `/agent/${encodeURIComponent(agentKey)}?newChat=${Date.now()}`;
}

function createAgentChatRoute(agentKey: string, chatId: string) {
  const params = new URLSearchParams();
  params.set("chatId", chatId.trim());
  return `/agent/${encodeURIComponent(agentKey)}?${params.toString()}`;
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

function resolveAgentManagementWebclientRoute(pathname: string, search: string): AgentWebclientResolvedRoute | null {
  const match = matchPath("/agents/:agentKey", pathname);
  const agentKey = match?.params.agentKey?.trim() ?? "";
  if (!agentKey) {
    return null;
  }

  return {
    key: "agents",
    routePath: `${pathname}${search}`,
    embedPath: `${pathname}${search}`,
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
  const requestedAgentKey = match?.params.agentKey?.trim() ?? "";

  if (pathname !== "/copilot" && !requestedAgentKey) {
    return null;
  }

  const matchedAgentKey = requestedAgentKey && copilotAgentOptions.some((agent) => agent.agentKey === requestedAgentKey)
    ? requestedAgentKey
    : "";
  const targetAgentKey = matchedAgentKey || firstAgentKey || requestedAgentKey;
  const targetPath = targetAgentKey
    ? `/copilot/${encodeURIComponent(targetAgentKey)}`
    : "/copilot";

  return {
    key: "copilot",
    routePath: `${pathname}${search}`,
    embedPath: `${targetPath}${search}`,
    labelKey: "nav.assistants",
    kind: "copilot",
    mode: "embedded"
  };
}

function resolveSingleAgentWebclientRoute(pathname: string, search: string): AgentWebclientResolvedRoute | null {
  const match = matchPath("/agent/:agentKey", pathname);
  const agentKey = match?.params.agentKey?.trim() ?? "";
  if (!agentKey) {
    return null;
  }

  const params = new URLSearchParams(search);
  const embedParams = new URLSearchParams();
  for (const key of ["chatId", "history", "historyRequest", "newChat"]) {
    if (params.has(key)) {
      embedParams.set(key, params.get(key)?.trim() ?? "");
    }
  }
  const embedQuery = embedParams.toString();
  return {
    key: "agent-chat",
    routePath: `${pathname}${search}`,
    embedPath: `/agent/${encodeURIComponent(agentKey)}${embedQuery ? `?${embedQuery}` : ""}`,
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
