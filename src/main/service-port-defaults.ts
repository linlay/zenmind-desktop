import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../shared/contracts";
import { getDesktopConfigRoot } from "./user-paths";

export const SERVICE_PORT_DEFAULTS_FILE = "service-port-defaults.json";

const MAX_TCP_PORT = 65535;

const CORE_SERVICE_IDS = new Set([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "identity-center"
]);

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

export function getServicePortDefaultsConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), SERVICE_PORT_DEFAULTS_FILE);
}

export function writeServicePortDefaultsConfig(app: App, config: ServicePortDefaultsConfig) {
  const filePath = getServicePortDefaultsConfigPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readServicePortDefaultsConfig(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServicePortDefaultsConfigPath(app);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeServicePortDefaultsConfig(parsed, platform);
  } catch {
    return null;
  }
}

export function getConfiguredServiceDefaultPort(
  app: App,
  serviceId: ServiceId,
  platform: NodeJS.Platform = process.platform
) {
  return readServicePortDefaultsConfig(app, platform)?.services[serviceId]?.defaultPort ?? null;
}
