import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  MarketCommandResult,
  MarketFavoriteInput,
  MarketFavoriteResult,
  MarketItemType,
  MarketListResult,
  MarketSection
} from "../shared/contracts";
import {
  asObject,
  DEFAULT_MARKET_API_BASE_URL,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  getMarketDesktopDeviceHeaders,
  getMarketSettings,
  mergeCatalogItems,
  MarketCatalogItemNotFoundError,
  upsertInstalledRecord,
  normalizeCatalog,
  normalizeMarketApiBaseUrl,
  readInstalledRecords,
  removeInstalledRecord,
  saveMarketSettings,
  selectAsset,
  writeMarketSettingsIfAbsent,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./marketplace/common";
import { listCatalogOnlyMarketItems } from "./marketplace/catalog-only-market";
import {
  installCliMarketItem,
  listCliMarketItems,
  uninstallCliMarketItem
} from "./marketplace/cli-market";
import {
  installPetMarketItem,
  listPetMarketItems,
  uninstallPetMarketItem
} from "./marketplace/pet-market";
import {
  installPluginMarketItem,
  listPluginMarketItems,
  uninstallPluginMarketItem
} from "./marketplace/plugin-market";
import {
  installWebsiteAppMarketItem,
  listWebsiteAppMarketItems,
  uninstallWebsiteAppMarketItem
} from "./marketplace/website-app-market";
import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  importSandboxImageFromPath,
  installSandboxTemplateMarketItem,
  listSandboxImageMarketItems
} from "./marketplace/sandbox-image-market";
import {
  importSkillMarketItemFromPath,
  installSkillMarketItem,
  listSkillMarketItems,
  uninstallSkillMarketItem
} from "./marketplace/skill-market";
import {
  getSkillInstallDir,
  installSkillFromCommand as installSkillFromCommandInput,
  listInstalledSkills
} from "./skill-installer";
import { t } from "./i18n/main-i18n";

export {
  DEFAULT_MARKET_API_BASE_URL,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  getMarketSettings,
  saveMarketSettings,
  writeMarketSettingsIfAbsent
};

const EMPTY_MARKET_SECTION: MarketSectionResult = {
  items: [],
  offline: false,
  message: ""
};

const MARKET_SECTIONS: readonly MarketSection[] = [
  "plugins",
  "skills",
  "agents",
  "sandboxImages",
  "pets",
  "cli",
  "websiteApps"
];

type IssueMarketAccessToken = (
  app: App,
  reason: AgentAuthRefreshReason
) => Promise<AgentAuthIssueResult> | AgentAuthIssueResult;

type MarketFavoriteOptions = MarketplaceOptions & {
  fetchImpl?: typeof fetch;
  issueAgentAccessToken?: IssueMarketAccessToken;
};

class MarketApiRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function marketRoute(type: MarketItemType) {
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
    case "website-app":
      return "webapps";
    default:
      return "skills";
  }
}

function getMarketApiBaseUrlForAction(app: App, options: MarketplaceOptions = {}) {
  if (options.apiBaseUrl !== undefined) {
    return options.marketEnabled === false ? "" : normalizeMarketApiBaseUrl(options.apiBaseUrl);
  }
  const settings = getMarketSettings(app);
  return settings.enabled === true ? settings.apiBaseUrl : "";
}

async function readMarketApiResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.trim() };
  }
}

function marketApiErrorMessage(status: number, data: unknown) {
  const raw = asObject(data);
  const error = asObject(raw.error);
  return String(error.message || raw.message || `HTTP ${status}`);
}

async function issueFavoriteAccessToken(
  app: App,
  reason: AgentAuthRefreshReason,
  options: MarketFavoriteOptions
) {
  if (!options.issueAgentAccessToken) {
    return "";
  }
  const result = await options.issueAgentAccessToken(app, reason);
  if (!result.ok || !result.token.trim()) {
    throw new Error(result.message || t("market.main.favoriteAuthRequired"));
  }
  return result.token.trim();
}

async function requestFavoriteUpdate(
  app: App,
  url: string,
  method: "POST" | "DELETE",
  options: MarketFavoriteOptions
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let token = await issueFavoriteAccessToken(app, "missing", options);
  for (const reason of ["missing", "unauthorized"] as const) {
    if (reason === "unauthorized") {
      token = await issueFavoriteAccessToken(app, "unauthorized", options);
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...getMarketDesktopDeviceHeaders(app),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const data = await readMarketApiResponse(response);
    if (response.ok) {
      return data;
    }
    if (response.status !== 401 || reason === "unauthorized" || !options.issueAgentAccessToken) {
      throw new MarketApiRequestError(response.status, marketApiErrorMessage(response.status, data));
    }
  }
  throw new Error(t("market.main.favoriteAuthRequired"));
}

function combineMarketSections(
  pluginMarket: MarketSectionResult,
  skillMarket: MarketSectionResult,
  agentMarket: MarketSectionResult,
  sandboxImageMarket: MarketSectionResult,
  petMarket: MarketSectionResult,
  cliMarket: MarketSectionResult,
  websiteAppMarket: MarketSectionResult
): MarketListResult {
  const message = [...new Set([
    pluginMarket.message,
    skillMarket.message,
    agentMarket.message,
    sandboxImageMarket.message,
    petMarket.message,
    cliMarket.message,
    websiteAppMarket.message
  ].filter(Boolean))].join(" ");
  return {
    ok: true,
    sourceUrl: websiteAppMarket.sourceUrl || cliMarket.sourceUrl || petMarket.sourceUrl || sandboxImageMarket.sourceUrl || agentMarket.sourceUrl || skillMarket.sourceUrl || pluginMarket.sourceUrl || DEFAULT_MARKETPLACE_CATALOG_URL,
    offline: pluginMarket.offline || skillMarket.offline || agentMarket.offline || sandboxImageMarket.offline || petMarket.offline || cliMarket.offline || websiteAppMarket.offline,
    message,
    items: [
      ...pluginMarket.items,
      ...skillMarket.items,
      ...agentMarket.items,
      ...sandboxImageMarket.items,
      ...petMarket.items,
      ...cliMarket.items,
      ...websiteAppMarket.items
    ],
    pluginMessage: pluginMarket.message,
    pluginOffline: pluginMarket.offline,
    skillMessage: skillMarket.message,
    skillOffline: skillMarket.offline,
    agentMessage: agentMarket.message,
    agentOffline: agentMarket.offline,
    sandboxMessage: sandboxImageMarket.message,
    sandboxOffline: sandboxImageMarket.offline,
    petMessage: petMarket.message,
    petOffline: petMarket.offline,
    cliMessage: cliMarket.message,
    cliOffline: cliMarket.offline,
    websiteAppMessage: websiteAppMarket.message,
    websiteAppOffline: websiteAppMarket.offline
  };
}

function shouldLoadMarketSection(options: MarketplaceOptions, section: MarketSection) {
  return !options.sections || options.sections.includes(section);
}

async function loadMarketSections(app: App, options: MarketplaceOptions = {}) {
  const sections = new Set((options.sections ?? MARKET_SECTIONS).filter((section) =>
    MARKET_SECTIONS.includes(section)
  ));
  const [pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, websiteAppMarket] = await Promise.all([
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "plugins")
      ? listPluginMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "skills")
      ? listSkillMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "agents")
      ? listCatalogOnlyMarketItems(app, "agent", options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "sandboxImages")
      ? listSandboxImageMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "pets")
      ? listPetMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "cli")
      ? listCliMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "websiteApps")
      ? listWebsiteAppMarketItems(app, options)
      : EMPTY_MARKET_SECTION
  ]);
  return { pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, websiteAppMarket };
}

function isMarketNotFoundError(error: unknown) {
  if (error instanceof MarketCatalogItemNotFoundError) {
    return true;
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "market_catalog_item_not_found") {
    return true;
  }
  return error instanceof Error && (
    error.message.startsWith("Market item not found:") ||
    /market item not found/iu.test(error.message)
  );
}

async function resolveInstalledItemType(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketItemType> {
  const records = readInstalledRecords(app);
  const record = records.find((entry) => entry.id === itemId);
  if (record) {
    return record.type;
  }

  const [pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, websiteAppMarket] = await Promise.all([
    listPluginMarketItems(app, options),
    listSkillMarketItems(app, options),
    listCatalogOnlyMarketItems(app, "agent", options),
    listSandboxImageMarketItems(app, options),
    listPetMarketItems(app, options),
    listCliMarketItems(app, options),
    listWebsiteAppMarketItems(app, options)
  ]);
  if (pluginMarket.items.some((item) => item.id === itemId)) {
    return "plugin";
  }
  if (skillMarket.items.some((item) => item.id === itemId)) {
    return "skill";
  }
  if (agentMarket.items.some((item) => item.id === itemId)) {
    return "agent";
  }
  if (sandboxImageMarket.items.some((item) => item.id === itemId)) {
    return "sandbox-image";
  }
  if (petMarket.items.some((item) => item.id === itemId)) {
    return "pet";
  }
  if (cliMarket.items.some((item) => item.id === itemId)) {
    return "cli";
  }
  if (websiteAppMarket.items.some((item) => item.id === itemId)) {
    return "website-app";
  }
  return "skill";
}

export async function refreshMarketCatalog(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  const { pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, websiteAppMarket } = await loadMarketSections(app, options);
  return combineMarketSections(pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, websiteAppMarket);
}

export async function listMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  return refreshMarketCatalog(app, options);
}

export async function toggleMarketFavorite(
  app: App,
  input: MarketFavoriteInput,
  options: MarketFavoriteOptions = {}
): Promise<MarketFavoriteResult> {
  const apiBaseUrl = getMarketApiBaseUrlForAction(app, options).replace(/\/+$/u, "");
  if (!apiBaseUrl) {
    throw new Error(t("market.main.marketApiNotConfigured"));
  }
  const itemId = String(input.itemId || "").trim();
  if (!itemId) {
    throw new Error(t("market.main.catalogItemNotFound", { itemId }));
  }
  const route = marketRoute(input.type);
  const method = input.favorited ? "DELETE" : "POST";
  const payload = await requestFavoriteUpdate(
    app,
    `${apiBaseUrl}/${route}/${encodeURIComponent(itemId)}/favorite`,
    method,
    options
  );
  const rawPayload = asObject(payload);
  const itemPayload = rawPayload.item ?? rawPayload.data ?? payload;
  const catalogItem = normalizeCatalog({
    schemaVersion: 1,
    items: [itemPayload]
  }).items[0];
  if (!catalogItem) {
    throw new Error(t("market.main.favoriteInvalidResponse"));
  }
  const [item] = mergeCatalogItems(app, [catalogItem], []);
  return {
    ok: true,
    item,
    message: item.favorited
      ? t("market.main.favoriteAdded", { name: item.name })
      : t("market.main.favoriteRemoved", { name: item.name })
  };
}

export async function installMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  try {
    return await installPluginMarketItem(app, itemId, options);
  } catch (error) {
    if (!isMarketNotFoundError(error)) {
      throw error;
    }
  }
  try {
    return await installSandboxTemplateMarketItem(app, itemId, options);
  } catch (error) {
    if (!isMarketNotFoundError(error)) {
      throw error;
    }
  }
  try {
    return await installPetMarketItem(app, itemId, options);
  } catch (error) {
    if (!isMarketNotFoundError(error)) {
      throw error;
    }
  }
  try {
    return await installCliMarketItem(app, itemId, options);
  } catch (error) {
    if (!isMarketNotFoundError(error)) {
      throw error;
    }
  }
  try {
    return await installWebsiteAppMarketItem(app, itemId, options);
  } catch (error) {
    if (!isMarketNotFoundError(error)) {
      throw error;
    }
  }
  return installSkillMarketItem(app, itemId, options);
}

export async function updateMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}) {
  return installMarketItem(app, itemId, options);
}

export async function importSkillFromPath(app: App, sourcePath: string): Promise<MarketCommandResult> {
  return importSkillMarketItemFromPath(app, sourcePath);
}

export async function importSkillFromCommand(app: App, commandText: string): Promise<MarketCommandResult> {
  const result = await installSkillFromCommandInput(app, commandText);
  if (result.ok) {
    const installed = listInstalledSkills(app).find((item) => item.id === result.itemId);
    upsertInstalledRecord(app, {
      id: result.itemId,
      type: "skill",
      version: installed?.version ?? "0.0.0",
      source: "cloud",
      installPath: result.installPath ?? getSkillInstallDir(app, result.itemId),
      installedAt: new Date().toISOString()
    });
  }
  return result;
}

export async function uninstallMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const type = await resolveInstalledItemType(app, itemId, options);
  const result = type === "plugin"
    ? await uninstallPluginMarketItem(app, itemId)
    : type === "pet"
      ? await uninstallPetMarketItem(app, itemId)
      : type === "website-app"
        ? await uninstallWebsiteAppMarketItem(app, itemId)
        : type === "cli"
          ? await uninstallCliMarketItem(app, itemId, options)
          : await uninstallSkillMarketItem(app, itemId);
  if (result.ok) {
    removeInstalledRecord(app, itemId, type);
  }
  return result;
}

export { buildSandboxImage, deleteSandboxImage, exportSandboxImageToPath, importSandboxImageFromPath };

export const __testInternals = {
  normalizeCatalog,
  selectAsset,
  readInstalledRecords
};
