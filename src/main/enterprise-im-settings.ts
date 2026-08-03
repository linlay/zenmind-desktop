import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { EnterpriseImSettings } from "../shared/contracts";
import { getDesktopConfigRoot } from "./user-paths";

export type { EnterpriseImSettings } from "../shared/contracts";

export const ENTERPRISE_IM_SETTINGS_FILE = "enterprise-im.json";
export const DEFAULT_ENTERPRISE_IM_ENABLED = false;
export const DEFAULT_ENTERPRISE_IM_BASE_URL = "http://127.0.0.1:11956";

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

export function normalizeEnterpriseImBaseUrl(value: unknown) {
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

export function normalizeEnterpriseImSettings(value: unknown): EnterpriseImSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseUrl = normalizeEnterpriseImBaseUrl(value.baseUrl);
  return typeof value.enabled === "boolean" && baseUrl
    ? {
        schemaVersion: 1,
        enabled: value.enabled,
        baseUrl
      }
    : null;
}

export function getEnterpriseImSettingsPath(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopConfigRoot(app, platform), ENTERPRISE_IM_SETTINGS_FILE);
}

export function writeEnterpriseImSettings(
  app: App,
  settings: EnterpriseImSettings,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getEnterpriseImSettingsPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function readEnterpriseImSettings(
  app: App,
  platform: NodeJS.Platform = process.platform
): EnterpriseImSettings {
  const fallback: EnterpriseImSettings = {
    schemaVersion: 1,
    enabled: DEFAULT_ENTERPRISE_IM_ENABLED,
    baseUrl: DEFAULT_ENTERPRISE_IM_BASE_URL
  };
  const filePath = getEnterpriseImSettingsPath(app, platform);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeEnterpriseImSettings(parsed) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setEnterpriseImEnabled(
  app: App,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform
) {
  const settings = {
    ...readEnterpriseImSettings(app, platform),
    enabled: enabled === true
  };
  writeEnterpriseImSettings(app, settings, platform);
  return settings;
}
