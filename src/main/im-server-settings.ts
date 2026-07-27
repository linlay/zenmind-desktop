import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopConfigRoot } from "./user-paths";

export const IM_SERVER_SETTINGS_FILE = "im-server.json";
export const DEFAULT_IM_SERVER_BASE_URL = "http://127.0.0.1:11956";

export type ImServerSettings = {
  schemaVersion: 1;
  baseUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

export function normalizeImServerBaseUrl(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) {
    return "";
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "";
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "";
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function normalizeImServerSettings(value: unknown): ImServerSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseUrl = normalizeImServerBaseUrl(value.baseUrl);
  return baseUrl
    ? {
        schemaVersion: 1,
        baseUrl
      }
    : null;
}

export function getImServerSettingsPath(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopConfigRoot(app, platform), IM_SERVER_SETTINGS_FILE);
}

export function writeImServerSettings(
  app: App,
  settings: ImServerSettings,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getImServerSettingsPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function readImServerSettings(
  app: App,
  platform: NodeJS.Platform = process.platform
): ImServerSettings {
  const filePath = getImServerSettingsPath(app, platform);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeImServerSettings(parsed) ?? {
      schemaVersion: 1,
      baseUrl: DEFAULT_IM_SERVER_BASE_URL
    };
  } catch {
    return {
      schemaVersion: 1,
      baseUrl: DEFAULT_IM_SERVER_BASE_URL
    };
  }
}
