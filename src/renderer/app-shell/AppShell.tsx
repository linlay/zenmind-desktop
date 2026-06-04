import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from "react-router-dom";
import { AppSidebar } from "./navigation/AppSidebar";
import { BuiltinBrowserSurfaceHost, CustomSidebarRouteFallback, CustomSidebarSurfaceHost, ExternalItemRoute, PluginSurfaceHost } from "./embedded-surfaces/EmbeddedSurfaceHosts";
import { AgentWebclientNativeRouteOutlet } from "./agent-webclient/AgentWebclientNativeRouteOutlet";
import { RootRouteRedirect, StartupLoadingScreen } from "./startup/StartupGate";
import { EnvImportOverlay } from "./startup/EnvImportOverlay";
import { AgentWebclientCopilotDock } from "../copilot/sidebar-copilot/AgentWebclientCopilotDock";
import { useServices } from "../services/ServicesContext";
import { getAssistantPageContext } from "../copilot/page-context/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "../services/currentPageContext";
import {
  registerDesktopActionProviderForScope,
  startDesktopActionRendererBridge
} from "../services/desktopActionRegistry";
import type { AssistantNavAgentItem, AssistantSettingsPublic, AssistantWorkerOpenRequest, CustomSidebarItem, CustomSidebarItemInput, CustomSidebarItemResult, DesktopSsoStatus, ServiceId, StartupRestoreState } from "../../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DESKTOP_COPILOT_PAGE_KEYS,
  DESKTOP_COPILOT_PAGE_LABELS
} from "../../shared/assistant-settings";
import {
  resolveDesktopCopilotPreference,
  sanitizeDesktopCopilotPagePreferences
} from "../../shared/page-copilot";
import {
  shouldAutoOpenAssistant,
  shouldShowStartupProgressCard
} from "../../shared/startup-gate";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../shared/browser-surfaces";
import { STORAGE_NAMESPACE } from "../../shared/generated/brand";
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
  createCustomSidebarNavOrderKey,
  createDefaultSidebarNavOrderItems,
  normalizeSidebarNavOrder,
  type SidebarNavOrderItem,
  type SidebarNavOrderItemKey
} from "./navigation/sidebarNavOrder";
import { useI18n } from "../i18n/useI18n";
import {
  normalizeAssistantNavAgentItemsResult,
  normalizeAssistantNavAgents
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

type ThemeMode = "light" | "dark";

const ControlCenterPage = lazy(() =>
  import("../pages/control-center/ControlCenterPage").then((module) => ({ default: module.ControlCenterPage }))
);
const HelpPage = lazy(() =>
  import("../pages/HelpPage").then((module) => ({ default: module.HelpPage }))
);
const FunctionalMarketPage = lazy(() =>
  import("../pages/functional-market").then((module) => ({ default: module.FunctionalMarketPage }))
);
const SettingsPage = lazy(() =>
  import("../pages/settings/SettingsPage").then((module) => ({ default: module.SettingsPage }))
);
const TaskBoardPage = lazy(() =>
  import("../pages/task-board/TaskBoardPage").then((module) => ({ default: module.TaskBoardPage }))
);

const THEME_STORAGE_KEY = `${STORAGE_NAMESPACE}.theme`;
const SIDEBAR_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar`;
const SIDEBAR_NAV_ORDER_STORAGE_KEY = `${STORAGE_NAMESPACE}.sidebar-nav-order`;
const CUSTOM_SIDEBAR_GROUP_ORDER_STORAGE_KEY = `${STORAGE_NAMESPACE}.custom-sidebar-group-order`;
const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
const LEGACY_AGENT_WEBCLIENT_SERVICE_PATH = "/service/agent-webclient";
const SIDEBAR_NAVIGATION_LOCK_MS = 900;
const STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
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
  return asRecord(args.patch);
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
  return window.electronAPI.sso?.getStatus ? window.electronAPI.sso : null;
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

function readInitialCustomSidebarGroupOrder(): SidebarNavOrderItemKey[] {
  const savedGroupOrder = readStoredSidebarNavOrder(CUSTOM_SIDEBAR_GROUP_ORDER_STORAGE_KEY);
  if (savedGroupOrder.length > 0) {
    return savedGroupOrder;
  }
  return readStoredSidebarNavOrder(SIDEBAR_NAV_ORDER_STORAGE_KEY).filter((key) => key.startsWith("custom:"));
}

function normalizeCustomSidebarGroupOrder(
  candidate: SidebarNavOrderItemKey[],
  customItems: CustomSidebarItem[]
) {
  const availableKeys = new Set(customItems.map((item) => createCustomSidebarNavOrderKey(item.id)));
  const normalized = candidate.filter((key) => key.startsWith("custom:") && availableKeys.has(key));
  for (const item of customItems) {
    const key = createCustomSidebarNavOrderKey(item.id);
    if (!normalized.includes(key)) {
      normalized.push(key);
    }
  }
  return normalized;
}

export const EXTERNAL_EXPERIMENTAL_ITEMS = [] as const;

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

export function AppShell() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { services, loading: servicesLoading, error: servicesError, refresh: refreshServices } = useServices();
  const sidebarNavigationUnlockTimerRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<SidebarResizeDragState | null>(null);
  const assistantDockOpenRequestPathRef = useRef<string | null>(null);
  const startupNavigationDoneRef = useRef(false);
  const refreshServicesRef = useRef(refreshServices);
  const assistantNavAgentsRefreshIdRef = useRef(0);
  const [desktopPlatform, setDesktopPlatform] = useState(inferDesktopPlatform);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "light";
    }
    try {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      return savedTheme === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
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
  const [customSidebarGroupOrder, setCustomSidebarGroupOrder] = useState<SidebarNavOrderItemKey[]>(readInitialCustomSidebarGroupOrder);
  const [assistantDockOpenPath, setAssistantDockOpenPath] = useState<string | null>(null);
  const [assistantDockOpenRequest, setAssistantDockOpenRequest] = useState<AssistantWorkerOpenRequest | null>(null);
  const [assistantRunningRunId, setAssistantRunningRunId] = useState<string | null>(null);
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [assistantNavAgents, setAssistantNavAgents] = useState<AssistantNavAgentItem[]>([]);
  const [assistantNavAgentsLoaded, setAssistantNavAgentsLoaded] = useState(false);
  const [copilotAgentOptions, setCopilotAgentOptions] = useState<AssistantNavAgentItem[]>([]);
  const [nativeDialogVisible, setNativeDialogVisible] = useState(false);
  const [desktopSsoStatus, setDesktopSsoStatus] = useState<DesktopSsoStatus | null>(null);
  const [desktopSsoBusy, setDesktopSsoBusy] = useState(false);
  const [customSidebarItems, setCustomSidebarItems] = useState<CustomSidebarItem[]>([]);
  const [customSidebarItemsLoaded, setCustomSidebarItemsLoaded] = useState(false);
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
  const rawActiveAgentWebclientRoute = resolveAgentWebclientRoute(location.pathname, location.search, copilotAgentOptions);
  const activeAgentWebclientRoute = rawActiveAgentWebclientRoute
    ? {
        ...rawActiveAgentWebclientRoute,
        label: rawActiveAgentWebclientRoute.labelKey
          ? t(rawActiveAgentWebclientRoute.labelKey)
          : rawActiveAgentWebclientRoute.label
      }
    : null;
  const activeEmbeddedAgentWebclientRoute = isEmbeddedAgentWebclientRoute(activeAgentWebclientRoute)
    ? activeAgentWebclientRoute
    : null;
  const bareAgentWebclientServiceRoute = isBareAgentWebclientServiceRoute(location.pathname, location.search);
  const usesAgentNativeSurface =
    activeAgentWebclientRoute?.mode === "native" &&
    (activeAgentWebclientRoute.key === "agents" || activeAgentWebclientRoute.key === "schedules");
  const activePluginId = activeEmbeddedAgentWebclientRoute
    ? AGENT_WEBCLIENT_SERVICE_ID
    : bareAgentWebclientServiceRoute
      ? null
      : resolvePluginRouteId(location.pathname);
  const activeCustomSidebarItemId = resolveCustomSidebarRouteId(location.pathname);
  const [mountedPluginIds, setMountedPluginIds] = useState<string[]>(() =>
    activePluginId ? [activePluginId] : []
  );
  const [mountedCustomSidebarItemIds, setMountedCustomSidebarItemIds] = useState<string[]>(() =>
    activeCustomSidebarItemId ? [activeCustomSidebarItemId] : []
  );
  const [builtinBrowserSurfaceMounted, setBuiltinBrowserSurfaceMounted] = useState(
    () => location.pathname === BUILTIN_BROWSER_ROUTE
  );
  const usesEmbeddedSurface =
    Boolean(activeEmbeddedAgentWebclientRoute) ||
    (!bareAgentWebclientServiceRoute && location.pathname.startsWith("/service/")) ||
    location.pathname.startsWith("/plugin/") ||
    location.pathname.startsWith("/external/") ||
    location.pathname === BUILTIN_BROWSER_ROUTE ||
    location.pathname.startsWith("/custom-sidebar/");
  const usesBuiltinBrowserSurface = location.pathname === BUILTIN_BROWSER_ROUTE;
  const shouldMountBuiltinBrowserSurface = builtinBrowserSurfaceMounted || usesBuiltinBrowserSurface;
  const usesPluginSurface =
    Boolean(activeEmbeddedAgentWebclientRoute) ||
    (!bareAgentWebclientServiceRoute && location.pathname.startsWith("/service/")) ||
    location.pathname.startsWith("/plugin/");
  const isTaskBoardRoute = location.pathname === "/kanban";
  const isMarketRoute = location.pathname === "/market";
  const usesStandardBaseSurface =
    isTaskBoardRoute ||
    location.pathname === "/control-center" ||
    location.pathname === "/market" ||
    location.pathname === "/help" ||
    location.pathname === "/settings";
  const isMac = desktopPlatform === "darwin";
  const isWindows = desktopPlatform === "win32";
  const isSettingsRoute = location.pathname === "/settings";
  const currentRoute = `${location.pathname}${location.search}`;
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
  const showStartupCard = !startupCardDismissed && shouldShowStartupProgressCard(startupRestoreState, startupAllReady);
  const customSidebarItemMap = useMemo(() => new Map(customSidebarItems.map((item) => [item.id, item])), [customSidebarItems]);
  const currentCopilotPreference = resolveDesktopCopilotPreference(assistantSettings?.desktopCopilotPages, location.pathname);
  const customSidebarAgentKey = activeCustomSidebarItemId
    ? customSidebarItemMap.get(activeCustomSidebarItemId)?.agentKey || ""
    : "";
  const resolvedCopilotAgentKey = customSidebarAgentKey || currentCopilotPreference?.agentKey || DEFAULT_DESKTOP_HELPER_AGENT_KEY;
  const assistantLauncherVisible = currentCopilotPreference?.enabled !== false;
  const isAgentWebclientMainRoute =
    location.pathname === ASSISTANT_TARGET_PATH ||
    isSingleAgentWebclientRoute(location.pathname) ||
    isCopilotAgentWebclientRoute(location.pathname);
  const assistantDockOpen = assistantDockOpenPath !== null;
  const assistantCopilotOpen = assistantDockOpen && assistantDockOpenPath === location.pathname && !isAgentWebclientMainRoute;
  const sidebarCollapsed = sidebarState.mode === "collapsed";
  const renderedSidebarWidth = resolveRenderedSidebarWidth(sidebarState);
  const availableSidebarNavOrderItems = useMemo<SidebarNavOrderItem[]>(() => {
    return createDefaultSidebarNavOrderItems({
      serviceItems: [],
      experimentalItems: [],
      customItems: []
    }).map((item) => {
      if (item.key === "kanban") return { ...item, label: t("nav.taskBoard") };
      if (item.key === "schedules") return { ...item, label: t("nav.schedules") };
      if (item.key === "group:assistants") return { ...item, label: t("nav.assistants") };
      if (item.key === "group:websites") return { ...item, label: t("nav.embeddedWebsites") };
      return item;
    });
  }, [t]);
  const normalizedSidebarNavOrder = useMemo(
    () => normalizeSidebarNavOrder(sidebarNavOrder, availableSidebarNavOrderItems),
    [availableSidebarNavOrderItems, sidebarNavOrder]
  );
  const normalizedCustomSidebarGroupOrder = useMemo(
    () => normalizeCustomSidebarGroupOrder(customSidebarGroupOrder, customSidebarItems),
    [customSidebarGroupOrder, customSidebarItems]
  );

  async function refreshCustomSidebarItems() {
    const result = await window.electronAPI.customSidebar.list();
    if (result.ok) {
      updateCustomSidebarItems(result.items);
    }
    return result;
  }

  async function createCustomSidebarItem(input: CustomSidebarItemInput): Promise<CustomSidebarItemResult> {
    const result = await window.electronAPI.customSidebar.add(input);
    updateCustomSidebarItems(result.items);
    return result;
  }

  function updateCustomSidebarItems(items: CustomSidebarItem[]) {
    setCustomSidebarItems(items);
    setCustomSidebarItemsLoaded(true);
    setCustomSidebarGroupOrder((currentOrder) => normalizeCustomSidebarGroupOrder(currentOrder, items));
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
        const nextItems = normalizeAssistantNavAgents(result.items);
        setAssistantNavAgentsLoaded(true);
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
      setAssistantNavAgents(nextResult.items);
    });

    return () => {
      cancelled = true;
      assistantNavAgentsRefreshIdRef.current += 1;
      unsubscribe();
    };
  }, []);

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

  useEffect(() => {
    startDesktopActionRendererBridge();
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
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    refreshCustomSidebarItems().catch(() => undefined);
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
    if (
      !shouldAutoOpenAssistant(startupRestoreState, startupAllReady, location.pathname) ||
      startupNavigationDoneRef.current
    ) {
      return;
    }

    startupNavigationDoneRef.current = true;
    setStartupTimedOut(false);
    navigate("/kanban", { replace: true });
  }, [location.pathname, navigate, startupAllReady, startupRestoreState]);

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
    if (
      startupRestoreState?.mode !== "bootstrap" ||
      startupRestoreState.phase !== "failed"
    ) {
      return;
    }

    setStartupCardDismissed(true);
    setStartupTimedOut(false);
    navigate("/control-center", {
      replace: true,
      state: {
        startupFailure: {
          serviceId: startupRestoreState.failedServiceId,
          message: startupRestoreState.message
        }
      }
    });
  }, [navigate, startupRestoreState]);

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
    document.documentElement.dataset.theme = themeMode;
    window.electronAPI.settings.setNativeThemeSource(themeMode).catch(() => undefined);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore persistence failures and keep the in-memory theme switch usable.
    }
  }, [themeMode]);

  useEffect(() => {
    const shouldApply = isMac;
    document.body.classList.toggle("mac-translucent-sidebar-body", shouldApply);

    return () => {
      document.body.classList.remove("mac-translucent-sidebar-body");
    };
  }, [isMac]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_NAV_ORDER_STORAGE_KEY,
        JSON.stringify(normalizedSidebarNavOrder)
      );
    } catch {
      // Ignore persistence failures and keep the in-memory navigation order usable.
    }
  }, [normalizedSidebarNavOrder]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CUSTOM_SIDEBAR_GROUP_ORDER_STORAGE_KEY,
        JSON.stringify(normalizedCustomSidebarGroupOrder)
      );
    } catch {
      // Ignore persistence failures and keep the in-memory website order usable.
    }
  }, [normalizedCustomSidebarGroupOrder]);

  useEffect(() => {
    document.body.classList.toggle("embedded-surface-body", usesEmbeddedSurface);
    return () => {
      document.body.classList.remove("embedded-surface-body");
    };
  }, [usesEmbeddedSurface]);

  useEffect(() => {
    document.body.classList.toggle("agent-native-surface-body", usesAgentNativeSurface);
    return () => {
      document.body.classList.remove("agent-native-surface-body");
    };
  }, [usesAgentNativeSurface]);

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
    if (!activeCustomSidebarItemId) {
      return;
    }

    setMountedCustomSidebarItemIds((current) =>
      current.includes(activeCustomSidebarItemId)
        ? current
        : [...current, activeCustomSidebarItemId]
    );
  }, [activeCustomSidebarItemId]);

  useEffect(() => {
    if (!usesBuiltinBrowserSurface) {
      return;
    }

    setBuiltinBrowserSurfaceMounted(true);
  }, [usesBuiltinBrowserSurface]);

  useEffect(() => {
    if (!customSidebarItemsLoaded) {
      return;
    }

    const availableItemIds = new Set(customSidebarItems.map((item) => item.id));
    setMountedCustomSidebarItemIds((current) =>
      current.filter((itemId) => availableItemIds.has(itemId))
    );
  }, [customSidebarItems, customSidebarItemsLoaded]);

  function toggleTheme() {
    setThemeMode((current) => (current === "light" ? "dark" : "light"));
  }

  function toggleSidebarCollapsed() {
    setSidebarState((current) => toggleSidebarLayoutState(current));
  }

  function handleSidebarResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || isSidebarResizing) {
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
          label: getServiceDisplayName(service.id, service.name),
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
        ...customSidebarItems.map((item) => ({
          id: item.id,
          label: item.label,
          url: item.url,
          route: `/custom-sidebar/${item.id}`,
          active: activeCustomSidebarItemId === item.id
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

    async function readSettingsState() {
      const [nextAssistantSettings, assistantAgents, desktopPetState] = await Promise.all([
        window.electronAPI.assistant.getSettings(),
        window.electronAPI.assistant.listAgents(),
        window.electronAPI.desktopPet.getState()
      ]);
      setAssistantSettings(nextAssistantSettings);
      return {
        themeMode,
        sidebarTranslucencyEnabled: true,
        assistantSettings: nextAssistantSettings,
        assistantAgents,
        desktopPet: desktopPetState
      };
    }

    async function validateSettingsPatch(patch: Record<string, unknown>) {
      const state = await readSettingsState();
      const issues: Array<{ field: string; message: string; value?: unknown }> = [];
      const desktopPetPatch = asRecord(patch.desktopPet);

      if ("themeMode" in patch && patch.themeMode !== "light" && patch.themeMode !== "dark") {
        issues.push({ field: "themeMode", value: patch.themeMode, message: "themeMode must be light or dark." });
      }
      if ("enabled" in desktopPetPatch && typeof desktopPetPatch.enabled !== "boolean") {
        issues.push({ field: "desktopPet.enabled", value: desktopPetPatch.enabled, message: "desktopPet.enabled must be boolean." });
      }
      if ("appearanceId" in desktopPetPatch) {
        const appearanceId = typeof desktopPetPatch.appearanceId === "string" ? desktopPetPatch.appearanceId.trim() : "";
        if (!state.desktopPet.appearanceOptions.some((appearance) => appearance.id === appearanceId)) {
          issues.push({ field: "desktopPet.appearanceId", value: desktopPetPatch.appearanceId, message: "请选择可用的桌面宠物形象。" });
        }
      }
      if ("boundAgentKey" in desktopPetPatch) {
        const boundAgentKey = typeof desktopPetPatch.boundAgentKey === "string" ? desktopPetPatch.boundAgentKey.trim() : "";
        if (!state.desktopPet.agentOptions.some((agent) => agent.agentKey === boundAgentKey)) {
          issues.push({ field: "desktopPet.boundAgentKey", value: desktopPetPatch.boundAgentKey, message: "请选择可用的桌面宠物绑定智能体。" });
        }
      }
      if ("desktopHelperAgentKey" in patch) {
        const agentKey = typeof patch.desktopHelperAgentKey === "string" ? patch.desktopHelperAgentKey.trim() : "";
        if (!state.assistantAgents.some((agent) => agent.agentKey === agentKey)) {
          issues.push({ field: "desktopHelperAgentKey", value: patch.desktopHelperAgentKey, message: "请选择可用的侧边栏默认智能体。" });
        }
      }
      if ("desktopCopilotPages" in patch) {
        const nextPages = sanitizeDesktopCopilotPagePreferences({
          ...state.assistantSettings.desktopCopilotPages,
          ...asRecord(patch.desktopCopilotPages)
        });
        for (const pageKey of DESKTOP_COPILOT_PAGE_KEYS) {
          const preference = nextPages[pageKey];
          if (preference.enabled && !state.assistantAgents.some((agent) => agent.agentKey === preference.agentKey)) {
            issues.push({
              field: `desktopCopilotPages.${pageKey}.agentKey`,
              value: preference.agentKey,
              message: `${DESKTOP_COPILOT_PAGE_LABELS[pageKey]} 的侧边助手智能体不可用。`
            });
          }
        }
      }

      return {
        valid: issues.length === 0,
        issues,
        state
      };
    }

    function createSettingsPreview(patch: Record<string, unknown>, state: Awaited<ReturnType<typeof readSettingsState>>) {
      const desktopPetPatch = asRecord(patch.desktopPet);
      const changes = [];
      if ("themeMode" in patch) {
        changes.push({ field: "themeMode", from: state.themeMode, to: patch.themeMode });
      }
      if ("enabled" in desktopPetPatch) {
        changes.push({ field: "desktopPet.enabled", from: state.desktopPet.enabled, to: desktopPetPatch.enabled });
      }
      if ("appearanceId" in desktopPetPatch) {
        changes.push({ field: "desktopPet.appearanceId", from: state.desktopPet.appearanceId, to: desktopPetPatch.appearanceId });
      }
      if ("boundAgentKey" in desktopPetPatch) {
        changes.push({ field: "desktopPet.boundAgentKey", from: state.desktopPet.boundAgentKey, to: desktopPetPatch.boundAgentKey });
      }
      if ("desktopHelperAgentKey" in patch) {
        changes.push({
          field: "desktopHelperAgentKey",
          from: state.assistantSettings.desktopHelperAgentKey,
          to: patch.desktopHelperAgentKey
        });
      }
      if ("desktopCopilotPages" in patch) {
        changes.push({
          field: "desktopCopilotPages",
          from: state.assistantSettings.desktopCopilotPages,
          to: sanitizeDesktopCopilotPagePreferences({
            ...state.assistantSettings.desktopCopilotPages,
            ...asRecord(patch.desktopCopilotPages)
          })
        });
      }
      return { changes };
    }

    return registerDesktopActionProviderForScope("global", async (request) => {
      const args = request.args ?? {};
      const patch = readSettingsPatch(args);

      switch (request.action) {
        case "desktop.settings.getState":
          return { ok: true, result: await readSettingsState() };
        case "desktop.settings.validatePatch": {
          const validation = await validateSettingsPatch(patch);
          return { ok: true, result: { valid: validation.valid, issues: validation.issues } };
        }
        case "desktop.settings.previewPatch": {
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
        case "desktop.settings.applyPatch": {
          const validation = await validateSettingsPatch(patch);
          if (!validation.valid) {
            return {
              ok: false,
              error: {
                code: "invalid_settings_patch",
                message: "Desktop 设置 patch 校验失败。",
                details: validation.issues
              }
            };
          }

          const desktopPetPatch = asRecord(patch.desktopPet);
          if (patch.themeMode === "light" || patch.themeMode === "dark") {
            setThemeMode(patch.themeMode);
          }
          if (Object.keys(desktopPetPatch).length > 0) {
            await window.electronAPI.desktopPet.saveSettings({
              ...(typeof desktopPetPatch.enabled === "boolean" ? { enabled: desktopPetPatch.enabled } : {}),
              ...(typeof desktopPetPatch.appearanceId === "string" ? { appearanceId: desktopPetPatch.appearanceId } : {}),
              ...(typeof desktopPetPatch.boundAgentKey === "string" ? { boundAgentKey: desktopPetPatch.boundAgentKey } : {})
            });
          }
          if ("desktopHelperAgentKey" in patch || "desktopCopilotPages" in patch) {
            const nextSettings = await window.electronAPI.assistant.saveSettings({
              ...(typeof patch.desktopHelperAgentKey === "string"
                ? { desktopHelperAgentKey: patch.desktopHelperAgentKey.trim() || DEFAULT_DESKTOP_HELPER_AGENT_KEY }
                : {}),
              ...("desktopCopilotPages" in patch
                ? {
                    desktopCopilotPages: sanitizeDesktopCopilotPagePreferences({
                      ...validation.state.assistantSettings.desktopCopilotPages,
                      ...asRecord(patch.desktopCopilotPages)
                    })
                  }
                : {})
            });
            setAssistantSettings(nextSettings);
          }
          return { ok: true, result: { applied: true, state: await readSettingsState() } };
        }
        case "desktop.embeddedWeb.listSurfaces":
          return { ok: true, result: { surfaces: createSurfaceList() } };
        case "desktop.embeddedWeb.activateSurface": {
          const target = getSurfaceTarget(args);
          const surface = createSurfaceList().find((candidate) => surfaceMatchesTarget(candidate, target));
          if (!surface) {
            return {
              ok: false,
              error: {
                code: "surface_not_found",
                message: "没有找到匹配的内嵌网站。",
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
    activeCustomSidebarItemId,
    activeAgentWebclientRoute,
    activePluginId,
    customSidebarItems,
    location.pathname,
    navigate,
    services,
    themeMode
  ]);

  const appShellStyle = {
    "--app-sidebar-width": `${renderedSidebarWidth}px`
  } as CSSProperties;

  return (
    <div
      style={appShellStyle}
      className={[
        "app-shell",
        usesEmbeddedSurface ? "has-embedded-surface" : "",
        usesBuiltinBrowserSurface ? "has-builtin-browser-surface" : "",
        usesPluginSurface ? "has-plugin-surface" : "",
        usesAgentNativeSurface ? "has-agent-native-surface" : "",
        isTaskBoardRoute ? "has-task-board-controls" : "",
        isMarketRoute ? "has-market-controls" : "",
        usesStandardBaseSurface ? "has-standard-base-surface" : "",
        assistantCopilotOpen ? "has-assistant-dock" : "",
        assistantCopilotOpen ? "has-assistant-dock-full" : "",
        isMac ? "is-mac-platform" : "",
        isWindows ? "is-windows-platform" : "",
        sidebarCollapsed ? "is-sidebar-collapsed" : "",
        isSidebarResizing ? "is-sidebar-resizing" : "",
        "has-translucent-sidebar",
        isMac ? "is-mac-translucent-sidebar" : ""
      ].filter(Boolean).join(" ")}
    >
      <div className="app-window-drag-region" aria-hidden="true" />
      <div className="app-sidebar-shell">
        <AppSidebar
          isCollapsed={sidebarCollapsed}
          isMac={isMac}
          isWindows={isWindows}
          currentPathname={location.pathname}
          currentRoute={currentRoute}
          pendingPath={pendingSidebarNavigationPath}
          assistantDockOpen={assistantCopilotOpen}
          assistantLauncherDisabled={isAgentWebclientMainRoute}
          assistantLauncherVisible={assistantLauncherVisible}
          sidebarNavOrder={normalizedSidebarNavOrder}
          customSidebarNavOrder={normalizedCustomSidebarGroupOrder}
          customSidebarItems={customSidebarItems}
          assistantNavAgents={assistantNavAgents}
          assistantNavAgentsLoaded={assistantNavAgentsLoaded}
          copilotAgentOptions={copilotAgentOptions}
          desktopSsoStatus={desktopSsoStatus}
          desktopSsoBusy={desktopSsoBusy}
          sidebarNavigationCanGoBack={sidebarNavigationHistory.back.length > 0}
          sidebarNavigationCanGoForward={sidebarNavigationHistory.forward.length > 0}
          onOpenAssistantDock={() => openAssistantDock()}
          onCloseAssistantDock={() => {
            setAssistantDockOpenPath(null);
            setAssistantDockOpenRequest(null);
            assistantDockOpenRequestPathRef.current = null;
          }}
          onDesktopSsoLogin={handleDesktopSsoLogin}
          onDesktopSsoLogout={handleDesktopSsoLogout}
          onRefreshAssistantNavAgents={refreshAssistantNavAgents}
          onRefreshCopilotAgentOptions={refreshCopilotAgentOptions}
          onCreateCustomSidebarItem={createCustomSidebarItem}
          onRequestNavigate={requestSidebarNavigation}
          onSidebarNavigateBack={handleSidebarBackNavigation}
          onSidebarNavigateForward={handleSidebarForwardNavigation}
          onNavigateItem={undefined}
          onToggleCollapsed={toggleSidebarCollapsed}
        />
      </div>
      <div
        className={[
          "app-sidebar-resizer",
          isSidebarResizing ? "is-active" : ""
        ].filter(Boolean).join(" ")}
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_EXPANDED_MAX_WIDTH}
        aria-valuenow={renderedSidebarWidth}
        onPointerDown={handleSidebarResizerPointerDown}
      >
        <span className="app-sidebar-resizer-line" aria-hidden="true" />
      </div>
      <div className="app-content">
        <main className="app-main">
          <div className="app-main-drag-region" aria-hidden="true" />
          <PluginSurfaceHost
            activePluginId={activePluginId}
            activeAgentWebclientRoute={activeEmbeddedAgentWebclientRoute}
            hostTheme={themeMode}
            mountedPluginIds={mountedPluginIds}
          />
          <BuiltinBrowserSurfaceHost
            active={usesBuiltinBrowserSurface}
            mounted={shouldMountBuiltinBrowserSurface}
          />
          <CustomSidebarSurfaceHost
            activeItemId={activeCustomSidebarItemId}
            itemMap={customSidebarItemMap}
            mountedItemIds={mountedCustomSidebarItemIds}
          />
          <Routes>
            <Route
              path="/"
              element={
                <RootRouteRedirect
                  startupRestoreState={startupRestoreState}
                  startupAllReady={startupAllReady}
                />
              }
            />
            <Route path="/kanban" element={<RouteSuspense><TaskBoardPage hostTheme={themeMode} /></RouteSuspense>} />
            <Route path="/control-center" element={<RouteSuspense><ControlCenterPage /></RouteSuspense>} />
            <Route
              path="/settings"
              element={
                <RouteSuspense>
                  <SettingsPage
                    themeMode={themeMode}
                    onToggleTheme={toggleTheme}
                    isMac={isMac}
                    isWindows={isWindows}
                    sidebarNavOrder={normalizedSidebarNavOrder}
                    availableSidebarNavOrderItems={availableSidebarNavOrderItems}
                    onSidebarNavOrderChange={setSidebarNavOrder}
                    customSidebarItems={customSidebarItems}
                    onCustomSidebarItemsChange={updateCustomSidebarItems}
                    onRefreshCustomSidebarItems={refreshCustomSidebarItems}
                    onAssistantSettingsChange={setAssistantSettings}
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
                element={<AgentWebclientNativeRouteOutlet route={activeAgentWebclientRoute} hostTheme={themeMode} />}
              />
            ))}
            {AGENT_WEBCLIENT_DYNAMIC_ROUTE_PATTERNS.map((routePattern) => (
              <Route
                key={routePattern}
                path={routePattern}
                element={<AgentWebclientNativeRouteOutlet route={activeAgentWebclientRoute} hostTheme={themeMode} />}
              />
            ))}
            <Route path="/external/:itemId" element={<ExternalItemRoute itemMap={experimentalItemMap} />} />
            <Route path={BUILTIN_BROWSER_ROUTE} element={null} />
            <Route path="/custom-sidebar/:itemId" element={<CustomSidebarRouteFallback itemMap={customSidebarItemMap} />} />
            <Route path="/service/:serviceId" element={null} />
            <Route path="/plugin/:pluginId" element={null} />
            <Route path="/market" element={<RouteSuspense><FunctionalMarketPage /></RouteSuspense>} />
            <Route path="/help" element={<RouteSuspense><HelpPage isWindows={isWindows} /></RouteSuspense>} />
          </Routes>
        </main>
      </div>
      {isSidebarResizing ? (
        <div className="app-sidebar-resize-overlay" aria-hidden="true" />
      ) : null}
      <AgentWebclientCopilotDock
        open={assistantCopilotOpen}
        hostTheme={themeMode}
        nativeDialogVisible={nativeDialogVisible}
        openRequest={assistantDockOpenRequest}
        resolvedAgentKey={resolvedCopilotAgentKey}
        onClose={() => {
          setAssistantDockOpenPath(null);
          setAssistantDockOpenRequest(null);
          assistantDockOpenRequestPathRef.current = null;
        }}
        onRunningRunIdChange={setAssistantRunningRunId}
      />
      {showStartupCard ? (
        <StartupLoadingScreen
          servicesLoading={servicesLoading}
          servicesError={servicesError}
          startupServices={startupServices}
          startupRestoreState={resolvedStartupRestoreState}
          timedOut={startupTimedOut}
          onRefresh={() => {
            startupNavigationDoneRef.current = false;
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
    </div>
  );
}

function resolvePluginRouteId(pathname: string) {
  return matchPath("/service/:serviceId", pathname)?.params.serviceId ??
    matchPath("/plugin/:pluginId", pathname)?.params.pluginId ??
    null;
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
    mode: "native"
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
) {
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

function resolveSingleAgentWebclientRoute(pathname: string, search: string) {
  const match = matchPath("/agent/:agentKey", pathname);
  const agentKey = match?.params.agentKey?.trim() ?? "";
  if (!agentKey) {
    return null;
  }

  const params = new URLSearchParams(search);
  const embedParams = new URLSearchParams();
  for (const key of ["chatId", "history", "historyRequest"]) {
    if (params.has(key)) {
      embedParams.set(key, params.get(key)?.trim() ?? "");
    }
  }
  const embedQuery = embedParams.toString();
  return {
    key: "agent-chat",
    routePath: `${pathname}${search}`,
    embedPath: `/agent/${encodeURIComponent(agentKey)}${embedQuery ? `?${embedQuery}` : ""}`,
    label: "智能助理",
    kind: "chat",
    mode: "embedded"
  };
}

function resolveCustomSidebarRouteId(pathname: string) {
  return matchPath("/custom-sidebar/:itemId", pathname)?.params.itemId ?? null;
}
