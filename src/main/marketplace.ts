import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type {
  MarketAsset,
  MarketCatalogItem,
  MarketCommandResult,
  MarketInstallState,
  MarketItem,
  MarketItemType,
  MarketListResult,
  MarketSettings,
  MarketSettingsInput
} from "../shared/contracts";
import { ContainerHubClient, type ContainerHubConfig, type ContainerHubEnvironment } from "./copilot/core/container-hub";
import { readManifestFromArchive } from "./manifest-utils";
import {
  getMarketplaceCacheRoot,
  getMarketplaceConfigRoot,
  getMarketplaceStateRoot
} from "./user-paths";
import { getAllServices } from "./services/service-registry";
import { getServiceState } from "./services/manager";
import { getPluginInstallDir, installPluginFromArchive, uninstallPlugin } from "./plugin-loader";
import { readEnvFile } from "./env-file";
import {
  getSkillInstallDir,
  installSkillFromPath,
  listInstalledSkills,
  uninstallSkill
} from "./skill-installer";

export const DEFAULT_MARKETPLACE_CATALOG_URL = "http://47.100.131.144:9001/marketplace/index.json";
export const DEFAULT_SKILLS_API_BASE_URL = "http://127.0.0.1:8080";
const CONTAINER_HUB_SERVICE_ID = "agent-container-hub";
const SKILLS_API_PAGE_LIMIT = 100;

type Catalog = {
  schemaVersion: number;
  generatedAt?: string;
  items: MarketCatalogItem[];
};

type InstalledRecord = {
  id: string;
  type: MarketItemType;
  version: string;
  source: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  installPath: string;
  installedAt: string;
};

type MarketplaceOptions = {
  catalogUrl?: string;
  catalog?: Catalog;
  skillsApiBaseUrl?: string;
  containerHubBaseUrl?: string;
  containerHubAuthToken?: string;
};

type SkillsApiPage = {
  items: unknown[];
  page: number;
  limit: number;
  total: number;
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

function catalogCachePath(app: App) {
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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isMarketItemType(value: unknown): value is MarketItemType {
  return value === "plugin" || value === "skill" || value === "sandbox-image";
}

function normalizeAsset(value: unknown): MarketAsset | null {
  const raw = asObject(value);
  const url = asString(raw.url).trim();
  if (!url) {
    return null;
  }
  const archiveType = asString(raw.archiveType);
  if (archiveType !== "tar.gz" && archiveType !== "zip" && archiveType !== "skill" && archiveType !== "md") {
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

function normalizeCatalog(input: unknown): Catalog {
  const raw = asObject(input);
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  const items: MarketCatalogItem[] = [];
  for (const itemRaw of itemsRaw) {
    const item = asObject(itemRaw);
    const id = asString(item.id).trim();
    const type = item.type;
    if (!id || !isMarketItemType(type)) {
      continue;
    }
    const assets: Record<string, MarketAsset> = {};
    for (const [key, assetRaw] of Object.entries(asObject(item.assets))) {
      const asset = normalizeAsset(assetRaw);
      if (asset) {
        assets[key] = asset;
      }
    }
    items.push({
      id,
      type,
      name: asString(item.name).trim() || id,
      version: asString(item.version).trim() || "0.0.0",
      description: asString(item.description),
      tags: asStringArray(item.tags),
      minDesktopVersion: asString(item.minDesktopVersion).trim() || undefined,
      assets
    });
  }
  return {
    schemaVersion: asNumber(raw.schemaVersion) || 1,
    generatedAt: asString(raw.generatedAt).trim() || undefined,
    items
  };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeSkillsApiBaseUrl(value: unknown) {
  const input = asString(value).trim() || DEFAULT_SKILLS_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("技能市场地址必须是有效的 http 或 https URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("技能市场地址仅支持 http 或 https。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("技能市场地址不应包含查询参数或锚点。");
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (pathname === "/") {
    return parsed.origin;
  }
  if (pathname === "/api/v1") {
    return `${parsed.origin}/api/v1`;
  }
  throw new Error("技能市场地址请输入服务根地址，或以 /api/v1 结尾。");
}

function normalizeContainerHubBaseUrl(value: unknown) {
  const input = asString(value).trim().replace(/\/+$/u, "");
  if (!input) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Container Hub 地址必须是有效的 http 或 https URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Container Hub 地址仅支持 http 或 https。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Container Hub 地址不应包含查询参数或锚点。");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

export function getMarketSettings(app: App): MarketSettings {
  const saved = readJsonFile<Partial<MarketSettings>>(marketplaceSettingsPath(app), {});
  try {
    return {
      skillsApiBaseUrl: normalizeSkillsApiBaseUrl(saved.skillsApiBaseUrl)
    };
  } catch {
    return { skillsApiBaseUrl: DEFAULT_SKILLS_API_BASE_URL };
  }
}

export function saveMarketSettings(app: App, input: MarketSettingsInput): MarketSettings {
  const settings = {
    skillsApiBaseUrl: normalizeSkillsApiBaseUrl(input.skillsApiBaseUrl)
  };
  writeJsonFile(marketplaceSettingsPath(app), settings);
  return settings;
}

function readInstalledRecords(app: App) {
  const parsed = readJsonFile<{ records?: InstalledRecord[] } | InstalledRecord[]>(installedRecordsPath(app), []);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
  return records.filter((record) => record && typeof record.id === "string" && isMarketItemType(record.type));
}

function writeInstalledRecords(app: App, records: InstalledRecord[]) {
  writeJsonFile(installedRecordsPath(app), { records });
}

function upsertInstalledRecord(app: App, record: InstalledRecord) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === record.id && item.type === record.type));
  records.push(record);
  writeInstalledRecords(app, records);
}

function removeInstalledRecord(app: App, itemId: string, type?: MarketItemType) {
  const records = readInstalledRecords(app).filter((item) => !(item.id === itemId && (!type || item.type === type)));
  writeInstalledRecords(app, records);
}

async function fetchJson(url: string, label = "market request") {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function loadCatalog(app: App, options: MarketplaceOptions = {}) {
  if (options.catalog) {
    return { catalog: normalizeCatalog(options.catalog), offline: false, message: "已加载指定市场清单。" };
  }
  const catalogUrl = options.catalogUrl ?? DEFAULT_MARKETPLACE_CATALOG_URL;
  try {
    const catalog = normalizeCatalog(await fetchJson(catalogUrl, "market catalog request"));
    writeJsonFile(catalogCachePath(app), catalog);
    return { catalog, offline: false, message: "市场已刷新。" };
  } catch (error) {
    const cached = readJsonFile<Catalog | null>(catalogCachePath(app), null);
    if (cached) {
      return {
        catalog: normalizeCatalog(cached),
        offline: true,
        message: `当前使用缓存市场：${error instanceof Error ? error.message : String(error)}`
      };
    }
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: `市场暂不可用：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

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

async function loadSkillsCatalog(app: App, options: MarketplaceOptions = {}) {
  const baseUrl = options.skillsApiBaseUrl
    ? normalizeSkillsApiBaseUrl(options.skillsApiBaseUrl)
    : getMarketSettings(app).skillsApiBaseUrl;
  try {
    const items = (await fetchAllSkillsApiItems(baseUrl))
      .map((item) => skillsApiItemToCatalogItem(baseUrl, item))
      .filter((item): item is MarketCatalogItem => Boolean(item));
    return {
      catalog: { schemaVersion: 1, items },
      offline: false,
      message: "技能市场已刷新。",
      sourceUrl: baseUrl
    };
  } catch (error) {
    return {
      catalog: { schemaVersion: 1, items: [] },
      offline: true,
      message: `技能市场暂不可用：${error instanceof Error ? error.message : String(error)}`,
      sourceUrl: baseUrl
    };
  }
}

async function resolveContainerHubConfig(app: App, options: MarketplaceOptions = {}): Promise<ContainerHubConfig | null> {
  if (options.containerHubBaseUrl !== undefined) {
    return {
      baseURL: normalizeContainerHubBaseUrl(options.containerHubBaseUrl),
      authToken: asString(options.containerHubAuthToken).trim() || undefined
    };
  }

  try {
    const state = await getServiceState(app, CONTAINER_HUB_SERVICE_ID);
    if (state.status !== "running" || !state.healthMeta.webUrl) {
      return null;
    }
    const env = readEnvFile(path.join(state.installDir, ".env"));
    return {
      baseURL: normalizeContainerHubBaseUrl(state.healthMeta.webUrl),
      authToken: env.get("AUTH_TOKEN")?.trim() || undefined
    };
  } catch {
    return null;
  }
}

function sandboxBuildState(environment: ContainerHubEnvironment): MarketInstallState {
  if (environment.lastBuild?.status === "building" || environment.lastBuild?.status === "smoke_checking") {
    return "installing";
  }
  if (environment.lastBuild?.status === "failed") {
    return "failed";
  }
  return environment.available ? "installed" : "not-installed";
}

function sandboxEnvironmentToMarketItem(environment: ContainerHubEnvironment): MarketItem {
  const state = sandboxBuildState(environment);
  const imageRef = environment.imageRef || [environment.imageRepository, environment.imageTag].filter(Boolean).join(":");
  const tags = [
    environment.enabled ? "已启用" : "已停用",
    environment.availableBuildTargets.length > 0 ? `${environment.availableBuildTargets.length} 个构建目标` : null,
    environment.lastBuild?.target ? `目标 ${environment.lastBuild.target}` : null
  ].filter((tag): tag is string => Boolean(tag));

  return {
    id: environment.name,
    type: "sandbox-image",
    name: environment.name,
    version: environment.imageTag || "latest",
    description: environment.description,
    tags,
    state,
    source: "local",
    installedVersion: environment.available ? environment.imageTag || "latest" : undefined,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    environmentName: environment.name,
    imageRef,
    buildStatus: environment.lastBuild?.status,
    buildJobId: environment.lastBuild?.id,
    buildTargetCount: environment.availableBuildTargets.length,
    message: state === "failed"
      ? environment.lastBuild?.status || "构建失败"
      : state === "installing" ? "镜像构建中" : undefined
  };
}

async function loadSandboxImageItems(app: App, options: MarketplaceOptions = {}) {
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    return {
      items: [] as MarketItem[],
      offline: true,
      message: "沙箱镜像市场需要先启动 Container Hub。"
    };
  }

  try {
    const client = new ContainerHubClient(config);
    const environments = await client.listEnvironments();
    return {
      items: environments.map(sandboxEnvironmentToMarketItem),
      offline: false,
      message: ""
    };
  } catch (error) {
    return {
      items: [] as MarketItem[],
      offline: true,
      message: `沙箱镜像市场暂不可用：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function loadMarketplaceCatalog(app: App, options: MarketplaceOptions = {}) {
  const catalogUrl = options.catalogUrl ?? DEFAULT_MARKETPLACE_CATALOG_URL;
  const pluginResult = await loadCatalog(app, options);
  const skillsResult = await loadSkillsCatalog(app, options);
  const sandboxResult = await loadSandboxImageItems(app, options);
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    items: [
      ...pluginResult.catalog.items.filter((item) => item.type === "plugin"),
      ...skillsResult.catalog.items
    ]
  };
  const messages = [pluginResult.message, skillsResult.message].filter(Boolean);
  return {
    catalog,
    sandboxItems: sandboxResult.items,
    offline: pluginResult.offline || skillsResult.offline,
    message: messages.join(" "),
    sourceUrl: skillsResult.sourceUrl || catalogUrl,
    sandboxOffline: sandboxResult.offline,
    sandboxMessage: sandboxResult.message
  };
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

function selectAsset(item: MarketCatalogItem) {
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
    message: state === "incompatible" ? "当前平台暂无可安装资源。" : undefined
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

export async function refreshMarketCatalog(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  const { catalog, sandboxItems, offline, message, sourceUrl, sandboxMessage, sandboxOffline } =
    await loadMarketplaceCatalog(app, options);
  return {
    ok: true,
    sourceUrl,
    offline,
    message,
    items: [...mergeMarketItems(app, catalog), ...sandboxItems],
    sandboxMessage,
    sandboxOffline
  };
}

function mergeMarketItems(app: App, catalog: Catalog) {
  const records = readInstalledRecords(app);
  const localItems = [...listLocalPlugins(app), ...listInstalledSkills(app)];
  const localByKey = new Map(localItems.map((item) => [`${item.type}:${item.id}`, item]));
  const result = catalog.items.map((item) => {
    const key = `${item.type}:${item.id}`;
    const record = records.find((entry) => entry.id === item.id && entry.type === item.type);
    return catalogItemToMarketItem(item, record, localByKey.get(key));
  });
  const catalogKeys = new Set(catalog.items.map((item) => `${item.type}:${item.id}`));
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

export async function listMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  return refreshMarketCatalog(app, options);
}

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function extensionForAsset(asset: MarketAsset) {
  if (asset.archiveType === "zip") return ".zip";
  if (asset.archiveType === "md") return ".md";
  if (asset.archiveType === "skill") return ".skill";
  return ".tar.gz";
}

async function downloadAsset(app: App, item: MarketCatalogItem, asset: MarketAsset) {
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (asset.sizeBytes > 0 && bytes.length !== asset.sizeBytes) {
    throw new Error(`下载大小不匹配：期望 ${asset.sizeBytes}，实际 ${bytes.length}`);
  }
  const downloadPath = path.join(downloadsRoot(app), `${item.id}-${Date.now()}${extensionForAsset(asset)}`);
  fs.writeFileSync(downloadPath, bytes);
  if (asset.sha256 && sha256(downloadPath) !== asset.sha256) {
    fs.rmSync(downloadPath, { force: true });
    throw new Error("下载包 sha256 校验失败");
  }
  return downloadPath;
}

function findCatalogItem(catalog: Catalog, itemId: string) {
  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error(`市场中未找到 ${itemId}`);
  }
  return item;
}

export async function installMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  const { catalog } = await loadMarketplaceCatalog(app, options);
  const item = findCatalogItem(catalog, itemId);
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error("当前平台暂无可安装资源。");
  }
  const archivePath = await downloadAsset(app, item, selected.asset);
  try {
    if (item.type === "skill") {
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
    }

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

export async function updateMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}) {
  return installMarketItem(app, itemId, options);
}

export async function buildSandboxImage(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  const environmentName = itemId.trim();
  if (!environmentName) {
    throw new Error("缺少沙箱环境名称。");
  }
  const config = await resolveContainerHubConfig(app, options);
  if (!config?.baseURL) {
    throw new Error("沙箱镜像构建需要先启动 Container Hub。");
  }
  const client = new ContainerHubClient(config);
  const job = await client.startBuildJob(environmentName);
  return {
    ok: true,
    itemId: environmentName,
    type: "sandbox-image",
    state: "installing",
    message: job.id ? `已开始构建 ${environmentName}。` : `已提交 ${environmentName} 构建。`,
    serviceId: CONTAINER_HUB_SERVICE_ID,
    environmentName,
    imageRef: job.imageRef,
    buildJobId: job.id,
    buildStatus: job.status,
    buildTarget: job.target
  };
}

export async function importSkillFromPath(app: App, sourcePath: string): Promise<MarketCommandResult> {
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

export async function uninstallMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  const records = readInstalledRecords(app);
  const record = records.find((entry) => entry.id === itemId);
  const { catalog } = await loadMarketplaceCatalog(app, options);
  const catalogItem = catalog.items.find((entry) => entry.id === itemId);
  const type = record?.type ?? catalogItem?.type ?? "skill";
  let result: MarketCommandResult;
  if (type === "plugin") {
    const pluginResult = await uninstallPlugin(app, itemId);
    result = {
      ok: pluginResult.ok,
      itemId,
      type: "plugin",
      state: pluginResult.ok ? "not-installed" : "failed",
      message: pluginResult.message,
      serviceId: itemId
    };
  } else {
    result = await uninstallSkill(app, itemId);
  }
  if (result.ok) {
    removeInstalledRecord(app, itemId, type);
  }
  return result;
}

export const __testInternals = {
  normalizeCatalog,
  normalizeSkillsApiBaseUrl,
  selectAsset,
  readInstalledRecords
};
