import type { BrowserWindow } from "electron";
import {
  app,
  globalShortcut,
  screen
} from "electron";
import type {
  AssistantWorkerOpenRequest
} from "../../../shared/contracts";
import { getMainPreloadPath } from "../../infrastructure/electron/bundle-paths";
import { loadRendererRoute } from "../../infrastructure/electron/renderer-route";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import {
  callAgentPlatform
} from "../../modules/desktop-actions";
import { issueAgentAccessToken } from "../../modules/identity";
import { createDesktopPetRuntime, type DesktopPetRuntime } from "../../modules/pet";
import { createPluginBridgeRuntime, createPluginClipboardBridge, invokePluginDesktopAction, refreshPluginGlobalShortcuts, retryPendingPluginResourceSync, type PluginBridgeRuntime } from "../../modules/plugins";
import {
  createServicesRuntime,
  getServiceState,
  type ServicesFacade
} from "../../modules/services";
import { type AppShellRuntime } from "../../modules/shell";
import { safeConsoleError } from "../../support/logging/safe-console";
import { createMainAppState } from "../state";
export interface AssembleDesktopPetDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "isHandlingQuit">;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "getNavigationSnapshot">;
  readonly MAIN_PRELOAD_PATH: ReturnType<typeof getMainPreloadPath>;
  readonly showMainWindow: AppShellRuntime["showMainWindow"];
  readonly openAssistantWorker: (request: AssistantWorkerOpenRequest) => Promise<void>;
  readonly pluginBridgeRuntime: Pick<PluginBridgeRuntime, "publishAssistantActiveTasks">;
  readonly appShellRuntime: Pick<AppShellRuntime, "refreshTrayContextMenu">;
}

export function assembleDesktopPet(dependencies: AssembleDesktopPetDependencies) {
  return createDesktopPetRuntime({
    app,
    platform: dependencies.startupPlatform,
    getMainWindow: dependencies.getMainWindow,
    isHandlingQuit: () => dependencies.appState.isHandlingQuit,
    getNavigationSnapshot: () => dependencies.assistantBridgeRuntime?.getNavigationSnapshot(),
    screen,
    preloadPath: dependencies.MAIN_PRELOAD_PATH,
    loadRendererRoute,
    showMainWindow: dependencies.showMainWindow,
    openAssistantWorker: dependencies.openAssistantWorker,
    publishPluginAssistantActiveTasks: (tasks, runningTaskCount) => dependencies.pluginBridgeRuntime.publishAssistantActiveTasks(tasks, runningTaskCount),
    refreshTrayContextMenu: () => dependencies.appShellRuntime.refreshTrayContextMenu()
  });
}

export interface AssemblePluginBridgeDependencies {
  readonly pluginClipboardBridge: ReturnType<typeof createPluginClipboardBridge>;
  readonly servicesFacade: Pick<ServicesFacade, "getServiceState" | "listServices">;
  readonly notifyServicesChanged: () => void;
  readonly petRuntime: Pick<DesktopPetRuntime, "getAssistantActiveTasksSnapshotForPlugins">;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
}

export function assemblePluginBridge(dependencies: AssemblePluginBridgeDependencies) {
  return createPluginBridgeRuntime({
    app,
    clipboardBridge: dependencies.pluginClipboardBridge,
    getServiceState: (serviceId) => dependencies.servicesFacade.getServiceState(app, serviceId),
    listServices: (targetApp) => dependencies.servicesFacade.listServices(targetApp),
    retryPendingPluginResourceSync,
    notifyAgentPlatformConfigChanged: () => dependencies.notifyServicesChanged(),
    getAssistantActiveTasks: () => dependencies.petRuntime.getAssistantActiveTasksSnapshotForPlugins(),
    queryAgentPlatform: (params) => callAgentPlatform(app, "/api/query", {
      issueAgentAccessToken: dependencies.issueAgentAccessToken,
      method: "POST",
      body: {
        message: params.message,
        ...(params.agentKey ? { agentKey: params.agentKey } : {}),
        params: {
          desktop: {
            source: params.source || "plugin",
            action: params.action || "query"
          }
        },
        stream: false
      }
    }),
    onError: safeConsoleError
  });
}

export interface RefreshPluginDesktopGlobalShortcutsDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly servicesRuntime: Pick<ReturnType<typeof createServicesRuntime>, "runServiceMutation" | "handleServiceStart">;
}

export function refreshPluginDesktopGlobalShortcuts(dependencies: RefreshPluginDesktopGlobalShortcutsDependencies) {
  return refreshPluginGlobalShortcuts({
    app,
    globalShortcut,
    platform: dependencies.startupPlatform,
    invokePluginAction: (serviceId, actionId) => {
      void dependencies.servicesRuntime.runServiceMutation(() => invokePluginDesktopAction({
        app,
        serviceId,
        actionId,
        getServiceState,
        handleServiceStart: dependencies.servicesRuntime.handleServiceStart
      })).catch((error) => {
        safeConsoleError("failed to invoke plugin global shortcut", {
          serviceId,
          actionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
}

