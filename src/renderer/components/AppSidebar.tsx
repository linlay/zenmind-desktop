import type { MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { EXTERNAL_EXPERIMENTAL_ITEMS } from "../App";
import { BrandMark, CustomSidebarIcon, SidebarIllustration, type SidebarIllustrationKind } from "./BrandMark";
import type { CustomSidebarItem } from "../../shared/contracts";
import { getServiceDisplayName, shouldShowServiceNavigationTab } from "../service-display";

type SidebarNavItem = {
  to: string;
  label: string;
  icon: SidebarIllustrationKind;
  iconId?: string;
};

const staticNavItems: SidebarNavItem[] = [
  { to: "/control-center", label: "控制中心", icon: "control" },
  { to: "/market", label: "插件市场", icon: "market" },
  { to: "/help", label: "帮助", icon: "help" }
];

const assistantNavItem: SidebarNavItem = {
  to: "/plugin/agent-webclient",
  label: "智能助理",
  icon: "assistant"
};

type AppSidebarProps = {
  isCollapsed: boolean;
  currentPath: string;
  pendingPath?: string | null;
  assistantDockOpen?: boolean;
  customSidebarItems: CustomSidebarItem[];
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onRequestNavigate?: (targetPath: string) => boolean;
  onNavigateItem?: () => void;
};

export function AppSidebar({
  isCollapsed,
  currentPath,
  pendingPath,
  assistantDockOpen = false,
  customSidebarItems,
  onOpenAssistantDock,
  onCloseAssistantDock,
  onRequestNavigate,
  onNavigateItem
}: AppSidebarProps) {
  const { services } = useServices();
  const serviceNavItems: SidebarNavItem[] = services
    .filter(shouldShowServiceNavigationTab)
    .map((service) => ({
      to: `/plugin/${service.id}`,
      label: getServiceDisplayName(service.id, service.name),
      icon: "service"
    }));

  const experimentalItems: SidebarNavItem[] = EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => ({
    to: `/external/${item.id}`,
    label: item.label,
    icon: item.icon
  }));

  const customItems: SidebarNavItem[] = customSidebarItems.map((item) => ({
    to: `/custom-sidebar/${item.id}`,
    label: item.label,
    icon: "custom",
    iconId: item.iconId
  }));

  const navItems = [
    assistantNavItem,
    staticNavItems[0],
    ...serviceNavItems,
    ...experimentalItems,
    ...customItems,
    ...staticNavItems.slice(1)
  ];

  function handleItemClick(event: MouseEvent<HTMLAnchorElement>, targetPath: string) {
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (targetPath === currentPath) {
      event.preventDefault();
      return;
    }

    if (onRequestNavigate && !onRequestNavigate(targetPath)) {
      event.preventDefault();
      return;
    }

    onNavigateItem?.();
  }

  function handleAssistantDockClick() {
    onOpenAssistantDock?.();
    onNavigateItem?.();
  }

  return (
    <aside className={isCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="app-sidebar-top">
        <div className="sidebar-profile-card">
          <div className="sidebar-avatar" aria-hidden="true">
            <BrandMark />
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
            onClick={(event) => handleItemClick(event, item.to)}
            className={({ isActive }) =>
              [
                "sidebar-link",
                (isActive || pendingPath === item.to) ? "sidebar-link-active" : ""
              ].filter(Boolean).join(" ")
            }
          >
            <span className="sidebar-link-icon">
              {item.iconId ? <CustomSidebarIcon iconId={item.iconId} /> : <SidebarIllustration kind={item.icon} />}
            </span>
            <span className="sidebar-link-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <NavLink
            to="/settings"
            onClick={(event) => handleItemClick(event, "/settings")}
            className={({ isActive }) =>
              [
                "sidebar-link",
                "sidebar-link-utility",
                !assistantDockOpen && (isActive || pendingPath === "/settings") ? "sidebar-link-active" : ""
              ].filter(Boolean).join(" ")
            }
          >
            <span className="sidebar-link-icon">
              <SidebarIllustration kind="settings" />
            </span>
            <span className="sidebar-link-label">设置</span>
          </NavLink>
          <button
            type="button"
            className={[
              "sidebar-link",
              "sidebar-link-utility",
              "sidebar-assistant-launcher",
              assistantDockOpen ? "sidebar-link-active" : ""
            ].filter(Boolean).join(" ")}
            onClick={handleAssistantDockClick}
            aria-label="打开 ZenMind 助手"
            aria-pressed={assistantDockOpen}
          >
            <span className="sidebar-link-icon">
              <SidebarIllustration kind="assistant" />
            </span>
            <span className="sidebar-link-label">助手</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
