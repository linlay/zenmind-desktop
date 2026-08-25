export const WEBAPP_BRIDGE_VERSION = 1 as const;

export const WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES = [
  "assistant.chat",
  "assistant.image",
  "native.browser.external",
  "native.dialog.files",
  "native.dialog.directories",
  "native.dialog.savePath",
  "native.microphone",
  "native.clipboard.write",
  "native.notification"
] as const;

export const WEBAPP_BRIDGE_RESERVED_CAPABILITIES = [
  "native.screen.capture",
  "native.clipboard.read",
  "native.file.reveal",
  "native.window",
  "native.camera",
  "native.share"
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
  capabilitiesList: "desktop.capabilities.list",
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
    "assistant.chat": Object.freeze([WEBAPP_BRIDGE_ACTIONS.assistantChat]),
    "assistant.image": Object.freeze([
      WEBAPP_BRIDGE_ACTIONS.assistantImage,
      WEBAPP_BRIDGE_ACTIONS.assistantImageCancel
    ]),
    "native.browser.external": Object.freeze([WEBAPP_BRIDGE_ACTIONS.browserOpenExternal]),
    "native.dialog.files": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectFiles]),
    "native.dialog.directories": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectDirectory]),
    "native.dialog.savePath": Object.freeze([WEBAPP_BRIDGE_ACTIONS.dialogSelectSavePath]),
    "native.microphone": Object.freeze([
      WEBAPP_BRIDGE_ACTIONS.microphoneGetPermission,
      WEBAPP_BRIDGE_ACTIONS.microphoneRequestAccess
    ]),
    "native.clipboard.write": Object.freeze([WEBAPP_BRIDGE_ACTIONS.clipboardWriteText]),
    "native.notification": Object.freeze([WEBAPP_BRIDGE_ACTIONS.notificationShow])
  });

export function isWebappBridgeAvailableCapability(value: string): value is WebappBridgeCapability {
  return (WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES as readonly string[]).includes(value);
}

export function isWebappBridgeReservedCapability(value: string): value is WebappBridgeReservedCapability {
  return (WEBAPP_BRIDGE_RESERVED_CAPABILITIES as readonly string[]).includes(value);
}
