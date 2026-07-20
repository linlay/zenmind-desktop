import type { App } from "electron";
import type {
  DesktopMobileWebappCatalog,
  DesktopMobileWebappItem
} from "../../../shared/contracts";
import { getDesktopDeviceId } from "../../device-identity";
import { getTunnelHubRuntimeStatus } from "../../tunnel-hub-runtime";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";
import { createMobileTunnelWebappUrl } from "./mobile-access";
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
  const runtime = webappRuntime.getStatus(app, ordered.entry.id);
  const settings = readTunnelHubSettings(app);
  return createDesktopMobileWebappItem({
    ...ordered,
    runtime,
    mobileConfigured: Boolean(settings.publicUrl),
    mobilePublicUrl: createMobileTunnelWebappUrl(app, runtime),
    tunnelConnected: tunnelConnected()
  });
}

export function createDesktopMobileWebappCatalog(app: App): DesktopMobileWebappCatalog {
  const connected = tunnelConnected();
  const settings = readTunnelHubSettings(app);
  return {
    desktopDeviceId: getDesktopDeviceId(app),
    tunnelConnected: connected,
    generatedAt: new Date().toISOString(),
    items: readOrderedWebappItems(app).map((entry, order) => {
      const runtime = webappRuntime.getStatus(app, entry.id);
      return createDesktopMobileWebappItem({
        entry,
        order,
        runtime,
        mobileConfigured: Boolean(settings.publicUrl),
        mobilePublicUrl: createMobileTunnelWebappUrl(app, runtime),
        tunnelConnected: connected
      });
    })
  };
}
