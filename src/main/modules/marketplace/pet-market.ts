import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../../shared/contracts";
import { listUserDesktopPetAppearanceOptions, listUserDesktopPets, PetPackageError } from "../pet";
import { t } from "../../support/i18n/main-i18n";
import {
  downloadAsset, findCatalogItem, loadMarketplaceCatalog, mergeCatalogItems,
  normalizeCatalog, resolveMarketAsset, upsertInstalledRecord, removeInstalledRecord,
  readInstalledRecords, type Catalog, type MarketplaceOptions, type MarketSectionResult
} from "./common";

function petOnlyCatalog(catalog: Catalog): Catalog {
  return { ...catalog, items: catalog.items.filter(item => item.type === "pet") };
}
async function loadPetCatalog(app: App, options: MarketplaceOptions = {}) {
  if (options.catalog) return { catalog: petOnlyCatalog(normalizeCatalog(options.catalog)), offline: false, message: t("market.main.catalogLoaded"), sourceUrl: options.catalogUrl ?? "" };
  const result = await loadMarketplaceCatalog(app, options, "pet market catalog request");
  return { ...result, catalog: petOnlyCatalog(result.catalog) };
}
function listLocalPets(app: App): MarketItem[] {
  const petById = new Map(listUserDesktopPets(app).map(pet => [pet.id, pet]));
  return listUserDesktopPetAppearanceOptions(app).flatMap(option => {
    const pet = petById.get(option.id);
    if (!pet) return [];
    const version = typeof pet.manifest.version === "string" ? pet.manifest.version : "0.0.0";
    return [{ id: pet.petId, type: "pet" as const, name: option.displayName, version,
      description: option.description, tags: Array.isArray(pet.manifest.tags) ? pet.manifest.tags.filter((tag): tag is string => typeof tag === "string") : [],
      state: "local-imported" as const, source: "local" as const, installedVersion: version,
      installPath: pet.rootPath, petPreviewUrl: option.previewUrl }];
  });
}
export async function listPetMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
  const local = listLocalPets(app);
  const localByID = new Map(local.map(pet => [pet.id, pet]));
  // A leftover Market record cannot resurrect a deleted package or overwrite a
  // different locally imported pet with the same identity.
  const records = readInstalledRecords(app).filter(record => {
    if (record.type !== "pet") return true;
    const installed = localByID.get(record.id);
    if (!installed?.installPath) return false;
    try {
      const file = path.join(installed.installPath, ".market-source.json");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return false;
      const marker = JSON.parse(fs.readFileSync(file, "utf8"));
      return marker.id === record.id && marker.version === installed.version && marker.version === record.version;
    } catch { return false; }
  });
  const result = await loadPetCatalog(app, options);
  return { ...result, items: mergeCatalogItems(app, result.catalog.items, local, records).map(item => ({
    ...item, state: item.source === "local" && localByID.has(item.id) ? "local-imported" : item.state, petPreviewUrl: item.petPreviewUrl || item.metadata?.previewUrl || item.metadata?.imageUrl
  })) };
}
export async function installPetMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  if (!options.petPackages) throw new Error(t("market.pet.unavailable"));
  const { catalog } = await loadPetCatalog(app, options);
  const resolved = await resolveMarketAsset(app, findCatalogItem(catalog, itemId, "pet"), options);
  const { item, asset } = resolved;
  const archivePath = await downloadAsset(app, item, asset, options, resolved.downloadUrl);
  try {
    await options.petPackages.installMarketPackage(archivePath, { id: item.id, version: item.version }, () => {
      upsertInstalledRecord(app, { id: item.id, type: "pet", version: item.version, platform: resolved.platform,
        source: "cloud", assetUrl: asset.url, sha256: asset.sha256, installedAt: new Date().toISOString() });
    }, options.assertPetOwner);
    return { ok: true, itemId: item.id, type: "pet", state: "installed", message: t("market.pet.installed", { name: item.name }) };
  } catch (error) {
    if (error instanceof PetPackageError) throw new Error(t(`settings.desktopPet.import.${error.code}`));
    throw error;
  } finally { fs.rmSync(archivePath, { force: true }); }
}
export async function uninstallPetMarketItem(app: App, itemId: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
  if (!options.petPackages || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(itemId)) throw new Error(t("market.pet.unavailable"));
  await options.petPackages.removePackage(`user:${itemId}`);
  removeInstalledRecord(app, itemId, "pet");
  return { ok: true, itemId, type: "pet", state: "not-installed", message: t("market.pet.uninstalled", { name: itemId }) };
}
export const __petMarketInternals = { loadPetCatalog };
