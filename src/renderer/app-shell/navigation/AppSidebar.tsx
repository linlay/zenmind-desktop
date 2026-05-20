import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { NavLink } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { EXTERNAL_EXPERIMENTAL_ITEMS } from "../../App";
import {
  CustomSidebarIcon,
  SidebarIllustration,
  type SidebarIllustrationKind,
} from "../../components/BrandMark";
import type { AssistantNavAgentItem, CustomSidebarItem } from "../../../shared/contracts";
import {
  getServiceDisplayName,
  shouldShowServiceNavigationTab,
} from "../../service-display";
import {
  createCustomSidebarNavOrderKey,
  createExperimentalSidebarNavOrderKey,
  createServiceSidebarNavOrderKey,
  sortSidebarNavItems,
  type SidebarNavOrderItemKey,
} from "./sidebarNavOrder";

type SidebarNavItem = {
  orderKey: SidebarNavOrderItemKey;
  to: string;
  label: string;
  icon: SidebarIllustrationKind;
  iconId?: string;
};

type SidebarToolItem = Omit<SidebarNavItem, "orderKey"> & {
  orderKey: string;
};

type SidebarPrimaryEntry = SidebarNavItem & {
  entryType?: "link" | "assistants" | "websites";
};

type SidebarGroupId = "assistants" | "websites";

type SidebarGroupState = Record<SidebarGroupId, boolean>;

type SidebarStatusSummary = {
  unreadCount: number;
  pendingCount: number;
};

const SIDEBAR_GROUP_STATE_STORAGE_KEY = "zenmind-desktop.sidebar-groups";

const defaultSidebarGroupState: SidebarGroupState = {
  assistants: true,
  websites: true,
};

const assistantGroupNavItem: SidebarPrimaryEntry = {
  orderKey: "group:assistants",
  to: "",
  label: "智能助手",
  icon: "assistant",
  entryType: "assistants",
};

const websitesGroupNavItem: SidebarPrimaryEntry = {
  orderKey: "group:websites",
  to: "",
  label: "内嵌网站",
  icon: "website",
  entryType: "websites",
};

const staticNavItems: SidebarNavItem[] = [
  { orderKey: "market", to: "/market", label: "功能市场", icon: "market" },
];

const assistantHomeNavItem: SidebarNavItem = {
  orderKey: "assistant",
  to: "/service/agent-webclient",
  label: "智能助手首页",
  icon: "assistant",
};

const fixedToolRows: SidebarToolItem[][] = [
  [
    { orderKey: "agents", to: "/agents", label: "智能体", icon: "agent" },
    {
      orderKey: "schedules",
      to: "/schedules",
      label: "自动化",
      icon: "schedule",
    },
    { orderKey: "memory", to: "/memory", label: "记忆管理", icon: "memory" },
  ],
  [
    { orderKey: "control-center", to: "/control-center", label: "控制中心", icon: "control" },
    { orderKey: "settings", to: "/settings", label: "设置", icon: "settings" },
    { orderKey: "help", to: "/help", label: "帮助", icon: "help" },
  ],
];

const fixedToolItems = fixedToolRows.flat();

function getCollapsedSidebarLabel(label: string) {
  const Segmenter =
    typeof Intl === "undefined"
      ? undefined
      : (
          Intl as unknown as {
            Segmenter?: new (
              locale: string,
              options: { granularity: "grapheme" },
            ) => { segment(input: string): Iterable<{ segment: string }> };
          }
        ).Segmenter;

  if (Segmenter) {
    const segments = new Segmenter("zh-CN", {
      granularity: "grapheme",
    }).segment(label);
    return Array.from(segments, ({ segment }) => segment)
      .slice(0, 5)
      .join("");
  }

  return Array.from(label).slice(0, 5).join("");
}

function normalizeSidebarGroupState(candidate: unknown): SidebarGroupState {
  if (!candidate || typeof candidate !== "object") {
    return defaultSidebarGroupState;
  }
  const record = candidate as Partial<Record<SidebarGroupId, unknown>>;
  return {
    assistants: typeof record.assistants === "boolean" ? record.assistants : defaultSidebarGroupState.assistants,
    websites: typeof record.websites === "boolean" ? record.websites : defaultSidebarGroupState.websites,
  };
}

function readInitialSidebarGroupState() {
  if (typeof window === "undefined") {
    return defaultSidebarGroupState;
  }
  try {
    const savedValue = window.localStorage.getItem(SIDEBAR_GROUP_STATE_STORAGE_KEY);
    return savedValue ? normalizeSidebarGroupState(JSON.parse(savedValue)) : defaultSidebarGroupState;
  } catch {
    return defaultSidebarGroupState;
  }
}

function getRoutePathname(route: string) {
  return route.split("?")[0] || "/";
}

function getRouteAgentKey(route: string) {
  const queryIndex = route.indexOf("?");
  if (queryIndex < 0) {
    return "";
  }
  try {
    return new URLSearchParams(route.slice(queryIndex + 1)).get("agentKey")?.trim() ?? "";
  } catch {
    return "";
  }
}

function createAgentRoute(agentKey: string) {
  return `/service/agent-webclient?agentKey=${encodeURIComponent(agentKey)}`;
}

function summarizeAgentStatus(items: AssistantNavAgentItem[]): SidebarStatusSummary {
  return {
    unreadCount: items.reduce((total, item) => total + Math.max(0, item.unreadCount), 0),
    pendingCount: items.filter((item) => item.hasPendingAwaiting).length,
  };
}

function createAgentStatusSummary(item: AssistantNavAgentItem): SidebarStatusSummary {
  return {
    unreadCount: Math.max(0, item.unreadCount),
    pendingCount: item.hasPendingAwaiting ? 1 : 0,
  };
}

function formatUnreadCount(value: number) {
  if (value <= 0) {
    return "";
  }
  return value > 99 ? "99+" : String(value);
}

type SidebarCollapseToggleVariant = "compact" | "nav";

type SidebarCollapseToggleProps = {
  isCollapsed: boolean;
  variant: SidebarCollapseToggleVariant;
  className?: string;
  onToggleCollapsed?: () => void;
};

function SidebarCollapseToggleIcon({ isCollapsed }: { isCollapsed: boolean }) {
  if (isCollapsed) {
    return (
      <span
        className="app-sidebar-collapse-button-icon app-sidebar-collapse-button-icon-chevron"
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className="app-sidebar-collapse-button-icon app-sidebar-collapse-button-icon-panel"
      viewBox="0 -960 960 960"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm120-80v-560H200v560h120Zm80 0h360v-560H400v560Zm-80 0H200h120Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SidebarCollapseToggle({
  isCollapsed,
  variant,
  onToggleCollapsed,
  className,
}: SidebarCollapseToggleProps) {
  return (
    <button
      type="button"
      className={[
        "app-sidebar-collapse-button",
        className ? className : "",
        variant === "compact" ? "is-compact" : "is-nav",
        isCollapsed ? "is-collapsed-state" : "is-expanded-state",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
      title={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
      aria-expanded={!isCollapsed}
      onClick={onToggleCollapsed}
    >
      <SidebarCollapseToggleIcon isCollapsed={isCollapsed} />
    </button>
  );
}

type AppSidebarProps = {
  isCollapsed: boolean;
  isMac: boolean;
  isWindows: boolean;
  currentPathname: string;
  currentRoute: string;
  pendingPath?: string | null;
  assistantDockOpen?: boolean;
  assistantLauncherDisabled?: boolean;
  assistantLauncherVisible?: boolean;
  sidebarNavOrder: SidebarNavOrderItemKey[];
  customSidebarNavOrder?: SidebarNavOrderItemKey[];
  customSidebarItems: CustomSidebarItem[];
  assistantNavAgents?: AssistantNavAgentItem[];
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onRequestNavigate?: (targetPath: string) => boolean;
  onNavigateItem?: () => void;
  onToggleCollapsed?: () => void;
};

export function AppSidebar({
  isCollapsed,
  isMac,
  isWindows,
  currentPathname,
  currentRoute,
  pendingPath,
  assistantDockOpen = false,
  assistantLauncherDisabled = false,
  assistantLauncherVisible = true,
  sidebarNavOrder,
  customSidebarNavOrder = [],
  customSidebarItems,
  assistantNavAgents = [],
  onOpenAssistantDock,
  onCloseAssistantDock,
  onRequestNavigate,
  onNavigateItem,
  onToggleCollapsed,
}: AppSidebarProps) {
  const { services } = useServices();
  const [sidebarGroupState, setSidebarGroupState] = useState<SidebarGroupState>(readInitialSidebarGroupState);
  const currentAgentKey = getRouteAgentKey(currentRoute);
  const pendingAgentKey = pendingPath ? getRouteAgentKey(pendingPath) : "";
  const assistantStatusSummary = useMemo(
    () => summarizeAgentStatus(assistantNavAgents),
    [assistantNavAgents],
  );
  const serviceNavItems: SidebarNavItem[] = useMemo(
    () =>
      services
        .filter(shouldShowServiceNavigationTab)
        .map((service) => ({
          orderKey: createServiceSidebarNavOrderKey(service.id),
          to: `/service/${service.id}`,
          label: getServiceDisplayName(service.id, service.name),
          icon: "service",
        })),
    [services],
  );

  const experimentalItems: SidebarNavItem[] = useMemo(
    () =>
      EXTERNAL_EXPERIMENTAL_ITEMS.map((item) => ({
        orderKey: createExperimentalSidebarNavOrderKey(item.id),
        to: `/external/${item.id}`,
        label: item.label,
        icon: item.icon,
      })),
    [],
  );

  const customItems: SidebarNavItem[] = useMemo(() => {
    const orderIndex = new Map(
      customSidebarNavOrder.map((key, index) => [key, index] as const),
    );
    return customSidebarItems
      .map((item) => ({
        orderKey: createCustomSidebarNavOrderKey(item.id),
        to: `/custom-sidebar/${item.id}`,
        label: item.label,
        icon: "website" as const,
        iconId: item.iconId,
      }))
      .sort((left, right) => {
        const leftIndex = orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [customSidebarItems, customSidebarNavOrder]);

  const assistantChildItems: Array<SidebarNavItem & { status?: SidebarStatusSummary }> = useMemo(
    () => [
      assistantHomeNavItem,
      ...assistantNavAgents.map((agent) => ({
        orderKey: "assistant" as const,
        to: createAgentRoute(agent.agentKey),
        label: agent.displayName,
        icon: "agent" as const,
        status: createAgentStatusSummary(agent),
      })),
    ],
    [assistantNavAgents],
  );

  const navItems = sortSidebarNavItems(
    [
      assistantGroupNavItem,
      websitesGroupNavItem,
      ...serviceNavItems,
      ...experimentalItems,
      ...staticNavItems,
    ],
    sidebarNavOrder,
  );
  const chromeToolbarClassName = [
    "sidebar-chrome-toolbar",
    isMac ? "is-mac" : isWindows ? "is-windows" : "is-default",
  ].join(" ");

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_GROUP_STATE_STORAGE_KEY,
        JSON.stringify(sidebarGroupState),
      );
    } catch {
      // Ignore localStorage failures in restricted renderer contexts.
    }
  }, [sidebarGroupState]);

  function handleItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    targetPath: string,
  ) {
    const targetPathname = getRoutePathname(targetPath);
    if (targetPath === "/settings") {
      onCloseAssistantDock?.();
    }

    if (targetPath === currentRoute || (!targetPath.includes("?") && targetPathname === currentPathname)) {
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

  function toggleSidebarGroup(groupId: SidebarGroupId) {
    setSidebarGroupState((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
  }

  function isRouteActive(targetPath: string) {
    const targetPathname = getRoutePathname(targetPath);
    if (targetPathname !== currentPathname && pendingPath !== targetPath) {
      return false;
    }
    if (targetPathname !== "/service/agent-webclient") {
      return targetPathname === currentPathname || pendingPath === targetPath;
    }
    const targetAgentKey = getRouteAgentKey(targetPath);
    const activeAgentKey = pendingPath === targetPath ? pendingAgentKey : currentAgentKey;
    return targetAgentKey === activeAgentKey;
  }

  function isAssistantGroupActive() {
    return currentPathname === "/service/agent-webclient" || Boolean(pendingPath?.startsWith("/service/agent-webclient"));
  }

  function isWebsiteGroupActive() {
    return currentPathname.startsWith("/custom-sidebar/") || Boolean(pendingPath?.startsWith("/custom-sidebar/"));
  }

  function renderStatusBadges(summary: SidebarStatusSummary, className = "") {
    const unreadLabel = formatUnreadCount(summary.unreadCount);
    if (summary.pendingCount <= 0 && !unreadLabel) {
      return null;
    }
    return (
      <span className={["sidebar-status-badges", className].filter(Boolean).join(" ")} aria-hidden="true">
        {summary.pendingCount > 0 ? (
          <span className="sidebar-status-badge is-pending">
            待{summary.pendingCount > 1 ? summary.pendingCount : ""}
          </span>
        ) : null}
        {unreadLabel ? (
          <span className="sidebar-status-badge is-unread">{unreadLabel}</span>
        ) : null}
      </span>
    );
  }

  function getSidebarLinkClassName(targetPath: string, extraClassName = "") {
    return [
      "sidebar-link",
      extraClassName,
      isRouteActive(targetPath) ? "sidebar-link-active" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function renderSidebarLink(item: SidebarNavItem, extraClassName = "") {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, extraClassName)}
      >
        <span className="sidebar-link-icon">
          {item.iconId ? (
            <CustomSidebarIcon iconId={item.iconId} />
          ) : (
            <SidebarIllustration kind={item.icon} />
          )}
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        <span className="sidebar-link-label-collapsed" aria-hidden="true">
          {getCollapsedSidebarLabel(item.label)}
        </span>
      </NavLink>
    );
  }

  function renderSidebarChildLink(item: SidebarNavItem & { status?: SidebarStatusSummary }) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, "sidebar-child-link")}
      >
        <span className="sidebar-link-icon">
          {item.iconId ? (
            <CustomSidebarIcon iconId={item.iconId} />
          ) : (
            <SidebarIllustration kind={item.icon} />
          )}
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        {item.status ? renderStatusBadges(item.status, "sidebar-child-status") : null}
      </NavLink>
    );
  }

  function renderSidebarGroup(args: {
    groupId: SidebarGroupId;
    label: string;
    icon: SidebarIllustrationKind;
    active: boolean;
    status?: SidebarStatusSummary;
    children: Array<SidebarNavItem & { status?: SidebarStatusSummary }>;
  }) {
    const expanded = sidebarGroupState[args.groupId];
    return (
      <div
        key={args.groupId}
        className={[
          "sidebar-nav-group",
          expanded ? "is-expanded" : "is-collapsed",
          args.active ? "is-active" : "",
        ].filter(Boolean).join(" ")}
      >
        <button
          type="button"
          className={[
            "sidebar-link",
            "sidebar-group-trigger",
            args.active ? "sidebar-link-active" : "",
          ].filter(Boolean).join(" ")}
          onClick={() => toggleSidebarGroup(args.groupId)}
          aria-expanded={!isCollapsed && expanded}
          aria-label={args.label}
          title={args.label}
        >
          <span className="sidebar-link-icon">
            <SidebarIllustration kind={args.icon} />
          </span>
          <span className="sidebar-link-label">{args.label}</span>
          {args.status ? renderStatusBadges(args.status, "sidebar-group-status") : null}
          <span className="sidebar-group-chevron" aria-hidden="true" />
        </button>
        {!isCollapsed && expanded ? (
          <div className="sidebar-group-children" role="group" aria-label={args.label}>
            {args.children.map((item) => renderSidebarChildLink(item))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderPrimaryNavEntry(item: SidebarPrimaryEntry) {
    if (item.entryType === "assistants") {
      return renderSidebarGroup({
        groupId: "assistants",
        label: item.label,
        icon: item.icon,
        active: isAssistantGroupActive(),
        status: assistantStatusSummary,
        children: assistantChildItems,
      });
    }
    if (item.entryType === "websites") {
      return renderSidebarGroup({
        groupId: "websites",
        label: item.label,
        icon: item.icon,
        active: isWebsiteGroupActive(),
        children: customItems,
      });
    }
    return renderSidebarLink(item);
  }

  function renderToolLink(item: SidebarToolItem) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={(event) => handleItemClick(event, item.to)}
        aria-label={item.label}
        title={item.label}
        className={() => getSidebarLinkClassName(item.to, "sidebar-tool-link")}
      >
        <span className="sidebar-link-icon">
          <SidebarIllustration kind={item.icon} />
        </span>
        <span className="sidebar-link-label">{item.label}</span>
        <span className="sidebar-link-label-collapsed" aria-hidden="true">
          {getCollapsedSidebarLabel(item.label)}
        </span>
      </NavLink>
    );
  }

  return (
    <aside className={isCollapsed ? "app-sidebar is-collapsed" : "app-sidebar"}>
      <div className="sidebar-chrome">
        <div className="sidebar-chrome-drag-region" aria-hidden="true" />
        <div className={chromeToolbarClassName}>
        </div>
        {isCollapsed ? (
          <div className="sidebar-collapsed-toggle-slot">
            <SidebarCollapseToggle
              isCollapsed={isCollapsed}
              variant="nav"
              onToggleCollapsed={onToggleCollapsed}
            />
          </div>
        ) : (
          <SidebarCollapseToggle
            className="sidebar-collapsed-toggle-button"
            isCollapsed={isCollapsed}
            variant="compact"
            onToggleCollapsed={onToggleCollapsed}
          />
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Primary Navigation">
        {navItems.map((item) => renderPrimaryNavEntry(item))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-divider" aria-hidden="true" />
        <div className="sidebar-footer-actions">
          <div className="sidebar-tool-grid" aria-label="固定工具区">
            {fixedToolItems.map((item) => renderToolLink(item))}
          </div>
          {assistantLauncherVisible ? (
            <button
              type="button"
              className={[
                "sidebar-link",
                "sidebar-link-utility",
                "sidebar-tool-assistant",
                "sidebar-assistant-launcher",
                assistantDockOpen ? "is-assistant-open" : "",
                assistantLauncherDisabled ? "is-disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
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
                <SidebarIllustration
                  kind={
                    assistantDockOpen
                      ? "sidebar-assistant-open"
                      : "sidebar-assistant-closed"
                  }
                />
              </span>
              <span className="sidebar-link-label">侧边助手</span>
              <span className="sidebar-link-label-collapsed" aria-hidden="true">
                {getCollapsedSidebarLabel("侧边助手")}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
