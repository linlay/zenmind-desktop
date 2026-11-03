import type {InstalledDesktopSkinSummary} from "../../../shared/desktop-appearance";
import fs from "node:fs";
import type { App } from "electron";
import type { MarketCommandResult } from "../../../shared/contracts";
import { SkinPackageError, SKIN_PACKAGE_LIMITS } from "../../../shared/desktop-skin-package";
import { t } from "../../support/i18n/main-i18n";
import { loadMarketplaceCatalog, normalizeCatalog, mergeCatalogItems, resolveMarketAsset, findCatalogItem, downloadAsset, upsertInstalledRecord, compareVersions, type MarketplaceOptions, type MarketSectionResult } from "./common";
export async function listSkinMarketItems(app: App, options: MarketplaceOptions = {}): Promise<MarketSectionResult> {
    const result = options.catalog ? { catalog: normalizeCatalog(options.catalog), offline: false, message: "", sourceUrl: options.catalogUrl ?? "" }
        : await loadMarketplaceCatalog(app, options, "skin market catalog request");
    let installed: readonly InstalledDesktopSkinSummary[] = [];
    let stateError = false;
    try { if (options.skinPackages) installed = await options.skinPackages.listInstalled(); }
    catch { stateError = true; }
    const items = mergeCatalogItems(app, result.catalog.items.filter(item => item.type === "skin"), [], []).map(item => {
        const candidates = installed.filter(skin => skin.packageId === item.id).sort((a, b) => compareVersions(b.version, a.version));
        const exact = candidates.find(skin => skin.version === item.version), local = exact ?? candidates[0];
        return local ? { ...item, state: exact ? "installed" as const : compareVersions(item.version, local.version) > 0 ? "update-available" as const : "installed" as const,
            installedSkinId: local.id, installedVersion: local.version } : item;
    });
    return { ...result, items, offline: result.offline || stateError, message: stateError ? t("market.skin.stateUnavailable") : result.message };
}
export async function installSkinMarketItem(app: App, id: string, options: MarketplaceOptions = {}): Promise<MarketCommandResult> {
    if (!options.skinPackages)
        throw new Error(t("market.skin.unavailable"));
    const catalog = await loadMarketplaceCatalog(app, options, "skin market install request");
    const resolved = await resolveMarketAsset(app, findCatalogItem(catalog.catalog, id, "skin"), options);
    const archive = await downloadAsset(app, resolved.item, resolved.asset, options, resolved.downloadUrl, SKIN_PACKAGE_LIMITS.archiveBytes);
    try {
        const skinId = await options.skinPackages.installArchive(archive, { id: resolved.item.id, version: resolved.item.version }, options.assertSkinOwner ?? (() => { }), skinId => {
            upsertInstalledRecord(app, { id: resolved.item.id, type: "skin", version: resolved.item.version, source: "cloud", platform: resolved.platform, resourceKey: skinId, assetUrl: resolved.asset.url, sha256: resolved.asset.sha256, installedAt: new Date().toISOString() });
        });
        return { ok: true, itemId: resolved.item.id, type: "skin", state: "installed", skinId, message: t("market.skin.installed") };
    }
    catch (error) {
        if (error instanceof SkinPackageError)
            throw new Error(t(`settings.appearance.${error.code}`));
        throw error;
    }
    finally {
        fs.rmSync(archive, { force: true });
    }
}
