import type { MutableRefObject } from "react";

export type PluginSurfaceWebviewRef = MutableRefObject<Electron.WebviewTag | null>;

let activePluginSurfaceId: string | null = null;
const pluginSurfaceWebviewRefs = new Map<string, PluginSurfaceWebviewRef>();

export function setActivePluginSurfaceId(pluginId: string | null) {
  activePluginSurfaceId = pluginId;
}

export function registerPluginSurfaceWebviewRef(
  pluginId: string,
  webviewRef: PluginSurfaceWebviewRef,
) {
  if (!pluginId) {
    return () => undefined;
  }

  pluginSurfaceWebviewRefs.set(pluginId, webviewRef);
  return () => {
    if (pluginSurfaceWebviewRefs.get(pluginId) === webviewRef) {
      pluginSurfaceWebviewRefs.delete(pluginId);
    }
  };
}

export function getActivePluginSurfaceId() {
  return activePluginSurfaceId;
}

export function getActivePluginSurfaceWebviewRef() {
  return activePluginSurfaceId
    ? pluginSurfaceWebviewRefs.get(activePluginSurfaceId) ?? null
    : null;
}

export function getActivePluginSurfaceWebview() {
  return getActivePluginSurfaceWebviewRef()?.current ?? null;
}
