import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  CopyOutlined,
  DownloadOutlined,
  FilterOutlined,
  GlobalOutlined,
  HddOutlined,
  HeartFilled,
  HeartOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PlusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SmileOutlined,
  SortAscendingOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Alert, Button, Card, Dropdown, Empty, Input, Modal, Tag } from "antd";
import type { MenuProps } from "antd";
import { PRODUCT_NAME } from "../../../shared/brand";
import type { MarketItem, MarketItemType, ServiceState } from "@shared/contracts";
import { createAgentWebclientAgentPath } from "../../../shared/agent-webclient-routes";
import { useNavigate } from "react-router-dom";
import { buildSettingsSectionPath } from "../../settings/settingsRoutes";
import { getServiceDisplayName } from "../../service-display";
import { useI18n } from "../../i18n/useI18n";
import { useServices } from "../../services/ServicesContext";
import { registerDesktopActionProvider } from "../../services/desktopActionRegistry";
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
  marketTabForItemType,
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

type RangeMode = "all" | "installed" | "updates";
type SortMode = "popular" | "latest" | "rating";
type SearchFilterMenu = "sort" | "scope" | null;
type MarketFeedbackType = "success" | "info" | "warning" | "error";
type SkillAssistantMode = "find" | "create";

const SKILL_COMPOSER_INTENT: Record<SkillAssistantMode, "find-skill" | "create-skill"> = {
  find: "find-skill",
  create: "create-skill"
};

function isInstalledMarketItem(item: MarketItem) {
  return item.state === "installed" || item.state === "update-available" || item.state === "local-imported";
}

function isCloudMarketItem(item: MarketItem) {
  return Boolean(item.marketplaceAvailable || item.source === "cloud");
}

function isCloudSkillStorefrontItem(item: MarketItem) {
  return isCloudMarketItem(item) && (
    item.state === "not-installed" ||
    item.state === "update-available" ||
    item.state === "incompatible" ||
    item.state === "failed"
  );
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
  if (tab === "mcps") return result.mcpMessage ?? "";
  if (tab === "softwarePackages") return result.softwarePackageMessage ?? "";
  return result.cliMessage ?? "";
}

function marketOfflineForTab(result: ReturnType<typeof createEmptyMarketResult>, tab: MarketTab) {
  if (tab === "plugins") return Boolean(result.pluginOffline);
  if (tab === "skills") return Boolean(result.skillOffline);
  if (tab === "agents") return Boolean(result.agentOffline);
  if (tab === "sandboxImages") return Boolean(result.sandboxOffline);
  if (tab === "pets") return Boolean(result.petOffline);
  if (tab === "websiteApps") return Boolean(result.websiteAppOffline);
  if (tab === "mcps") return Boolean(result.mcpOffline);
  if (tab === "softwarePackages") return Boolean(result.softwarePackageOffline);
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

function marketSortLabel(sortMode: SortMode, t: ReturnType<typeof useI18n>["t"]) {
  switch (sortMode) {
    case "latest":
      return t("market.sort.latest");
    case "rating":
      return t("market.sort.rating");
    case "popular":
    default:
      return t("market.sort.popular");
  }
}

function marketScopeLabel(rangeMode: RangeMode, t: ReturnType<typeof useI18n>["t"]) {
  switch (rangeMode) {
    case "installed":
      return t("market.scope.installed");
    case "updates":
      return t("market.scope.updates");
    case "all":
    default:
      return t("market.scope.all");
  }
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
    case "mcp":
      return t("market.type.mcp");
    case "website-app":
      return t("market.type.websiteApp");
    case "software-package":
      return t("market.type.softwarePackage");
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
    case "mcp":
      return <LinkOutlined />;
    case "website-app":
      return <GlobalOutlined />;
    case "software-package":
      return <HddOutlined />;
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
  return item.author || item.metadata?.author || PRODUCT_NAME;
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

export function StorefrontMarket({ activeTab, initialItemId = "", onTabChange }: MarketViewProps) {
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [searchFilterMenu, setSearchFilterMenu] = useState<SearchFilterMenu>(null);
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [favoritingItemKey, setFavoritingItemKey] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackType, setFeedbackType] = useState<MarketFeedbackType>("info");
  const [isImporting, setIsImporting] = useState(false);
  const [isOpeningSkillAssistant, setIsOpeningSkillAssistant] = useState(false);
  const [selectedDetailItem, setSelectedDetailItem] = useState<MarketItem | null>(null);
  const searchFilterRef = useRef<HTMLDivElement | null>(null);

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
      activeItems.filter((item) => {
        const matchesView = activeTab === "skills"
          ? rangeMode === "installed"
            ? isInstalledMarketItem(item)
            : isCloudSkillStorefrontItem(item)
          : rangeMatches(item, rangeMode);
        return matchesView && matchesMarketItemQuery(item, query, t);
      }),
      sortMode
    ),
    [activeItems, activeTab, query, rangeMode, sortMode, t]
  );
  const marketStatusMessage = feedback || marketMessageForTab(marketResult, activeTab);
  const marketOffline = marketOfflineForTab(marketResult, activeTab);
  const shouldShowMarketStatus = Boolean(feedback) || Boolean(marketOffline && marketStatusMessage);

  async function loadMarket(force = false, preserveFeedback = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName, t);
      }
      const next = await command();
      setMarketResult(next);
      const initialItem = initialItemId
        ? next.items.find((item) => item.id === initialItemId) ?? null
        : null;
      if (initialItem) {
        setSelectedDetailItem(initialItem);
        const initialTab = marketTabForItemType(initialItem.type);
        if (initialTab && initialTab !== activeTab) {
          onTabChange(initialTab);
        }
      }
      if (!preserveFeedback) {
        setFeedback("");
        setFeedbackType("info");
      }
    } catch (reason) {
      console.warn("[market-storefront] failed to load market data", reason);
      setFeedback(normalizeError(reason));
      setFeedbackType("error");
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  useEffect(() => {
    setRangeMode("all");
    setSearchFilterMenu(null);
  }, [activeTab]);

  useEffect(() => {
    if (!searchFilterMenu) {
      return undefined;
    }
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && searchFilterRef.current?.contains(target)) {
        return;
      }
      setSearchFilterMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchFilterMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [searchFilterMenu]);

  async function refreshEverything(force = false, preserveFeedback = false) {
    await refreshServices();
    await loadMarket(force, preserveFeedback);
  }

  useEffect(() => {
    return registerDesktopActionProvider(async (request) => {
      if (request.action !== "desktop.market.importSkill" && request.action !== "desktop.market.importSandboxImage") {
        return null;
      }
      const methodName = request.action === "desktop.market.importSkill" ? "importSkill" : "importSandboxImage";
      setIsImporting(true);
      try {
        const command = getMarketMethod(methodName);
        if (!command) {
          throw createMissingMarketApiError(methodName, t);
        }
        const result = await command();
        setFeedback(result.message);
        setFeedbackType("success");
        await refreshEverything(true, true);
        return { ok: true, result };
      } catch (reason) {
        console.warn(`[market-storefront] ${methodName} desktop action failed`, reason);
        const message = normalizeError(reason);
        setFeedback(message);
        setFeedbackType("error");
        return {
          ok: false,
          error: {
            code: "market_action_failed",
            message
          }
        };
      } finally {
        setIsImporting(false);
      }
    });
  }, [t]);

  async function runMarketAction(item: MarketItem, actionName: "install" | "update" | "uninstall") {
    setBusyItemId(item.id);
    setFeedback(t("market.action.installing"));
    setFeedbackType("info");
    try {
      const action = getMarketMethod(actionName);
      if (!action) {
        throw createMissingMarketApiError(actionName, t);
      }
      const result = await action(item.id);
      setFeedback(result.message);
      setFeedbackType("success");
      await refreshEverything(true, true);
    } catch (reason) {
      console.warn(`[market-storefront] ${actionName} failed for ${item.id}`, reason);
      setFeedback(normalizeError(reason));
      setFeedbackType("error");
    } finally {
      setBusyItemId("");
    }
  }

  async function copyText(value: string, label: string) {
    if (!value.trim()) {
      setFeedback(t("market.cli.commandUnavailable"));
      setFeedbackType("error");
      return;
    }
    const result = await window.electronAPI.clipboard.writeText(value);
    setFeedback(result.ok ? t("market.cli.copied", { label }) : (result.message ?? t("market.cli.copyFailed")));
    setFeedbackType(result.ok ? "success" : "error");
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
      setFeedbackType("success");
    } catch (reason) {
      console.warn(`[market-storefront] favorite toggle failed for ${item.id}`, reason);
      setFeedback(normalizeError(reason));
      setFeedbackType("error");
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
        setFeedbackType("success");
      } else if (activeTab === "skills") {
        const importSkill = getMarketMethod("importSkill");
        if (!importSkill) {
          throw createMissingMarketApiError("importSkill", t);
        }
        const result = await importSkill();
        setFeedback(result.message);
        setFeedbackType("success");
      } else if (activeTab === "sandboxImages") {
        const importSandboxImage = getMarketMethod("importSandboxImage");
        if (!importSandboxImage) {
          throw createMissingMarketApiError("importSandboxImage", t);
        }
        const result = await importSandboxImage();
        setFeedback(result.message);
        setFeedbackType("success");
      }
      await refreshEverything(true, true);
    } catch (reason) {
      console.warn("[market-storefront] import action failed", reason);
      setFeedback(normalizeError(reason));
      setFeedbackType("error");
    } finally {
      setIsImporting(false);
    }
  }

  async function openSkillAssistant(mode: SkillAssistantMode) {
    if (isOpeningSkillAssistant) {
      return;
    }
    setIsOpeningSkillAssistant(true);
    try {
      const settings = await window.electronAPI.assistant.getSettings();
      const agentKey = settings.chatDefaultAgentKey.trim() || settings.desktopHelperAgentKey.trim();
      if (!agentKey) {
        throw new Error(t("market.skill.assistant.agentUnavailable"));
      }
      const search = new URLSearchParams({
        newChat: String(Date.now()),
        composerIntent: SKILL_COMPOSER_INTENT[mode]
      });
      navigate(createAgentWebclientAgentPath(agentKey, search));
    } catch (reason) {
      console.warn("[market-storefront] skill assistant failed", reason);
      setFeedback(normalizeError(reason) || t("market.skill.assistant.openFailed"));
      setFeedbackType("error");
    } finally {
      setIsOpeningSkillAssistant(false);
    }
  }

  function openPlugin(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    if (canOpenPlugin(service)) {
      navigate(`/service/${item.id}`);
      return;
    }
    navigate(buildSettingsSectionPath("plugins"), {
      state: {
        selectedServiceId: item.id
      }
    });
  }

  function renderPrimaryAction(item: MarketItem, compact = false) {
    const busy = busyItemId === item.id;
    if (isListOnlyMarketItem(item)) {
      return (
        <Button
          aria-label={t("market.action.details")}
          className={`market-store-action ${compact ? "is-compact-icon" : ""}`}
          icon={<InfoCircleOutlined />}
          onClick={() => void openDetail(item)}
          title={t("market.action.details")}
        >
          {compact ? null : t("market.action.details")}
        </Button>
      );
    }
    if (item.type === "cli") {
      const installed = isInstalledMarketItem(item);
      const copyLabel = installed ? t("market.cli.uninstallScript") : t("market.cli.installScript");
      const copyValue = installed ? item.cliUninstallCommand : item.cliInstallCommand;
      return (
        <Button
          aria-label={copyLabel}
          className={`market-store-action is-primary ${compact ? "is-compact-icon" : ""}`}
          icon={<CopyOutlined />}
          loading={busy}
          disabled={busy || !copyValue}
          onClick={() => void copyText(copyValue ?? "", copyLabel)}
          title={copyLabel}
          type="primary"
        >
          {compact ? null : copyLabel}
        </Button>
      );
    }
    if (item.state === "failed" || item.state === "incompatible") {
      return (
        <Button
          aria-label={marketItemStateLabel(item, t)}
          className={`market-store-action ${compact ? "is-compact-icon" : ""}`}
          disabled
          icon={<InfoCircleOutlined />}
          title={marketItemStateLabel(item, t)}
        >
          {compact ? null : marketItemStateLabel(item, t)}
        </Button>
      );
    }
    if (item.state === "not-installed") {
      const depsCount = marketItemDepsCount(item);
      return (
        <Button
          aria-label={depsCount > 0 ? t("market.action.installDeps", { count: depsCount }) : t("market.action.install")}
          className={`market-store-action ${compact ? "is-compact-icon" : "is-primary"}`}
          disabled={busy}
          icon={compact ? <PlusOutlined /> : undefined}
          loading={busy}
          onClick={() => void runMarketAction(item, "install")}
          title={depsCount > 0 ? t("market.action.installDeps", { count: depsCount }) : t("market.action.install")}
          type={compact ? "default" : "primary"}
        >
          {compact ? null : busy ? t("market.action.installing") : depsCount > 0 ? t("market.action.installDeps", { count: depsCount }) : t("market.action.install")}
        </Button>
      );
    }
    if (item.state === "update-available") {
      return (
        <Button
          aria-label={t("market.action.update")}
          className={`market-store-action is-primary ${compact ? "is-compact-icon" : ""}`}
          disabled={busy}
          icon={compact ? <CloudDownloadOutlined /> : undefined}
          loading={busy}
          onClick={() => void runMarketAction(item, "update")}
          title={t("market.action.update")}
          type="primary"
        >
          {compact ? null : busy ? t("market.action.installing") : t("market.action.update")}
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
    if (item.type === "skill" || item.type === "pet" || item.type === "mcp" || item.type === "website-app" || item.type === "software-package") {
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
    const isCloudSource = isCloudMarketItem(item);
    const favoriteKey = `${item.type}:${item.id}`;
    const isFavoriting = favoritingItemKey === favoriteKey;
    const favoriteLabel = item.favorited ? t("market.favorite.unfavorite") : t("market.favorite.favorite");
    const chips = Array.from(new Set([
      ...item.tags,
      item.sandboxKind === "environment-template" ? t("market.detail.environmentTemplate") : "",
      item.type === "cli" ? t("market.detail.scriptedInstall") : "",
      item.type === "pet" ? t("market.detail.desktopPet") : "",
      item.type === "mcp" ? t("market.type.mcp") : "",
      item.type === "website-app" ? t("market.type.websiteApp") : "",
      item.type === "software-package" ? t("market.type.softwarePackage") : ""
    ].filter(Boolean))).slice(0, 3);
    return (
      <Card
        key={`${item.type}:${item.id}`}
        className={`market-store-card is-${item.type} is-catalog`}
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
            <div className="market-store-submeta">
              <span className={`market-store-state-pill ${getMarketItemStatusClass(item.state)}`}>
                <span className="market-store-state-dot" aria-hidden="true" />
                {marketItemStateLabel(item, t)}
              </span>
              {service ? <span className="market-store-source-pill">{serviceMetric(service)}</span> : null}
            </div>
            {description ? <p className="market-store-description">{description}</p> : null}
          </div>
          <div className="market-store-card-quick-action">
            <span className={`market-store-origin-pill ${isCloudSource ? "is-cloud" : "is-local"}`}>
              {marketSourceLabel(item, t)}
            </span>
            {renderPrimaryAction(item, true)}
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
        </div>
      </Card>
    );
  }

  const toolbarImportLabel = activeTab === "plugins"
    ? t("market.plugin.import")
    : activeTab === "sandboxImages"
      ? t("market.sandbox.import")
      : "";
  const sortOptions: Array<{ label: string; value: SortMode }> = [
    { label: t("market.sort.popular"), value: "popular" },
    { label: t("market.sort.latest"), value: "latest" },
    { label: t("market.sort.rating"), value: "rating" }
  ];
  const scopeOptions: Array<{ label: string; value: RangeMode }> = [
    { label: t("market.scope.all"), value: "all" },
    { label: t("market.scope.installed"), value: "installed" },
    { label: t("market.scope.updates"), value: "updates" }
  ];
  const sortFilterLabel = marketSortLabel(sortMode, t);
  const scopeFilterLabel = marketScopeLabel(rangeMode, t);
  const activeTypeLabel = marketTypeLabel(itemType, t);
  const installedItemCount = activeItems.filter(isInstalledMarketItem).length;
  const sectionTitle = activeTab === "skills"
    ? rangeMode === "installed"
      ? t("market.storefront.installedSkillsTitle")
      : t("market.storefront.cloudSkillsTitle")
    : t("market.storefront.allTitle", { type: activeTypeLabel });
  const emptyTitle = activeTab === "skills"
    ? rangeMode === "installed"
      ? t("market.storefront.noInstalled")
      : t("market.storefront.noCloudSkills")
    : t("market.storefront.emptyTitle");
  const emptyDescription = activeTab === "skills"
    ? rangeMode === "installed"
      ? t("market.storefront.noInstalledDescription")
      : t("market.storefront.noCloudSkillsDescription")
    : t("market.storefront.emptyDescription");
  const catalogSections = visibleItems.length > 0
    ? [{ key: "all", title: sectionTitle, items: visibleItems }]
    : [];
  const skillAddMenu: MenuProps = {
    items: [
      {
        key: "find",
        icon: <SearchOutlined />,
        label: t("market.skill.menu.find")
      },
      {
        key: "import",
        icon: <CloudDownloadOutlined />,
        label: t("market.skill.localImport")
      },
      {
        key: "create",
        icon: <PlusCircleOutlined />,
        label: t("market.skill.menu.create")
      }
    ],
    onClick: ({ key }) => {
      if (key === "import") {
        void handleToolbarImport();
        return;
      }
      void openSkillAssistant(key === "find" ? "find" : "create");
    }
  };
  const marketHeaderTools = (
    <div className="market-store-header-tools" aria-label={t("market.toolbar.filters")}>
      <Input
        allowClear
        className="market-store-search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("market.search.storefront")}
        prefix={<SearchOutlined />}
        suffix={
          <div className="market-store-search-filters" ref={searchFilterRef}>
            <button
              type="button"
              className={`market-store-search-filter-button ${searchFilterMenu === "sort" ? "is-open" : ""} ${sortMode !== "popular" ? "is-active" : ""}`}
              aria-label={`${t("market.toolbar.sort")}: ${sortFilterLabel}`}
              aria-haspopup="true"
              aria-expanded={searchFilterMenu === "sort"}
              title={`${t("market.toolbar.sort")}: ${sortFilterLabel}`}
              onClick={() => setSearchFilterMenu(searchFilterMenu === "sort" ? null : "sort")}
            >
              <SortAscendingOutlined />
            </button>
            {activeTab !== "skills" ? (
              <button
                type="button"
                className={`market-store-search-filter-button ${searchFilterMenu === "scope" ? "is-open" : ""} ${rangeMode !== "all" ? "is-active" : ""}`}
                aria-label={`${t("market.toolbar.scope")}: ${scopeFilterLabel}`}
                aria-haspopup="true"
                aria-expanded={searchFilterMenu === "scope"}
                title={`${t("market.toolbar.scope")}: ${scopeFilterLabel}`}
                onClick={() => setSearchFilterMenu(searchFilterMenu === "scope" ? null : "scope")}
              >
                <FilterOutlined />
              </button>
            ) : null}
            {searchFilterMenu ? (
              <div
                className={`market-store-search-filter-menu is-${searchFilterMenu}`}
                aria-label={searchFilterMenu === "sort" ? t("market.toolbar.sort") : t("market.toolbar.scope")}
              >
                {(searchFilterMenu === "sort" ? sortOptions : scopeOptions).map((option) => (
                  <label key={option.value} className="market-store-search-filter-row">
                    <input
                      type="radio"
                      name={`market-${searchFilterMenu}-filter`}
                      checked={searchFilterMenu === "sort" ? sortMode === option.value : rangeMode === option.value}
                      onChange={() => {
                        if (searchFilterMenu === "sort") {
                          setSortMode(option.value as SortMode);
                        } else {
                          setRangeMode(option.value as RangeMode);
                        }
                        setSearchFilterMenu(null);
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        }
        value={query}
      />
      {activeTab === "skills" ? (
        <Button
          className={`market-store-toolbar-button is-installed ${rangeMode === "installed" ? "is-active" : ""}`}
          aria-pressed={rangeMode === "installed"}
          icon={<CheckCircleOutlined />}
          onClick={() => setRangeMode(rangeMode === "installed" ? "all" : "installed")}
        >
          {t("market.toolbar.myInstalled")}
          <span className="market-store-installed-count">{installedItemCount}</span>
        </Button>
      ) : null}
      <Button
        aria-label={isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}
        title={isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}
        className="market-store-toolbar-button is-icon-only"
        icon={<ReloadOutlined />}
        loading={isLoadingMarket}
        onClick={() => void refreshEverything(true)}
      />
      {activeTab === "skills" ? (
        <Dropdown
          disabled={isImporting || isOpeningSkillAssistant}
          menu={skillAddMenu}
          placement="bottomRight"
          trigger={["click"]}
        >
          <Button
            className="market-store-toolbar-button is-add"
            icon={<PlusCircleOutlined />}
            loading={isImporting || isOpeningSkillAssistant}
          >
            {isImporting ? t("market.toolbar.importing") : t("market.toolbar.addSkill")}
          </Button>
        </Dropdown>
      ) : toolbarImportLabel ? (
        <Button
          className="market-store-toolbar-button is-add"
          icon={<PlusOutlined />}
          loading={isImporting}
          onClick={() => void handleToolbarImport()}
        >
          {isImporting ? t("market.toolbar.importing") : toolbarImportLabel}
        </Button>
      ) : null}
    </div>
  );

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      tabs={tabDefinitions}
      toolbar={marketHeaderTools}
    >
      <div className="market-content market-storefront">
        {renderDetailDialog()}
        {shouldShowMarketStatus ? (
          <Alert
            className="market-status"
            message={marketStatusMessage}
            showIcon
            type={feedback ? feedbackType : "warning"}
          />
        ) : null}

        <div className="market-store-scroll">
          {visibleItems.length > 0 ? (
            <div className="market-store-sections">
              {catalogSections.map((section) => (
                <section className={`market-store-section is-${section.key}`} key={section.key}>
                  <div className="market-store-section-head">
                    <h2>{section.title}</h2>
                    <span>{section.items.length}</span>
                  </div>
                  <div className="market-store-grid">
                    {section.items.map((item) => renderCard(item))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <Empty
              className="market-store-empty"
              description={<span>{emptyDescription}</span>}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <strong>{isLoadingMarket ? t("market.storefront.loading") : emptyTitle}</strong>
            </Empty>
          )}
        </div>
      </div>
    </MarketPageFrame>
  );
}
