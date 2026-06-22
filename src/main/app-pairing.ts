import os from "node:os";
import type { App } from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { readTunnelHubSettings } from "./tunnel-hub-settings";
import { t } from "./i18n/main-i18n";
import type {
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  DesktopAppPairingPayloadRequest,
  DesktopAppPairingPayloadResult,
  DesktopWsServerStartOptions,
  DesktopWsServerState,
  MobilePairingPayloadV2,
  PairingTargetMode
} from "../shared/contracts";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_LAN_BIND_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT
} from "../shared/desktop-ws";
import {
  encodePairingPayloadV2,
  normalizeDesktopWsUrlInput
} from "../shared/desktop-ws-protocol";

const MAX_TCP_PORT = 65535;
const DEFAULT_TARGET_MODE: PairingTargetMode = "local";

export type AppPairingRuntimeState = Omit<DesktopWsServerState, "enabled" | "message">;

export type AppPairingRuntimeOptions = {
  issueAccessToken?: (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  getDesktopWsServerRuntimeState?: () => AppPairingRuntimeState;
  startDesktopWsServer?: (options?: DesktopWsServerStartOptions) => Promise<AppPairingRuntimeState>;
};

type TokenClaims = {
  deviceId: string;
  expiresAtMs: number;
};

type PairingTargetPreflight =
  | { targetMode: "local" }
  | { targetMode: "lan"; host: string }
  | { targetMode: "tunnel"; wsUrl: string };

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTargetMode(value: unknown): PairingTargetMode {
  return value === "lan" || value === "tunnel" || value === "local" ? value : DEFAULT_TARGET_MODE;
}

function normalizePort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : DESKTOP_WS_PORT;
}

function normalizePath(value: unknown) {
  const pathname = readText(value);
  return pathname.startsWith("/") ? pathname : DESKTOP_WS_PATH;
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

function listExternalIPv4(interfaces = os.networkInterfaces()) {
  const addresses: string[] = [];
  for (const items of Object.values(interfaces)) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal && item.address) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

function selectLanPairingHost(interfaces = os.networkInterfaces()) {
  return listExternalIPv4(interfaces).find(isPrivateIPv4) ?? "";
}

function preflightPairingTarget(app: App, targetMode: PairingTargetMode): PairingTargetPreflight {
  if (targetMode === "lan") {
    const host = selectLanPairingHost();
    if (!host) {
      throw new Error(t("settings.mobilePairing.lanUnavailable"));
    }
    return { targetMode, host };
  }

  if (targetMode === "tunnel") {
    const wsUrl = readTunnelHubSettings(app).webSocketUrl.trim();
    if (!wsUrl) {
      throw new Error(t("settings.mobilePairing.tunnelUnavailable"));
    }
    return { targetMode, wsUrl };
  }

  return { targetMode: "local" };
}

async function ensureDesktopWsRuntime(
  target: PairingTargetPreflight,
  options: AppPairingRuntimeOptions
): Promise<AppPairingRuntimeState> {
  const startOptions = target.targetMode === "lan" ? { host: DESKTOP_WS_LAN_BIND_HOST } : undefined;
  if (!startOptions) {
    const current = options.getDesktopWsServerRuntimeState?.();
    if (current?.running) {
      return current;
    }
  }
  if (!options.startDesktopWsServer) {
    throw new Error(t("settings.mobilePairing.serverUnavailable"));
  }
  const next = await options.startDesktopWsServer(startOptions);
  if (!next.running) {
    throw new Error(t("settings.mobilePairing.serverUnavailable"));
  }
  return next;
}

function buildWsUrl(target: PairingTargetPreflight, runtimeState: AppPairingRuntimeState) {
  const port = normalizePort(runtimeState.port);
  const pathname = normalizePath(runtimeState.path);

  if (target.targetMode === "local") {
    return `ws://${DESKTOP_WS_HOST}:${port}${pathname}`;
  }

  if (target.targetMode === "lan") {
    return `ws://${target.host}:${port}${pathname}`;
  }

  const normalizedTunnelUrl = normalizeDesktopWsUrlInput(target.wsUrl);
  if (!normalizedTunnelUrl) {
    throw new Error(t("settings.mobilePairing.tunnelUnavailable"));
  }
  return normalizedTunnelUrl;
}

export async function createAppPairingPayload(
  app: App,
  request: DesktopAppPairingPayloadRequest = {},
  options: AppPairingRuntimeOptions = {}
): Promise<DesktopAppPairingPayloadResult> {
  try {
    const targetMode = normalizeTargetMode(request?.targetMode);
    const target = preflightPairingTarget(app, targetMode);
    const runtimeState = await ensureDesktopWsRuntime(target, options);
    const tokenResult = await (options.issueAccessToken ?? issueAgentAccessToken)(app, "missing");
    const token = readText(tokenResult.token);
    if (!tokenResult.ok || !token) {
      return { ok: false, message: tokenResult.message || t("settings.mobilePairing.tokenUnavailable") };
    }

    const claims = readPairingTokenClaims(token);
    const wsUrl = buildWsUrl(target, runtimeState);
    const payload: MobilePairingPayloadV2 = {
      v: 2,
      kind: "desktop-ws",
      targetMode,
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
        targetMode,
        wsUrl,
        expiresAt: new Date(claims.expiresAtMs).toISOString()
      }
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
