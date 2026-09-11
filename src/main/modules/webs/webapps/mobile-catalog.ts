import type { App } from "electron";
import type {
  DesktopMobileWebappCatalog,
  DesktopMobileWebappItem
} from "../../../../shared/contracts";
import { requireWebsIntegrationPorts, type WebsIntegrationPorts } from "../integration-ports";
import { createMobileTunnelWebappUrl } from "./mobile-access";
import { webappRuntime, type WebappRuntime } from "./runtime";
import {
  createDesktopMobileWebappItem,
  findOrderedWebapp,
  readOrderedWebappItems
} from "./mobile-view";

function tunnelConnected(ports?: WebsIntegrationPorts) {
  try {
    return requireWebsIntegrationPorts(ports).getTunnelHubRuntimeStatus().connected === true;
  } catch {
    return false;
  }
}

export function readDesktopMobileWebappItem(
  app: App,
  id: string,
  ports?: WebsIntegrationPorts,
  runtimeFacade: WebappRuntime = webappRuntime
): DesktopMobileWebappItem | null {
  const ordered = findOrderedWebapp(app, id);
  if (!ordered) {
    return null;
  }
  const runtime = runtimeFacade.getStatus(app, ordered.entry.id);
  const settings = requireWebsIntegrationPorts(ports).readTunnelHubSettings(app);
  return createDesktopMobileWebappItem({
    ...ordered,
    runtime,
    mobileConfigured: Boolean(settings.publicUrl),
    mobilePublicUrl: createMobileTunnelWebappUrl(app, runtime, ports),
    tunnelConnected: tunnelConnected(ports)
  });
}

export function createDesktopMobileWebappCatalog(
  app: App,
  ports?: WebsIntegrationPorts,
  runtimeFacade: WebappRuntime = webappRuntime
): DesktopMobileWebappCatalog {
  const integration = requireWebsIntegrationPorts(ports);
  const connected = tunnelConnected(ports);
  const settings = integration.readTunnelHubSettings(app);
  return {
    desktopDeviceId: integration.getDesktopDeviceId(app),
    tunnelConnected: connected,
    generatedAt: new Date().toISOString(),
    items: readOrderedWebappItems(app).map((entry, order) => {
      const runtime = runtimeFacade.getStatus(app, entry.id);
      return createDesktopMobileWebappItem({
        entry,
        order,
        runtime,
        mobileConfigured: Boolean(settings.publicUrl),
        mobilePublicUrl: createMobileTunnelWebappUrl(app, runtime, ports),
        tunnelConnected: connected
      });
    })
  };
}
