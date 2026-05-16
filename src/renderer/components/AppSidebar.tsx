import type { MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { EXTERNAL_EXPERIMENTAL_ITEMS } from "../App";
import { BrandMark, CustomSidebarIcon, SidebarIllustration, type SidebarIllustrationKind } from "./BrandMark";
import type { CustomSidebarItem } from "../../shared/contracts";
import { getServiceDisplayName, shouldShowServiceNavigationTab } from "../service-display";
import type { SettingsSectionDefinition, SettingsSectionId } from "../settingsSections";
import {
  createCustomSidebarNavOrderKey,
  createExperimentalSidebarNavOrderKey,
  createServiceSidebarNavOrderKey,
  sortSidebarNavItems,
  type SidebarNavOrderItemKey
} from "../sidebarNavOrder";

type SidebarNavItem = {
  orderKey: SidebarNavOrderItemKey;
  to: string;
  label: string;
  icon: SidebarIllustrationKind;
  iconId?: string;
};

const staticNavItems: SidebarNavItem[] = [
  { orderKey: "market", to: "/market", label: "功能市场", icon: "market" },
  { orderKey: "help", to: "/help", label: "帮助", icon: "help" }
];

const controlCenterUtilityItem = {
  to: "/control-center",
  label: "控制中心",
  icon: "control" satisfies SidebarIllustrationKind
};

const assistantNavItem: SidebarNavItem = {
  orderKey: "assistant",
  to: "/plugin/agent-webclient",
  label: "智能助理",
  icon: "assistant"
};

const agentWebclientNavItems: SidebarNavItem[] = [
  { orderKey: "agents", to: "/agents", label: "智能体", icon: "agent" },
  { orderKey: "schedules", to: "/schedules", label: "自动化", icon: "schedule" },
  { orderKey: "memory", to: "/memory", label: "记忆管理", icon: "memory" }
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
  currentPathname: string;
  pendingPath?: string | null;
  assistantDockOpen?: boolean;
  assistantLauncherDisabled?: boolean;
  assistantLauncherVisible?: boolean;
  isSettingsMode?: boolean;
  settingsSections?: SettingsSectionDefinition[];
  activeSettingsSectionId?: SettingsSectionId | null;
  pendingSettingsSectionId?: SettingsSectionId | null;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  customSidebarItems: CustomSidebarItem[];
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onRequestNavigate?: (targetPath: string) => boolean;
  onSelectSettingsSection?: (sectionId: SettingsSectionId) => void;
  onNavigateItem?: () => void;
  onToggleCollapsed?: () => void;
};

export function AppSidebar({
  isCollapsed,
  currentPathname,
  pendingPath,
  assistantDockOpen = false,
  assistantLauncherDisabled = false,
  assistantLauncherVisible = true,
  isSettingsMode = false,
  settingsSections = [],
  activeSettingsSectionId = null,
  pendingSettingsSectionId = null,
  sidebarNavOrder,
  customSidebarItems,
  onOpenAssistantDock,
  onCloseAssistantDock,
  onRequestNavigate,
  onSelectSettingsSection,
  onNavigateItem,
  onToggleCollapsed
}: AppSidebarProps) {
  const { services } = useServices();
  const serviceNavItems: SidebarNavItem[] = services
    .filter(shouldShowServiceNavigationTab)
    .map((service) => ({
      orderKey: createServiceSidebarNavOrderKey(service.id),
      to: `/plugin/${service.id}`,
      label: getServiceDisplayName(service.id, service.name),
      icon: "service"
    }));

  const experimentalItems: SidebarNavItem[] = EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => ({
    orderKey: createExperimentalSidebarNavOrderKey(item.id),
    to: `/external/${item.id}`,
    label: item.label,
    icon: item.icon
  }));

  const customItems: SidebarNavItem[] = customSidebarItems.map((item) => ({
    orderKey: createCustomSidebarNavOrderKey(item.id),
    to: `/custom-sidebar/${item.id}`,
    label: item.label,
    icon: "website",
    iconId: item.iconId
  }));

  const navItems = sortSidebarNavItems([
    assistantNavItem,
    ...agentWebclientNavItems,
    ...serviceNavItems,
    ...experimentalItems,
    ...customItems,
    ...staticNavItems
  ], sidebarNavOrder);

  function handleItemClick(event: MouseEvent<HTMLAnchorElement>, targetPath: string) {
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (targetPath === currentPathname) {
      event.preventDefault();
      return;
    }

    if (onRequestNavigate && !onRequestNavigate(targetPath)) {
      event.preventDefault();
      return;
    }

    onNavigateItem?.();
  }

  function handleSettingsSectionClick(sectionId: SettingsSectionId) {
    if (sectionId === activeSettingsSectionId) {
      return;
    }
    onSelectSettingsSection?.(sectionId);
    onNavigateItem?.();
  }

  function handleAssistantDockClick() {
    if (assistantLauncherDisabled) {
      return;
    }
    if (assistantDockOpen) {
      onCloseAssistantDock?.();
    } else {
      onOpenAssistantDock?.();
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

      <nav
        className={isSettingsMode ? "sidebar-nav sidebar-settings-nav" : "sidebar-nav"}
        aria-label={isSettingsMode ? "设置模块导航" : "Primary Navigation"}
      >
        {isSettingsMode
          ? settingsSections.map((section) => {
              const active = section.id === activeSettingsSectionId || section.id === pendingSettingsSectionId;
              return (
                <button
                  type="button"
                  key={section.id}
                  data-settings-section={section.id}
                  aria-label={section.label}
                  title={section.label}
                  className={[
                    "sidebar-link",
                    "sidebar-link-settings",
                    active ? "sidebar-link-active" : ""
                  ].filter(Boolean).join(" ")}
                  onClick={() => handleSettingsSectionClick(section.id)}
                >
                  <span className="sidebar-link-icon">
                    <SidebarIllustration kind={section.icon} />
                  </span>
                  <span className="sidebar-link-label">{section.label}</span>
                  <span className="sidebar-link-label-collapsed" aria-hidden="true">
                    {getCollapsedSidebarLabel(section.label)}
                  </span>
                </button>
              );
            })
          : navItems.map((item) => (
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
            to={controlCenterUtilityItem.to}
            onClick={(event) => handleItemClick(event, controlCenterUtilityItem.to)}
            aria-label={controlCenterUtilityItem.label}
            title={controlCenterUtilityItem.label}
            className={({ isActive }) =>
              [
                "sidebar-link",
                "sidebar-link-utility",
                (isActive || pendingPath === controlCenterUtilityItem.to) ? "sidebar-link-active" : ""
              ].filter(Boolean).join(" ")
            }
          >
            <span className="sidebar-link-icon">
              <SidebarIllustration kind={controlCenterUtilityItem.icon} />
            </span>
            <span className="sidebar-link-label">{controlCenterUtilityItem.label}</span>
          </NavLink>
          <NavLink
            to="/settings"
            onClick={(event) => handleItemClick(event, "/settings")}
            aria-label="设置"
            title="设置"
            className={({ isActive }) =>
              [
                "sidebar-link",
                "sidebar-link-utility",
                (isActive || pendingPath === "/settings") ? "sidebar-link-active" : ""
              ].filter(Boolean).join(" ")
            }
          >
            <span className="sidebar-link-icon">
              <SidebarIllustration kind="settings" />
            </span>
            <span className="sidebar-link-label">设置</span>
          </NavLink>
          {assistantLauncherVisible ? (
            <button
              type="button"
              className={[
                "sidebar-link",
                "sidebar-link-utility",
                "sidebar-assistant-launcher",
                assistantDockOpen ? "is-assistant-open" : "",
                assistantLauncherDisabled ? "is-disabled" : ""
              ].filter(Boolean).join(" ")}
              onClick={handleAssistantDockClick}
              aria-label={
                assistantLauncherDisabled
                  ? "当前页面不可开启 ZenMind 助手"
                  : assistantDockOpen
                    ? "关闭 ZenMind 助手"
                    : "打开 ZenMind 助手"
              }
              aria-disabled={assistantLauncherDisabled}
              disabled={assistantLauncherDisabled}
              title="助手"
            >
              <span className="sidebar-link-icon">
                <SidebarIllustration kind={assistantDockOpen ? "sidebar-assistant-open" : "sidebar-assistant-closed"} />
              </span>
              <span className="sidebar-link-label">侧边助手</span>
            </button>
          ) : null}
        </div>
        <div className="sidebar-collapse-control">
          <button
            type="button"
            className="app-sidebar-collapse-button"
            aria-label={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
            title={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={onToggleCollapsed}
          >
            <span className="app-sidebar-collapse-button-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
