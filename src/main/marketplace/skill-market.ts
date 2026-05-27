import fs from "node:fs";
import type { App } from "electron";
import type { MarketCatalogItem, MarketCommandResult } from "../../shared/contracts";
import {
  getSkillInstallDir,
  installSkillFromPath,
  listInstalledSkills,
  uninstallSkill
} from "../skill-installer";
import { t } from "../i18n/main-i18n";
import {
  asNumber,
  asObject,
  asString,
  asStringArray,
  DEFAULT_SKILLS_API_BASE_URL,
  downloadAsset,
  fetchJson,
  findCatalogItem,
  getMarketSettings,
  mergeCatalogItems,
  normalizeSkillsApiBaseUrl,
  selectAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const SKILLS_API_PAGE_LIMIT = 100;

type SkillsApiPage = {
  items: unknown[];
  page: number;
  limit: number;
  total: number;
};

type SkillCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function skillsApiPrefix(baseUrl: string) {
  return baseUrl.endsWith("/api/v1") ? baseUrl : `${baseUrl}/api/v1`;
}

function skillsApiListUrl(baseUrl: string, page: number, limit: number) {
  const url = new URL(`${skillsApiPrefix(baseUrl)}/skills`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function skillsApiDownloadUrl(baseUrl: string, skillName: string, version: string) {
  const url = new URL(`${skillsApiPrefix(baseUrl)}/skills/${encodeURIComponent(skillName)}/download`);
  if (version) {
    url.searchParams.set("version", version);
  }
  return url.toString();
}

async function fetchSkillsApiPage(baseUrl: string, page: number): Promise<SkillsApiPage> {
  const raw = asObject(await fetchJson(skillsApiListUrl(baseUrl, page, SKILLS_API_PAGE_LIMIT), "skills api request"));
  if (raw.success === false) {
    const error = asObject(raw.error);
    throw new Error(asString(error.message) || asString(error.code) || "skills api request failed");
  }
  const pagination = asObject(raw.pagination);
  const items = Array.isArray(raw.data) ? raw.data : [];
  return {
    items,
    page: asNumber(pagination.page) || page,
    limit: asNumber(pagination.limit) || SKILLS_API_PAGE_LIMIT,
    total: asNumber(pagination.total) || items.length
  };
}

async function fetchAllSkillsApiItems(baseUrl: string) {
  const items: unknown[] = [];
  let page = 1;
  for (let guard = 0; guard < 100; guard += 1) {
    const result = await fetchSkillsApiPage(baseUrl, page);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0 || result.items.length < result.limit) {
      break;
    }
    page = result.page + 1;
  }
  return items;
}

function skillsApiItemToCatalogItem(baseUrl: string, value: unknown): MarketCatalogItem | null {
  const raw = asObject(value);
  const id = asString(raw.name).trim();
  if (!id) {
    return null;
  }
  const version = asString(raw.latest_version).trim();
  return {
    id,
    type: "skill",
    name: asString(raw.display_name).trim() || id,
    version: version || "0.0.0",
    description: asString(raw.description),
    tags: asStringArray(raw.tags),
    assets: {
      universal: {
        url: skillsApiDownloadUrl(baseUrl, id, version),
        sha256: "",
        sizeBytes: 0,
        archiveType: "tar.gz"
      }
    }
  };
}

async function loadSkillCatalog(app: App, options: MarketplaceOptions = {}): Promise<SkillCatalogResult> {
  const baseUrl = options.skillsApiBaseUrl
    ? normalizeSkillsApiBaseUrl(options.skillsApiBaseUrl)
    : getMarketSettings(app).skillsApiBaseUrl;
  if (!options.skillsApiBaseUrl && baseUrl === DEFAULT_SKILLS_API_BASE_URL) {
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: false,
      message: t("market.main.skillCommandHint"),
      sourceUrl: baseUrl
    };
  }
  try {
    const items = (await fetchAllSkillsApiItems(baseUrl))
      .map((item) => skillsApiItemToCatalogItem(baseUrl, item))
      .filter((item): item is MarketCatalogItem => Boolean(item));
    return {
      catalog: { schemaVersion: 1, items },
      offline: false,
      message: t("market.main.skillCatalogRefreshed"),
      sourceUrl: baseUrl
    };
  } catch (error) {
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: t("market.main.skillCatalogUnavailable", { reason: error instanceof Error ? error.message : String(error) }),
      sourceUrl: baseUrl
    };
  }
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
