import type { MarketCatalogItem, MarketItem, MarketInstallState } from "../../../shared/contracts";
import type { InstalledRecord, Catalog, InstallableMarketType } from "./market-model";
import { shouldRequireInstallableAsset } from "./catalog-normalization";
import { selectAsset, compareVersions } from "./asset-selection";
import { t } from "../../support/i18n/main-i18n";
import type { App } from "electron";
import { readInstalledRecords } from "./installed-records";
import { MarketCatalogItemNotFoundError } from "./market-model";

export function catalogItemToMarketItem(item: MarketCatalogItem, record: InstalledRecord | undefined, localItem?: MarketItem): MarketItem {
  let state: MarketInstallState = "not-installed";
  let installedVersion: string | undefined;
  let installPath: string | undefined;
  let source: "cloud" | "local" = "cloud";
  if (shouldRequireInstallableAsset(item) && !selectAsset(item)) {
    state = "incompatible";
  }
  if (record) {
    installedVersion = record.version;
    installPath = record.installPath;
    state = compareVersions(item.version, record.version) > 0 ? "update-available" : "installed";
    source = record.source;
  } else if (localItem) {
    installedVersion = localItem.version;
    installPath = localItem.installPath;
    state = compareVersions(item.version, localItem.version) > 0 ? "update-available" : "local-imported";
    source = "local";
  }
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    version: item.version,
    description: item.description,
    tags: item.tags,
    state,
    source,
    marketplaceAvailable: true,
    installedVersion,
    installPath,
    serviceId: item.type === "plugin" ? item.id : undefined,
    sandboxKind: item.sandboxKind,
    websiteKind: item.websiteKind,
    readme: item.readme,
    npmPackage: item.npmPackage,
    dependencies: item.dependencies,
    metadata: item.metadata,
    author: item.author,
    createdAt: item.createdAt,
    downloadCount: item.downloadCount,
    favoriteCount: item.favoriteCount,
    favorited: item.favorited,
    skill: item.skill,
    skillFeatured: item.skillFeatured === true,
    targets: item.targets,
    assets: item.assets,
    install: item.install,
    uninstall: item.uninstall,
    detect: item.detect,
    mcpServerKey: item.type === "mcp" ? record?.resourceKey : undefined,
    webappId: item.type === "website-app" ? record?.resourceKey : undefined,
    mcpRuntimeStatus: item.type === "mcp" && record ? "configuration-written" : undefined,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    homepageUrl: item.metadata?.homepageUrl,
    message: state === "incompatible" ? t("market.main.platformUnavailable") : undefined
  };
}

export function mergeCatalogItems(app: App, catalogItems: MarketCatalogItem[], localItems: MarketItem[], records = readInstalledRecords(app)) {
  const localByKey = new Map(localItems.map((item) => [`${item.type}:${item.id}`, item]));
  const result = catalogItems.map((item) => {
    const key = `${item.type}:${item.id}`;
    const record = records.find((entry) => entry.id === item.id && entry.type === item.type);
    return catalogItemToMarketItem(item, record, localByKey.get(key));
  });
  const catalogKeys = new Set(catalogItems.map((item) => `${item.type}:${item.id}`));
  const catalogResourceKeys = new Set(records.flatMap((record) => (
    record.resourceKey && catalogKeys.has(`${record.type}:${record.id}`)
      ? [`${record.type}:${record.resourceKey}`]
      : []
  )));
  for (const localItem of localItems) {
    const localKey = `${localItem.type}:${localItem.id}`;
    if (!catalogKeys.has(localKey) && !catalogResourceKeys.has(localKey)) {
      const record = records.find((entry) => entry.id === localItem.id && entry.type === localItem.type);
      result.push({
        ...localItem,
        state: record ? "installed" : "local-imported",
        source: record?.source ?? "local",
        installedVersion: record?.version ?? localItem.installedVersion
      });
    }
  }
  return result.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function findCatalogItem(catalog: Catalog, itemId: string, type?: InstallableMarketType) {
  const item = catalog.items.find((entry) => entry.id === itemId && (!type || entry.type === type));
  if (!item) {
    throw new MarketCatalogItemNotFoundError(itemId);
  }
  return item;
}
