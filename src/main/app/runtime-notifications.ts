import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import type {
  AssistantAttachmentTaskProgress,
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  WebsChangedEvent
} from "../../shared/contracts";
import { type AssistantBridgeRuntime } from "../modules/assistant";
import {
  emitDesktopWsPush
} from "../modules/desktop-protocol";
import { type DesktopPetRuntime } from "../modules/pet";
import { type PluginBridgeRuntime } from "../modules/plugins";
import { type AppShellRuntime } from "../modules/shell";
import {
  isStartupPhaseAtLeast
} from "./lifecycle/startup-phases";
import { createMainAppState } from "./state";
export interface NotifyServicesChangedDependencies {
  readonly notifyCoreServicesChanged: () => void;
  readonly notifyDesktopDecorationsChanged: () => void;
}

export function notifyServicesChanged(dependencies: NotifyServicesChangedDependencies) {
  dependencies.notifyCoreServicesChanged();
  dependencies.notifyDesktopDecorationsChanged();
}

export interface NotifyCoreServicesChangedDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "startupPhase">;
  readonly pluginBridgeRuntime: Pick<PluginBridgeRuntime, "publishServiceStates">;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "scheduleNavigationRefresh">;
  readonly getMainWindow: () => BrowserWindow | null;
}

export function notifyCoreServicesChanged(dependencies: NotifyCoreServicesChangedDependencies) {
  if (!isStartupPhaseAtLeast(dependencies.appState.startupPhase, "shell-ready")) {
    console.info(`[main] skipped core service notification before shell-ready: ${dependencies.appState.startupPhase}`);
    return;
  }
  void dependencies.pluginBridgeRuntime.publishServiceStates();
  emitDesktopWsPush("service.changed", { changedAt: new Date().toISOString() });
  dependencies.assistantBridgeRuntime?.scheduleNavigationRefresh(1000);
  const targetWindow = dependencies.getMainWindow();
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("services.changed");
  }
}

export interface NotifyDesktopDecorationsChangedDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "startupPhase">;
  readonly refreshPluginDesktopGlobalShortcuts: () => void;
}

export function notifyDesktopDecorationsChanged(dependencies: NotifyDesktopDecorationsChangedDependencies) {
  if (dependencies.appState.startupPhase !== "non-core-ready") {
    return;
  }
  if (app.isReady()) {
    dependencies.refreshPluginDesktopGlobalShortcuts();
  }
}

export interface EmitWebsChangedDependencies {
  readonly getMainWindow: () => BrowserWindow | null;
}

export function emitWebsChanged(dependencies: EmitWebsChangedDependencies, details: Partial<Omit<WebsChangedEvent, "changedAt">>) {
  const payload: WebsChangedEvent = {
    changedAt: new Date().toISOString(),
    ...details
  };
  const targetWindow = dependencies.getMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send("webs.changed", payload);
}

export interface EmitKanbanChangedDependencies {
  readonly getMainWindow: () => BrowserWindow | null;
}

export function emitKanbanChanged(dependencies: EmitKanbanChangedDependencies) {
  emitDesktopWsPush("snapshot.updated", { changedAt: new Date().toISOString() });
  const targetWindow = dependencies.getMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send("kanban.changed");
}

export interface EmitAssistantNavigationAgentsChangedDependencies {
  readonly appShellRuntime: Pick<AppShellRuntime, "refreshTaskbarUnread" | "refreshTrayContextMenu">;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly petRuntime: Pick<DesktopPetRuntime, "isVisible">;
  readonly refreshDesktopPetState: DesktopPetRuntime["refreshState"];
}

export function emitAssistantNavigationAgentsChanged(dependencies: EmitAssistantNavigationAgentsChangedDependencies, result: AssistantNavAgentItemsResult) {
  dependencies.appShellRuntime.refreshTaskbarUnread(result);
  dependencies.appShellRuntime.refreshTrayContextMenu();
  const targetWindow = dependencies.getMainWindow();
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
  }
  if (dependencies.petRuntime.isVisible()) {
    dependencies.refreshDesktopPetState();
  }
}

export interface EmitAssistantNavigationPushEventDependencies {
  readonly getMainWindow: () => BrowserWindow | null;
}

export function emitAssistantNavigationPushEvent(dependencies: EmitAssistantNavigationPushEventDependencies, event: AssistantNavigationPushEvent) {
  const targetWindow = dependencies.getMainWindow();
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("assistant.navigationPushEvent", event);
  }
}

export interface EmitAssistantAttachmentProgressDependencies {
  readonly getMainWindow: () => BrowserWindow | null;
}

export function emitAssistantAttachmentProgress(dependencies: EmitAssistantAttachmentProgressDependencies, progress: AssistantAttachmentTaskProgress) {
  const targetWindow = dependencies.getMainWindow();
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("assistant.attachmentProgress", progress);
  }
}

