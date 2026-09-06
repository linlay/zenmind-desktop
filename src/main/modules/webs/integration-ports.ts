import type { App } from "electron";

export type WebsIntegrationPorts = {
  getDesktopDeviceId: (app: App) => string;
  getConfiguredDesktopActionBridgePort: (app: App) => number;
  readInstalledRecords: (app: App) => any[];
  removeInstalledRecordByResourceKey: (app: App, key: string, type: any) => unknown;
  installWebsiteAppArchiveFromPath: (app: App, archivePath: string, options?: any) => Promise<any>;
  deriveTunnelHubRegistrationApiOrigin: (settings: any) => string;
  getTunnelHubRuntimeStatus: () => any;
  startTunnelHubRuntime: () => Promise<any>;
  readTunnelHubRegistrationBearerToken: (app: App) => string;
  readTunnelHubSettings: (app: App) => any;
  saveTunnelHubSettings: (app: App, input: any) => any;
};

export function requireWebsIntegrationPorts(
  ports: WebsIntegrationPorts | undefined
): WebsIntegrationPorts {
  if (!ports) {
    throw new Error("Webs integration ports must be supplied by the application composition root.");
  }
  return ports;
}
