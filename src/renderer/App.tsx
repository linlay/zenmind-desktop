import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { AssistantPage } from "./pages/AssistantPage";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { ExternalWebviewPage } from "./pages/ExternalWebviewPage";
import { HelpPage } from "./pages/HelpPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { PluginMarketPage } from "./pages/PluginMarketPage";
import { PluginPage } from "./pages/PluginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ServicesProvider } from "./services/ServicesContext";

type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "zenmind-desktop.theme";
const SIDEBAR_STORAGE_KEY = "zenmind-desktop.sidebar";
const EXPERIMENTAL_STORAGE_KEY = "zenmind-desktop.experimental";

export const EXTERNAL_EXPERIMENTAL_ITEMS = [
  { id: "guoxiao", label: "国小君平台", url: "https://gtjaqh.net/home/#/home", icon: "futures" as const },
  { id: "qiuer", label: "秋而工作站", url: "https://station.qiuer.net/", icon: "autumn" as const }
] as const;

const DEFAULT_SIDEBAR_WIDTH = 196;
const MIN_SIDEBAR_WIDTH = 176;
const MAX_SIDEBAR_WIDTH = 340;
const COLLAPSED_SIDEBAR_WIDTH = 76;
const COLLAPSE_THRESHOLD = 118;

type SidebarState = {
  collapsed: boolean;
  width: number;
};

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const appShellRef = useRef<HTMLDivElement | null>(null);
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
        return { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH };
      }
      const parsed = JSON.parse(savedValue) as Partial<SidebarState>;
      const width = typeof parsed.width === "number"
        ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed.width))
        : DEFAULT_SIDEBAR_WIDTH;
      return {
        collapsed: parsed.collapsed === true,
        width
      };
    } catch {
      return { collapsed: false, width: DEFAULT_SIDEBAR_WIDTH };
    }
  });
  const [isSidebarDragging, setIsSidebarDragging] = useState(false);
  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(EXPERIMENTAL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIMENTAL_STORAGE_KEY, experimentalEnabled ? "true" : "false");
    } catch {
      // ignore
    }
  }, [experimentalEnabled]);

  useEffect(() => {
    return window.electronAPI.onNavigate((targetPath) => {
      navigate(targetPath);
    });
  }, [navigate]);

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

  function startSidebarResize(startClientX: number) {
    if (window.innerWidth <= 1080) {
      return;
    }

    sidebarDragMovedRef.current = false;
    sidebarDragStartRef.current = startClientX;
    setIsSidebarDragging(true);
    updateSidebarWidth(resolveSidebarWidth(startClientX));

    const handlePointerMove = (event: PointerEvent) => {
      if (Math.abs(event.clientX - sidebarDragStartRef.current) > 3) {
        sidebarDragMovedRef.current = true;
      }
      updateSidebarWidth(resolveSidebarWidth(event.clientX));
    };

    const handlePointerUp = (event: PointerEvent) => {
      commitSidebarWidth(resolveSidebarWidth(event.clientX));
      setIsSidebarDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function toggleSidebarCollapsed() {
    setSidebarState((current) =>
      current.collapsed
        ? { collapsed: false, width: current.width }
        : { collapsed: true, width: current.width }
    );
  }

  const sidebarWidth = sidebarState.collapsed
    ? COLLAPSED_SIDEBAR_WIDTH
    : sidebarState.width;
  const assistantVisible = location.pathname === "/assistant";

  return (
    <div className="app-shell" ref={appShellRef}>
      <div
        className={[
          "app-sidebar-shell",
          sidebarState.collapsed ? "is-collapsed" : "",
          isSidebarDragging ? "is-resizing" : ""
        ].filter(Boolean).join(" ")}
        style={{ "--app-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <AppSidebar isCollapsed={sidebarState.collapsed} experimentalEnabled={experimentalEnabled} />
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
            startSidebarResize(event.clientX);
          }}
        >
          <span className="app-sidebar-resizer-grip" aria-hidden="true" />
        </button>
      </div>
      <div className="app-content">
        <main className="app-main">
          <div
            className={`app-route-layer assistant-route-layer ${assistantVisible ? "is-active" : "is-hidden"}`}
            aria-hidden={!assistantVisible}
          >
            <AssistantPage hostTheme={themeMode} visible={assistantVisible} />
          </div>
          <div
            className={`app-route-layer ${assistantVisible ? "is-hidden" : "is-active"}`}
            aria-hidden={assistantVisible}
          >
            <Routes>
              <Route path="/" element={<Navigate to="/assistant" replace />} />
              <Route path="/control-center" element={<ControlCenterPage />} />
              <Route
                path="/settings"
                element={
                  <SettingsPage
                    themeMode={themeMode}
                    onToggleTheme={toggleTheme}
                    experimentalEnabled={experimentalEnabled}
                    onToggleExperimental={() => setExperimentalEnabled((v) => !v)}
                  />
                }
              />
              <Route path="/assistant" element={<div className="assistant-route-placeholder" />} />
              <Route
                path="/agents"
                element={
                  <PlaceholderPage
                    title="智能体"
                    description="智能体工作台会在后续核心能力接入后启用。当前先保留独立页面和导航位置。"
                  />
                }
              />
              <Route path="/plugin/:pluginId" element={<PluginPage hostTheme={themeMode} />} />
              {experimentalEnabled
                ? EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => (
                    <Route
                      key={item.id}
                      path={`/external/${item.id}`}
                      element={<ExternalWebviewPage title={item.label} url={item.url} />}
                    />
                  ))
                : null}
              <Route path="/market" element={<PluginMarketPage />} />
              <Route path="/help" element={<HelpPage />} />
            </Routes>
          </div>
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
