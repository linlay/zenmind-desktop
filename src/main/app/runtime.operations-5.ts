import {
  app,
  globalShortcut,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  shell,
  session,
  webContents
} from "electron";
import {
  configurePluginResources
} from "../modules/plugins";
import { revealPathInFileManager } from "../modules/shell";
import {
  STORAGE_NAMESPACE
} from "../../shared/brand";
import {
  callAgentPlatform
} from "../modules/desktop-actions";
import {
  stopTunnelHubRuntime
} from "../modules/tunnel";
import {
  registerDesktopPetAssetProtocol
} from "../modules/pet";
import {
  registerWebsiteFaviconProtocol
} from "../modules/webs";
import {
  registerDesktopSsoAvatarProtocol
} from "../modules/identity";
import { registerMainIpcHandlers } from "./module-registry";
import {
  unregisterPluginGlobalShortcuts
} from "../modules/plugins";
import {
  parseInstallerShutdownRequest,
  writeShutdownAck
} from "./lifecycle/shutdown-ack";
import { registerMainAppEvents } from "./app-events";
import { registerDesktopOpenProtocolClient } from "./deep-link";
import { createConversationShareFacade } from "../modules/conversation-share";
import type { CreateMainProcessRuntimeContext } from "./runtime.shared";

export async function createMainProcessRuntime_handleAppReady_1(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.setStartupPhase("platform-preflight");
    factoryContext.systemIdentityRuntime.ensureDockIdentity();
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
    const programDataCleanup = factoryContext.initializeUserDataRootsAndSettings();
    // A first-install root migration must finish before protocol.handle creates
    // the default Session and opens files in the already-configured profile.
    registerDesktopPetAssetProtocol(app, protocol, net, factoryContext.startupPlatform);
    registerWebsiteFaviconProtocol(app, protocol, net, factoryContext.startupPlatform);
    registerDesktopSsoAvatarProtocol(app, protocol, net, session, factoryContext.startupPlatform);
    factoryContext.setStartupPhase("desktop-state-ready");
    factoryContext.logsRuntime.installConsoleTee();
    // Persist the pre-logger cleanup result without moving logging ahead of root initialization.
    if (programDataCleanup.failedPaths.length > 0) {
        console.warn("[program-data-cleanup] result", programDataCleanup);
    } else {
        console.info("[program-data-cleanup] result", programDataCleanup);
    }
    const desktopSsoRestoreResult = await factoryContext.desktopSsoController.restoreDesktopSsoSession();
    factoryContext.applyDesktopSsoRestoreResult(desktopSsoRestoreResult);
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
        snapshotProvider: factoryContext.assistantBridgeRuntime.assistantBridge
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
