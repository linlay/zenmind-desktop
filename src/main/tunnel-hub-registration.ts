import type { App } from "electron";
import {
  ensureTunnelHubDeviceId,
  normalizeRelayUrl,
  readTunnelHubSettings,
  readTunnelHubRegistrationBearerToken,
  recordTunnelHubRegistrationResult
} from "./tunnel-hub-settings";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { t } from "./i18n/main-i18n";

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

type TunnelHubRegistrationResponse = {
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

export async function ensureTunnelHubRegistrationReady(app: App) {
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

  const deviceId = ensureTunnelHubDeviceId(app);
  const deviceInfo = getDesktopDeviceInfo(app);
  const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
  const fetchImpl = controllerOptions.fetch ?? globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== "function") {
    throw new Error("current runtime does not provide fetch for Tunnel Hub registration.");
  }

  const requestRegistration = async (identityToken: string) => {
    const response = await fetchImpl(`${origin}/api/desktop/devices/register`, {
      method: "POST",
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
  if (response.status === 401 && controllerOptions.refreshIdentityToken) {
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
    throw new Error(`Tunnel Hub registration failed (${response.status} ${response.statusText}): ${raw}`);
  }
  const data = parseRegistrationResponse(raw);
  const registrationRecord = {
    deviceId: readText(data.deviceId) || deviceId,
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
