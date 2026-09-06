import type { App, BrowserWindow } from "electron";
import type { DesktopAppInfo, DesktopPageContextSnapshot } from "../../../shared/contracts";
import type { AgentAuthIssueResult } from "../../../shared/contracts";
import type { KanbanRuntime } from "../kanban";
import type { ServicesFacade } from "../services";
import type { WebsFacade } from "../webs";
import { workPanelLocalFileRegistry } from "../work-panel";
import { createDesktopRuntimeDiagnostics } from "./runtime-info";

export interface DesktopActionRuntimeContext {
  app: App;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  getCurrentPageSnapshot: () => DesktopPageContextSnapshot | null;
  getKanbanRuntime: () => KanbanRuntime | null;
}

export interface DesktopActionContextDependencies {
  assistantBridge: unknown;
  issueAgentAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
  getAssistantSettings: (app: App) => { desktopHelperAgentKey: string };
  createContainerHubClient: (config: {
    baseURL: string;
    authToken?: string;
    timeoutMs?: number;
    defaultEnvironmentName?: string;
  }) => any;
  services: ServicesFacade;
  webs: WebsFacade;
  desktopAppInfo: DesktopAppInfo;
  navigate: (...args: any[]) => unknown;
  openLogViewer: (...args: any[]) => unknown;
  showFileDialog?: (...args: any[]) => unknown;
  showSaveDialog?: (...args: any[]) => unknown;
  callRendererAction: (...args: any[]) => unknown;
  confirmRendererAction?: (...args: any[]) => unknown;
  executeCdpCommand: (request: unknown) => Promise<unknown>;
  hasTunnelWebappSubscriber?: () => boolean;
  emitWebappChanged?: (...args: any[]) => unknown;
  desktopPet?: {
    refreshState: (...args: any[]) => unknown;
    showWindow: (...args: any[]) => unknown;
    hideWindow: (...args: any[]) => unknown;
    saveSettings: (...args: any[]) => unknown;
  };
}

export function createDesktopActionOptions(
  context: DesktopActionRuntimeContext,
  dependencies: DesktopActionContextDependencies
): any {
  return {
    app: context.app,
    platform: context.platform,
    assistantBridge: dependencies.assistantBridge as any,
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    getAssistantSettings: dependencies.getAssistantSettings,
    createContainerHubClient: dependencies.createContainerHubClient,
    getDesktopAppInfo: () => dependencies.desktopAppInfo,
    getDesktopRuntimeDiagnostics: () => createDesktopRuntimeDiagnostics(
      context.app,
      dependencies.desktopAppInfo,
      { platform: context.platform, listServices: dependencies.services.listServices }
    ),
    getMainWindow: context.getMainWindow,
    services: dependencies.services,
    webs: dependencies.webs,
    getCurrentPageSnapshot: context.getCurrentPageSnapshot,
    navigate: dependencies.navigate,
    openLogViewer: dependencies.openLogViewer,
    showFileDialog: dependencies.showFileDialog,
    showSaveDialog: dependencies.showSaveDialog,
    callRendererAction: dependencies.callRendererAction,
    prepareWorkPanelLocalFileClaim: (input: {
      ownerChatId: string;
      rendererWebContentsId: number;
      filePath: string;
      workspaceRelativePath: string;
    }) => workPanelLocalFileRegistry.prepareClaim(input),
    discardWorkPanelLocalFileClaim: (claimId: string) =>
      workPanelLocalFileRegistry.discardPreparedClaim(claimId),
    confirmRendererAction: dependencies.confirmRendererAction,
    executeCdpCommand: dependencies.executeCdpCommand,
    getKanbanRuntime: context.getKanbanRuntime,
    hasTunnelWebappSubscriber: dependencies.hasTunnelWebappSubscriber,
    emitWebappChanged: dependencies.emitWebappChanged,
    desktopPet: dependencies.desktopPet
      ? {
          refreshState: () => dependencies.desktopPet?.refreshState(),
          saveSettings: (input: unknown) => dependencies.desktopPet?.saveSettings(input),
          show: () => dependencies.desktopPet?.showWindow(),
          hide: () => dependencies.desktopPet?.hideWindow()
        }
      : undefined
  };
}
