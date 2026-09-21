import {
  type ManifestEnvBinding,
  type ManifestDesktopCapabilityProvider,
  type ManifestDesktopCapabilityRequirement,
  type ManifestDesktopCapabilities
} from "../../../shared/contracts";
import { asObject, asString, asOptionalString, asBoolean, asStringRecord, asStringArray } from "./manifest-values";
import { toManifestCommand } from "./manifest-service-fields";

export function resolveEnvBindings(raw: Record<string, unknown>): ManifestEnvBinding[] {
  const desktop = asObject(raw.desktop);
  if (!Array.isArray(desktop.envBindings)) {
    return [];
  }
  const result: ManifestEnvBinding[] = [];
  for (const item of desktop.envBindings) {
    const binding = asObject(item);
    const key = asString(binding.key).trim();
    if (!key) continue;
    const entry: ManifestEnvBinding = { key };
    const value = asOptionalString(binding.value);
    if (value !== undefined) entry.value = value;
    const fromService = asOptionalString(binding.fromService);
    if (fromService !== undefined) entry.fromService = fromService;
    const template = asOptionalString(binding.template);
    if (template !== undefined) entry.template = template;
    const onlyIfDefault = asBoolean(binding.onlyIfDefault);
    if (onlyIfDefault !== undefined) entry.onlyIfDefault = onlyIfDefault;
    if (Array.isArray(binding.defaults)) {
      entry.defaults = binding.defaults.filter((d): d is string => typeof d === "string");
    }
    result.push(entry);
  }
  return result;
}

export function resolveCapabilityCommand(value: unknown) {
  const command = toManifestCommand(value);
  return command ?? undefined;
}

export function resolveCapabilityProvider(value: unknown): ManifestDesktopCapabilityProvider | null {
  const provider = asObject(value);
  const id = asOptionalString(provider.id);
  if (!id) {
    return null;
  }

  const entry: ManifestDesktopCapabilityProvider = { id };
  const command = resolveCapabilityCommand(provider.command);
  if (command !== undefined) entry.command = command;
  const windowsCommand = resolveCapabilityCommand(provider.windowsCommand);
  if (windowsCommand !== undefined) entry.windowsCommand = windowsCommand;
  const darwinCommand = resolveCapabilityCommand(provider.darwinCommand);
  if (darwinCommand !== undefined) entry.darwinCommand = darwinCommand;
  const linuxCommand = resolveCapabilityCommand(provider.linuxCommand);
  if (linuxCommand !== undefined) entry.linuxCommand = linuxCommand;
  const env = asStringRecord(provider.env);
  if (Object.keys(env).length > 0) entry.env = env;
  if (
    provider.output !== undefined &&
    provider.output !== "file" &&
    provider.output !== "stdoutLastLine"
  ) {
    throw new Error(`invalid Desktop capability output for ${id}: ${String(provider.output)}`);
  }
  const output = provider.output === "file" || provider.output === "stdoutLastLine"
    ? provider.output
    : undefined;
  if (output !== undefined) entry.output = output;
  const outputPath = asOptionalString(provider.outputPath);
  if (outputPath !== undefined) entry.outputPath = outputPath;
  const dependsOn = asStringArray(provider.dependsOn);
  if (dependsOn.length > 0) entry.dependsOn = dependsOn;
  const retryOnSqliteBusy = asBoolean(provider.retryOnSqliteBusy);
  if (retryOnSqliteBusy !== undefined) entry.retryOnSqliteBusy = retryOnSqliteBusy;
  const validateJwtDeviceId = asBoolean(provider.validateJwtDeviceId);
  if (validateJwtDeviceId !== undefined) entry.validateJwtDeviceId = validateJwtDeviceId;
  const allowDeviceIdFallback = asBoolean(provider.allowDeviceIdFallback);
  if (allowDeviceIdFallback !== undefined) entry.allowDeviceIdFallback = allowDeviceIdFallback;
  return entry;
}

export function resolveCapabilityRequirement(value: unknown): ManifestDesktopCapabilityRequirement | null {
  const requirement = asObject(value);
  const phase = requirement.phase === "preStart" || requirement.phase === "verifyRunning"
    ? requirement.phase
    : null;
  if (!phase) {
    if (requirement.capability !== undefined || requirement.service !== undefined) {
      throw new Error(`invalid Desktop capability requirement phase: ${String(requirement.phase)}`);
    }
    return null;
  }

  const capability = asOptionalString(requirement.capability);
  const service = asOptionalString(requirement.service);
  if (!capability && !service) {
    return null;
  }

  const action =
    requirement.action === "copyFile" ||
    requirement.action === "preload" ||
    requirement.action === "waitHttp"
      ? requirement.action
      : undefined;
  if (requirement.action !== undefined && action === undefined) {
    throw new Error(`invalid Desktop capability requirement action: ${String(requirement.action)}`);
  }
  const target = asOptionalString(requirement.target);
  const authCapability = asOptionalString(requirement.authCapability);
  return {
    phase,
    ...(capability ? { capability } : {}),
    ...(service ? { service } : {}),
    ...(action ? { action } : {}),
    ...(target ? { target } : {}),
    ...(authCapability ? { authCapability } : {})
  };
}

export function resolveDesktopCapabilities(raw: Record<string, unknown>): ManifestDesktopCapabilities & {
  provides: ManifestDesktopCapabilityProvider[];
  requires: ManifestDesktopCapabilityRequirement[];
} {
  const desktop = asObject(raw.desktop);
  const capabilities = asObject(desktop.capabilities);
  const provides = Array.isArray(capabilities.provides)
    ? capabilities.provides.map(resolveCapabilityProvider).filter((item): item is ManifestDesktopCapabilityProvider => Boolean(item))
    : [];
  const requires = Array.isArray(capabilities.requires)
    ? capabilities.requires.map(resolveCapabilityRequirement).filter((item): item is ManifestDesktopCapabilityRequirement => Boolean(item))
    : [];
  return { provides, requires };
}
