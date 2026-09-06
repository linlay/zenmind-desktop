import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { DESKTOP_ACTION_BRIDGE_PORT } from "../../../shared/desktop-actions";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export const DESKTOP_ACTION_BRIDGE_SETTINGS_FILE = "desktop-action-bridge.json";

const MAX_TCP_PORT = 65535;

export type DesktopActionBridgeSettingsConfig = {
  schemaVersion: 1;
  port: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTcpPort(value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_TCP_PORT ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/gu, "");
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const port = Number.parseInt(trimmed, 10);
  return port > 0 && port <= MAX_TCP_PORT ? port : null;
}

function readPlatformDefaults(defaults: Record<string, unknown>, platform: NodeJS.Platform) {
  const platforms = isRecord(defaults.platforms) ? defaults.platforms : {};
  const platformDefaults = platforms[platform];
  return isRecord(platformDefaults) ? platformDefaults : {};
}

export function normalizeDesktopActionBridgeSettingsConfig(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): DesktopActionBridgeSettingsConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  const platformDefaults = readPlatformDefaults(value, platform);
  const port = readTcpPort(platformDefaults.port) ?? readTcpPort(value.port);
  return port
    ? {
        schemaVersion: 1,
        port
      }
    : null;
}

export function getDesktopActionBridgeSettingsConfigPath(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(getDesktopConfigRoot(app, platform), DESKTOP_ACTION_BRIDGE_SETTINGS_FILE);
}

export function writeDesktopActionBridgeSettingsConfig(
  app: App,
  config: DesktopActionBridgeSettingsConfig,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getDesktopActionBridgeSettingsConfigPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readDesktopActionBridgeSettingsConfig(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getDesktopActionBridgeSettingsConfigPath(app, platform);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeDesktopActionBridgeSettingsConfig(parsed, platform);
  } catch {
    return null;
  }
}

export function getConfiguredDesktopActionBridgePort(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  return readDesktopActionBridgeSettingsConfig(app, platform)?.port ?? DESKTOP_ACTION_BRIDGE_PORT;
}
