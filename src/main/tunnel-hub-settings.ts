import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type {
  TunnelHubSettings,
  TunnelHubSettingsInput,
  TunnelHubSettingsResult
} from "../shared/contracts";
import {
  getDesktopConfigRoot,
  getDesktopSsoAccessTokenFilePath,
  getSecretsRoot
} from "./user-paths";
import { getDesktopDeviceId } from "./device-identity";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname,
} from "./tunnel-hub-url-policy";

const LEGACY_TUNNEL_SECRET_FILE_NAMES = [
  "tunnel-hub-registration-token",
  "tunnel-hub-token",
  "tunnel-hub-device-secret"
] as const;
const DEFAULT_RECONNECT_SECONDS = 3;
const MIN_RECONNECT_SECONDS = 1;
const MAX_RECONNECT_SECONDS = 3600;
const DEVICE_ID_MAX_LENGTH = 63;
const DEVICE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESERVED_DEVICE_IDS = new Set(["admin", "api", "www", "tunnel", "relay"]);

type StoredTunnelHubSettings = {
  enabled?: unknown;
  relayUrl?: unknown;
  deviceId?: unknown;
  publicHost?: unknown;
  publicUrl?: unknown;
  webSocketUrl?: unknown;
  lastRegisteredAt?: unknown;
  tlsInsecureSkipVerify?: unknown;
  reconnectSeconds?: unknown;
};

type WritableTunnelHubSettings = {
  enabled: boolean;
  relayUrl: string;
  deviceId?: string;
  publicHost?: string;
  lastRegisteredAt?: string;
  tlsInsecureSkipVerify: boolean;
  reconnectSeconds: number;
};

export type TunnelHubRegistrationRecord = {
  deviceId: string;
  relayUrl?: string;
  publicHost?: string;
  publicUrl?: string;
  webSocketUrl?: string;
  lastRegisteredAt?: string;
};

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getSettingsPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), "tunnel-hub.json");
}

function readStoredSettings(app: App, platform: NodeJS.Platform = process.platform): StoredTunnelHubSettings {
  const settingsPath = getSettingsPath(app, platform);
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as StoredTunnelHubSettings : {};
  } catch {
    return {};
  }
}

export function normalizeRelayUrl(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `wss://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol === "http:") {
      if (isTunnelHubLoopbackHostname(parsed.hostname)) {
        parsed.protocol = "ws:";
      }
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    if ((parsed.protocol === "ws:" || parsed.protocol === "wss:") && (!parsed.pathname || parsed.pathname === "/")) {
      parsed.pathname = "/tunnel";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function readStoredString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePublicHost(value: unknown) {
  const text = readStoredString(value);
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
    return parsed.host.toLowerCase();
  } catch {
    return text
      .replace(/^https?:\/\//iu, "")
      .replace(/^wss?:\/\//iu, "")
      .split("/")[0]
      .trim()
      .toLowerCase();
  }
}

function readStoredPublicHost(stored: StoredTunnelHubSettings) {
  return normalizePublicHost(stored.publicHost) ||
    normalizePublicHost(stored.publicUrl) ||
    normalizePublicHost(stored.webSocketUrl);
}

function publicUrlFromHost(publicHost: string) {
  return publicHost ? `https://${publicHost}` : "";
}

function webSocketUrlFromHost(publicHost: string) {
  return publicHost ? `wss://${publicHost}/ws` : "";
}

export function normalizeTunnelHubDeviceId(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidTunnelHubDeviceId(deviceId: string) {
  return Boolean(deviceId) &&
    deviceId.length <= DEVICE_ID_MAX_LENGTH &&
    DEVICE_ID_PATTERN.test(deviceId) &&
    !RESERVED_DEVICE_IDS.has(deviceId);
}

function slugifyDeviceId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, DEVICE_ID_MAX_LENGTH)
    .replace(/-+$/gu, "");
}

function createDefaultDeviceId(app: App) {
  const hostname = slugifyDeviceId(os.hostname());
  if (isValidTunnelHubDeviceId(hostname)) {
    return hostname;
  }
  const desktopId = getDesktopDeviceId(app).replace(/-/gu, "").slice(0, 12);
  return `desktop-${desktopId || crypto.randomBytes(6).toString("hex")}`.slice(0, DEVICE_ID_MAX_LENGTH);
}

function isValidRelayUrl(relayUrl: string) {
  try {
    const parsed = new URL(relayUrl);
    if (!parsed.host || isTunnelHubForbiddenHostname(parsed.hostname)) {
      return false;
    }
    if (parsed.protocol === "wss:") {
      return true;
    }
    return parsed.protocol === "ws:" && isTunnelHubLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeReconnectSeconds(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : DEFAULT_RECONNECT_SECONDS;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RECONNECT_SECONDS;
  }
  return Math.max(MIN_RECONNECT_SECONDS, Math.min(MAX_RECONNECT_SECONDS, Math.trunc(parsed)));
}

export function clearLegacyTunnelHubSecrets(app: App, platform: NodeJS.Platform = process.platform) {
  const secretsRoot = getSecretsRoot(app, platform);
  for (const fileName of LEGACY_TUNNEL_SECRET_FILE_NAMES) {
    writeSecretFile(path.join(secretsRoot, fileName), "");
  }
}

function readJwtExpiresAtMs(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    return 0;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { exp?: unknown };
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function readCanonicalDesktopSsoToken(app: App, platform: NodeJS.Platform = process.platform) {
  const tokenPath = getDesktopSsoAccessTokenFilePath(app, platform);
  if (!fs.existsSync(tokenPath)) {
    return "";
  }
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const expiresAtMs = readJwtExpiresAtMs(token);
    if (!token || (expiresAtMs > 0 && expiresAtMs <= Date.now())) {
      return "";
    }
    return token;
  } catch {
    return "";
  }
}

export function readTunnelHubRegistrationBearerToken(app: App, platform: NodeJS.Platform = process.platform) {
  return readCanonicalDesktopSsoToken(app, platform);
}

export function readTunnelHubSettings(
  app: App,
  platform: NodeJS.Platform = process.platform
): TunnelHubSettings {
  clearLegacyTunnelHubSecrets(app, platform);
  const stored = readStoredSettings(app, platform);
  const identityToken = readTunnelHubRegistrationBearerToken(app, platform);
  const relayUrl = normalizeRelayUrl(stored.relayUrl);
  const deviceId = normalizeTunnelHubDeviceId(stored.deviceId) || createDefaultDeviceId(app);
  const publicHost = readStoredPublicHost(stored);
  const complete = Boolean(identityToken) && isValidRelayUrl(relayUrl) && isValidTunnelHubDeviceId(deviceId);
  const enabled = typeof stored.enabled === "boolean"
    ? stored.enabled && complete
    : complete;
  return {
    enabled,
    relayUrl,
    deviceId,
    publicHost,
    publicUrl: publicUrlFromHost(publicHost),
    webSocketUrl: webSocketUrlFromHost(publicHost),
    lastRegisteredAt: readStoredString(stored.lastRegisteredAt) || undefined,
    tlsInsecureSkipVerify: false,
    reconnectSeconds: normalizeReconnectSeconds(stored.reconnectSeconds)
  };
}

export function validateTunnelHubSettingsInput(input: TunnelHubSettingsInput) {
  const issues: string[] = [];
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    issues.push("enabled must be boolean.");
  }
  if (input.enabled === true || relayUrl) {
    if (!isValidRelayUrl(relayUrl)) {
      issues.push("Relay URL is invalid.");
    }
  }
  if (input.deviceId !== undefined) {
    const deviceId = normalizeTunnelHubDeviceId(input.deviceId);
    if (!isValidTunnelHubDeviceId(deviceId)) {
      issues.push("Device ID must be a lowercase DNS label up to 63 characters.");
    }
  }

  const reconnectSeconds = normalizeReconnectSeconds(input.reconnectSeconds);
  if (
    input.reconnectSeconds !== undefined &&
    (!Number.isFinite(Number(input.reconnectSeconds)) ||
      Number(input.reconnectSeconds) < MIN_RECONNECT_SECONDS ||
      Number(input.reconnectSeconds) > MAX_RECONNECT_SECONDS)
  ) {
    issues.push(`Reconnect seconds must be between ${MIN_RECONNECT_SECONDS} and ${MAX_RECONNECT_SECONDS}.`);
  }

  return {
    valid: issues.length === 0,
    issues,
    settings: {
      enabled: input.enabled === true,
      relayUrl,
      deviceId: normalizeTunnelHubDeviceId(input.deviceId),
      tlsInsecureSkipVerify: false,
      reconnectSeconds
    }
  };
}

function writeStoredSettings(
  app: App,
  settings: WritableTunnelHubSettings,
  platform: NodeJS.Platform = process.platform
) {
  const settingsPath = getSettingsPath(app, platform);
  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function writeSecretFile(secretPath: string, token: string) {
  if (!token) {
    try {
      fs.rmSync(secretPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return;
  }
  ensureDir(path.dirname(secretPath));
  fs.writeFileSync(secretPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    // Windows does not honor POSIX file modes.
  }
}

export function saveTunnelHubSettings(
  app: App,
  input: TunnelHubSettingsInput,
  platform: NodeJS.Platform = process.platform
): TunnelHubSettingsResult {
  clearLegacyTunnelHubSecrets(app, platform);
  const current = readTunnelHubSettings(app, platform);
  const relayUrl = "relayUrl" in input ? normalizeRelayUrl(input.relayUrl) : current.relayUrl;
  const deviceId = "deviceId" in input && normalizeTunnelHubDeviceId(input.deviceId)
    ? normalizeTunnelHubDeviceId(input.deviceId)
    : current.deviceId || createDefaultDeviceId(app);
  const reconnectSeconds = normalizeReconnectSeconds(input.reconnectSeconds ?? current.reconnectSeconds);
  const requestedEnabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const identityToken = readTunnelHubRegistrationBearerToken(app, platform);
  const issues: string[] = [];
  if (!isValidTunnelHubDeviceId(deviceId)) {
    issues.push("Device ID must be a lowercase DNS label up to 63 characters.");
  }
  if (requestedEnabled) {
    if (!isValidRelayUrl(relayUrl)) {
      issues.push("Relay URL is invalid.");
    }
    if (!identityToken) {
      issues.push("Sign in before enabling Tunnel Hub.");
    }
  }

  const deviceIdChanged = deviceId !== current.deviceId;
  const nextSettings = {
    enabled: requestedEnabled && issues.length === 0,
    relayUrl,
    deviceId,
    publicHost: deviceIdChanged ? "" : current.publicHost,
    lastRegisteredAt: deviceIdChanged ? "" : current.lastRegisteredAt,
    tlsInsecureSkipVerify: false,
    reconnectSeconds
  };
  writeStoredSettings(app, nextSettings, platform);

  if (issues.length > 0) {
    return {
      ok: false,
      message: issues.join(" "),
      settings: readTunnelHubSettings(app),
      configPath: getSettingsPath(app)
    };
  }
  return {
    ok: true,
    message: nextSettings.enabled ? "Tunnel Hub settings saved and enabled." : "Tunnel Hub settings saved.",
    settings: readTunnelHubSettings(app),
    configPath: getSettingsPath(app)
  };
}

export function ensureTunnelHubDeviceId(app: App) {
  const stored = readStoredSettings(app);
  const current = normalizeTunnelHubDeviceId(stored.deviceId);
  if (isValidTunnelHubDeviceId(current)) {
    return current;
  }
  const currentSettings = readTunnelHubSettings(app);
  const deviceId = currentSettings.deviceId || createDefaultDeviceId(app);
  writeStoredSettings(app, {
    enabled: currentSettings.enabled,
    relayUrl: currentSettings.relayUrl,
    deviceId,
    publicHost: currentSettings.publicHost,
    lastRegisteredAt: currentSettings.lastRegisteredAt,
    tlsInsecureSkipVerify: false,
    reconnectSeconds: currentSettings.reconnectSeconds
  });
  return deviceId;
}

export function recordTunnelHubRegistrationResult(app: App, record: TunnelHubRegistrationRecord) {
  const current = readTunnelHubSettings(app);
  const deviceId = normalizeTunnelHubDeviceId(record.deviceId) || current.deviceId || createDefaultDeviceId(app);
  const publicHost = normalizePublicHost(record.publicHost) ||
    normalizePublicHost(record.publicUrl) ||
    normalizePublicHost(record.webSocketUrl) ||
    current.publicHost;
  const nextSettings = {
    enabled: current.enabled,
    relayUrl: normalizeRelayUrl(record.relayUrl ?? current.relayUrl),
    deviceId,
    publicHost,
    lastRegisteredAt: record.lastRegisteredAt?.trim() || new Date().toISOString(),
    tlsInsecureSkipVerify: false,
    reconnectSeconds: current.reconnectSeconds
  };
  writeStoredSettings(app, nextSettings);
  return readTunnelHubSettings(app);
}
