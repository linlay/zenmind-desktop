import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getMarketplaceCacheRoot, getMarketplaceStateRoot, getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureMarketplaceRoots(app: App) {
  const cacheRoot = getMarketplaceCacheRoot(app);
  const stateRoot = getMarketplaceStateRoot(app);
  fs.mkdirSync(path.join(cacheRoot, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(cacheRoot, "backups"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  return { cacheRoot, stateRoot };
}

export function installedRecordsPath(app: App) {
  return path.join(ensureMarketplaceRoots(app).stateRoot, "marketplace-installed.json");
}

export function marketplaceSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "market.json");
}

export function downloadsRoot(app: App) {
  return path.join(ensureMarketplaceRoots(app).cacheRoot, "downloads");
}
