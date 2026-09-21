import type { App } from "electron";
import type { MarketCatalogItem } from "../../../shared/contracts";
import type { MarketplaceOptions, MarketplaceCatalogResult } from "./market-model";
import type { ResolvedMarketAsset } from "./asset-selection";
import { selectAsset, assertDesktopVersionCompatible } from "./asset-selection";
import { t } from "../../support/i18n/main-i18n";
import { getMarketApiBaseUrl, getMarketplaceCatalogUrl } from "./market-settings";
import { verifyMarketAuthentication, marketRoute, requestMarketJson, requestVisibleMarketJson } from "./market-http";
import { asObject, asString } from "./catalog-values";
import {
  normalizeMarketItemType,
  normalizeAsset,
  isDesktopInstallableAsset,
  normalizePlatformSpec,
  normalizeCatalog
} from "./catalog-normalization";

export async function resolveMarketAsset(
  app: App,
  item: MarketCatalogItem,
  options: MarketplaceOptions = {}
): Promise<ResolvedMarketAsset> {
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error(t("market.main.platformUnavailable"));
  }

  const apiBaseUrl = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!apiBaseUrl || options.catalog) {
    const platformSpec = item.targets?.[selected.key];
    assertDesktopVersionCompatible(app, item, platformSpec);
    return {
      item,
      platform: selected.key,
      asset: selected.asset,
      downloadUrl: selected.asset.url
    };
  }

  await verifyMarketAuthentication(app, apiBaseUrl, options);

  const route = marketRoute(item.type);
  const query = new URLSearchParams({
    version: item.version,
    platform: selected.key
  });
  const resolved = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}/${route}/${encodeURIComponent(item.id)}/resolve?${query.toString()}`,
    options,
    "market resolve request"
  ));
  const resolvedItemRaw = asObject(resolved.item);
  const resolvedId = asString(resolvedItemRaw.id).trim();
  const resolvedType = normalizeMarketItemType(resolvedItemRaw.type);
  if (resolvedId !== item.id || resolvedType !== item.type) {
    throw new Error(t("market.main.resolveIdentityMismatch"));
  }
  const version = asString(resolved.version).trim();
  const platform = asString(resolved.platform).trim() || selected.key;
  const asset = normalizeAsset(resolved.asset);
  if (version !== item.version || platform !== selected.key) {
    throw new Error(t("market.main.resolveIdentityMismatch"));
  }
  if (!asset || !isDesktopInstallableAsset(item, asset)) {
    throw new Error(t("market.main.platformUnavailable"));
  }
  const platformSpec = normalizePlatformSpec(platform, resolved.platformSpec) ?? item.targets?.[platform];
  const resolvedItem: MarketCatalogItem = {
    ...item,
    version,
    minDesktopVersion: platformSpec?.minDesktopVersion || item.minDesktopVersion,
    dependencies: platformSpec?.dependencies?.length ? platformSpec.dependencies : item.dependencies,
    targets: {
      ...item.targets,
      ...(platformSpec ? { [platform]: platformSpec } : {})
    },
    assets: { [platform]: asset }
  };
  assertDesktopVersionCompatible(app, resolvedItem, platformSpec);
  const downloadQuery = new URLSearchParams({ version, platform });
  return {
    item: resolvedItem,
    platform,
    asset,
    downloadUrl: `${apiBaseUrl}/${route}/${encodeURIComponent(item.id)}/download?${downloadQuery.toString()}`
  };
}

export async function loadMarketplaceCatalog(app: App, options: MarketplaceOptions = {}, label = "market catalog request"): Promise<MarketplaceCatalogResult> {
  if (options.catalog || options.catalogSnapshot) {
    return {
      catalog: normalizeCatalog(options.catalog ?? options.catalogSnapshot),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? getMarketplaceCatalogUrl(app, options)
    };
  }

  const catalogUrl = getMarketplaceCatalogUrl(app, options);
  if (!catalogUrl) {
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: t("market.main.marketApiNotConfigured"),
      sourceUrl: ""
    };
  }
  try {
    const catalog = normalizeCatalog(await requestVisibleMarketJson(app, catalogUrl, options, label));
    return {
      catalog,
      offline: false,
      message: t("market.main.catalogRefreshed"),
      sourceUrl: catalogUrl
    };
  } catch (error) {
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: t("market.main.catalogUnavailable", { reason: error instanceof Error ? error.message : String(error) }),
      sourceUrl: catalogUrl
    };
  }
}
