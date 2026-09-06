import { createHash } from "node:crypto";

import { Buffer } from "node:buffer";

import fs from "node:fs";

import path from "node:path";

import type { App } from "electron";
import type { WebsFacade } from "../webs";

import type {
  MarketAsset,
  MarketCatalogItem,
  MarketDependency,
  MarketDetectSpec,
  MarketInstallState,
  MarketItem,
  MarketItemType,
  MarketListOptions,
  MarketPlatformSpec,
  MarketScriptSpec,
  MarketSettings,
  MarketSettingsInput,
  MarketSkillProfile
} from "../../../shared/contracts";

import {
  getDesktopConfigRoot,
  getMarketplaceCacheRoot,
  getMarketplaceStateRoot
} from "../../infrastructure/filesystem/user-paths";

import { getDesktopDeviceInfo } from "../identity";

import { t } from "../../support/i18n/main-i18n";

export const DEFAULT_MARKET_API_BASE_URL = "";

export const DEFAULT_MARKETPLACE_CATALOG_URL = "";

export const MARKET_API_VERSION_PATH = "/api/v1";

export const MARKET_AUTH_ME_PATH = "/auth/me";

export const MARKET_DESKTOP_CATALOG_PATH = "/desktop/catalog";

export const MAX_MARKET_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type Catalog = {
  schemaVersion: number;
  generatedAt?: string;
  items: MarketCatalogItem[];
};

export type InstalledRecord = {
  id: string;
  type: MarketItemType;
  version: string;
  platform?: string;
  source: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  installPath?: string;
  resourceKey?: string;
  skillPackage?: boolean;
  installedAt: string;
};

export type MarketplaceOptions = MarketListOptions & {
  catalogSnapshot?: unknown;
  catalogUrl?: string;
  catalog?: Catalog;
  apiBaseUrl?: string;
  marketEnabled?: boolean;
  containerHubBaseUrl?: string;
  containerHubAuthToken?: string;
  fetchImpl?: typeof fetch;
  issueMarketAccessToken?: MarketAccessTokenIssuer;
  createContainerHubClient?: (config: {
    baseURL: string;
    authToken?: string;
    timeoutMs?: number;
    defaultEnvironmentName?: string;
  }) => any;
  webs?: Pick<
    WebsFacade,
    | "disposeWebappInstallation"
    | "webappRuntime"
    | "webappWindowManager"
  >;
};

export type MarketAccessTokenReason = "missing" | "unauthorized";

export type MarketAccessTokenIssuer = (
  app: App,
  reason: MarketAccessTokenReason
) => Promise<string> | string;

export type InstallableMarketType = Extract<MarketItemType, "plugin" | "skill" | "agent" | "sandbox-image" | "pet" | "cli" | "mcp" | "website-app" | "software-package">;

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

export class MarketCatalogItemNotFoundError extends Error {
  readonly code = "market_catalog_item_not_found";
  readonly itemId: string;

  constructor(itemId: string) {
    super(t("market.main.catalogItemNotFound", { itemId }));
    this.name = "MarketCatalogItemNotFoundError";
    this.itemId = itemId;
  }
}

export let configuredMarketAccessTokenIssuer: MarketAccessTokenIssuer | null = null;

export function configureMarketAccessTokenIssuer(issuer: MarketAccessTokenIssuer | null) {
  configuredMarketAccessTokenIssuer = issuer;
}

export function resolveMarketFetchImpl(fetchImpl?: typeof fetch) {
  return fetchImpl ?? fetch;
}

export function ensureMarketplaceRoots(app: App) {
  const cacheRoot = getMarketplaceCacheRoot(app);
  const stateRoot = getMarketplaceStateRoot(app);
  fs.mkdirSync(path.join(cacheRoot, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(cacheRoot, "backups"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  return { cacheRoot, stateRoot };
}

export function installedRecordsPath(app: App) {
  return path.join(ensureMarketplaceRoots(app).stateRoot, "marketplace-installed.json");
}

export function marketplaceSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "market.json");
}

export function downloadsRoot(app: App) {
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

export function asCount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.replace(/[^0-9]+/gu, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function asBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

export function isMarketItemType(value: unknown): value is MarketItemType {
  return (
    value === "plugin" ||
    value === "skill" ||
    value === "agent" ||
    value === "sandbox-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "mcp" ||
    value === "website-app" ||
    value === "software-package"
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
    value === "mcp" ||
    value === "website-app" ||
    value === "software-package"
  ) {
    return value;
  }
  return null;
}

export function normalizeSandboxKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "environment-template"
    ? "environment-template" as const
    : kind === "container-image"
      ? "container-image" as const
      : undefined;
}

export function normalizeWebsiteKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "external"
    ? "external" as const
    : kind === "local-app"
      ? "local-app" as const
      : undefined;
}

export function isKnownArchiveType(value: string): value is MarketAsset["archiveType"] {
  return (
    value === "tar.gz" ||
    value === "zip" ||
    value === "skill" ||
    value === "md" ||
    value === "agent" ||
    value === "sandbox-template" ||
    value === "container-image" ||
    value === "pet" ||
    value === "cli" ||
    value === "json" ||
    value === "website-app"
  );
}

export function normalizeAsset(value: unknown): MarketAsset | null {
  const raw = asObject(value);
  const url = asString(raw.url).trim();
  if (!url) {
    return null;
  }
  const archiveType = asString(raw.archiveType);
  if (!isKnownArchiveType(archiveType)) {
    return null;
  }
  return {
    url,
    sha256: asString(raw.sha256).trim(),
    integrity: asString(raw.integrity).trim() || undefined,
    sizeBytes: asNumber(raw.sizeBytes),
    archiveType,
    platform: asString(raw.platform).trim() || undefined,
    role: asString(raw.role).trim() || undefined
  };
}

export function normalizeDependency(value: unknown): MarketDependency | null {
  const raw = asObject(value);
  const kind = asString(raw.kind).trim();
  const phase = asString(raw.phase).trim();
  if (!kind && !phase) {
    return null;
  }
  return {
    kind,
    phase,
    required: raw.required === true,
    id: asString(raw.id).trim() || undefined,
    serviceId: asString(raw.serviceId).trim() || undefined,
    command: asString(raw.command).trim() || undefined,
    runtime: asString(raw.runtime).trim() || undefined,
    capability: asString(raw.capability).trim() || undefined,
    version: asString(raw.version).trim() || undefined,
    displayName: asString(raw.displayName).trim() || undefined,
    installHint: asString(raw.installHint).trim() || undefined
  };
}

export function normalizeDependencies(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeDependency).filter((item): item is MarketDependency => Boolean(item))
    : [];
}

export function normalizeScriptSpec(value: unknown): MarketScriptSpec | undefined {
  const raw = asObject(value);
  const spec = {
    command: asString(raw.command).trim() || undefined,
    scriptUrl: asString(raw.scriptUrl).trim() || undefined,
    sha256: asString(raw.sha256).trim() || undefined,
    integrity: asString(raw.integrity).trim() || undefined
  };
  return spec.command || spec.scriptUrl || spec.sha256 || spec.integrity ? spec : undefined;
}

export function normalizeDetectSpec(value: unknown): MarketDetectSpec | undefined {
  const raw = asObject(value);
  const spec = {
    commands: asStringArray(raw.commands).map((item) => item.trim()).filter(Boolean),
    versionCommand: asString(raw.versionCommand).trim() || undefined
  };
  return spec.commands.length > 0 || spec.versionCommand ? spec : undefined;
}

export function normalizeMetadata(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asObject(value))
      .map(([key, item]) => [key, asString(item).trim()])
      .filter(([, item]) => item)
  );
}

export function normalizeSkillProfile(value: unknown): MarketSkillProfile | undefined {
  const raw = asObject(value);
  const kind = asString(raw.kind).trim().toLowerCase();
  if (kind !== "single" && kind !== "package") {
    return undefined;
  }
  const includedSkills = Array.isArray(raw.includedSkills)
    ? raw.includedSkills.flatMap((entry) => {
      const item = asObject(entry);
      const id = asString(item.id).trim();
      if (!id) return [];
      return [{
        id,
        name: asString(item.name).trim() || undefined,
        optional: asBoolean(item.optional),
        sortOrder: asNumber(item.sortOrder)
      }];
    })
    : [];
  return {
    kind,
    packageMode: asString(raw.packageMode).trim() || undefined,
    includedSkills: includedSkills.length > 0 ? includedSkills : undefined
  };
}

export function normalizePlatformSpec(key: string, value: unknown): MarketPlatformSpec | null {
  const raw = asObject(value);
  const platform = asString(raw.platform).trim() || asString(raw.key).trim() || key.trim() || "universal";
  if (!platform) {
    return null;
  }
  const dependencies = normalizeDependencies(raw.dependencies);
  const metadata = normalizeMetadata(raw.metadata);
  const spec: MarketPlatformSpec = {
    platform,
    os: asString(raw.os).trim() || undefined,
    arch: asString(raw.arch).trim() || undefined,
    description: asString(raw.description).trim() || undefined,
    readme: asString(raw.readme).trim() || undefined,
    minDesktopVersion: asString(raw.minDesktopVersion).trim() || undefined,
    metadata,
    dependencies,
    install: normalizeScriptSpec(raw.install),
    uninstall: normalizeScriptSpec(raw.uninstall),
    detect: normalizeDetectSpec(raw.detect)
  };
  return spec;
}

export function normalizeTargets(value: unknown, assets: Record<string, MarketAsset>) {
  const targets: Record<string, MarketPlatformSpec> = {};
  for (const [key, rawPlatform] of Object.entries(asObject(value))) {
    const normalizedKey = key.trim() || "universal";
    const platform = normalizePlatformSpec(normalizedKey, rawPlatform);
    if (platform) {
      targets[platform.platform] = platform;
    }
  }
  for (const [key] of Object.entries(assets)) {
    const normalizedKey = key.trim() || "universal";
    if (!targets[normalizedKey]) {
      targets[normalizedKey] = {
        platform: normalizedKey
      };
    }
  }
  return targets;
}

export function isDesktopInstallableAsset(
  item: Pick<MarketCatalogItem, "type" | "sandboxKind">,
  asset: MarketAsset
) {
  if (item.type === "plugin" || item.type === "skill") {
    return asset.archiveType === "zip";
  }
  if (item.type === "agent") {
    return asset.archiveType === "zip" || asset.archiveType === "agent";
  }
  if (item.type === "pet") {
    return asset.archiveType === "zip" || asset.archiveType === "pet";
  }
  if (item.type === "cli") {
    return asset.archiveType === "zip" || asset.archiveType === "cli";
  }
  if (item.type === "website-app") {
    return asset.archiveType === "zip" || asset.archiveType === "website-app";
  }
  if (item.type === "software-package") {
    return asset.archiveType === "zip" || asset.archiveType === "tar.gz";
  }
  if (item.type === "sandbox-image") {
    if (item.sandboxKind === "container-image" || asset.archiveType === "container-image") {
      return asset.archiveType === "container-image" || asset.archiveType === "tar.gz";
    }
    return asset.archiveType === "zip" || asset.archiveType === "sandbox-template";
  }
  return false;
}

export function shouldRequireInstallableAsset(item: MarketCatalogItem) {
  return item.type === "plugin" ||
    (item.type === "skill" && item.skill?.kind !== "package") ||
    item.type === "agent" ||
    item.type === "pet" ||
    item.type === "website-app" ||
    item.type === "software-package" ||
    (item.type === "sandbox-image" && item.sandboxKind === "environment-template");
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
    const sandboxKind = normalizeSandboxKind(item.sandboxKind);
    const websiteKind = normalizeWebsiteKind(item.websiteKind);
    const assets: Record<string, MarketAsset> = {};
    for (const [key, assetRaw] of Object.entries(asObject(item.assets))) {
      const asset = normalizeAsset(assetRaw);
      if (asset) {
        assets[key] = asset;
      }
    }
    const rawMetadata = asObject(item.metadata);
    const metadata = normalizeMetadata(rawMetadata);
    const installSpec = normalizeScriptSpec(item.install);
    const uninstallSpec = normalizeScriptSpec(item.uninstall);
    const detectSpec = normalizeDetectSpec(item.detect);
    const install = asObject(installSpec);
    const installCommand = asString(install.command).trim();
    const installScriptUrl = asString(install.scriptUrl).trim();
    if (installCommand) metadata.installCommand = installCommand;
    if (installScriptUrl) metadata.installScriptUrl = installScriptUrl;
    const uninstall = asObject(uninstallSpec);
    const uninstallCommand = asString(uninstall.command).trim();
    const uninstallScriptUrl = asString(uninstall.scriptUrl).trim();
    if (uninstallCommand) metadata.uninstallCommand = uninstallCommand;
    if (uninstallScriptUrl) metadata.uninstallScriptUrl = uninstallScriptUrl;
    const publishedAt = asString(item.publishedAt).trim() || undefined;
    const updatedAt = asString(item.updatedAt).trim() || undefined;
    const createdAt = asString(item.createdAt).trim() || asString(rawMetadata.createdAt).trim() || publishedAt;
    const author = asString(item.author).trim() || metadata.author || undefined;
    const downloadCount = asCount(item.downloadCount ?? rawMetadata.downloadCount ?? rawMetadata.downloads ?? item.downloads);
    const favoriteCount = asCount(item.favoriteCount ?? rawMetadata.favoriteCount ?? rawMetadata.favorites ?? item.favorites);
    const favorited = asBoolean(item.favorited ?? rawMetadata.favorited ?? rawMetadata.favorite);
    const targets = normalizeTargets(item.targets, assets);
    if (publishedAt) metadata.publishedAt = publishedAt;
    if (updatedAt) metadata.updatedAt = updatedAt;
    if (createdAt) metadata.createdAt = createdAt;
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
      readme: asString(item.readme).trim() || undefined,
      tags: asStringArray(item.tags),
      minDesktopVersion: asString(item.minDesktopVersion).trim() || undefined,
      sandboxKind,
      websiteKind,
      npmPackage: asString(item.npmPackage).trim() || undefined,
      author,
      createdAt,
      downloadCount,
      favoriteCount,
      favorited,
      skill: normalizeSkillProfile(item.skill),
      dependencies: normalizeDependencies(item.dependencies),
      metadata,
      targets,
      install: installSpec,
      uninstall: uninstallSpec,
      detect: detectSpec,
      publishedAt,
      updatedAt,
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

export function isLoopbackHostname(value: unknown) {
  const hostname = asString(value).trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
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
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(t("market.main.marketApiSecureUrlRequired"));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(t("market.main.marketApiNoSearch"));
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (pathname === MARKET_API_VERSION_PATH || pathname.endsWith(MARKET_API_VERSION_PATH)) {
    return `${parsed.origin}${pathname}`;
  }
  throw new Error(t("market.main.marketApiInvalidPath"));
}

export function catalogUrlFromApiBaseUrl(value: unknown) {
  const baseUrl = normalizeMarketApiBaseUrl(value).replace(/\/+$/u, "");
  return baseUrl ? `${baseUrl}${MARKET_DESKTOP_CATALOG_PATH}` : "";
}

export function getMarketplaceCatalogUrl(app: App, options: MarketplaceOptions = {}) {
  if (options.catalogUrl) {
    return options.catalogUrl;
  }
  if (options.apiBaseUrl !== undefined) {
    return options.marketEnabled === false ? "" : catalogUrlFromApiBaseUrl(options.apiBaseUrl);
  }
  const settings = getMarketSettings(app);
  if (settings.enabled !== true) {
    return "";
  }
  return catalogUrlFromApiBaseUrl(settings.apiBaseUrl);
}

export function getMarketApiBaseUrl(app: App, options: MarketplaceOptions = {}) {
  if (options.apiBaseUrl !== undefined) {
    return options.marketEnabled === false ? "" : normalizeMarketApiBaseUrl(options.apiBaseUrl);
  }
  const settings = getMarketSettings(app);
  return settings.enabled === true ? settings.apiBaseUrl : "";
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
    const apiBaseUrl = normalizeMarketApiBaseUrl(saved.apiBaseUrl);
    return {
      enabled: saved.enabled === true,
      apiBaseUrl
    };
  } catch {
    return {
      enabled: false,
      apiBaseUrl: DEFAULT_MARKET_API_BASE_URL
    };
  }
}

export function saveMarketSettings(
  app: App,
  input: MarketSettingsInput,
  platform: NodeJS.Platform = process.platform
): MarketSettings {
  const apiBaseUrl = normalizeMarketApiBaseUrl(input.apiBaseUrl);
  const settings = {
    enabled: input.enabled === true,
    apiBaseUrl
  };
  writeJsonFile(marketplaceSettingsPath(app, platform), settings);
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
      if (!record || typeof record.id !== "string" || !type) {
        return null;
      }
      const normalized: InstalledRecord = { ...record, type };
      delete (normalized as InstalledRecord & { agentKeys?: unknown }).agentKeys;
      const legacyIncludedItemIds = (record as InstalledRecord & { includedItemIds?: unknown }).includedItemIds;
      delete (normalized as InstalledRecord & { includedItemIds?: unknown }).includedItemIds;
      normalized.skillPackage = record.skillPackage === true || (
        Array.isArray(legacyIncludedItemIds) && legacyIncludedItemIds.length > 0
      ) || undefined;
      return normalized;
    })
    .filter((record): record is InstalledRecord => Boolean(record));
}
