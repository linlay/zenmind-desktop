import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../../shared/contracts";
import { WEBAPP_ID_PATTERN } from "../../shared/webapp-manifest";
import packageValidation = require("../../shared/webapp-package-validation");
import { extractArchiveToDir, inspectZipArchiveSafety } from "../archive-utils";
import { t } from "../i18n/main-i18n";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsDataRoot
} from "../user-paths";
import { disposeWebappInstallation } from "../webs/webapps/actions";
import {
  getWebappDir,
  readInstalledWebappItems,
  readWebappItemFromDir
} from "../webs/webapps/store";
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
  readInstalledRecords,
  replaceInstalledRecords,
  resolveMarketAsset,
  upsertInstalledRecord,
  type Catalog,
  type MarketplaceOptions,
  type MarketSectionResult
} from "./common";

const {
  WebappPackageValidationError,
  validateWebappArchiveLayout
} = packageValidation;

type WebsiteAppCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

type WebsiteAppArchiveInstallOptions = {
  expectedId?: string;
  marketItemId?: string;
  displayName?: string;
  version?: string;
  source?: "cloud" | "local";
  platform?: string;
  assetUrl?: string;
  sha256?: string;
  removeArchive?: boolean;
  recordInstallation?: boolean;
};

export type WebappInstallStage = "archive" | "manifest" | "package" | "runtime" | "startup" | "install";

export class WebappInstallError extends Error {
  constructor(
    readonly stage: WebappInstallStage,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WebappInstallError";
  }
}

export class WebappInstallPolicyError extends WebappInstallError {
  constructor(
    code: "invalid_id" | "version_content_conflict" | "downgrade_not_allowed",
    message: string,
    details: Record<string, unknown>
  ) {
    super("install", code, message, details);
    this.name = "WebappInstallPolicyError";
  }
}

export class WebappRuntimeRequiredError extends WebappInstallError {
  constructor(
    readonly webappId: string,
    readonly executable: string,
    message: string
  ) {
    super("runtime", "runtime_required", message, { webappId, runtime: executable });
    this.name = "WebappRuntimeRequiredError";
  }
}

function toWebappInstallError(
  error: unknown,
  stage: WebappInstallStage,
  code: string,
  details: Record<string, unknown> = {}
) {
  if (error instanceof WebappInstallError) {
    return error;
  }
  if (error instanceof WebappPackageValidationError) {
    return new WebappInstallError(error.stage, error.code, error.message, error.details);
  }
  return new WebappInstallError(
    stage,
    code,
    error instanceof Error ? error.message : String(error),
    details
  );
}

function websiteAppOnlyCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    items: catalog.items.filter((item) =>
      item.type === "website-app" && item.websiteKind === "local-app"
    )
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
  const catalogItem = findCatalogItem(catalog, itemId, "website-app");
  const resolved = await resolveMarketAsset(app, catalogItem, options);
  const item = resolved.item;
  if (item.websiteKind !== "local-app" || resolved.asset.archiveType !== "zip") {
    throw new WebappInstallError(
      "archive",
      "unsupported_market_artifact",
      t("market.websiteApp.localZipRequired")
    );
  }
  const archivePath = await downloadAsset(app, item, resolved.asset, options, resolved.downloadUrl);
  return installWebsiteAppArchiveFromPath(app, archivePath, {
    marketItemId: item.id,
    displayName: item.name,
    version: item.version,
    source: "cloud",
    platform: resolved.platform,
    assetUrl: resolved.asset.url,
    sha256: resolved.asset.sha256,
    removeArchive: true
  });
}

export async function installWebsiteAppArchiveFromPath(
  app: App,
  archivePath: string,
  options: WebsiteAppArchiveInstallOptions = {}
): Promise<MarketCommandResult> {
  if (path.extname(archivePath).toLowerCase() !== ".zip") {
    throw new WebappInstallError("archive", "unsupported_format", "WebApp packages must be ZIP archives.", {
      path: archivePath
    });
  }
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
  const originalInstalledRecords = options.recordInstallation === false
    ? null
    : readInstalledRecords(app);
  let installedRecordCommitted = false;
  let activatedWebappId = "";
  let replacingExistingPackage = false;
  let previousPackageWasRunning = false;
  try {
    let archiveRootName: string;
    try {
      const { entries } = await inspectZipArchiveSafety(archivePath);
      archiveRootName = validateWebappArchiveLayout(entries, WEBAPP_ID_PATTERN);
      await extractArchiveToDir(archivePath, tempRoot);
    } catch (error) {
      throw toWebappInstallError(error, "archive", "invalid_archive", { path: archivePath });
    }
    const webappRoot = path.join(tempRoot, archiveRootName);
    if (!fs.existsSync(webappRoot) || !fs.statSync(webappRoot).isDirectory()) {
      throw new WebappInstallError("package", "package_root_missing", t("market.websiteApp.invalidPackage"), {
        path: webappRoot
      });
    }

    let webapp;
    try {
      webapp = readWebappItemFromDir(webappRoot, expectedId || archiveRootName);
    } catch (error) {
      throw toWebappInstallError(error, "manifest", "invalid_manifest", {
        path: path.join(webappRoot, "webapp.json")
      });
    }
    if (!webapp) {
      throw new WebappInstallError("package", "invalid_package", t("market.websiteApp.invalidPackage"));
    }
    const safeWebappDirName = validateWebappId(expectedId || webapp.id);
    if (!safeWebappDirName) {
      throw new WebappInstallError("manifest", "invalid_id", t("market.websiteApp.invalidId"));
    }
    if (webapp.id !== safeWebappDirName) {
      throw new WebappInstallError(
        "manifest",
        "id_mismatch",
        t("market.websiteApp.idMismatch", { expected: safeWebappDirName, actual: webapp.id }),
        { expected: safeWebappDirName, actual: webapp.id }
      );
    }
    if (archiveRootName !== webapp.id) {
      throw new WebappInstallError(
        "archive",
        "id_mismatch",
        t("market.websiteApp.idMismatch", { expected: archiveRootName, actual: webapp.id }),
        { expected: archiveRootName, actual: webapp.id }
      );
    }
    if (options.version && webapp.version !== options.version) {
      throw new WebappInstallError(
        "manifest",
        "version_mismatch",
        t("market.websiteApp.versionMismatch", {
          expected: options.version,
          actual: webapp.version
        }),
        { expected: options.version, actual: webapp.version }
      );
    }
    const keyConflict = readInstalledWebappItems(app).find((item) =>
      item.key === webapp.key && item.id !== webapp.id
    );
    if (keyConflict) {
      throw new WebappInstallError(
        "install",
        "key_conflict",
        `WebApp key is already installed: ${webapp.key} (${keyConflict.id}).`,
        { key: webapp.key, installedId: keyConflict.id }
      );
    }

    const targetRoot = getDesktopWebappsDataRoot(app);
    const installPath = path.join(targetRoot, safeWebappDirName);
    const replacingExisting = fs.existsSync(installPath);
    replacingExistingPackage = replacingExisting;
    if (replacingExisting) {
      const installed = readWebappItemFromDir(installPath, safeWebappDirName);
      if (!installed) {
        throw new WebappInstallError("install", "installed_package_invalid", t("market.websiteApp.invalidPackage"), {
          id: safeWebappDirName
        });
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
        if (options.recordInstallation !== false) {
          upsertInstalledRecord(app, {
            id: options.marketItemId || webapp.id,
            type: "website-app",
            version: webapp.version,
            ...(options.platform ? { platform: options.platform } : {}),
            source: options.source ?? "local",
            ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
            ...(options.sha256 ? { sha256: options.sha256 } : {}),
            installPath,
            ...(options.marketItemId ? { resourceKey: webapp.id } : {}),
            installedAt: new Date().toISOString()
          });
        }
        webappRuntime.emitLifecycleChange("installed", webapp.id);
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
    previousPackageWasRunning = previousWasRunning;
    const prerequisites = webappRuntime.checkItemPrerequisites(app, webapp, webappRoot);
    if (!prerequisites.ok) {
      if (
        webapp.backend?.command.type === "runtime" &&
        prerequisites.issues.some((entry) =>
          entry.code === "runtime_missing" || entry.code === "runtime_version_too_low"
        )
      ) {
        throw new WebappRuntimeRequiredError(
          webapp.id,
          webapp.backend.command.runtime,
          prerequisites.message
        );
      }
      throw new WebappInstallError("runtime", "runtime_invalid", prerequisites.message, {
        issues: prerequisites.issues
      });
    }
    if (replacingExisting) {
      releaseWebappDisposal = webappWindowManager.beginDisposal(safeWebappDirName);
      const stopped = await webappRuntime.stop(app, safeWebappDirName, t("market.websiteApp.replaced"));
      if (!stopped.ok) {
        throw new WebappInstallError(
          "install",
          "existing_runtime_stop_failed",
          t("webapp.marketReplaceActive", { message: stopped.message }),
          { id: safeWebappDirName }
        );
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
    activatedWebappId = safeWebappDirName;

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
        throw new WebappInstallError(
          "startup",
          "startup_failed",
          t("webapp.marketStartupValidationFailed", { message: started.message }),
          { id: safeWebappDirName }
        );
      }
      if (!previousWasRunning) {
        const stopped = await webappRuntime.stop(app, safeWebappDirName);
        if (!stopped.ok) {
          rollbackWebappInstall(app, transaction);
          transaction = null;
          throw new WebappInstallError("startup", "validation_stop_failed", stopped.message, {
            id: safeWebappDirName
          });
        }
      }
    }
    if (options.recordInstallation !== false) {
      upsertInstalledRecord(app, {
        id: options.marketItemId || webapp.id,
        type: "website-app",
        version: webapp.version,
        ...(options.platform ? { platform: options.platform } : {}),
        source: options.source ?? "local",
        ...(options.assetUrl ? { assetUrl: options.assetUrl } : {}),
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
        installPath,
        ...(options.marketItemId ? { resourceKey: webapp.id } : {}),
        installedAt: new Date().toISOString()
      });
      installedRecordCommitted = true;
    }
    commitWebappInstall(app, transaction);
    transaction = null;
    webappRuntime.emitLifecycleChange(replacingExisting ? "updated" : "installed", webapp.id);

    return {
      ok: true,
      itemId: webapp.id,
      type: "website-app",
      state: "installed",
      message: t("market.websiteApp.installed", { name: options.displayName || webapp.label }),
      installPath
    };
  } catch (error) {
    if (transaction && activatedWebappId) {
      await webappRuntime.stop(app, activatedWebappId).catch(() => undefined);
      rollbackWebappInstall(app, transaction);
      transaction = null;
      if (replacingExistingPackage && previousPackageWasRunning) {
        await webappRuntime.start(app, activatedWebappId).catch(() => undefined);
      }
    }
    if (installedRecordCommitted && originalInstalledRecords) {
      replaceInstalledRecords(app, originalInstalledRecords);
      installedRecordCommitted = false;
    }
    throw toWebappInstallError(error, "install", "install_failed", { path: archivePath });
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
  const marketRecord = readInstalledRecords(app).find((record) =>
    record.id === itemId && record.type === "website-app"
  );
  const safeWebappDirName = validateWebappId(marketRecord?.resourceKey || itemId);
  if (!safeWebappDirName) {
    throw new Error(t("market.websiteApp.invalidId"));
  }
  const target = readInstalledWebappItems(app).find((item) => item.id === safeWebappDirName);
  if (!target) {
    throw new Error(t("webapp.notFound"));
  }
  if (target.removable === false) {
    throw new Error(t("webapp.managedNotRemovable", { label: target.label }));
  }
  const removed = await disposeWebappInstallation(
    app,
    {
      id: target.id,
      label: target.label,
      installPath: target.installPath,
      removeMarketRecord: true,
      preserveUserData: true
    },
    t("market.websiteApp.uninstalled", { name: target.label })
  );
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
