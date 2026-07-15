export const SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL = "desktop:service-webview:message";
export const SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL = "desktop:service-webview:deliver";
export const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = "desktop:service-webview:route";
export const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = "desktop:service-webview:action";
export const SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE = "desktop:service-webview:debug";

export const AGENT_APP_CLIPBOARD_REQUEST_TYPE = "desktop:agent-app-clipboard:request";
export const AGENT_APP_CLIPBOARD_RESPONSE_TYPE = "desktop:agent-app-clipboard:response";
export const DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE = "desktop:dialog:select-directory";
export const DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE = "desktop:dialog:select-directory:response";
export const DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE = "desktop:shell:open-path";
export const DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE = "desktop:shell:open-path:response";
export const DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE = "desktop:download:file";
export const DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE = "desktop:download:file:response";
export const DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE = "desktop:screenshot:capture";
export const DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE = "desktop:screenshot:capture:response";
export const PLUGIN_SETTINGS_READ_REQUEST_TYPE = "desktop:plugin-settings:read";
export const PLUGIN_SETTINGS_READ_RESPONSE_TYPE = "desktop:plugin-settings:read:response";
export const PLUGIN_SETTINGS_WRITE_REQUEST_TYPE = "desktop:plugin-settings:write";
export const PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE = "desktop:plugin-settings:write:response";
export const DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE = "desktopContextChanged";
export const DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE = "desktopRouteChanged";

export const SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES = [
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE,
  DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE,
  DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE,
  PLUGIN_SETTINGS_READ_REQUEST_TYPE,
  PLUGIN_SETTINGS_WRITE_REQUEST_TYPE
] as const;

export const SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES = [
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE,
  PLUGIN_SETTINGS_READ_RESPONSE_TYPE,
  PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE
] as const;

const SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPE_SET = new Set<string>(SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES);

const SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPE_SET = new Set<string>(SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES);

export function isServiceWebviewBridgeRequestType(type: string | undefined | null) {
  return Boolean(type && SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPE_SET.has(type));
}

export function isServiceWebviewBridgeResponseType(type: string | undefined | null) {
  return Boolean(type && SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPE_SET.has(type));
}

export function isServiceWebviewBridgeMessageType(
  type: string | undefined | null,
  canonicalType: string
) {
  return type === canonicalType;
}

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
  width?: number;
  height?: number;
  sizeBytes?: number;
  cancelled?: boolean;
  values?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  schema?: unknown;
  shortcutStatuses?: unknown;
  restartRequired?: boolean;
  changedKeys?: string[];
  token?: string | null;
  desktopAuthContext?: string;
  desktop?: unknown;
  stage?: string;
  message?: string;
  url?: string;
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
};
