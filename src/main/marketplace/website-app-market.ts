import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { extractArchiveToDir, listArchiveEntriesAsync } from "../archive-utils";
import { t } from "../i18n/main-i18n";
import {
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappsDataRoot
} from "../user-paths";
import { removeWebappItem } from "../webs/webapps/actions";
import { getWebappDir, readWebappItemFromDir } from "../webs/webapps/store";
import {
  installPreparedWebappDirectory,
  normalizeWebappDirectoryName,
  type WebappRuntimeValidationMode
} from "../webs/webapps/installation";
import {
  downloadAsset,
  findCatalogItem,
  loadMarketplaceCatalog,
  mergeCatalogItems,
  normalizeCatalog,
  removeInstalledRecord,
  selectAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

type WebsiteAppCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

type WebsiteAppArchiveInstallOptions = {
  expectedId?: string;
  displayName?: string;
  version?: string;
  source?: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  removeArchive?: boolean;
  runtimeValidation?: WebappRuntimeValidationMode;
};

function websiteAppOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) => item.type === "website-app")
  };
}

async function loadWebsiteAppCatalog(
  app: App,
  options: MarketplaceOptions = {}
): Promise<WebsiteAppCatalogResult> {
  if (options.catalog) {
    return {
      catalog: websiteAppOnlyCatalog(normalizeCatalog(options.catalog)),
      offline: false,
      message: t("market.main.catalogLoaded"),
      sourceUrl: options.catalogUrl ?? ""
    };
  }

  const result = await loadMarketplaceCatalog(app, options, "website app market catalog request");
  return {
    ...result,
    catalog: websiteAppOnlyCatalog(result.catalog)
  };
}

function assertSafeArchiveEntries(entries: Set<string>) {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().replace(/\\/gu, "/");
    if (!entry || entry.startsWith("/") || /^[a-z]:/iu.test(entry)) {
      throw new Error(t("market.websiteApp.invalidArchivePath"));
    }
    const parts = entry.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new Error(t("market.websiteApp.invalidArchivePath"));
    }
  }
}

function hasWebappManifest(entries: Set<string>) {
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\\/gu, "/").replace(/\/$/u, "");
    if (entry.endsWith("/webapp.json") || entry === "webapp.json") {
      return true;
    }
  }
  return false;
}

function findExtractedWebappRoot(rootPath: string): string | null {
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.shift() ?? rootPath;
    const manifestPath = path.join(current, "webapp.json");
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

function listLocalWebsiteApps(app: App): MarketItem[] {
  return fs.existsSync(getDesktopWebappsDataRoot(app))
    ? fs.readdirSync(getDesktopWebappsDataRoot(app), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const installPath = getWebappDir(app, entry.name);
        try {
          const item = readWebappItemFromDir(installPath, entry.name);
          if (!item) {
            return [];
          }
          return {
            id: item.id,
            type: "website-app" as const,
            name: item.label,
            version: item.version,
            description: "",
            tags: [],
            state: "local-imported" as const,
            source: "local" as const,
            installedVersion: item.version,
            installPath,
            websiteKind: "local-app" as const
          };
        } catch {
          return [];
        }
      })
    : [];
}

export async function listWebsiteAppMarketItems(
  app: App,
  options: MarketplaceOptions = {}
): Promise<MarketSectionResult> {
  const result = await loadWebsiteAppCatalog(app, options);
  return {
    items: mergeCatalogItems(app, result.catalog.items, listLocalWebsiteApps(app)),
    offline: result.offline,
    message: result.message,
    sourceUrl: result.sourceUrl
  };
}

export async function installWebsiteAppMarketItem(
  app: App,
  itemId: string,
  options: MarketplaceOptions = {}
): Promise<MarketCommandResult> {
  const { catalog } = await loadWebsiteAppCatalog(app, options);
  const item = findCatalogItem(catalog, itemId, "website-app");
  const selected = selectAsset(item);
  if (!selected) {
    throw new Error(t("market.main.platformUnavailable"));
  }
  const archivePath = await downloadAsset(app, item, selected.asset);
  return installWebsiteAppArchiveFromPath(app, archivePath, {
    expectedId: item.id,
    displayName: item.name,
    version: item.version,
    source: "cloud",
    assetUrl: selected.asset.url,
    sha256: selected.asset.sha256,
    removeArchive: true
  });
}

export async function installWebsiteAppArchiveFromPath(
  app: App,
  archivePath: string,
  options: WebsiteAppArchiveInstallOptions = {}
): Promise<MarketCommandResult> {
  const expectedId = normalizeWebappDirectoryName(options.expectedId);
  const tempId = expectedId || `local-${Date.now()}`;
  const stagingRoot = getDesktopWebappInstallStagingRoot(app);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempRoot = path.join(stagingRoot, `${tempId}-${nonce}`);
  const preparedPath = path.join(stagingRoot, `${tempId}-${nonce}-package`);
  try {
    const entries = await listArchiveEntriesAsync(archivePath);
    assertSafeArchiveEntries(entries);
    if (!hasWebappManifest(entries)) {
      throw new Error(t("market.websiteApp.invalidPackage"));
    }
    await extractArchiveToDir(archivePath, tempRoot);
    const webappRoot = findExtractedWebappRoot(tempRoot);
    if (!webappRoot) {
      throw new Error(t("market.websiteApp.invalidPackage"));
    }

    if (webappRoot === tempRoot) {
      fs.renameSync(tempRoot, preparedPath);
    } else {
      fs.renameSync(webappRoot, preparedPath);
    }
    const installed = await installPreparedWebappDirectory(app, preparedPath, {
      ...(expectedId ? { expectedId } : {}),
      runtimeValidation: options.runtimeValidation ?? "updates"
    });
    upsertInstalledRecord(app, {
      id: installed.item.id,
      type: "website-app",
      version: installed.item.schemaVersion >= 4
        ? installed.item.version
        : options.version ?? installed.item.version,
      source: options.source ?? "local",
      ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
      installPath: installed.installPath,
      installedAt: new Date().toISOString()
    });
    return {
      ok: true,
      itemId: installed.item.id,
      type: "website-app",
      state: "installed",
      message: t("market.websiteApp.installed", {
        name: options.displayName || installed.item.label
      }),
      installPath: installed.installPath
    };
  } finally {
    if (options.removeArchive) {
      fs.rmSync(archivePath, { force: true });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(preparedPath, { recursive: true, force: true });
  }
}

export async function uninstallWebsiteAppMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const safeWebappDirName = normalizeWebappDirectoryName(itemId);
  if (!safeWebappDirName) {
    throw new Error(t("market.websiteApp.invalidId"));
  }
  const removed = await removeWebappItem(app, safeWebappDirName);
  if (!removed.ok) {
    throw new Error(removed.message);
  }
  return {
    ok: true,
    itemId,
    type: "website-app",
    state: "not-installed",
    message: t("market.websiteApp.uninstalled", { name: itemId })
  };
}

export const __websiteAppMarketInternals = {
  installWebsiteAppArchiveFromPath,
  loadWebsiteAppCatalog,
  normalizeWebappDirectoryName
};
