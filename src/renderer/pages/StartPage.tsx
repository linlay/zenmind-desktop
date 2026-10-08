import { Dropdown } from "antd";
import type { WebEntry } from "../../shared/contracts";
import { SidebarActionIcon, SidebarIllustration } from "../components/BrandMark";
import { useI18n } from "../i18n/useI18n";

export interface StartPageRecentItem {
  key: string;
  label: string;
  kind: "chat" | "website" | "webapp";
  open: () => void;
}

interface StartPageProps {
  canCreateChat: boolean;
  sites: WebEntry[];
  sitesLoaded: boolean;
  recentItems: StartPageRecentItem[];
  onNewChat: () => void;
  onOpenSite: (site: WebEntry) => void;
  onManageSites: () => void;
}

export function StartPage({ canCreateChat, sites, sitesLoaded, recentItems, onNewChat, onOpenSite, onManageSites }: StartPageProps) {
  const { t } = useI18n();
  const siteMenuItems = [
    ...(!sitesLoaded || sites.length === 0
      ? [{ key: "empty", disabled: true, label: t(!sitesLoaded ? "startPage.loadingSites" : "startPage.noSites") }]
      : sites.map((site) => ({
        key: site.entryKey,
        icon: <SidebarIllustration kind="website" />,
        label: <span className="start-page-site-label" title={site.label}>
          <span>{site.label}</span>
          <small>{t(site.kind === "website" ? "startPage.website" : "startPage.webapp")}</small>
        </span>,
      }))),
    { type: "divider" as const },
    { key: "manage", label: t("startPage.manageSites") },
  ];
  return (
    <section className="start-page" aria-labelledby="start-page-title">
      <div className="start-page-content">
        <header className="start-page-header">
          <h1 id="start-page-title">{t("startPage.title")}</h1>
          <p>{t("startPage.description")}</p>
        </header>
        <div className="start-page-actions">
          <button type="button" className="start-page-action is-primary" disabled={!canCreateChat} onClick={onNewChat}>
            <SidebarActionIcon kind="new_chat" />{t("sidebar.chats.newChat")}
          </button>
          <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            autoFocus
            overlayClassName="start-page-sites-menu"
            menu={{
              items: siteMenuItems,
              onClick: ({ key }) => {
                if (key === "manage") onManageSites();
                else {
                  const site = sites.find((item) => item.entryKey === key);
                  if (site) onOpenSite(site);
                }
              },
            }}
          >
            <button type="button" className="start-page-action" aria-haspopup="menu">
              <SidebarIllustration kind="website" />{t("startPage.browseSites")}
            </button>
          </Dropdown>
        </div>
        {!canCreateChat && <p className="start-page-hint" role="status">{t("sidebar.chats.defaultAgentUnavailable")}</p>}
        {recentItems.length > 0 && <section className="start-page-section" aria-labelledby="start-page-recent-title">
          <div className="start-page-section-heading">
            <h2 id="start-page-recent-title">{t("startPage.recent")}</h2>
            <span>{t("startPage.thisSession")}</span>
          </div>
          <div className="start-page-list">
            {recentItems.map((item) => <button type="button" className="start-page-row" key={item.key} onClick={item.open} title={item.label}>
              <SidebarIllustration kind={item.kind === "chat" ? "chat" : "website"} />
              <span className="start-page-row-label">{item.label}</span>
              <span className="start-page-row-kind">{t(item.kind === "chat" ? "startPage.chat" : item.kind === "website" ? "startPage.website" : "startPage.webapp")}</span>
            </button>)}
          </div>
        </section>}
      </div>
    </section>
  );
}
