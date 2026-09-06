import type { App } from "electron";

export type ServicesIntegrationPorts = {
  issueAgentAccessToken: (app: App, reason: any) => Promise<any>;
  getDesktopDeviceId: (app: App) => string;
  getDesktopDeviceInfo: (app: App) => any;
  ensureProviderRegisterApiKey: (app: App) => Promise<unknown>;
  resolveConversationAssetOrigin: (app: App) => any;
  emitPluginBridgeHook: (hook: string, payload: unknown) => void;
  getPluginBridgeEnv: (app: App, service: any) => NodeJS.ProcessEnv;
  getPluginSettingsEnv: (app: App, service: any) => NodeJS.ProcessEnv;
  initializePluginResourceState: (app: App, service: any) => any;
  readPluginResourceDesiredStatus: (app: App, service: any) => any;
  stopPluginResources: (app: App, service: any) => Promise<unknown>;
  syncPluginResources: (app: App, service: any, installDir: string) => Promise<unknown>;
};

export type ServiceCapabilityPorts = Pick<
  ServicesIntegrationPorts,
  "getDesktopDeviceId" | "getDesktopDeviceInfo"
>;

export function requireServicesIntegrationPorts(
  ports: ServicesIntegrationPorts | undefined
): ServicesIntegrationPorts {
  if (!ports) {
    throw new Error("Services integration ports must be supplied by the application composition root.");
  }
  return ports;
}
