import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../shared/contracts";
import type { ServiceDefinition } from "./manifest-utils";
import { getService } from "./service-registry";
import { getInstallDir } from "./service-manager";
import { readEnvFile } from "./env-file";
import { upsertChannel, removeChannel, type ChannelEntry } from "./agent-platform-channels";
import { getServiceConfigRoot } from "./user-paths";

const AGENT_PLATFORM_ID = "agent-platform";
const BRIDGE_HTTP_ADDR_DEFAULT = ":11970";
const GATEWAY_INFO_RETRIES = 5;
const GATEWAY_INFO_RETRY_DELAY_MS = 2000;

interface BridgeRegistrationState {
  registered: boolean;
  channelId: string | null;
  channelName: string | null;
  lastError: string | null;
}

const bridgeRegistrationStates = new Map<ServiceId, BridgeRegistrationState>();

function updateBridgeRegistrationState(
  serviceId: ServiceId,
  update: Partial<BridgeRegistrationState>
) {
  const existing = bridgeRegistrationStates.get(serviceId) ?? {
    registered: false,
    channelId: null,
    channelName: null,
    lastError: null
  };
  bridgeRegistrationStates.set(serviceId, { ...existing, ...update });
}

export function getBridgeRegistrationState(serviceId: ServiceId): BridgeRegistrationState {
  return bridgeRegistrationStates.get(serviceId) ?? {
    registered: false,
    channelId: null,
    channelName: null,
    lastError: null
  };
}

interface GatewayInfo {
  id: string;
  channel: string;
  url: string;
  token: string;
  baseUrl: string;
}

function getBridgeHttpAddr(app: App, service: ServiceDefinition, _bridgeInstallDir: string): string {
  const envPath = path.join(getServiceConfigRoot(app, service.id, service.kind), ".env");
  const env = readEnvFile(envPath);
  return env.get("BRIDGE_HTTP_ADDR") ?? BRIDGE_HTTP_ADDR_DEFAULT;
}

function parseBridgeAddr(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  if (trimmed.startsWith(":")) {
    return { host: "127.0.0.1", port: Number.parseInt(trimmed.slice(1), 10) || 11970 };
  }
  if (trimmed.includes(":")) {
    const lastColonIndex = trimmed.lastIndexOf(":");
    return {
      host: trimmed.slice(0, lastColonIndex) || "127.0.0.1",
      port: Number.parseInt(trimmed.slice(lastColonIndex + 1), 10) || 11970
    };
  }
  return { host: "127.0.0.1", port: Number.parseInt(trimmed, 10) || 11970 };
}

async function fetchGatewayInfoWithRetry(addr: string, endpoint: string): Promise<GatewayInfo> {
  const { host, port } = parseBridgeAddr(addr);
  const url = `http://${host}:${port}${endpoint}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= GATEWAY_INFO_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json() as GatewayInfo;
        return data;
      }
      lastError = new Error(`HTTP ${response.status}`);
      console.warn(`[bridge-registrar] ${url} attempt ${attempt}/${GATEWAY_INFO_RETRIES}: HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
      const reason = err instanceof Error ? `${err.name}: ${err.message}${(err as { cause?: unknown }).cause ? ` (cause: ${String((err as { cause?: unknown }).cause)})` : ""}` : String(err);
      console.warn(`[bridge-registrar] ${url} attempt ${attempt}/${GATEWAY_INFO_RETRIES}: ${reason}`);
    }

    if (attempt < GATEWAY_INFO_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_INFO_RETRY_DELAY_MS));
    }
  }

  const reason = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
  throw new Error(`Failed to fetch gateway info from ${url} after ${GATEWAY_INFO_RETRIES} attempts (last error: ${reason})`);
}

function isBridgeService(service: ServiceDefinition): boolean {
  return service.kind === "plugin" && service.desktop?.bridge?.category === "bridge";
}

function getAgentPlatformInstallDir(app: App): string | null {
  try {
    const agentPlatform = getService(AGENT_PLATFORM_ID);
    return getServiceConfigRoot(app, agentPlatform.id, agentPlatform.kind);
  } catch {
    return null;
  }
}

export async function registerBridge(app: App, serviceId: ServiceId): Promise<{ ok: boolean; message: string }> {
  let service: ServiceDefinition;
  try {
    service = getService(serviceId);
  } catch {
    return { ok: false, message: `Service ${serviceId} not found` };
  }

  if (!isBridgeService(service)) {
    return { ok: false, message: `Service ${serviceId} is not a bridge service` };
  }

  const bridge = service.desktop!.bridge!;
  const installDir = getInstallDir(app, service);
  const bridgeAddr = getBridgeHttpAddr(app, service, installDir);

  let gatewayInfo: GatewayInfo;
  try {
    gatewayInfo = await fetchGatewayInfoWithRetry(bridgeAddr, bridge.gatewayInfoEndpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateBridgeRegistrationState(serviceId, {
      registered: false,
      channelId: bridge.channelId,
      channelName: bridge.channelName,
      lastError: message
    });
    return { ok: false, message: `Failed to fetch gateway info: ${message}` };
  }

  const agentPlatformInstallDir = getAgentPlatformInstallDir(app);
  if (!agentPlatformInstallDir) {
    const errorMsg = "agent-platform not found, cannot update channels.yml";
    updateBridgeRegistrationState(serviceId, {
      registered: false,
      channelId: bridge.channelId,
      channelName: bridge.channelName,
      lastError: errorMsg
    });
    return { ok: false, message: errorMsg };
  }

  const channelEntry: ChannelEntry = {
    name: bridge.channelName,
    type: "bridge",
    "default-agent": "",
    agents: "*",
    gateway: {
      url: gatewayInfo.url,
      "jwt-token": gatewayInfo.token
    }
  };

  try {
    upsertChannel(agentPlatformInstallDir, bridge.channelId, channelEntry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateBridgeRegistrationState(serviceId, {
      registered: false,
      channelId: bridge.channelId,
      channelName: bridge.channelName,
      lastError: message
    });
    return { ok: false, message: `Failed to update channels.yml: ${message}` };
  }

  updateBridgeRegistrationState(serviceId, {
    registered: true,
    channelId: bridge.channelId,
    channelName: bridge.channelName,
    lastError: null
  });

  return {
    ok: true,
    message: `Bridge ${bridge.channelName} registered to agent-platform`
  };
}

export async function unregisterBridge(app: App, serviceId: ServiceId): Promise<{ ok: boolean; message: string }> {
  let service: ServiceDefinition;
  try {
    service = getService(serviceId);
  } catch {
    return { ok: false, message: `Service ${serviceId} not found` };
  }

  if (!isBridgeService(service)) {
    return { ok: false, message: `Service ${serviceId} is not a bridge service` };
  }

  const bridge = service.desktop!.bridge!;
  const agentPlatformInstallDir = getAgentPlatformInstallDir(app);

  if (agentPlatformInstallDir) {
    try {
      removeChannel(agentPlatformInstallDir, bridge.channelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateBridgeRegistrationState(serviceId, {
        registered: false,
        channelId: bridge.channelId,
        channelName: bridge.channelName,
        lastError: message
      });
      return { ok: false, message: `Failed to update channels.yml: ${message}` };
    }
  }

  updateBridgeRegistrationState(serviceId, {
    registered: false,
    channelId: null,
    channelName: null,
    lastError: null
  });

  return {
    ok: true,
    message: `Bridge ${bridge.channelName} unregistered from agent-platform`
  };
}
