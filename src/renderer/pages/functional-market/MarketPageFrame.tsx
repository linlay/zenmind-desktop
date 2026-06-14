import type { ReactNode } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CodeOutlined,
  GlobalOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SmileOutlined
} from "@ant-design/icons";
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

function marketTabIcon(tab: MarketTab) {
  switch (tab) {
    case "skills":
      return <SafetyCertificateOutlined />;
    case "agents":
      return <RobotOutlined />;
    case "sandboxImages":
      return <ApiOutlined />;
    case "pets":
      return <SmileOutlined />;
    case "cli":
      return <CodeOutlined />;
    case "websiteApps":
      return <GlobalOutlined />;
    case "plugins":
    default:
      return <AppstoreOutlined />;
  }
}

export function MarketPageFrame({
  activeTab,
  children,
  onTabChange,
  tabs,
  toolbar
}: MarketPageFrameProps) {
  const { t } = useI18n();
  const hasToolbar = Boolean(toolbar);

  return (
    <section className="market-page">
      <div className="market-shell">
        <div className={hasToolbar ? "market-topbar has-toolbar" : "market-topbar"}>
          <div className="market-tabs" role="tablist" aria-label={t("market.tabs.ariaLabel")}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "market-tab is-active" : "market-tab"}
                onClick={() => onTabChange(tab.id)}
              >
                <span className="market-tab-label">
                  <span className="market-tab-icon" aria-hidden="true">{marketTabIcon(tab.id)}</span>
                  <span className="market-tab-text">{tab.label}</span>
                  {typeof tab.count === "number" ? <span className="market-tab-count">{tab.count}</span> : null}
                </span>
              </button>
            ))}
          </div>

          {hasToolbar ? (
            <div className="market-toolbar">
              {toolbar}
            </div>
          ) : null}
        </div>

        <div className="market-body">
          {children}
        </div>
      </div>
    </section>
  );
}
