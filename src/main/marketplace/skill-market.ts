import fs from "node:fs";
import type { App } from "electron";
import type { MarketCommandResult } from "../../shared/contracts";
import {
  getSkillInstallDir,
  installSkillFromPath,
  listInstalledSkills,
  uninstallSkill
} from "../skill-installer";
import { t } from "../i18n/main-i18n";
import {
  downloadAsset,
  findCatalogItem,
  getMarketSettings,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  selectAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type SkillCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function skillOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "skill")
  };
}

async function loadSkillCatalog(app: App, options: MarketplaceOptions = {}): Promise<SkillCatalogResult> {
  if (options.catalog) {
    return {
      catalog: skillOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? getMarketSettings(app).apiBaseUrl
    };
  }
  const result = await loadMarketplaceCatalog(app, options, "skill market catalog request");
  return {
    ...result,
    catalog: skillOnlyCatalog(result.catalog)
  };
}

export async function listSkillMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = await loadSkillCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, listInstalledSkills(app)),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installSkillMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadSkillCatalog(app, options);
  const item = findCatalogItem(catalog, itemId, "skill");
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error(t("market.main.platformUnavailable"));
  }
  const archivePath = await downloadAsset(app, item, selected.asset);
  try {
    const result = await installSkillFromPath(app, archivePath, {
      source: "cloud",
      expectedId: item.id,
      expectedVersion: item.version,
      metadata: {
        id: item.id,
        name: item.name,
        version: item.version,
        description: item.description,
        tags: item.tags
      }
    });
    upsertInstalledRecord(app, {
      id: item.id,
      type: "skill",
      version: item.version,
      source: "cloud",
      assetUrl: selected.asset.url,
      sha256: selected.asset.sha256,
      installPath: result.installPath ?? getSkillInstallDir(app, item.id),
      installedAt: new Date().toISOString()
    });
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

export async function importSkillMarketItemFromPath(app: App, sourcePath: string): Promise<MarketCommandResult> {
  const result = await installSkillFromPath(app, sourcePath, { source: "local" });
  const installed = listInstalledSkills(app).find((item) => item.id === result.itemId);
  upsertInstalledRecord(app, {
    id: result.itemId,
    type: "skill",
    version: installed?.version ?? "0.0.0",
    source: "local",
    installPath: result.installPath ?? getSkillInstallDir(app, result.itemId),
    installedAt: new Date().toISOString()
  });
  return result;
}

export async function uninstallSkillMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  return uninstallSkill(app, itemId);
}

export const __skillMarketInternals = {
  loadSkillCatalog
};
