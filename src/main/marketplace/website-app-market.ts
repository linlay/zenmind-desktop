import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { WEBAPP_ID_PATTERN } from "../../shared/webapp-manifest";
import { extractArchiveToDir, listArchiveEntriesAsync } from "../archive-utils";
import { t } from "../i18n/main-i18n";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsDataRoot
} from "../user-paths";
import { removeWebappItem } from "../webs/webapps/actions";
import { getWebappDir, readWebappItemFromDir } from "../webs/webapps/store";
import { webappRuntime } from "../webs/webapps/runtime";
import { webappWindowManager } from "../webs/webapps/window-manager";
import {
  activateWebappInstall,
  commitWebappInstall,
  rollbackWebappInstall,
  type WebappInstallTransaction
} from "../webs/webapps/install-transaction";
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
  recordInstallation?: boolean;
};

export class WebappInstallPolicyError extends Error {
  constructor(
    readonly code: "invalid_id" | "version_content_conflict" | "downgrade_not_allowed",
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = "WebappInstallPolicyError";
  }
}

export class WebappSystemRuntimeRequiredError extends Error {
  readonly code = "system_runtime_required";

  constructor(
    readonly webappId: string,
    readonly executable: string,
    message: string
  ) {
    super(message);
    this.name = "WebappSystemRuntimeRequiredError";
  }
}

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

function validateWebappId(value: unknown) {
  const id = typeof value === "string" ? value : "";
  return WEBAPP_ID_PATTERN.test(id) ? id : "";
}

function compareSemver(left: string, right: string) {
  const parse = (value: string) => {
    const separator = value.indexOf("-");
    const core = separator >= 0 ? value.slice(0, separator) : value;
    const prerelease = separator >= 0 ? value.slice(separator + 1) : "";
    return {
      core: core!.split(".").map(Number),
      prerelease: prerelease ? prerelease.split(".") : []
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return Math.sign(Number(aPart) - Number(bPart));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function calculateDirectoryDigest(rootPath: string) {
  const hash = createHash("sha256");
  const visit = (directoryPath: string) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`WebApp packages must not contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(absolutePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update("\0");
      }
    }
  };
  visit(rootPath);
  return hash.digest("hex");
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
  const hasExpectedId = Object.hasOwn(options, "expectedId");
  const expectedId = hasExpectedId ? validateWebappId(options.expectedId) : "";
  if (hasExpectedId && !expectedId) {
    throw new WebappInstallPolicyError(
      "invalid_id",
      t("market.websiteApp.invalidId"),
      { expectedId: options.expectedId }
    );
  }
  const tempId = expectedId || `local-${Date.now()}`;
  const stagingRoot = getDesktopWebappInstallStagingRoot(app);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempRoot = path.join(stagingRoot, `${tempId}-${nonce}`);
  const preparedPath = path.join(stagingRoot, `${tempId}-${nonce}-package`);
  let transaction: WebappInstallTransaction | null = null;
  let releaseWebappDisposal: (() => void) | null = null;
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

    const webapp = readWebappItemFromDir(webappRoot, expectedId);
    if (!webapp) {
      throw new Error(t("market.websiteApp.invalidPackage"));
    }
    const safeWebappDirName = validateWebappId(expectedId || webapp.id);
    if (!safeWebappDirName) {
      throw new Error(t("market.websiteApp.invalidId"));
    }
    if (webapp.id !== safeWebappDirName) {
      throw new Error(t("market.websiteApp.idMismatch", { expected: safeWebappDirName, actual: webapp.id }));
    }

    const targetRoot = getDesktopWebappsDataRoot(app);
    const installPath = path.join(targetRoot, safeWebappDirName);
    const replacingExisting = fs.existsSync(installPath);
    if (replacingExisting) {
      const installed = readWebappItemFromDir(installPath, safeWebappDirName);
      if (!installed) {
        throw new Error(t("market.websiteApp.invalidPackage"));
      }
      const versionOrder = compareSemver(webapp.version, installed.version);
      if (versionOrder < 0) {
        throw new WebappInstallPolicyError(
          "downgrade_not_allowed",
          `Cannot downgrade WebApp ${webapp.id} from ${installed.version} to ${webapp.version}.`,
          { id: webapp.id, installedVersion: installed.version, incomingVersion: webapp.version }
        );
      }
      if (versionOrder === 0) {
        const incomingDigest = calculateDirectoryDigest(webappRoot);
        const installedDigest = calculateDirectoryDigest(installPath);
        if (incomingDigest !== installedDigest) {
          throw new WebappInstallPolicyError(
            "version_content_conflict",
            `WebApp ${webapp.id} ${webapp.version} is already installed with different content.`,
            { id: webapp.id, version: webapp.version, installedDigest, incomingDigest }
          );
        }
        return {
          ok: true,
          itemId: webapp.id,
          type: "website-app",
          state: "installed",
          message: t("market.websiteApp.installed", { name: options.displayName || webapp.label }),
          installPath
        };
      }
    }
    const previousState = replacingExisting ? webappRuntime.getStatus(app, safeWebappDirName) : null;
    const previousWasRunning = previousState?.status === "running";
    const prerequisites = webappRuntime.checkItemPrerequisites(app, webapp, webappRoot);
    if (!prerequisites.ok) {
      if (
        webapp.backend?.command.type === "system" &&
        prerequisites.issues.some((entry) => entry.code === "system_runtime_missing")
      ) {
        throw new WebappSystemRuntimeRequiredError(
          webapp.id,
          webapp.backend.command.executable,
          prerequisites.message
        );
      }
      throw new Error(prerequisites.message);
    }
    if (replacingExisting) {
      releaseWebappDisposal = webappWindowManager.beginDisposal(safeWebappDirName);
      const stopped = await webappRuntime.stop(app, safeWebappDirName, t("market.websiteApp.replaced"));
      if (!stopped.ok) {
        throw new Error(t("webapp.marketReplaceActive", { message: stopped.message }));
      }
    }
    fs.mkdirSync(targetRoot, { recursive: true });
    if (webappRoot === tempRoot) {
      fs.renameSync(tempRoot, preparedPath);
    } else {
      fs.renameSync(webappRoot, preparedPath);
    }
    transaction = activateWebappInstall({
      app,
      id: safeWebappDirName,
      installPath,
      stagingPath: preparedPath
    });

    {
      const started = await webappRuntime.start(app, safeWebappDirName);
      if (!started.ok) {
        await webappRuntime.stop(app, safeWebappDirName).catch(() => undefined);
        rollbackWebappInstall(app, transaction);
        transaction = null;
        if (replacingExisting) {
          if (previousWasRunning) {
            await webappRuntime.start(app, safeWebappDirName).catch(() => undefined);
          } else {
            await webappRuntime.stop(app, safeWebappDirName).catch(() => undefined);
          }
        } else {
          fs.rmSync(getDesktopWebappDataRoot(app, safeWebappDirName), { recursive: true, force: true });
          fs.rmSync(getDesktopWebappStateRoot(app, safeWebappDirName), { recursive: true, force: true });
          fs.rmSync(getDesktopWebappLogsRoot(app, safeWebappDirName), { recursive: true, force: true });
        }
        throw new Error(t("webapp.marketStartupValidationFailed", { message: started.message }));
      }
      if (!previousWasRunning) {
        const stopped = await webappRuntime.stop(app, safeWebappDirName);
        if (!stopped.ok) {
          rollbackWebappInstall(app, transaction);
          transaction = null;
          throw new Error(stopped.message);
        }
      }
    }
    commitWebappInstall(app, transaction);
    transaction = null;
    if (options.recordInstallation !== false) {
      upsertInstalledRecord(app, {
        id: webapp.id,
        type: "website-app",
        version: webapp.version,
        source: options.source ?? "local",
        ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
        installPath,
        installedAt: new Date().toISOString()
      });
    }

    return {
      ok: true,
      itemId: webapp.id,
      type: "website-app",
      state: "installed",
      message: t("market.websiteApp.installed", { name: options.displayName || webapp.label }),
      installPath
    };
  } finally {
    releaseWebappDisposal?.();
    if (transaction) {
      rollbackWebappInstall(app, transaction);
    }
    if (options.removeArchive) {
      fs.rmSync(archivePath, { force: true });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallWebsiteAppMarketItem(app: App, itemId: string): Promise<MarketCommandResult> {
  const safeWebappDirName = validateWebappId(itemId);
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
  validateWebappId
};
