import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  TunnelHubAgentSettings,
  TunnelHubAgentSettingsInput,
  TunnelHubAgentSettingsResult
} from "../shared/contracts";
import { readEnvFile } from "./env-file";
import { getDesktopConfigRoot, getSecretsRoot, getServiceConfigRoot } from "./user-paths";
import { writeEnvFileUpdates } from "./services/manager/env-content";

export const TUNNEL_HUB_AGENT_SERVICE_ID = "tunnel-hub-agent";
export const DEFAULT_TUNNEL_HUB_AGENT_RELAY_URL = "wss://tunnel-hub.zenmind.cc/tunnel";
const DEFAULT_RECONNECT_SECONDS = 3;
const MIN_RECONNECT_SECONDS = 1;
const MAX_RECONNECT_SECONDS = 3600;

type StoredTunnelHubAgentSettings = {
  relayUrl?: unknown;
  tlsInsecureSkipVerify?: unknown;
  reconnectSeconds?: unknown;
};

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getSettingsPath(app: App) {
  return path.join(getDesktopConfigRoot(app), "tunnel-hub-agent.json");
}

function getTokenPath(app: App) {
  return path.join(getSecretsRoot(app), "tunnel-hub-agent-token");
}

function getEnvPath(app: App) {
  return path.join(getServiceConfigRoot(app, TUNNEL_HUB_AGENT_SERVICE_ID, "builtin"), ".env");
}

function readStoredSettings(app: App): StoredTunnelHubAgentSettings {
  const settingsPath = getSettingsPath(app);
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as StoredTunnelHubAgentSettings : {};
  } catch {
    return {};
  }
}

function normalizeRelayUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || DEFAULT_TUNNEL_HUB_AGENT_RELAY_URL;
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

function readTokenFile(app: App) {
  const tokenPath = getTokenPath(app);
  if (!fs.existsSync(tokenPath)) {
    return "";
  }
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function readEnvAgentToken(app: App) {
  const envPath = getEnvPath(app);
  if (!fs.existsSync(envPath)) {
    return "";
  }
  try {
    return readEnvFile(envPath).get("AGENT_TOKEN")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function readTunnelHubAgentToken(app: App) {
  return readTokenFile(app) || readEnvAgentToken(app);
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

export function readTunnelHubAgentSettings(app: App): TunnelHubAgentSettings {
  const stored = readStoredSettings(app);
  const token = readTunnelHubAgentToken(app);
  return {
    relayUrl: normalizeRelayUrl(stored.relayUrl),
    hasAgentToken: Boolean(token),
    agentTokenPreview: previewToken(token),
    tlsInsecureSkipVerify: stored.tlsInsecureSkipVerify === true,
    reconnectSeconds: normalizeReconnectSeconds(stored.reconnectSeconds)
  };
}

export function validateTunnelHubAgentSettingsInput(input: TunnelHubAgentSettingsInput) {
  const issues: string[] = [];
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      issues.push("Relay URL must use ws:// or wss://.");
    }
  } catch {
    issues.push("Relay URL is invalid.");
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
      relayUrl,
      tlsInsecureSkipVerify: input.tlsInsecureSkipVerify === true,
      reconnectSeconds
    }
  };
}

function writeStoredSettings(app: App, settings: Pick<TunnelHubAgentSettings, "relayUrl" | "tlsInsecureSkipVerify" | "reconnectSeconds">) {
  const settingsPath = getSettingsPath(app);
  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function writeToken(app: App, token: string) {
  const tokenPath = getTokenPath(app);
  if (!token) {
    try {
      fs.rmSync(tokenPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return;
  }
  ensureDir(path.dirname(tokenPath));
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Windows does not honor POSIX file modes.
  }
}

export function syncTunnelHubAgentSettingsToEnv(app: App) {
  const settings = readTunnelHubAgentSettings(app);
  const token = readTunnelHubAgentToken(app);
  const updates = new Map<string, string>([
    ["AGENT_TOKEN", token],
    ["AGENT_RELAY_URL", settings.relayUrl],
    ["AGENT_TLS_INSECURE_SKIP_VERIFY", settings.tlsInsecureSkipVerify ? "true" : "false"],
    ["AGENT_RECONNECT_SECONDS", String(settings.reconnectSeconds)]
  ]);
  writeEnvFileUpdates(getEnvPath(app), updates);
}

export function saveTunnelHubAgentSettings(
  app: App,
  input: TunnelHubAgentSettingsInput
): TunnelHubAgentSettingsResult {
  const validation = validateTunnelHubAgentSettingsInput(input);
  if (!validation.valid) {
    return {
      ok: false,
      message: validation.issues.join(" "),
      settings: readTunnelHubAgentSettings(app),
      configPath: getSettingsPath(app)
    };
  }

  const nextSettings = {
    relayUrl: validation.settings.relayUrl,
    tlsInsecureSkipVerify: validation.settings.tlsInsecureSkipVerify,
    reconnectSeconds: validation.settings.reconnectSeconds
  };
  writeStoredSettings(app, nextSettings);

  if (input.clearAgentToken === true) {
    writeToken(app, "");
  } else if (typeof input.agentToken === "string") {
    const token = input.agentToken.trim();
    if (token) {
      writeToken(app, token);
    }
  }

  syncTunnelHubAgentSettingsToEnv(app);
  return {
    ok: true,
    message: "Tunnel Hub Agent settings saved.",
    settings: readTunnelHubAgentSettings(app),
    configPath: getSettingsPath(app)
  };
}
