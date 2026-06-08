import { useEffect, useMemo, useState } from "react";
import type { MarketItem, ServiceState } from "@shared/contracts";
import { useNavigate } from "react-router-dom";
import { getServiceDisplayName } from "../../service-display";
import { useI18n } from "../../i18n/useI18n";
import { useServices } from "../../services/ServicesContext";
import { MarketPageFrame } from "./MarketPageFrame";
import {
  createMissingMarketApiError,
  createMissingPluginApiError,
  getMarketMethod,
  getPluginMethod
} from "./marketPageApi";
import {
  canOpenPlugin,
  getMarketItemStatusClass,
  getPluginStatusClass,
  MarketCardGlyph,
  marketCardDescription,
  marketItemStateLabel,
  marketSourceLabel,
  marketVersionLabel,
  pluginDetailChips,
  pluginMetricLabel
} from "./marketDisplay";
import {
  createEmptyMarketResult,
  getMarketTabDefinitions,
  getMarketTabDefinition,
  matchesMarketItemQuery,
  type MarketViewProps
} from "./marketPageModel";
import "./PluginMarket.css";

interface PluginMarketToolbarProps {
  isImportingPlugin: boolean;
  isLoadingMarket: boolean;
  onImportPlugin: () => void;
  onRefresh: () => void;
}

interface PluginMarketSectionProps {
  busyItemId: string;
  isLoadingMarket: boolean;
  items: MarketItem[];
  onInstallItem: (item: MarketItem) => void;
  onOpenPlugin: (item: MarketItem) => void;
  onQueryChange: (query: string) => void;
  query: string;
  serviceById: Map<string, ServiceState>;
}

export function PluginMarket({ activeTab, onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [isImportingPlugin, setIsImportingPlugin] = useState(false);

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const items = useMemo(
    () => marketResult.items.filter((item) => item.type === "plugin" && matchesMarketItemQuery(item, query, t)),
    [marketResult.items, query, t]
  );

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName, t);
      }
      setMarketResult(await command({ sections: ["plugins"] }));
    } catch (reason) {
      console.warn("[plugin-market] failed to load market data", reason);
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  async function refreshEverything() {
    await refreshServices();
    await loadMarket(false);
  }

  async function handleImportPlugin() {
    setIsImportingPlugin(true);
    try {
      const install = getPluginMethod("install");
      if (!install) {
        throw createMissingPluginApiError("install", t);
      }
      await install();
      await refreshEverything();
    } catch (reason) {
      console.warn("[plugin-market] failed to import plugin", reason);
    } finally {
      setIsImportingPlugin(false);
    }
  }

  async function handleInstallItem(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const commandName = item.state === "update-available" ? "update" : "install";
      const action = getMarketMethod(commandName);
      if (!action) {
        throw createMissingMarketApiError(commandName, t);
      }
      await action(item.id);
      await refreshEverything();
    } catch (reason) {
      console.warn(`[plugin-market] failed to ${item.state === "update-available" ? "update" : "install"} ${item.id}`, reason);
    } finally {
      setBusyItemId("");
    }
  }

  function handleOpenPlugin(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    if (canOpenPlugin(service)) {
      navigate(`/service/${item.id}`);
      return;
    }
    navigate("/control-center", {
      state: {
        selectedServiceId: item.id
      }
    });
  }

  const activeDefinition = getMarketTabDefinition(activeTab, t);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={getMarketTabDefinitions(t)}
      title={activeDefinition.title}
      toolbar={(
        <PluginMarketToolbar
          isImportingPlugin={isImportingPlugin}
          isLoadingMarket={isLoadingMarket}
          onImportPlugin={() => void handleImportPlugin()}
          onRefresh={() => void loadMarket(true)}
        />
      )}
    >
      <PluginMarketSection
        busyItemId={busyItemId}
        isLoadingMarket={isLoadingMarket}
        items={items}
        onInstallItem={(item) => void handleInstallItem(item)}
        onOpenPlugin={handleOpenPlugin}
        onQueryChange={setQuery}
        query={query}
        serviceById={serviceById}
      />
    </MarketPageFrame>
  );
}

export function PluginMarketToolbar({
  isImportingPlugin,
  isLoadingMarket,
  onImportPlugin,
  onRefresh
}: PluginMarketToolbarProps) {
  const { t } = useI18n();

  return (
    <>
      <button type="button" className="market-toolbar-btn" onClick={onRefresh}>
        {isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}
      </button>
      <button
        type="button"
        className="market-toolbar-btn market-toolbar-btn-primary"
        onClick={onImportPlugin}
        disabled={isImportingPlugin}
      >
        {isImportingPlugin ? t("market.toolbar.importing") : t("market.plugin.import")}
      </button>
    </>
  );
}

export function PluginMarketSection({
  busyItemId,
  isLoadingMarket,
  items,
  onInstallItem,
  onOpenPlugin,
  onQueryChange,
  query,
  serviceById
}: PluginMarketSectionProps) {
  const { t } = useI18n();

  function renderPluginAction(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    const busy = busyItemId === item.id;
    if (item.state === "not-installed" || item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-item-action"
          disabled={busy || item.state === "incompatible"}
          onClick={(event) => {
            event.stopPropagation();
            onInstallItem(item);
          }}
        >
          {busy ? t("market.action.installing") : item.state === "update-available" ? t("market.action.update") : t("market.action.install")}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="market-item-action"
        onClick={(event) => {
          event.stopPropagation();
          onOpenPlugin(item);
        }}
      >
        {canOpenPlugin(service) ? t("market.action.open") : t("market.action.manage")}
      </button>
    );
  }

  return (
    <div className="market-content">
      <div className="market-filter-bar market-filter-bar-single">
        <label className="market-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("market.search.plugins")}
          />
        </label>
      </div>

      {items.length > 0 ? (
        <div className="market-plugin-panel">
          {items.map((plugin) => {
            const service = serviceById.get(plugin.id) ?? null;
            const displayName = getServiceDisplayName(plugin.id, plugin.name);
            const description = marketCardDescription(plugin);
            const detailChips = pluginDetailChips(plugin, service, t);
            return (
              <article
                key={`${plugin.type}:${plugin.id}`}
                className="market-plugin-feature"
                onClick={() => onOpenPlugin(plugin)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenPlugin(plugin);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="market-plugin-feature-head">
                  <div className="market-card-icon" aria-hidden="true">
                    <MarketCardGlyph kind="plugin" />
                  </div>
                  <div className="market-card-heading">
                    <div className="market-card-title-row">
                      <h2>{displayName}</h2>
                      <span className="market-card-more" aria-hidden="true">...</span>
                    </div>
                    <span className="market-provider-pill">
                      <span className="market-provider-dot" aria-hidden="true" />
                      {marketSourceLabel(plugin, t)}
                    </span>
                  </div>
                </div>
                {description ? <p className="market-card-description">{description}</p> : null}
                {detailChips.length > 0 ? (
                  <div className="market-card-tags" aria-label={t("market.tags.aria", { name: displayName })}>
                    {detailChips.map((chip) => (
                      <span key={chip} className="market-chip">{chip}</span>
                    ))}
                  </div>
                ) : null}
                <div className="market-plugin-meta">
                  <div className="market-card-footer-main">
                    <span className={`market-state-pill ${getMarketItemStatusClass(plugin.state)}`}>
                      <span
                        className={`market-plugin-status-dot ${service ? getPluginStatusClass(service.status) : getMarketItemStatusClass(plugin.state)}`}
                        aria-hidden="true"
                      />
                      {marketItemStateLabel(plugin, t)}
                    </span>
                    <span className="market-meta-pill">{marketVersionLabel(plugin)}</span>
                    <span className="market-meta-pill">{pluginMetricLabel(service, t)}</span>
                  </div>
                  <div className="market-card-footer-action">
                    {renderPluginAction(plugin)}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="market-empty-state">
          <h2>{isLoadingMarket ? t("market.plugin.empty.loading") : t("market.plugin.empty.title")}</h2>
          <p>{t("market.plugin.empty.description")}</p>
        </section>
      )}
    </div>
  );
}
