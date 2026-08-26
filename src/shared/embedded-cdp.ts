import type { WebviewContextMenuSurfaceType } from "./webview-context-menu";
import type { SurfaceIdentity } from "./surface-identity";

export const EMBEDDED_CDP_GATEWAY_HOST = "127.0.0.1";
export const EMBEDDED_CDP_GATEWAY_PORT = 11789;
export const EMBEDDED_CDP_GATEWAY_URL = `http://${EMBEDDED_CDP_GATEWAY_HOST}:${EMBEDDED_CDP_GATEWAY_PORT}`;

export const DESKTOP_CDP_PUBLIC_METHODS = [
  "Target.getCurrentTarget",
  "Target.getTargets",
  "Target.closeTarget",
  "Page.bringToFront",
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.captureScreenshot",
  "Runtime.evaluate",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getOuterHTML",
  "DOM.getBoxModel",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Network.enable",
  "Network.disable"
] as const;

export type DesktopCdpPublicMethod = typeof DESKTOP_CDP_PUBLIC_METHODS[number];

export type EmbeddedCdpSurfaceKind = "website" | "webapp" | "browser" | "service" | "chat-work-panel";
export type EmbeddedCdpSiteSurfaceKind = Extract<EmbeddedCdpSurfaceKind, "website" | "webapp">;

export type EmbeddedCdpSurfaceTabRegistration = {
  tabId: string;
  currentUrl: string;
  title: string;
  webContentsId: number;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
};

export type EmbeddedCdpSurfaceRegistration = SurfaceIdentity & {
  registrationId: string;
  /** Internal stable key used by Main to verify dynamic IDs and reject hash collisions. */
  surfaceIdentityKey?: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  surfaceType?: WebviewContextMenuSurfaceType;
  serviceId?: string;
  pageRoute?: string;
  /** Main-only route snapshot used for authorization; never expose it in diagnostics. */
  pageRouteIdentity?: string;
  ownerChatId?: string;
  presentationScope?: "main-workspace" | "workpanel";
  label: string;
  url: string;
  active: boolean;
  tabs: EmbeddedCdpSurfaceTabRegistration[];
  activeTabId: string | null;
};

export type EmbeddedCdpSurfaceRegistrationRejectReason =
  | "route_not_aligned"
  | "ownership_conflict"
  | "invalid_registration";

export type EmbeddedCdpSurfaceRegistrationResult =
  | { ok: true }
  | { ok: false; reason: EmbeddedCdpSurfaceRegistrationRejectReason };

export type EmbeddedCdpSurfaceTargetState = {
  tabId: string;
  targetId: string;
  currentUrl: string;
  title: string;
  isLoading: boolean;
};

export type EmbeddedCdpSurfaceTargetStateRequest = {
  registrationId: string;
  surfaceId: string;
};

export type EmbeddedCdpSurfaceTargetStateResult = {
  ok: boolean;
  surfaceId?: string;
  activeTabId?: string | null;
  targets?: EmbeddedCdpSurfaceTargetState[];
};

export type EmbeddedCdpSurfaceRemoval = {
  registrationId: string;
  surfaceId: string;
};
