import fs from "node:fs";
import type { App } from "electron";
import type { MarketCommandResult } from "../../../shared/contracts";
import {
  installSkillFromPath,
  listInstalledSkills,
  uninstallSkill
} from "./skill-installer";
import { t } from "../../support/i18n/main-i18n";
import {
  downloadAsset,
  asObject,
  asString,
  assertDesktopVersionCompatible,
  compareVersions,
  findCatalogItem,
  getMarketApiBaseUrl,
  getMarketSettings,
  MARKET_AUTH_ME_PATH,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  platformCandidates,
  readInstalledRecords,
  readResponseBytesWithLimit,
  replaceInstalledRecords,
  requestMarket,
  requestMarketJson,
  resolveMarketAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const MAX_SKILL_PACKAGE_BYTES = 512 * 1024 * 1024;

type SkillMarketPlatformCall = (
  targetPath: string,
  options?: { method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string }
) => Promise<unknown>;

type PlatformSkillPackageResponse = {
  id?: string;
  version?: string;
  skills?: Array<{ id?: string; version?: string }>;
};

type PlatformSkillPackage = PlatformSkillPackageResponse & {
  skills?: Array<{ id?: string; version?: string }>;
};

let skillMarketPlatformCall: SkillMarketPlatformCall | null = null;

export function configureSkillMarketPlatformCaller(call: SkillMarketPlatformCall | null) {
  skillMarketPlatformCall = call;
}

async function listPlatformSkillPackages(suppressErrors = true) {
  if (!skillMarketPlatformCall) {
    return [] as PlatformSkillPackage[];
  }
  try {
    const packages = await skillMarketPlatformCall("/api/admin/skill-packages");
    return Array.isArray(packages) ? packages as PlatformSkillPackage[] : [];
  } catch (error) {
    if (!suppressErrors) throw error;
    return [] as PlatformSkillPackage[];
  }
}

function mergePlatformSkillPackageState(items: ReturnType<typeof mergeCatalogItems>, packages: PlatformSkillPackage[]) {
  const ownerBySkill = new Map<string, { packageId: string; version: string }>();
  for (const packageItem of packages) {
    const packageId = asString(packageItem.id).trim();
    if (!packageId) continue;
    for (const skill of packageItem.skills ?? []) {
      const skillId = asString(skill.id).trim();
      const version = asString(skill.version).trim();
      if (skillId && version) {
        ownerBySkill.set(skillId, { packageId, version });
      }
    }
  }
  return items.map((item) => {
    if (item.type !== "skill") return item;
    const owner = ownerBySkill.get(item.id);
    if (!owner) return item;
    return {
      ...item,
      source: "cloud" as const,
      state: compareVersions(item.version, owner.version) > 0 ? "update-available" as const : "installed" as const,
      installedVersion: owner.version,
      skillPackageId: owner.packageId
    };
  });
}

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
  const [result, packages] = await Promise.all([
    loadSkillCatalog(app, options),
    listPlatformSkillPackages()
  ]);
  return {
    items: mergePlatformSkillPackageState(
      mergeCatalogItems(app, result.catalog.items, listInstalledSkills(app)),
      packages
    ),
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
  const catalogItem = findCatalogItem(catalog, itemId, "skill");
  if (catalogItem.skill?.kind === "package") {
    return installSkillPackageMarketItem(app, catalogItem, options);
  }
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
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
      },
      onPublished: ({ installPath }) => upsertInstalledRecord(app, {
        id: item.id,
        type: "skill",
        version: item.version,
        platform: resolved.platform,
        source: "cloud",
        assetUrl: resolved.asset.url,
        sha256: resolved.asset.sha256,
        installPath,
        installedAt: new Date().toISOString()
      })
    });
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function installSkillPackageMarketItem(
  app: App,
  item: ReturnType<typeof findCatalogItem>,
  options: MarketplaceOptions
): Promise<MarketCommandResult> {
  if (!skillMarketPlatformCall) {
    throw new Error(t("market.main.skillPackagePlatformUnavailable"));
  }
  const apiBaseUrl = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!apiBaseUrl) {
    throw new Error(t("market.main.marketApiNotConfigured"));
  }
  await requestMarketJson(app, `${apiBaseUrl}${MARKET_AUTH_ME_PATH}`, options, "skill package authentication request");
  const platform = platformCandidates().find((candidate) => Boolean(item.targets?.[candidate]))
    || "universal";
  const query = new URLSearchParams({ version: item.version, platform });
  const resolved = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}/skills/${encodeURIComponent(item.id)}/resolve?${query.toString()}`,
    options,
    "skill package resolve request"
  ));
  const resolvedItem = asObject(resolved.item);
  if (
    asString(resolvedItem.id).trim() !== item.id ||
    asString(resolvedItem.type).trim() !== "skill" ||
    asString(resolved.version).trim() !== item.version
  ) {
    throw new Error(t("market.main.resolveIdentityMismatch"));
  }
  const resolvedPlatform = asString(resolved.platform).trim() || platform;
  const resolvedPlatformSpec = asObject(resolved.platformSpec);
  assertDesktopVersionCompatible(app, {
    ...item,
    minDesktopVersion: asString(resolvedPlatformSpec.minDesktopVersion).trim() || item.minDesktopVersion
  });
  const response = await requestMarket(
    app,
    `${apiBaseUrl}/skills/${encodeURIComponent(item.id)}/package/download?${new URLSearchParams({ platform: resolvedPlatform }).toString()}`,
    {},
    options,
    "skill package download"
  );
  const bytes = await readResponseBytesWithLimit(response, MAX_SKILL_PACKAGE_BYTES);
  const installed = await skillMarketPlatformCall(
    `/api/admin/skill-packages/import?${new URLSearchParams({ key: item.id, version: item.version }).toString()}`,
    { method: "POST", rawBody: bytes, contentType: "application/zip" }
  ) as PlatformSkillPackageResponse;
  if (installed.id?.trim() !== item.id || installed.version?.trim() !== item.version) {
    throw new Error(t("market.main.resolveIdentityMismatch"));
  }
  upsertInstalledRecord(app, {
    id: item.id,
    type: "skill",
    version: item.version,
    platform: resolvedPlatform,
    source: "cloud",
    skillPackage: true,
    installedAt: new Date().toISOString()
  });
  return {
    ok: true,
    itemId: item.id,
    type: "skill",
    state: "installed",
    message: t("skillInstaller.packageInstalled", { count: installed.skills?.length ?? 0 })
  };
}

export async function importSkillMarketItemFromPath(app: App, sourcePath: string): Promise<MarketCommandResult> {
  return installSkillFromPath(app, sourcePath, {
    source: "local",
    onPublished: ({ metadata, installPath }) => upsertInstalledRecord(app, {
      id: metadata.id,
      type: "skill",
      version: metadata.version,
      source: "local",
      installPath,
      installedAt: new Date().toISOString()
    })
  });
}

export async function uninstallSkillMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const records = readInstalledRecords(app);
  const packageRecord = records.find((record) => record.type === "skill" && record.id === itemId);
  if (packageRecord?.skillPackage) {
    if (!skillMarketPlatformCall) {
      throw new Error(t("market.main.skillPackagePlatformUnavailable"));
    }
    const deleted = await skillMarketPlatformCall("/api/admin/skill-packages/delete", {
      method: "POST",
      body: { key: itemId }
    }) as { deleted?: boolean; skills?: Array<{ id?: string }> };
    if (deleted.deleted !== true) {
      throw new Error(t("market.main.skillPackageRemovalUnconfirmed"));
    }
    replaceInstalledRecords(
      app,
      records.filter((record) => !(record.type === "skill" && record.id === itemId))
    );
    return {
      ok: true,
      itemId,
      type: "skill",
      state: "not-installed",
      message: t("skillInstaller.packageUninstalled", { count: deleted.skills?.length ?? 0 })
    };
  }
  const owningPackage = (await listPlatformSkillPackages(false)).find((packageItem) => (
    (packageItem.skills ?? []).some((skill) => asString(skill.id).trim() === itemId)
  ));
  const owningPackageID = asString(owningPackage?.id).trim();
  if (owningPackageID) {
    const deleted = await skillMarketPlatformCall?.("/api/admin/skill-packages/skills/delete", {
      method: "POST",
      body: { packageId: owningPackageID, skillId: itemId }
    }) as { deleted?: boolean; packageDeleted?: boolean } | undefined;
    if (deleted?.deleted !== true) {
      throw new Error(t("market.main.skillPackageRemovalUnconfirmed"));
    }
    if (deleted.packageDeleted) {
      replaceInstalledRecords(
        app,
        records.filter((record) => !(record.type === "skill" && record.id === owningPackageID))
      );
    }
    return {
      ok: true,
      itemId,
      type: "skill",
      state: "not-installed",
      message: t("skillInstaller.uninstalled", { id: itemId })
    };
  }
  return uninstallSkill(app, itemId, {
    onRemoved: () => replaceInstalledRecords(
      app,
      records.filter((record) => !(record.type === "skill" && record.id === itemId))
    )
  });
}

export const __skillMarketInternals = {
  loadSkillCatalog,
  mergePlatformSkillPackageState
};
