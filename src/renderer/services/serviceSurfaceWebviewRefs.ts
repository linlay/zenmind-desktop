import type { MutableRefObject } from "react";

export type ServiceSurfaceWebviewRef = MutableRefObject<Electron.WebviewTag | null>;

let activeServiceSurfaceId: string | null = null;
const serviceSurfaceWebviewRefs = new Map<string, ServiceSurfaceWebviewRef>();

export function setActiveServiceSurfaceId(surfaceId: string | null) {
  activeServiceSurfaceId = surfaceId;
}

export function registerServiceSurfaceWebviewRef(
  surfaceId: string,
  webviewRef: ServiceSurfaceWebviewRef,
) {
  if (!surfaceId) {
    return () => undefined;
  }

  serviceSurfaceWebviewRefs.set(surfaceId, webviewRef);
  return () => {
    if (serviceSurfaceWebviewRefs.get(surfaceId) === webviewRef) {
      serviceSurfaceWebviewRefs.delete(surfaceId);
    }
  };
}

export function getActiveServiceSurfaceId() {
  return activeServiceSurfaceId;
}

export function getActiveServiceSurfaceWebviewRef() {
  return activeServiceSurfaceId
    ? serviceSurfaceWebviewRefs.get(activeServiceSurfaceId) ?? null
    : null;
}

export function getActiveServiceSurfaceWebview() {
  return getActiveServiceSurfaceWebviewRef()?.current ?? null;
}
