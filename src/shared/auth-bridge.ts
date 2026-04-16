export type PluginAuthBridgeProtocol = {
  requestType: string;
  responseType: string;
};

const AUTH_BRIDGE_PROTOCOLS: Record<string, PluginAuthBridgeProtocol> = {
  "agent-webclient": {
    requestType: "zenmind:agent-app-auth:request",
    responseType: "zenmind:agent-app-auth:response"
  },
  "pan-webclient": {
    requestType: "zenmind:pan-app-auth:request",
    responseType: "zenmind:pan-app-auth:response"
  }
};

export function getPluginAuthBridgeProtocol(
  serviceId?: string | null
): PluginAuthBridgeProtocol | null {
  if (!serviceId) {
    return null;
  }
  return AUTH_BRIDGE_PROTOCOLS[serviceId] ?? null;
}

export function buildPluginEmbeddedUrl(
  serviceId: string | undefined,
  webUrl: string,
  themeMode?: "light" | "dark"
): string {
  if (!webUrl) {
    return "";
  }

  const url = new URL(webUrl);
  if (serviceId === "agent-webclient") {
    url.pathname = "/appagent";
  }
  if (serviceId === "agent-webclient" || serviceId === "pan-webclient") {
    url.searchParams.set("desktopApp", "1");
  }
  if (themeMode) {
    url.searchParams.set("hostTheme", themeMode);
  }
  return url.toString();
}
