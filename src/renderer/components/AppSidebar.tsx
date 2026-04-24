import type { MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { EXTERNAL_EXPERIMENTAL_ITEMS } from "../App";
import { BrandMark, CustomSidebarIcon, SidebarIllustration, type SidebarIllustrationKind } from "./BrandMark";
import type { CustomSidebarItem } from "../../shared/contracts";
import { getServiceDisplayName } from "../service-display";

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
  customSidebarItems: CustomSidebarItem[];
  pendingNavigationPath: string | null;
  onRequestNavigate?: (targetPath: string) => boolean;
  onNavigateItem?: () => void;
};

export function AppSidebar({
  isCollapsed,
  currentPath,
  customSidebarItems,
  pendingNavigationPath,
  onRequestNavigate,
  onNavigateItem
}: AppSidebarProps) {
  const { services } = useServices();
  const serviceNavItems: SidebarNavItem[] = services
    .filter((service) => service.id !== "agent-webclient" && service.frontendMode === "standalone" && service.status === "running")
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

      <nav className={pendingNavigationPath ? "sidebar-nav is-busy" : "sidebar-nav"} aria-label="Primary Navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={(event) => handleItemClick(event, item.to)}
            className={({ isActive }) =>
              [
                "sidebar-link",
                isActive ? "sidebar-link-active" : "",
                pendingNavigationPath === item.to ? "sidebar-link-pending" : ""
              ].filter(Boolean).join(" ")
            }
            aria-disabled={Boolean(pendingNavigationPath && pendingNavigationPath !== item.to)}
          >
            <span className="sidebar-link-icon">
              {item.iconId ? <CustomSidebarIcon iconId={item.iconId} /> : <SidebarIllustration kind={item.icon} />}
            </span>
            <span className="sidebar-link-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className={pendingNavigationPath ? "sidebar-footer is-busy" : "sidebar-footer"}>
        <NavLink
          to="/settings"
          onClick={(event) => handleItemClick(event, "/settings")}
          className={({ isActive }) =>
            [
              "sidebar-link",
              "sidebar-link-utility",
              isActive ? "sidebar-link-active" : "",
              pendingNavigationPath === "/settings" ? "sidebar-link-pending" : ""
            ].filter(Boolean).join(" ")
          }
          aria-disabled={Boolean(pendingNavigationPath && pendingNavigationPath !== "/settings")}
        >
          <span className="sidebar-link-icon">
            <SidebarIllustration kind="settings" />
          </span>
          <span className="sidebar-link-label">设置</span>
        </NavLink>
      </div>
    </aside>
  );
}
