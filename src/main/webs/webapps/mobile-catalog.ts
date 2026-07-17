import type { App } from "electron";
import type {
  DesktopMobileWebappCatalog,
  DesktopMobileWebappItem
} from "../../../shared/contracts";
import { getDesktopDeviceId } from "../../device-identity";
import { getTunnelHubRuntimeStatus } from "../../tunnel-hub-runtime";
import { readWebappPublishState } from "./publisher";
import { webappRuntime } from "./runtime";
import {
  createDesktopMobileWebappItem,
  findOrderedWebapp,
  readOrderedWebappItems
} from "./mobile-view";

function tunnelConnected() {
  try {
    return getTunnelHubRuntimeStatus().connected === true;
  } catch {
    return false;
  }
}

export function readDesktopMobileWebappItem(app: App, id: string): DesktopMobileWebappItem | null {
  const ordered = findOrderedWebapp(app, id);
  if (!ordered) {
    return null;
  }
  return createDesktopMobileWebappItem({
    ...ordered,
    runtime: webappRuntime.getStatus(app, ordered.entry.id),
    publishState: readWebappPublishState(app, ordered.entry.id),
    tunnelConnected: tunnelConnected()
  });
}

export function createDesktopMobileWebappCatalog(app: App): DesktopMobileWebappCatalog {
  const connected = tunnelConnected();
  return {
    desktopDeviceId: getDesktopDeviceId(app),
    tunnelConnected: connected,
    generatedAt: new Date().toISOString(),
    items: readOrderedWebappItems(app).map((entry, order) => createDesktopMobileWebappItem({
      entry,
      order,
      runtime: webappRuntime.getStatus(app, entry.id),
      publishState: readWebappPublishState(app, entry.id),
      tunnelConnected: connected
    }))
  };
}
