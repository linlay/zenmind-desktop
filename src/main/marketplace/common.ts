import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
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
  MarketSettingsInput
} from "../../shared/contracts";
import {
  getDesktopConfigRoot,
  getMarketplaceCacheRoot,
  getMarketplaceStateRoot
} from "../user-paths";
import { getDesktopDeviceInfo } from "../desktop-device-info";
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
  platform?: string;
  source: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  installPath?: string;
  resourceKey?: string;
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

let configuredMarketAccessTokenIssuer: MarketAccessTokenIssuer | null = null;

export function configureMarketAccessTokenIssuer(issuer: MarketAccessTokenIssuer | null) {
  configuredMarketAccessTokenIssuer = issuer;
}

function ensureMarketplaceRoots(app: App) {
  const cacheRoot = getMarketplaceCacheRoot(app);
  const stateRoot = getMarketplaceStateRoot(app);
  fs.mkdirSync(path.join(cacheRoot, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(cacheRoot, "backups"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  return { cacheRoot, stateRoot };
}

function installedRecordsPath(app: App) {
  return path.join(ensureMarketplaceRoots(app).stateRoot, "marketplace-installed.json");
}

function marketplaceSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "market.json");
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

function normalizeSandboxKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "environment-template"
    ? "environment-template" as const
    : kind === "container-image"
      ? "container-image" as const
      : undefined;
}

function normalizeWebsiteKind(value: unknown) {
  const kind = asString(value).trim();
  return kind === "external"
    ? "external" as const
    : kind === "local-app"
      ? "local-app" as const
      : undefined;
}

function isKnownArchiveType(value: string): value is MarketAsset["archiveType"] {
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

function normalizeDependency(value: unknown): MarketDependency | null {
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

function normalizeDependencies(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeDependency).filter((item): item is MarketDependency => Boolean(item))
    : [];
}

function normalizeScriptSpec(value: unknown): MarketScriptSpec | undefined {
  const raw = asObject(value);
  const spec = {
    command: asString(raw.command).trim() || undefined,
    scriptUrl: asString(raw.scriptUrl).trim() || undefined,
    sha256: asString(raw.sha256).trim() || undefined,
    integrity: asString(raw.integrity).trim() || undefined
  };
  return spec.command || spec.scriptUrl || spec.sha256 || spec.integrity ? spec : undefined;
}

function normalizeDetectSpec(value: unknown): MarketDetectSpec | undefined {
  const raw = asObject(value);
  const spec = {
    commands: asStringArray(raw.commands).map((item) => item.trim()).filter(Boolean),
    versionCommand: asString(raw.versionCommand).trim() || undefined
  };
  return spec.commands.length > 0 || spec.versionCommand ? spec : undefined;
}

function normalizeMetadata(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asObject(value))
      .map(([key, item]) => [key, asString(item).trim()])
      .filter(([, item]) => item)
  );
}

function normalizePlatformSpec(key: string, value: unknown): MarketPlatformSpec | null {
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

function normalizePlatforms(value: unknown, assets: Record<string, MarketAsset>) {
  const platforms: Record<string, MarketPlatformSpec> = {};
  for (const [key, rawPlatform] of Object.entries(asObject(value))) {
    const normalizedKey = key.trim() || "universal";
    const platform = normalizePlatformSpec(normalizedKey, rawPlatform);
    if (platform) {
      platforms[platform.platform] = platform;
    }
  }
  for (const [key] of Object.entries(assets)) {
    const normalizedKey = key.trim() || "universal";
    if (!platforms[normalizedKey]) {
      platforms[normalizedKey] = {
        platform: normalizedKey
      };
    }
  }
  return platforms;
}

function isDesktopInstallableAsset(
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

function shouldRequireInstallableAsset(item: MarketCatalogItem) {
  return item.type === "plugin" ||
    item.type === "skill" ||
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
    const platforms = normalizePlatforms(item.platforms, assets);
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
      dependencies: normalizeDependencies(item.dependencies),
      metadata,
      platforms,
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
  if (pathname === "/api/v1" || pathname.endsWith("/api/v1")) {
    return `${parsed.origin}${pathname}`;
  }
  throw new Error(t("market.main.marketApiInvalidPath"));
}

export function catalogUrlFromApiBaseUrl(value: unknown) {
  const baseUrl = normalizeMarketApiBaseUrl(value).replace(/\/+$/u, "");
  return baseUrl ? `${baseUrl}/desktop/catalog` : "";
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

function encodeHeaderText(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sanitizeAsciiHeaderText(value: string) {
  return value.replace(/[^\x20-\x7e]+/gu, "").trim();
}

export function getMarketDesktopDeviceHeaders(app: App) {
  const deviceInfo = getDesktopDeviceInfo(app);
  return {
    "X-Desktop-Device-Id": deviceInfo.deviceId,
    "X-Desktop-Device-Name-B64": encodeHeaderText(deviceInfo.deviceName),
    "X-Desktop-Hostname-B64": encodeHeaderText(deviceInfo.hostname),
    "X-Desktop-Username-B64": encodeHeaderText(deviceInfo.username),
    "X-Desktop-Platform": sanitizeAsciiHeaderText(deviceInfo.platform),
    "X-Desktop-Arch": sanitizeAsciiHeaderText(deviceInfo.arch)
  };
}

export function marketRoute(type: MarketItemType) {
  switch (type) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "agent":
      return "agents";
    case "sandbox-image":
      return "sandbox-images";
    case "pet":
      return "pets";
    case "cli":
      return "cli-tools";
    case "mcp":
      return "mcps";
    case "website-app":
      return "webapps";
    case "software-package":
      return "software-packages";
  }
}

async function issueMarketAccessToken(
  app: App,
  reason: MarketAccessTokenReason,
  options: MarketplaceOptions
) {
  const issuer = options.issueMarketAccessToken ?? configuredMarketAccessTokenIssuer;
  if (!issuer) {
    return "";
  }
  return String(await issuer(app, reason) || "").trim();
}

async function readMarketErrorMessage(response: Response, label: string) {
  const fallback = `${label} failed: ${response.status}`;
  try {
    const text = await response.text();
    if (!text.trim()) {
      return fallback;
    }
    const data = JSON.parse(text) as unknown;
    const raw = asObject(data);
    const error = asObject(raw.error);
    return asString(error.message).trim() || asString(raw.message).trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function requestMarket(
  app: App,
  url: string,
  init: RequestInit = {},
  options: MarketplaceOptions = {},
  label = "market request"
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let token = await issueMarketAccessToken(app, "missing", options);
  for (const reason of ["missing", "unauthorized"] as const) {
    if (reason === "unauthorized") {
      token = await issueMarketAccessToken(app, "unauthorized", options);
    }
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        ...getMarketDesktopDeviceHeaders(app),
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (response.status === 401 && reason === "missing" && (options.issueMarketAccessToken || configuredMarketAccessTokenIssuer)) {
      continue;
    }
    if (response.status === 401) {
      throw new Error(t("market.main.marketAuthRequired"));
    }
    if (!response.ok) {
      throw new Error(await readMarketErrorMessage(response, label));
    }
    return response;
  }
  throw new Error(t("market.main.marketAuthRequired"));
}

export async function requestMarketJson(
  app: App,
  url: string,
  options: MarketplaceOptions = {},
  label = "market request",
  init: RequestInit = {}
) {
  const response = await requestMarket(app, url, init, options, label);
  return response.json() as Promise<unknown>;
}

async function verifyMarketAuthentication(
  app: App,
  apiBaseUrl: string,
  options: MarketplaceOptions
) {
  const response = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}/auth/me`,
    options,
    "market authentication request"
  ));
  const user = asObject(response.user);
  if (!asString(user.id).trim()) {
    throw new Error(t("market.main.marketAuthRequired"));
  }
}

export async function fetchJson(url: string, label = "market request", headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
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
  if (asset.archiveType === "container-image" || asset.archiveType === "tar.gz") return ".tar.gz";
  if (
    asset.archiveType === "skill" ||
    asset.archiveType === "sandbox-template" ||
    asset.archiveType === "pet" ||
    asset.archiveType === "cli" ||
    asset.archiveType === "agent" ||
    asset.archiveType === "website-app"
  ) return ".zip";
  return ".zip";
}

export async function downloadAsset(
  app: App,
  item: MarketCatalogItem,
  asset: MarketAsset,
  options: MarketplaceOptions = {},
  downloadUrl = asset.url
) {
  const response = await requestMarket(app, downloadUrl, {}, options, "market asset download");
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

type ParsedSemanticVersion = {
  core: [string, string, string];
  prerelease: string[];
};

const SEMANTIC_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseSemanticVersion(value: string): ParsedSemanticVersion | null {
  const match = SEMANTIC_VERSION_PATTERN.exec(String(value || "").trim());
  if (!match) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease
  };
}

function compareNumericIdentifiers(left: string, right: string) {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string) {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (!a || !b) {
    return 0;
  }
  for (let index = 0; index < a.core.length; index += 1) {
    const diff = compareNumericIdentifiers(a.core[index], b.core[index]);
    if (diff !== 0) {
      return diff;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) {
      return 0;
    }
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function platformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) {
  const platformName = platform === "win32" ? "windows" : platform;
  const archAliases = arch === "x64"
    ? platform === "darwin" ? ["x64", "amd64"] : ["amd64", "x64"]
    : arch === "ia32"
      ? ["x86", "ia32"]
      : [arch];
  return [...new Set(archAliases.map((alias) => `${platformName}-${alias}`)), "universal"];
}

export function selectAsset(item: Pick<MarketCatalogItem, "type" | "sandboxKind"> & { assets?: Record<string, MarketAsset> }) {
  const assets = item.assets ?? {};
  for (const candidate of platformCandidates()) {
    const asset = assets[candidate];
    if (asset && isDesktopInstallableAsset(item, asset)) {
      return { key: candidate, asset };
    }
  }
  const universal = assets.universal;
  if (universal && isDesktopInstallableAsset(item, universal)) {
    return { key: "universal", asset: universal };
  }
  return null;
}

export type ResolvedMarketAsset = {
  item: MarketCatalogItem;
  platform: string;
  asset: MarketAsset;
  downloadUrl: string;
};

function currentDesktopVersion(app: App) {
  try {
    return typeof app.getVersion === "function" ? String(app.getVersion() || "").trim() : "";
  } catch {
    return "";
  }
}

function assertDesktopVersionCompatible(app: App, item: MarketCatalogItem, platformSpec?: MarketPlatformSpec) {
  const requiredVersion = platformSpec?.minDesktopVersion || item.minDesktopVersion || "";
  const desktopVersion = currentDesktopVersion(app);
  if (requiredVersion && desktopVersion && compareVersions(desktopVersion, requiredVersion) < 0) {
    throw new Error(t("market.main.desktopVersionTooOld", {
      current: desktopVersion,
      required: requiredVersion
    }));
  }
}

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
    const platformSpec = item.platforms?.[selected.key];
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
  const platformSpec = normalizePlatformSpec(platform, resolved.platformSpec) ?? item.platforms?.[platform];
  const resolvedItem: MarketCatalogItem = {
    ...item,
    version,
    minDesktopVersion: platformSpec?.minDesktopVersion || item.minDesktopVersion,
    dependencies: platformSpec?.dependencies?.length ? platformSpec.dependencies : item.dependencies,
    platforms: {
      ...item.platforms,
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
    const catalog = normalizeCatalog(await requestMarketJson(app, catalogUrl, options, label));
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

function catalogItemToMarketItem(item: MarketCatalogItem, record: InstalledRecord | undefined, localItem?: MarketItem): MarketItem {
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
    platforms: item.platforms,
    assets: item.assets,
    install: item.install,
    uninstall: item.uninstall,
    detect: item.detect,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
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
    throw new MarketCatalogItemNotFoundError(itemId);
  }
  return item;
}
