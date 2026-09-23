import type { BrowserWindow } from "electron";
import {
  app,
  ipcMain,
  nativeTheme,
  session,
  shell,
  webContents
} from "electron";
import {
  STORAGE_NAMESPACE
} from "../../../shared/brand";
import type {
  AssistantAttachmentTaskProgress,
  DesktopAppInfo,
  EnterpriseChatScreenshotMode
} from "../../../shared/contracts";
import {
  bundledEnvZipExists,
  resolveRuntimeRoot,
  runtimeRootExists,
  type EnvRootConflictDecision
} from "../../infrastructure/filesystem/runtime-environment";
import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge, createAssistantRunWakeLock, createFirstInstallBootstrapNavigation, type AssistantBridgeRuntime
} from "../../modules/assistant";
import { createConversationShareFacade } from "../../modules/conversation-share";
import { EnterpriseChatRuntime } from "../../modules/enterprise-chat";
import { createDesktopSsoController, issueAgentAccessToken } from "../../modules/identity";
import { type DesktopPetRuntime } from "../../modules/pet";
import {
  createServicesRuntime,
  type ServicesFacade
} from "../../modules/services";
import { createSettingsRuntime } from "../../modules/settings";
import { revealPathInFileManager, type AppShellRuntime } from "../../modules/shell";
import { registerDesktopUpdates } from "../../modules/updates";
import {
  createWebSurfaceRuntime,
  type WebsFacade
} from "../../modules/webs";
import { createLogsRuntime } from "../../support/logging/runtime";
import {
  type StartupPhase
} from "../lifecycle/startup-phases";
import { createStartupRestoreController } from "../lifecycle/startup-restore";
import { registerMainIpcHandlers } from "../module-registry";
export interface ReadyIpcDependencies {
  readonly setStartupPhase: (phase: StartupPhase) => void;
  readonly startupRestoreController: ReturnType<typeof createStartupRestoreController>;
  readonly startupPlatform: NodeJS.Platform;
  readonly logsRuntime: ReturnType<typeof createLogsRuntime>;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "browserSurfaceRegistry" | "getCurrentPageSnapshot" | "setCurrentPageSnapshot" | "getCopilotDevToolsTarget" | "setCopilotDevToolsTarget">;
  readonly desktopSsoController: ReturnType<typeof createDesktopSsoController>;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly assistantBridgeRuntime: AssistantBridgeRuntime;
  readonly servicesFacade: ServicesFacade;
  readonly websFacade: WebsFacade;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly appShellRuntime: Pick<AppShellRuntime, "setWorkPanelFullscreenActive" | "refreshTrayContextMenu" | "refreshMainWindowAppearance" | "setGlobalSearchOverlayVisible" | "setWebviewModalOverlayVisible">;
  readonly assistantRunWakeLock: ReturnType<typeof createAssistantRunWakeLock>;
  readonly petRuntime: DesktopPetRuntime;
  readonly enterpriseChatRuntime: InstanceType<typeof EnterpriseChatRuntime>;
  readonly desktopAppInfo: DesktopAppInfo;
  readonly oldRootDecisionRef: { current: EnvRootConflictDecision | undefined };
  readonly isFirstDesktopInstall: boolean;
  readonly bundledEnvZipExistsAtStartup: ReturnType<typeof bundledEnvZipExists>;
  readonly runtimeRootExistedAtStartup: ReturnType<typeof runtimeRootExists>;
  readonly runtimeRootAtProcessStart: ReturnType<typeof resolveRuntimeRoot>;
  readonly firstInstallBootstrapNavigation: Pick<ReturnType<typeof createFirstInstallBootstrapNavigation>, "consume">;
  readonly showFileDialog: AppShellRuntime["showFileDialog"];
  readonly showSaveDialog: AppShellRuntime["showSaveDialog"];
  readonly showMessageBox: AppShellRuntime["showMessageBox"];
  readonly showArchiveDialog: AppShellRuntime["showArchiveDialog"];
  readonly openLogViewerWindow: ReturnType<typeof createLogsRuntime>["openLogViewerWindow"];
  readonly closeLogViewerWindow: ReturnType<typeof createLogsRuntime>["closeLogViewerWindow"];
  readonly minimizeLogViewerWindow: ReturnType<typeof createLogsRuntime>["minimizeLogViewerWindow"];
  readonly maximizeLogViewerWindow: ReturnType<typeof createLogsRuntime>["maximizeLogViewerWindow"];
  readonly openAgentPlatformMonitorWindow: AppShellRuntime["openAgentPlatformMonitorWindow"];
  readonly openAgentRealtimeInspectorWindow: AppShellRuntime["openAgentRealtimeInspectorWindow"];
  readonly openDesktopActionWorkbenchWindow: AppShellRuntime["openDesktopActionWorkbenchWindow"];
  readonly closeDesktopActionWorkbenchWindow: AppShellRuntime["closeDesktopActionWorkbenchWindow"];
  readonly getServiceWebviewPreloadPath: AppShellRuntime["getServiceWebviewPreloadPath"];
  readonly getServiceWebviewPreloadUrl: AppShellRuntime["getServiceWebviewPreloadUrl"];
  readonly servicesRuntime: Pick<ReturnType<typeof createServicesRuntime>, "runServiceMutation" | "handleServiceStart">;
  readonly refreshPluginDesktopGlobalShortcuts: () => void;
  readonly notifyServicesChanged: () => void;
  readonly startNonCoreDesktopRuntime: () => void;
  readonly settingsRuntime: Pick<ReturnType<typeof createSettingsRuntime>, "refreshDesktopRuntimeConfigFromCanonicalFiles" | "emitLocaleChanged">;
  readonly buildApplicationMenu: AppShellRuntime["buildApplicationMenu"];
  readonly captureDesktopScreenshotForWebview: (mode?: EnterpriseChatScreenshotMode) => ReturnType<typeof captureScreenshotForBridge>;
  readonly reportRendererDiagnostic: (source: string, details: Record<string, unknown>) => void;
  readonly emitAssistantAttachmentProgress: (progress: AssistantAttachmentTaskProgress) => void;
  readonly captureAssistantScreenshot: (chatId: string | null | undefined) => ReturnType<typeof captureCopilotScreenshot>;
}
export function registerReadyIpc(dependencies: ReadyIpcDependencies, conversationShareFacade: ReturnType<typeof createConversationShareFacade>, getUpdatesRuntime: () => ReturnType<typeof registerDesktopUpdates> | undefined) {
  registerMainIpcHandlers({
    app,
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    servicesFacade: dependencies.servicesFacade,
    websFacade: dependencies.websFacade,
    conversationShareFacade,
    ipcMain,
    platform: dependencies.startupPlatform,
    shell,
    session,
    nativeTheme,
    getMainWindow: dependencies.getMainWindow,
    getCurrentPageSnapshot: dependencies.webSurfaceRuntime.getCurrentPageSnapshot,
    setCurrentPageSnapshot: dependencies.webSurfaceRuntime.setCurrentPageSnapshot,
    getCopilotDevToolsTarget: dependencies.webSurfaceRuntime.getCopilotDevToolsTarget,
    setCopilotDevToolsTarget: dependencies.webSurfaceRuntime.setCopilotDevToolsTarget,
    getWebContentsById: (id) => webContents.fromId(id) ?? undefined,
    setWorkPanelFullscreenActive: dependencies.appShellRuntime.setWorkPanelFullscreenActive,
    assistantBridgeRuntime: dependencies.assistantBridgeRuntime,
    assistantRunWakeLock: dependencies.assistantRunWakeLock,
    logsRuntime: dependencies.logsRuntime,
    petRuntime: dependencies.petRuntime,
    browserSurfaces: dependencies.webSurfaceRuntime.browserSurfaceRegistry,
    isTrustedAgentWebclientSession: (sender) => sender.session === session.fromPartition(`persist:${STORAGE_NAMESPACE}-service-agent-webclient`),
    enterpriseChatRuntime: dependencies.enterpriseChatRuntime,
    desktopSsoController: dependencies.desktopSsoController,
    startupRestoreController: dependencies.startupRestoreController,
    desktopAppInfo: dependencies.desktopAppInfo,
    oldRootDecisionRef: dependencies.oldRootDecisionRef,
    isFirstDesktopInstall: dependencies.isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup: dependencies.bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup: dependencies.runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart: dependencies.runtimeRootAtProcessStart,
    consumeFirstInstallBootstrapNavigation: () => dependencies.firstInstallBootstrapNavigation.consume(),
    showFileDialog: dependencies.showFileDialog,
    showSaveDialog: dependencies.showSaveDialog,
    showMessageBox: dependencies.showMessageBox,
    showArchiveDialog: dependencies.showArchiveDialog,
    openLogViewerWindow: dependencies.openLogViewerWindow,
    closeLogViewerWindow: dependencies.closeLogViewerWindow,
    minimizeLogViewerWindow: dependencies.minimizeLogViewerWindow,
    maximizeLogViewerWindow: dependencies.maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow: dependencies.openAgentPlatformMonitorWindow,
    openAgentRealtimeInspectorWindow: dependencies.openAgentRealtimeInspectorWindow,
    openDesktopActionWorkbenchWindow: dependencies.openDesktopActionWorkbenchWindow,
    closeDesktopActionWorkbenchWindow: dependencies.closeDesktopActionWorkbenchWindow,
    revealPathInFileManager,
    getServiceWebviewPreloadPath: dependencies.getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl: dependencies.getServiceWebviewPreloadUrl,
    runServiceMutation: dependencies.servicesRuntime.runServiceMutation,
    handleServiceStart: dependencies.servicesRuntime.handleServiceStart,
    refreshPluginDesktopGlobalShortcuts: dependencies.refreshPluginDesktopGlobalShortcuts,
    notifyServicesChanged: dependencies.notifyServicesChanged,
    onStartupPreparationSucceeded: () => {
      dependencies.setStartupPhase("core-ready");
      void getUpdatesRuntime()?.mainReady();
      dependencies.startNonCoreDesktopRuntime();
    },
    onStartupPreparationBlocked: () => dependencies.setStartupPhase("degraded"),
    refreshDesktopRuntimeConfigFromCanonicalFiles: (reason) => {
      dependencies.settingsRuntime.refreshDesktopRuntimeConfigFromCanonicalFiles(reason);
      getUpdatesRuntime()?.getState();
      void getUpdatesRuntime()?.check();
    },
    buildApplicationMenu: dependencies.buildApplicationMenu,
    refreshTrayContextMenu: () => dependencies.appShellRuntime.refreshTrayContextMenu(),
    refreshMainWindowAppearance: () => dependencies.appShellRuntime.refreshMainWindowAppearance(),
    setGlobalSearchOverlayVisible: (visible) => dependencies.appShellRuntime.setGlobalSearchOverlayVisible(visible),
    setWebviewModalOverlayVisible: (sourceId, visible) => dependencies.appShellRuntime.setWebviewModalOverlayVisible(sourceId, visible),
    emitLocaleChanged: dependencies.settingsRuntime.emitLocaleChanged,
    captureDesktopScreenshotForWebview: dependencies.captureDesktopScreenshotForWebview,
    reportRendererDiagnostic: dependencies.reportRendererDiagnostic,
    emitAssistantAttachmentProgress: dependencies.emitAssistantAttachmentProgress,
    captureAssistantScreenshot: dependencies.captureAssistantScreenshot
  });
}
