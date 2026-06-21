import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { extractArchiveToDir, listArchiveEntriesAsync } from "../archive-utils";
import { t } from "../i18n/main-i18n";
import { getDesktopWebappsDataRoot } from "../user-paths";
import { getWebappDir, readWebappItemFromDir } from "../webs/webapps/store";
import { webappRuntime } from "../webs/webapps/runtime";
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

function normalizeWebappDirectoryName(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().replace(/^user:/u, "") : "";
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
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
            version: "0.0.0",
            description: "",
            tags: [],
            state: "local-imported" as const,
            source: "local" as const,
            installedVersion: "0.0.0",
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
  const safeWebappDirName = normalizeWebappDirectoryName(item.id);
  if (!safeWebappDirName) {
    throw new Error(t("market.websiteApp.invalidId"));
  }

  const archivePath = await downloadAsset(app, item, selected.asset);
  const tempRoot = path.join(app.getPath("temp") || os.tmpdir(), "desktop-market-webapps", `${item.id}-${Date.now()}`);
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

    const webapp = readWebappItemFromDir(webappRoot, safeWebappDirName);
    if (!webapp) {
      throw new Error(t("market.websiteApp.invalidPackage"));
    }
    if (webapp.id !== safeWebappDirName) {
      throw new Error(t("market.websiteApp.idMismatch", { expected: item.id, actual: webapp.id }));
    }

    const targetRoot = getDesktopWebappsDataRoot(app);
    const installPath = path.join(targetRoot, safeWebappDirName);
    await webappRuntime.stop(app, safeWebappDirName, t("market.websiteApp.replaced")).catch(() => undefined);
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.rmSync(installPath, { recursive: true, force: true });
    fs.cpSync(webappRoot, installPath, { recursive: true });
    upsertInstalledRecord(app, {
      id: item.id,
      type: "website-app",
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
      type: "website-app",
      state: "installed",
      message: t("market.websiteApp.installed", { name: item.name }),
      installPath
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallWebsiteAppMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const safeWebappDirName = normalizeWebappDirectoryName(itemId);
  if (!safeWebappDirName) {
    throw new Error(t("market.websiteApp.invalidId"));
  }
  await webappRuntime.stop(
    app,
    safeWebappDirName,
    t("market.websiteApp.uninstalled", { name: itemId })
  ).catch(() => undefined);
  fs.rmSync(path.join(getDesktopWebappsDataRoot(app), safeWebappDirName), { recursive: true, force: true });
  removeInstalledRecord(app, itemId, "website-app");
  return {
    ok: true,
    itemId,
    type: "website-app",
    state: "not-installed",
    message: t("market.websiteApp.uninstalled", { name: itemId })
  };
}

export const __websiteAppMarketInternals = {
  loadWebsiteAppCatalog,
  normalizeWebappDirectoryName
};
