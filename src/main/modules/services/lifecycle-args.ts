import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId, ServiceKind } from "../../../shared/contracts";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

export const SERVICE_LIFECYCLE_ARGS_FILE = "service-lifecycle-args.json";

export type ServiceLifecycleCommandKind = "deploy" | "start" | "stop";

export type ServiceLifecycleArgsConfig = {
  schemaVersion: 1;
  services: Record<ServiceId, {
    lifecycleArgs: Partial<Record<ServiceLifecycleCommandKind, string[]>>;
  }>;
};

const CORE_SERVICE_LIFECYCLE_COMMANDS = {
  "agent-container-hub": [],
  "identity-center": ["deploy"],
  "agent-platform": ["deploy"],
  "agent-webclient": ["start"]
} as const satisfies Record<string, readonly ServiceLifecycleCommandKind[]>;

const AGENT_PLATFORM_DEPLOY_VALUE_FLAGS = [
  "--ai-vision-general-model-key",
  "--ai-vision-ocr-model-key",
  "--ai-web-fetch-model-key",
  "--ai-image-generate-model-key",
  "--coder-model-key",
  "--coder-reasoning-effort",
  "--kbase-model-key",
  "--kbase-reasoning-effort",
  "--kbase-embedding-model-key"
] as const;

const SUPPORTED_VALUE_FLAGS = {
  "identity-center": {
    deploy: ["--auth-issuer"]
  },
  "agent-platform": {
    deploy: AGENT_PLATFORM_DEPLOY_VALUE_FLAGS
  },
  "agent-webclient": {
    start: ["--base-url"]
  }
} as const;

const REASONING_EFFORT_FLAGS = new Set([
  "--coder-reasoning-effort",
  "--kbase-reasoning-effort"
]);
const REASONING_EFFORT_VALUES = new Set(["NONE", "LOW", "MEDIUM", "HIGH"]);

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

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeLifecycleFlagValue(flag: string, value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("--")) {
    return null;
  }
  if (REASONING_EFFORT_FLAGS.has(flag)) {
    const upper = normalized.toUpperCase();
    return REASONING_EFFORT_VALUES.has(upper) ? upper : null;
  }
  if ((flag === "--base-url" || flag === "--auth-issuer") && !isValidHttpUrl(normalized)) {
    return null;
  }
  return normalized;
}

function getSupportedValueFlags(serviceId: string, kind: ServiceLifecycleCommandKind) {
  const serviceFlags = SUPPORTED_VALUE_FLAGS[serviceId as keyof typeof SUPPORTED_VALUE_FLAGS];
  if (!serviceFlags) {
    return [] as readonly string[];
  }
  return (serviceFlags as Partial<Record<ServiceLifecycleCommandKind, readonly string[]>>)[kind] ?? [];
}

function filterServiceLifecycleArgs(
  serviceId: ServiceId | string,
  args: string[],
  kind?: ServiceLifecycleCommandKind
) {
  if (!kind) {
    return [];
  }

  const supportedFlags = getSupportedValueFlags(serviceId, kind);
  if (supportedFlags.length === 0) {
    return [];
  }
  const supportedFlagSet = new Set(supportedFlags);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]?.trim().toLowerCase();
    if (!supportedFlagSet.has(flag)) {
      continue;
    }
    const value = normalizeLifecycleFlagValue(flag, args[index + 1] ?? "");
    index += 1;
    if (value !== null) {
      values.set(flag, value);
    }
  }

  return supportedFlags.flatMap((flag) => {
    const value = values.get(flag);
    return value === undefined ? [] : [flag, value];
  });
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
      const args = filterServiceLifecycleArgs(serviceId, [
        ...(commonArgs ?? []),
        ...(platformArgs ?? [])
      ], kind);
      if (args.length > 0) {
        lifecycleArgs[kind] = args;
      }
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

export function getServiceLifecycleArgsConfigPath(app: App, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopConfigRoot(app, platform), SERVICE_LIFECYCLE_ARGS_FILE);
}

export function writeServiceLifecycleArgsConfig(
  app: App,
  config: ServiceLifecycleArgsConfig,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServiceLifecycleArgsConfigPath(app, platform);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") {
    fs.chmodSync(path.dirname(filePath), 0o700);
    fs.chmodSync(filePath, 0o600);
  }
}

export function readServiceLifecycleArgsConfig(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const filePath = getServiceLifecycleArgsConfigPath(app, platform);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeServiceLifecycleArgsConfig(parsed, platform);
  } catch {
    return null;
  }
}

export function rewriteServiceLifecycleArgsForDesktopConfigUpgrade(
  app: App,
  agentPlatformPort: number,
  platform: NodeJS.Platform = process.platform
) {
  const current = readServiceLifecycleArgsConfig(app, platform);
  const services: ServiceLifecycleArgsConfig["services"] = {
    ...(current?.services ?? {})
  };
  const configuredBaseUrl = services["agent-webclient"]?.lifecycleArgs.start ?? [];
  const normalizedBaseUrl = filterServiceLifecycleArgs(
    "agent-webclient",
    configuredBaseUrl,
    "start"
  );
  services["agent-webclient"] = {
    lifecycleArgs: {
      start: normalizedBaseUrl.length > 0
        ? normalizedBaseUrl
        : ["--base-url", `http://127.0.0.1:${agentPlatformPort}`]
    }
  };

  const config: ServiceLifecycleArgsConfig = {
    schemaVersion: 1,
    services
  };
  writeServiceLifecycleArgsConfig(app, config, platform);
  return config;
}

export function getConfiguredServiceLifecycleArgs(
  app: App,
  serviceId: ServiceId,
  kind: ServiceLifecycleCommandKind,
  platform: NodeJS.Platform = process.platform
) {
  const args = readServiceLifecycleArgsConfig(app, platform)?.services[serviceId]?.lifecycleArgs[kind] ?? [];
  return filterServiceLifecycleArgs(serviceId, args, kind);
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
