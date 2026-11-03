import type { PlatformCredential } from "./client-endpoint";
import type { App } from "electron";
import {
  normalizeRelayUrl,
  readTunnelHubSettings,
  readTunnelHubRegistrationBearerToken,
  recordTunnelHubRegistrationResult
} from "./settings";
import { getDesktopDeviceInfo } from "../identity";
import { t } from "../../support/i18n/main-i18n";

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect?: "error";
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

type TunnelHubRegistrationResponse = {
  accountId?: unknown;
  deviceId?: unknown;
  relayUrl?: unknown;
  publicHost?: unknown;
  publicUrl?: unknown;
  webSocketUrl?: unknown;
};

type TunnelHubRegistrationControllerOptions = {
  fetch?: FetchLike;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

/** Hub refused the canonical Desktop credential; only Tunnel is affected, never Desktop sign-in. */
export class TunnelHubCredentialRejectedError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`Tunnel Hub rejected the Desktop credential (${status})${reason ? `: ${reason}` : ""}`);
    this.name = "TunnelHubCredentialRejectedError";
  }
}

let controllerOptions: TunnelHubRegistrationControllerOptions | null = null;

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Keep the Hub's verification category (signature, issuer, audience, expiry) diagnosable
// without echoing arbitrary bodies, which could contain credentials, into logs or UI.
function readRegistrationRejectionReason(raw: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return ""; }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const reason = [nested.code, nested.message, record.code, record.error, record.message, record.msg]
    .map(readText).find(Boolean) || "";
  return reason.replace(/[^\x20-\x7e\u4e00-\u9fff]+/gu, " ").replace(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu, "[redacted]").trim().slice(0, 160);
}

function parseRegistrationResponse(raw: string): TunnelHubRegistrationResponse {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as TunnelHubRegistrationResponse : {};
  } catch {
    return {};
  }
}

export function deriveTunnelHubRegistrationApiOrigin(relayUrl: string) {
  const parsed = new URL(normalizeRelayUrl(relayUrl));
  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else {
    throw new Error("Relay URL is invalid.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

export function configureTunnelHubRegistrationController(options: TunnelHubRegistrationControllerOptions) {
  controllerOptions = options;
}

export async function ensureTunnelHubRegistrationReady(app: App, signal?: AbortSignal) {
  const settings = readTunnelHubSettings(app);
  if (!settings.enabled) {
    return {
      ok: true,
      registered: false,
      skipped: true,
      identityToken: ""
    };
  }
  if (!controllerOptions) {
    throw new Error("Tunnel Hub registration controller is not configured.");
  }

  const canonicalToken = readTunnelHubRegistrationBearerToken(app);
  if (!canonicalToken) {
    return {
      ok: true,
      registered: false,
      skipped: false,
      identityToken: ""
    };
  }

  const deviceId = settings.deviceId;
  const deviceInfo = getDesktopDeviceInfo(app);
  const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
  const fetchImpl = controllerOptions.fetch ?? globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== "function") {
    throw new Error("current runtime does not provide fetch for Tunnel Hub registration.");
  }

  const requestRegistration = async (identityToken: string) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${origin}/api/desktop/devices/register`, {
      method: "POST",
      signal,
      headers: {
        "Authorization": `Bearer ${identityToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        deviceId,
        deviceName: deviceInfo.deviceName || deviceId
      })
    });
    return {
      response,
      raw: await response.text()
    };
  };
  // A Hub rejection never asks Identity to renew: Desktop already renews before expiry, and a
  // misconfigured Hub would turn every retry into another account-wide renewal.
  const identityToken = canonicalToken;
  const { response, raw } = await requestRegistration(identityToken);
  if (!response.ok) {
    if (response.status === 405) {
      throw new Error(t("tunnelHub.registrationApiUnavailable"));
    }
    const reason = readRegistrationRejectionReason(raw);
    if (response.status === 401 || response.status === 403) {
      throw new TunnelHubCredentialRejectedError(response.status, reason);
    }
    throw new Error(`Tunnel Hub registration failed (${response.status} ${response.statusText})${reason ? `: ${reason}` : ""}`);
  }
  const current = readTunnelHubSettings(app);
  if (signal?.aborted || identityToken !== readTunnelHubRegistrationBearerToken(app) || current.deviceId !== deviceId || current.relayUrl !== settings.relayUrl) {
    throw new Error("Tunnel registration superseded");
  }
  const data = parseRegistrationResponse(raw);
  if (!readText(data.accountId) || readText(data.deviceId) !== deviceId) {
    throw new Error("Tunnel Hub account or device identity mismatch");
  }
  const registrationRecord = {
    deviceId,
    relayUrl: readText(data.relayUrl) || settings.relayUrl
  };
  const publicHost = readText(data.publicHost);
  const publicUrl = readText(data.publicUrl);
  const webSocketUrl = readText(data.webSocketUrl);
  if (publicHost) {
    Object.assign(registrationRecord, { publicHost });
  }
  if (publicUrl) {
    Object.assign(registrationRecord, { publicUrl });
  }
  if (webSocketUrl) {
    Object.assign(registrationRecord, { webSocketUrl });
  }
  recordTunnelHubRegistrationResult(app, registrationRecord);
  controllerOptions.logger?.log?.(`[tunnel-hub] registered desktop device ${deviceId}`);
  return {
    ok: true,
    registered: true,
    skipped: false,
    identityToken
  };
}

export const __testInternals = {
  parseRegistrationResponse,
  readRegistrationRejectionReason
};

export async function updateTunnelPlatformCredential(
  app: App, tunnelSessionId: string, platformCredential: PlatformCredential, signal: AbortSignal
) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  requestSignal.throwIfAborted();
  const settings = readTunnelHubSettings(app);
  const token = readTunnelHubRegistrationBearerToken(app);
  const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
  const fetchImpl = controllerOptions?.fetch ?? globalThis.fetch as unknown as FetchLike;
  if (!token || !settings.deviceId) throw new Error("Desktop account unavailable");
  const response = await fetchImpl(`${origin}/api/desktop/devices/register`, {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: settings.deviceId, tunnelSessionId, platformCredential })
  });
  const body = await response.text();
  requestSignal.throwIfAborted();
  if (!response.ok) throw new Error(`Platform credential update rejected (${response.status})`);
  const updated = parseRegistrationResponse(body);
  if (readText(updated.deviceId) !== settings.deviceId || !readText(updated.accountId)) {
    throw new Error("Invalid Platform credential update receipt");
  }
  const current = readTunnelHubSettings(app);
  if (token !== readTunnelHubRegistrationBearerToken(app) ||
    settings.deviceId !== current.deviceId || settings.relayUrl !== current.relayUrl) {
    throw new Error("Platform credential update superseded");
  }
}
