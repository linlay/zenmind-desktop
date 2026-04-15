import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";

const staticNavItems = [
  { to: "/control-center", label: "控制中心", icon: "control" },
  { to: "/market", label: "插件市场", icon: "market" },
  { to: "/help", label: "帮助", icon: "help" }
] as const;

type AppSidebarProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  isCollapsed: boolean;
};

function SidebarIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "control":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="7" height="7" rx="2" />
          <rect x="13" y="5" width="7" height="7" rx="2" />
          <rect x="4" y="14" width="7" height="7" rx="2" />
          <path d="M13 17h7" />
          <path d="M16.5 13.5v7" />
        </svg>
      );
    case "assistant":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 9a5 5 0 0 1 10 0v3a5 5 0 0 1-10 0z" />
          <path d="M9 18h6" />
          <path d="M12 18v3" />
          <circle cx="9.5" cy="10.5" r="1" />
          <circle cx="14.5" cy="10.5" r="1" />
        </svg>
      );
    case "market":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 8h14l-1.4 11H6.4z" />
          <path d="M9 8a3 3 0 0 1 6 0" />
          <path d="M9 12h.01" />
          <path d="M15 12h.01" />
        </svg>
      );
    case "help":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2.2-2.5 4" />
          <circle cx="12" cy="17" r="1" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 0 0-.08-1l2.03-1.58-2-3.46-2.4.76a7 7 0 0 0-1.73-1L14.5 3h-5l-.32 2.72a7 7 0 0 0-1.73 1l-2.4-.76-2 3.46L5.08 11A7 7 0 0 0 5 12c0 .34.03.67.08 1l-2.03 1.58 2 3.46 2.4-.76a7 7 0 0 0 1.73 1L9.5 21h5l.32-2.72a7 7 0 0 0 1.73-1l2.4.76 2-3.46L18.92 13c.05-.33.08-.66.08-1z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="4" />
          <path d="M9 12h6" />
          <path d="M12 9v6" />
        </svg>
      );
  }
}

export function AppSidebar({ themeMode, onToggleTheme, isCollapsed }: AppSidebarProps) {
  const { services } = useServices();
  const serviceNavItems = services
    .filter((service) => service.frontendMode === "standalone" && service.status === "running")
    .map((service) => ({
      to: `/plugin/${service.id}`,
      label: service.name,
      icon: service.id === "agent-webclient" ? "assistant" : "service"
    }));

  const navItems = [
    staticNavItems[0],
    ...serviceNavItems,
    ...staticNavItems.slice(1)
  ];

  return (
    <aside className={isCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="app-sidebar-top">
        <div className="sidebar-profile-card">
          <div className="sidebar-avatar" aria-hidden="true">
            <span>Z</span>
          </div>
          <div className="sidebar-profile-copy">
            <h2 className="sidebar-profile-name">ZenMind</h2>
            <p className="sidebar-profile-meta">桌面工作台</p>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Primary Navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive ? "sidebar-link sidebar-link-active" : "sidebar-link"
            }
          >
            <span className="sidebar-link-icon">
              <SidebarIcon kind={item.icon} />
            </span>
            <span className="sidebar-link-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            isActive ? "sidebar-link sidebar-link-active sidebar-link-utility" : "sidebar-link sidebar-link-utility"
          }
        >
          <span className="sidebar-link-icon">
            <SidebarIcon kind="settings" />
          </span>
          <span className="sidebar-link-label">设置</span>
        </NavLink>
        <button
          type="button"
          className="theme-toggle sidebar-theme-toggle"
          onClick={onToggleTheme}
          aria-label={themeMode === "light" ? "切换到黑版" : "切换到白版"}
        >
          <span className="theme-toggle-icon" aria-hidden="true">
            {themeMode === "light" ? "◐" : "◑"}
          </span>
          <span>{themeMode === "light" ? "黑版" : "白版"}</span>
        </button>
      </div>
    </aside>
  );
}
