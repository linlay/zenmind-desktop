import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { ExternalWebviewPage } from "./pages/ExternalWebviewPage";
import { HelpPage } from "./pages/HelpPage";
import { PluginMarketPage } from "./pages/PluginMarketPage";
import { PluginPage } from "./pages/PluginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ServicesProvider } from "./services/ServicesContext";
import type { CustomSidebarItem } from "../shared/contracts";

type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "zenmind-desktop.theme";
const SIDEBAR_STORAGE_KEY = "zenmind-desktop.sidebar";
const EXPERIMENTAL_STORAGE_KEY = "zenmind-desktop.experimental";
const DEFAULT_SIDEBAR_WIDTH = 196;
const MIN_SIDEBAR_WIDTH = 176;
const MAX_SIDEBAR_WIDTH = 340;
const COLLAPSED_SIDEBAR_WIDTH = 76;
const COLLAPSE_THRESHOLD = 118;
const MAC_OVERLAY_SIDEBAR_WIDTH = 332;
const ASSISTANT_TARGET_PATH = "/plugin/agent-webclient";

export const EXTERNAL_EXPERIMENTAL_ITEMS = [
  { id: "guoxiao", label: "国小君平台", url: "https://gtjaqh.net/home/#/home", icon: "futures" as const },
  { id: "qiuer", label: "秋而工作站", url: "https://station.qiuer.net/", icon: "autumn" as const }
] as const;

type SidebarState = {
  collapsed: boolean;
  width: number;
};

function isMacOverlaySidebarPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent;

  return /mac/i.test(platform);
}

function SidebarToggleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 4v16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.5 8h1M6.5 12h1M6.5 16h1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const macSidebarShellRef = useRef<HTMLDivElement | null>(null);
  const macSidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidebarResizePointerIdRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const isMacOverlaySidebar = isMacOverlaySidebarPlatform();
  const sidebarDragMovedRef = useRef(false);
  const sidebarDragStartRef = useRef(0);
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
        return { collapsed: isMacOverlaySidebar, width: DEFAULT_SIDEBAR_WIDTH };
      }
      const parsed = JSON.parse(savedValue) as Partial<SidebarState>;
      const width = typeof parsed.width === "number"
        ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed.width))
        : DEFAULT_SIDEBAR_WIDTH;
      return {
        collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : isMacOverlaySidebar,
        width
      };
    } catch {
      return { collapsed: isMacOverlaySidebar, width: DEFAULT_SIDEBAR_WIDTH };
    }
  });
  const [isSidebarDragging, setIsSidebarDragging] = useState(false);
  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(EXPERIMENTAL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [customSidebarItems, setCustomSidebarItems] = useState<CustomSidebarItem[]>([]);

  async function refreshCustomSidebarItems() {
    const result = await window.electronAPI.customSidebar.list();
    if (result.ok) {
      setCustomSidebarItems(result.items);
    }
    return result;
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
    document.documentElement.dataset.theme = themeMode;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore persistence failures and keep the in-memory theme switch usable.
    }
  }, [themeMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(sidebarState));
    } catch {
      // Ignore persistence failures and keep the in-memory sidebar state usable.
    }
  }, [sidebarState]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIMENTAL_STORAGE_KEY, experimentalEnabled ? "true" : "false");
    } catch {
      // Ignore persistence failures and keep the in-memory setting usable.
    }
  }, [experimentalEnabled]);

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
    sidebarResizeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (!isMacOverlaySidebar || sidebarState.collapsed) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (macSidebarShellRef.current?.contains(target) || macSidebarToggleRef.current?.contains(target)) {
        return;
      }

      closeMacOverlaySidebar();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMacOverlaySidebar();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMacOverlaySidebar, sidebarState.collapsed]);

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
    if (isMacOverlaySidebar || window.innerWidth <= 1080) {
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

  function openMacOverlaySidebar() {
    setSidebarState((current) => ({ ...current, collapsed: false }));
  }

  function closeMacOverlaySidebar() {
    setSidebarState((current) => ({ ...current, collapsed: true }));
  }

  const sidebarWidth = sidebarState.collapsed
    ? (isMacOverlaySidebar ? MAC_OVERLAY_SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH)
    : (isMacOverlaySidebar ? MAC_OVERLAY_SIDEBAR_WIDTH : sidebarState.width);
  const experimentalItemMap = new Map(EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => [item.id, item]));
  const customSidebarItemMap = new Map(customSidebarItems.map((item) => [item.id, item]));
  const usesRightCornerToggle =
    isMacOverlaySidebar &&
    (location.pathname.startsWith("/plugin/") ||
      location.pathname.startsWith("/external/") ||
      location.pathname.startsWith("/custom-sidebar/"));
  const showMacOverlayToggle = isMacOverlaySidebar;
  const isMacOverlaySidebarOpen = isMacOverlaySidebar && !sidebarState.collapsed;

  return (
    <div
      className={[
        "app-shell",
        isMacOverlaySidebar ? "is-mac-overlay-sidebar" : "",
        showMacOverlayToggle ? "has-right-corner-toggle" : ""
      ].filter(Boolean).join(" ")}
      ref={appShellRef}
    >
      <div className="app-window-drag-region" aria-hidden="true" />
      {showMacOverlayToggle ? (
        <>
          <button
            ref={macSidebarToggleRef}
            type="button"
            className={[
              "app-sidebar-toggle",
              sidebarState.collapsed ? "" : "is-active"
            ].filter(Boolean).join(" ")}
            aria-label={sidebarState.collapsed ? "打开侧边栏" : "收起侧边栏"}
            aria-expanded={!sidebarState.collapsed}
            onClick={(event) => {
              event.stopPropagation();
              if (sidebarState.collapsed) {
                openMacOverlaySidebar();
                return;
              }
              closeMacOverlaySidebar();
            }}
          >
            <SidebarToggleIcon />
          </button>
        </>
      ) : null}
      <div
        ref={isMacOverlaySidebar ? macSidebarShellRef : undefined}
        className={[
          "app-sidebar-shell",
          !isMacOverlaySidebar && sidebarState.collapsed ? "is-collapsed" : "",
          isMacOverlaySidebarOpen ? "is-open" : "",
          isMacOverlaySidebar ? "is-overlay" : "",
          isSidebarDragging ? "is-resizing" : ""
        ].filter(Boolean).join(" ")}
        style={{ "--app-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="app-sidebar-drag-region" aria-hidden="true" />
        <AppSidebar
          isCollapsed={!isMacOverlaySidebar && sidebarState.collapsed}
          experimentalEnabled={experimentalEnabled}
          customSidebarItems={customSidebarItems}
          onNavigateItem={
            showMacOverlayToggle ? () => closeMacOverlaySidebar() : undefined
          }
        />
        {!isMacOverlaySidebar ? (
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
        ) : null}
      </div>
      <div className="app-content">
        <main className="app-main">
          <div className="app-main-drag-region" aria-hidden="true" />
          <Routes>
            <Route path="/" element={<Navigate to="/control-center" replace />} />
            <Route path="/control-center" element={<ControlCenterPage />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  themeMode={themeMode}
                  onToggleTheme={toggleTheme}
                  experimentalEnabled={experimentalEnabled}
                  onToggleExperimental={() => setExperimentalEnabled((value) => !value)}
                  customSidebarItems={customSidebarItems}
                  onCustomSidebarItemsChange={setCustomSidebarItems}
                  onRefreshCustomSidebarItems={refreshCustomSidebarItems}
                />
              }
            />
            <Route
              path="/assistant"
              element={
                <PlaceholderPage
                  title="小宅助理"
                  description="这里会承接后续的小宅助理桌面入口。本期先完成服务宿主、控制中心和网盘装配。"
                />
              }
            />
            <Route
              path="/agents"
              element={
                <PlaceholderPage
                  title="智能体"
                  description="智能体工作台会在后续核心能力接入后启用。当前先保留独立页面和导航位置。"
                />
              }
            />
            <Route path="/external/:itemId" element={<ExternalItemRoute itemMap={experimentalItemMap} />} />
            <Route path="/custom-sidebar/:itemId" element={<ExternalItemRoute itemMap={customSidebarItemMap} />} />
            <Route path="/plugin/:pluginId" element={<PluginPage hostTheme={themeMode} />} />
            <Route path="/market" element={<PluginMarketPage />} />
            <Route path="/help" element={<HelpPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ServicesProvider>
      <AppShell />
    </ServicesProvider>
  );
}

function ExternalItemRoute({
  itemMap
}: {
  itemMap: Map<string, { label: string; url: string }>;
}) {
  const { itemId = "" } = useParams<{ itemId: string }>();
  const item = itemMap.get(itemId);

  if (!item) {
    return (
      <PlaceholderPage
        title="入口不存在"
        description="没有找到对应的侧边栏入口，请返回设置页检查是否已被删除。"
      />
    );
  }

  return <ExternalWebviewPage title={item.label} url={item.url} />;
}
