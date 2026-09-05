import fs from "node:fs";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { readManifestFromArchive } from "../manifest-utils";
import { getPluginInstallDir, installPluginFromArchive, uninstallPlugin } from "../plugin-loader";
import { getAllServices } from "../services/service-registry";
import { t } from "../i18n/main-i18n";
import {
  DEFAULT_MARKETPLACE_CATALOG_URL,
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  resolveMarketAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type PluginCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function pluginOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "plugin")
  };
}

async function loadPluginCatalog(app: App, options: MarketplaceOptions = {}): Promise<PluginCatalogResult> {
  if (options.catalog) {
    return {
      catalog: pluginOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? DEFAULT_MARKETPLACE_CATALOG_URL
    };
  }

  const result = await loadMarketplaceCatalog(app, options, "market catalog request");
  return {
    ...result,
    catalog: pluginOnlyCatalog(result.catalog)
  };
}

function listLocalPlugins(app: App): MarketItem[] {
  return getAllServices()
    .filter((service) => service.kind === "plugin")
    .map((service) => ({
      id: service.id,
      type: "plugin" as const,
      name: service.name,
      version: service.version,
      description: service.description,
      tags: [],
      state: "local-imported" as const,
      source: "local" as const,
      installedVersion: service.version,
      serviceId: service.id,
      installPath: getPluginInstallDir(app, service.id)
    }));
}

export async function listPluginMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = await loadPluginCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, listLocalPlugins(app)),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installPluginMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadPluginCatalog(app, options);
  const catalogItem = findCatalogItem(catalog, itemId, "plugin");
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
  try {
    const manifest = readManifestFromArchive(archivePath);
    const manifestKind = manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as { kind?: unknown }).kind
      : undefined;
    if (manifestKind === "builtin") {
      throw new Error(t("market.main.pluginKindRequired"));
    }
    if (manifest.id !== item.id) {
      throw new Error(t("market.main.pluginIdMismatch", { expected: item.id, actual: manifest.id }));
    }
    const result = await installPluginFromArchive(app, archivePath);
    const installPath = getPluginInstallDir(app, item.id);
    upsertInstalledRecord(app, {
      id: item.id,
      type: "plugin",
      version: item.version,
      platform: resolved.platform,
      source: "cloud",
      assetUrl: resolved.asset.url,
      sha256: resolved.asset.sha256,
      installPath,
      installedAt: new Date().toISOString()
    });
    return {
      ok: result.ok,
      itemId: item.id,
      type: "plugin",
      state: result.ok ? "installed" : "failed",
      message: result.message,
      serviceId: result.serviceId,
      installPath
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

export async function uninstallPluginMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const result = await uninstallPlugin(app, itemId);
  return {
    ok: result.ok,
    itemId,
    type: "plugin",
    state: result.ok ? "not-installed" : "failed",
    message: result.message,
    serviceId: itemId
  };
}

export const __pluginMarketInternals = {
  loadPluginCatalog
};
