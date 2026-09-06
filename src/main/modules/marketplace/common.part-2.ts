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

import { Catalog, InstallableMarketType, InstalledRecord, MARKET_AUTH_ME_PATH, MAX_MARKET_DOWNLOAD_BYTES, MarketAccessTokenReason, MarketCatalogItemNotFoundError, MarketplaceCatalogResult, MarketplaceOptions, asObject, asString, configuredMarketAccessTokenIssuer, downloadsRoot, getMarketApiBaseUrl, getMarketplaceCatalogUrl, installedRecordsPath, isDesktopInstallableAsset, normalizeAsset, normalizeCatalog, normalizeMarketItemType, normalizePlatformSpec, readInstalledRecords, resolveMarketFetchImpl, shouldRequireInstallableAsset } from "./common.part-1";

export function writeInstalledRecords(app: App, records: InstalledRecord[]) {
  const targetPath = installedRecordsPath(app);
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.tmp`);
  const backupPath = path.join(directory, `.${path.basename(targetPath)}.${nonce}.bak`);
  let backupActive = false;
  let targetPublished = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ records }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      backupActive = true;
    }
    fs.renameSync(temporaryPath, targetPath);
    targetPublished = true;
  } catch (error) {
    if (targetPublished) {
      fs.rmSync(targetPath, { force: true });
    }
    if (backupActive && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
      backupActive = false;
    }
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  if (backupActive) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // The new record is already committed; hidden backup cleanup is best effort.
    }
  }
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

export function removeInstalledRecordByResourceKey(app: App, resourceKey: string, type: MarketItemType) {
  const records = readInstalledRecords(app).filter((item) => !(
    item.type === type && (item.id === resourceKey || item.resourceKey === resourceKey)
  ));
  writeInstalledRecords(app, records);
}

export function replaceInstalledRecords(app: App, records: InstalledRecord[]) {
  writeInstalledRecords(app, records);
}

export function encodeHeaderText(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function sanitizeAsciiHeaderText(value: string) {
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

export async function issueMarketAccessToken(
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

export async function readMarketErrorMessage(response: Response, label: string) {
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
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  let token = await issueMarketAccessToken(app, "missing", options);
  for (const reason of ["missing", "unauthorized"] as const) {
    if (reason === "unauthorized") {
      token = await issueMarketAccessToken(app, "unauthorized", options);
    }
    const response = await fetchImpl(url, {
      ...init,
      credentials: "include",
      redirect: "error",
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

export async function requestPublicMarketJson(
  app: App,
  url: string,
  options: MarketplaceOptions = {},
  label = "market public request"
) {
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  const response = await fetchImpl(url, {
    credentials: "omit",
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(await readMarketErrorMessage(response, label));
  }
  return response.json() as Promise<unknown>;
}

export async function verifyMarketAuthentication(
  app: App,
  apiBaseUrl: string,
  options: MarketplaceOptions
) {
  const response = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}${MARKET_AUTH_ME_PATH}`,
    options,
    "market authentication request"
  ));
  const user = asObject(response.user);
  if (!asString(user.id).trim()) {
    throw new Error(t("market.main.marketAuthRequired"));
  }
}

export async function fetchJson(url: string, label = "market request", headers: Record<string, string> = {}) {
  const response = await resolveMarketFetchImpl()(url, {
    credentials: "omit",
    headers,
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function readResponseBytesWithLimit(response: Response, maxBytes: number) {
  const limit = Math.max(1, Math.trunc(maxBytes));
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function extensionForAsset(asset: MarketAsset) {
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
  if (asset.sizeBytes > MAX_MARKET_DOWNLOAD_BYTES) {
    throw new Error(t("market.main.downloadTooLarge", { maxBytes: MAX_MARKET_DOWNLOAD_BYTES }));
  }
  const response = await requestMarket(app, downloadUrl, {}, options, "market asset download");
  const bytes = await readResponseBytesWithLimit(
    response,
    asset.sizeBytes > 0 ? asset.sizeBytes : MAX_MARKET_DOWNLOAD_BYTES
  );
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

export type ParsedSemanticVersion = {
  core: [string, string, string];
  prerelease: string[];
};

export const SEMANTIC_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemanticVersion(value: string): ParsedSemanticVersion | null {
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

export function compareNumericIdentifiers(left: string, right: string) {
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

export function selectAsset(
  item: Pick<MarketCatalogItem, "type" | "sandboxKind"> & {
    assets?: Record<string, MarketAsset>;
  }
) {
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

export function currentDesktopVersion(app: App) {
  try {
    return typeof app.getVersion === "function" ? String(app.getVersion() || "").trim() : "";
  } catch {
    return "";
  }
}

export function assertDesktopVersionCompatible(app: App, item: MarketCatalogItem, platformSpec?: MarketPlatformSpec) {
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
    const catalog = normalizeCatalog(await requestPublicMarketJson(app, catalogUrl, options, label));
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

export function mergeCatalogItems(app: App, catalogItems: MarketCatalogItem[], localItems: MarketItem[]) {
  const records = readInstalledRecords(app);
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
