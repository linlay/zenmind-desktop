import type { App, BrowserWindow } from "electron";
import type { AssistantEvent, AssistantNavAgentItemsResult, AssistantNavigationPushEvent, DesktopWsServerStartOptions } from "../../shared/contracts";
import { AgentPlatformAssistantBridge } from "../assistant/core/agent-platform-bridge";
import { AssistantNavigationStatusClient } from "../assistant/core/assistant-navigation-status-client";
import { callDesktopActionConfirmation, callDesktopActionRenderer } from "../desktop-action-renderer";
import {
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

export type AssistantBridgeRuntimeOptions = {
  app: App;
  context: MainProcessContext;
  assistantRunWakeLock: AssistantRunWakeLock;
  cdpIntegration: any;
  getResponsiveServiceState: (app: App, serviceId: string) => Promise<any>;
  issueAgentAccessToken: (app: App, reason: any) => Promise<any>;
  callAgentPlatform: (...args: any[]) => unknown;
  showMainWindow: (targetPath?: string) => void;
  openLogViewerWindow: (...args: any[]) => unknown;
  getQuickAssistantWindow: () => BrowserWindow | null;
  listKanbanLocalAgents: () => any[];
  emitKanbanChanged: () => void;
  emitAssistantNavigationAgentsChanged: (result: AssistantNavAgentItemsResult) => void;
  emitAssistantNavigationPushEvent: (event: AssistantNavigationPushEvent) => void;
  handleDesktopPetAssistantEvent: (event: AssistantEvent) => void;
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
    wakeLock: options.assistantRunWakeLock,
    onEvent: (event) => {
      state.kanbanRuntime?.sendAssistantEvent(event);
      emitDesktopWsPush("assistant.event", event);
      for (const targetWindow of [state.mainWindow, options.getQuickAssistantWindow()]) {
        if (!targetWindow || targetWindow.isDestroyed()) {
          continue;
        }
        targetWindow.webContents.send("assistant.event", event);
      }
      options.handleDesktopPetAssistantEvent(event);
    }
  });

  const desktopActionOptions = createDesktopActionOptions(options.context, {
    assistantBridge,
    navigate: options.showMainWindow,
    openLogViewer: options.openLogViewerWindow,
    callRendererAction: (request) => callDesktopActionRenderer(request, {
      getMainWindow: () => state.mainWindow,
      pendingRequests: state.desktopActionRendererRequests
    }),
    confirmRendererAction: (request) => callDesktopActionConfirmation(request, {
      getMainWindow: () => state.mainWindow,
      pendingRequests: state.desktopActionConfirmationRequests
    }),
    cdpIntegration: options.cdpIntegration,
    desktopPet: options.desktopPet
  });

  const desktopWsServerOptions = {
    app: options.app,
    desktopActionOptions,
    assistantBridge,
    getKanbanRuntime: () => state.kanbanRuntime,
    issueAccessToken: options.issueAgentAccessToken,
    agentPlatformBridge: {
      getServiceState: options.getResponsiveServiceState,
      issueAccessToken: options.issueAgentAccessToken
    },
    logger: console
  };

  function startKanbanAndNavigation() {
    state.kanbanRuntime = createKanbanRuntime({
      app: options.app,
      assistantBridge,
      callAgentPlatform: options.callAgentPlatform as any,
      listLocalAgents: options.listKanbanLocalAgents,
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
      onSnapshot: options.emitAssistantNavigationAgentsChanged,
      onPushEvent: (event) => {
        state.kanbanRuntime?.sendAssistantEvent(event);
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
      logger: console
    });
    configureTunnelHubRuntime({
      app: options.app,
      desktopWsServerOptions,
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
    refreshDesktopActionBridge,
    stop() {
      void options.cdpIntegration.stop();
      stopDesktopActionBridge();
      void stopDesktopWsServer();
      state.kanbanRuntime?.stop();
      state.kanbanRuntime = null;
      state.assistantNavigationStatusClient?.stop();
      state.assistantNavigationStatusClient = null;
    }
  };
}

export type AssistantBridgeRuntime = ReturnType<typeof createAssistantBridgeRuntime>;
