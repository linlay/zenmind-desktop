import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DESKTOP_PET_REQUIRED_STATE_KEYS,
  DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES,
  DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES
} from "../../../shared/desktop-pet";
import { extractArchiveToDir, listArchiveEntriesAsync } from "../../support/archive/archive-utils";
import {
  listUserDesktopPetAppearanceOptions,
  listUserDesktopPets,
  readDesktopPetStoredState,
  saveDesktopPetSettings
} from "../pet";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopPetsDataRoot } from "../../infrastructure/filesystem/user-paths";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  resolveMarketAsset,
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

function sanitizePetAssetRelativePath(value: unknown) {
  const normalized = typeof value === "string"
    ? value.trim().replace(/\\/gu, "/").replace(/^\/+/u, "")
    : "";
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || part.startsWith("."))) {
    return "";
  }
  return parts.join("/");
}

function isForbiddenPetAssetPath(relativePath: string) {
  const safeRelative = sanitizePetAssetRelativePath(relativePath);
  const parts = safeRelative.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  return fileName.startsWith("pet-") ||
    fileName === "task-run-left.webp" ||
    (fileName === "dance.webp" && parent !== "signature");
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
    const fileName = parts.at(-1) ?? "";
    const parent = parts.at(-2) ?? "";
    if (
      fileName.startsWith("pet-") ||
      fileName === "task-run-left.webp" ||
      (fileName === "dance.webp" && parent !== "signature")
    ) {
      throw new Error(t("market.pet.invalidPackage"));
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
    if (entry.endsWith("/idle.webp") || entry === "idle.webp") {
      hasIdleImage = true;
    }
  }
  return hasManifest && hasIdleImage;
}

function assertPetAssetExists(petRoot: string, relativePath: unknown) {
  const safeRelative = sanitizePetAssetRelativePath(relativePath);
  if (!safeRelative || isForbiddenPetAssetPath(safeRelative) || !fs.existsSync(path.join(petRoot, safeRelative))) {
    throw new Error(t("market.pet.invalidPackage"));
  }
}

function assertPetSignatureActions(petRoot: string, value: unknown, optional = false) {
  if (value === undefined && optional) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  for (const rawAction of value) {
    if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
      throw new Error(t("market.pet.invalidPackage"));
    }
    const action = rawAction as Record<string, unknown>;
    const id = readText(action.id);
    const label = readText(action.label);
    const triggers = Array.isArray(action.trigger) ? action.trigger : [];
    const variants = Array.isArray(action.variants) ? action.variants : null;
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) ||
      !label ||
      !triggers.every((trigger) => trigger === "manual" || trigger === "idle-random") ||
      !variants
    ) {
      throw new Error(t("market.pet.invalidPackage"));
    }
    for (const rawVariant of variants) {
      if (!rawVariant || typeof rawVariant !== "object" || Array.isArray(rawVariant)) {
        throw new Error(t("market.pet.invalidPackage"));
      }
      const variant = rawVariant as Record<string, unknown>;
      const frameCount = Math.max(1, Math.round(Number(variant.frameCount) || 0));
      const durationMs = Math.max(0, Math.round(Number(variant.durationMs) || 0));
      if (frameCount < 1 || durationMs <= 0) {
        throw new Error(t("market.pet.invalidPackage"));
      }
      assertPetAssetExists(petRoot, variant.path);
    }
  }
}

function assertPetStandardActionAsset(petRoot: string, state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  const stateRecord = state as Record<string, unknown>;
  const frameCount = Math.max(1, Math.round(Number(stateRecord.frameCount) || 0));
  const durationMs = Math.max(0, Math.round(Number(stateRecord.durationMs) || 0));
  if (
    frameCount < DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES ||
    frameCount > DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES ||
    durationMs <= 0
  ) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  assertPetAssetExists(petRoot, stateRecord.path);
  assertPetSignatureActions(petRoot, stateRecord.alts, true);
}

function assertStrictPetManifest(petRoot: string, manifest: Record<string, unknown>) {
  if ("previewAssetPath" in manifest || "signatureActions" in manifest || "capabilities" in manifest) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  assertPetAssetExists(petRoot, manifest.preview);
  if (!manifest.states || typeof manifest.states !== "object" || Array.isArray(manifest.states)) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  const states = manifest.states as Record<string, unknown>;
  const allowedStateKeys: ReadonlySet<string> = new Set(DESKTOP_PET_REQUIRED_STATE_KEYS);
  if (Object.keys(states).some((key) => !allowedStateKeys.has(key))) {
    throw new Error(t("market.pet.invalidPackage"));
  }
  for (const key of DESKTOP_PET_REQUIRED_STATE_KEYS) {
    assertPetStandardActionAsset(petRoot, states[key]);
  }
  assertPetSignatureActions(petRoot, manifest.signature, true);
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
  const petById = new Map(listUserDesktopPets(app).map((pet) => [pet.id, pet]));
  return listUserDesktopPetAppearanceOptions(app).flatMap((option) => {
    const pet = petById.get(option.id);
    if (!pet) {
      return [];
    }
    return {
      id: pet.petId,
      type: "pet" as const,
      name: option.displayName,
      version: readText(pet.manifest.version) || "0.0.0",
      description: option.description,
      tags: Array.isArray(pet.manifest.tags)
        ? pet.manifest.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
        : [],
      state: "local-imported" as const,
      source: "local" as const,
      installedVersion: readText(pet.manifest.version) || "0.0.0",
      installPath: pet.rootPath,
      petPreviewUrl: option.previewUrl
    };
  });
}

function withPetDisplayFields(items: MarketItem[]): MarketItem[] {
  return items.map((item) => ({
    ...item,
    petPreviewUrl: item.petPreviewUrl ||
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
  const catalogItem = findCatalogItem(catalog, itemId, "pet");
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
  const tempRoot = path.join(app.getPath("temp") || os.tmpdir(), "desktop-market-pets", `${item.id}-${Date.now()}`);
  const safePetDirName = normalizePetDirectoryName(item.id);
  if (!safePetDirName) {
    throw new Error(t("market.pet.invalidId"));
  }
  try {
    const entries = await listArchiveEntriesAsync(archivePath);
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
    assertStrictPetManifest(petRoot, manifest as Record<string, unknown>);

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
      platform: resolved.platform,
      source: "cloud",
      assetUrl: resolved.asset.url,
      sha256: resolved.asset.sha256,
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
