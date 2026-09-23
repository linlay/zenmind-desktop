import type { App } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  KanbanCloudConfig,
  KanbanSettings,
  KanbanSettingsInput
} from "../../../shared/contracts";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { getDesktopDeviceInfo, readDesktopSsoAccessToken, readDesktopSsoAccessTokenUser } from "../identity";
import { isRecord, readBoolean, readText } from "./protocol-values";
import {
  type KanbanDesktopConnectionState,
  type KanbanDesktopWsConfig
} from "./ws-client";

export type KanbanDesktopConfigFile = {
  schemaVersion?: unknown;
  enabled?: unknown;
  cloud?: unknown;
  serverUrl?: unknown;
  remoteControlEnabled?: unknown;
};

export const KANBAN_CONFIG_FILE = "kanban.json";

export const DEFAULT_SELECTED_PROJECT_ID = "default";

export function getKanbanConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), KANBAN_CONFIG_FILE);
}

export function normalizeKanbanCloudConfig(input: KanbanDesktopConfigFile): KanbanCloudConfig {
  return {
    serverUrl: readText(input.serverUrl),
    remoteControlEnabled: readBoolean(input.remoteControlEnabled)
  };
}

export function normalizeKanbanSettings(input: KanbanDesktopConfigFile): KanbanSettings {
  return {
    enabled: input.enabled === true,
    cloud: normalizeKanbanCloudConfig(isRecord(input.cloud) ? input.cloud : {})
  };
}

export function readJsonConfigFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function readKanbanSettings(app: App, platform: NodeJS.Platform = process.platform): KanbanSettings {
  const configPath = getKanbanConfigPath(app, platform);
  if (fs.existsSync(configPath)) {
    const raw = readJsonConfigFile(configPath);
    return normalizeKanbanSettings(isRecord(raw) ? raw : {});
  }

  const settings = normalizeKanbanSettings({});
  writeKanbanSettings(app, settings, platform);
  return settings;
}

export function readKanbanWsConfig(app: App): KanbanDesktopWsConfig | null {
  return resolveKanbanWsConnection(app).config;
}

export type KanbanConnectionFallbackState = Extract<KanbanDesktopConnectionState, "disabled" | "auth_required">;

export function resolveKanbanWsConnection(
  app: App,
  canUseDesktopSsoCredentials = true
): { config: KanbanDesktopWsConfig | null; fallbackState: KanbanConnectionFallbackState } {
  const settings = readKanbanSettings(app);
  const config = settings.cloud;
  const serverUrl = readText(process.env.DESKTOP_KANBAN_SERVER_URL) ||
    readText(config.serverUrl);
  const remoteControlEnabled = process.env.DESKTOP_KANBAN_REMOTE_CONTROL_ENABLED === "true" ||
    config.remoteControlEnabled;
  if (!settings.enabled || !remoteControlEnabled || !serverUrl) {
    return { config: null, fallbackState: "disabled" };
  }
  if (!canUseDesktopSsoCredentials) {
    return { config: null, fallbackState: "auth_required" };
  }
  const token = readDesktopSsoAccessToken(app);
  if (!token || !readDesktopSsoAccessTokenUser(app)) {
    return { config: null, fallbackState: "auth_required" };
  }
  return {
    config: {
      serverUrl,
      token,
      selectedProjectId: readText(process.env.DESKTOP_KANBAN_PROJECT_ID) ||
        DEFAULT_SELECTED_PROJECT_ID
    },
    fallbackState: "disabled"
  };
}

export function readKanbanCloudConfig(app: App): KanbanCloudConfig {
  return readKanbanSettings(app).cloud;
}

export function writeKanbanSettings(
  app: App,
  input: KanbanSettings,
  platform: NodeJS.Platform = process.platform
): KanbanSettings {
  const settings = normalizeKanbanSettings({
    enabled: input.enabled,
    cloud: input.cloud
  });
  const configPath = getKanbanConfigPath(app, platform);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    enabled: settings.enabled,
    cloud: settings.cloud
  }, null, 2)}\n`, "utf8");
  return settings;
}

export function saveKanbanSettings(
  app: App,
  input: KanbanSettingsInput,
  platform: NodeJS.Platform = process.platform
): KanbanSettings {
  const current = readKanbanSettings(app, platform);
  return writeKanbanSettings(app, {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    cloud: normalizeKanbanCloudConfig({
      ...current.cloud,
      ...(isRecord(input.cloud) ? input.cloud : {})
    })
  }, platform);
}

export function writeKanbanCloudConfig(app: App, input: KanbanDesktopConfigFile): KanbanCloudConfig {
  const configPath = getKanbanConfigPath(app);
  return saveKanbanSettings(app, {
    ...(fs.existsSync(configPath) ? {} : { enabled: true }),
    cloud: input as Partial<KanbanCloudConfig>
  }).cloud;
}

export function getKanbanDeviceInfo(app: App) {
  const deviceInfo = getDesktopDeviceInfo(app);
  const deviceName = deviceInfo.deviceName;
  return {
    deviceName,
    deviceAlias: deviceName,
    hostname: deviceInfo.hostname || undefined,
    username: deviceInfo.username || undefined
  };
}
