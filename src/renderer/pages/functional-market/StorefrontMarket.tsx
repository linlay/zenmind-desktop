import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightOutlined,
  AppstoreOutlined,
  CheckCircleFilled,
  CloudDownloadOutlined,
  CopyOutlined,
  CloseOutlined,
  InfoCircleOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import type { MarketItem, MarketItemType, ServiceState } from "@shared/contracts";
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
  MARKET_TAB_ITEM_TYPES,
  matchesMarketItemQuery,
  type MarketTab,
  type MarketViewProps
} from "./marketPageModel";
import {
  canOpenPlugin,
  marketCardDescription,
  marketItemStateLabel,
  marketSourceLabel,
  marketVersionLabel
} from "./marketDisplay";
import "./StorefrontMarket.css";

type RangeMode = "all" | "installed" | "updates";
type SortMode = "popular" | "latest" | "rating";

function isInstalledMarketItem(item: MarketItem) {
  return item.state === "installed" || item.state === "update-available" || item.state === "local-imported";
}

function isListOnlyMarketItem(item: MarketItem) {
  return item.type === "agent" || item.type === "website-app";
}

function marketMessageForTab(result: ReturnType<typeof createEmptyMarketResult>, tab: MarketTab) {
  if (tab === "plugins") return result.pluginMessage ?? "";
  if (tab === "skills") return result.skillMessage ?? "";
  if (tab === "agents") return result.agentMessage ?? "";
  if (tab === "sandboxImages") return result.sandboxMessage ?? "";
  if (tab === "pets") return result.petMessage ?? "";
  if (tab === "websiteApps") return result.websiteAppMessage ?? "";
  return result.cliMessage ?? "";
}

function marketOfflineForTab(result: ReturnType<typeof createEmptyMarketResult>, tab: MarketTab) {
  if (tab === "plugins") return Boolean(result.pluginOffline);
  if (tab === "skills") return Boolean(result.skillOffline);
  if (tab === "agents") return Boolean(result.agentOffline);
  if (tab === "sandboxImages") return Boolean(result.sandboxOffline);
  if (tab === "pets") return Boolean(result.petOffline);
  if (tab === "websiteApps") return Boolean(result.websiteAppOffline);
  return Boolean(result.cliOffline);
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
  return (item.homepageUrl || item.metadata?.readmeUrl || item.metadata?.manifestUrl || item.cliDetailCommand || "").trim();
}

function numberFromMetadata(item: MarketItem, keys: string[]) {
  for (const key of keys) {
    const raw = item.metadata?.[key];
    const value = raw ? Number.parseFloat(raw) : Number.NaN;
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function dateFromMetadata(item: MarketItem) {
  for (const key of ["publishedAt", "releasedAt", "updatedAt", "createdAt"]) {
    const raw = item.metadata?.[key];
    if (!raw) {
      continue;
    }
    const value = Date.parse(raw);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function sortMarketItems(items: MarketItem[], sortMode: SortMode) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortMode === "latest") {
      const diff = dateFromMetadata(b) - dateFromMetadata(a);
      if (diff !== 0) return diff;
    } else if (sortMode === "rating") {
      const diff = numberFromMetadata(b, ["rating", "score"]) - numberFromMetadata(a, ["rating", "score"]);
      if (diff !== 0) return diff;
    } else {
      const diff = numberFromMetadata(b, ["featuredOrder", "popularity", "downloads", "installCount"]) -
        numberFromMetadata(a, ["featuredOrder", "popularity", "downloads", "installCount"]);
      if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return sorted;
}

function rangeMatches(item: MarketItem, rangeMode: RangeMode) {
  if (rangeMode === "installed") {
    return isInstalledMarketItem(item);
  }
  if (rangeMode === "updates") {
    return item.state === "update-available";
  }
  return true;
}

function marketTypeLabel(type: MarketItemType, t: ReturnType<typeof useI18n>["t"]) {
  switch (type) {
    case "skill":
      return t("market.type.skill");
    case "agent":
      return t("market.type.agent");
    case "sandbox-image":
      return t("market.type.sandboxImage");
    case "pet":
      return t("market.type.pet");
    case "cli":
      return t("market.type.cli");
    case "website-app":
      return t("market.type.websiteApp");
    case "plugin":
    default:
      return t("market.type.plugin");
  }
}

function compatibilityLabel(item: MarketItem, t: ReturnType<typeof useI18n>["t"]) {
  if (item.message) {
    return item.message;
  }
  if (item.state === "incompatible") {
    return t("market.storefront.compatibilityMissing");
  }
  if (item.minDesktopVersion) {
    return t("market.storefront.minDesktopVersion", { version: item.minDesktopVersion });
  }
  return t("market.storefront.compatible");
}

function storefrontReadinessClass(item: MarketItem) {
  if (item.state === "failed" || item.state === "incompatible") {
    return "is-error";
  }
  if (item.state === "installing" || item.state === "update-available") {
    return "is-warning";
  }
  return "is-ready";
}

function storefrontReadinessLabel(item: MarketItem, t: ReturnType<typeof useI18n>["t"]) {
  if (item.state === "failed" || item.state === "incompatible" || item.state === "installing") {
    return marketItemStateLabel(item, t);
  }
  return t("market.action.ready");
}

function tagLabel(tag: string) {
  const normalized = tag.trim().replace(/^#+/u, "");
  return normalized ? `#${normalized}` : "";
}

function storefrontDetailRows(
  item: MarketItem,
  service: ServiceState | null,
  t: ReturnType<typeof useI18n>["t"]
) {
  const commercialMeta = itemCommercialMeta(item, t);
  const rows = [
    [t("market.storefront.detail.type"), marketTypeLabel(item.type, t)],
    [t("market.storefront.detail.version"), marketVersionLabel(item)],
    [t("market.storefront.detail.status"), marketItemStateLabel(item, t)],
    [t("market.storefront.detail.source"), marketSourceLabel(item, t)],
    [t("market.storefront.detail.compatibility"), compatibilityLabel(item, t)],
    [t("market.storefront.detail.plan"), commercialMeta],
    [t("market.storefront.detail.tags"), item.tags.map(tagLabel).filter(Boolean).join(" ")],
    [t("market.storefront.detail.desktopStatus"), serviceMetric(service)],
    [t("market.storefront.detail.environment"), item.environmentName ?? ""],
    [t("market.storefront.detail.engine"), item.containerEngine ?? ""],
    [t("market.storefront.detail.image"), item.imageRef ?? ""],
    [t("market.storefront.detail.imageId"), item.imageId ?? ""],
    [t("market.storefront.detail.size"), item.imageSize ?? ""],
    [t("market.storefront.detail.createdAt"), item.imageCreatedAt ?? ""],
    [t("market.storefront.detail.buildStatus"), item.buildStatus ?? ""],
    [t("market.storefront.detail.installPath"), item.installPath ?? ""],
    [t("market.storefront.detail.minDesktopVersion"), item.minDesktopVersion ?? ""],
    [t("market.storefront.detail.installCommand"), item.cliInstallCommand ?? ""],
    [t("market.storefront.detail.uninstallCommand"), item.cliUninstallCommand ?? ""]
  ];

  return rows
    .map(([label, value]) => ({ label, value: value.trim() }))
    .filter((row) => row.value.length > 0);
}

export function StorefrontMarket({ activeTab, onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [selectedDetailItem, setSelectedDetailItem] = useState<MarketItem | null>(null);

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const itemType = MARKET_TAB_ITEM_TYPES[activeTab];
  const tabDefinitions = useMemo(() => {
    const counts = new Map<MarketItemType, number>();
    for (const item of marketResult.items) {
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    }
    return getMarketTabDefinitions(t).map((tab) => ({
      ...tab,
      count: counts.get(MARKET_TAB_ITEM_TYPES[tab.id]) ?? 0
    }));
  }, [marketResult.items, t]);

  const activeItems = useMemo(
    () => marketResult.items.filter((item) => item.type === itemType),
    [itemType, marketResult.items]
  );
  const visibleItems = useMemo(
    () => sortMarketItems(
      activeItems.filter((item) =>
        rangeMatches(item, rangeMode) && matchesMarketItemQuery(item, query, t)
      ),
      sortMode
    ),
    [activeItems, query, rangeMode, sortMode, t]
  );
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
      const next = await command();
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
    void loadMarket(false);
  }, []);

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

  async function openDetail(item: MarketItem) {
    const detailUrl = itemDetailUrl(item);
    if (!detailUrl) {
      setSelectedDetailItem(item);
      return;
    }
    if (detailUrl.startsWith("http")) {
      await window.electronAPI.shell.openExternal(detailUrl);
      return;
    }
    await copyText(detailUrl, t("market.action.details"));
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
    if (isListOnlyMarketItem(item)) {
      return (
        <button
          type="button"
          className="market-store-action"
          onClick={() => void openDetail(item)}
        >
          <InfoCircleOutlined />
          <span>{t("market.action.details")}</span>
        </button>
      );
    }
    if (item.type === "cli") {
      const installed = isInstalledMarketItem(item);
      const copyLabel = installed ? t("market.cli.uninstallScript") : t("market.cli.installScript");
      const copyValue = installed ? item.cliUninstallCommand : item.cliInstallCommand;
      return (
        <button
          type="button"
          className="market-store-action is-primary"
          disabled={busy || !copyValue}
          onClick={() => void copyText(copyValue ?? "", copyLabel)}
        >
          <CopyOutlined />
          <span>{copyLabel}</span>
        </button>
      );
    }
    if (item.state === "failed" || item.state === "incompatible") {
      return (
        <button type="button" className="market-store-action" disabled>
          <InfoCircleOutlined />
          <span>{marketItemStateLabel(item, t)}</span>
        </button>
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

  function renderDetailDialog() {
    if (!selectedDetailItem) {
      return null;
    }
    const service = selectedDetailItem.type === "plugin" ? serviceById.get(selectedDetailItem.id) ?? null : null;
    const displayName = selectedDetailItem.type === "plugin"
      ? getServiceDisplayName(selectedDetailItem.id, selectedDetailItem.name)
      : selectedDetailItem.name;
    const description = marketCardDescription(selectedDetailItem);
    const rows = storefrontDetailRows(selectedDetailItem, service, t);

    return (
      <div className="market-store-detail-backdrop" onClick={() => setSelectedDetailItem(null)}>
        <section
          className="market-store-detail-dialog"
          aria-label={t("market.storefront.detail.dialogLabel")}
          aria-modal="true"
          role="dialog"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="market-store-detail-head">
            <div className="market-store-detail-title">
              <span className="market-store-category-pill">{marketTypeLabel(selectedDetailItem.type, t)}</span>
              <h2>{displayName}</h2>
            </div>
            <button
              type="button"
              className="market-store-detail-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => setSelectedDetailItem(null)}
            >
              <CloseOutlined />
            </button>
          </div>
          {description ? <p className="market-store-detail-description">{description}</p> : null}
          <dl className="market-store-detail-grid">
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    );
  }

  function renderCard(item: MarketItem) {
    const service = item.type === "plugin" ? serviceById.get(item.id) ?? null : null;
    const displayName = item.type === "plugin" ? getServiceDisplayName(item.id, item.name) : item.name;
    const description = marketCardDescription(item);
    const chips = Array.from(new Set([
      ...item.tags,
      item.sandboxKind === "environment-template" ? t("market.detail.environmentTemplate") : "",
      item.type === "cli" ? t("market.detail.scriptedInstall") : "",
      item.type === "pet" ? t("market.detail.desktopPet") : ""
    ].filter(Boolean))).slice(0, 3);
    return (
      <article key={`${item.type}:${item.id}`} className={`market-store-card is-${item.type}`}>
        <div className="market-store-card-head">
          <span className="market-store-category-pill">{marketTypeLabel(item.type, t)}</span>
          <span className={`market-store-readiness ${storefrontReadinessClass(item)}`}>
            <span aria-hidden="true" />
            {storefrontReadinessLabel(item, t)}
          </span>
        </div>
        <div className="market-store-title-line">
          <h2>{displayName}</h2>
          <span>{marketVersionLabel(item)}</span>
        </div>
        {description ? <p className="market-store-description">{description}</p> : null}
        {chips.length > 0 ? (
          <div className="market-store-tags" aria-label={t("market.tags.aria", { name: displayName })}>
            {chips.map((chip) => <span key={chip}>{tagLabel(chip)}</span>)}
          </div>
        ) : null}
        <div className="market-store-card-footer">
          <button
            type="button"
            className="market-store-detail-link"
            onClick={() => void openDetail(item)}
          >
            <span>{t("market.storefront.detailsDemo")}</span>
            <ArrowRightOutlined />
          </button>
          <div className="market-store-card-action">
            {renderPrimaryAction(item)}
          </div>
        </div>
      </article>
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
      tabs={tabDefinitions}
    >
      <div className="market-content market-storefront">
        {renderDetailDialog()}

        <div className="market-filter-bar market-store-toolbar" aria-label={t("market.toolbar.filters")}>
          <label className="market-search">
            <AppstoreOutlined />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("market.search.storefront")}
            />
          </label>
          <label className="market-select">
            <span>{t("market.toolbar.sort")}</span>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              <option value="popular">{t("market.sort.popular")}</option>
              <option value="latest">{t("market.sort.latest")}</option>
              <option value="rating">{t("market.sort.rating")}</option>
            </select>
          </label>
          <label className="market-select">
            <span>{t("market.toolbar.scope")}</span>
            <select value={rangeMode} onChange={(event) => setRangeMode(event.target.value as RangeMode)}>
              <option value="all">{t("market.scope.all")}</option>
              <option value="installed">{t("market.scope.installed")}</option>
              <option value="updates">{t("market.scope.updates")}</option>
            </select>
          </label>
          <div className="market-store-toolbar-actions">
            <button
              type="button"
              className="market-store-toolbar-button"
              onClick={() => void refreshEverything(true)}
              disabled={isLoadingMarket}
            >
              <ReloadOutlined />
              <span>{isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}</span>
            </button>
            {toolbarImportLabel ? (
              <button
                type="button"
                className="market-store-toolbar-button is-primary"
                onClick={() => void handleToolbarImport()}
                disabled={isImporting}
              >
                <CloudDownloadOutlined />
                <span>{isImporting ? t("market.toolbar.importing") : toolbarImportLabel}</span>
              </button>
            ) : null}
          </div>
        </div>

        {marketStatusMessage ? (
          <div className={marketOffline ? "market-status is-warning" : "market-status"} aria-live="polite">
            {marketStatusMessage}
          </div>
        ) : null}

        <div className="market-store-scroll">
          {visibleItems.length > 0 ? (
            <div className="market-store-grid">
              {visibleItems.map((item) => renderCard(item))}
            </div>
          ) : (
            <div className="market-store-empty">
              <strong>{isLoadingMarket ? t("market.storefront.loading") : t("market.storefront.emptyTitle")}</strong>
              <span>{t("market.storefront.emptyDescription")}</span>
            </div>
          )}
        </div>
      </div>
    </MarketPageFrame>
  );
}
