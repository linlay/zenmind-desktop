import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { DEFAULT_DESKTOP_PET_APPEARANCE_ID } from "../../shared/desktop-pet";
import { extractArchiveToDir, listArchiveEntries } from "../archive-utils";
import {
  listUserDesktopPetAppearanceOptions,
  listUserDesktopPets,
  readDesktopPetStoredState,
  saveDesktopPetSettings
} from "../copilot/pet-copilot/desktop-pet";
import { t } from "../i18n/main-i18n";
import { getDesktopPetsDataRoot } from "../user-paths";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  selectAsset,
  upsertInstalledRecord,
  removeInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type PetCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

function petOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "pet")
  };
}

async function loadPetCatalog(app: App, options: MarketplaceOptions = {}): Promise<PetCatalogResult> {
  if (options.catalog) {
    return {
      catalog: petOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }

  const result = await loadMarketplaceCatalog(app, options, "pet market catalog request");
  return {
    ...result,
    catalog: petOnlyCatalog(result.catalog)
  };
}

function normalizePetDirectoryName(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().replace(/^user:/u, "") : "";
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function assertSafeArchiveEntries(entries: Set<string>) {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().replace(/\\/gu, "/");
    if (!entry || entry.startsWith("/") || /^[a-z]:/iu.test(entry)) {
      throw new Error(t("market.pet.invalidArchivePath"));
    }
    const parts = entry.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new Error(t("market.pet.invalidArchivePath"));
    }
  }
}

function hasPetBaseAssets(entries: Set<string>) {
  let hasManifest = false;
  let hasIdleImage = false;
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\\/gu, "/").replace(/\/$/u, "");
    if (entry.endsWith("/pet.json") || entry === "pet.json") {
      hasManifest = true;
    }
    if (entry.endsWith("/pet-idle.png") || entry === "pet-idle.png") {
      hasIdleImage = true;
    }
  }
  return hasManifest && hasIdleImage;
}

function findExtractedPetRoot(rootPath: string): string | null {
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.shift() ?? rootPath;
    const manifestPath = path.join(current, "pet.json");
    if (fs.existsSync(manifestPath)) {
      return current;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      }
    }
  }
  return null;
}

function listLocalPets(app: App): MarketItem[] {
  const optionById = new Map(listUserDesktopPetAppearanceOptions(app).map((option) => [option.id, option]));
  return listUserDesktopPets(app).map((pet) => {
    const option = optionById.get(pet.id);
    return {
      id: pet.petId,
      type: "pet" as const,
      name: option?.displayName ?? pet.petId,
      version: readText(pet.manifest.version) || "0.0.0",
      description: option?.description ?? "",
      tags: Array.isArray(pet.manifest.tags)
        ? pet.manifest.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
        : [],
      state: "local-imported" as const,
      source: "local" as const,
      installedVersion: readText(pet.manifest.version) || "0.0.0",
      installPath: pet.rootPath,
      petPreviewAssetPath: option?.previewAssetPath
    };
  });
}

function withPetDisplayFields(items: MarketItem[]): MarketItem[] {
  return items.map((item) => ({
    ...item,
    petPreviewAssetPath: item.petPreviewAssetPath ||
      item.metadata?.previewAssetPath ||
      item.metadata?.previewUrl ||
      item.metadata?.imageUrl
  }));
}

export async function listPetMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const result = await loadPetCatalog(app, options);
  return {
    items: withPetDisplayFields(mergeCatalogItems(app, result.catalog.items, listLocalPets(app))),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installPetMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadPetCatalog(app, options);
  const item = findCatalogItem(catalog, itemId, "pet");
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error(t("market.main.platformUnavailable"));
  }
  const archivePath = await downloadAsset(app, item, selected.asset);
  const tempRoot = path.join(app.getPath("temp") || os.tmpdir(), "zenmind-market-pets", `${item.id}-${Date.now()}`);
  const safePetDirName = normalizePetDirectoryName(item.id);
  if (!safePetDirName) {
    throw new Error(t("market.pet.invalidId"));
  }
  try {
    const entries = listArchiveEntries(archivePath);
    assertSafeArchiveEntries(entries);
    if (!hasPetBaseAssets(entries)) {
      throw new Error(t("market.pet.invalidPackage"));
    }
    await extractArchiveToDir(archivePath, tempRoot);
    const petRoot = findExtractedPetRoot(tempRoot);
    if (!petRoot) {
      throw new Error(t("market.pet.invalidPackage"));
    }
    const manifest = readJsonFile(path.join(petRoot, "pet.json"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(t("market.pet.invalidPackage"));
    }
    const manifestId = readText((manifest as { id?: unknown }).id);
    if (manifestId && normalizePetDirectoryName(manifestId) !== safePetDirName) {
      throw new Error(t("market.pet.idMismatch", { expected: item.id, actual: manifestId }));
    }
    if (!fs.existsSync(path.join(petRoot, "pet-idle.png"))) {
      throw new Error(t("market.pet.invalidPackage"));
    }

    const targetRoot = getDesktopPetsDataRoot(app);
    const installPath = path.join(targetRoot, safePetDirName);
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.rmSync(installPath, { recursive: true, force: true });
    fs.cpSync(petRoot, installPath, { recursive: true });
    saveDesktopPetSettings(app, {
      appearanceId: `user:${safePetDirName}`,
      selectedPetId: `user:${safePetDirName}`
    });
    upsertInstalledRecord(app, {
      id: item.id,
      type: "pet",
      version: item.version,
      source: "cloud",
      assetUrl: selected.asset.url,
      sha256: selected.asset.sha256,
      installPath,
      installedAt: new Date().toISOString()
    });
    return {
      ok: true,
      itemId: item.id,
      type: "pet",
      state: "installed",
      message: t("market.pet.installed", { name: item.name }),
      installPath
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallPetMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const safePetDirName = normalizePetDirectoryName(itemId);
  const installPath = path.join(getDesktopPetsDataRoot(app), safePetDirName);
  fs.rmSync(installPath, { recursive: true, force: true });
  removeInstalledRecord(app, itemId, "pet");

  const settings = readDesktopPetStoredState(app);
  if (settings.appearanceId === `user:${safePetDirName}`) {
    saveDesktopPetSettings(app, {
      appearanceId: DEFAULT_DESKTOP_PET_APPEARANCE_ID,
      selectedPetId: ""
    });
  }
  return {
    ok: true,
    itemId,
    type: "pet",
    state: "not-installed",
    message: t("market.pet.uninstalled", { name: itemId })
  };
}

export const __petMarketInternals = {
  loadPetCatalog,
  normalizePetDirectoryName
};
