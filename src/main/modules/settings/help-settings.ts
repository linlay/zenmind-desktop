import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { DesktopHelpSettings } from "../../../shared/help";
import { isSafeHelpUrl } from "../../../shared/help";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export const HELP_SETTINGS_FILE = "help.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeHelpUrl(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || !isSafeHelpUrl(candidate)) {
    return "";
  }
  const url = new URL(candidate);
  url.hash = "";
  return url.toString();
}

export function normalizeHelpSettings(value: unknown): DesktopHelpSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = normalizeHelpUrl(value.url);
  return url
    ? {
        schemaVersion: 1,
        url
      }
    : null;
}

export function getHelpSettingsPath(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopConfigRoot(app, platform), HELP_SETTINGS_FILE);
}

export function writeHelpSettings(
  app: App,
  settings: DesktopHelpSettings,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getHelpSettingsPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function readHelpSettings(
  app: App,
  platform: NodeJS.Platform = process.platform
): DesktopHelpSettings {
  try {
    const value = JSON.parse(fs.readFileSync(getHelpSettingsPath(app, platform), "utf8")) as unknown;
    return normalizeHelpSettings(value) ?? {
      schemaVersion: 1,
      url: ""
    };
  } catch {
    return {
      schemaVersion: 1,
      url: ""
    };
  }
}
