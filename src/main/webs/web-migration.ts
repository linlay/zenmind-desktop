import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { readDesktopProfileFromRoot } from "../desktop-profile-store";
import {
  getDesktopConfigRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebappsLogsRoot,
  getDesktopWebappsStateRoot,
  getDesktopWebsConfigRoot,
  getDesktopWebsStateRoot,
  getDesktopWebsitesDataRoot,
  getLegacyDesktopWebsitesConfigRoot,
  getLegacyDesktopWebsitesDataRoot,
  getLegacyDesktopWebsitesLogsRoot,
  getLegacyDesktopWebsitesStateRoot
} from "../user-paths";
import {
  createWebappEntryKey,
  createWebsiteEntryKey,
  isRecord,
  normalizeAgentKey,
  normalizeWebEntryKey,
  normalizeWebId,
  normalizeWebsiteLabel,
  normalizeWebsiteUrl,
  readString,
  toIsoTimestamp,
  toTimestamp
} from "./web-common";

const MIGRATION_FILE = "migration.json";
const WEBSITE_FILE = "website.json";
const WEBAPP_FILE = "webapp.json";
const LEGACY_WEBSITE_ITEMS_FILE = "custom-sidebar-items.json";
const completedMigrationPaths = new Set<string>();

type MigrationSummary = {
  schemaVersion: 1;
  migratedAt: string;
  data: { websites: number; webapps: number };
  order: { migrated: boolean; count: number };
  runtime: { stateDirs: number; logDirs: number };
  skipped: string[];
  errors: string[];
};

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isLegacyWebappManifest(value: unknown) {
  return isRecord(value) && (value.kind === "local-app" || value.schemaVersion === 2);
}

function normalizeLegacyTimestamp(value: unknown) {
  return toIsoTimestamp(toTimestamp(value));
}

function writeWebsiteManifest(targetDir: string, raw: Record<string, unknown>, fallbackId: string) {
  const url = normalizeWebsiteUrl(readString(raw.url));
  const id = normalizeWebId(readString(raw.id) || fallbackId);
  const agentKey = normalizeAgentKey(raw.agentKey);
  writeJsonFile(path.join(targetDir, WEBSITE_FILE), {
    schemaVersion: 1,
    id,
    kind: "website",
    label: normalizeWebsiteLabel(readString(raw.label), url),
    url,
    ...(agentKey ? { agentKey } : {}),
    createdAt: normalizeLegacyTimestamp(raw.createdAt),
    updatedAt: normalizeLegacyTimestamp(raw.updatedAt)
  });
  return id;
}

function writeWebappManifest(targetDir: string, raw: Record<string, unknown>, fallbackId: string) {
  const id = normalizeWebId(readString(raw.id) || fallbackId);
  const agentKey = normalizeAgentKey(raw.agentKey);
  writeJsonFile(path.join(targetDir, WEBAPP_FILE), {
    schemaVersion: 1,
    id,
    kind: "webapp",
    label: normalizeWebsiteLabel(readString(raw.label), id),
    frontend: isRecord(raw.frontend) ? raw.frontend : {},
    backend: isRecord(raw.backend) ? raw.backend : {},
    ...(agentKey ? { agentKey } : {}),
    createdAt: normalizeLegacyTimestamp(raw.createdAt),
    updatedAt: normalizeLegacyTimestamp(raw.updatedAt)
  });
  return id;
}

function copyDirIfMissing(sourceDir: string, targetDir: string, skipped: string[]) {
  if (fs.existsSync(targetDir)) {
    skipped.push(`${targetDir} already exists`);
    return false;
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return true;
}

function migrateLegacyWebData(app: App, summary: MigrationSummary) {
  const legacyRoot = getLegacyDesktopWebsitesDataRoot(app);
  if (!fs.existsSync(legacyRoot)) {
    return;
  }
  for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(legacyRoot, entry.name);
    const raw = readJsonFile(path.join(sourceDir, WEBSITE_FILE));
    if (!isRecord(raw)) {
      summary.skipped.push(`${sourceDir} missing legacy website manifest`);
      continue;
    }

    try {
      if (isLegacyWebappManifest(raw)) {
        const id = normalizeWebId(readString(raw.id) || entry.name);
        const targetDir = path.join(getDesktopWebappsDataRoot(app), id);
        if (copyDirIfMissing(sourceDir, targetDir, summary.skipped)) {
          fs.rmSync(path.join(targetDir, WEBSITE_FILE), { force: true });
          writeWebappManifest(targetDir, raw, entry.name);
          summary.data.webapps += 1;
        }
        continue;
      }

      const id = normalizeWebId(readString(raw.id) || entry.name);
      const targetDir = path.join(getDesktopWebsitesDataRoot(app), id);
      if (copyDirIfMissing(sourceDir, targetDir, summary.skipped)) {
        writeWebsiteManifest(targetDir, raw, entry.name);
        summary.data.websites += 1;
      }
    } catch (error) {
      summary.errors.push(`${sourceDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function parseLegacyItemsPayload(raw: unknown) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (isRecord(raw) && Array.isArray(raw.items)) {
    return raw.items;
  }
  return [];
}

function migrateLegacyWebsiteItemsFile(app: App, summary: MigrationSummary) {
  const legacyPath = path.join(getDesktopConfigRoot(app), LEGACY_WEBSITE_ITEMS_FILE);
  const raw = readJsonFile(legacyPath);
  const items = parseLegacyItemsPayload(raw);
  if (items.length === 0) {
    return;
  }
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    try {
      const url = normalizeWebsiteUrl(readString(item.url));
      const id = normalizeWebId(readString(item.id));
      const targetDir = path.join(getDesktopWebsitesDataRoot(app), id);
      if (fs.existsSync(targetDir)) {
        summary.skipped.push(`${targetDir} already exists`);
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      writeWebsiteManifest(targetDir, { ...item, url, id }, id);
      summary.data.websites += 1;
    } catch (error) {
      summary.errors.push(`${legacyPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function normalizeLegacyOrderValue(value: unknown) {
  const key = normalizeWebEntryKey(value);
  return key ? createWebsiteEntryKey(key.split(":")[1] || "") : null;
}

function readLegacyOrderFile(app: App) {
  const orderPath = path.join(getLegacyDesktopWebsitesConfigRoot(app), "order.json");
  const parsed = readJsonFile(orderPath);
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeLegacyOrderValue).filter((value): value is `website:${string}` => Boolean(value));
  }
  if (isRecord(parsed) && Array.isArray(parsed.ids)) {
    return parsed.ids.map(normalizeLegacyOrderValue).filter((value): value is `website:${string}` => Boolean(value));
  }
  return [];
}

function readLegacyProfileOrder(app: App) {
  const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
  return profile.navigation.webOrder
    .map(normalizeLegacyOrderValue)
    .filter((value): value is `website:${string}` => Boolean(value));
}

function migrateLegacyOrder(app: App, summary: MigrationSummary) {
  const targetPath = path.join(getDesktopWebsConfigRoot(app), "order.json");
  if (fs.existsSync(targetPath)) {
    summary.skipped.push(`${targetPath} already exists`);
    return;
  }
  const order = [...new Set([
    ...readLegacyOrderFile(app),
    ...readLegacyProfileOrder(app)
  ])];
  if (order.length === 0) {
    return;
  }
  writeJsonFile(targetPath, {
    schemaVersion: 1,
    entryKeys: order
  });
  summary.order.migrated = true;
  summary.order.count = order.length;
}

function migrateRuntimeDirs(sourceRoot: string, targetRoot: string, skipped: string[]) {
  if (!fs.existsSync(sourceRoot)) {
    return 0;
  }
  let migrated = 0;
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const targetDir = path.join(targetRoot, normalizeWebId(entry.name));
    if (copyDirIfMissing(path.join(sourceRoot, entry.name), targetDir, skipped)) {
      migrated += 1;
    }
  }
  return migrated;
}

export function getWebsMigrationPath(app: App) {
  return path.join(getDesktopWebsStateRoot(app), MIGRATION_FILE);
}

export function ensureWebsMigration(app: App) {
  const migrationPath = getWebsMigrationPath(app);
  if (completedMigrationPaths.has(migrationPath) || fs.existsSync(migrationPath)) {
    completedMigrationPaths.add(migrationPath);
    return;
  }

  const summary: MigrationSummary = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    data: { websites: 0, webapps: 0 },
    order: { migrated: false, count: 0 },
    runtime: { stateDirs: 0, logDirs: 0 },
    skipped: [],
    errors: []
  };

  fs.mkdirSync(getDesktopWebsitesDataRoot(app), { recursive: true });
  fs.mkdirSync(getDesktopWebappsDataRoot(app), { recursive: true });
  fs.mkdirSync(getDesktopWebsConfigRoot(app), { recursive: true });
  fs.mkdirSync(getDesktopWebappsStateRoot(app), { recursive: true });
  fs.mkdirSync(getDesktopWebappsLogsRoot(app), { recursive: true });

  migrateLegacyWebData(app, summary);
  migrateLegacyWebsiteItemsFile(app, summary);
  migrateLegacyOrder(app, summary);
  summary.runtime.stateDirs = migrateRuntimeDirs(
    getLegacyDesktopWebsitesStateRoot(app),
    getDesktopWebappsStateRoot(app),
    summary.skipped
  );
  summary.runtime.logDirs = migrateRuntimeDirs(
    getLegacyDesktopWebsitesLogsRoot(app),
    getDesktopWebappsLogsRoot(app),
    summary.skipped
  );

  writeJsonFile(migrationPath, summary);
  completedMigrationPaths.add(migrationPath);
}

export const __testInternals = {
  MIGRATION_FILE,
  createWebappEntryKey,
  createWebsiteEntryKey
};
