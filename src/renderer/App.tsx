import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { DesktopPet } from "./components/DesktopPet";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { ExternalWebviewPage } from "./pages/ExternalWebviewPage";
import { HelpPage } from "./pages/HelpPage";
import { LogViewerPage } from "./pages/LogViewerPage";
import { PluginMarketPage } from "./pages/PluginMarketPage";
import { PluginPage } from "./pages/PluginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ServicesProvider, useServices } from "./services/ServicesContext";
import { getAssistantPageContext } from "./services/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "./services/currentPageContext";
import {
  registerDesktopActionProviderForScope,
  startDesktopActionRendererBridge
} from "./services/desktopActionRegistry";
import type { AssistantSettingsPublic, AssistantWorkerOpenRequest, CustomSidebarItem, ServiceId, ServiceState, StartupRestoreState } from "../shared/contracts";
import {
  DEFAULT_DESKTOP_HELPER_AGENT_KEY,
  DEFAULT_QUICK_ASSISTANT_AGENT_KEY,
  DESKTOP_COPILOT_PAGE_KEYS,
  DESKTOP_COPILOT_PAGE_LABELS
} from "../shared/assistant-settings";
import {
  resolveDesktopCopilotPreference,
  sanitizeDesktopCopilotPagePreferences
} from "../shared/page-copilot";
import {
  resolveStartupRootPath,
  shouldAutoOpenAssistant,
  shouldShowStartupProgressCard
} from "../shared/startup-gate";
import { formatStartupStatusText } from "../shared/startup-status";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../shared/browser-surfaces";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_MAX_WIDTH,
  normalizeSidebarLayoutState,
  resolveRenderedSidebarWidth,
  resolveSidebarLayoutStateFromDrag,
  toggleSidebarLayoutState,
  type SidebarLayoutState
} from "../shared/sidebar-layout";
import { AGENT_WEBCLIENT_DISPLAY_NAME, getServiceDisplayName, shouldShowServiceNavigationTab } from "./service-display";
import {
  createCustomSidebarNavOrderKey,
  createDefaultSidebarNavOrderItems,
  createExperimentalSidebarNavOrderKey,
  createServiceSidebarNavOrderKey,
  normalizeSidebarNavOrder,
  type SidebarNavOrderItem,
  type SidebarNavOrderItemKey
} from "./sidebarNavOrder";

type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "zenmind-desktop.theme";
const SIDEBAR_STORAGE_KEY = "zenmind-desktop.sidebar";
const SIDEBAR_NAV_ORDER_STORAGE_KEY = "zenmind-desktop.sidebar-nav-order";
const ASSISTANT_TARGET_PATH = "/service/agent-webclient";
const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";
const SIDEBAR_NAVIGATION_LOCK_MS = 900;
const STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const STARTUP_LOADING_TIMEOUT_MS = 45000;
const AGENT_WEBCLIENT_ROUTE_ITEMS = [
  { routePath: "/agents", embedPath: "/agents", label: "智能体" },
  { routePath: "/schedules", embedPath: "/schedules", label: "自动化" },
  { routePath: "/memory", embedPath: "/memory", label: "记忆管理" }
] as const;

const STARTUP_STATUS_REFRESH_MS = 1500;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readSettingsPatch(args: Record<string, unknown>) {
  return asRecord(args.patch);
}

export const EXTERNAL_EXPERIMENTAL_ITEMS = [] as const;

type SidebarResizeDragState = {
  initialState: SidebarLayoutState;
  startClientX: number;
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

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { services, loading: servicesLoading, error: servicesError, refresh: refreshServices } = useServices();
  const sidebarNavigationUnlockTimerRef = useRef<number | null>(null);
  const sidebarResizeStateRef = useRef<SidebarResizeDragState | null>(null);
  const assistantDockOpenRequestPathRef = useRef<string | null>(null);
  const startupNavigationDoneRef = useRef(false);
  const refreshServicesRef = useRef(refreshServices);
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
  const [sidebarNavOrder, setSidebarNavOrder] = useState<SidebarNavOrderItemKey[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }
    try {
      const savedValue = window.localStorage.getItem(SIDEBAR_NAV_ORDER_STORAGE_KEY);
      return savedValue ? JSON.parse(savedValue) as SidebarNavOrderItemKey[] : [];
    } catch {
      return [];
    }
  });
  const [assistantDockOpen, setAssistantDockOpen] = useState(false);
  const [assistantDockOpenRequest, setAssistantDockOpenRequest] = useState<AssistantWorkerOpenRequest | null>(null);
  const [assistantRunningRunId, setAssistantRunningRunId] = useState<string | null>(null);
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [nativeDialogVisible, setNativeDialogVisible] = useState(false);
  const [customSidebarItems, setCustomSidebarItems] = useState<CustomSidebarItem[]>([]);
  const [customSidebarItemsLoaded, setCustomSidebarItemsLoaded] = useState(false);
  const [pendingSidebarNavigationPath, setPendingSidebarNavigationPath] = useState<string | null>(null);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [startupCardDismissed, setStartupCardDismissed] = useState(false);
  const [startupRestoreState, setStartupRestoreState] = useState<StartupRestoreState | null>(null);
  const activeAgentWebclientRoute = resolveAgentWebclientRoute(location.pathname);
  const activePluginId = activeAgentWebclientRoute
    ? "agent-webclient"
    : resolvePluginRouteId(location.pathname);
  const activeCustomSidebarItemId = resolveCustomSidebarRouteId(location.pathname);
  const [mountedPluginIds, setMountedPluginIds] = useState<string[]>(() =>
    activePluginId ? [activePluginId] : []
  );
  const [mountedCustomSidebarItemIds, setMountedCustomSidebarItemIds] = useState<string[]>(() =>
    activeCustomSidebarItemId ? [activeCustomSidebarItemId] : []
  );
  const usesEmbeddedSurface =
    Boolean(activeAgentWebclientRoute) ||
    location.pathname.startsWith("/service/") ||
    location.pathname.startsWith("/plugin/") ||
    location.pathname.startsWith("/external/") ||
    location.pathname === BUILTIN_BROWSER_ROUTE ||
    location.pathname.startsWith("/custom-sidebar/");
  const usesPluginSurface =
    Boolean(activeAgentWebclientRoute) ||
    location.pathname.startsWith("/service/") ||
    location.pathname.startsWith("/plugin/");
  const isMarketRoute = location.pathname === "/market";
  const usesStandardBaseSurface =
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
  const resolvedStartupRestoreState = startupRestoreState ?? createFallbackStartupRestoreState();
  const showStartupCard = !startupCardDismissed && shouldShowStartupProgressCard(startupRestoreState, startupAllReady);
  const customSidebarItemMap = useMemo(() => new Map(customSidebarItems.map((item) => [item.id, item])), [customSidebarItems]);
  const currentCopilotPreference = resolveDesktopCopilotPreference(assistantSettings?.desktopCopilotPages, location.pathname);
  const customSidebarAgentKey = activeCustomSidebarItemId
    ? customSidebarItemMap.get(activeCustomSidebarItemId)?.agentKey || ""
    : "";
  const resolvedCopilotAgentKey = customSidebarAgentKey || currentCopilotPreference?.agentKey || "";
  const assistantLauncherVisible = currentCopilotPreference?.enabled !== false;
  const isAgentWebclientMainRoute = location.pathname === ASSISTANT_TARGET_PATH;
  const assistantCopilotOpen = assistantDockOpen && !isAgentWebclientMainRoute;
  const sidebarCollapsed = sidebarState.mode === "collapsed";
  const renderedSidebarWidth = resolveRenderedSidebarWidth(sidebarState);
  const availableSidebarNavOrderItems = useMemo<SidebarNavOrderItem[]>(() => {
    const serviceItems = services
      .filter(shouldShowServiceNavigationTab)
      .map((service) => ({
        key: createServiceSidebarNavOrderKey(service.id),
        label: getServiceDisplayName(service.id, service.name)
      }));
    const experimentalItems = EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => ({
      key: createExperimentalSidebarNavOrderKey(item.id),
      label: item.label
    }));
    const customItems = customSidebarItems.map((item) => ({
      key: createCustomSidebarNavOrderKey(item.id),
      label: item.label
    }));
    return createDefaultSidebarNavOrderItems({
      serviceItems,
      experimentalItems,
      customItems
    });
  }, [customSidebarItems, services]);
  const normalizedSidebarNavOrder = useMemo(
    () => normalizeSidebarNavOrder(sidebarNavOrder, availableSidebarNavOrderItems),
    [availableSidebarNavOrderItems, sidebarNavOrder]
  );

  async function refreshCustomSidebarItems() {
    const result = await window.electronAPI.customSidebar.list();
    if (result.ok) {
      updateCustomSidebarItems(result.items);
    }
    return result;
  }

  function updateCustomSidebarItems(items: CustomSidebarItem[]) {
    setCustomSidebarItems(items);
    setCustomSidebarItemsLoaded(true);
  }

  async function refreshStartupRestoreState() {
    const nextState = await window.electronAPI.services.getStartupRestoreState();
    setStartupRestoreState(nextState);
    return nextState;
  }

  function openAssistantDock() {
    if (isAgentWebclientMainRoute) {
      return;
    }
    setAssistantDockOpen(true);
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
    if (currentCopilotPreference?.enabled === false && assistantDockOpen && !assistantRunningRunId) {
      setAssistantDockOpen(false);
    }
  }, [assistantDockOpen, assistantRunningRunId, currentCopilotPreference?.enabled]);

  useEffect(() => {
    if (isAgentWebclientMainRoute && assistantDockOpen) {
      setAssistantDockOpen(false);
      setAssistantDockOpenRequest(null);
      assistantDockOpenRequestPathRef.current = null;
    }
  }, [assistantDockOpen, isAgentWebclientMainRoute]);

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
      assistantDockOpenRequestPathRef.current = location.pathname;
      setAssistantDockOpenRequest(request);
      openAssistantDock();
    });
  }, [location.pathname]);

  useEffect(() => {
    return window.electronAPI.onNativeDialogVisibility((state) => {
      setNativeDialogVisible(state.platform === "darwin" && state.open);
    });
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
      !shouldAutoOpenAssistant(startupRestoreState, startupAllReady) ||
      startupNavigationDoneRef.current
    ) {
      return;
    }

    startupNavigationDoneRef.current = true;
    setStartupTimedOut(false);
    navigate(ASSISTANT_TARGET_PATH, { replace: true });
  }, [navigate, startupAllReady, startupRestoreState]);

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
      })
      .catch(() => undefined);

    const removeListener = window.electronAPI.onStartupRestoreState((nextState) => {
      if (cancelled) {
        return;
      }
      setStartupRestoreState(nextState);
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

    if (location.pathname !== pendingSidebarNavigationPath) {
      return;
    }

    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, 220);
  }, [location.pathname, pendingSidebarNavigationPath]);

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

    setPendingSidebarNavigationPath(targetPath);
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarNavigationUnlockTimerRef.current = window.setTimeout(() => {
      setPendingSidebarNavigationPath(null);
      sidebarNavigationUnlockTimerRef.current = null;
    }, SIDEBAR_NAVIGATION_LOCK_MS);
    return true;
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
        usesPluginSurface ? "has-plugin-surface" : "",
        isMarketRoute ? "has-market-controls" : "",
        usesStandardBaseSurface ? "has-standard-base-surface" : "",
        assistantCopilotOpen ? "has-assistant-dock" : "",
        assistantCopilotOpen ? "has-assistant-dock-full" : "",
        isMac ? "is-mac-platform" : "",
        isWindows ? "is-windows-platform" : "",
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
          pendingPath={pendingSidebarNavigationPath}
          assistantDockOpen={assistantCopilotOpen}
          assistantLauncherDisabled={isAgentWebclientMainRoute}
          assistantLauncherVisible={assistantLauncherVisible}
          sidebarNavOrder={normalizedSidebarNavOrder}
          customSidebarItems={customSidebarItems}
          onOpenAssistantDock={() => openAssistantDock()}
          onCloseAssistantDock={() => setAssistantDockOpen(false)}
          onRequestNavigate={requestSidebarNavigation}
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
            activeAgentWebclientRoute={activeAgentWebclientRoute}
            hostTheme={themeMode}
            mountedPluginIds={mountedPluginIds}
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
            <Route path="/control-center" element={<ControlCenterPage />} />
            <Route
              path="/settings"
              element={
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
              }
            />
            <Route
              path="/assistant"
              element={<Navigate to={ASSISTANT_TARGET_PATH} replace />}
            />
            <Route path="/agents" element={null} />
            <Route path="/schedules" element={null} />
            <Route path="/memory" element={null} />
            <Route path="/external/:itemId" element={<ExternalItemRoute itemMap={experimentalItemMap} />} />
            <Route
              path={BUILTIN_BROWSER_ROUTE}
              element={
                <ExternalWebviewPage
                  surfaceId={BUILTIN_BROWSER_SURFACE_ID}
                  surfaceLabel={BUILTIN_BROWSER_SURFACE_LABEL}
                  title={BUILTIN_BROWSER_SURFACE_LABEL}
                  url={BUILTIN_BROWSER_DEFAULT_URL}
                />
              }
            />
            <Route path="/custom-sidebar/:itemId" element={<CustomSidebarRouteFallback itemMap={customSidebarItemMap} />} />
            <Route path="/service/:serviceId" element={null} />
            <Route path="/plugin/:pluginId" element={null} />
            <Route path="/market" element={<PluginMarketPage />} />
            <Route path="/help" element={<HelpPage isWindows={isWindows} />} />
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
          setAssistantDockOpen(false);
          setAssistantDockOpenRequest(null);
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
    </div>
  );
}

function RootRouteRedirect({
  startupRestoreState,
  startupAllReady
}: {
  startupRestoreState: StartupRestoreState | null;
  startupAllReady: boolean;
}) {
  const targetPath = resolveStartupRootPath(startupRestoreState, startupAllReady);
  if (!targetPath) {
    return null;
  }

  return <Navigate to={targetPath} replace />;
}

function StartupLoadingScreen({
  servicesLoading,
  servicesError,
  startupServices,
  startupRestoreState,
  timedOut,
  onRefresh,
  onOpenControlCenter
}: {
  servicesLoading: boolean;
  servicesError: string;
  startupServices: Array<ServiceState | null>;
  startupRestoreState: StartupRestoreState;
  timedOut: boolean;
  onRefresh: () => void;
  onOpenControlCenter: () => void;
}) {
  const readyCount = startupRestoreState.services.filter((service) => service.phase === "succeeded").length;
  const totalCount = startupRestoreState.serviceOrder.length;
  const hasFailure = startupRestoreState.phase === "failed";
  const activeAction = startupRestoreState.services.find((service) =>
    service.phase === "installing" || service.phase === "initializing" || service.phase === "starting"
  );
  const activeService = activeAction
    ? startupServices[startupRestoreState.serviceOrder.indexOf(activeAction.serviceId)] ?? null
    : null;
  const activeServiceName = activeAction
    ? activeService
      ? getServiceDisplayName(activeService.id, activeService.name)
      : getStartupServiceFallbackName(activeAction.serviceId)
    : "";
  const title = hasFailure ? "服务未就绪" : timedOut ? "启动较慢" : "正在启动";
  const statusText = hasFailure
    ? "有核心服务需要处理"
    : timedOut
      ? "核心服务仍在响应中"
      : activeAction
        ? formatStartupStatusText(activeServiceName, activeAction.message)
        : "正在准备核心服务";

  return (
    <div className="startup-loading-screen">
      <div className="startup-loading-card">
        <div className="startup-loading-mark" aria-hidden="true">Z</div>
        <h1>{title}</h1>
        <p className="startup-loading-status">{statusText}</p>

        <div className="startup-loading-progress" aria-hidden="true">
          <span
            className="startup-loading-progress-bar"
            style={{ width: `${(readyCount / Math.max(totalCount, 1)) * 100}%` }}
          />
        </div>

        <div className="startup-loading-summary">
          <strong>{readyCount}/{totalCount}</strong>
          <span>已就绪</span>
        </div>

        <div className="startup-loading-list">
          {startupRestoreState.serviceOrder.map((serviceId, index) => {
            const fallbackId = serviceId as ServiceId;
            const service = startupServices[index] ?? null;
            const startupServiceState = startupRestoreState.services.find((item) => item.serviceId === fallbackId);
            const displayName = service
              ? getServiceDisplayName(service.id, service.name)
              : getStartupServiceFallbackName(fallbackId);
            const previousServicesReady = startupRestoreState.serviceOrder
              .slice(0, index)
              .every((previousServiceId) => {
                const previousServiceState = startupRestoreState.services.find((item) => item.serviceId === previousServiceId);
                return previousServiceState?.phase === "succeeded";
              });
            const startupPhase = startupServiceState?.phase ?? "pending";
            const isActiveStartupService =
              !timedOut && (
                startupPhase === "installing" ||
                startupPhase === "initializing" ||
                startupPhase === "starting"
              );
            const isReady = startupPhase === "succeeded";
            const isFailed = startupPhase === "failed";
            const statusLabel = isReady
              ? "已就绪"
              : isFailed
                ? "启动失败"
                : startupPhase === "installing"
                  ? "安装中..."
                  : startupPhase === "initializing"
                    ? "初始化中..."
                : isActiveStartupService
                  ? "启动中..."
                  : !previousServicesReady
                    ? "等待前序服务"
                    : servicesLoading && startupRestoreState.phase === "idle"
                      ? "读取中..."
                      : "等待启动";

            return (
              <div className="startup-loading-item" key={fallbackId}>
                <span
                  className={[
                    "startup-loading-dot",
                    isReady ? "is-ready" : "",
                    isActiveStartupService && !isReady ? "is-active" : "",
                    isFailed ? "is-failed" : ""
                  ].filter(Boolean).join(" ")}
                  aria-hidden="true"
                />
                <div className="startup-loading-copy">
                  <strong>{displayName}</strong>
                  <span>{statusLabel}</span>
                </div>
              </div>
            );
          })}
        </div>

        {startupRestoreState.phase === "failed" && startupRestoreState.message ? (
          <div className="startup-loading-error">{startupRestoreState.message}</div>
        ) : null}
        {servicesError ? <div className="startup-loading-error">{servicesError}</div> : null}

        {timedOut || hasFailure ? (
          <div className="startup-loading-actions">
            <button type="button" className="action-button" onClick={onRefresh}>
              重新检查
            </button>
            <button type="button" className="text-button" onClick={onOpenControlCenter}>
              进入控制中心
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentWebclientCopilotDock({
  open,
  hostTheme,
  nativeDialogVisible,
  openRequest,
  resolvedAgentKey,
  onClose,
  onRunningRunIdChange
}: {
  open: boolean;
  hostTheme: ThemeMode;
  nativeDialogVisible: boolean;
  openRequest: AssistantWorkerOpenRequest | null;
  resolvedAgentKey: string;
  onClose: () => void;
  onRunningRunIdChange: (runId: string | null) => void;
}) {
  const targetAgentKey = openRequest?.agentKey ?? openRequest?.workerKey ?? resolvedAgentKey;

  useEffect(() => {
    if (!open) {
      onRunningRunIdChange(null);
    }
  }, [onRunningRunIdChange, open]);

  return (
    <aside
      className={[
        "agent-webclient-copilot-dock",
        open ? "is-open" : "",
        nativeDialogVisible ? "is-native-dialog-open" : ""
      ].filter(Boolean).join(" ")}
      aria-hidden={!open}
      data-open-chat-id={openRequest?.chatId ?? ""}
      data-open-agent-key={targetAgentKey}
    >
      <PluginPage
        key={`agent-webclient-copilot:${targetAgentKey}`}
        active={open}
        embedPath={AGENT_WEBCLIENT_COPILOT_PATH}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceLabel="助手"
        skipContextRegistration
      />
      <button
        type="button"
        className="agent-webclient-copilot-close"
        onClick={onClose}
        aria-label="关闭助手"
        title="关闭"
      >
        <span aria-hidden="true" />
      </button>
    </aside>
  );
}

function readStoredThemeMode() {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function QuickAssistantWebCopilot() {
  const { services, loading, error, refresh } = useServices();
  const [hostTheme, setHostTheme] = useState<ThemeMode>(() => readStoredThemeMode());
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const startupServices = STARTUP_SERVICE_IDS.map((serviceId) =>
    services.find((service) => service.id === serviceId) ?? null
  );
  const allReady = !loading && startupServices.every((service) => service?.status === "running");
  const failedService = startupServices.find((service) => service && service.status !== "running");

  useEffect(() => {
    document.body.classList.add("quick-web-copilot-body");
    return () => {
      document.body.classList.remove("quick-web-copilot-body");
    };
  }, []);

  useEffect(() => {
    const nextTheme = readStoredThemeMode();
    setHostTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.assistant.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setAssistantSettings(settings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAssistantSettings(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const quickAssistantAgentKey = assistantSettings?.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY;

  if (!allReady) {
    return (
      <main className="quick-web-copilot-status" aria-live="polite">
        <div className="quick-web-copilot-status-panel">
          <strong>{error || failedService ? "智能助理暂未就绪" : "正在启动智能助理"}</strong>
          <span>
            {error ||
              failedService?.message ||
              "ZenMind 正在恢复认证、智能体平台和 Web Copilot 服务。"}
          </span>
          <div className="quick-web-copilot-status-actions">
            <button type="button" onClick={() => void refresh()}>
              重新检查
            </button>
            <button type="button" onClick={() => void window.electronAPI.quickAssistant.openControlCenter()}>
              控制中心
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="quick-web-copilot">
      <PluginPage
        active
        embedPath={AGENT_WEBCLIENT_COPILOT_PATH}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceLabel="助手"
      />
      <span className="quick-web-copilot-agent-marker" data-open-agent-key={quickAssistantAgentKey} aria-hidden="true" />
    </main>
  );
}

function getStartupServiceFallbackName(serviceId: ServiceId) {
  switch (serviceId) {
    case "zenmind-app-server":
      return "认证服务";
    case "agent-platform":
      return "智能体平台";
    case "agent-webclient":
      return AGENT_WEBCLIENT_DISPLAY_NAME;
    default:
      return serviceId;
  }
}

export function App() {
  const location = useLocation();
  if (location.pathname === "/quick-assistant") {
    return (
      <ServicesProvider>
        <QuickAssistantWebCopilot />
      </ServicesProvider>
    );
  }
  if (location.pathname === DESKTOP_PET_ROUTE) {
    return <DesktopPet />;
  }
  if (location.pathname === "/log-viewer") {
    return (
      <ServicesProvider>
        <LogViewerPage />
      </ServicesProvider>
    );
  }

  return (
    <ServicesProvider>
      <AppShell />
    </ServicesProvider>
  );
}

function resolvePluginRouteId(pathname: string) {
  return matchPath("/service/:serviceId", pathname)?.params.serviceId ??
    matchPath("/plugin/:pluginId", pathname)?.params.pluginId ??
    null;
}

function resolveAgentWebclientRoute(pathname: string) {
  return AGENT_WEBCLIENT_ROUTE_ITEMS.find((item) => item.routePath === pathname) ?? null;
}

function resolveCustomSidebarRouteId(pathname: string) {
  return matchPath("/custom-sidebar/:itemId", pathname)?.params.itemId ?? null;
}

function PluginSurfaceHost({
  activePluginId,
  activeAgentWebclientRoute,
  hostTheme,
  mountedPluginIds
}: {
  activePluginId: string | null;
  activeAgentWebclientRoute: (typeof AGENT_WEBCLIENT_ROUTE_ITEMS)[number] | null;
  hostTheme: ThemeMode;
  mountedPluginIds: string[];
}) {
  if (mountedPluginIds.length === 0) {
    return null;
  }

  return (
    <>
      {/* Keep embedded plugin browsing contexts mounted so sidebar switches do not tear down live sessions. */}
      {mountedPluginIds.map((pluginId) => (
        <PluginPage
          key={pluginId}
          active={activePluginId === pluginId}
          embedPath={pluginId === "agent-webclient" ? activeAgentWebclientRoute?.embedPath : undefined}
          hostTheme={hostTheme}
          pluginId={pluginId}
          surfaceLabel={pluginId === "agent-webclient" ? activeAgentWebclientRoute?.label : undefined}
        />
      ))}
    </>
  );
}

type EmbeddedSidebarItem = {
  label: string;
  url: string;
};

function CustomSidebarSurfaceHost({
  activeItemId,
  itemMap,
  mountedItemIds
}: {
  activeItemId: string | null;
  itemMap: Map<string, EmbeddedSidebarItem>;
  mountedItemIds: string[];
}) {
  const visibleItemIds =
    activeItemId && itemMap.has(activeItemId) && !mountedItemIds.includes(activeItemId)
      ? [...mountedItemIds, activeItemId]
      : mountedItemIds;

  if (visibleItemIds.length === 0) {
    return null;
  }

  return (
    <>
      {visibleItemIds.map((itemId) => {
        const item = itemMap.get(itemId);
        if (!item) {
          return null;
        }

        return (
          <ExternalWebviewPage
            key={itemId}
            active={activeItemId === itemId}
            surfaceId={itemId}
            surfaceLabel={item.label}
            title={item.label}
            url={item.url}
          />
        );
      })}
    </>
  );
}

function ExternalItemRoute({
  itemMap
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
}) {
  const { itemId = "" } = useParams<{ itemId: string }>();
  const item = itemMap.get(itemId);

  if (!item) {
    return (
      <PlaceholderPage
        title="入口不存在"
        description="该内嵌网站不存在或已被删除，请在设置中检查。"
      />
    );
  }

  return <ExternalWebviewPage surfaceId={itemId} surfaceLabel={item.label} title={item.label} url={item.url} />;
}

function CustomSidebarRouteFallback({
  itemMap
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
}) {
  const { itemId = "" } = useParams<{ itemId: string }>();
  if (itemMap.has(itemId)) {
    return null;
  }

  return (
    <PlaceholderPage
      title="入口不存在"
      description="该内嵌网站不存在或已被删除，请在设置中检查。"
    />
  );
}
