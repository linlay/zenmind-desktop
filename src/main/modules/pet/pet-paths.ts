import type { App } from "electron";
import type { Platform } from "./pet-model";
import path from "node:path";
import { getDesktopPetSettingsPath as resolveDesktopPetSettingsPath, getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import { DESKTOP_PET_STATE_FILE } from "./pet-model";
import fs from "node:fs";

export function getDesktopPetRoot(app: App, platform: Platform = process.platform) {
  return path.dirname(getDesktopPetSettingsPath(app, platform));
}

export function getDesktopPetSettingsPath(app: App, platform: Platform = process.platform) {
  return resolveDesktopPetSettingsPath(app, platform as NodeJS.Platform);
}

export function getDesktopPetStatePath(app: App, platform: Platform = process.platform) {
  return path.join(getDesktopStateRoot(app, platform as NodeJS.Platform), DESKTOP_PET_STATE_FILE);
}

export function ensureDesktopPetRoot(app: App, platform: Platform = process.platform) {
  fs.mkdirSync(getDesktopPetRoot(app, platform), { recursive: true });
}

export function ensureDesktopPetStateRoot(app: App, platform: Platform = process.platform) {
  fs.mkdirSync(path.dirname(getDesktopPetStatePath(app, platform)), { recursive: true });
}
