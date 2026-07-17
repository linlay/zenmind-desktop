import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WebEntry, WebEntryKey } from "../../shared/contracts";
import { readDesktopProfileFromRoot, updateDesktopProfileInRoot } from "../desktop-profile-store";
import { getDesktopConfigRoot, getDesktopWebsConfigRoot } from "../user-paths";
import { normalizeWebEntryKey } from "./common";

const ORDER_FILE = "order.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntryKeyArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeWebEntryKey).filter((key): key is WebEntryKey => Boolean(key))
    : [];
}

export function getWebOrderPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsConfigRoot(app, platform), ORDER_FILE);
}

function readOrderFile(app: App, platform: NodeJS.Platform) {
  const orderPath = getWebOrderPath(app, platform);
  if (!fs.existsSync(orderPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(orderPath, "utf8")) as unknown;
  if (Array.isArray(parsed)) {
    return normalizeEntryKeyArray(parsed);
  }
  if (isRecord(parsed)) {
    return normalizeEntryKeyArray(parsed.entryKeys ?? parsed.ids);
  }
  return [];
}

function readProfileOrder(app: App, platform: NodeJS.Platform) {
  const profile = readDesktopProfileFromRoot(getDesktopConfigRoot(app, platform));
  return normalizeEntryKeyArray(profile.navigation.webOrder);
}

export function readWebOrderKeys(
  app: App,
  availableEntryKeys: string[] = [],
  platform: NodeJS.Platform = process.platform
) {
  const available = new Set(availableEntryKeys);
  const filterKnown = (keys: WebEntryKey[]) => available.size > 0 ? keys.filter((key) => available.has(key)) : keys;
  const orderFromFile = readOrderFile(app, platform);
  if (orderFromFile) {
    return filterKnown(orderFromFile);
  }

  const profileOrder = filterKnown(readProfileOrder(app, platform));
  if (profileOrder.length > 0) {
    writeWebOrderKeys(app, profileOrder, platform);
  }
  return profileOrder;
}

export function writeWebOrderKeys(
  app: App,
  keys: string[],
  platform: NodeJS.Platform = process.platform
) {
  const normalized = [...new Set(normalizeEntryKeyArray(keys))];
  const targetPath = getWebOrderPath(app, platform);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify({
    schemaVersion: 1,
    entryKeys: normalized
  }, null, 2)}\n`, "utf8");

  const current = readDesktopProfileFromRoot(getDesktopConfigRoot(app, platform));
  updateDesktopProfileInRoot(getDesktopConfigRoot(app, platform), {
    navigation: {
      mainOrder: current.navigation.mainOrder,
      webOrder: normalized,
      desktopCopilotPages: current.navigation.desktopCopilotPages
    }
  });
  return normalized;
}

export function applyWebOrder(app: App, items: WebEntry[], platform: NodeJS.Platform = process.platform) {
  const order = readWebOrderKeys(app, items.map((item) => item.entryKey), platform);
  const orderIndex = new Map(order.map((entryKey, index) => [entryKey, index] as const));
  return [...items].sort((a, b) => {
    const aIndex = orderIndex.get(a.entryKey);
    const bIndex = orderIndex.get(b.entryKey);
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
  normalizeEntryKeyArray
};
