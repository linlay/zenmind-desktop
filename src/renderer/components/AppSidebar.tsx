import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { EXTERNAL_EXPERIMENTAL_ITEMS } from "../App";
import { BrandMark, CustomSidebarIcon, SidebarIllustration, type SidebarIllustrationKind } from "./BrandMark";
import type { CustomSidebarItem } from "../../shared/contracts";

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

type AppSidebarProps = {
  isCollapsed: boolean;
  experimentalEnabled: boolean;
  customSidebarItems: CustomSidebarItem[];
};

export function AppSidebar({ isCollapsed, experimentalEnabled, customSidebarItems }: AppSidebarProps) {
  const { services } = useServices();
  const serviceNavItems: SidebarNavItem[] = services
    .filter((service) => service.frontendMode === "standalone" && service.status === "running")
    .map((service) => ({
      to: `/plugin/${service.id}`,
      label: service.name,
      icon: service.id === "agent-webclient" ? "assistant" : "service"
    }));

  const experimentalItems: SidebarNavItem[] = experimentalEnabled
    ? EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => ({
        to: `/external/${item.id}`,
        label: item.label,
        icon: item.icon
      }))
    : [];

  const customItems: SidebarNavItem[] = customSidebarItems.map((item) => ({
    to: `/custom-sidebar/${item.id}`,
    label: item.label,
    icon: "custom",
    iconId: item.iconId
  }));

  const navItems = [
    staticNavItems[0],
    ...serviceNavItems,
    ...experimentalItems,
    ...customItems,
    ...staticNavItems.slice(1)
  ];

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
            className={({ isActive }) =>
              isActive ? "sidebar-link sidebar-link-active" : "sidebar-link"
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
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            isActive ? "sidebar-link sidebar-link-active sidebar-link-utility" : "sidebar-link sidebar-link-utility"
          }
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
