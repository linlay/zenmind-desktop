import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WebsiteEntry, WebsiteInput } from "../../../shared/contracts";
import { getDesktopWebsitesDataRoot } from "../../user-paths";
import {
  createWebId,
  createWebsiteEntryKey,
  isRecord,
  normalizeAgentKey,
  normalizeWebId,
  normalizeWebsiteLabel,
  normalizeWebsiteUrl,
  readString,
  sanitizeWebsiteItems,
  sortWebEntries,
  toIsoTimestamp,
  toTimestamp
} from "../common";

export const WEBSITE_FILE = "website.json";
export const WEBSITE_SCHEMA_VERSION = 2;

function readCopilotAgentKey(value: Record<string, unknown>) {
  return normalizeAgentKey(readString(value.copilotAgentKey) || readString(value.agentKey));
}

export function getWebsiteDir(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsitesDataRoot(app, platform), normalizeWebId(id));
}

export function getWebsitePath(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getWebsiteDir(app, id, platform), WEBSITE_FILE);
}

export function normalizeWebsiteManifest(value: unknown, fallbackId = ""): WebsiteEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const urlText = readString(value.url);
  if (!urlText) {
    return null;
  }
  const url = normalizeWebsiteUrl(urlText);
  const now = Date.now();
  const id = normalizeWebId(readString(value.id) || fallbackId || createWebId());
  const copilotAgentKey = readCopilotAgentKey(value);
  return {
    id,
    entryKey: createWebsiteEntryKey(id),
    kind: "website",
    label: normalizeWebsiteLabel(readString(value.label), url),
    url,
    ...(copilotAgentKey ? { copilotAgentKey } : {}),
    createdAt: value.createdAt === undefined ? now : toTimestamp(value.createdAt),
    updatedAt: value.updatedAt === undefined ? now : toTimestamp(value.updatedAt)
  };
}

function readWebsiteManifestFile(websiteDir: string) {
  const websitePath = path.join(websiteDir, WEBSITE_FILE);
  return JSON.parse(fs.readFileSync(websitePath, "utf8")) as unknown;
}

export function readWebsiteItemFromDir(websiteDir: string, fallbackId = "") {
  return normalizeWebsiteManifest(readWebsiteManifestFile(websiteDir), fallbackId || path.basename(websiteDir));
}

export function readWebsiteItems(app: App, platform: NodeJS.Platform = process.platform) {
  return readWebsiteItemsWithoutMigration(app, platform);
}

export function readWebsiteItemsWithoutMigration(app: App, platform: NodeJS.Platform = process.platform) {
  const root = getDesktopWebsitesDataRoot(app, platform);
  if (!fs.existsSync(root)) {
    return [];
  }
  const items: WebsiteEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const item = readWebsiteItemFromDir(path.join(root, entry.name), entry.name);
      if (item) {
        items.push(item);
      }
    } catch (error) {
      console.warn("failed to read website item", path.join(root, entry.name, WEBSITE_FILE), error);
    }
  }
  return sortWebEntries(sanitizeWebsiteItems(items));
}

export function writeWebsiteItems(
  app: App,
  items: WebsiteEntry[],
  platform: NodeJS.Platform = process.platform
) {
  return writeWebsiteItemsWithoutMigration(app, items, platform);
}

export function writeWebsiteItemsWithoutMigration(
  app: App,
  items: WebsiteEntry[],
  platform: NodeJS.Platform = process.platform
) {
  const root = getDesktopWebsitesDataRoot(app, platform);
  fs.mkdirSync(root, { recursive: true });
  const normalizedItems = sanitizeWebsiteItems(items);
  const expectedDirs = new Set(normalizedItems.map((item) => normalizeWebId(item.id)));

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || expectedDirs.has(entry.name)) {
      continue;
    }
    try {
      const existing = readWebsiteItemFromDir(path.join(root, entry.name), entry.name);
      if (existing?.kind === "website") {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    } catch {
      // Preserve unknown user directories instead of risking webapp data loss.
    }
  }

  for (const item of normalizedItems) {
    writeWebsiteItem(app, item, platform);
  }
  return normalizedItems;
}

export function writeWebsiteItem(
  app: App,
  item: WebsiteEntry,
  platform: NodeJS.Platform = process.platform
) {
  const websiteId = normalizeWebId(item.id);
  const targetPath = getWebsitePath(app, websiteId, platform);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify({
    schemaVersion: WEBSITE_SCHEMA_VERSION,
    id: websiteId,
    kind: "website",
    label: item.label,
    url: item.url,
    ...(item.copilotAgentKey ? { copilotAgentKey: item.copilotAgentKey } : {}),
    createdAt: toIsoTimestamp(item.createdAt),
    updatedAt: toIsoTimestamp(item.updatedAt)
  }, null, 2)}\n`, "utf8");
  return item;
}

export function createWebsiteItem(input: WebsiteInput): WebsiteEntry {
  const url = normalizeWebsiteUrl(input.url);
  const now = Date.now();
  const id = normalizeWebId(input.id || createWebId());
  const copilotAgentKey = readCopilotAgentKey(input as unknown as Record<string, unknown>);
  return {
    id,
    entryKey: createWebsiteEntryKey(id),
    kind: "website",
    label: normalizeWebsiteLabel(input.label, url),
    url,
    ...(copilotAgentKey ? { copilotAgentKey } : {}),
    createdAt: input.createdAt === undefined ? now : toTimestamp(input.createdAt),
    updatedAt: input.updatedAt === undefined ? now : toTimestamp(input.updatedAt)
  };
}

export function isWebsiteFile(value: unknown) {
  try {
    return Boolean(normalizeWebsiteManifest(isRecord(value) ? value : {}, ""));
  } catch {
    return false;
  }
}
