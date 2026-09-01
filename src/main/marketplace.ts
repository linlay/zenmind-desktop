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
  compareVersions,
  DEFAULT_MARKET_API_BASE_URL,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  configureMarketAccessTokenIssuer,
  getMarketDesktopDeviceHeaders,
  getMarketSettings,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  MarketCatalogItemNotFoundError,
  upsertInstalledRecord,
  normalizeCatalog,
  marketRoute,
  normalizeMarketApiBaseUrl,
  platformCandidates,
  readInstalledRecords,
  removeInstalledRecord,
  resolveMarketFetchImpl,
  saveMarketSettings,
  selectAsset,
  writeMarketSettingsIfAbsent,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./marketplace/common";
import { listCatalogOnlyMarketItems } from "./marketplace/catalog-only-market";
import { installAgentMarketItem, uninstallAgentMarketItem } from "./marketplace/agent-market";
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
  installMcpMarketItem,
  listMcpMarketItems,
  mergeMcpRuntimeStatuses,
  uninstallMcpMarketItem
} from "./marketplace/mcp-market";
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
  installSoftwarePackageMarketItem,
  listSoftwarePackageMarketItems,
  uninstallSoftwarePackageMarketItem
} from "./marketplace/software-package-market";
import {
  installSkillFromCommand as installSkillFromCommandInput
} from "./skill-installer";
import { t } from "./i18n/main-i18n";

export {
  DEFAULT_MARKET_API_BASE_URL,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  configureMarketAccessTokenIssuer,
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
  "mcps",
  "websiteApps",
  "softwarePackages"
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
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
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
  mcpMarket: MarketSectionResult,
  websiteAppMarket: MarketSectionResult,
  softwarePackageMarket: MarketSectionResult
): MarketListResult {
  const message = [...new Set([
    pluginMarket.message,
    skillMarket.message,
    agentMarket.message,
    sandboxImageMarket.message,
    petMarket.message,
    cliMarket.message,
    mcpMarket.message,
    websiteAppMarket.message,
    softwarePackageMarket.message
  ].filter(Boolean))].join(" ");
  return {
    ok: true,
    sourceUrl: softwarePackageMarket.sourceUrl || websiteAppMarket.sourceUrl || mcpMarket.sourceUrl || cliMarket.sourceUrl || petMarket.sourceUrl || sandboxImageMarket.sourceUrl || agentMarket.sourceUrl || skillMarket.sourceUrl || pluginMarket.sourceUrl || DEFAULT_MARKETPLACE_CATALOG_URL,
    offline: pluginMarket.offline || skillMarket.offline || agentMarket.offline || sandboxImageMarket.offline || petMarket.offline || cliMarket.offline || mcpMarket.offline || websiteAppMarket.offline || softwarePackageMarket.offline,
    message,
    items: [
      ...pluginMarket.items,
      ...skillMarket.items,
      ...agentMarket.items,
      ...sandboxImageMarket.items,
      ...petMarket.items,
      ...cliMarket.items,
      ...mcpMarket.items,
      ...websiteAppMarket.items,
      ...softwarePackageMarket.items
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
    mcpMessage: mcpMarket.message,
    mcpOffline: mcpMarket.offline,
    websiteAppMessage: websiteAppMarket.message,
    websiteAppOffline: websiteAppMarket.offline,
    softwarePackageMessage: softwarePackageMarket.message,
    softwarePackageOffline: softwarePackageMarket.offline
  };
}

function shouldLoadMarketSection(options: MarketplaceOptions, section: MarketSection) {
  return !options.sections || options.sections.includes(section);
}

async function loadMarketSections(app: App, options: MarketplaceOptions = {}) {
  const sections = new Set((options.sections ?? MARKET_SECTIONS).filter((section) =>
    MARKET_SECTIONS.includes(section)
  ));
  const [pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, mcpMarket, websiteAppMarket, softwarePackageMarket] = await Promise.all([
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
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "mcps")
      ? listMcpMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "websiteApps")
      ? listWebsiteAppMarketItems(app, options)
      : EMPTY_MARKET_SECTION,
    shouldLoadMarketSection({ ...options, sections: [...sections] }, "softwarePackages")
      ? listSoftwarePackageMarketItems(app, options)
      : EMPTY_MARKET_SECTION
  ]);
  return { pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, mcpMarket, websiteAppMarket, softwarePackageMarket };
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

  const catalog = await loadMarketplaceCatalog(app, options, "market uninstall catalog request");
  const item = catalog.catalog.items.find((entry) => entry.id === itemId);
  if (item) {
    return item.type;
  }
  return "skill";
}

export async function refreshMarketCatalog(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  const { pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, mcpMarket, websiteAppMarket, softwarePackageMarket } = await loadMarketSections(app, options);
  return combineMarketSections(pluginMarket, skillMarket, agentMarket, sandboxImageMarket, petMarket, cliMarket, mcpMarket, websiteAppMarket, softwarePackageMarket);
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
  const catalog = await loadMarketplaceCatalog(app, options, "market install catalog request");
  const item = catalog.catalog.items.find((entry) => entry.id === itemId);
  const installOptions: MarketplaceOptions = {
    ...options,
    catalogSnapshot: catalog.catalog
  };
  switch (item?.type) {
    case "software-package":
      return installSoftwarePackageMarketItem(app, itemId, installOptions);
    case "plugin":
      return installPluginMarketItem(app, itemId, installOptions);
    case "sandbox-image":
      return installSandboxTemplateMarketItem(app, itemId, installOptions);
    case "pet":
      return installPetMarketItem(app, itemId, installOptions);
    case "cli":
      return installCliMarketItem(app, itemId, installOptions);
    case "mcp":
      return installMcpMarketItem(app, itemId, installOptions);
    case "website-app":
      return installWebsiteAppMarketItem(app, itemId, installOptions);
    case "agent":
      return installAgentMarketItem(app, itemId, installOptions);
    case "skill":
      return installSkillMarketItem(app, itemId, installOptions);
    default:
      throw new MarketCatalogItemNotFoundError(itemId);
  }
}

export async function updateMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}) {
  return installMarketItem(app, itemId, options);
}

export async function importSkillFromPath(app: App, sourcePath: string): Promise<MarketCommandResult> {
  return importSkillMarketItemFromPath(app, sourcePath);
}

export async function importSkillFromCommand(app: App, commandText: string): Promise<MarketCommandResult> {
  return installSkillFromCommandInput(app, commandText, {
    onPublished: ({ metadata, installPath }) => upsertInstalledRecord(app, {
      id: metadata.id,
      type: "skill",
      version: metadata.version,
      source: "cloud",
      installPath,
      installedAt: new Date().toISOString()
    })
  });
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
      : type === "agent"
        ? await uninstallAgentMarketItem(app, itemId)
      : type === "website-app"
        ? await uninstallWebsiteAppMarketItem(app, itemId)
        : type === "software-package"
          ? await uninstallSoftwarePackageMarketItem(app, itemId)
        : type === "cli"
          ? await uninstallCliMarketItem(app, itemId, options)
          : type === "mcp"
            ? await uninstallMcpMarketItem(app, itemId)
          : await uninstallSkillMarketItem(app, itemId);
  if (result.ok && type !== "website-app" && type !== "skill" && type !== "mcp") {
    removeInstalledRecord(app, itemId, type);
  }
  return result;
}

export { buildSandboxImage, deleteSandboxImage, exportSandboxImageToPath, importSandboxImageFromPath };
export { mergeMcpRuntimeStatuses };

export const __testInternals = {
  compareVersions,
  normalizeCatalog,
  platformCandidates,
  selectAsset,
  readInstalledRecords
};
