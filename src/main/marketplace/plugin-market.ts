import fs from "node:fs";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { readManifestFromArchive } from "../manifest-utils";
import { getPluginInstallDir, installPluginFromArchive, uninstallPlugin } from "../plugin-loader";
import { getAllServices } from "../services/service-registry";
import {
  catalogCachePath,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  downloadAsset,
  fetchJson,
  findCatalogItem,
  mergeCatalogItems,
  normalizeCatalog,
  readJsonFile,
  selectAsset,
  upsertInstalledRecord,
  writeJsonFile,
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
      message: "已加载指定市场清单。",
      sourceUrl: options.catalogUrl ?? DEFAULT_MARKETPLACE_CATALOG_URL
    };
  }

  const catalogUrl = options.catalogUrl ?? DEFAULT_MARKETPLACE_CATALOG_URL;
  try {
    const catalog = normalizeCatalog(await fetchJson(catalogUrl, "market catalog request"));
    writeJsonFile(catalogCachePath(app), catalog);
    return {
      catalog: pluginOnlyCatalog(catalog),
      offline: false,
      message: "市场已刷新。",
      sourceUrl: catalogUrl
    };
  } catch (error) {
    const cached = readJsonFile<Catalog | null>(catalogCachePath(app), null);
    if (cached) {
      return {
        catalog: pluginOnlyCatalog(normalizeCatalog(cached)),
        offline: true,
        message: `当前使用缓存市场：${error instanceof Error ? error.message : String(error)}`,
        sourceUrl: catalogUrl
      };
    }
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: `市场暂不可用：${error instanceof Error ? error.message : String(error)}`,
      sourceUrl: catalogUrl
    };
  }
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
  const item = findCatalogItem(catalog, itemId, "plugin");
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error("当前平台暂无可安装资源。");
  }
  const archivePath = await downloadAsset(app, item, selected.asset);
  try {
    const manifest = readManifestFromArchive(archivePath);
    if (manifest.kind !== "plugin") {
      throw new Error("云端插件包必须声明 kind=plugin");
    }
    if (manifest.id !== item.id) {
      throw new Error(`插件包 id 不匹配：期望 ${item.id}，实际 ${manifest.id}`);
    }
    const result = await installPluginFromArchive(app, archivePath);
    const installPath = getPluginInstallDir(app, item.id);
    upsertInstalledRecord(app, {
      id: item.id,
      type: "plugin",
      version: item.version,
      source: "cloud",
      assetUrl: selected.asset.url,
      sha256: selected.asset.sha256,
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
