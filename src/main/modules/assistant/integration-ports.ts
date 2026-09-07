import type { SiteCdpScope } from "../web-surfaces";
import type { App } from "electron";

export type AssistantIntegrationPorts = {
  callDesktopActionConfirmation: (request: any, options: any) => Promise<any>;
  callDesktopActionRenderer: (request: any, options: any) => Promise<any>;
  handleAgentPlatformDesktopActionRequest: (options: any, request: any) => Promise<any>;
  handleDesktopCdpRequest: (options: any, request: any, scope?: SiteCdpScope) => Promise<any>;
  startDesktopActionBridge: (options: any) => unknown;
  stopDesktopActionBridge: () => unknown;
  emitDesktopWsPush: (type: any, payload: any) => unknown;
  getDesktopWsServerRuntimeState: () => any;
  startDesktopWsServer: (options: any) => Promise<any>;
  stopDesktopWsServer: () => Promise<unknown>;
  createDesktopActionOptions: (context: any, dependencies: any) => any;
  createKanbanRuntime: (options: any) => any;
  configureTunnelHubRegistrationController: (options: any) => unknown;
  configureTunnelHubRuntime: (options: any) => unknown;
  createDesktopMobileWebappCatalog: (app: App) => any;
  readDesktopMobileWebappItem: (app: App, webappId: string) => any;
  setWebappPublicationChangeListener: (listener: any) => void;
};

export function createAssistantIntegrationPorts(ports: AssistantIntegrationPorts): AssistantIntegrationPorts {
  return ports;
}
