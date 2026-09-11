import path from "node:path";
import type { App } from "electron";
import { getDesktopWebsConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { normalizeEntryKeys, readEntryKeysFile, writeEntryKeysFile } from "../../infrastructure/filesystem/entry-keys-file";

export function getWebPinnedPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebsConfigRoot(app, platform), "pinned.json");
}

function normalizePins(keys: unknown) {
  return normalizeEntryKeys(keys).filter((key) => /^(website|webapp):\S+$/.test(key));
}

export function readWebPinnedKeys(app: App, platform: NodeJS.Platform = process.platform) {
  return normalizePins(readEntryKeysFile(getWebPinnedPath(app, platform)) ?? []);
}

export function writeWebPinnedKeys(app: App, keys: string[], platform: NodeJS.Platform = process.platform) {
  return writeEntryKeysFile(getWebPinnedPath(app, platform), normalizePins(keys));
}
