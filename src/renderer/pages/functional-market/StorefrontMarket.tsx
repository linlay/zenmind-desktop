import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CalendarOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  CopyOutlined,
  DownloadOutlined,
  GlobalOutlined,
  HeartFilled,
  HeartOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SmileOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Alert, Button, Card, Empty, Input, Modal, Select, Tag } from "antd";
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
  return item.type === "agent";
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

function countFromValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.replace(/[^0-9]+/gu, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function itemDownloadCount(item: MarketItem) {
  return countFromValue(
    item.downloadCount ??
    item.metadata?.downloadCount ??
    item.metadata?.downloads ??
    item.metadata?.installCount
  );
}

function itemFavoriteCount(item: MarketItem) {
  return countFromValue(
    item.favoriteCount ??
    item.metadata?.favoriteCount ??
    item.metadata?.favorites
  );
}

function formatCount(value: unknown) {
  return countFromValue(value).toLocaleString();
}

function dateFromMetadata(item: MarketItem) {
  const candidates = [
    item.updatedAt,
    item.publishedAt,
    item.createdAt,
    item.metadata?.updatedAt,
    item.metadata?.publishedAt,
    item.metadata?.releasedAt,
    item.metadata?.createdAt
  ];
  for (const raw of candidates) {
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
      const downloadDiff = itemDownloadCount(b) - itemDownloadCount(a);
      if (downloadDiff !== 0) return downloadDiff;
      const favoriteDiff = itemFavoriteCount(b) - itemFavoriteCount(a);
      if (favoriteDiff !== 0) return favoriteDiff;
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

function marketTypeIcon(type: MarketItemType) {
  switch (type) {
    case "skill":
      return <SafetyCertificateOutlined />;
    case "agent":
      return <RobotOutlined />;
    case "sandbox-image":
      return <ApiOutlined />;
    case "pet":
      return <SmileOutlined />;
    case "cli":
      return <CodeOutlined />;
    case "website-app":
      return <GlobalOutlined />;
    case "plugin":
    default:
      return <AppstoreOutlined />;
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

function marketItemDepsCount(item: MarketItem) {
  const requiredDependencies = (item.dependencies ?? []).filter((dependency) => dependency.required);
  if (requiredDependencies.length > 0) {
    return requiredDependencies.length;
  }
  for (const key of ["depsCount", "dependencyCount", "missingDepsCount", "requiredDepsCount"]) {
    const raw = item.metadata?.[key]?.trim();
    if (!raw) {
      continue;
    }
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function tagLabel(tag: string) {
  const normalized = tag.trim().replace(/^#+/u, "");
  return normalized ? `#${normalized}` : "";
}

function formatAssetSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function itemAssetSize(item: MarketItem) {
  const size = Object.values(item.assets ?? {})
    .reduce((total, asset) => total + (Number.isFinite(asset.sizeBytes) ? asset.sizeBytes : 0), 0);
  return size > 0 ? formatAssetSize(size) : "";
}

function itemAuthor(item: MarketItem) {
  return item.author || item.metadata?.author || "ZenMind";
}

function formatMarketDate(value: string | undefined, locale: string, fallback: string) {
  if (!value) {
    return fallback;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(timestamp));
}

function itemCreatedAt(item: MarketItem, locale: string, fallback: string) {
  return formatMarketDate(item.createdAt || item.publishedAt || item.metadata?.createdAt, locale, fallback);
}

function platformSummary(item: MarketItem) {
  const platforms = Object.keys(item.platforms ?? {});
  const assetPlatforms = Object.keys(item.assets ?? {});
  return [...new Set([...platforms, ...assetPlatforms])]
    .filter(Boolean)
    .sort((a, b) => {
      if (a === "universal") return -1;
      if (b === "universal") return 1;
      return a.localeCompare(b);
    })
    .join(", ");
}

function dependencySummary(item: MarketItem) {
  return (item.dependencies ?? [])
    .map((dependency) => {
      const target = dependency.displayName ||
        dependency.id ||
        dependency.serviceId ||
        dependency.command ||
        dependency.runtime ||
        dependency.capability ||
        dependency.kind;
      const parts = [
        target,
        dependency.kind && dependency.kind !== target ? dependency.kind : "",
        dependency.phase,
        dependency.version,
        dependency.required ? "required" : "optional",
        dependency.installHint
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .join("\n");
}

function assetSummary(item: MarketItem) {
  return Object.entries(item.assets ?? {})
    .map(([key, asset]) => {
      const parts = [
        key,
        asset.archiveType,
        asset.platform,
        asset.role,
        formatAssetSize(asset.sizeBytes)
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .join("\n");
}

function metadataSummary(item: MarketItem) {
  const hiddenKeys = new Set([
    "author",
    "createdAt",
    "downloadCount",
    "downloads",
    "favoriteCount",
    "favorites",
    "favorited",
    "installCommand",
    "installScriptUrl",
    "uninstallCommand",
    "uninstallScriptUrl",
    "publishedAt",
    "updatedAt"
  ]);
  return Object.entries(item.metadata ?? {})
    .filter(([key, value]) => !hiddenKeys.has(key) && value.trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function scriptSummary(script: MarketItem["install"] | MarketItem["uninstall"]) {
  if (!script) {
    return "";
  }
  return [
    script.command,
    script.scriptUrl,
    script.sha256 ? `sha256: ${script.sha256}` : "",
    script.integrity ? `integrity: ${script.integrity}` : ""
  ].filter(Boolean).join("\n");
}

function storefrontDetailRows(
  item: MarketItem,
  service: ServiceState | null,
  t: ReturnType<typeof useI18n>["t"]
) {
  const commercialMeta = itemCommercialMeta(item, t);
  const rows = [
    [t("market.storefront.detail.id"), item.id],
    [t("market.storefront.detail.type"), marketTypeLabel(item.type, t)],
    [t("market.storefront.detail.version"), marketVersionLabel(item)],
    [t("market.storefront.detail.status"), marketItemStateLabel(item, t)],
    [t("market.storefront.detail.source"), marketSourceLabel(item, t)],
    [t("market.storefront.detail.compatibility"), compatibilityLabel(item, t)],
    [t("market.storefront.detail.platforms"), platformSummary(item)],
    [t("market.storefront.detail.plan"), commercialMeta],
    [t("market.storefront.detail.tags"), item.tags.map(tagLabel).filter(Boolean).join(" ")],
    [t("market.storefront.detail.sandboxKind"), item.sandboxKind ?? ""],
    [t("market.storefront.detail.websiteKind"), item.websiteKind ?? ""],
    [t("market.storefront.detail.npmPackage"), item.npmPackage ?? ""],
    [t("market.storefront.detail.dependencies"), dependencySummary(item)],
    [t("market.storefront.detail.assets"), assetSummary(item)],
    [t("market.storefront.detail.desktopStatus"), serviceMetric(service)],
    [t("market.storefront.detail.environment"), item.environmentName ?? ""],
    [t("market.storefront.detail.engine"), item.containerEngine ?? ""],
    [t("market.storefront.detail.image"), item.imageRef ?? ""],
    [t("market.storefront.detail.imageId"), item.imageId ?? ""],
    [t("market.storefront.detail.size"), item.imageSize || itemAssetSize(item)],
    [t("market.storefront.detail.imageCreatedAt"), item.imageCreatedAt ?? ""],
    [t("market.storefront.detail.buildStatus"), item.buildStatus ?? ""],
    [t("market.storefront.detail.installPath"), item.installPath ?? ""],
    [t("market.storefront.detail.minDesktopVersion"), item.minDesktopVersion ?? ""],
    [t("market.storefront.detail.detailUrl"), itemDetailUrl(item)],
    [t("market.storefront.detail.installCommand"), item.cliInstallCommand ?? ""],
    [t("market.storefront.detail.uninstallCommand"), item.cliUninstallCommand ?? ""],
    [t("market.storefront.detail.installSpec"), scriptSummary(item.install)],
    [t("market.storefront.detail.uninstallSpec"), scriptSummary(item.uninstall)],
    [t("market.storefront.detail.detectCommands"), (item.detect?.commands ?? []).join("\n")],
    [t("market.storefront.detail.detectVersionCommand"), item.detect?.versionCommand ?? ""],
    [t("market.storefront.detail.publishedAt"), item.publishedAt ?? ""],
    [t("market.storefront.detail.updatedAt"), item.updatedAt ?? ""],
    [t("market.storefront.detail.metadata"), metadataSummary(item)]
  ];

  return rows
    .map(([label, value]) => ({ label, value: value.trim() }))
    .filter((row) => row.value.length > 0);
}

export function StorefrontMarket({ activeTab, onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [favoritingItemKey, setFavoritingItemKey] = useState("");
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
  const shouldShowMarketStatus = marketOffline && marketStatusMessage;

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

  async function toggleFavorite(item: MarketItem) {
    const key = `${item.type}:${item.id}`;
    if (favoritingItemKey) {
      return;
    }
    setFavoritingItemKey(key);
    try {
      const command = getMarketMethod("toggleFavorite");
      if (!command) {
        throw createMissingMarketApiError("toggleFavorite", t);
      }
      const result = await command({
        itemId: item.id,
        type: item.type,
        favorited: Boolean(item.favorited)
      });
      setMarketResult((current) => ({
        ...current,
        items: current.items.map((entry) => (
          entry.id === result.item.id && entry.type === result.item.type ? result.item : entry
        ))
      }));
      setSelectedDetailItem((current) => (
        current && current.id === result.item.id && current.type === result.item.type ? result.item : current
      ));
      setFeedback(result.message);
    } catch (reason) {
      console.warn(`[market-storefront] favorite toggle failed for ${item.id}`, reason);
      setFeedback(normalizeError(reason));
    } finally {
      setFavoritingItemKey("");
    }
  }

  function openDetail(item: MarketItem) {
    setSelectedDetailItem(item);
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
        <Button
          className="market-store-action"
          icon={<InfoCircleOutlined />}
          onClick={() => void openDetail(item)}
        >
          {t("market.action.details")}
        </Button>
      );
    }
    if (item.type === "cli") {
      const installed = isInstalledMarketItem(item);
      const copyLabel = installed ? t("market.cli.uninstallScript") : t("market.cli.installScript");
      const copyValue = installed ? item.cliUninstallCommand : item.cliInstallCommand;
      return (
        <Button
          className="market-store-action is-primary"
          icon={<CopyOutlined />}
          loading={busy}
          disabled={busy || !copyValue}
          onClick={() => void copyText(copyValue ?? "", copyLabel)}
          type="primary"
        >
          {copyLabel}
        </Button>
      );
    }
    if (item.state === "failed" || item.state === "incompatible") {
      return (
        <Button className="market-store-action" disabled icon={<InfoCircleOutlined />}>
          {marketItemStateLabel(item, t)}
        </Button>
      );
    }
    if (item.state === "not-installed") {
      const depsCount = marketItemDepsCount(item);
      return (
        <Button
          className="market-store-action is-primary"
          disabled={busy || item.state === "incompatible"}
          loading={busy}
          onClick={() => void runMarketAction(item, "install")}
          type="primary"
        >
          {busy ? t("market.action.installing") : depsCount > 0 ? t("market.action.installDeps", { count: depsCount }) : t("market.action.install")}
        </Button>
      );
    }
    if (item.state === "update-available") {
      return (
        <Button
          className="market-store-action is-primary"
          disabled={busy}
          loading={busy}
          onClick={() => void runMarketAction(item, "update")}
          type="primary"
        >
          {busy ? t("market.action.installing") : t("market.action.update")}
        </Button>
      );
    }
    if (item.type === "plugin") {
      return (
        <Button className="market-store-action" onClick={() => openPlugin(item)}>
          {t("market.action.manage")}
        </Button>
      );
    }
    if (item.type === "skill" || item.type === "pet" || item.type === "website-app") {
      return (
        <Button
          className="market-store-action"
          disabled={busy}
          loading={busy}
          onClick={() => void runMarketAction(item, "uninstall")}
        >
          {busy ? t("market.action.installing") : t("market.action.uninstall")}
        </Button>
      );
    }
    return (
      <Button className="market-store-action" onClick={() => void openDetail(item)}>
        {t("market.action.manage")}
      </Button>
    );
  }

  function renderDetailDialog() {
    if (!selectedDetailItem) {
      return null;
    }
    const service = selectedDetailItem.type === "plugin" ? serviceById.get(selectedDetailItem.id) ?? null : null;
    const displayName = selectedDetailItem.type === "plugin"
      ? getServiceDisplayName(selectedDetailItem.id, selectedDetailItem.name, t)
      : selectedDetailItem.name;
    const description = marketCardDescription(selectedDetailItem);
    const rows = storefrontDetailRows(selectedDetailItem, service, t);
    const favoriteKey = `${selectedDetailItem.type}:${selectedDetailItem.id}`;
    const isFavoriting = favoritingItemKey === favoriteKey;
    const favoriteLabel = selectedDetailItem.favorited
      ? t("market.favorite.unfavorite")
      : t("market.favorite.favorite");
    const favoriteIcon = selectedDetailItem.favorited ? <HeartFilled /> : <HeartOutlined />;

    return (
      <Modal
        centered
        className="market-store-detail-modal"
        destroyOnHidden
        footer={null}
        onCancel={() => setSelectedDetailItem(null)}
        open={Boolean(selectedDetailItem)}
        title={
          <div className="market-store-detail-head">
            <div className="market-store-detail-title-row">
              <span className={`market-store-item-icon is-${selectedDetailItem.type}`} aria-hidden="true">
                {marketTypeIcon(selectedDetailItem.type)}
              </span>
              <div className="market-store-detail-title">
                <Tag className="market-store-detail-category-pill" color="blue">{marketTypeLabel(selectedDetailItem.type, t)}</Tag>
                <h2>{displayName}</h2>
                <span className="market-store-detail-version">{marketVersionLabel(selectedDetailItem)}</span>
              </div>
            </div>
          </div>
        }
        width={680}
      >
        {description ? <p className="market-store-detail-description">{description}</p> : null}
        <div className="market-store-detail-meta">
          <span className="market-store-detail-meta-pill">
            <UserOutlined />
            <span>{t("market.storefront.detail.author")}</span>
            <strong>{itemAuthor(selectedDetailItem)}</strong>
          </span>
          <span className="market-store-detail-meta-pill">
            <CalendarOutlined />
            <span>{t("market.storefront.detail.createdAt")}</span>
            <strong>{itemCreatedAt(selectedDetailItem, locale, t("common.none"))}</strong>
          </span>
          <span className="market-store-detail-meta-pill">
            <DownloadOutlined />
            <span>{t("market.stats.downloads")}</span>
            <strong>{formatCount(itemDownloadCount(selectedDetailItem))}</strong>
          </span>
          <button
            type="button"
            className={selectedDetailItem.favorited ? "market-store-detail-meta-pill market-store-favorite is-active" : "market-store-detail-meta-pill market-store-favorite"}
            onClick={() => void toggleFavorite(selectedDetailItem)}
            disabled={isFavoriting}
            aria-label={`${favoriteLabel}: ${formatCount(itemFavoriteCount(selectedDetailItem))}`}
            title={favoriteLabel}
          >
            {favoriteIcon}
            <span>{t("market.stats.favorites")}</span>
            <strong>{formatCount(itemFavoriteCount(selectedDetailItem))}</strong>
          </button>
        </div>
        <dl className="market-store-detail-grid">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    );
  }

  function renderCard(item: MarketItem) {
    const service = item.type === "plugin" ? serviceById.get(item.id) ?? null : null;
    const displayName = item.type === "plugin" ? getServiceDisplayName(item.id, item.name, t) : item.name;
    const description = marketCardDescription(item);
    const favoriteKey = `${item.type}:${item.id}`;
    const isFavoriting = favoritingItemKey === favoriteKey;
    const favoriteLabel = item.favorited ? t("market.favorite.unfavorite") : t("market.favorite.favorite");
    const chips = Array.from(new Set([
      ...item.tags,
      item.sandboxKind === "environment-template" ? t("market.detail.environmentTemplate") : "",
      item.type === "cli" ? t("market.detail.scriptedInstall") : "",
      item.type === "pet" ? t("market.detail.desktopPet") : "",
      item.type === "website-app" ? t("market.type.websiteApp") : ""
    ].filter(Boolean))).slice(0, 3);
    return (
      <Card
        key={`${item.type}:${item.id}`}
        className={`market-store-card is-${item.type}`}
        classNames={{ body: "market-store-card-body" }}
        hoverable
        variant="outlined"
      >
        <div className="market-store-card-head">
          <span className={`market-store-item-icon is-${item.type}`} aria-hidden="true">
            {marketTypeIcon(item.type)}
          </span>
          <div className="market-store-title-block">
            <div className="market-store-title-line">
              <h2>{displayName}</h2>
              <span className="market-store-version">{marketVersionLabel(item)}</span>
            </div>
            {description ? <p className="market-store-description">{description}</p> : null}
          </div>
        </div>
        {chips.length > 0 ? (
          <div className="market-store-tags" aria-label={t("market.tags.aria", { name: displayName })}>
            {chips.map((chip) => <Tag className="market-store-tag" key={chip}>{tagLabel(chip)}</Tag>)}
          </div>
        ) : null}
        <div className="market-store-card-footer">
          <div className="market-store-footer-meta">
            <button
              type="button"
              className="market-store-detail-link"
              onClick={() => openDetail(item)}
            >
              <span>{t("market.action.details")}</span>
            </button>
            <div className="market-store-stats">
              <span className="market-store-stat-pill" title={t("market.stats.downloads")} aria-label={`${t("market.stats.downloads")}: ${formatCount(itemDownloadCount(item))}`}>
                <DownloadOutlined />
                <span>{formatCount(itemDownloadCount(item))}</span>
              </span>
              <button
                type="button"
                className={item.favorited ? "market-store-stat-pill market-store-stat-button is-active" : "market-store-stat-pill market-store-stat-button"}
                onClick={() => void toggleFavorite(item)}
                disabled={isFavoriting || Boolean(favoritingItemKey)}
                title={favoriteLabel}
                aria-label={`${favoriteLabel}: ${formatCount(itemFavoriteCount(item))}`}
              >
                {item.favorited ? <HeartFilled /> : <HeartOutlined />}
                <span>{formatCount(itemFavoriteCount(item))}</span>
              </button>
            </div>
          </div>
          <div className="market-store-card-action">
            {renderPrimaryAction(item)}
          </div>
        </div>
      </Card>
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
          <Input
            allowClear
            className="market-store-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("market.search.storefront")}
            prefix={<AppstoreOutlined />}
            value={query}
          />
          <Select
            className="market-store-select"
            onChange={(value) => setSortMode(value as SortMode)}
            options={[
              { label: t("market.sort.popular"), value: "popular" },
              { label: t("market.sort.latest"), value: "latest" },
              { label: t("market.sort.rating"), value: "rating" }
            ]}
            prefix={<span className="market-store-select-prefix">{t("market.toolbar.sort")}</span>}
            value={sortMode}
          />
          <Select
            className="market-store-select"
            onChange={(value) => setRangeMode(value as RangeMode)}
            options={[
              { label: t("market.scope.all"), value: "all" },
              { label: t("market.scope.installed"), value: "installed" },
              { label: t("market.scope.updates"), value: "updates" }
            ]}
            prefix={<span className="market-store-select-prefix">{t("market.toolbar.scope")}</span>}
            value={rangeMode}
          />
          <div className="market-store-toolbar-actions">
            <Button
              className="market-store-toolbar-button"
              icon={<ReloadOutlined />}
              loading={isLoadingMarket}
              onClick={() => void refreshEverything(true)}
            >
              {isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}
            </Button>
            {toolbarImportLabel ? (
              <Button
                className="market-store-toolbar-button is-primary"
                icon={<CloudDownloadOutlined />}
                loading={isImporting}
                onClick={() => void handleToolbarImport()}
                type="primary"
              >
                {isImporting ? t("market.toolbar.importing") : toolbarImportLabel}
              </Button>
            ) : null}
          </div>
        </div>

        {shouldShowMarketStatus ? (
          <Alert
            className="market-status"
            message={marketStatusMessage}
            showIcon
            type={marketOffline ? "warning" : "info"}
          />
        ) : null}

        <div className="market-store-scroll">
          {visibleItems.length > 0 ? (
            <div className="market-store-grid">
              {visibleItems.map((item) => renderCard(item))}
            </div>
          ) : (
            <Empty
              className="market-store-empty"
              description={<span>{t("market.storefront.emptyDescription")}</span>}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <strong>{isLoadingMarket ? t("market.storefront.loading") : t("market.storefront.emptyTitle")}</strong>
            </Empty>
          )}
        </div>
      </div>
    </MarketPageFrame>
  );
}
