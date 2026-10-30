import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/useI18n";
import { SettingsSidebarIcon } from "./SettingsSidebarIcon";
import { SidebarActionIcon } from "../../components/BrandMark";
import { SIDEBAR_COLLAPSED_WIDTH } from "../../../shared/sidebar-layout";

export const DESKTOP_CHAT_HEADER_INITIAL_INSET = 142;
export const WINDOWS_CHAT_HEADER_INITIAL_INSET = 62;

export function DesktopChatHeaderNavigation(props: {
  isCollapsed: boolean;
  leftInset: number;
  canGoBack: boolean;
  canGoForward: boolean;
  onSearch(): void;
  onBack(): void;
  onForward(): void;
  onToggle(): void;
  onInsetChange(inset: number): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The group stays anchored to the window, including while the sidebar animates.
    // Only the collapsed guest needs to reserve the overlap plus a 12px gap.
    const measure = () => {
      const width = Math.ceil(element.getBoundingClientRect().width);
      if (width > 0) props.onInsetChange(Math.min(256,
        Math.max(0, props.leftInset + width - SIDEBAR_COLLAPSED_WIDTH + 12)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.leftInset, props.onInsetChange]);
  const toggleLabel = t(props.isCollapsed ? "nav.sidebar.expand" : "nav.sidebar.collapse");
  return <div ref={ref} className="main-chat-header-actions main-chat-header-navigation" style={{ left: props.leftInset }} role="group" aria-label={t("nav.main")}>
    <button type="button" className="main-chat-header-action" aria-label={t("desktop.globalSearch.title")}
      title={t("desktop.globalSearch.shortcutHint")} onClick={props.onSearch}>
      <SettingsSidebarIcon kind="search" />
    </button>
    <button type="button" className="main-chat-header-action" aria-label={t("sidebar.navigation.back")}
      title={t("sidebar.navigation.back")} disabled={!props.canGoBack} onClick={props.onBack}>
      <SidebarActionIcon kind="back" />
    </button>
    <button type="button" className="main-chat-header-action" aria-label={t("sidebar.navigation.forward")}
      title={t("sidebar.navigation.forward")} disabled={!props.canGoForward} onClick={props.onForward}>
      <SidebarActionIcon kind="forward" />
    </button>
    <button type="button" className="main-chat-header-action" aria-label={toggleLabel}
      title={toggleLabel} aria-expanded={!props.isCollapsed} onClick={props.onToggle}>
      <SidebarActionIcon kind="sidebar_left" />
    </button>
  </div>;
}
