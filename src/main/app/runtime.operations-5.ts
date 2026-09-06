import fs from "node:fs";

import {
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  session,
  systemPreferences,
  webContents,
} from "electron";


import {
  completeDesktopSsoCookieLogin,
  desktopSsoAccessTokenNeedsRefresh,
  finalizeDesktopSsoLoginAttempt,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
} from "../modules/identity";

import { loadBuiltinServices } from "../modules/services";

import {
  getResponsiveServiceState,
  getServiceState,
  listServices,
  readServiceLog,
  runStartupPreparation,
} from "../modules/services";

import {
  createDesktopMobileWebappCatalog,
  readDesktopMobileWebappItem,
  restorePublishedWebapps
} from "../modules/webs";

import { webappManager } from "../modules/webs";

import { webappWindowManager } from "../modules/webs";

import { loadInstalledPlugins } from "../modules/plugins";

import {
  configurePluginResources,
  emitPluginBridgeHook,
  getPluginBridgeEnv,
  getPluginSettingsEnv,
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  retryPendingPluginResourceSync,
  stopPluginResources,
  syncPluginResources
} from "../modules/plugins";

import { revealPathInFileManager } from "../modules/shell";

import { createAppShellRuntime, type AppShellRuntime } from "../modules/shell";

import { readDesktopProfileFromRoot } from "../infrastructure/filesystem/profile-store";

import { createServicesRuntime } from "../modules/services";

import type {
  AssistantAttachmentTaskProgress,
  AssistantNavAgentItemsResult,
  AssistantNavigationPushEvent,
  AssistantWorkerOpenRequest,
  EnterpriseChatScreenshotMode,
  ServiceOpenLogViewerRequest,
  WebsChangedEvent,
} from "../../shared/contracts";

import {
  APP_ID,
  INSTALLER_SHUTDOWN_ARG,
  PRODUCT_NAME,
  STORAGE_NAMESPACE,
} from "../../shared/brand";

import {
  desktopDataRootExists,
  ensureDataRoot,
  getDataRoot,
  getDesktopConfigRoot,
  getElectronUserDataRoot,
} from "../infrastructure/filesystem/user-paths";

import { EnterpriseChatRuntime } from "../modules/enterprise-chat";

import { redactEnterpriseChatSupportText } from "../modules/enterprise-chat";

import { readEnterpriseImSettings } from "../modules/enterprise-chat";

import { createLogsRuntime } from "../support/logging/runtime";

import { isDesktopDevelopmentRuntime } from "../infrastructure/electron/development-runtime";

import { setDeprecatedCompatibilityDesktopVersion } from "../support/logging/deprecated-compatibility";

import {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade
} from "./bootstrap/desktop-init";

import {
  bundledEnvZipExists,
  configureRuntimeEnvironmentTranslator,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeEnvNeedsBundledSeedRefresh,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  shouldRequireEnvZipImport,
  type EnvRootConflictDecision,
} from "../infrastructure/filesystem/runtime-environment";

import { createStartupEnvironmentRuntime } from "./bootstrap/startup-environment";

import { safeConsoleError } from "../support/logging/safe-console";

import {
  callAgentPlatform,
  handleAgentPlatformDesktopActionRequest,
  handleDesktopActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge
} from "../modules/desktop-actions";

import {
  callDesktopActionConfirmation,
  callDesktopActionRenderer,
  createDesktopActionOptions
} from "../modules/desktop-actions";

import {
  emitDesktopWsPush,
  getDesktopWsServerRuntimeState,
  startDesktopWsServer,
  stopDesktopWsServer
} from "../modules/desktop-protocol";

import {
  configureTunnelHubRegistrationController,
  configureTunnelHubRuntime,
  startTunnelHubRuntimeIfEnabled,
  stopTunnelHubRuntime,
} from "../modules/tunnel";

import {
  AGENT_WEBCLIENT_TARGET_PATH,
  createAgentWebclientRoute
} from "../../shared/agent-webclient-routes";

import {
  registerDesktopPetAssetProtocol,
  registerDesktopPetAssetProtocolScheme,
} from "../modules/pet";

import {
  registerWebsiteFaviconProtocol,
  registerWebsiteFaviconProtocolScheme,
} from "../modules/webs";

import {
  registerDesktopSsoAvatarProtocol,
  registerDesktopSsoAvatarProtocolScheme,
} from "../modules/identity";

import { registerChatWorkPanelLocalFileProtocolScheme } from "../modules/work-panel";

import { isDesktopPetSupportedPlatform } from "../modules/pet";

import { createDesktopPetRuntime, type DesktopPetRuntime } from "../modules/pet";

import { registerMainIpcHandlers } from "./module-registry";

import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge
} from "../modules/assistant";

import { initializeMainI18n, setMainLocale, t } from "../support/i18n/main-i18n";

import { createStartupRestoreController } from "./lifecycle/startup-restore";

import {
  getFocusedWebviewDevToolsShortcut,
  isDevToolsShortcut,
  isGlobalSearchShortcut,
  isWorkPanelCloseShortcut,
  resolveGlobalSearchCommandShortcut,
} from "../infrastructure/electron/platform-adapter";

import { MAIN_CHAT_SURFACE_ID } from "../../shared/surface-identity";

import { configureSystemIdentity } from "./system-identity";

import { openCurrentWebviewDevTools } from "../modules/web-surfaces";

import {
  createDesktopSsoController,
  type DesktopSsoRestoreResult
} from "../modules/identity";

import { createCdpIntegration } from "../modules/web-surfaces";

import { createWebSurfaceRuntime } from "../modules/webs";

import { createWebviewContextMenuController } from "../modules/web-surfaces";

import { createSettingsRuntime } from "../modules/settings";

import { readHelpSettings } from "../modules/settings";

import { createMainAppState } from "./state";

import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../infrastructure/electron/bundle-paths";

import { loadRendererRoute } from "../infrastructure/electron/renderer-route";

import { parseSafeLoopbackWebUrl } from "../infrastructure/network/loopback-url";

import {
  refreshPluginGlobalShortcuts,
  unregisterPluginGlobalShortcuts,
} from "../modules/plugins";

import { invokePluginDesktopAction } from "../modules/plugins";

import { cleanupProgramDataForVersion } from "./lifecycle/program-data-cleanup";

import { createAssistantBridgeRuntime, type AssistantBridgeRuntime } from "../modules/assistant";

import { createAssistantRunWakeLock } from "../modules/assistant";

import { createFirstInstallBootstrapNavigation } from "../modules/assistant";

import {
  ensureProviderRegisterApiKey,
  RealtimeBroker
} from "../modules/agent-platform";

import { createPluginClipboardBridge } from "../modules/plugins";

import { createPluginBridgeRuntime, type PluginBridgeRuntime } from "../modules/plugins";

import {
  createInstallerShutdownArgs,
  requestMainSingleInstanceLock,
} from "./lifecycle/single-instance";

import { createStartupPipeline } from "./lifecycle/startup";

import {
  isStartupPhaseAtLeast,
  type StartupPhase,
} from "./lifecycle/startup-phases";

import { createShutdownCleanupRunner } from "./lifecycle/shutdown";

import {
  createNoPrimaryShutdownReport,
  parseInstallerShutdownRequest,
  writeShutdownAck
} from "./lifecycle/shutdown-ack";

import { registerMainAppEvents } from "./app-events";

import { registerDesktopOpenProtocolClient } from "./deep-link";

import {
  createResourceDirectoryWatcher,
  type ResourceDirectoryWatcher
} from "./resource-directory-watcher";

import { recoverWebappInstallTransactions } from "../modules/webs";

import { configureMarketAccessTokenIssuer, refreshMarketCatalog } from "../modules/marketplace";

import { configureAgentMarketPlatformCaller } from "../modules/marketplace";

import { configureSkillMarketPlatformCaller } from "../modules/marketplace";

import {
  getDesktopDeviceId,
  getDesktopDeviceInfo
} from "../modules/identity";


import { resolveConversationAssetOrigin } from "../modules/conversation-share";

import {
  installWebsiteAppArchiveFromPath,
  readInstalledRecords,
  removeInstalledRecordByResourceKey
} from "../modules/marketplace";

import {
  deriveTunnelHubRegistrationApiOrigin,
  getTunnelHubRuntimeStatus,
  readTunnelHubRegistrationBearerToken,
  readTunnelHubSettings,
  saveTunnelHubSettings,
  startTunnelHubRuntime
} from "../modules/tunnel";

import {
  getConfiguredDesktopActionBridgePort
} from "../modules/desktop-actions";

import {
  ContainerHubClient,
  createAssistantIntegrationPorts,
  getAssistantSettings,
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform,
  readAssistantSettings,
  resolveAssistantAttachmentPath,
  resolveAssistantChatStoragePaths,
  toPublicAssistantSettings
} from "../modules/assistant";

import { toDesktopPetAgentOptions } from "../modules/pet";

import { createKanbanRuntime } from "../modules/kanban";
import { createConversationShareFacade } from "../modules/conversation-share";

import type { CreateMainProcessRuntimeContext } from "./runtime.shared";

export async function createMainProcessRuntime_handleAppReady_1(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.setStartupPhase("platform-preflight");
    factoryContext.systemIdentityRuntime.ensureDockIdentity();
    registerDesktopPetAssetProtocol(app, protocol, net, factoryContext.startupPlatform);
    registerWebsiteFaviconProtocol(app, protocol, net, factoryContext.startupPlatform);
    registerDesktopSsoAvatarProtocol(app, protocol, net, session, factoryContext.startupPlatform);
    factoryContext.setStartupPhase("runtime-env");
    const canContinueStartup = await factoryContext.startupEnvironmentRuntime.handleStartupEnvRootConflict();
    if (!canContinueStartup) {
        app.exit(0);
        return;
    }
    const startupRuntimeReady = await factoryContext.startupEnvironmentRuntime.prepareStartupRuntimeEnvironment();
    if (!startupRuntimeReady.ok) {
        factoryContext.startupEnvImportFailureMessage =
            startupRuntimeReady.message || factoryContext.startupEnvironmentRuntime.getDefaultEnvImportRequiredMessage();
        factoryContext.startupRestoreController.setEnvImportRequired(factoryContext.startupEnvImportFailureMessage);
    }
    factoryContext.setStartupPhase("runtime-env-ready");
    factoryContext.initializeUserDataRootsAndSettings();
    factoryContext.setStartupPhase("desktop-state-ready");
    const desktopSsoRestoreResult = await factoryContext.desktopSsoController.restoreDesktopSsoSession();
    factoryContext.applyDesktopSsoRestoreResult(desktopSsoRestoreResult);
    factoryContext.logsRuntime.installConsoleTee();
    factoryContext.pluginBridgeRuntime.configure();
    configurePluginResources({
        callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
            ...requestOptions,
            issueAgentAccessToken: factoryContext.issueAgentAccessToken
        })
    });
    factoryContext.assistantBridgeRuntime.start();
    const conversationShareFacade = createConversationShareFacade({
        app,
        snapshotProvider: factoryContext.assistantBridgeRuntime.assistantBridge,
        getServiceState: factoryContext.servicesFacade.getServiceState
    });
    conversationShareFacade.start();
    app.once("will-quit", () => {
        void conversationShareFacade.dispose();
    });
    registerMainIpcHandlers({
        app,
        issueAgentAccessToken: factoryContext.issueAgentAccessToken,
        servicesFacade: factoryContext.servicesFacade,
        websFacade: factoryContext.websFacade,
        conversationShareFacade,
        ipcMain,
        platform: factoryContext.startupPlatform,
        shell,
        session,
        nativeTheme,
        getMainWindow: factoryContext.getMainWindow,
        getCurrentPageSnapshot: factoryContext.webSurfaceRuntime.getCurrentPageSnapshot,
        setCurrentPageSnapshot: factoryContext.webSurfaceRuntime.setCurrentPageSnapshot,
        getCopilotDevToolsTarget: factoryContext.webSurfaceRuntime.getCopilotDevToolsTarget,
        setCopilotDevToolsTarget: factoryContext.webSurfaceRuntime.setCopilotDevToolsTarget,
        getWebContentsById: (id) => webContents.fromId(id) ?? undefined,
        setWorkPanelFullscreenActive: factoryContext.appShellRuntime.setWorkPanelFullscreenActive,
        assistantBridgeRuntime: factoryContext.assistantBridgeRuntime,
        assistantRunWakeLock: factoryContext.assistantRunWakeLock,
        logsRuntime: factoryContext.logsRuntime,
        petRuntime: factoryContext.petRuntime,
        browserSurfaces: factoryContext.webSurfaceRuntime.browserSurfaceRegistry,
        isTrustedAgentWebclientSession: (sender) => sender.session === session.fromPartition(`persist:${STORAGE_NAMESPACE}-service-agent-webclient`),
        enterpriseChatRuntime: factoryContext.enterpriseChatRuntime,
        desktopSsoController: factoryContext.desktopSsoController,
        startupRestoreController: factoryContext.startupRestoreController,
        desktopAppInfo: factoryContext.desktopAppInfo,
        oldRootDecisionRef: factoryContext.oldRootDecisionRef,
        isFirstDesktopInstall: factoryContext.isFirstDesktopInstall,
        bundledEnvZipExistsAtStartup: factoryContext.bundledEnvZipExistsAtStartup,
        runtimeRootExistedAtStartup: factoryContext.runtimeRootExistedAtStartup,
        runtimeRootAtProcessStart: factoryContext.runtimeRootAtProcessStart,
        consumeFirstInstallBootstrapNavigation: () => factoryContext.firstInstallBootstrapNavigation.consume(),
        showFileDialog: factoryContext.showFileDialog,
        showSaveDialog: factoryContext.showSaveDialog,
        showMessageBox: factoryContext.showMessageBox,
        showArchiveDialog: factoryContext.showArchiveDialog,
        openLogViewerWindow: factoryContext.openLogViewerWindow,
        closeLogViewerWindow: factoryContext.closeLogViewerWindow,
        minimizeLogViewerWindow: factoryContext.minimizeLogViewerWindow,
        maximizeLogViewerWindow: factoryContext.maximizeLogViewerWindow,
        openAgentPlatformMonitorWindow: factoryContext.openAgentPlatformMonitorWindow,
        openAgentRealtimeInspectorWindow: factoryContext.openAgentRealtimeInspectorWindow,
        openDesktopActionWorkbenchWindow: factoryContext.openDesktopActionWorkbenchWindow,
        closeDesktopActionWorkbenchWindow: factoryContext.closeDesktopActionWorkbenchWindow,
        revealPathInFileManager,
        getServiceWebviewPreloadPath: factoryContext.getServiceWebviewPreloadPath,
        getServiceWebviewPreloadUrl: factoryContext.getServiceWebviewPreloadUrl,
        runServiceMutation: factoryContext.servicesRuntime.runServiceMutation,
        handleServiceStart: factoryContext.servicesRuntime.handleServiceStart,
        refreshPluginDesktopGlobalShortcuts: factoryContext.refreshPluginDesktopGlobalShortcuts,
        notifyServicesChanged: factoryContext.notifyServicesChanged,
        onStartupPreparationSucceeded: () => {
            factoryContext.setStartupPhase("core-ready");
            factoryContext.startNonCoreDesktopRuntime();
        },
        onStartupPreparationBlocked: () => factoryContext.setStartupPhase("degraded"),
        refreshDesktopRuntimeConfigFromCanonicalFiles: factoryContext.settingsRuntime.refreshDesktopRuntimeConfigFromCanonicalFiles,
        buildApplicationMenu: factoryContext.buildApplicationMenu,
        refreshTrayContextMenu: () => factoryContext.appShellRuntime.refreshTrayContextMenu(),
        refreshMainWindowAppearance: () => factoryContext.appShellRuntime.refreshMainWindowAppearance(),
        setGlobalSearchOverlayVisible: (visible) => factoryContext.appShellRuntime.setGlobalSearchOverlayVisible(visible),
        setWebviewModalOverlayVisible: (sourceId, visible) => factoryContext.appShellRuntime.setWebviewModalOverlayVisible(sourceId, visible),
        emitLocaleChanged: factoryContext.settingsRuntime.emitLocaleChanged,
        captureDesktopScreenshotForWebview: factoryContext.captureDesktopScreenshotForWebview,
        reportRendererDiagnostic: factoryContext.reportRendererDiagnostic,
        emitAssistantAttachmentProgress: factoryContext.emitAssistantAttachmentProgress,
        captureAssistantScreenshot: factoryContext.captureAssistantScreenshot
    });
    factoryContext.configureAppMediaPermissions();
    factoryContext.registerFocusedWebviewDevToolsShortcut();
    factoryContext.createWindow();
    factoryContext.setStartupPhase("shell-ready");
    factoryContext.startResourceDirectoryWatcher();
    void factoryContext.startupPipeline.run();
}

export function createMainProcessRuntime_start_2(factoryContext: CreateMainProcessRuntimeContext) {
    registerDesktopOpenProtocolClient(app, factoryContext.startupPlatform, {
        isDefaultApp: Boolean((process as NodeJS.Process & {
            defaultApp?: boolean;
        }).defaultApp),
        execPath: process.execPath,
        appEntryPath: process.argv[1]
    });
    registerMainAppEvents({
        app,
        platform: factoryContext.startupPlatform,
        state: factoryContext.appState,
        gotSingleInstanceLock: factoryContext.gotSingleInstanceLock,
        installerShutdownArgs: factoryContext.INSTALLER_SHUTDOWN_ARGS,
        globalShortcut,
        focusedWebviewDevToolsShortcut: factoryContext.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT,
        initialCommandLine: process.argv,
        onReady: factoryContext.handleAppReady,
        showMainWindow: factoryContext.showMainWindow,
        beginAppQuitWithoutConfirmation: factoryContext.beginAppQuitWithoutConfirmation,
        beginInstallerShutdown: factoryContext.beginInstallerShutdown,
        isNativeDialogOpen: () => factoryContext.appShellRuntime.isNativeDialogOpen(),
        emitPluginBeforeQuit: () => factoryContext.pluginBridgeRuntime.emitBeforeQuit(),
        prepareQuitUi: factoryContext.prepareQuitUi,
        beginRealtimeShutdown: () => factoryContext.realtimeBroker.beginShutdown(),
        runShutdownCleanup: factoryContext.runShutdownCleanup,
        flushDesktopLogs: (timeoutMs) => factoryContext.logsRuntime.flush(timeoutMs),
        writeInstallerShutdownAcks: factoryContext.writeInstallerShutdownAcks,
        releaseAssistantRunWakeLock: () => factoryContext.assistantRunWakeLock.release(),
        clearDesktopPetIdleResetTimer: factoryContext.clearDesktopPetIdleResetTimer,
        stopAssistantBridgeRuntime: () => factoryContext.assistantBridgeRuntime.stop(),
        stopTunnelHubRuntime,
        disposeRealtimeBroker: () => factoryContext.realtimeBroker.dispose(),
        unregisterPluginGlobalShortcuts: () => unregisterPluginGlobalShortcuts(globalShortcut),
        stopResourceDirectoryWatcher: factoryContext.stopResourceDirectoryWatcher,
        stopPluginBridgeRuntime: () => factoryContext.pluginBridgeRuntime.stop(),
        stopEnterpriseChatRuntime: () => factoryContext.enterpriseChatRuntime.stop()
    });
}

export function createMainProcessRuntime_prepareQuitUi_3(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.appShellRuntime.prepareQuitUi();
}

export function createMainProcessRuntime_beginAppQuitWithoutConfirmation_4(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.appState.isHandlingQuit = true;
    factoryContext.prepareQuitUi();
    app.quit();
}

export function createMainProcessRuntime_beginInstallerShutdown_5(factoryContext: CreateMainProcessRuntimeContext, commandLine: string[]) {
    const request = parseInstallerShutdownRequest(commandLine, factoryContext.INSTALLER_SHUTDOWN_ARGS, STORAGE_NAMESPACE);
    factoryContext.appState.shutdownMode = "installer";
    if (request.ackPath) {
        if (factoryContext.appState.shutdownReport) {
            factoryContext.writeInstallerShutdownAck(request.ackPath, factoryContext.appState.shutdownReport);
        }
        else {
            factoryContext.appState.shutdownAckPaths.add(request.ackPath);
        }
    }
    factoryContext.beginAppQuitWithoutConfirmation();
}

export function createMainProcessRuntime_writeInstallerShutdownAck_6(factoryContext: CreateMainProcessRuntimeContext, ackPath: string, report: import("../../shared/shutdown").ShutdownReport) {
    const status = report.ok ? "OK" : "FAILED";
    try {
        writeShutdownAck(ackPath, status, report);
    }
    catch (error) {
        console.error(`[main] failed to write shutdown acknowledgement ${ackPath}`, error);
    }
}

export function createMainProcessRuntime_writeInstallerShutdownAcks_7(factoryContext: CreateMainProcessRuntimeContext, report: import("../../shared/shutdown").ShutdownReport) {
    if (factoryContext.appState.shutdownAckPaths.size === 0) {
        return;
    }
    for (const ackPath of factoryContext.appState.shutdownAckPaths) {
        factoryContext.writeInstallerShutdownAck(ackPath, report);
    }
    factoryContext.appState.shutdownAckPaths.clear();
}

export function createMainProcessRuntime_requestAppQuit_8(factoryContext: CreateMainProcessRuntimeContext) {
    void factoryContext.appShellRuntime.confirmAndRequestAppQuit();
}
