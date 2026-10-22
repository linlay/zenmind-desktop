/**
 * Every WorkPanel tab has one surfaceId; what an Agent may do with it is its
 * capability list. Webpages and verified HTML file previews are live CDP
 * surfaces. Every other tab (other file previews, Desktop and WebClient pages)
 * only has an item identity: it can be activated or closed, never scripted,
 * clicked or captured. Desktop Main enforces this; the list is informative.
 */
export const WORK_PANEL_ITEM_SURFACE_PREFIX = "workpanel-item:";

export type WorkPanelSurfaceCapability =
  | "activate"
  | "close"
  | "state"
  | "navigate"
  | "reload"
  | "screenshot"
  | "script"
  | "input"
  | "cdp"
  | "awcp"
  | "login"
  | "viewport";

export const WORK_PANEL_WEB_CAPABILITIES: readonly WorkPanelSurfaceCapability[] = [
  "activate", "close", "state", "navigate", "reload", "screenshot", "script", "input", "cdp", "awcp", "login", "viewport",
];

/** A file preview stays isolated: it cannot navigate, reach the network, use AWCP or saved logins. */
export const WORK_PANEL_HTML_FILE_CAPABILITIES: readonly WorkPanelSurfaceCapability[] = [
  "activate", "close", "state", "reload", "screenshot", "script", "input", "cdp", "viewport",
];

/** CDP methods a verified HTML file preview accepts. Navigation and network methods are absent. */
export const WORK_PANEL_HTML_FILE_CDP_METHODS: ReadonlySet<string> = new Set([
  "Surface.getState",
  "Surface.close",
  "Surface.setViewport",
  "Page.bringToFront",
  "Page.enable",
  "Page.reload",
  "Page.captureScreenshot",
  "Runtime.evaluate",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getOuterHTML",
  "DOM.getBoxModel",
  "Input.click",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
]);

export function createWorkPanelItemSurfaceId(itemId: string) {
  return `${WORK_PANEL_ITEM_SURFACE_PREFIX}${itemId}`;
}

export function workPanelItemCapabilities(closable: boolean | undefined): WorkPanelSurfaceCapability[] {
  return closable === false ? ["activate"] : ["activate", "close"];
}
