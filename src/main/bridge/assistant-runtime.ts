import type { App, BrowserWindow } from "electron";
import type {
  AssistantEvent,
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  DesktopMobileWebappItem,
  DesktopAppInfo,
  DesktopWebappChangedReason,
  DesktopWsServerStartOptions
} from "../../shared/contracts";
import { AgentPlatformAssistantBridge } from "../assistant/core/agent-platform-bridge";
import { AssistantNavigationStatusClient } from "../assistant/core/assistant-navigation-status-client";
import { callDesktopActionConfirmation, callDesktopActionRenderer } from "../desktop-action-renderer";
import {
  handleAgentPlatformDesktopActionRequest,
  handleDesktopActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge
} from "../desktop-action-bridge";
import {
  emitDesktopWsPush,
  getDesktopWsServerRuntimeState,
  startDesktopWsServer,
  stopDesktopWsServer
} from "../desktop-ws-server";
import { createDesktopActionOptions, type MainProcessContext } from "../main-process-context";
import { createKanbanRuntime } from "../kanban-runtime";
import { configureTunnelHubRegistrationController } from "../tunnel-hub-registration";
import { configureTunnelHubRuntime } from "../tunnel-hub-runtime";
import type { AssistantRunWakeLock } from "./assistant-wake-lock";
import type { RealtimeBroker } from "../realtime/realtime-broker";
import {
  createDesktopMobileWebappCatalog,
  readDesktopMobileWebappItem
} from "../webs/webapps/mobile-catalog";
import { webappManager } from "../webs/webapps/manager";

export type AssistantBridgeRuntimeOptions = {
  app: App;
  desktopAppInfo: DesktopAppInfo;
  context: MainProcessContext;
  assistantRunWakeLock: AssistantRunWakeLock;
  cdpIntegration: any;
  getResponsiveServiceState: (app: App, serviceId: string) => Promise<any>;
  issueAgentAccessToken: (app: App, reason: any) => Promise<any>;
  realtimeBroker: RealtimeBroker;
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
  handleDesktopPetAssistantEvent: (event: AssistantEvent) => void;
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
  const state = options.context.state;
  let desktopWsServerLastError = "";

  const assistantBridge = new AgentPlatformAssistantBridge({
    app: options.app,
    getServiceState: options.getResponsiveServiceState,
    issueAccessToken: options.issueAgentAccessToken,
    realtimeBroker: options.realtimeBroker,
    wakeLock: options.assistantRunWakeLock,
    onEvent: (event) => {
      emitDesktopWsPush("assistant.event", event);
      const targetWindow = state.mainWindow;
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("assistant.event", event);
      }
      options.handleDesktopPetAssistantEvent(event);
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
        resolvedItem = readDesktopMobileWebappItem(options.app, webappId);
      } catch (error) {
        console.warn(`[webapp] failed to build mobile change item for ${webappId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    emitDesktopWsPush("webapp.changed", {
      reason,
      webappId,
      changedAt,
      item: resolvedItem
    });
    const targetWindow = state.mainWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("webs.changed", {
        changedAt,
        webappId,
        reason
      });
    }
  }
  webappManager.runtime.setPublicationChangeListener(emitWebappChanged);

  const desktopActionOptions = createDesktopActionOptions(options.context, {
    assistantBridge,
    desktopAppInfo: options.desktopAppInfo,
    navigate: options.showMainWindow,
    openLogViewer: options.openLogViewerWindow,
    showFileDialog: options.showFileDialog,
    showSaveDialog: options.showSaveDialog,
    callRendererAction: (request) => callDesktopActionRenderer(request, {
      getMainWindow: () => state.mainWindow,
      pendingRequests: state.desktopActionRendererRequests
    }),
    confirmRendererAction: (request) => callDesktopActionConfirmation(request, {
      getMainWindow: () => state.mainWindow,
      pendingRequests: state.desktopActionConfirmationRequests
    }),
    cdpIntegration: options.cdpIntegration,
    emitWebappChanged,
    desktopPet: options.desktopPet
  });
  options.realtimeBroker.setDesktopBridgeProvider({
    action: (request) => handleAgentPlatformDesktopActionRequest(desktopActionOptions, request as any),
    cdp: (request) => handleDesktopCdpRequest(desktopActionOptions, request as any),
  });

  const desktopWsServerOptions = {
    app: options.app,
    desktopActionOptions,
    assistantBridge,
    getKanbanRuntime: () => state.kanbanRuntime,
    listMobileWebapps: () => createDesktopMobileWebappCatalog(options.app),
    issueAccessToken: options.issueAgentAccessToken,
    agentPlatformBridge: {
      getServiceState: options.getResponsiveServiceState,
      issueAccessToken: options.issueAgentAccessToken,
      realtimeBroker: options.realtimeBroker
    },
    logger: console
  };

  function startKanbanAndNavigation() {
    state.kanbanRuntime = createKanbanRuntime({
      app: options.app,
      assistantBridge,
      callAgentPlatform: options.callAgentPlatform as any,
      listLocalAgents: options.listKanbanLocalAgents,
      canUseDesktopSsoCredentials: options.canUseDesktopSsoCredentials,
      onChanged: options.emitKanbanChanged,
      onDebug: (message) => {
        options.logger.warn(`[kanban] ${message}`);
      }
    });
    state.kanbanRuntime.start();
    state.assistantNavigationStatusClient = new AssistantNavigationStatusClient({
      app: options.app,
      getServiceState: options.getResponsiveServiceState,
      issueAccessToken: options.issueAgentAccessToken,
      realtimeBroker: options.realtimeBroker,
      onSnapshot: options.emitAssistantNavigationAgentsChanged,
      onPushEvent: (event) => {
        if (event.type === "run.started" || event.type === "run.finished") {
          state.kanbanRuntime?.sendNavigationPushEvent(event);
        }
        options.emitAssistantNavigationPushEvent(event);
      },
      onDebug: (message) => {
        options.logger.warn(`[assistant-navigation] status unavailable: ${message}`);
      }
    });
    state.assistantNavigationStatusClient.start();
  }

  function refreshDesktopActionBridge() {
    startDesktopActionBridge({
      ...desktopActionOptions
    });
  }

  function configureRemoteRuntimes() {
    refreshDesktopActionBridge();
    configureTunnelHubRegistrationController({
      refreshIdentityToken: options.refreshDesktopSsoAccessToken,
      logger: console
    });
    configureTunnelHubRuntime({
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
      return await startDesktopWsServer({
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
    await stopDesktopWsServer();
    return getDesktopWsServerRuntimeState();
  }

  return {
    assistantBridge,
    realtimeBroker: options.realtimeBroker,
    desktopActionOptions,
    desktopWsServerOptions,
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
      const runtimeState = getDesktopWsServerRuntimeState();
      return desktopWsServerLastError ? { ...runtimeState, message: desktopWsServerLastError } : runtimeState;
    },
    startDesktopWsServerForSettings,
    stopDesktopWsServerForSettings,
    emitWebappChanged,
    refreshDesktopActionBridge,
    stop() {
      options.realtimeBroker.setDesktopBridgeProvider(null);
      webappManager.runtime.setPublicationChangeListener(null);
      void options.cdpIntegration.stop();
      stopDesktopActionBridge();
      void stopDesktopWsServer();
      state.kanbanRuntime?.stop();
      state.kanbanRuntime = null;
      state.assistantNavigationStatusClient?.stop();
      state.assistantNavigationStatusClient = null;
      assistantBridge.dispose();
    }
  };
}

export type AssistantBridgeRuntime = ReturnType<typeof createAssistantBridgeRuntime>;
