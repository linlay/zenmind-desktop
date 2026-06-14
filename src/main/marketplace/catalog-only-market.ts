import type { App } from "electron";
import type { MarketItemType } from "../../shared/contracts";
import { t } from "../i18n/main-i18n";
import {
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type CatalogOnlyResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function typeOnlyCatalog(catalog: Catalog, type: MarketItemType): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === type)
  };
}

async function loadCatalogOnlyMarket(
  app: App,
  type: MarketItemType,
  options: MarketplaceOptions = {}
): Promise<CatalogOnlyResult> {
  if (options.catalog) {
    return {
      catalog: typeOnlyCatalog(normalizeCatalog(options.catalog), type),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }

  const result = await loadMarketplaceCatalog(app, options, `${type} market catalog request`);
  return {
    ...result,
    catalog: typeOnlyCatalog(result.catalog, type)
  };
}

export async function listCatalogOnlyMarketItems(
  app: App,
  type: MarketItemType,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const result = await loadCatalogOnlyMarket(app, type, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, []),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}
