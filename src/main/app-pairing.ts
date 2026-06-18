import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import { issueIdentityCenterAccessToken, ensureIdentityCenterJwk } from "./identity-center-auth";
import { getDesktopDeviceIdentity } from "./device-identity";
import { readEnvFile } from "./env-file";
import { getService } from "./services/service-registry";
import { getServiceConfigRoot } from "./user-paths";

const IDENTITY_CENTER_SERVICE_ID = "identity-center";
const MAX_TCP_PORT = 65535;

export type AppPairingPayload = {
  desktopDeviceId: string;
  desktopIdentityCreatedAt: string;
  desktopUsername: string;
  desktopHostname: string;
  identityCenterIssuer: string;
  identityCenterPublicKeySha256: string;
  apiBaseUrl: string;
  pairingId: string;
  secret: string;
  expiresAt: string;
};

export type AppPairingPayloadResult =
  | { ok: true; payload: AppPairingPayload; payloadText: string }
  | { ok: false; message: string };

type FetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

function parsePortValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TCP_PORT ? parsed : 0;
}

export function resolveIdentityCenterPort(app: App) {
  const service = getService(IDENTITY_CENTER_SERVICE_ID);
  const envPath = path.join(getServiceConfigRoot(app, service.id, service.kind), ".env");
  const env = readEnvFile(envPath);
  return parsePortValue(env.get(service.web.portEnvKey) ?? "") || service.web.defaultPort;
}

function isPrivateIPv4(address: string) {
  if (/^10\./u.test(address) || /^192\.168\./u.test(address)) {
    return true;
  }
  const match172 = address.match(/^172\.(\d{1,2})\./u);
  if (!match172) {
    return false;
  }
  const second = Number.parseInt(match172[1] ?? "", 10);
  return second >= 16 && second <= 31;
}

export function selectPairingHost(interfaces = os.networkInterfaces()) {
  const candidates: string[] = [];
  for (const items of Object.values(interfaces)) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal && item.address) {
        candidates.push(item.address);
      }
    }
  }
  return candidates.find(isPrivateIPv4) ?? candidates[0] ?? "127.0.0.1";
}

function getDesktopUsername() {
  try {
    return os.userInfo().username || "";
  } catch {
    return "";
  }
}

function parseJSON(text: string) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key].trim() : "";
}

function normalizePairingPayload(raw: unknown, fallback: {
  desktopDeviceId: string;
  desktopIdentityCreatedAt: string;
  desktopUsername: string;
  desktopHostname: string;
  identityCenterPublicKeySha256: string;
  apiBaseUrl: string;
}): AppPairingPayload {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    desktopDeviceId: readString(record, "desktopDeviceId") || fallback.desktopDeviceId,
    desktopIdentityCreatedAt: readString(record, "desktopIdentityCreatedAt") || fallback.desktopIdentityCreatedAt,
    desktopUsername: readString(record, "desktopUsername") || fallback.desktopUsername,
    desktopHostname: readString(record, "desktopHostname") || fallback.desktopHostname,
    identityCenterIssuer: readString(record, "identityCenterIssuer"),
    identityCenterPublicKeySha256: readString(record, "identityCenterPublicKeySha256") || fallback.identityCenterPublicKeySha256,
    apiBaseUrl: readString(record, "apiBaseUrl") || fallback.apiBaseUrl,
    pairingId: readString(record, "pairingId"),
    secret: readString(record, "secret"),
    expiresAt: readString(record, "expiresAt")
  };
}

export async function createAppPairingPayload(
  app: App,
  fetchImpl: FetchLike = fetch
): Promise<AppPairingPayloadResult> {
  try {
    const identity = getDesktopDeviceIdentity(app);
    const port = resolveIdentityCenterPort(app);
    const loopbackBaseUrl = `http://127.0.0.1:${port}`;
    const apiBaseUrl = `http://${selectPairingHost()}:${port}`;
    const publicKey = await ensureIdentityCenterJwk(app);
    const publicKeySha256 = crypto.createHash("sha256").update(publicKey.publicKeyPem).digest("hex");
    const accessToken = await issueIdentityCenterAccessToken(app);
    const fallback = {
      desktopDeviceId: identity.deviceId,
      desktopIdentityCreatedAt: identity.createdAt,
      desktopUsername: getDesktopUsername(),
      desktopHostname: os.hostname() || "",
      identityCenterPublicKeySha256: publicKeySha256,
      apiBaseUrl
    };
    const response = await fetchImpl(`${loopbackBaseUrl}/api/auth/pairing/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(fallback)
    });
    const responseText = await response.text();
    const parsed = parseJSON(responseText);
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? readString(parsed as Record<string, unknown>, "error") || readString(parsed as Record<string, unknown>, "message")
        : String(parsed || "");
      return { ok: false, message: message || `app pairing failed: HTTP ${response.status}` };
    }
    const payload = normalizePairingPayload(parsed, fallback);
    if (!payload.pairingId || !payload.secret || !payload.apiBaseUrl) {
      return { ok: false, message: "app pairing response is missing required fields." };
    }
    return { ok: true, payload, payloadText: JSON.stringify(payload) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
