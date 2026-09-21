import { type WebEntryKey, type WebsiteEntry, type WebappEntry } from "../../../shared/contracts";
import { BootstrapSectionResult, BootstrapWebsReport, isRecord, readText, pathApiForRuntimeRoot, readJsonFile } from "./desktop-init-state";
import {
  normalizeWebId,
  createWebsiteItem,
  webappManager,
  readWebsiteItems,
  getWebsiteDir,
  writeWebsiteItem,
  readWebOrderKeys,
  writeWebOrderKeys
} from "../../modules/webs";
import path from "node:path";
import fs from "node:fs";
import { type App } from "electron";
import { getDesktopWebappsDataRoot } from "../../infrastructure/filesystem/user-paths";

export type PreparedBootstrapWebsite = {
  kind: "website";
  id: string;
  entryKey: WebEntryKey;
  item: WebsiteEntry;
};

export type PreparedBootstrapWebapp = {
  kind: "webapp";
  id: string;
  entryKey: WebEntryKey;
  item: WebappEntry;
  sourceDir: string;
};

export type PreparedBootstrapSite = PreparedBootstrapWebsite | PreparedBootstrapWebapp;

export type BootstrapWebsApplyResult = {
  status: Exclude<BootstrapSectionResult, "failed">;
  report: BootstrapWebsReport;
};

export function hasWebsiteDefaults(webs: unknown) {
  return isRecord(webs) && Array.isArray(webs.items);
}

export function assertSafeBootstrapId(rawId: unknown, itemIndex: number) {
  const id = readText(rawId);
  if (!id || normalizeWebId(id) !== id) {
    throw new Error(`webs.items[${itemIndex}].id must be a normalized Site id.`);
  }
  return id;
}

export function assertPathInsideRoot(
  rootDir: string,
  targetDir: string,
  pathApi: typeof path.posix | typeof path.win32,
  message: string
) {
  const relative = pathApi.relative(rootDir, targetDir);
  if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(message);
  }
}

export function assertBootstrapTreeHasNoSymlinks(rootDir: string) {
  const visit = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`WebApp seed cannot contain symbolic links: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  };
  visit(rootDir);
}

export function prepareBootstrapSites(
  initPath: string,
  webs: unknown,
  platform: NodeJS.Platform
) {
  const rawItems = isRecord(webs) && Array.isArray(webs.items) ? webs.items : [];
  const pathApi = pathApiForRuntimeRoot(platform, path.dirname(initPath));
  const sitesRoot = pathApi.join(pathApi.dirname(initPath), "desktop-init", "sites");
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const prepared: PreparedBootstrapSite[] = [];

  for (const [index, rawItem] of rawItems.entries()) {
    if (!isRecord(rawItem)) {
      throw new Error(`webs.items[${index}] must be an object.`);
    }
    const kind = readText(rawItem.kind);
    if (kind !== "website" && kind !== "webapp") {
      throw new Error(`webs.items[${index}].kind must be website or webapp.`);
    }
    const explicitId = assertSafeBootstrapId(rawItem.id, index);

    if (kind === "website") {
      const item = createWebsiteItem({
        id: explicitId || undefined,
        label: readText(rawItem.label) || undefined,
        url: readText(rawItem.url),
        copilotAgentKey: readText(rawItem.copilotAgentKey) || undefined
      });
      if (seenIds.has(item.id)) {
        throw new Error(`Duplicate Site id in desktop-init: ${item.id}`);
      }
      if (seenUrls.has(item.url)) {
        throw new Error(`Duplicate Website URL in desktop-init: ${item.url}`);
      }
      seenIds.add(item.id);
      seenUrls.add(item.url);
      prepared.push({ kind, id: item.id, entryKey: item.entryKey, item });
      continue;
    }

    const id = explicitId;
    if (seenIds.has(id)) {
      throw new Error(`Duplicate Site id in desktop-init: ${id}`);
    }
    const sourceDir = pathApi.join(sitesRoot, id);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`WebApp seed directory does not exist: desktop-init/sites/${id}`);
    }
    if (fs.lstatSync(sitesRoot).isSymbolicLink() || fs.lstatSync(sourceDir).isSymbolicLink()) {
      throw new Error(`WebApp seed path cannot be a symbolic link: ${id}`);
    }
    const sitesRootReal = fs.realpathSync(sitesRoot);
    const sourceDirReal = fs.realpathSync(sourceDir);
    assertPathInsideRoot(
      sitesRootReal,
      sourceDirReal,
      pathApi,
      `WebApp seed path escapes desktop-init/sites: ${id}`
    );
    assertBootstrapTreeHasNoSymlinks(sourceDirReal);
    const rawManifest = readJsonFile(pathApi.join(sourceDirReal, webappManager.manifestFileName));
    if (!webappManager.isManifest(rawManifest) || !isRecord(rawManifest)) {
      throw new Error(`WebApp seed manifest is invalid: ${id}/${webappManager.manifestFileName}`);
    }
    if (readText(rawManifest.id) !== id) {
      throw new Error(`WebApp seed manifest id must match directory id: ${id}`);
    }
    const item = webappManager.readPackage(sourceDirReal, id);
    if (!item || item.id !== id) {
      throw new Error(`WebApp seed manifest is invalid: ${id}/${webappManager.manifestFileName}`);
    }
    seenIds.add(id);
    prepared.push({ kind, id, entryKey: item.entryKey, item, sourceDir: sourceDirReal });
  }
  return prepared;
}

export function applyWebsiteDefaults(
  app: App,
  initPath: string,
  webs: unknown,
  preserve: boolean,
  platform: NodeJS.Platform = process.platform
): BootstrapWebsApplyResult {
  const mode = preserve ? "preserve" : "initialize";
  const emptyReport: BootstrapWebsReport = { mode, items: [], warnings: [] };
  if (!hasWebsiteDefaults(webs)) {
    return { status: "absent", report: emptyReport };
  }
  if (preserve) {
    return { status: "preserved", report: emptyReport };
  }

  // Validate every declared Site and packaged WebApp before touching user data.
  const prepared = prepareBootstrapSites(initPath, webs, platform);
  const existingWebsites = readWebsiteItems(app, platform);
  const existingWebapps = webappManager.listInstalled(app, platform);
  const websiteById = new Map(existingWebsites.map((item) => [item.id, item] as const));
  const websiteByUrl = new Map(existingWebsites.map((item) => [item.url, item] as const));
  const webappById = new Map(existingWebapps.map((item) => [item.id, item] as const));
  const report: BootstrapWebsReport = { mode, items: [], warnings: [] };
  const declaredOrder: WebEntryKey[] = [];
  const websitesToInstall: PreparedBootstrapWebsite[] = [];
  const webappsToInstall: PreparedBootstrapWebapp[] = [];

  for (const site of prepared) {
    if (site.kind === "website") {
      const existing = websiteById.get(site.id) ?? websiteByUrl.get(site.item.url);
      if (existing) {
        declaredOrder.push(existing.entryKey);
        const message = `Preserved existing Website for seed ${site.id}.`;
        report.items.push({ entryKey: existing.entryKey, status: "skipped", message });
        report.warnings.push(message);
        continue;
      }
      const targetDir = getWebsiteDir(app, site.id, platform);
      if (fs.existsSync(targetDir)) {
        const message = `Preserved unknown Website directory for seed ${site.id}.`;
        report.items.push({ entryKey: site.entryKey, status: "skipped", message });
        report.warnings.push(message);
        continue;
      }
      websitesToInstall.push(site);
      declaredOrder.push(site.entryKey);
      continue;
    }

    const existing = webappById.get(site.id);
    const targetDir = path.join(getDesktopWebappsDataRoot(app, platform), site.id);
    if (existing || fs.existsSync(targetDir)) {
      const entryKey = existing?.entryKey ?? site.entryKey;
      const message = `Preserved existing WebApp for seed ${site.id}.`;
      if (existing) {
        declaredOrder.push(entryKey);
      }
      report.items.push({ entryKey, status: "skipped", message });
      report.warnings.push(message);
      continue;
    }
    webappsToInstall.push(site);
    declaredOrder.push(site.entryKey);
  }

  const webappsRoot = getDesktopWebappsDataRoot(app, platform);
  const stagedWebapps: Array<{ site: PreparedBootstrapWebapp; stagedDir: string; targetDir: string }> = [];
  const createdDirs: string[] = [];
  let stagingRoot = "";
  try {
    if (webappsToInstall.length > 0) {
      fs.mkdirSync(webappsRoot, { recursive: true });
      stagingRoot = fs.mkdtempSync(path.join(webappsRoot, ".desktop-init-"));
      for (const site of webappsToInstall) {
        const stagedDir = path.join(stagingRoot, site.id);
        fs.cpSync(site.sourceDir, stagedDir, { recursive: true, errorOnExist: true });
        const stagedItem = webappManager.canonicalizePackage(stagedDir, site.id);
        if (stagedItem.id !== site.id) {
          throw new Error(`Staged WebApp id changed unexpectedly: ${site.id}`);
        }
        stagedWebapps.push({ site, stagedDir, targetDir: path.join(webappsRoot, site.id) });
      }
    }

    for (const staged of stagedWebapps) {
      fs.renameSync(staged.stagedDir, staged.targetDir);
      createdDirs.push(staged.targetDir);
      report.items.push({ entryKey: staged.site.entryKey, status: "installed" });
    }
    for (const site of websitesToInstall) {
      writeWebsiteItem(app, site.item, platform);
      createdDirs.push(getWebsiteDir(app, site.id, platform));
      report.items.push({ entryKey: site.entryKey, status: "installed" });
    }

    const availableEntryKeys = [
      ...existingWebsites.map((item) => item.entryKey),
      ...existingWebapps.map((item) => item.entryKey),
      ...websitesToInstall.map((item) => item.entryKey),
      ...webappsToInstall.map((item) => item.entryKey)
    ];
    const currentOrder = readWebOrderKeys(app, availableEntryKeys, platform);
    writeWebOrderKeys(app, [...declaredOrder, ...currentOrder, ...availableEntryKeys], platform);
  } catch (error) {
    for (const createdDir of createdDirs.reverse()) {
      fs.rmSync(createdDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (stagingRoot) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  return { status: "applied", report };
}
