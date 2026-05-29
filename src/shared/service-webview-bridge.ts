export const SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL = "zenmind:service-webview:message";
export const SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL = "zenmind:service-webview:deliver";
export const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = "zenmind:service-webview:route";
export const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = "zenmind:service-webview:action";
export const SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE = "zenmind:service-webview:debug";

export const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "zenmind:agent-app-clipboard:request";
export const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "zenmind:agent-app-clipboard:response";
export const DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE = "zenmind:desktop-dialog:select-directory";
export const DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE = "zenmind:desktop-dialog:select-directory:response";
export const DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE = "zenmind:desktop-shell:open-path";
export const DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE = "zenmind:desktop-shell:open-path:response";
export const DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE = "zenmind:desktop-download:file";
export const DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE = "zenmind:desktop-download:file:response";
export const DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE = "desktopContextChanged";
export const DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE = "desktopRouteChanged";

export const SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES = [
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE,
  DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE,
  DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE
] as const;

export const SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES = [
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE
] as const;

export type ServiceWebviewBridgeReservedCapability =
  | "media.microphone"
  | "media.camera"
  | "screen.capture"
  | "notification";

export type ServiceWebviewBridgeMessage = {
  type?: string;
  requestId?: string;
  action?: string;
  reason?: "missing" | "unauthorized" | "initial" | "navigation" | "route-sync";
  ok?: boolean;
  mode?: "directory";
  text?: string;
  path?: string;
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
  token?: string | null;
  desktop?: unknown;
  stage?: string;
  message?: string;
  url?: string;
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
};
