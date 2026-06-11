import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CheckCircleFilled,
  CloudDownloadOutlined,
  CodeOutlined,
  CopyOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SmileOutlined
} from "@ant-design/icons";
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
  getPluginMethod,
  normalizeError
} from "./marketPageApi";
import {
  createEmptyMarketResult,
  getMarketTabDefinitions,
  getMarketTabDefinition,
  MARKET_TAB_ITEM_TYPES,
  matchesMarketItemQuery,
  type MarketTab,
  type MarketViewProps
} from "./marketPageModel";
import {
  canOpenPlugin,
  getMarketItemStatusClass,
  marketCardDescription,
  marketItemStateLabel,
  marketSourceLabel,
  marketVersionLabel
} from "./marketDisplay";
import "./StorefrontMarket.css";

const RECOMMENDED_PREVIEW_LIMIT = 6;

function isInstalledMarketItem(item: MarketItem) {
  return item.state === "installed" || item.state === "update-available" || item.state === "local-imported";
}

function marketMessageForTab(result: ReturnType<typeof createEmptyMarketResult>, tab: MarketTab) {
  if (tab === "plugins") return result.pluginMessage ?? "";
  if (tab === "skills") return result.skillMessage ?? "";
  if (tab === "sandboxImages") return result.sandboxMessage ?? "";
  if (tab === "pets") return result.petMessage ?? "";
  return result.cliMessage ?? "";
}

function marketOfflineForTab(result: ReturnType<typeof createEmptyMarketResult>, tab: MarketTab) {
  if (tab === "plugins") return Boolean(result.pluginOffline);
  if (tab === "skills") return Boolean(result.skillOffline);
  if (tab === "sandboxImages") return Boolean(result.sandboxOffline);
  if (tab === "pets") return Boolean(result.petOffline);
  return Boolean(result.cliOffline);
}

function categoryIcon(tab: MarketTab) {
  switch (tab) {
    case "skills":
      return <SafetyCertificateOutlined />;
    case "sandboxImages":
      return <CloudDownloadOutlined />;
    case "pets":
      return <SmileOutlined />;
    case "cli":
      return <CodeOutlined />;
    case "plugins":
    default:
      return <AppstoreOutlined />;
  }
}

function itemIcon(item: MarketItem, activeTab: MarketTab) {
  if (item.type === "pet" && item.petPreviewAssetPath) {
    return <img src={item.petPreviewAssetPath} alt="" aria-hidden="true" />;
  }
  if (item.type === "cli") {
    return <CodeOutlined />;
  }
  if (item.type === "sandbox-image") {
    return <ApiOutlined />;
  }
  return categoryIcon(activeTab);
}

function serviceMetric(service: ServiceState | null) {
  if (service?.healthMeta.port) {
    return `${service.healthMeta.port}`;
  }
  return service?.status ?? "";
}

function itemCommercialMeta(item: MarketItem, t: ReturnType<typeof useI18n>["t"]) {
  return item.metadata?.price || item.metadata?.plan || (item.source === "cloud" ? t("market.storefront.free") : "");
}

function itemDetailUrl(item: MarketItem) {
  const value = item.cliDetailCommand || item.homepageUrl || item.metadata?.readmeUrl || item.metadata?.manifestUrl || "";
  return value.trim();
}

export function StorefrontMarket({ activeTab, onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [expandedRecommended, setExpandedRecommended] = useState(false);
  const [detailItemId, setDetailItemId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const activeDefinition = getMarketTabDefinition(activeTab, t);
  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const itemType = MARKET_TAB_ITEM_TYPES[activeTab];

  const items = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === itemType && matchesMarketItemQuery(item, query, t)
    ),
    [itemType, marketResult.items, query, t]
  );
  const installedItems = useMemo(() => items.filter(isInstalledMarketItem), [items]);
  const recommendedItems = useMemo(
    () => items.filter((item) => item.source === "cloud" && !isInstalledMarketItem(item)),
    [items]
  );
  const visibleRecommendedItems = expandedRecommended
    ? recommendedItems
    : recommendedItems.slice(0, RECOMMENDED_PREVIEW_LIMIT);
  const hasMoreRecommended = recommendedItems.length > RECOMMENDED_PREVIEW_LIMIT;
  const marketStatusMessage = feedback || marketMessageForTab(marketResult, activeTab);
  const marketOffline = marketOfflineForTab(marketResult, activeTab);

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName, t);
      }
      const next = await command({ sections: [activeTab] });
      setMarketResult(next);
      setFeedback("");
    } catch (reason) {
      console.warn("[market-storefront] failed to load market data", reason);
      setFeedback(normalizeError(reason));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    setExpandedRecommended(false);
    setDetailItemId("");
    setFeedback("");
    void loadMarket(false);
  }, [activeTab]);

  async function refreshEverything(force = false) {
    await refreshServices();
    await loadMarket(force);
  }

  async function runMarketAction(item: MarketItem, actionName: "install" | "update" | "uninstall") {
    setBusyItemId(item.id);
    try {
      const action = getMarketMethod(actionName);
      if (!action) {
        throw createMissingMarketApiError(actionName, t);
      }
      const result = await action(item.id);
      setFeedback(result.message);
      await refreshEverything(true);
    } catch (reason) {
      console.warn(`[market-storefront] ${actionName} failed for ${item.id}`, reason);
      setFeedback(normalizeError(reason));
    } finally {
      setBusyItemId("");
    }
  }

  async function copyText(value: string, label: string) {
    if (!value.trim()) {
      setFeedback(t("market.cli.commandUnavailable"));
      return;
    }
    const result = await window.electronAPI.clipboard.writeText(value);
    setFeedback(result.ok ? t("market.cli.copied", { label }) : (result.message ?? t("market.cli.copyFailed")));
  }

  async function handleToolbarImport() {
    setIsImporting(true);
    try {
      if (activeTab === "plugins") {
        const install = getPluginMethod("install");
        if (!install) {
          throw createMissingPluginApiError("install", t);
        }
        const result = await install();
        setFeedback(result.message);
      } else if (activeTab === "skills") {
        const importSkill = getMarketMethod("importSkill");
        if (!importSkill) {
          throw createMissingMarketApiError("importSkill", t);
        }
        const result = await importSkill();
        setFeedback(result.message);
      } else if (activeTab === "sandboxImages") {
        const importSandboxImage = getMarketMethod("importSandboxImage");
        if (!importSandboxImage) {
          throw createMissingMarketApiError("importSandboxImage", t);
        }
        const result = await importSandboxImage();
        setFeedback(result.message);
      }
      await refreshEverything(true);
    } catch (reason) {
      console.warn("[market-storefront] import action failed", reason);
      setFeedback(normalizeError(reason));
    } finally {
      setIsImporting(false);
    }
  }

  function openPlugin(item: MarketItem) {
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

  function renderPrimaryAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    if (item.type === "cli") {
      const installed = isInstalledMarketItem(item);
      const copyLabel = installed ? t("market.cli.uninstallScript") : t("market.cli.installScript");
      const copyValue = installed ? item.cliUninstallCommand : item.cliInstallCommand;
      return (
        <>
          <button
            type="button"
            className="market-store-action is-primary"
            disabled={busy || !copyValue}
            onClick={() => void copyText(copyValue ?? "", copyLabel)}
          >
            <CopyOutlined />
            <span>{copyLabel}</span>
          </button>
          <button
            type="button"
            className="market-store-action"
            onClick={() => setDetailItemId(detailItemId === item.id ? "" : item.id)}
          >
            <InfoCircleOutlined />
            <span>{t("market.cli.viewDetails")}</span>
          </button>
        </>
      );
    }
    if (item.state === "not-installed") {
      return (
        <button
          type="button"
          className="market-store-action is-primary"
          disabled={busy || item.state === "incompatible"}
          onClick={() => void runMarketAction(item, "install")}
        >
          <CloudDownloadOutlined />
          <span>{busy ? t("market.action.installing") : t("market.action.install")}</span>
        </button>
      );
    }
    if (item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-store-action is-primary"
          disabled={busy}
          onClick={() => void runMarketAction(item, "update")}
        >
          <CloudDownloadOutlined />
          <span>{busy ? t("market.action.installing") : t("market.action.update")}</span>
        </button>
      );
    }
    if (item.type === "plugin") {
      const service = serviceById.get(item.id) ?? null;
      return (
        <button type="button" className="market-store-action" onClick={() => openPlugin(item)}>
          <AppstoreOutlined />
          <span>{canOpenPlugin(service) ? t("market.action.open") : t("market.action.manage")}</span>
        </button>
      );
    }
    if (item.type === "skill" || item.type === "pet") {
      return (
        <button
          type="button"
          className="market-store-action"
          disabled={busy}
          onClick={() => void runMarketAction(item, "uninstall")}
        >
          <CheckCircleFilled />
          <span>{busy ? t("market.action.installing") : t("market.action.uninstall")}</span>
        </button>
      );
    }
    return (
      <span className="market-store-ready-pill">
        <CheckCircleFilled />
        {t("market.action.ready")}
      </span>
    );
  }

  function renderCliDetail(item: MarketItem) {
    if (item.type !== "cli" || detailItemId !== item.id) {
      return null;
    }
    const detailUrl = itemDetailUrl(item);
    return (
      <div className="market-cli-detail">
        <div>
          <span>{t("market.cli.installScript")}</span>
          <code>{item.cliInstallCommand || t("market.cli.commandUnavailable")}</code>
        </div>
        <div>
          <span>{t("market.cli.uninstallScript")}</span>
          <code>{item.cliUninstallCommand || t("market.cli.commandUnavailable")}</code>
        </div>
        {detailUrl ? (
          <button
            type="button"
            className="market-store-action"
            onClick={() => detailUrl.startsWith("http")
              ? void window.electronAPI.shell.openExternal(detailUrl)
              : void copyText(detailUrl, t("market.cli.details"))}
          >
            <InfoCircleOutlined />
            <span>{t("market.cli.details")}</span>
          </button>
        ) : null}
      </div>
    );
  }

  function renderCard(item: MarketItem, section: "installed" | "recommended") {
    const service = item.type === "plugin" ? serviceById.get(item.id) ?? null : null;
    const displayName = item.type === "plugin" ? getServiceDisplayName(item.id, item.name) : item.name;
    const description = marketCardDescription(item);
    const commercialMeta = itemCommercialMeta(item, t);
    const metric = serviceMetric(service);
    const chips = [
      ...item.tags,
      item.sandboxKind === "environment-template" ? t("market.detail.environmentTemplate") : "",
      item.type === "cli" ? t("market.detail.scriptedInstall") : "",
      item.type === "pet" ? t("market.detail.desktopPet") : ""
    ].filter(Boolean).slice(0, 4);
    return (
      <article key={`${section}:${item.type}:${item.id}`} className={`market-store-card is-${item.type}`}>
        <div className="market-store-card-head">
          <div className="market-store-item-icon" aria-hidden="true">
            {itemIcon(item, activeTab)}
          </div>
          <div className="market-store-card-title">
            <div className="market-store-card-title-row">
              <h2>{displayName}</h2>
              <span className={`market-state-pill ${getMarketItemStatusClass(item.state)}`}>
                {marketItemStateLabel(item, t)}
              </span>
            </div>
            <div className="market-store-submeta">
              <span>{marketSourceLabel(item, t)}</span>
              <span>{marketVersionLabel(item)}</span>
              {commercialMeta ? <span>{commercialMeta}</span> : null}
              {metric ? <span>{metric}</span> : null}
            </div>
          </div>
        </div>
        {description ? <p className="market-store-description">{description}</p> : null}
        {chips.length > 0 ? (
          <div className="market-store-tags" aria-label={t("market.tags.aria", { name: displayName })}>
            {chips.map((chip) => <span key={chip}>{chip}</span>)}
          </div>
        ) : null}
        <div className="market-store-card-footer">
          {renderPrimaryAction(item)}
        </div>
        {renderCliDetail(item)}
      </article>
    );
  }

  function renderSection(
    title: string,
    subtitle: string,
    sectionItems: MarketItem[],
    section: "installed" | "recommended",
    emptyTitle: string,
    emptyDescription: string
  ) {
    return (
      <section className="market-store-section">
        <div className="market-store-section-head">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <span>{sectionItems.length}</span>
        </div>
        {sectionItems.length > 0 ? (
          <div className="market-store-grid">
            {sectionItems.map((item) => renderCard(item, section))}
          </div>
        ) : (
          <div className="market-store-empty">
            <strong>{emptyTitle}</strong>
            <span>{emptyDescription}</span>
          </div>
        )}
      </section>
    );
  }

  const toolbarImportLabel = activeTab === "plugins"
    ? t("market.plugin.import")
    : activeTab === "skills"
      ? t("market.skill.localImport")
      : activeTab === "sandboxImages"
        ? t("market.sandbox.import")
        : "";

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={getMarketTabDefinitions(t)}
      title={activeDefinition.title}
      toolbar={(
        <>
          <button type="button" className="market-toolbar-btn" onClick={() => void loadMarket(true)}>
            <ReloadOutlined />
            <span>{isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}</span>
          </button>
          {toolbarImportLabel ? (
            <button
              type="button"
              className="market-toolbar-btn market-toolbar-btn-primary"
              onClick={() => void handleToolbarImport()}
              disabled={isImporting}
            >
              <CloudDownloadOutlined />
              <span>{isImporting ? t("market.toolbar.importing") : toolbarImportLabel}</span>
            </button>
          ) : null}
        </>
      )}
    >
      <div className="market-content market-storefront">
        <div className="market-store-overview">
          <div className="market-store-category-mark" aria-hidden="true">{categoryIcon(activeTab)}</div>
          <div>
            <p>{t("market.storefront.official")}</p>
            <h2>{activeDefinition.label}</h2>
          </div>
          <dl>
            <div>
              <dt>{t("market.storefront.installedCount")}</dt>
              <dd>{installedItems.length}</dd>
            </div>
            <div>
              <dt>{t("market.storefront.recommendedCount")}</dt>
              <dd>{recommendedItems.length}</dd>
            </div>
            <div>
              <dt>{t("market.storefront.updateCount")}</dt>
              <dd>{items.filter((item) => item.state === "update-available").length}</dd>
            </div>
          </dl>
        </div>

        {marketStatusMessage ? (
          <div className={marketOffline ? "market-status is-warning" : "market-status"} aria-live="polite">
            {marketStatusMessage}
          </div>
        ) : null}

        <div className="market-filter-bar market-filter-bar-single">
          <label className="market-search">
            <AppstoreOutlined />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("market.search.storefront")}
            />
          </label>
        </div>

        <div className="market-store-scroll">
          {renderSection(
            t("market.storefront.installed"),
            t("market.storefront.installedSubtitle"),
            installedItems,
            "installed",
            isLoadingMarket ? t("market.storefront.loading") : t("market.storefront.noInstalled"),
            t("market.storefront.noInstalledDescription")
          )}

          {renderSection(
            t("market.storefront.recommended"),
            t("market.storefront.recommendedSubtitle"),
            visibleRecommendedItems,
            "recommended",
            isLoadingMarket ? t("market.storefront.loading") : t("market.storefront.noRecommended"),
            t("market.storefront.noRecommendedDescription")
          )}

          {hasMoreRecommended ? (
            <button
              type="button"
              className="market-store-more"
              onClick={() => setExpandedRecommended((expanded) => !expanded)}
            >
              {expandedRecommended
                ? t("market.storefront.showLess")
                : t("market.storefront.showMore", { count: recommendedItems.length - RECOMMENDED_PREVIEW_LIMIT })}
            </button>
          ) : null}
        </div>
      </div>
    </MarketPageFrame>
  );
}
