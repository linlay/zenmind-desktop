export const EMBEDDED_CDP_GATEWAY_HOST = "127.0.0.1";
export const EMBEDDED_CDP_GATEWAY_PORT = 11789;
export const EMBEDDED_CDP_GATEWAY_URL = `http://${EMBEDDED_CDP_GATEWAY_HOST}:${EMBEDDED_CDP_GATEWAY_PORT}`;

export const DESKTOP_CDP_PUBLIC_METHODS = [
  "Target.getCurrentTarget",
  "Target.getTargets",
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

export type EmbeddedCdpSurfaceKind = "website" | "webapp" | "browser" | "service";
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

export type EmbeddedCdpSurfaceRegistration = {
  registrationId: string;
  surfaceId: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  label: string;
  url: string;
  active: boolean;
  tabs: EmbeddedCdpSurfaceTabRegistration[];
  activeTabId: string | null;
};

export type EmbeddedCdpSurfaceRemoval = {
  registrationId: string;
  surfaceId: string;
};
