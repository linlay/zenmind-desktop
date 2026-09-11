import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { App } from "electron";
import type { MarketCommandResult } from "../../../shared/contracts";
import { extractArchiveToDir, inspectZipArchiveSafety, listArchiveEntries } from "../../support/archive/archive-utils";
import { t } from "../../support/i18n/main-i18n";
import { getSoftwarePackagesRoot } from "../../infrastructure/filesystem/user-paths";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  readInstalledRecords,
  resolveMarketAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u;
const MAX_PACKAGE_ENTRIES = 10_000;
const MAX_PACKAGE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const ARCHIVE_INSPECTION_TIMEOUT_MS = 300_000;

function normalizePackageSegment(value: string, pattern: RegExp, label: string) {
  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new Error(t("market.softwarePackage.invalidIdentity", { label }));
  }
  return normalized;
}

export function getSoftwarePackageInstallDir(app: App, itemId: string, version: string) {
  const safeId = normalizePackageSegment(itemId, PACKAGE_ID_PATTERN, "id");
  const safeVersion = normalizePackageSegment(version.replace(/^v/u, ""), PACKAGE_VERSION_PATTERN, "version");
  return path.join(getSoftwarePackagesRoot(app), safeId, safeVersion);
}

function softwarePackageOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "software-package")
  };
}

async function loadSoftwarePackageCatalog(app: App, options: MarketplaceOptions = {}) {
  if (options.catalog) {
    return {
      catalog: softwarePackageOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }
  const result = await loadMarketplaceCatalog(app, options, "software package market catalog request");
  return {
    ...result,
    catalog: softwarePackageOnlyCatalog(result.catalog)
  };
}

export async function listSoftwarePackageMarketItems(
  app: App,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const result = await loadSoftwarePackageCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, []),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

function assertSafeArchiveEntry(entryName: string) {
  const normalized = entryName.trim().replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.includes("../") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw new Error(t("market.softwarePackage.unsafeArchive"));
  }
}

function assertTarArchiveHasNoLinks(archivePath: string) {
  const output = execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    timeout: ARCHIVE_INSPECTION_TIMEOUT_MS
  });
  for (const line of output.split(/\r?\n/u)) {
    const entryType = line.trimStart().charAt(0);
    if (entryType === "l" || entryType === "h") {
      throw new Error(t("market.softwarePackage.symlinkRejected"));
    }
  }
}

function validateExtractedPackage(root: string) {
  let entryCount = 0;
  let expandedBytes = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > MAX_PACKAGE_ENTRIES) {
        throw new Error(t("market.softwarePackage.packageTooLarge"));
      }
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error(t("market.softwarePackage.symlinkRejected"));
      }
      if (stat.isDirectory()) {
        visit(target);
      } else if (stat.isFile()) {
        expandedBytes += stat.size;
        if (expandedBytes > MAX_EXPANDED_PACKAGE_BYTES) {
          throw new Error(t("market.softwarePackage.packageTooLarge"));
        }
      }
    }
  };
  visit(root);
  if (entryCount === 0) {
    throw new Error(t("market.softwarePackage.emptyArchive"));
  }
}

function writeCurrentVersion(itemRoot: string, value: { version: string; installPath: string }) {
  const currentPath = path.join(itemRoot, "current.json");
  const temporaryPath = `${currentPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, currentPath);
}

function restoreCurrentVersion(currentPath: string, previous: Buffer | null) {
  if (previous) {
    fs.writeFileSync(currentPath, previous);
  } else {
    fs.rmSync(currentPath, { force: true });
  }
}

export async function installSoftwarePackageMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const market = await loadSoftwarePackageCatalog(app, options);
  const catalogItem = findCatalogItem(market.catalog, itemId, "software-package");
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  if (resolved.asset.sizeBytes <= 0 || resolved.asset.sizeBytes > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new Error(t("market.softwarePackage.packageTooLarge"));
  }
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
  const installPath = getSoftwarePackageInstallDir(app, item.id, item.version);
  const itemRoot = path.dirname(installPath);
  const currentPath = path.join(itemRoot, "current.json");
  const previousCurrent = fs.existsSync(currentPath) ? fs.readFileSync(currentPath) : null;
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const extractRoot = path.join(itemRoot, `.staging-${nonce}`);
  const backupPath = path.join(itemRoot, `.backup-${path.basename(installPath)}-${nonce}`);
  let backedUp = false;
  let activated = false;
  try {
    fs.mkdirSync(itemRoot, { recursive: true });
    for (const entry of listArchiveEntries(archivePath)) {
      assertSafeArchiveEntry(entry);
    }
    if (resolved.asset.archiveType === "zip") {
      await inspectZipArchiveSafety(archivePath, {
        maxArchiveBytes: MAX_PACKAGE_ARCHIVE_BYTES,
        maxExpandedBytes: MAX_EXPANDED_PACKAGE_BYTES,
        maxEntries: MAX_PACKAGE_ENTRIES
      });
    } else {
      assertTarArchiveHasNoLinks(archivePath);
    }
    await extractArchiveToDir(archivePath, extractRoot);
    validateExtractedPackage(extractRoot);

    const entries = fs.readdirSync(extractRoot, { withFileTypes: true });
    const sourcePath = entries.length === 1 && entries[0].isDirectory()
      ? path.join(extractRoot, entries[0].name)
      : extractRoot;
    if (fs.existsSync(installPath)) {
      fs.renameSync(installPath, backupPath);
      backedUp = true;
    }
    fs.renameSync(sourcePath, installPath);
    activated = true;
    writeCurrentVersion(itemRoot, { version: item.version, installPath });
    upsertInstalledRecord(app, {
      id: item.id,
      type: "software-package",
      version: item.version,
      platform: resolved.platform,
      source: "cloud",
      assetUrl: resolved.asset.url,
      sha256: resolved.asset.sha256,
      installPath,
      installedAt: new Date().toISOString()
    });
    if (backedUp) {
      fs.rmSync(backupPath, { recursive: true, force: true });
      backedUp = false;
    }
    return {
      ok: true,
      itemId: item.id,
      type: "software-package",
      state: "installed",
      message: t("market.softwarePackage.installed", { name: item.name }),
      installPath
    };
  } catch (error) {
    if (activated) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    if (backedUp && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, installPath);
      backedUp = false;
    }
    restoreCurrentVersion(currentPath, previousCurrent);
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(extractRoot, { recursive: true, force: true });
    if (!backedUp) {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
  }
}

export async function uninstallSoftwarePackageMarketItem(
  app: App,
  itemId: string
): Promise<MarketCommandResult> {
  const record = readInstalledRecords(app).find((item) => item.type === "software-package" && item.id === itemId);
  const safeId = normalizePackageSegment(itemId, PACKAGE_ID_PATTERN, "id");
  const itemRoot = path.join(getSoftwarePackagesRoot(app), safeId);
  fs.rmSync(itemRoot, { recursive: true, force: true });
  return {
    ok: true,
    itemId,
    type: "software-package",
    state: "not-installed",
    message: t("market.softwarePackage.uninstalled", { name: itemId }),
    installPath: record?.installPath
  };
}

export const __softwarePackageMarketInternals = {
  loadSoftwarePackageCatalog,
  validateExtractedPackage
};
