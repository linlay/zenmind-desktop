export const SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL = "desktop:service-webview:message";
export const SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL = "desktop:service-webview:deliver";
export const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = "desktop:service-webview:route";
export const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = "desktop:service-webview:action";
export const SERVICE_WEBVIEW_BRIDGE_SURFACE_LIFECYCLE_CHANNEL = "desktop:service-webview:surface-lifecycle";
export const SERVICE_WEBVIEW_MODAL_OVERLAY_STATE_CHANNEL = "desktop:service-webview:modal-overlay-state";
export const SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE = "desktop:service-webview:debug";

export type ServiceWebviewModalOverlayState = {
  visible: boolean;
};

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
export const DESKTOP_WEBS_LIST_REQUEST_TYPE = "desktop:webs:list";
export const DESKTOP_WEBS_LIST_RESPONSE_TYPE = "desktop:webs:list:response";
export const AGENT_WEBCLIENT_NEW_CHAT_PREPARE_REQUEST_TYPE =
  "desktop:agent-webclient:new-chat:prepare";
export const AGENT_WEBCLIENT_NEW_CHAT_PREPARE_RESPONSE_TYPE =
  "desktop:agent-webclient:new-chat:prepared";
export const AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_REQUEST_TYPE =
  "desktop:agent-webclient:current-resource:action";
export const AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_RESPONSE_TYPE =
  "desktop:agent-webclient:current-resource:action:response";
export const AGENT_WEBCLIENT_DOCUMENT_STATE_MESSAGE_TYPE =
  "desktop:agent-webclient:document-state";
export const AGENT_WEBCLIENT_DOCUMENT_HANDOFF_MESSAGE_TYPE =
  "desktop:agent-webclient:document-handoff";
export const PLUGIN_SETTINGS_READ_REQUEST_TYPE = "desktop:plugin-settings:read";
export const PLUGIN_SETTINGS_READ_RESPONSE_TYPE = "desktop:plugin-settings:read:response";
export const PLUGIN_SETTINGS_WRITE_REQUEST_TYPE = "desktop:plugin-settings:write";
export const PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE = "desktop:plugin-settings:write:response";
export const DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE = "desktopContextChanged";
export const DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE = "desktopRouteChanged";
export const DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE = "desktopSurfaceActiveChanged";

export const SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES = [
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE,
  DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE,
  DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE,
  DESKTOP_WEBS_LIST_REQUEST_TYPE,
  AGENT_WEBCLIENT_NEW_CHAT_PREPARE_REQUEST_TYPE,
  AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_REQUEST_TYPE,
  AGENT_WEBCLIENT_DOCUMENT_STATE_MESSAGE_TYPE,
  AGENT_WEBCLIENT_DOCUMENT_HANDOFF_MESSAGE_TYPE,
  PLUGIN_SETTINGS_READ_REQUEST_TYPE,
  PLUGIN_SETTINGS_WRITE_REQUEST_TYPE
] as const;

export const SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES = [
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE,
  DESKTOP_WEBS_LIST_RESPONSE_TYPE,
  AGENT_WEBCLIENT_NEW_CHAT_PREPARE_RESPONSE_TYPE,
  AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_RESPONSE_TYPE,
  PLUGIN_SETTINGS_READ_RESPONSE_TYPE,
  PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE
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

export type AgentWebclientCurrentResourceAction = "reveal" | "open-default";

export type AgentWebclientCurrentResourceIdentity = {
  chatId: string;
  profile: "artifact" | "reference";
  relativePath: string;
};

export type AgentWebclientCurrentResourceActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  available?: boolean;
};

export function normalizeAgentWebclientCurrentResourceIdentity(
  value: unknown,
): AgentWebclientCurrentResourceIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
  const profile = record.profile === "artifact" || record.profile === "reference"
    ? record.profile
    : null;
  const relativePath = typeof record.relativePath === "string"
    ? record.relativePath.trim()
    : "";
  if (
    !chatId ||
    chatId.length > 512 ||
    /[/\\\u0000-\u001f\u007f]/u.test(chatId) ||
    !profile ||
    !relativePath ||
    relativePath.length > 2_048 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    return null;
  }
  const parts = relativePath.split("/");
  const expectedRoot = profile === "artifact" ? "artifacts" : "references";
  if (
    parts.length < 2 ||
    parts[0] !== expectedRoot ||
    parts.some((part) => {
      if (!part || part === "." || part === "..") return true;
      let probe = part;
      for (let depth = 0; depth < 4; depth += 1) {
        try {
          const next = decodeURIComponent(probe);
          if (next === "." || next === ".." || next.includes("/") || next.includes("\\")) {
            return true;
          }
          if (next === probe) return false;
          probe = next;
        } catch {
          return true;
        }
      }
      return /%[\da-f]{2}/iu.test(probe);
    })
  ) {
    return null;
  }
  return { chatId, profile, relativePath: parts.join("/") };
}

export type ServiceWebviewBridgeMessage = {
  type?: string;
  requestId?: string;
  action?: string;
  code?: string;
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
  items?: Array<{
    id: string;
    entryKey: string;
    label: string;
    kind: "website" | "webapp";
    url?: string;
    updatedAt: number;
  }>;
  cancelled?: boolean;
  values?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  schema?: unknown;
  shortcutStatuses?: unknown;
  restartRequired?: boolean;
  changedKeys?: string[];
  token?: string | null;
  desktopAuthContext?: string;
  dirty?: boolean;
  busy?: boolean;
  annotationCount?: number;
  targetKey?: string;
  desktop?: unknown;
  active?: boolean;
  available?: boolean;
  chatId?: string;
  profile?: "artifact" | "reference";
  relativePath?: string;
  surfaceId?: string;
  agentKey?: string;
  sourceChatId?: string;
  newChat?: string;
  stage?: string;
  message?: string;
  url?: string;
  origin?: string;
  pathname?: string;
  search?: string;
  hash?: string;
};
