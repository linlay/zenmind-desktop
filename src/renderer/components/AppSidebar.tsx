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
  { to: "/market", label: "功能市场", icon: "market" },
  { to: "/help", label: "帮助", icon: "help" }
];

const assistantNavItem: SidebarNavItem = {
  to: "/plugin/agent-webclient",
  label: "智能助理",
  icon: "assistant"
};

const agentWebclientNavItems: SidebarNavItem[] = [
  { to: "/agents", label: "智能体管理", icon: "service" },
  { to: "/schedules", label: "自动化", icon: "service" },
  { to: "/memory", label: "记忆管理", icon: "service" }
];

function getCollapsedSidebarLabel(label: string) {
  const Segmenter = typeof Intl === "undefined"
    ? undefined
    : (Intl as unknown as {
        Segmenter?: new (
          locale: string,
          options: { granularity: "grapheme" }
        ) => { segment(input: string): Iterable<{ segment: string }> };
      }).Segmenter;

  if (Segmenter) {
    const segments = new Segmenter("zh-CN", { granularity: "grapheme" }).segment(label);
    return Array.from(segments, ({ segment }) => segment).slice(0, 5).join("");
  }

  return Array.from(label).slice(0, 5).join("");
}

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
    ...agentWebclientNavItems,
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
            aria-label={item.label}
            title={item.label}
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
            <span className="sidebar-link-label-collapsed" aria-hidden="true">
              {getCollapsedSidebarLabel(item.label)}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <NavLink
            to="/settings"
            onClick={(event) => handleItemClick(event, "/settings")}
            aria-label="设置"
            title="设置"
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
            <span className="sidebar-link-label-collapsed" aria-hidden="true">设置</span>
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
            title="助手"
          >
            <span className="sidebar-link-icon">
              <SidebarIllustration kind="assistant" />
            </span>
            <span className="sidebar-link-label">助手</span>
            <span className="sidebar-link-label-collapsed" aria-hidden="true">助手</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
