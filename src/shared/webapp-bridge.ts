import type { WebappDesktopBridgeConfig } from "./webapp-manifest";
export const WEBAPP_BRIDGE_VERSION = 1 as const;

export const WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES = [
  "assistant.chat",
  "assistant.image",
  "connector.read",
  "connector.write",
  "skill.read",
  "artifact.read",
  "kanban.read",
  "artifact.present",
  "desktop.permissions",
  "desktop.connector.authenticate",
  "desktop.browser.external",
  "desktop.dialog.files",
  "desktop.dialog.directories",
  "desktop.dialog.savePath",
  "desktop.microphone",
  "desktop.clipboard.write",
  "desktop.notification"
] as const;

export const WEBAPP_BRIDGE_RESERVED_CAPABILITIES = [
  "automation.manage",
  "desktop.screen.capture",
  "desktop.clipboard.read",
  "desktop.file.reveal",
  "desktop.window",
  "desktop.camera",
  "desktop.share"
] as const;

export type WebappBridgeCapability = typeof WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES[number];
export type WebappBridgeReservedCapability = typeof WEBAPP_BRIDGE_RESERVED_CAPABILITIES[number];
export type WebappBridgeCapabilityStatus = "available" | "reserved" | "unavailable";
export type WebappBridgePermissionStatus =
  | "granted"
  | "denied"
  | "prompt"
  | "restricted"
  | "unavailable"
  | "not_required";

export type { WebappDesktopBridgeConfig } from "./webapp-manifest";

export interface WebappBridgeCapabilityState {
  id: WebappBridgeCapability | WebappBridgeReservedCapability;
  status: WebappBridgeCapabilityStatus;
  declared: boolean;
  permission: WebappBridgePermissionStatus;
}

export interface WebappBridgeCapabilitiesResult {
  bridgeVersion: typeof WEBAPP_BRIDGE_VERSION;
  capabilities: WebappBridgeCapabilityState[];
}

export const WEBAPP_BRIDGE_ACTIONS = Object.freeze({
  permissionsRequest: "desktop.requestAccess",
  capabilitiesList: "desktop.capabilities.list",
  connectorList: "connector.list",
  connectorDescribe: "connector.describe",
  connectorInvoke: "connector.invoke",
  connectorAuthenticate: "desktop.authenticateConnector",
  assistantChat: "desktop.assistant.chat",
  assistantImage: "desktop.assistant.image",
  assistantImageCancel: "desktop.assistant.image.cancel",
  browserOpenExternal: "desktop.native.browser.openExternal",
  dialogSelectFiles: "desktop.native.dialog.selectFiles",
  dialogSelectDirectory: "desktop.native.dialog.selectDirectory",
  dialogSelectSavePath: "desktop.native.dialog.selectSavePath",
  microphoneGetPermission: "desktop.native.microphone.getPermission",
  microphoneRequestAccess: "desktop.native.microphone.requestAccess",
  clipboardWriteText: "desktop.native.clipboard.writeText",
  notificationShow: "desktop.native.notification.show"
} as const);

export const WEBAPP_BRIDGE_CAPABILITY_ACTIONS: Readonly<Record<WebappBridgeCapability, readonly string[]>> =
  Object.freeze({
    "kanban.read": Object.freeze(["kanban.boards.list", "kanban.issues.list", "kanban.issues.get"]),
    "skill.read": Object.freeze(["skill.list", "skill.describe"]),
    "artifact.present": Object.freeze(["artifact.open", "artifact.saveAs"]),
    "artifact.read": Object.freeze(["artifact.list", "artifact.get", "artifact.read"]),
    "desktop.permissions": Object.freeze([WEBAPP_BRIDGE_ACTIONS.permissionsRequest]),
    "connector.write": Object.freeze([]),
    "connector.read": Object.freeze([WEBAPP_BRIDGE_ACTIONS.connectorList,WEBAPP_BRIDGE_ACTIONS.connectorDescribe,WEBAPP_BRIDGE_ACTIONS.connectorInvoke]),
    "desktop.connector.authenticate": Object.freeze([WEBAPP_BRIDGE_ACTIONS.connectorAuthenticate]),
    "assistant.chat": Object.freeze([WEBAPP_BRIDGE_ACTIONS.assistantChat, "assistant.events", "assistant.stop"]),
    "assistant.image": Object.freeze([
      WEBAPP_BRIDGE_ACTIONS.assistantImage,
      WEBAPP_BRIDGE_ACTIONS.assistantImageCancel
    ]),
    "desktop.browser.external": Object.freeze([WEBAPP_BRIDGE_ACTIONS.browserOpenExternal]),
    "desktop.dialog.files": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectFiles]),
    "desktop.dialog.directories": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectDirectory]),
    "desktop.dialog.savePath": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectSavePath]),
    "desktop.microphone": Object.freeze([
      WEBAPP_BRIDGE_ACTIONS.microphoneGetPermission,
      WEBAPP_BRIDGE_ACTIONS.microphoneRequestAccess
    ]),
    "desktop.clipboard.write": Object.freeze([WEBAPP_BRIDGE_ACTIONS.clipboardWriteText]),
    "desktop.notification": Object.freeze([WEBAPP_BRIDGE_ACTIONS.notificationShow])
  });

export function isWebappBridgeAvailableCapability(value: string): value is WebappBridgeCapability {
  return (WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES as readonly string[]).includes(value);
}

export function isWebappBridgeReservedCapability(value: string): value is WebappBridgeReservedCapability {
  return (WEBAPP_BRIDGE_RESERVED_CAPABILITIES as readonly string[]).includes(value);
}

// Public WebApp names map only to this explicit allowlist. Other Desktop
// actions cannot become WebApp capabilities through prefix rewriting.
export const WEBAPP_PUBLIC_ACTIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.values(WEBAPP_BRIDGE_ACTIONS).map((action) => [
    action.replace(/^desktop\.assistant\./u, "assistant.").replace(/^desktop\.native\./u, "desktop."),
    action
  ]))
);

export function resolveWebappAction(action: string): string {
  return Object.prototype.hasOwnProperty.call(WEBAPP_PUBLIC_ACTIONS, action)
    ? WEBAPP_PUBLIC_ACTIONS[action]
    : action;
}

// Login permission is independent of a package's optional business operations.
export function getWebappAuthenticationConnectors(config?: WebappDesktopBridgeConfig): string[] {
  return [...new Set([...(config?.connectorAuthentication ?? []), ...Object.keys(config?.connectorOperations ?? {})])];
}
