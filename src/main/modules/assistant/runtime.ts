import type { App, BrowserWindow } from "electron";
import type {
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  DesktopMobileWebappItem,
  DesktopAppInfo,
  DesktopActionConfirmationResponse,
  DesktopActionRendererResponse,
  DesktopPageContextSnapshot,
  DesktopWebappChangedReason,
  DesktopWsServerStartOptions
} from "../../../shared/contracts";
import { AgentPlatformAssistantBridge } from "../agent-platform";
import type { AgentPlatformAssistantBridgePorts } from "../agent-platform";
import { AssistantNavigationStatusClient } from "./navigation-status-client";
import type { AssistantIntegrationPorts } from "./integration-ports";
import type { AssistantRunWakeLock } from "./wake-lock";
import type { RealtimeBroker } from "../agent-platform";

export type AssistantBridgeRuntimeOptions = {
  integrationPorts: AssistantIntegrationPorts;
  app: App;
  desktopAppInfo: DesktopAppInfo;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
  assistantRunWakeLock: AssistantRunWakeLock;
  cdpIntegration: any;
  getResponsiveServiceState: (app: App, serviceId: string) => Promise<any>;
  issueAgentAccessToken: (app: App, reason: any) => Promise<any>;
  realtimeBroker: RealtimeBroker;
  agentPlatformPorts: AgentPlatformAssistantBridgePorts;
  refreshDesktopSsoAccessToken?: () => Promise<string>;
  canUseDesktopSsoCredentials?: () => boolean;
  callAgentPlatform: (...args: any[]) => unknown;
  showMainWindow: (targetPath?: string) => void;
  showFileDialog: (...args: any[]) => Promise<any>;
  showSaveDialog: (...args: any[]) => Promise<any>;
  openLogViewerWindow: (...args: any[]) => unknown;
  listKanbanLocalAgents: () => any[];
  emitKanbanChanged: () => void;
  emitAssistantNavigationAgentsChanged: (result: AssistantNavAgentItemsResult) => void;
  emitAssistantNavigationPushEvent: (event: AssistantNavigationPushEvent) => void;
  onTunnelConnected?: () => Promise<unknown> | unknown;
  desktopPet: {
    refreshState: (...args: any[]) => unknown;
    showWindow: (...args: any[]) => unknown;
    hideWindow: (...args: any[]) => unknown;
    saveSettings: (...args: any[]) => unknown;
  };
  safeConsoleError: (message: string, details: Record<string, unknown>) => void;
  logger: Pick<Console, "warn">;
};

export function createAssistantBridgeRuntime(options: AssistantBridgeRuntimeOptions) {
  const integration = options.integrationPorts;
  let kanbanRuntime: any = null;
  let assistantNavigationStatusClient: AssistantNavigationStatusClient | null = null;
  const desktopActionRendererRequests = new Map<string, {
    resolve: (response: DesktopActionRendererResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const desktopActionConfirmationRequests = new Map<string, {
    resolve: (response: DesktopActionConfirmationResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  let desktopWsServerLastError = "";

  const assistantBridge = new AgentPlatformAssistantBridge({
    app: options.app,
    getServiceState: options.getResponsiveServiceState,
    issueAccessToken: options.issueAgentAccessToken,
    ports: options.agentPlatformPorts,
    realtimeBroker: options.realtimeBroker,
    wakeLock: options.assistantRunWakeLock,
    onEvent: (event) => {
      integration.emitDesktopWsPush("assistant.event", event);
      const targetWindow = options.getMainWindow();
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("assistant.event", event);
      }
    }
  });

  function emitWebappChanged(
    reason: DesktopWebappChangedReason,
    webappId: string,
    item?: DesktopMobileWebappItem | null
  ) {
    const changedAt = new Date().toISOString();
    let resolvedItem = item ?? null;
    if (item === undefined) {
      try {
        resolvedItem = integration.readDesktopMobileWebappItem(options.app, webappId);
      } catch (error) {
        console.warn(`[webapp] failed to build mobile change item for ${webappId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    integration.emitDesktopWsPush("webapp.changed", {
      reason,
      webappId,
      changedAt,
      item: resolvedItem
    });
    const targetWindow = options.getMainWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("webs.changed", {
        changedAt,
        webappId,
        reason
      });
    }
  }
  integration.setWebappPublicationChangeListener(emitWebappChanged);

  const desktopActionOptions = integration.createDesktopActionOptions({
    app: options.app,
    platform: options.platform,
    getMainWindow: options.getMainWindow,
    getCurrentPageSnapshot: options.getCurrentPageSnapshot,
    getKanbanRuntime: () => kanbanRuntime
  }, {
    assistantBridge,
    desktopAppInfo: options.desktopAppInfo,
    navigate: options.showMainWindow,
    openLogViewer: options.openLogViewerWindow,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    callRendererAction: (request: any) => integration.callDesktopActionRenderer(request, {
      getMainWindow: options.getMainWindow,
      pendingRequests: desktopActionRendererRequests
    }),
    confirmRendererAction: (request: any) => integration.callDesktopActionConfirmation(request, {
      getMainWindow: options.getMainWindow,
      pendingRequests: desktopActionConfirmationRequests
    }),
    executeCdpCommand: async (request: unknown) => options.cdpIntegration.start().executeCommand(request),
    emitWebappChanged,
    desktopPet: options.desktopPet
  });
  options.realtimeBroker.setDesktopBridgeProvider({
    action: (request) => integration.handleAgentPlatformDesktopActionRequest(desktopActionOptions, request as any),
    cdp: (request) => integration.handleDesktopCdpRequest(desktopActionOptions, request as any),
  });

  const desktopWsServerOptions = {
    app: options.app,
    desktopActionOptions,
    assistantBridge,
    getKanbanRuntime: () => kanbanRuntime,
    listMobileWebapps: () => integration.createDesktopMobileWebappCatalog(options.app),
    issueAccessToken: options.issueAgentAccessToken,
    agentPlatformBridge: {
      getServiceState: options.getResponsiveServiceState,
      issueAccessToken: options.issueAgentAccessToken,
      realtimeBroker: options.realtimeBroker
    },
    logger: console
  };

  function startKanbanAndNavigation() {
    kanbanRuntime = integration.createKanbanRuntime({
      app: options.app,
      assistantBridge,
      callAgentPlatform: options.callAgentPlatform as any,
      listLocalAgents: options.listKanbanLocalAgents,
      canUseDesktopSsoCredentials: options.canUseDesktopSsoCredentials,
      onChanged: options.emitKanbanChanged,
      onDebug: (message: string) => {
        options.logger.warn(`[kanban] ${message}`);
      }
    });
    kanbanRuntime.start();
    assistantNavigationStatusClient = new AssistantNavigationStatusClient({
      app: options.app,
      getServiceState: options.getResponsiveServiceState,
      issueAccessToken: options.issueAgentAccessToken,
      realtimeBroker: options.realtimeBroker,
      onSnapshot: options.emitAssistantNavigationAgentsChanged,
      onPushEvent: (event) => {
        if (event.type === "run.started" || event.type === "run.finished") {
          kanbanRuntime?.sendNavigationPushEvent(event);
        }
        options.emitAssistantNavigationPushEvent(event);
      },
      onDebug: (message) => {
        options.logger.warn(`[assistant-navigation] status unavailable: ${message}`);
      }
    });
    assistantNavigationStatusClient.start();
  }

  function refreshDesktopActionBridge() {
    integration.startDesktopActionBridge({
      ...desktopActionOptions
    });
  }

  function configureRemoteRuntimes() {
    refreshDesktopActionBridge();
    integration.configureTunnelHubRegistrationController({
      refreshIdentityToken: options.refreshDesktopSsoAccessToken,
      logger: console
    });
    integration.configureTunnelHubRuntime({
      app: options.app,
      desktopWsServerOptions,
      onConnected: options.onTunnelConnected,
      canUseDesktopSsoCredentials: options.canUseDesktopSsoCredentials,
      logger: console
    });
  }

  async function startDesktopWsServerForSettings(startOptions?: DesktopWsServerStartOptions) {
    desktopWsServerLastError = "";
    try {
      return await integration.startDesktopWsServer({
        ...desktopWsServerOptions,
        ...startOptions
      });
    } catch (error) {
      desktopWsServerLastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async function stopDesktopWsServerForSettings() {
    desktopWsServerLastError = "";
    await integration.stopDesktopWsServer();
    return integration.getDesktopWsServerRuntimeState();
  }

  return {
    assistantBridge,
    realtimeBroker: options.realtimeBroker,
    desktopActionOptions,
    desktopWsServerOptions,
    getKanbanRuntime: () => kanbanRuntime,
    getNavigationStatusClient: () => assistantNavigationStatusClient,
    getNavigationSnapshot: () => assistantNavigationStatusClient?.getSnapshot(),
    scheduleNavigationRefresh: (delayMs: number) => assistantNavigationStatusClient?.scheduleRefresh(delayMs),
    refreshKanbanDeviceInfo: () => kanbanRuntime?.refreshDeviceInfo(),
    desktopActionRendererRequests,
    desktopActionConfirmationRequests,
    start() {
      startKanbanAndNavigation();
      options.cdpIntegration.start();
      configureRemoteRuntimes();
    },
    startDesktopWsServerIfEnabled(enabled: boolean) {
      if (!enabled) {
        return;
      }
      void startDesktopWsServerForSettings().catch((error) => {
        options.safeConsoleError("failed to start Desktop WS server", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    },
    getDesktopWsServerRuntimeStateForSettings() {
      const runtimeState = integration.getDesktopWsServerRuntimeState();
      return desktopWsServerLastError ? { ...runtimeState, message: desktopWsServerLastError } : runtimeState;
    },
    startDesktopWsServerForSettings,
    stopDesktopWsServerForSettings,
    emitWebappChanged,
    refreshDesktopActionBridge,
    stop() {
      options.realtimeBroker.setDesktopBridgeProvider(null);
      integration.setWebappPublicationChangeListener(null);
      void options.cdpIntegration.stop();
      integration.stopDesktopActionBridge();
      void integration.stopDesktopWsServer();
      kanbanRuntime?.stop();
      kanbanRuntime = null;
      assistantNavigationStatusClient?.stop();
      assistantNavigationStatusClient = null;
      assistantBridge.dispose();
    }
  };
}

export type AssistantBridgeRuntime = ReturnType<typeof createAssistantBridgeRuntime>;
