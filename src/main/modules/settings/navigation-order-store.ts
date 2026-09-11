import path from "node:path";
import type { App } from "electron";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { readEntryKeysFile, writeEntryKeysFile } from "../../infrastructure/filesystem/entry-keys-file";

export function getNavigationOrderPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "navigation-order.json");
}

export function readNavigationOrder(app: App, platform: NodeJS.Platform = process.platform) {
  return readEntryKeysFile(getNavigationOrderPath(app, platform)) ?? [];
}

export function writeNavigationOrder(app: App, keys: string[], platform: NodeJS.Platform = process.platform) {
  return writeEntryKeysFile(getNavigationOrderPath(app, platform), keys);
}
