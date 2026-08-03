import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../shared/contracts";
import { getDesktopConfigRoot } from "./user-paths";

export const SERVICE_PORT_DEFAULTS_FILE = "service-port-defaults.json";

const MAX_TCP_PORT = 65535;

export const CORE_SERVICE_PORT_IDS = [
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "identity-center"
] as const satisfies readonly ServiceId[];

const CORE_SERVICE_IDS = new Set<ServiceId>(CORE_SERVICE_PORT_IDS);

export type ServicePortDefaultsConfig = {
  schemaVersion: 1;
  services: Record<ServiceId, {
    defaultPort: number;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTcpPort(value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_TCP_PORT ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/gu, "");
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const port = Number.parseInt(trimmed, 10);
  return port > 0 && port <= MAX_TCP_PORT ? port : null;
}

function readPlatformServiceDefaults(
  serviceDefaults: Record<string, unknown>,
  platform: NodeJS.Platform
) {
  const platforms = isRecord(serviceDefaults.platforms) ? serviceDefaults.platforms : {};
  const platformDefaults = platforms[platform];
  return isRecord(platformDefaults) ? platformDefaults : {};
}

function normalizeServicePortDefault(
  serviceId: string,
  serviceDefaults: unknown,
  platform: NodeJS.Platform
) {
  if (!CORE_SERVICE_IDS.has(serviceId) || !isRecord(serviceDefaults)) {
    return null;
  }
  const platformDefaults = readPlatformServiceDefaults(serviceDefaults, platform);
  const platformPort = readTcpPort(platformDefaults.defaultPort);
  const defaultPort = platformPort ?? readTcpPort(serviceDefaults.defaultPort);
  return defaultPort ? { defaultPort } : null;
}

export function normalizeServicePortDefaultsConfig(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): ServicePortDefaultsConfig | null {
  if (!isRecord(value) || !isRecord(value.services)) {
    return null;
  }

  const services: ServicePortDefaultsConfig["services"] = {};
  for (const [serviceId, serviceDefaults] of Object.entries(value.services)) {
    const serviceConfig = normalizeServicePortDefault(serviceId, serviceDefaults, platform);
    if (serviceConfig) {
      services[serviceId] = serviceConfig;
    }
  }

  return Object.keys(services).length > 0
    ? {
        schemaVersion: 1,
        services
      }
    : null;
}

export function getServicePortDefaultsConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), SERVICE_PORT_DEFAULTS_FILE);
}

export function writeServicePortDefaultsConfig(
  app: App,
  config: ServicePortDefaultsConfig,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServicePortDefaultsConfigPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") {
    fs.chmodSync(path.dirname(filePath), 0o700);
    fs.chmodSync(filePath, 0o600);
  }
}

export function readServicePortDefaultsConfig(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServicePortDefaultsConfigPath(app, platform);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeServicePortDefaultsConfig(parsed, platform);
  } catch {
    return null;
  }
}

export function rewriteServicePortDefaultsForDesktopConfigUpgrade(
  app: App,
  currentDesktopDefaults: Record<string, number>,
  platform: NodeJS.Platform = process.platform
) {
  const current = readServicePortDefaultsConfig(app, platform);
  const services: ServicePortDefaultsConfig["services"] = {};
  for (const serviceId of CORE_SERVICE_PORT_IDS) {
    const configuredPort = current?.services[serviceId]?.defaultPort;
    const fallbackPort = readTcpPort(currentDesktopDefaults[serviceId]);
    const defaultPort = readTcpPort(configuredPort) ?? fallbackPort;
    if (!defaultPort) {
      throw new Error(`missing current Desktop default port for ${serviceId}`);
    }
    services[serviceId] = { defaultPort };
  }

  const config: ServicePortDefaultsConfig = {
    schemaVersion: 1,
    services
  };
  writeServicePortDefaultsConfig(app, config, platform);
  return config;
}

export function getConfiguredServiceDefaultPort(
  app: App,
  serviceId: ServiceId,
  platform: NodeJS.Platform = process.platform
) {
  return readServicePortDefaultsConfig(app, platform)?.services[serviceId]?.defaultPort ?? null;
}
