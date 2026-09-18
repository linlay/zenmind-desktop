import type { EmbeddedCdpContainer, EmbeddedCdpSurfaceTab } from "./containers";

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/%2F/giu, "-");
}

export function targetDescriptor(
  surface: EmbeddedCdpContainer,
  tab: EmbeddedCdpSurfaceTab,
  surfaceId: string,
  origins: { httpOrigin: string; wsOrigin: string }
) {
  const url = tab.currentUrl || surface.currentUrl || surface.url || "about:blank";
  const title = tab.title || surface.title || surface.label || url;
  const encodedSurfaceId = encodePathSegment(surfaceId);
  return {
    description: "",
    devtoolsFrontendUrl: `/devtools/inspector.html?ws=${origins.wsOrigin.replace(/^wss?:\/\//u, "")}/devtools/page/${encodedSurfaceId}`,
    id: surfaceId,
    title,
    type: "page",
    url,
    webSocketDebuggerUrl: `${origins.wsOrigin}/devtools/page/${encodedSurfaceId}`,
    containerId: surface.id,
    tabId: tab.tabId,
    surfaceKind: surface.surfaceKind,
    surfaceRole: surface.surfaceRole,
    surfaceLevel: surface.surfaceLevel,
    parentContainerId: surface.parentSurfaceId || "",
    interaction: surface.interaction,
    open: surface.open,
    isLoading: Boolean(tab.isLoading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    surfaceRoute: surface.surfaceRoute || "",
    copilotAgentKey: surface.copilotAgentKey || ""
  };
}

export function targetInfoDescriptor(surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab, surfaceId: string, current: boolean) {
  const url = tab.currentUrl || surface.currentUrl || surface.url || "about:blank";
  const title = tab.title || surface.title || surface.label || url;
  return {
    attached: false,
    canAccessOpener: false,
    active: current,
    current,
    surfaceId,
    title,
    type: "webview",
    url,
    containerId: surface.id,
    tabId: tab.tabId,
    surfaceKind: surface.surfaceKind,
    surfaceRole: surface.surfaceRole,
    surfaceLevel: surface.surfaceLevel,
    parentContainerId: surface.parentSurfaceId || "",
    interaction: surface.interaction,
    open: surface.open,
    isLoading: Boolean(tab.isLoading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    surfaceRoute: surface.surfaceRoute || "",
    copilotAgentKey: surface.copilotAgentKey || ""
  };
}

