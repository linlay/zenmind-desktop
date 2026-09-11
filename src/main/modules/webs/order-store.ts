import { readEntryKeysFile, writeEntryKeysFile } from "../../infrastructure/filesystem/entry-keys-file";
import path from "node:path";
import type { App } from "electron";
import type { WebEntry, WebEntryKey } from "../../../shared/contracts";
import { getDesktopWebsConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { normalizeWebEntryKey } from "./common";

const ORDER_FILE = "order.json";

function normalizeEntryKeyArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(normalizeWebEntryKey).filter((key): key is WebEntryKey => Boolean(key))
    : [];
}

export function getWebOrderPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsConfigRoot(app, platform), ORDER_FILE);
}

export function readWebOrderKeys(
  app: App,
  availableEntryKeys: string[] = [],
  platform: NodeJS.Platform = process.platform
) {
  const available = new Set(availableEntryKeys);
  const filterKnown = (keys: WebEntryKey[]) => available.size > 0 ? keys.filter((key) => available.has(key)) : keys;
  const keys = readEntryKeysFile(getWebOrderPath(app, platform)) ?? [];
  return filterKnown(normalizeEntryKeyArray(keys));
}

export function writeWebOrderKeys(
  app: App,
  keys: string[],
  platform: NodeJS.Platform = process.platform
) {
  const normalized = [...new Set(normalizeEntryKeyArray(keys))];
  writeEntryKeysFile(getWebOrderPath(app, platform), normalized);
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
