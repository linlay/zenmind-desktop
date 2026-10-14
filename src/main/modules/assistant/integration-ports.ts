import type { SiteControlScope } from "../web-surfaces";
import type { App } from "electron";
import type { DesktopWsServerOptions, startDesktopWsServer } from "../desktop-protocol";
import type { configureTunnelHubRuntime } from "../tunnel";

export type AssistantIntegrationPorts = {
  callDesktopActionConfirmation: (request: any, options: any) => Promise<any>;
  callDesktopActionRenderer: (request: any, options: any) => Promise<any>;
  handleAgentPlatformDesktopActionRequest: (options: any, request: any) => Promise<any>;
  handleDesktopCdpRequest: (options: any, request: any, scope?: SiteControlScope, signal?: AbortSignal, trustedRunSource?: boolean) => Promise<any>;
  startDesktopActionBridge: (options: any) => unknown;
  stopDesktopActionBridge: () => unknown;
  emitDesktopWsPush: (type: any, payload: any) => unknown;
  getDesktopWsServerRuntimeState: () => any;
  validateTunnelAccountRouteCredential: (app: App, credential: string) => ReturnType<NonNullable<DesktopWsServerOptions["verifyAccountRoute"]>>;
  ensureIdentityCenterJwk: DesktopWsServerOptions["ensureIdentityCenterJwk"];
  startDesktopWsServer: typeof startDesktopWsServer;
  stopDesktopWsServer: () => Promise<unknown>;
  createDesktopActionOptions: (context: any, dependencies: any) => any;
  createKanbanRuntime: (options: any) => any;
  configureTunnelHubRegistrationController: (options: any) => unknown;
  configureTunnelHubRuntime: typeof configureTunnelHubRuntime;
  createDesktopMobileWebappCatalog: (app: App) => any;
  readDesktopMobileWebappItem: (app: App, webappId: string) => any;
  setWebappPublicationChangeListener: (listener: any) => void;
};

export function createAssistantIntegrationPorts(ports: AssistantIntegrationPorts): AssistantIntegrationPorts {
  return ports;
}
