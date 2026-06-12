import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WebsiteListItem } from "../../shared/contracts";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot } from "../desktop-profile-store";
import { getDesktopConfigRoot, getDesktopWebsitesConfigRoot } from "../user-paths";

const ORDER_FILE = "order.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeId(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.startsWith("custom:") ? raw.slice("custom:".length).trim() : raw;
}

function normalizeIdArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeId).filter(Boolean)
    : [];
}

export function getWebsiteOrderPath(app: App) {
  return path.join(getDesktopWebsitesConfigRoot(app), ORDER_FILE);
}

function readOrderFile(app: App) {
  const orderPath = getWebsiteOrderPath(app);
  if (!fs.existsSync(orderPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(orderPath, "utf8")) as unknown;
  if (Array.isArray(parsed)) {
    return normalizeIdArray(parsed);
  }
  if (isRecord(parsed)) {
    return normalizeIdArray(parsed.ids);
  }
  return [];
}

function readLegacyProfileOrder(app: App) {
  const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
  return normalizeIdArray(profile.navigation.websiteOrder);
}

export function readWebsiteOrderIds(app: App, availableIds: string[] = []) {
  const available = new Set(availableIds);
  const filterKnown = (ids: string[]) => available.size > 0 ? ids.filter((id) => available.has(id)) : ids;
  const orderFromFile = readOrderFile(app);
  if (orderFromFile) {
    return filterKnown(orderFromFile);
  }

  const legacyOrder = filterKnown(readLegacyProfileOrder(app));
  if (legacyOrder.length > 0) {
    writeWebsiteOrderIds(app, legacyOrder);
  }
  return legacyOrder;
}

export function writeWebsiteOrderIds(app: App, ids: string[]) {
  const normalized = [...new Set(normalizeIdArray(ids))];
  const targetPath = getWebsiteOrderPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify({
    schemaVersion: 1,
    ids: normalized
  }, null, 2)}\n`, "utf8");
  return normalized;
}

export function readWebsiteOrderKeys(app: App, availableIds: string[] = []) {
  return readWebsiteOrderIds(app, availableIds).map((id) => `custom:${id}`);
}

export function writeWebsiteOrderKeys(app: App, keys: string[]) {
  const ids = writeWebsiteOrderIds(app, keys.map(normalizeId));
  const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app));
  updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
    navigation: {
      mainOrder: current.navigation.mainOrder,
      websiteOrder: ids.map((id) => `custom:${id}`),
      desktopCopilotPages: current.navigation.desktopCopilotPages
    }
  });
  return ids.map((id) => `custom:${id}`);
}

export function applyWebsiteOrder(app: App, items: WebsiteListItem[]) {
  const order = readWebsiteOrderIds(app, items.map((item) => item.id));
  const orderIndex = new Map(order.map((id, index) => [id, index] as const));
  return [...items].sort((a, b) => {
    const aIndex = orderIndex.get(a.id);
    const bIndex = orderIndex.get(b.id);
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex;
    }
    if (aIndex !== undefined) {
      return -1;
    }
    if (bIndex !== undefined) {
      return 1;
    }
    return a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN");
  });
}

export const __testInternals = {
  ORDER_FILE,
  normalizeId,
  normalizeIdArray
};
