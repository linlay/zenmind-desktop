import type { ServiceWebviewBridgeReservedCapability } from "../../shared/service-webview-bridge";

export type ReservedServiceWebviewBridgeCapability = {
  key: ServiceWebviewBridgeReservedCapability;
  enabled: false;
  description: string;
};

export const RESERVED_SERVICE_WEBVIEW_BRIDGE_CAPABILITIES: ReservedServiceWebviewBridgeCapability[] = [
  {
    key: "media.microphone",
    enabled: false,
    description: "Reserved for future desktop-mediated microphone permission diagnostics."
  },
  {
    key: "media.camera",
    enabled: false,
    description: "Reserved for future desktop-mediated camera permission flow."
  },
  {
    key: "notification",
    enabled: false,
    description: "Reserved for future desktop notification capability."
  }
];
