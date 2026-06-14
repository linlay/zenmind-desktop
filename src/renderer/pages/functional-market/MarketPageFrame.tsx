import type { ReactNode } from "react";
import type { MarketTab, MarketTabDefinition } from "./marketPageModel";
import { useI18n } from "../../i18n/useI18n";
import "./MarketPageFrame.css";

interface MarketPageFrameProps {
  activeTab: MarketTab;
  children: ReactNode;
  onTabChange: (tab: MarketTab) => void;
  subtitle?: string;
  tabs: MarketTabDefinition[];
  title?: string;
  toolbar?: ReactNode;
}

export function MarketPageFrame({
  activeTab,
  children,
  onTabChange,
  tabs,
  toolbar
}: MarketPageFrameProps) {
  const { t } = useI18n();

  return (
    <section className="market-page">
      <div className="market-shell">
        <div className="market-topbar">
          <div className="market-tabs" role="tablist" aria-label={t("market.tabs.ariaLabel")}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "market-tab is-active" : "market-tab"}
                onClick={() => onTabChange(tab.id)}
              >
                <span className="market-tab-label">
                  {tab.label}
                  {typeof tab.count === "number" ? <span className="market-tab-count">{tab.count}</span> : null}
                </span>
                <span className="market-tab-meta">{tab.meta}</span>
              </button>
            ))}
          </div>

          <div className="market-toolbar">
            {toolbar}
          </div>
        </div>

        <div className="market-body">
          {children}
        </div>
      </div>
    </section>
  );
}
