import type { ReactNode } from "react";
import type { MarketTab, MarketTabDefinition } from "./marketPageModel";
import "./MarketPageFrame.css";

interface MarketPageFrameProps {
  activeTab: MarketTab;
  children: ReactNode;
  onTabChange: (tab: MarketTab) => void;
  subtitle: string;
  tabs: MarketTabDefinition[];
  title: string;
  toolbar: ReactNode;
}

export function MarketPageFrame({
  activeTab,
  children,
  onTabChange,
  subtitle,
  tabs,
  title,
  toolbar
}: MarketPageFrameProps) {
  return (
    <section className="market-page">
      <div className="market-shell workspace-wide">
        <div className="market-topbar">
          <div className="market-tabs" role="tablist" aria-label="市场页签">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "market-tab is-active" : "market-tab"}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="market-toolbar">
            {toolbar}
          </div>
        </div>

        <div className="market-body">
          <header className="market-hero">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </header>

          {children}
        </div>
      </div>
    </section>
  );
}
