import type { App } from "electron";
import type { AgentEngineSyncState } from "../../../shared/contracts/services";

export type ServicesIntegrationPorts = {
  readAgentEngineState?: (app: App, pluginId: string) => AgentEngineSyncState;
  agentEngines?: (app: App) => {
    prepareLaunch(): Promise<{ args: string[]; complete(success: boolean): void }>;
    hasAuthority(): boolean;
    stopped(): void;
    reconcile(): Promise<void>;
  };
  issueAgentAccessToken: (app: App, reason: any) => Promise<any>;
  getDesktopDeviceId: (app: App) => string;
  getDesktopDeviceInfo: (app: App) => any;
  ensureProviderRegisterApiKey: (app: App, preparation?: boolean) => Promise<unknown>;
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
