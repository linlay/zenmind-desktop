import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId, ServiceKind } from "../shared/contracts";
import { getDesktopConfigRoot } from "./user-paths";

export const SERVICE_LIFECYCLE_ARGS_FILE = "service-lifecycle-args.json";

export type ServiceLifecycleCommandKind = "deploy" | "start" | "stop";

export type ServiceLifecycleArgsConfig = {
  schemaVersion: 1;
  services: Record<ServiceId, {
    lifecycleArgs: Partial<Record<ServiceLifecycleCommandKind, string[]>>;
  }>;
};

const CORE_SERVICE_LIFECYCLE_COMMANDS = {
  "agent-container-hub": ["deploy", "start", "stop"],
  "identity-center": ["deploy", "start", "stop"],
  "agent-platform": ["deploy", "start", "stop"],
  "agent-webclient": ["deploy"]
} as const satisfies Record<string, readonly ServiceLifecycleCommandKind[]>;

const AGENT_PLATFORM_REMOVED_VALUE_FLAGS = new Set(["--runtime-dir"]);

type CoreLifecycleServiceId = keyof typeof CORE_SERVICE_LIFECYCLE_COMMANDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readLifecycleArgArray(
  lifecycleArgs: Record<string, unknown>,
  kind: ServiceLifecycleCommandKind
) {
  if (!Object.prototype.hasOwnProperty.call(lifecycleArgs, kind)) {
    return null;
  }
  return readStringArray(lifecycleArgs[kind]);
}

function getAllowedLifecycleKinds(serviceId: string) {
  return CORE_SERVICE_LIFECYCLE_COMMANDS[serviceId as CoreLifecycleServiceId] ?? null;
}

function readPlatformServiceDefaults(
  serviceDefaults: Record<string, unknown>,
  platform: NodeJS.Platform
) {
  const platforms = isRecord(serviceDefaults.platforms) ? serviceDefaults.platforms : {};
  const platformDefaults = platforms[platform];
  return isRecord(platformDefaults) ? platformDefaults : {};
}

function normalizeServiceLifecycleArgs(
  serviceId: string,
  serviceDefaults: unknown,
  platform: NodeJS.Platform
) {
  if (!isRecord(serviceDefaults)) {
    return null;
  }
  const allowedKinds = getAllowedLifecycleKinds(serviceId);
  if (!allowedKinds) {
    return null;
  }

  const commonLifecycleArgs = isRecord(serviceDefaults.lifecycleArgs)
    ? serviceDefaults.lifecycleArgs
    : {};
  const platformDefaults = readPlatformServiceDefaults(serviceDefaults, platform);
  const platformLifecycleArgs = isRecord(platformDefaults.lifecycleArgs)
    ? platformDefaults.lifecycleArgs
    : {};
  const lifecycleArgs: Partial<Record<ServiceLifecycleCommandKind, string[]>> = {};

  for (const kind of allowedKinds) {
    const commonArgs = readLifecycleArgArray(commonLifecycleArgs, kind);
    const platformArgs = readLifecycleArgArray(platformLifecycleArgs, kind);
    if (commonArgs || platformArgs) {
      lifecycleArgs[kind] = [
        ...(commonArgs ?? []),
        ...(platformArgs ?? [])
      ];
    }
  }

  return Object.keys(lifecycleArgs).length > 0 ? { lifecycleArgs } : null;
}

export function normalizeServiceLifecycleArgsConfig(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): ServiceLifecycleArgsConfig | null {
  if (!isRecord(value) || !isRecord(value.services)) {
    return null;
  }

  const services: ServiceLifecycleArgsConfig["services"] = {};
  for (const [serviceId, serviceDefaults] of Object.entries(value.services)) {
    const serviceConfig = normalizeServiceLifecycleArgs(serviceId, serviceDefaults, platform);
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

export function getServiceLifecycleArgsConfigPath(app: App) {
  return path.join(getDesktopConfigRoot(app), SERVICE_LIFECYCLE_ARGS_FILE);
}

export function writeServiceLifecycleArgsConfig(app: App, config: ServiceLifecycleArgsConfig) {
  const filePath = getServiceLifecycleArgsConfigPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readServiceLifecycleArgsConfig(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServiceLifecycleArgsConfigPath(app);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeServiceLifecycleArgsConfig(parsed, platform);
  } catch {
    return null;
  }
}

export function getConfiguredServiceLifecycleArgs(
  app: App,
  serviceId: ServiceId,
  kind: ServiceLifecycleCommandKind,
  platform: NodeJS.Platform = process.platform
) {
  const args = readServiceLifecycleArgsConfig(app, platform)?.services[serviceId]?.lifecycleArgs[kind] ?? [];
  if (serviceId !== "agent-platform") {
    return args;
  }
  const nextArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.trim().toLowerCase();
    if (AGENT_PLATFORM_REMOVED_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    nextArgs.push(args[index]);
  }
  return nextArgs;
}

export function appendConfiguredServiceLifecycleArgs(
  app: App,
  service: { id: ServiceId; kind: ServiceKind },
  command: string[],
  kind: ServiceLifecycleCommandKind,
  platform: NodeJS.Platform = process.platform
) {
  if (service.kind !== "builtin") {
    return command;
  }
  const args = getConfiguredServiceLifecycleArgs(app, service.id, kind, platform);
  return args.length > 0 ? [...command, ...args] : command;
}
