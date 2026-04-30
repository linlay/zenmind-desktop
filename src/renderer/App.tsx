import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { ExternalWebviewPage } from "./pages/ExternalWebviewPage";
import { HelpPage } from "./pages/HelpPage";
import { PluginMarketPage } from "./pages/PluginMarketPage";
import { PluginPage } from "./pages/PluginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ServicesProvider, useServices } from "./services/ServicesContext";
import type { CustomSidebarItem, ServiceId, ServiceState, StartupRestoreState } from "../shared/contracts";
import {
  resolveStartupRootPath,
  shouldAutoOpenAssistant,
  shouldShowStartupProgressCard
} from "../shared/startup-gate";
import { AGENT_WEBCLIENT_DISPLAY_NAME, getServiceDisplayName } from "./service-display";

type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "zenmind-desktop.theme";
const SIDEBAR_STORAGE_KEY = "zenmind-desktop.sidebar";
const SIDEBAR_TRANSLUCENCY_STORAGE_KEY = "zenmind-desktop.sidebar-translucency";
const DEFAULT_SIDEBAR_WIDTH = 196;
const MIN_SIDEBAR_WIDTH = 176;
const MAX_SIDEBAR_WIDTH = 340;
const COLLAPSED_SIDEBAR_WIDTH = 64;
const COLLAPSE_THRESHOLD = 118;
const ASSISTANT_TARGET_PATH = "/plugin/agent-webclient";
const SIDEBAR_NAVIGATION_LOCK_MS = 900;
const STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const STARTUP_LOADING_TIMEOUT_MS = 45000;
const STARTUP_STATUS_REFRESH_MS = 1500;

export const EXTERNAL_EXPERIMENTAL_ITEMS = [] as const;

type SidebarState = {
  collapsed: boolean;
  width: number;
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
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const sidebarNavigationUnlockTimerRef = useRef<number | null>(null);
  const sidebarResizePointerIdRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const sidebarDragMovedRef = useRef(false);
  const sidebarDragStartRef = useRef(0);
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
  const [sidebarState, setSidebarState] = useState<SidebarState>(() => {
    if (typeof window === "undefined") {
      return { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH };
    }
    try {
      const savedValue = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (!savedValue) {
        return { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH };
      }
      const parsed = JSON.parse(savedValue) as Partial<SidebarState>;
      const width = typeof parsed.width === "number"
        ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed.width))
        : DEFAULT_SIDEBAR_WIDTH;
      return {
        collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : false,
        width
      };
    } catch {
      return { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH };
    }
  });
  const [sidebarTranslucencyEnabled, setSidebarTranslucencyEnabled] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(SIDEBAR_TRANSLUCENCY_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isSidebarDragging, setIsSidebarDragging] = useState(false);
  const [customSidebarItems, setCustomSidebarItems] = useState<CustomSidebarItem[]>([]);
  const [customSidebarItemsLoaded, setCustomSidebarItemsLoaded] = useState(false);
  const [pendingSidebarNavigationPath, setPendingSidebarNavigationPath] = useState<string | null>(null);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [startupCardDismissed, setStartupCardDismissed] = useState(false);
  const [startupRestoreState, setStartupRestoreState] = useState<StartupRestoreState | null>(null);
  const activePluginId = resolvePluginRouteId(location.pathname);
  const activeCustomSidebarItemId = resolveCustomSidebarRouteId(location.pathname);
  const [mountedPluginIds, setMountedPluginIds] = useState<string[]>(() =>
    activePluginId ? [activePluginId] : []
  );
  const [mountedCustomSidebarItemIds, setMountedCustomSidebarItemIds] = useState<string[]>(() =>
    activeCustomSidebarItemId ? [activeCustomSidebarItemId] : []
  );
  const usesEmbeddedSurface =
    location.pathname.startsWith("/plugin/") ||
    location.pathname.startsWith("/external/") ||
    location.pathname.startsWith("/custom-sidebar/");
  const isMac = desktopPlatform === "darwin";
  const isWindows = desktopPlatform === "win32";
  const startupServices = STARTUP_SERVICE_IDS.map((serviceId) =>
    services.find((service) => service.id === serviceId) ?? null
  );
  const startupAllReady =
    !servicesLoading &&
    startupServices.every((service) => service?.status === "running");
  const resolvedStartupRestoreState = startupRestoreState ?? createFallbackStartupRestoreState();
  const showStartupCard = !startupCardDismissed && shouldShowStartupProgressCard(startupRestoreState, startupAllReady);

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

  useEffect(() => {
    return window.electronAPI.onNavigate((targetPath) => {
      navigate(targetPath);
    });
  }, [navigate]);

  useEffect(() => {
    return window.electronAPI.onOpenAssistantWorker(() => {
      navigate(ASSISTANT_TARGET_PATH);
    });
  }, [navigate]);

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
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore persistence failures and keep the in-memory theme switch usable.
    }
  }, [themeMode]);

  useEffect(() => {
    const shouldApply = isMac && sidebarTranslucencyEnabled;
    document.body.classList.toggle("mac-translucent-sidebar-body", shouldApply);
    if (isMac) {
      try {
        window.localStorage.setItem(
          SIDEBAR_TRANSLUCENCY_STORAGE_KEY,
          sidebarTranslucencyEnabled ? "true" : "false"
        );
      } catch {
        // Ignore persistence failures and keep the in-memory translucency switch usable.
      }
    }
    window.electronAPI.settings.setSidebarTranslucency(shouldApply).catch(() => undefined);

    return () => {
      document.body.classList.remove("mac-translucent-sidebar-body");
    };
  }, [isMac, sidebarTranslucencyEnabled]);

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
    if (!isSidebarDragging) {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      return;
    }
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, [isSidebarDragging]);

  useEffect(() => () => {
    if (sidebarNavigationUnlockTimerRef.current !== null) {
      window.clearTimeout(sidebarNavigationUnlockTimerRef.current);
    }
    sidebarResizeCleanupRef.current?.();
  }, []);

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

  function updateSidebarWidth(nextWidth: number) {
    setSidebarState((current) => ({
      collapsed: nextWidth <= COLLAPSE_THRESHOLD,
      width: current.collapsed && nextWidth > COLLAPSE_THRESHOLD
        ? Math.max(MIN_SIDEBAR_WIDTH, nextWidth)
        : nextWidth > COLLAPSE_THRESHOLD
          ? nextWidth
          : current.width
    }));
  }

  function resolveSidebarWidth(clientX: number) {
    const shellLeft = appShellRef.current?.getBoundingClientRect().left ?? 0;
    const rawWidth = clientX - shellLeft;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(COLLAPSED_SIDEBAR_WIDTH, rawWidth));
  }

  function commitSidebarWidth(rawWidth: number) {
    if (rawWidth <= COLLAPSE_THRESHOLD) {
      setSidebarState((current) => ({
        collapsed: true,
        width: current.width
      }));
      return;
    }
    setSidebarState({
      collapsed: false,
      width: Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, rawWidth))
    });
  }

  function startSidebarResize(startClientX: number, pointerId: number, handle: HTMLButtonElement) {
    if (window.innerWidth <= 1080) {
      return;
    }

    sidebarResizeCleanupRef.current?.();
    sidebarDragMovedRef.current = false;
    sidebarDragStartRef.current = startClientX;
    sidebarResizePointerIdRef.current = pointerId;
    setIsSidebarDragging(true);
    updateSidebarWidth(resolveSidebarWidth(startClientX));

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Some platforms may reject pointer capture for transient pointer state changes.
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== sidebarResizePointerIdRef.current) {
        return;
      }
      if (Math.abs(event.clientX - sidebarDragStartRef.current) > 3) {
        sidebarDragMovedRef.current = true;
      }
      updateSidebarWidth(resolveSidebarWidth(event.clientX));
    };

    const finishResize = (clientX?: number) => {
      const finalWidth = resolveSidebarWidth(clientX ?? sidebarDragStartRef.current);
      commitSidebarWidth(finalWidth);
      setIsSidebarDragging(false);
      sidebarResizePointerIdRef.current = null;
      sidebarResizeCleanupRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
      handle.removeEventListener("lostpointercapture", handleLostPointerCapture);
      try {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore if capture is already gone.
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== sidebarResizePointerIdRef.current) {
        return;
      }
      finishResize(event.clientX);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== sidebarResizePointerIdRef.current) {
        return;
      }
      finishResize(event.clientX);
    };

    const handleLostPointerCapture = () => {
      if (sidebarResizePointerIdRef.current !== pointerId) {
        return;
      }
      finishResize();
    };

    const handleWindowBlur = () => {
      if (sidebarResizePointerIdRef.current !== pointerId) {
        return;
      }
      finishResize();
    };

    sidebarResizeCleanupRef.current = () => finishResize();
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);
    handle.addEventListener("lostpointercapture", handleLostPointerCapture);
  }

  function toggleSidebarCollapsed() {
    setSidebarState((current) =>
      current.collapsed
        ? { collapsed: false, width: current.width }
        : { collapsed: true, width: current.width }
    );
  }

  function requestSidebarNavigation(targetPath: string) {
    if (targetPath === location.pathname) {
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

  const sidebarWidth = sidebarState.collapsed
    ? COLLAPSED_SIDEBAR_WIDTH
    : sidebarState.width;
  const experimentalItemMap = new Map(EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => [item.id, item]));
  const customSidebarItemMap = new Map(customSidebarItems.map((item) => [item.id, item]));

  return (
    <div
      className={[
        "app-shell",
        usesEmbeddedSurface ? "has-embedded-surface" : "",
        isMac && sidebarTranslucencyEnabled ? "is-mac-translucent-sidebar" : ""
      ].filter(Boolean).join(" ")}
      ref={appShellRef}
      style={{ "--app-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="app-window-drag-region" aria-hidden="true" />
      <div
        className={[
          "app-sidebar-shell",
          sidebarState.collapsed ? "is-collapsed" : "",
          isSidebarDragging ? "is-resizing" : ""
        ].filter(Boolean).join(" ")}
        style={{ "--app-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="app-sidebar-drag-region" aria-hidden="true" />
        <AppSidebar
          isCollapsed={sidebarState.collapsed}
          currentPath={location.pathname}
          pendingPath={pendingSidebarNavigationPath}
          customSidebarItems={customSidebarItems}
          onRequestNavigate={requestSidebarNavigation}
          onNavigateItem={undefined}
        />
        <button
          type="button"
          className="app-sidebar-resizer"
          aria-label={sidebarState.collapsed ? "展开侧边栏" : "调整或收起侧边栏"}
          onClick={() => {
            if (sidebarDragMovedRef.current) {
              sidebarDragMovedRef.current = false;
              return;
            }
            toggleSidebarCollapsed();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            if (!event.isPrimary || event.button !== 0) {
              return;
            }
            startSidebarResize(event.clientX, event.pointerId, event.currentTarget);
          }}
        >
          <span className="app-sidebar-resizer-grip" aria-hidden="true" />
        </button>
      </div>
      <div className="app-content">
        <main className="app-main">
          <div className="app-main-drag-region" aria-hidden="true" />
          <PluginSurfaceHost
            activePluginId={activePluginId}
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
                  sidebarTranslucencyEnabled={isMac && sidebarTranslucencyEnabled}
                  onToggleSidebarTranslucency={() => setSidebarTranslucencyEnabled((current) => !current)}
                  customSidebarItems={customSidebarItems}
                  onCustomSidebarItemsChange={updateCustomSidebarItems}
                  onRefreshCustomSidebarItems={refreshCustomSidebarItems}
                />
              }
            />
            <Route
              path="/assistant"
              element={
                <PlaceholderPage
                  title={AGENT_WEBCLIENT_DISPLAY_NAME}
                  description="桌面端助理功能建设中，敬请期待。"
                />
              }
            />
            <Route
              path="/agents"
              element={
                <PlaceholderPage
                  title="智能体"
                  description="智能体工作台建设中，敬请期待。"
                />
              }
            />
            <Route path="/external/:itemId" element={<ExternalItemRoute itemMap={experimentalItemMap} />} />
            <Route path="/custom-sidebar/:itemId" element={<CustomSidebarRouteFallback itemMap={customSidebarItemMap} />} />
            <Route path="/plugin/:pluginId" element={null} />
            <Route path="/market" element={<PluginMarketPage />} />
            <Route path="/help" element={<HelpPage isWindows={isWindows} />} />
          </Routes>
        </main>
      </div>
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

  return (
    <div className="startup-loading-screen">
      <div className="startup-loading-card">
        <div className="startup-loading-mark" aria-hidden="true">Z</div>
        <p className="eyebrow">STARTING UP</p>
        <h1>{hasFailure ? "部分核心服务未就绪" : timedOut ? "准备较慢" : "正在准备 ZenMind"}</h1>
        <p className="page-copy">
          {hasFailure
            ? "后台准备没有全部完成。你可以继续查看系统，或前往控制中心修复失败的服务。"
            : timedOut
              ? "后台准备时间比预期更长。你可以继续等待，或进入控制中心排查。"
              : activeAction?.message || "正在后台准备核心服务，完成后将自动进入助理。"}
        </p>

        <div className="startup-loading-progress" aria-hidden="true">
          <span
            className="startup-loading-progress-bar"
            style={{ width: `${(readyCount / Math.max(totalCount, 1)) * 100}%` }}
          />
        </div>

        <div className="startup-loading-summary">
          <strong>{readyCount}/{totalCount}</strong>
          <span>核心服务已就绪</span>
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
  return (
    <ServicesProvider>
      <AppShell />
    </ServicesProvider>
  );
}

function resolvePluginRouteId(pathname: string) {
  return matchPath("/plugin/:pluginId", pathname)?.params.pluginId ?? null;
}

function resolveCustomSidebarRouteId(pathname: string) {
  return matchPath("/custom-sidebar/:itemId", pathname)?.params.itemId ?? null;
}

function PluginSurfaceHost({
  activePluginId,
  hostTheme,
  mountedPluginIds
}: {
  activePluginId: string | null;
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
          hostTheme={hostTheme}
          pluginId={pluginId}
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
        description="该侧边栏入口不存在或已被删除，请在设置中检查。"
      />
    );
  }

  return <ExternalWebviewPage title={item.label} url={item.url} />;
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
      description="该侧边栏入口不存在或已被删除，请在设置中检查。"
    />
  );
}
