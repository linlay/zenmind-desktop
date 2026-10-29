import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/useI18n";
import { SettingsSidebarIcon } from "./SettingsSidebarIcon";
import { SidebarActionIcon } from "../../components/BrandMark";

export const DESKTOP_CHAT_HEADER_INITIAL_INSET = 128;

export function DesktopChatHeaderNavigation(props: {
  canGoBack: boolean;
  canGoForward: boolean;
  onSearch(): void;
  onBack(): void;
  onForward(): void;
  onExpand(): void;
  onInsetChange(inset: number): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // 8px before the buttons and 12px between the group and guest content.
    const measure = () => {
      const width = Math.ceil(element.getBoundingClientRect().width);
      if (width > 0) props.onInsetChange(Math.min(256, width + 20));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.onInsetChange]);
  return <div ref={ref} className="main-chat-header-actions main-chat-header-navigation" role="group" aria-label={t("nav.main")}>
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
    <button type="button" className="main-chat-header-action" aria-label={t("nav.sidebar.expand")}
      title={t("nav.sidebar.expand")} aria-expanded={false} onClick={props.onExpand}>
      <SidebarActionIcon kind="sidebar_left" />
    </button>
  </div>;
}
