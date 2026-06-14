import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  MarketAsset,
  MarketCatalogItem,
  MarketInstallState,
  MarketItem,
  MarketItemType,
  MarketListOptions,
  MarketSettings,
  MarketSettingsInput
} from "../../shared/contracts";
import {
  getMarketplaceCacheRoot,
  getMarketplaceConfigRoot,
  getMarketplaceStateRoot
} from "../user-paths";
import { t } from "../i18n/main-i18n";

export const DEFAULT_MARKET_API_BASE_URL = "";
export const DEFAULT_MARKETPLACE_CATALOG_URL = "";

export type Catalog = {
  schemaVersion: number;
  generatedAt?: string;
  items: MarketCatalogItem[];
};

export type InstalledRecord = {
  id: string;
  type: MarketItemType;
  version: string;
  source: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  installPath?: string;
  installedAt: string;
};

export type MarketplaceOptions = MarketListOptions & {
  catalogUrl?: string;
  catalog?: Catalog;
  marketApiBaseUrl?: string;
  containerHubBaseUrl?: string;
  containerHubAuthToken?: string;
};

export type InstallableMarketType = Extract<MarketItemType, "plugin" | "skill" | "sandbox-image" | "pet" | "cli">;

export type MarketSectionResult = {
  items: MarketItem[];
  offline: boolean;
  message: string;
  sourceUrl?: string;
};

export type MarketplaceCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function ensureMarketplaceRoots(app: App) {
  const cacheRoot = getMarketplaceCacheRoot(app);
  const configRoot = getMarketplaceConfigRoot(app);
  const stateRoot = getMarketplaceStateRoot(app);
  fs.mkdirSync(path.join(cacheRoot, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(cacheRoot, "backups"), { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  return { cacheRoot, configRoot, stateRoot };
}

export function catalogCachePath(app: App) {
  return path.join(ensureMarketplaceRoots(app).cacheRoot, "catalog-cache.json");
}

function installedRecordsPath(app: App) {
  return path.join(ensureMarketplaceRoots(app).stateRoot, "marketplace-installed.json");
}

function marketplaceSettingsPath(app: App) {
  return path.join(ensureMarketplaceRoots(app).configRoot, "settings.json");
}

function downloadsRoot(app: App) {
  return path.join(ensureMarketplaceRoots(app).cacheRoot, "downloads");
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isMarketItemType(value: unknown): value is MarketItemType {
  return (
    value === "plugin" ||
    value === "skill" ||
    value === "agent" ||
    value === "sandbox-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "website-app"
  );
}

export function normalizeMarketItemType(value: unknown): MarketItemType | null {
  if (value === "cli-tool") {
    return "cli";
  }
  if (
    value === "plugin" ||
    value === "skill" ||
    value === "agent" ||
    value === "sandbox-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "website-app"
  ) {
    return value;
  }
  return null;
}

function normalizeAsset(value: unknown): MarketAsset | null {
  const raw = asObject(value);
  const url = asString(raw.url).trim();
  if (!url) {
    return null;
  }
  const archiveType = asString(raw.archiveType);
  if (
    archiveType !== "tar.gz" &&
    archiveType !== "zip" &&
    archiveType !== "skill" &&
    archiveType !== "md" &&
    archiveType !== "agent" &&
    archiveType !== "sandbox-template" &&
    archiveType !== "container-image" &&
    archiveType !== "pet" &&
    archiveType !== "cli" &&
    archiveType !== "website-app"
  ) {
    return null;
  }
  return {
    url,
    sha256: asString(raw.sha256).trim(),
    sizeBytes: asNumber(raw.sizeBytes),
    archiveType,
    platform: asString(raw.platform).trim() || undefined
  };
}

export function normalizeCatalog(input: unknown): Catalog {
  const raw = asObject(input);
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  const items: MarketCatalogItem[] = [];
  for (const itemRaw of itemsRaw) {
    const item = asObject(itemRaw);
    const id = asString(item.id).trim();
    const type = normalizeMarketItemType(item.type);
    if (!id || !type) {
      continue;
    }
    const assets: Record<string, MarketAsset> = {};
    for (const [key, assetRaw] of Object.entries(asObject(item.assets))) {
      const asset = normalizeAsset(assetRaw);
      if (asset) {
        assets[key] = asset;
      }
    }
    const rawMetadata = asObject(item.metadata);
    const metadata: Record<string, string> = Object.fromEntries(
      Object.entries(rawMetadata)
        .map(([key, value]) => [key, asString(value).trim()])
        .filter(([, value]) => value)
    );
    const rawScripts = asObject(rawMetadata.scripts || item.scripts);
    const scriptPlatforms = [
      ["macos", "macos"],
      ["darwin", "darwin"],
      ["windows", "windows"],
      ["win32", "win32"],
      ["linux", "linux"]
    ] as const;
    for (const [sourceKey, metadataPrefix] of scriptPlatforms) {
      const script = asObject(rawScripts[sourceKey]);
      const installCommand = asString(script.installCommand).trim();
      const uninstallCommand = asString(script.uninstallCommand).trim();
      const installScriptUrl = asString(script.installScriptUrl || script.installUrl).trim();
      const uninstallScriptUrl = asString(script.uninstallScriptUrl || script.uninstallUrl).trim();
      if (installCommand) metadata[`${metadataPrefix}InstallCommand`] = installCommand;
      if (uninstallCommand) metadata[`${metadataPrefix}UninstallCommand`] = uninstallCommand;
      if (installScriptUrl) metadata[`${metadataPrefix}InstallScriptUrl`] = installScriptUrl;
      if (uninstallScriptUrl) metadata[`${metadataPrefix}UninstallScriptUrl`] = uninstallScriptUrl;
    }
    items.push({
      id,
      type,
      name: asString(item.name).trim() || id,
      version: asString(item.version).trim() || "0.0.0",
      description: asString(item.description),
      tags: asStringArray(item.tags),
      minDesktopVersion: asString(item.minDesktopVersion).trim() || undefined,
      sandboxKind: asString(item.sandboxKind).trim() === "environment-template"
        ? "environment-template"
        : asString(item.sandboxKind).trim() === "container-image" ? "container-image" : undefined,
      metadata,
      assets
    });
  }
  return {
    schemaVersion: asNumber(raw.schemaVersion) || 1,
    generatedAt: asString(raw.generatedAt).trim() || undefined,
    items
  };
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeMarketApiBaseUrl(value: unknown) {
  const input = asString(value).trim() || DEFAULT_MARKET_API_BASE_URL;
  if (!input) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(t("market.main.marketApiInvalidUrl"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("market.main.marketApiUnsupportedProtocol"));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(t("market.main.marketApiNoSearch"));
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (pathname === "/") {
    return parsed.origin;
  }
  if (pathname === "/api/v1" || pathname.endsWith("/api/v1")) {
    return `${parsed.origin}${pathname}`;
  }
  throw new Error(t("market.main.marketApiInvalidPath"));
}

export function catalogUrlFromMarketApiBaseUrl(value: unknown) {
  const baseUrl = normalizeMarketApiBaseUrl(value).replace(/\/+$/u, "");
  return baseUrl ? `${baseUrl}/desktop/catalog` : "";
}

export function getMarketplaceCatalogUrl(app: App, options: MarketplaceOptions = {}) {
  if (options.catalogUrl) {
    return options.catalogUrl;
  }
  return catalogUrlFromMarketApiBaseUrl(options.marketApiBaseUrl ?? getMarketSettings(app).marketApiBaseUrl);
}

export function normalizeContainerHubBaseUrl(value: unknown) {
  const input = asString(value).trim().replace(/\/+$/u, "");
  if (!input) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(t("market.main.containerHubInvalidUrl"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("market.main.containerHubUnsupportedProtocol"));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(t("market.main.containerHubNoSearch"));
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

export function getMarketSettings(app: App): MarketSettings {
  const saved = readJsonFile<Partial<MarketSettings>>(marketplaceSettingsPath(app), {});
  try {
    return {
      marketApiBaseUrl: normalizeMarketApiBaseUrl(saved.marketApiBaseUrl)
    };
  } catch {
    return {
      marketApiBaseUrl: DEFAULT_MARKET_API_BASE_URL
    };
  }
}

export function saveMarketSettings(app: App, input: MarketSettingsInput): MarketSettings {
  const settings = {
    marketApiBaseUrl: normalizeMarketApiBaseUrl(input.marketApiBaseUrl)
  };
  writeJsonFile(marketplaceSettingsPath(app), settings);
  return settings;
}

export function writeMarketSettingsIfAbsent(app: App, input: MarketSettingsInput) {
  const settingsPath = marketplaceSettingsPath(app);
  if (fs.existsSync(settingsPath)) {
    return false;
  }
  saveMarketSettings(app, input);
  return true;
}

export function readInstalledRecords(app: App) {
  const parsed = readJsonFile<{ records?: InstalledRecord[] } | InstalledRecord[]>(installedRecordsPath(app), []);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
  return records
    .map((record) => {
      const type = normalizeMarketItemType(record?.type);
      return record && typeof record.id === "string" && type
        ? { ...record, type }
        : null;
    })
    .filter((record): record is InstalledRecord => Boolean(record));
}

function writeInstalledRecords(app: App, records: InstalledRecord[]) {
  writeJsonFile(installedRecordsPath(app), { records });
}

export function upsertInstalledRecord(app: App, record: InstalledRecord) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === record.id && item.type === record.type));
  records.push(record);
  writeInstalledRecords(app, records);
}

export function removeInstalledRecord(app: App, itemId: string, type?: MarketItemType) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === itemId && (!type || item.type === type)));
  writeInstalledRecords(app, records);
}

export async function fetchJson(url: string, label = "market request") {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function extensionForAsset(asset: MarketAsset) {
  if (asset.archiveType === "zip") return ".zip";
  if (asset.archiveType === "md") return ".md";
  if (asset.archiveType === "skill") return ".skill";
  if (asset.archiveType === "sandbox-template") return ".tar.gz";
  if (asset.archiveType === "pet") return ".tar.gz";
  if (asset.archiveType === "cli") return ".tar.gz";
  return ".tar.gz";
}

export async function downloadAsset(app: App, item: MarketCatalogItem, asset: MarketAsset) {
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(t("market.main.downloadFailed", { status: response.status }));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (asset.sizeBytes > 0 && bytes.length !== asset.sizeBytes) {
    throw new Error(t("market.main.downloadSizeMismatch", { expected: asset.sizeBytes, actual: bytes.length }));
  }
  const downloadPath = path.join(downloadsRoot(app), `${item.id}-${Date.now()}${extensionForAsset(asset)}`);
  fs.writeFileSync(downloadPath, bytes);
  if (asset.sha256 && sha256(downloadPath) !== asset.sha256) {
    fs.rmSync(downloadPath, { force: true });
    throw new Error(t("market.main.downloadChecksumFailed"));
  }
  return downloadPath;
}

function compareVersions(left: string, right: string) {
  const parse = (value: string) => value.replace(/^v/u, "").split(/[.-]/u).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function platformCandidates() {
  if (process.platform === "win32") {
    return [`windows-${process.arch === "arm64" ? "arm64" : "x64"}`, "windows-x64", "universal"];
  }
  if (process.platform === "darwin") {
    return [`darwin-${process.arch}`, "darwin-arm64", "darwin-x64", "universal"];
  }
  return [`${process.platform}-${process.arch}`, "universal"];
}

export function selectAsset(item: MarketCatalogItem) {
  for (const candidate of platformCandidates()) {
    const asset = item.assets[candidate];
    if (asset) {
      return { key: candidate, asset };
    }
  }
  const universal = item.assets.universal;
  if (universal) {
    return { key: "universal", asset: universal };
  }
  return null;
}

export async function loadMarketplaceCatalog(app: App, options: MarketplaceOptions = {}, label = "market catalog request"): Promise<MarketplaceCatalogResult> {
  if (options.catalog) {
    return {
      catalog: normalizeCatalog(options.catalog),
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
    const catalog = normalizeCatalog(await fetchJson(catalogUrl, label));
    writeJsonFile(catalogCachePath(app), catalog);
    return {
      catalog,
      offline: false,
      message: t("market.main.catalogRefreshed"),
      sourceUrl: catalogUrl
    };
  } catch (error) {
    const cached = readJsonFile<Catalog | null>(catalogCachePath(app), null);
    if (cached) {
      return {
        catalog: normalizeCatalog(cached),
        offline: true,
        message: t("market.main.cachedCatalog", { reason: error instanceof Error ? error.message : String(error) }),
        sourceUrl: catalogUrl
      };
    }
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: t("market.main.catalogUnavailable", { reason: error instanceof Error ? error.message : String(error) }),
      sourceUrl: catalogUrl
    };
  }
}

function catalogItemToMarketItem(item: MarketCatalogItem, record: InstalledRecord | undefined, localItem?: MarketItem): MarketItem {
  let state: MarketInstallState = "not-installed";
  let installedVersion: string | undefined;
  let installPath: string | undefined;
  let source: "cloud" | "local" = "cloud";
  if (!selectAsset(item)) {
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
    state = "local-imported";
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
    installedVersion,
    installPath,
    serviceId: item.type === "plugin" ? item.id : undefined,
    sandboxKind: item.sandboxKind,
    metadata: item.metadata,
    homepageUrl: item.metadata?.homepageUrl,
    message: state === "incompatible" ? t("market.main.platformUnavailable") : undefined
  };
}

export function mergeCatalogItems(app: App, catalogItems: MarketCatalogItem[], localItems: MarketItem[]) {
  const records = readInstalledRecords(app);
  const localByKey = new Map(localItems.map((item) => [`${item.type}:${item.id}`, item]));
  const result = catalogItems.map((item) => {
    const key = `${item.type}:${item.id}`;
    const record = records.find((entry) => entry.id === item.id && entry.type === item.type);
    return catalogItemToMarketItem(item, record, localByKey.get(key));
  });
  const catalogKeys = new Set(catalogItems.map((item) => `${item.type}:${item.id}`));
  for (const localItem of localItems) {
    if (!catalogKeys.has(`${localItem.type}:${localItem.id}`)) {
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
    throw new Error(t("market.main.catalogItemNotFound", { itemId }));
  }
  return item;
}
