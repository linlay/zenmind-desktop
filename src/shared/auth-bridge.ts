import type { ManifestFrontend } from "./contracts";

export type PluginAuthBridgeProtocol = {
  requestType: string;
  responseType: string;
};

type EmbeddedServiceLike = {
  id?: string | null;
  frontend?: Pick<ManifestFrontend, "embedPath" | "embedParams"> | null;
};

const authBridgeRegistry = new Map<string, PluginAuthBridgeProtocol>();

export function registerAuthBridgeProtocol(serviceId: string, protocol: PluginAuthBridgeProtocol) {
  const normalizedServiceId = serviceId.trim();
  if (!normalizedServiceId) {
    throw new Error("serviceId is required");
  }

  authBridgeRegistry.set(normalizedServiceId, protocol);
}

export function clearAuthBridgeProtocols() {
  authBridgeRegistry.clear();
}

export function registerBuiltinAuthBridgeProtocols() {
  registerAuthBridgeProtocol("agent-webclient", {
    requestType: "zenmind:agent-app-auth:request",
    responseType: "zenmind:agent-app-auth:response"
  });
  registerAuthBridgeProtocol("pan-webclient", {
    requestType: "zenmind:pan-app-auth:request",
    responseType: "zenmind:pan-app-auth:response"
  });
}

export function getPluginAuthBridgeProtocol(
  serviceId?: string | null
): PluginAuthBridgeProtocol | null {
  if (!serviceId) {
    return null;
  }
  return authBridgeRegistry.get(serviceId) ?? null;
}

export function buildPluginEmbeddedUrl(
  service: EmbeddedServiceLike | undefined,
  webUrl: string,
  options: {
    hostTheme?: "light" | "dark";
  } = {}
): string {
  if (!webUrl) {
    return "";
  }

  const url = new URL(webUrl);
  if (service?.frontend?.embedPath) {
    url.pathname = service.frontend.embedPath;
  }

  const embedParams = service?.frontend?.embedParams ?? {};
  for (const [key, value] of Object.entries(embedParams)) {
    url.searchParams.set(key, value);
  }

  if (options.hostTheme && (service?.frontend?.embedPath || Object.keys(embedParams).length > 0)) {
    url.searchParams.set("hostTheme", options.hostTheme);
  }

  return url.toString();
}
