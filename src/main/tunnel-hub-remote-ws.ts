import os from "node:os";
import type { App } from "electron";
import {
  DESKTOP_REMOTE_WS_PORT,
  DESKTOP_WS_HOST
} from "../shared/desktop-ws";
import {
  getDesktopRemoteWsServerRuntimeState,
  startDesktopRemoteWsServer,
  stopDesktopRemoteWsServer,
  type DesktopWsServerOptions
} from "./desktop-ws-server";
import {
  ensureTunnelHubDeviceId,
  readTunnelHubAgentTokenRotationRequest,
  readTunnelHubAgentSettings,
  readTunnelHubRegistrationBearerToken,
  recordTunnelHubRegistrationResult,
  syncTunnelHubAgentSettingsToEnv
} from "./tunnel-hub-agent-settings";

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
  targetUrl?: unknown;
  agentToken?: unknown;
};

type TunnelHubRemoteWsControllerOptions = {
  desktopWsServerOptions: DesktopWsServerOptions;
  fetch?: FetchLike;
  startRemoteWsServer?: typeof startDesktopRemoteWsServer;
  getRemoteWsServerRuntimeState?: typeof getDesktopRemoteWsServerRuntimeState;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

let controllerOptions: TunnelHubRemoteWsControllerOptions | null = null;

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
  const parsed = new URL(relayUrl);
  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else {
    throw new Error("Relay URL must use ws:// or wss://.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function getRemoteWsTargetUrl(
  readRuntimeState: typeof getDesktopRemoteWsServerRuntimeState = getDesktopRemoteWsServerRuntimeState
) {
  const state = readRuntimeState();
  return `http://${state.host || DESKTOP_WS_HOST}:${state.port || DESKTOP_REMOTE_WS_PORT}`;
}

export function configureTunnelHubRemoteWsController(options: TunnelHubRemoteWsControllerOptions) {
  controllerOptions = options;
}

export async function ensureTunnelHubRemoteWsReady(app: App) {
  const settings = readTunnelHubAgentSettings(app);
  if (!settings.enabled) {
    return {
      ok: true,
      registered: false,
      skipped: true,
      targetUrl: ""
    };
  }
  if (!controllerOptions) {
    throw new Error("Tunnel Hub remote WS controller is not configured.");
  }

  const startRemoteWsServer = controllerOptions.startRemoteWsServer ?? startDesktopRemoteWsServer;
  const readRemoteWsState = controllerOptions.getRemoteWsServerRuntimeState ?? getDesktopRemoteWsServerRuntimeState;
  await startRemoteWsServer(controllerOptions.desktopWsServerOptions);
  const targetUrl = getRemoteWsTargetUrl(readRemoteWsState);
  const registrationToken = readTunnelHubRegistrationBearerToken(app);
  if (!registrationToken) {
    syncTunnelHubAgentSettingsToEnv(app);
    return {
      ok: true,
      registered: false,
      skipped: false,
      targetUrl
    };
  }

  const deviceId = ensureTunnelHubDeviceId(app);
  const rotateToken = readTunnelHubAgentTokenRotationRequest(app) || settings.hasAgentToken === false;
  const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
  const fetchImpl = controllerOptions.fetch ?? globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== "function") {
    throw new Error("current runtime does not provide fetch for Tunnel Hub registration.");
  }

  const response = await fetchImpl(`${origin}/api/desktop/devices/register`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${registrationToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      deviceId,
      deviceName: os.hostname() || deviceId,
      targetUrl,
      rotateToken
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Tunnel Hub registration failed (${response.status} ${response.statusText}): ${raw}`);
  }
  const data = parseRegistrationResponse(raw);
  const registrationRecord = {
    deviceId: readText(data.deviceId) || deviceId,
    relayUrl: readText(data.relayUrl) || settings.relayUrl,
    targetUrl: readText(data.targetUrl) || targetUrl,
    agentToken: readText(data.agentToken)
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
  controllerOptions.logger?.log?.(`[tunnel-hub] registered desktop device ${deviceId} -> ${targetUrl}`);
  return {
    ok: true,
    registered: true,
    skipped: false,
    targetUrl
  };
}

export function stopTunnelHubRemoteWs() {
  return stopDesktopRemoteWsServer();
}

export const __testInternals = {
  parseRegistrationResponse,
  getRemoteWsTargetUrl
};
