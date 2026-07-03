import type { App } from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { t } from "./i18n/main-i18n";
import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  DesktopAppPairingPayloadResult,
  MobilePairingPayloadV2,
  TunnelHubRuntimeStatus
} from "../shared/contracts";
import {
  encodePairingPayloadV2,
  normalizeDesktopWsUrlInput
} from "../shared/desktop-ws-protocol";

export type AppPairingRuntimeOptions = {
  issueAccessToken?: (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  getTunnelHubRuntimeStatus?: () => TunnelHubRuntimeStatus;
};

type TokenClaims = {
  deviceId: string;
  expiresAtMs: number;
};

const PAIRING_TARGET_MODE = "tunnel";

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error(t("settings.mobilePairing.invalidToken"));
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(t("settings.mobilePairing.invalidToken"));
  }
}

function readPairingTokenClaims(token: string): TokenClaims {
  const payload = decodeJwtPayload(token);
  const scope = readText(payload.scope);
  if (scope !== "app") {
    throw new Error(t("settings.mobilePairing.invalidScope"));
  }

  const deviceId = readText(payload.device_id) || readText(payload.deviceId);
  if (!deviceId) {
    throw new Error(t("settings.mobilePairing.missingDeviceId"));
  }

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) {
    throw new Error(t("settings.mobilePairing.missingExpiration"));
  }

  const expiresAtMs = exp * 1000;
  if (expiresAtMs <= Date.now()) {
    throw new Error(t("settings.mobilePairing.expiredToken"));
  }

  return { deviceId, expiresAtMs };
}

function readConnectedTunnelWsUrl(options: AppPairingRuntimeOptions) {
  const status = options.getTunnelHubRuntimeStatus?.();
  if (!status?.enabled || !status.connected) {
    throw new Error(t("settings.mobilePairing.tunnelDisconnected"));
  }
  const normalizedTunnelUrl = normalizeDesktopWsUrlInput(status.webSocketUrl);
  if (!normalizedTunnelUrl) {
    throw new Error(t("settings.mobilePairing.tunnelUnavailable"));
  }
  return normalizedTunnelUrl;
}

export async function createAppPairingPayload(
  app: App,
  options: AppPairingRuntimeOptions = {}
): Promise<DesktopAppPairingPayloadResult> {
  try {
    const wsUrl = readConnectedTunnelWsUrl(options);
    const tokenResult = await (options.issueAccessToken ?? issueAgentAccessToken)(app, "missing");
    const token = readText(tokenResult.token);
    if (!tokenResult.ok || !token) {
      return { ok: false, message: tokenResult.message || t("settings.mobilePairing.tokenUnavailable") };
    }

    const claims = readPairingTokenClaims(token);
    const payload: MobilePairingPayloadV2 = {
      v: 2,
      kind: "desktop-ws",
      targetMode: PAIRING_TARGET_MODE,
      wsUrl,
      tokenMode: "query",
      token,
      expiresAtMs: claims.expiresAtMs,
      desktopDeviceId: claims.deviceId
    };

    return {
      ok: true,
      payload,
      payloadText: encodePairingPayloadV2(payload),
      display: {
        targetMode: PAIRING_TARGET_MODE,
        wsUrl,
        expiresAt: new Date(claims.expiresAtMs).toISOString()
      }
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
