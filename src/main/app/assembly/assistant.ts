import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import {
  createAgentWebclientRoute
} from "../../../shared/agent-webclient-routes";
import type {
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  AssistantWorkerOpenRequest,
  DesktopAppInfo
} from "../../../shared/contracts";
import {
  RealtimeBroker
} from "../../modules/agent-platform";
import {
  ContainerHubClient, captureAssistantScreenshot as captureCopilotScreenshot, createAssistantBridgeRuntime, createAssistantIntegrationPorts, createAssistantRunWakeLock, getAssistantSettings, readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform,
  resolveAssistantAttachmentPath,
  resolveAssistantChatStoragePaths
} from "../../modules/assistant";
import {
  callAgentPlatform,
  callDesktopActionConfirmation,
  callDesktopActionRenderer,
  createDesktopActionOptions,
  handleAgentPlatformDesktopActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge
} from "../../modules/desktop-actions";
import {
  emitDesktopWsPush,
  getDesktopWsServerRuntimeState,
  startDesktopWsServer,
  stopDesktopWsServer
} from "../../modules/desktop-protocol";
import { ensureIdentityCenterJwk, isDesktopSsoCredentialRuntimeReady, issueAgentAccessToken } from "../../modules/identity";
import { createKanbanRuntime } from "../../modules/kanban";
import { toDesktopPetAgentOptions, type DesktopPetRuntime } from "../../modules/pet";
import {
  createServicesRuntime,
  getResponsiveServiceState,
  type ServicesFacade
} from "../../modules/services";
import { readHelpSettings } from "../../modules/settings";
import { type AppShellRuntime } from "../../modules/shell";
import {
  configureTunnelHubRegistrationController,
  configureTunnelHubRuntime
} from "../../modules/tunnel";
import { createCdpIntegration } from "../../modules/web-surfaces";
import {
  createWebSurfaceRuntime,
  type WebsFacade
} from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
import { createLogsRuntime } from "../../support/logging/runtime";
import { safeConsoleError } from "../../support/logging/safe-console";
export interface AssembleAssistantIntegrationDependencies {
  readonly servicesFacade: ServicesFacade;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly websFacade: WebsFacade;
}

export function assembleAssistantIntegration(dependencies: AssembleAssistantIntegrationDependencies) {
  return createAssistantIntegrationPorts({
    callDesktopActionConfirmation,
    callDesktopActionRenderer,
    handleAgentPlatformDesktopActionRequest,
    handleDesktopCdpRequest,
    startDesktopActionBridge,
    stopDesktopActionBridge,
    emitDesktopWsPush,
    getDesktopWsServerRuntimeState,
    startDesktopWsServer: (options) => startDesktopWsServer({
      ...options,
      ensureIdentityCenterJwk: (targetApp) => ensureIdentityCenterJwk(
        targetApp,
        dependencies.servicesFacade.resolveDesktopCapability
      )
    }),
    stopDesktopWsServer,
    createDesktopActionOptions: (context, dependencies) => createDesktopActionOptions(context, {
      ...dependencies,
      getHelpUrl: () => readHelpSettings(context.app, context.platform).url,
      issueAgentAccessToken: dependencies.issueAgentAccessToken,
      getAssistantSettings,
      createContainerHubClient: (config) => new ContainerHubClient(config),
      services: dependencies.servicesFacade,
      webs: dependencies.websFacade
    }),
    createKanbanRuntime,
    configureTunnelHubRegistrationController,
    configureTunnelHubRuntime,
    createDesktopMobileWebappCatalog: dependencies.websFacade.createDesktopMobileWebappCatalog,
    readDesktopMobileWebappItem: dependencies.websFacade.readDesktopMobileWebappItem,
    setWebappPublicationChangeListener: (listener) =>
      dependencies.websFacade.webappRuntime.setPublicationChangeListener(listener)
  });
}

export interface AssembleAssistantRuntimeDependencies {
  readonly assistantIntegrationPorts: ReturnType<typeof createAssistantIntegrationPorts>;
  readonly desktopAppInfo: DesktopAppInfo;
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "getCurrentPageSnapshot" | "browserSurfaceRegistry">;
  readonly assistantRunWakeLock: ReturnType<typeof createAssistantRunWakeLock>;
  readonly cdpIntegration: ReturnType<typeof createCdpIntegration>;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly realtimeBroker: InstanceType<typeof RealtimeBroker>;
  readonly refreshDesktopSsoIdentityToken: (force?: boolean) => Promise<string>;
  readonly showMainWindow: AppShellRuntime["showMainWindow"];
  readonly showFileDialog: AppShellRuntime["showFileDialog"];
  readonly showSaveDialog: AppShellRuntime["showSaveDialog"];
  readonly openLogViewerWindow: ReturnType<typeof createLogsRuntime>["openLogViewerWindow"];
  readonly petRuntime: Pick<DesktopPetRuntime, "listKanbanLocalAgents" | "refreshState" | "showWindow" | "hideWindow" | "saveSettings">;
  readonly emitKanbanChanged: () => void;
  readonly emitAssistantNavigationAgentsChanged: (result: AssistantNavAgentItemsResult) => void;
  readonly emitAssistantNavigationPushEvent: (event: AssistantNavigationPushEvent) => void;
  readonly websFacade: Pick<WebsFacade, "restorePublishedWebapps">;
}

export function assembleAssistantRuntime(dependencies: AssembleAssistantRuntimeDependencies) {
  return createAssistantBridgeRuntime({
    integrationPorts: dependencies.assistantIntegrationPorts,
    app,
    desktopAppInfo: dependencies.desktopAppInfo,
    platform: dependencies.startupPlatform,
    getMainWindow: dependencies.getMainWindow,
    getCurrentPageSnapshot: dependencies.webSurfaceRuntime.getCurrentPageSnapshot,
    assistantRunWakeLock: dependencies.assistantRunWakeLock,
    cdpIntegration: dependencies.cdpIntegration,
    browserSurfaces: dependencies.webSurfaceRuntime.browserSurfaceRegistry,
    getResponsiveServiceState,
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    realtimeBroker: dependencies.realtimeBroker,
    agentPlatformPorts: {
      toDesktopPetAgentOptions,
      resolveAssistantAttachmentPath,
      resolveAssistantChatFile: (targetApp, chatId) => resolveAssistantChatStoragePaths(targetApp, chatId)?.chatFilePath ?? "",
      readNavigationAgents: readAssistantNavigationAgentsFromPlatform,
      readCopilotAgents: readAssistantCopilotAgentsFromPlatform
    },
    refreshDesktopSsoAccessToken: () => dependencies.refreshDesktopSsoIdentityToken(true),
    canUseDesktopSsoCredentials: isDesktopSsoCredentialRuntimeReady,
    callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
      ...requestOptions,
      issueAgentAccessToken: dependencies.issueAgentAccessToken
    }),
    showMainWindow: dependencies.showMainWindow,
    showFileDialog: dependencies.showFileDialog,
    showSaveDialog: dependencies.showSaveDialog,
    openLogViewerWindow: dependencies.openLogViewerWindow,
    listKanbanLocalAgents: () => dependencies.petRuntime.listKanbanLocalAgents(),
    emitKanbanChanged: dependencies.emitKanbanChanged,
    emitAssistantNavigationAgentsChanged: dependencies.emitAssistantNavigationAgentsChanged,
    emitAssistantNavigationPushEvent: dependencies.emitAssistantNavigationPushEvent,
    onTunnelConnected: () => dependencies.websFacade.restorePublishedWebapps(app),
    desktopPet: {
      refreshState: () => dependencies.petRuntime.refreshState(),
      showWindow: () => dependencies.petRuntime.showWindow(),
      hideWindow: () => dependencies.petRuntime.hideWindow(),
      saveSettings: dependencies.petRuntime.saveSettings
    },
    safeConsoleError,
    logger: console
  });
}

export interface ShowAssistantTargetWindowDependencies {
  readonly showMainWindow: AppShellRuntime["showMainWindow"];
  readonly servicesRuntime: Pick<ReturnType<typeof createServicesRuntime>, "runServiceMutation" | "ensureAssistantTargetServicesRunning">;
  readonly getMainWindow: () => BrowserWindow | null;
}

export async function showAssistantTargetWindow(dependencies: ShowAssistantTargetWindowDependencies, source: string, targetPath: string) {
  // Keep Windows tray activation responsive while service probes/startup finish.
  dependencies.showMainWindow(targetPath);
  const failures = await dependencies.servicesRuntime.runServiceMutation(() => dependencies.servicesRuntime.ensureAssistantTargetServicesRunning(source));
  if (failures.length > 0) {
    dependencies.showMainWindow("/control-center");
    const mainWindow = dependencies.getMainWindow();
    return {
      ok: false,
      message: t("main.assistantServicesRecoveryFailed", { failures: failures.join(t("common.nameSeparator")) }),
      window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    };
  }
  const mainWindow = dependencies.getMainWindow();
  return {
    ok: true,
    message: t("main.assistantOpened"),
    window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  };
}

export interface OpenAssistantWorkerDependencies {
  readonly showAssistantTargetWindow: (source: string, targetPath?: string) => Promise<{ ok: boolean; message: string; window: BrowserWindow | null }>;
}

export async function openAssistantWorker(dependencies: OpenAssistantWorkerDependencies, request: AssistantWorkerOpenRequest) {
  const targetAgentKey = request.agentKey ?? request.workerKey ?? "";
  const openResult = await dependencies.showAssistantTargetWindow("assistant-worker", createAgentWebclientRoute({
    agentKey: targetAgentKey,
    chatId: request.chatId
  }));
  const targetWindow = openResult.window;
  if (!openResult.ok || !targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  const sendOpenAssistantWorker = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("app.openAssistantWorker", request);
    }
  };
  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendOpenAssistantWorker);
    return;
  }
  setTimeout(sendOpenAssistantWorker, 100);
}

export interface CaptureAssistantScreenshotDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly delay: (ms: number) => Promise<void>;
}

export async function captureAssistantScreenshot(dependencies: CaptureAssistantScreenshotDependencies, chatId: string | null | undefined) {
  return captureCopilotScreenshot({
    app,
    chatId,
    platform: dependencies.startupPlatform,
    getMainWindow: () => dependencies.getMainWindow(),
    delay: dependencies.delay
  });
}

