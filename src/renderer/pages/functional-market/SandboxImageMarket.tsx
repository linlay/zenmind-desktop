import { useEffect, useMemo, useState } from "react";
import type { MarketItem, ServiceState } from "@shared/contracts";
import { useNavigate } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { MarketPageFrame } from "./MarketPageFrame";
import {
  createMissingMarketApiError,
  getMarketMethod,
  normalizeError
} from "./marketPageApi";
import {
  getMarketItemStatusClass,
  MarketCardGlyph,
  marketCardDescription,
  marketItemStateLabel,
  marketSourceLabel,
  marketVersionLabel,
  sandboxDetailChips,
  sandboxMetricLabel
} from "./marketDisplay";
import {
  MARKET_TAB_DEFINITIONS,
  createEmptyMarketResult,
  getMarketTabDefinition,
  matchesMarketItemQuery,
  type MarketViewProps
} from "./marketPageModel";

interface SandboxImageMarketToolbarProps {
  isLoadingMarket: boolean;
  onManageContainerHub: () => void;
  onRefresh: () => void;
}

interface SandboxImageMarketSectionProps {
  busyItemId: string;
  isLoadingMarket: boolean;
  items: MarketItem[];
  onBuildSandboxImage: (item: MarketItem) => void;
  onQueryChange: (query: string) => void;
  query: string;
  sandboxMessage: string;
  sandboxOffline: boolean;
  serviceById: Map<string, ServiceState>;
}

export function SandboxImageMarket({ activeTab, onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { services } = useServices();
  const [query, setQuery] = useState("");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [marketFeedback, setMarketFeedback] = useState("");

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const items = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "sandbox-image" && matchesMarketItemQuery(item, query)
    ),
    [marketResult.items, query]
  );

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName);
      }
      const next = await command();
      setMarketResult(next);
      setMarketFeedback("");
    } catch (reason) {
      console.warn("[sandbox-image-market] failed to load market data", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  async function handleBuildSandboxImage(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const buildSandboxImage = getMarketMethod("buildSandboxImage");
      if (!buildSandboxImage) {
        throw createMissingMarketApiError("buildSandboxImage");
      }
      const result = await buildSandboxImage(item.environmentName ?? item.id);
      setMarketFeedback(result.message);
      await loadMarket(true);
    } catch (reason) {
      console.warn(`[sandbox-image-market] failed to build sandbox image ${item.id}`, reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setBusyItemId("");
    }
  }

  const activeDefinition = getMarketTabDefinition(activeTab);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={MARKET_TAB_DEFINITIONS}
      title={activeDefinition.title}
      toolbar={(
        <SandboxImageMarketToolbar
          isLoadingMarket={isLoadingMarket}
          onManageContainerHub={() => navigate("/control-center", { state: { selectedServiceId: "agent-container-hub" } })}
          onRefresh={() => void loadMarket(true)}
        />
      )}
    >
      <SandboxImageMarketSection
        busyItemId={busyItemId}
        isLoadingMarket={isLoadingMarket}
        items={items}
        onBuildSandboxImage={(item) => void handleBuildSandboxImage(item)}
        onQueryChange={setQuery}
        query={query}
        sandboxMessage={marketFeedback || marketResult.sandboxMessage || ""}
        sandboxOffline={Boolean(marketResult.sandboxOffline)}
        serviceById={serviceById}
      />
    </MarketPageFrame>
  );
}

export function SandboxImageMarketToolbar({
  isLoadingMarket,
  onManageContainerHub,
  onRefresh
}: SandboxImageMarketToolbarProps) {
  return (
    <>
      <button type="button" className="market-toolbar-btn" onClick={onRefresh}>
        {isLoadingMarket ? "刷新中" : "刷新市场"}
      </button>
      <button
        type="button"
        className="market-toolbar-btn market-toolbar-btn-primary"
        onClick={onManageContainerHub}
      >
        管理 Container Hub
      </button>
    </>
  );
}

export function SandboxImageMarketSection({
  busyItemId,
  isLoadingMarket,
  items,
  onBuildSandboxImage,
  onQueryChange,
  query,
  sandboxMessage,
  sandboxOffline,
  serviceById
}: SandboxImageMarketSectionProps) {
  const hubService = serviceById.get("agent-container-hub") ?? null;
  const sandboxStatus = sandboxMessage || (
    hubService?.status && hubService.status !== "running"
      ? "沙箱镜像市场需要先启动 Container Hub。"
      : ""
  );

  function renderSandboxAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    return (
      <button
        type="button"
        className="market-item-action"
        disabled={busy || item.state === "installing"}
        onClick={() => onBuildSandboxImage(item)}
      >
        {busy || item.state === "installing" ? "构建中" : item.state === "installed" ? "重新构建" : "构建"}
      </button>
    );
  }

  return (
    <div className="market-content">
      {sandboxStatus ? (
        <div className={sandboxOffline ? "market-status is-warning" : "market-status"} aria-live="polite">
          {sandboxStatus}
        </div>
      ) : null}

      <div className="market-filter-bar market-filter-bar-single">
        <label className="market-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索 environment / 镜像"
          />
        </label>
      </div>

      {items.length > 0 ? (
        <div className="market-plugin-panel">
          {items.map((image) => {
            const description = marketCardDescription(image);
            const detailChips = sandboxDetailChips(image);
            return (
              <article key={`${image.type}:${image.id}`} className="market-skill-card">
                <div className="market-plugin-feature-head">
                  <div className="market-card-icon" aria-hidden="true">
                    <MarketCardGlyph kind="sandbox" />
                  </div>
                  <div className="market-card-heading">
                    <div className="market-card-title-row">
                      <h2>{image.name}</h2>
                      <div className="market-card-footer-action">
                        {renderSandboxAction(image)}
                      </div>
                    </div>
                    <span className="market-provider-pill">
                      <span className="market-provider-dot" aria-hidden="true" />
                      {marketSourceLabel(image)}
                    </span>
                  </div>
                </div>
                {description ? <p className="market-card-description">{description}</p> : null}
                {detailChips.length > 0 ? (
                  <div className="market-card-tags" aria-label={`${image.name} 标签`}>
                    {detailChips.map((chip) => (
                      <span key={chip} className="market-chip">{chip}</span>
                    ))}
                  </div>
                ) : null}
                <div className="market-plugin-meta">
                  <div className="market-card-footer-main">
                    <span className={`market-state-pill ${getMarketItemStatusClass(image.state)}`}>
                      <span className={`market-plugin-status-dot ${getMarketItemStatusClass(image.state)}`} aria-hidden="true" />
                      {marketItemStateLabel(image)}
                    </span>
                    <span className="market-meta-pill">{marketVersionLabel(image)}</span>
                    <span className="market-meta-pill">{sandboxMetricLabel(image)}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="market-empty-state">
          <h2>{isLoadingMarket ? "正在加载沙箱镜像" : "暂无沙箱镜像"}</h2>
          <p>请先启动 Container Hub，或在 Container Hub 内新增 environment。</p>
        </section>
      )}
    </div>
  );
}
