import { NormalizeManifestOptions, ServiceDefinition } from "./manifest-types";
import {
  type ManifestFrontend,
  type ManifestDesktop,
  type ManifestEnvBinding,
  type ManifestDesktopAction,
  type ManifestDesktopCapabilities,
  type ManifestDesktopCapabilityProvider,
  type ManifestDesktopCapabilityRequirement
} from "../../../shared/contracts";
import { asObject, asOptionalString } from "./manifest-values";
import { resolveEnvBindings, resolveDesktopCapabilities } from "./manifest-capabilities";
import {
  cloneDesktopHosting,
  resolveDesktopHosting,
  resolveDefaultDesktopHosting,
  assertAgentWebclientPlatformFramePortHosting
} from "./manifest-hosting";
import { resolveDesktopActions } from "./manifest-plugin-fields";

export function resolveDesktop(
  raw: Record<string, unknown>,
  options: NormalizeManifestOptions,
  serviceId: string,
  frontend: ManifestFrontend,
  settings: ServiceDefinition["settings"]
) {
  const desktop = asObject(raw.desktop);
  const runtimeResources = asOptionalString(desktop.runtimeResources) === "v1" ? "v1" as const : undefined;
  const assetFileName =
    options.desktop?.assetFileName ?? asOptionalString(desktop.assetFileName);
  const bundleTopLevelDir =
    options.desktop?.bundleTopLevelDir ??
    asOptionalString(desktop.bundleTopLevelDir) ??
    serviceId;
  const envBindings = resolveEnvBindings(raw);
  const hosting =
    (options.desktop?.hosting ? cloneDesktopHosting(options.desktop.hosting) : undefined) ??
    resolveDesktopHosting(raw) ??
    resolveDefaultDesktopHosting(serviceId, frontend);
  assertAgentWebclientPlatformFramePortHosting(serviceId, frontend, hosting);
  const capabilities = resolveDesktopCapabilities(raw);
  const actions = resolveDesktopActions(raw, settings);

  return {
    ...(runtimeResources ? { runtimeResources } : {}),
    assetFileName,
    bundleTopLevelDir,
    envBindings,
    actions,
    capabilities,
    ...(hosting ? { hosting } : {})
  } satisfies ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    actions: ManifestDesktopAction[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
}
