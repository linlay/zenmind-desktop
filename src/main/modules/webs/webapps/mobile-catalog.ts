import type { App } from "electron";
import type {
  DesktopMobileWebappCatalog,
  DesktopMobileWebappItem,
  WebappEntry
} from "../../../../shared/contracts";
import type { WebsIntegrationPorts } from "../integration-ports";
import { applyWebOrder } from "../order-store";
import type { WebappManager } from "./manager";
import { createMobileTunnelWebappUrl } from "./mobile-access";
import { createDesktopMobileWebappItem } from "./mobile-view";

function readOrderedWebappItems(app: App, manager: WebappManager): WebappEntry[] {
  return applyWebOrder(app, manager.list(app)) as WebappEntry[];
}

export function readDesktopMobileWebappItem(
  app: App,
  id: string,
  ports: WebsIntegrationPorts,
  manager: WebappManager
): DesktopMobileWebappItem | null {
  const items = readOrderedWebappItems(app, manager);
  const order = items.findIndex((item) => item.id === id.trim());
  if (order < 0) {
    return null;
  }
  const entry = items[order];
  const runtime = manager.runtime.getStatus(app, entry.id);
  const settings = ports.readTunnelHubSettings(app);
  return createDesktopMobileWebappItem({
    entry,
    order,
    runtime,
    mobileConfigured: Boolean(settings.publicUrl),
    mobilePublicUrl: createMobileTunnelWebappUrl(app, runtime, ports),
    tunnelConnected: ports.getTunnelHubRuntimeStatus().connected === true
  });
}

export function createDesktopMobileWebappCatalog(
  app: App,
  ports: WebsIntegrationPorts,
  manager: WebappManager
): DesktopMobileWebappCatalog {
  const connected = ports.getTunnelHubRuntimeStatus().connected === true;
  const settings = ports.readTunnelHubSettings(app);
  return {
    desktopDeviceId: ports.getDesktopDeviceId(app),
    tunnelConnected: connected,
    generatedAt: new Date().toISOString(),
    items: readOrderedWebappItems(app, manager).map((entry, order) => {
      const runtime = manager.runtime.getStatus(app, entry.id);
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
