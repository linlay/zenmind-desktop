export const SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL = "zenmind:service-webview:message";
export const SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL = "zenmind:service-webview:deliver";
export const SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE = "zenmind:service-webview:debug";

export const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "zenmind:agent-app-clipboard:request";
export const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "zenmind:agent-app-clipboard:response";
export const DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE = "desktopContextChanged";
export const DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE = "desktopRouteChanged";

export type ServiceWebviewBridgeMessage = {
  type?: string;
  requestId?: string;
  action?: string;
  reason?: "missing" | "unauthorized" | "initial" | "navigation" | "route-sync";
  text?: string;
  stage?: string;
  message?: string;
  url?: string;
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
};
