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
  refreshIdentityToken?: () => Promise<string>;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

let controllerOptions: TunnelHubRegistrationControllerOptions | null = null;

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
  let identityToken = canonicalToken;
  let { response, raw } = await requestRegistration(identityToken);
  if (response.status === 401 && !signal?.aborted && controllerOptions.refreshIdentityToken) {
    const refreshedIdentityToken = (await controllerOptions.refreshIdentityToken()).trim();
    if (refreshedIdentityToken) {
      identityToken = refreshedIdentityToken;
      ({ response, raw } = await requestRegistration(identityToken));
    }
  }
  if (!response.ok) {
    if (response.status === 405) {
      throw new Error(t("tunnelHub.registrationApiUnavailable"));
    }
    throw new Error(`Tunnel Hub registration failed (${response.status} ${response.statusText})`);
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
  parseRegistrationResponse
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
