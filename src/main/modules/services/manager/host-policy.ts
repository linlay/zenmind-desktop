import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { isHostManagedAgentWebclientService } from "../agent-webclient-host";
import { type App } from "electron";
import { getConfiguredServiceLifecycleArgs } from "../lifecycle-args";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { integrationPorts } from "./manager-contracts";

export function isHostManagedService(service: ServiceDefinition) {
  return isHostManagedAgentWebclientService(service);
}

export function getDesktopManagedCommandPort(service: ServiceDefinition) {
  return service.web.defaultPort;
}

export function getDesktopManagedContainerHubBindAddr(service: ServiceDefinition) {
  return `127.0.0.1:${getDesktopManagedCommandPort(service)}`;
}

export function normalizeHttpUrlArgument(value: string) {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
      return parsed.toString().replace(/\/$/u, "");
    }
  } catch {
    // Return null below so callers get a lifecycle-specific error message.
  }
  return null;
}

export function resolveAgentWebclientHostBaseUrl(app: App) {
  const args = getConfiguredServiceLifecycleArgs(app, "agent-webclient", "start");
  let baseUrl = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base-url": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("agent-webclient host start argument --base-url requires a value.");
        }
        const normalized = normalizeHttpUrlArgument(value);
        if (!normalized) {
          throw new Error(`agent-webclient host start argument --base-url must be an http(s) URL: ${value}`);
        }
        baseUrl = normalized;
        index += 1;
        break;
      }
      default:
        throw new Error(`unsupported agent-webclient host start argument: ${arg}`);
    }
  }

  if (!baseUrl) {
    throw new Error("agent-webclient host start requires lifecycleArgs.start --base-url.");
  }

  return baseUrl;
}

export function resolveAgentWebclientHostStartOverrides(
  app: App,
  ports?: ServicesIntegrationPorts
) {
  const baseUrl = resolveAgentWebclientHostBaseUrl(app);
  const overrides = new Map<string, string>([
    ["BASE_URL", baseUrl],
    ["DESKTOP_APP", "true"]
  ]);
  const assetOrigin = integrationPorts(ports).resolveConversationAssetOrigin(app);
  if (assetOrigin.ok) {
    overrides.set("CONVERSATION_EXPORT_ASSET_ORIGIN", assetOrigin.origin);
  }
  return overrides;
}
