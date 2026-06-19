import type { App } from "electron";
import type { DesktopPetTaskItem } from "../../shared/contracts";
import {
  configurePluginBridge,
  emitPluginBridgeHook,
  publishPluginBridgeAssistantActiveTasks,
  publishPluginBridgeServiceState,
  setPluginBridgeDesktopReady,
  stopPluginBridgeServers
} from "../plugin-bridge";
import {
  hideDesktopActivityIsland,
  hideDesktopClipboardPalette,
  showDesktopPetBanner,
  showSystemUpdateOverlay,
  updateDesktopActivityIsland
} from "../plugin-desktop-effects";
import type { PluginClipboardBridge } from "./plugin-clipboard";

export type PluginBridgeRuntimeOptions = {
  app: App;
  clipboardBridge: PluginClipboardBridge;
  getServiceState: (serviceId: string) => Promise<any>;
  listServices: (app: App) => Promise<any[]>;
  retryPendingPluginResourceSync: (app: App) => Promise<unknown>;
  notifyAgentPlatformConfigChanged: () => void;
  getAssistantActiveTasks: () => unknown;
  onError: (message: string, details: Record<string, unknown>) => void;
};

export function createPluginBridgeRuntime(options: PluginBridgeRuntimeOptions) {
  let lastAssistantActiveTasksSignature = "";

  function configure() {
    configurePluginBridge({
      getServiceState: options.getServiceState,
      notifyAgentPlatformConfigChanged: options.notifyAgentPlatformConfigChanged,
      runDesktopPetBanner: (params) => showDesktopPetBanner(options.app, params as any),
      showSystemUpdateOverlay: (params) => showSystemUpdateOverlay(params as any),
      getAssistantActiveTasks: options.getAssistantActiveTasks,
      updateDesktopActivityIsland: (params) => updateDesktopActivityIsland(params as any),
      hideDesktopActivityIsland: () => hideDesktopActivityIsland(),
      readDesktopClipboardText: () => options.clipboardBridge.readDesktopClipboardText(),
      writeDesktopClipboardText: (params) => options.clipboardBridge.writeDesktopClipboardText(params),
      registerDesktopClipboardShortcut: (pluginId, params) =>
        options.clipboardBridge.registerDesktopClipboardShortcut(pluginId, params),
      unregisterDesktopClipboardShortcut: (pluginId) =>
        options.clipboardBridge.unregisterDesktopClipboardShortcut(pluginId),
      showDesktopClipboardPalette: (pluginId, params) =>
        options.clipboardBridge.showDesktopClipboardPaletteForPlugin(pluginId, params),
      hideDesktopClipboardPalette: (pluginId) =>
        options.clipboardBridge.hideDesktopClipboardPaletteForPlugin(pluginId),
      cleanupPluginBridgePlugin: options.clipboardBridge.cleanupPlugin
    });
  }

  async function publishServiceStates() {
    try {
      const services = await options.listServices(options.app);
      for (const service of services) {
        publishPluginBridgeServiceState(service);
      }
      const agentPlatform = services.find((service) => service.id === "agent-platform");
      if (agentPlatform?.status === "running") {
        void options.retryPendingPluginResourceSync(options.app).catch((error) => {
          options.onError("failed to retry pending plugin resource sync", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    } catch (error) {
      options.onError("failed to publish plugin bridge service states", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function publishAssistantActiveTasks(tasks: DesktopPetTaskItem[], runningTaskCount: number) {
    const signature = JSON.stringify({
      runningTaskCount,
      tasks: tasks.map((task) => ({
        id: task.id,
        runId: task.runId,
        status: task.status,
        title: task.title,
        preview: task.preview,
        updatedAt: task.updatedAt
      }))
    });
    if (signature === lastAssistantActiveTasksSignature) {
      return;
    }
    lastAssistantActiveTasksSignature = signature;
    publishPluginBridgeAssistantActiveTasks(tasks, runningTaskCount);
  }

  return {
    configure,
    publishServiceStates,
    publishAssistantActiveTasks,
    setDesktopReady: setPluginBridgeDesktopReady,
    emitBeforeQuit() {
      emitPluginBridgeHook("desktop.beforeQuit", {});
    },
    stop() {
      hideDesktopActivityIsland();
      hideDesktopClipboardPalette();
      stopPluginBridgeServers();
    }
  };
}

export type PluginBridgeRuntime = ReturnType<typeof createPluginBridgeRuntime>;
