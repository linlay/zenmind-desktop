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
import { getDesktopConfigRoot, getSecretsRoot } from "./user-paths";
import { getDesktopDeviceId } from "./device-identity";

const SSO_SITE_TOKEN_FILE_NAME = "sso-site-token.json";
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
  targetUrl?: unknown;
  lastRegisteredAt?: unknown;
  rotateRelayToken?: unknown;
  tlsInsecureSkipVerify?: unknown;
  reconnectSeconds?: unknown;
};

type WritableTunnelHubSettings = {
  enabled: boolean;
  relayUrl: string;
  deviceId?: string;
  publicHost?: string;
  publicUrl?: string;
  webSocketUrl?: string;
  targetUrl?: string;
  lastRegisteredAt?: string;
  rotateRelayToken?: boolean;
  tlsInsecureSkipVerify: boolean;
  reconnectSeconds: number;
};

export type TunnelHubRegistrationRecord = {
  deviceId: string;
  relayUrl?: string;
  publicHost?: string;
  publicUrl?: string;
  webSocketUrl?: string;
  targetUrl: string;
  relayToken?: string;
  lastRegisteredAt?: string;
};

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getSettingsPath(app: App) {
  return path.join(getDesktopConfigRoot(app), "tunnel-hub.json");
}

function getTokenPath(app: App) {
  return path.join(getSecretsRoot(app), "tunnel-hub-token");
}

function getRegistrationTokenPath(app: App) {
  return path.join(getSecretsRoot(app), "tunnel-hub-registration-token");
}

function getSsoSiteTokenPath(app: App) {
  return path.join(getSecretsRoot(app), SSO_SITE_TOKEN_FILE_NAME);
}

function getDeviceSecretPath(app: App) {
  return path.join(getSecretsRoot(app), "tunnel-hub-device-secret");
}

function readStoredSettings(app: App): StoredTunnelHubSettings {
  const settingsPath = getSettingsPath(app);
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

function normalizeRelayUrl(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStoredString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
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

function readSecretFile(secretPath: string) {
  if (!fs.existsSync(secretPath)) {
    return "";
  }
  try {
    return fs.readFileSync(secretPath, "utf8").trim();
  } catch {
    return "";
  }
}

function readTokenFile(app: App) {
  return readSecretFile(getTokenPath(app));
}

export function readTunnelHubRelayToken(app: App) {
  return readTokenFile(app);
}

export function readTunnelHubRegistrationToken(app: App) {
  return readSecretFile(getRegistrationTokenPath(app));
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

function readSsoSiteToken(app: App) {
  const siteTokenPath = getSsoSiteTokenPath(app);
  if (!fs.existsSync(siteTokenPath)) {
    return "";
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(siteTokenPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }
    const record = parsed as Record<string, unknown>;
    const token = typeof record.accessToken === "string"
      ? record.accessToken.trim()
      : typeof record.access_token === "string"
        ? record.access_token.trim()
        : "";
    const expiresAtMs = readJwtExpiresAtMs(token);
    if (!token || (expiresAtMs > 0 && expiresAtMs <= Date.now())) {
      return "";
    }
    return token;
  } catch {
    return "";
  }
}

export function readTunnelHubRegistrationBearerToken(app: App) {
  return readSsoSiteToken(app) || readTunnelHubRegistrationToken(app);
}

export function ensureTunnelHubDeviceSecret(app: App) {
  const current = readSecretFile(getDeviceSecretPath(app));
  if (current) {
    return current;
  }
  const deviceSecret = crypto.randomBytes(32).toString("base64url");
  writeSecretFile(getDeviceSecretPath(app), deviceSecret);
  return deviceSecret;
}

function previewToken(token: string) {
  if (!token) {
    return "";
  }
  if (token.length <= 4) {
    return "****";
  }
  return `****${token.slice(-4)}`;
}

export function readTunnelHubSettings(app: App): TunnelHubSettings {
  const stored = readStoredSettings(app);
  const token = readTunnelHubRelayToken(app);
  const registrationToken = readTunnelHubRegistrationBearerToken(app);
  const relayUrl = normalizeRelayUrl(stored.relayUrl);
  const deviceId = normalizeTunnelHubDeviceId(stored.deviceId) || createDefaultDeviceId(app);
  const complete = Boolean(token || registrationToken) && isValidRelayUrl(relayUrl) && isValidTunnelHubDeviceId(deviceId);
  const enabled = typeof stored.enabled === "boolean"
    ? stored.enabled && complete
    : complete;
  return {
    enabled,
    relayUrl,
    deviceId,
    hasRelayToken: Boolean(token),
    relayTokenPreview: previewToken(token),
    hasRegistrationToken: Boolean(registrationToken),
    registrationTokenPreview: previewToken(registrationToken),
    publicHost: readStoredString(stored.publicHost),
    publicUrl: readStoredString(stored.publicUrl),
    webSocketUrl: readStoredString(stored.webSocketUrl),
    targetUrl: readStoredString(stored.targetUrl),
    lastRegisteredAt: readStoredString(stored.lastRegisteredAt) || undefined,
    tlsInsecureSkipVerify: stored.tlsInsecureSkipVerify === true,
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
      issues.push(relayUrl ? "Relay URL must use ws:// or wss://." : "Relay URL is invalid.");
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
      tlsInsecureSkipVerify: input.tlsInsecureSkipVerify === true,
      reconnectSeconds
    }
  };
}

function writeStoredSettings(
  app: App,
  settings: WritableTunnelHubSettings
) {
  const settingsPath = getSettingsPath(app);
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

function writeToken(app: App, token: string) {
  writeSecretFile(getTokenPath(app), token);
}

function writeRegistrationToken(app: App, token: string) {
  writeSecretFile(getRegistrationTokenPath(app), token);
}

export function writeTunnelHubRelayToken(app: App, token: string) {
  writeToken(app, token.trim());
}

export function saveTunnelHubSettings(
  app: App,
  input: TunnelHubSettingsInput
): TunnelHubSettingsResult {
  const current = readTunnelHubSettings(app);
  const relayUrl = "relayUrl" in input ? normalizeRelayUrl(input.relayUrl) : current.relayUrl;
  const deviceId = "deviceId" in input && normalizeTunnelHubDeviceId(input.deviceId)
    ? normalizeTunnelHubDeviceId(input.deviceId)
    : current.deviceId || createDefaultDeviceId(app);
  const reconnectSeconds = normalizeReconnectSeconds(input.reconnectSeconds ?? current.reconnectSeconds);
  const tlsInsecureSkipVerify = typeof input.tlsInsecureSkipVerify === "boolean"
    ? input.tlsInsecureSkipVerify
    : current.tlsInsecureSkipVerify;
  const requestedEnabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
  const nextToken = input.clearRelayToken === true
    ? ""
    : typeof input.relayToken === "string" && input.relayToken.trim()
      ? input.relayToken.trim()
      : readTunnelHubRelayToken(app);
  const nextRegistrationToken = input.clearRegistrationToken === true
    ? ""
    : typeof input.registrationToken === "string" && input.registrationToken.trim()
      ? input.registrationToken.trim()
      : readTunnelHubRegistrationToken(app);
  const availableRegistrationToken = nextRegistrationToken || readSsoSiteToken(app);
  const issues: string[] = [];
  if (!isValidTunnelHubDeviceId(deviceId)) {
    issues.push("Device ID must be a lowercase DNS label up to 63 characters.");
  }
  if (requestedEnabled) {
    if (!isValidRelayUrl(relayUrl)) {
      issues.push(relayUrl ? "Relay URL must use ws:// or wss://." : "Relay URL is invalid.");
    }
    if (!nextToken && !availableRegistrationToken) {
      issues.push("Registration token or relay token is required.");
    }
  }

  const deviceIdChanged = deviceId !== current.deviceId;
  const nextSettings = {
    enabled: requestedEnabled && issues.length === 0,
    relayUrl,
    deviceId,
    publicHost: deviceIdChanged ? "" : current.publicHost,
    publicUrl: deviceIdChanged ? "" : current.publicUrl,
    webSocketUrl: deviceIdChanged ? "" : current.webSocketUrl,
    targetUrl: deviceIdChanged ? "" : current.targetUrl,
    lastRegisteredAt: deviceIdChanged ? "" : current.lastRegisteredAt,
    rotateRelayToken: input.rotateRelayToken === true,
    tlsInsecureSkipVerify,
    reconnectSeconds
  };
  writeStoredSettings(app, nextSettings);

  if (input.clearRelayToken === true) {
    writeToken(app, "");
  } else if (typeof input.relayToken === "string") {
    const token = input.relayToken.trim();
    if (token) {
      writeToken(app, token);
    }
  }
  if (input.clearRegistrationToken === true) {
    writeRegistrationToken(app, "");
  } else if (typeof input.registrationToken === "string") {
    const token = input.registrationToken.trim();
    if (token) {
      writeRegistrationToken(app, token);
    }
  }
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
    publicUrl: currentSettings.publicUrl,
    webSocketUrl: currentSettings.webSocketUrl,
    targetUrl: currentSettings.targetUrl,
    lastRegisteredAt: currentSettings.lastRegisteredAt,
    rotateRelayToken: readStoredSettings(app).rotateRelayToken === true,
    tlsInsecureSkipVerify: currentSettings.tlsInsecureSkipVerify,
    reconnectSeconds: currentSettings.reconnectSeconds
  });
  return deviceId;
}

export function readTunnelHubRelayTokenRotationRequest(app: App) {
  return readStoredSettings(app).rotateRelayToken === true;
}

export function recordTunnelHubRegistrationResult(app: App, record: TunnelHubRegistrationRecord) {
  const current = readTunnelHubSettings(app);
  const deviceId = normalizeTunnelHubDeviceId(record.deviceId) || current.deviceId || createDefaultDeviceId(app);
  const nextSettings = {
    enabled: current.enabled,
    relayUrl: normalizeRelayUrl(record.relayUrl ?? current.relayUrl),
    deviceId,
    publicHost: record.publicHost?.trim() ?? current.publicHost,
    publicUrl: record.publicUrl?.trim() ?? current.publicUrl,
    webSocketUrl: record.webSocketUrl?.trim() ?? current.webSocketUrl,
    targetUrl: record.targetUrl.trim(),
    lastRegisteredAt: record.lastRegisteredAt?.trim() || new Date().toISOString(),
    rotateRelayToken: false,
    tlsInsecureSkipVerify: current.tlsInsecureSkipVerify,
    reconnectSeconds: current.reconnectSeconds
  };
  writeStoredSettings(app, nextSettings);
  if (record.relayToken?.trim()) {
    writeToken(app, record.relayToken.trim());
  }
  return readTunnelHubSettings(app);
}
