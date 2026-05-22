import type { App } from "electron";
import type { MarketCommandResult, MarketListResult, MarketItemType } from "../shared/contracts";
import {
  DEFAULT_MARKETPLACE_CATALOG_URL,
  DEFAULT_SKILLS_API_BASE_URL,
  getMarketSettings,
  upsertInstalledRecord,
  normalizeCatalog,
  normalizeSkillsApiBaseUrl,
  readInstalledRecords,
  removeInstalledRecord,
  saveMarketSettings,
  selectAsset,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./marketplace/common";
import {
  installPluginMarketItem,
  listPluginMarketItems,
  uninstallPluginMarketItem
} from "./marketplace/plugin-market";
import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  importSandboxImageFromPath,
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

export {
  DEFAULT_MARKETPLACE_CATALOG_URL,
  DEFAULT_SKILLS_API_BASE_URL,
  getMarketSettings,
  saveMarketSettings
};

function combineMarketSections(
  pluginMarket: MarketSectionResult,
  skillMarket: MarketSectionResult,
  sandboxImageMarket: MarketSectionResult
): MarketListResult {
  const message = [pluginMarket.message, skillMarket.message].filter(Boolean).join(" ");
  return {
    ok: true,
    sourceUrl: skillMarket.sourceUrl || pluginMarket.sourceUrl || DEFAULT_MARKETPLACE_CATALOG_URL,
    offline: pluginMarket.offline || skillMarket.offline,
    message,
    items: [
      ...pluginMarket.items,
      ...skillMarket.items,
      ...sandboxImageMarket.items
    ],
    sandboxMessage: sandboxImageMarket.message,
    sandboxOffline: sandboxImageMarket.offline
  };
}

async function loadMarketSections(app: App, options: MarketplaceOptions = {}) {
  const [pluginMarket, skillMarket, sandboxImageMarket] = await Promise.all([
    listPluginMarketItems(app, options),
    listSkillMarketItems(app, options),
    listSandboxImageMarketItems(app, options)
  ]);
  return { pluginMarket, skillMarket, sandboxImageMarket };
}

function isMarketNotFoundError(error: unknown) {
  return error instanceof Error && error.message.startsWith("市场中未找到 ");
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

  const [pluginMarket, skillMarket] = await Promise.all([
    listPluginMarketItems(app, options),
    listSkillMarketItems(app, options)
  ]);
  if (pluginMarket.items.some((item) => item.id === itemId)) {
    return "plugin";
  }
  if (skillMarket.items.some((item) => item.id === itemId)) {
    return "skill";
  }
  return "skill";
}

export async function refreshMarketCatalog(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  const { pluginMarket, skillMarket, sandboxImageMarket } = await loadMarketSections(app, options);
  return combineMarketSections(pluginMarket, skillMarket, sandboxImageMarket);
}

export async function listMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketListResult> {
  return refreshMarketCatalog(app, options);
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
    : await uninstallSkillMarketItem(app, itemId);
  if (result.ok) {
    removeInstalledRecord(app, itemId, type);
  }
  return result;
}

export { buildSandboxImage, deleteSandboxImage, exportSandboxImageToPath, importSandboxImageFromPath };

export const __testInternals = {
  normalizeCatalog,
  normalizeSkillsApiBaseUrl,
  selectAsset,
  readInstalledRecords
};
