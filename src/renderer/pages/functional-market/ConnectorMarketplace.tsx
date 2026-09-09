import { useState, type ReactNode } from "react";
import { CheckOutlined, LinkOutlined, LoadingOutlined, PlusCircleOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import type { MarketItem } from "@shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import { MarketCardDescription } from "./MarketCardDescription";
import { MarketPageFrame } from "./MarketPageFrame";
import { getMarketTabDefinitions, matchesMarketItemQuery, type MarketTab } from "./marketPageModel";
import "./SkillMarketplace.css";
import "./ConnectorMarketplace.css";

interface ConnectorMarketplaceProps {
  items: MarketItem[];
  loading: boolean;
  busyItemId: string;
  feedback: ReactNode;
  detail: ReactNode;
  onTabChange: (tab: MarketTab) => void;
  onDetail: (item: MarketItem) => void;
  onManage: () => void;
}

function runtimeLabel(item: MarketItem, t: ReturnType<typeof useI18n>["t"]) {
  switch (item.mcpRuntimeStatus) {
    case "ready": return t("market.mcp.runtime.ready", { count: item.mcpToolCount ?? 0 });
    case "pending": return t("market.mcp.runtime.pending");
    case "unavailable": return t("market.mcp.runtime.unavailable");
    case "invalid": return t("market.mcp.runtime.invalid");
    case "disabled": return t("market.mcp.runtime.disabled");
    case "configuration-written": return t("market.mcp.runtime.configurationWritten");
    default: return "";
  }
}

export function ConnectorMarketplace(props: ConnectorMarketplaceProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const visible = props.items.filter((item) => item.type === "mcp" && matchesMarketItemQuery(item, query, t));

  return <MarketPageFrame activeTab="mcps" tabs={getMarketTabDefinitions(t)} onTabChange={props.onTabChange}
    toolbar={<div className="skill-discovery-toolbar">
      <label className="skill-discovery-search">
        <SearchOutlined aria-hidden="true" />
        <input type="search" aria-label={t("market.connector.search")} placeholder={t("market.connector.search")}
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button type="button" className="skill-discovery-outline" onClick={props.onManage}>
        <PlusCircleOutlined aria-hidden="true" />{t("market.connector.custom")}
      </button>
    </div>}>
    <div className="skill-discovery connector-discovery">
      {props.feedback}{props.detail}
      <div className="skill-discovery-scroll">
        <div className="skill-discovery-grid" aria-busy={props.loading}>
          {visible.map((item) => {
            const updateAvailable = item.state === "update-available";
            const installed = item.state === "installed" || item.state === "local-imported" || updateAvailable;
            const installing = props.busyItemId === item.id || item.state === "installing";
            const actionLabel = t(installing ? "market.state.installing" : item.state === "incompatible"
              ? "market.state.incompatible" : updateAvailable ? "market.state.updateAvailable"
                : installed ? "market.state.installed" : "market.action.install");
            const runtime = runtimeLabel(item, t);
            return <article className="skill-discovery-card" key={item.id}>
              <div className="skill-discovery-card-head">
                <span className={`skill-discovery-icon tone-${item.id.length % 6}`} aria-hidden="true"><LinkOutlined /></span>
                <button type="button" className="skill-discovery-name" title={item.name}
                  onClick={() => props.onDetail(item)}>{item.name}</button>
                {runtime ? <span className={`connector-runtime-dot is-${item.mcpRuntimeStatus}`} role="img"
                  aria-label={runtime} title={[runtime, item.mcpRuntimeMessage].filter(Boolean).join(" · ")} /> : null}
                <button type="button" className={`skill-discovery-install${updateAvailable ? " is-update" : ""}`}
                  disabled={props.busyItemId !== "" || installing || item.state === "incompatible"}
                  aria-label={`${item.name}: ${t("market.connector.custom")}`} title={`${actionLabel} · ${t("market.connector.custom")}`}
                  onClick={props.onManage}>
                  {installing ? <LoadingOutlined /> : updateAvailable ? t("market.state.updateAvailable") : installed ? <CheckOutlined /> : <PlusOutlined />}
                </button>
              </div>
              <MarketCardDescription text={item.description || t("market.discovery.noDescription")} onDetail={() => props.onDetail(item)} />
            </article>;
          })}
        </div>
        {!visible.length ? <div className="skill-discovery-empty" role="status">
          {t(props.loading ? "market.storefront.loading" : "market.connector.empty")}
        </div> : null}
      </div>
    </div>
  </MarketPageFrame>;
}
