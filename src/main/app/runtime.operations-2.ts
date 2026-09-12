import { resolveRegisteredWebviewPopupTarget } from "../modules/web-surfaces";
import {
  app,
  nativeTheme,
  screen,
  shell,
  session,
  systemPreferences,
  webContents
} from "electron";
import {
  desktopSsoAccessTokenNeedsRefresh,
  getDesktopSsoAccessToken,
  isDesktopSsoCredentialRuntimeReady
} from "../modules/identity";
import { loadBuiltinServices } from "../modules/services";
import {
  getResponsiveServiceState
} from "../modules/services";
import { loadInstalledPlugins } from "../modules/plugins";
import {
  retryPendingPluginResourceSync
} from "../modules/plugins";
import { createAppShellRuntime } from "../modules/shell";
import {
  PRODUCT_NAME
} from "../../shared/brand";
import { readEnterpriseImSettings } from "../modules/enterprise-chat";
import { createLogsRuntime } from "../support/logging/runtime";
import {
  applyDesktopInitVersionUpgrade
} from "./bootstrap/desktop-init";
import { createStartupEnvironmentRuntime } from "./bootstrap/startup-environment";
import { safeConsoleError } from "../support/logging/safe-console";
import {
  callAgentPlatform
} from "../modules/desktop-actions";
import { isDesktopPetSupportedPlatform } from "../modules/pet";
import { createDesktopPetRuntime } from "../modules/pet";
import { t } from "../support/i18n/main-i18n";
import {
  isDevToolsShortcut,
  isGlobalSearchShortcut,
  isDesktopCloseShortcut,
  resolveGlobalSearchCommandShortcut
} from "../infrastructure/electron/platform-adapter";
import { MAIN_CHAT_SURFACE_ID } from "../../shared/surface-identity";
import {
  createDesktopSsoController
} from "../modules/identity";
import { createSettingsRuntime } from "../modules/settings";
import { readHelpSettings } from "../modules/settings";
import { loadRendererRoute } from "../infrastructure/electron/renderer-route";
import { parseSafeLoopbackWebUrl } from "../infrastructure/network/loopback-url";
import { createAssistantBridgeRuntime } from "../modules/assistant";
import { createPluginBridgeRuntime } from "../modules/plugins";
import { createStartupPipeline } from "./lifecycle/startup";
import { configureMarketAccessTokenIssuer } from "../modules/marketplace";
import {
  getAssistantSettings,
  readAssistantCopilotAgentsFromPlatform,
  readAssistantNavigationAgentsFromPlatform,
  resolveAssistantAttachmentPath,
  resolveAssistantChatStoragePaths
} from "../modules/assistant";
import { toDesktopPetAgentOptions } from "../modules/pet";
import type { CreateMainProcessRuntimeContext } from "./runtime.shared";

export function createMainProcessRuntime_logsRuntime_1(factoryContext: CreateMainProcessRuntimeContext) { return createLogsRuntime({
    app,
    preloadPath: factoryContext.MAIN_PRELOAD_PATH,
    routePath: factoryContext.LOG_VIEWER_ROUTE,
    platform: factoryContext.startupPlatform,
    getOwnerWindow: () => {
        const mainWindow = factoryContext.getMainWindow();
        return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    },
    loadRendererRoute,
    onRendererError: safeConsoleError
}); }

export function createMainProcessRuntime_block68_2(factoryContext: CreateMainProcessRuntimeContext): void {
factoryContext.appShellRuntime = createAppShellRuntime({
    app,
    platform: factoryContext.startupPlatform,
    effectiveAppId: factoryContext.systemIdentityRuntime.effectiveAppId,
    mainProcessDir: factoryContext.MAIN_PROCESS_DIR,
    productName: PRODUCT_NAME,
    resourcesPath: process.resourcesPath,
    session,
    shell,
    nativeTheme,
    systemPreferences,
    t,
    logsRuntime: factoryContext.logsRuntime,
    agentRealtimeInspectorRoute: factoryContext.AGENT_REALTIME_INSPECTOR_ROUTE,
    desktopActionWorkbenchRoute: factoryContext.DESKTOP_ACTION_WORKBENCH_ROUTE,
    loadRendererRoute,
    parseSafeLoopbackWebUrl,
    isDevToolsShortcut,
    isGlobalSearchShortcut,
    isDesktopCloseShortcut,
    isWorkPanelWebview: (contents) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return Boolean(target?.active &&
            (target.presentationScope === "workpanel" || (target.surfaceLevel === "child" &&
                target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
                target.ownerChatId &&
                [
                    "overview",
                    "debug",
                    "btw",
                    "source",
                    "project",
                    "file-diff",
                    "artifact",
                    "reference",
                    "file",
                    "planning",
                    "agent",
                    "copilot",
                    "skill",
                    "workpanel-web",
                ].includes(target.surfaceRole))));
    },
    isMainChatWebview: (contents) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return Boolean(target?.active &&
            target.surfaceId === MAIN_CHAT_SURFACE_ID &&
            target.surfaceRole === "main-chat" &&
            target.surfaceLevel === "root" &&
            target.surfaceType === "agent-chat");
    },
    resolveWebsiteCloseTarget: (contents) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        if (!target?.active || target.surfaceType !== "website" || target.surfaceRole !== "website" ||
            target.surfaceLevel !== "root" || target.presentationScope === "workpanel") return null;
        return { surfaceId: target.surfaceId, registrationId: target.registrationId };
    },
    resolveGlobalSearchCommandShortcut,
    handleDesktopSsoWebviewNavigation: factoryContext.handleDesktopSsoWebviewNavigation,
    shouldOpenWebviewPopupInWorkPanelTab: (contents) => (() => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return resolveRegisteredWebviewPopupTarget(target) === "work-panel";
    })(),
    shouldOpenWebviewPopupExternally: (contents) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return target?.serviceId === "agent-webclient";
    },
    resolveBlobPopupTarget: (contents) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return resolveRegisteredWebviewPopupTarget(target);
    },
    attachWebviewContextMenu: factoryContext.webviewContextMenuController.attach,
    collectWebviewLoadDiagnostics: factoryContext.collectWebviewLoadDiagnostics,
    reportRendererDiagnostic: factoryContext.reportRendererDiagnostic,
    safeConsoleError,
    ensureDockIdentity: () => factoryContext.systemIdentityRuntime.ensureDockIdentity(),
    isHandlingQuit: () => factoryContext.appState.isHandlingQuit,
    beginAppQuitWithoutConfirmation: factoryContext.beginAppQuitWithoutConfirmation,
    requestAppQuit: factoryContext.requestAppQuit,
    getAssistantNavigationSnapshot: () => factoryContext.assistantBridgeRuntime?.getNavigationSnapshot(),
    getDefaultChatAgentKey: () => getAssistantSettings(app).chatDefaultAgentKey,
    getDesktopPetEnabled: () => factoryContext.petRuntime?.getSettings()?.enabled === true,
    isDesktopPetSupported: () => isDesktopPetSupportedPlatform(factoryContext.startupPlatform),
    showDesktopPetWindow: factoryContext.showDesktopPetWindow,
    hideDesktopPetWindow: factoryContext.hideDesktopPetWindow,
    restoreDesktopPetWindowLayering: factoryContext.restoreDesktopPetWindowLayering,
    isAllowedWebappMicrophoneRequest: (contents, details) => {
        const guest = webContents.fromId(contents.id);
        if (!guest || guest.isDestroyed()) {
            return false;
        }
        const liveUrl = guest.getURL();
        const requestingUrl = details && typeof details === "object" &&
            "requestingUrl" in details && typeof details.requestingUrl === "string"
            ? details.requestingUrl
            : liveUrl;
        try {
            if (new URL(liveUrl).origin !== new URL(requestingUrl).origin) {
                return false;
            }
        }
        catch {
            return false;
        }
        return factoryContext.websFacade.webappRuntime
          .allowsLocalPageCapability(requestingUrl, "native.microphone");
    },
    getHelpUrl: () => readHelpSettings(app, factoryContext.startupPlatform).url
});
}

export function createMainProcessRuntime_startupEnvironmentRuntime_3(factoryContext: CreateMainProcessRuntimeContext) { return createStartupEnvironmentRuntime({
    app,
    platform: factoryContext.startupPlatform,
    productName: PRODUCT_NAME,
    envZipConflictNeedsDecision: factoryContext.envZipConflictNeedsDecision,
    requireEnvZipImportAtStartup: factoryContext.requireEnvZipImportAtStartup,
    runtimeRootAtProcessStart: factoryContext.runtimeRootAtProcessStart,
    oldRootDecisionRef: factoryContext.oldRootDecisionRef,
    startupRestoreController: factoryContext.startupRestoreController,
    showMessageBox: (options) => factoryContext.appShellRuntime.showMessageBox(options),
    t
}); }

export function createMainProcessRuntime_block71_4(factoryContext: CreateMainProcessRuntimeContext): void {
factoryContext.petRuntime = createDesktopPetRuntime({
    app,
    platform: factoryContext.startupPlatform,
    getMainWindow: factoryContext.getMainWindow,
    isHandlingQuit: () => factoryContext.appState.isHandlingQuit,
    getNavigationSnapshot: () => factoryContext.assistantBridgeRuntime?.getNavigationSnapshot(),
    screen,
    preloadPath: factoryContext.MAIN_PRELOAD_PATH,
    loadRendererRoute,
    showMainWindow: factoryContext.showMainWindow,
    openAssistantWorker: factoryContext.openAssistantWorker,
    publishPluginAssistantActiveTasks: (tasks, runningTaskCount) => factoryContext.pluginBridgeRuntime.publishAssistantActiveTasks(tasks, runningTaskCount),
    refreshTrayContextMenu: () => factoryContext.appShellRuntime.refreshTrayContextMenu()
});
}

export function createMainProcessRuntime_block72_5(factoryContext: CreateMainProcessRuntimeContext): void {
factoryContext.pluginBridgeRuntime = createPluginBridgeRuntime({
    app,
    clipboardBridge: factoryContext.pluginClipboardBridge,
    getServiceState: (serviceId) => factoryContext.servicesFacade.getServiceState(app, serviceId),
    listServices: (targetApp) => factoryContext.servicesFacade.listServices(targetApp),
    retryPendingPluginResourceSync,
    notifyAgentPlatformConfigChanged: () => factoryContext.notifyServicesChanged(),
    getAssistantActiveTasks: () => factoryContext.petRuntime.getAssistantActiveTasksSnapshotForPlugins(),
    queryAgentPlatform: (params) => callAgentPlatform(app, "/api/query", {
        issueAgentAccessToken: factoryContext.issueAgentAccessToken,
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

export function createMainProcessRuntime_desktopSsoController_6(factoryContext: CreateMainProcessRuntimeContext) { return createDesktopSsoController({
    app,
    platform: factoryContext.startupPlatform,
    session,
    getMainWindow: () => factoryContext.getMainWindow(),
    openBrowserUrl: factoryContext.webSurfaceRuntime.openBrowserUrl,
    openExternal: shell.openExternal,
    onRestoreResult: factoryContext.applyDesktopSsoRestoreResult
}); }

export function createMainProcessRuntime_block74_7(factoryContext: CreateMainProcessRuntimeContext): void {
configureMarketAccessTokenIssuer(async (_marketApp, reason) => {
    const currentToken = isDesktopSsoCredentialRuntimeReady()
        ? getDesktopSsoAccessToken() || ""
        : "";
    if (currentToken && reason === "missing") {
        return currentToken;
    }
    return factoryContext.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(true);
});
}

export function createMainProcessRuntime_block75_8(factoryContext: CreateMainProcessRuntimeContext): void {
factoryContext.refreshDesktopSsoIdentityToken = async (force = false) => {
    const restoreResult = await factoryContext.desktopSsoController.retryDesktopSsoSessionRestoreIfNeeded();
    factoryContext.applyDesktopSsoRestoreResult(restoreResult);
    if (factoryContext.desktopSsoRestoreState === "temporarily_unavailable") {
        return "";
    }
    const needsRefresh = force || desktopSsoAccessTokenNeedsRefresh(app);
    const accessToken = await factoryContext.desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(force);
    if (needsRefresh && accessToken) {
        factoryContext.assistantBridgeRuntime?.refreshKanbanDeviceInfo();
        void factoryContext.enterpriseChatRuntime.refresh().catch((error) => {
            safeConsoleError("failed to refresh enterprise chat after desktop sso token renewal", {
                error: error instanceof Error ? error.message : String(error)
            });
        });
    }
    return accessToken;
};
}

export function createMainProcessRuntime_settingsRuntime_9(factoryContext: CreateMainProcessRuntimeContext) { return createSettingsRuntime({
    app,
    platform: factoryContext.startupPlatform,
    getMainWindow: factoryContext.getMainWindow,
    getDesktopPetWindow: factoryContext.petRuntime.getWindow,
    getLogViewerWindow: () => factoryContext.logsRuntime.getLogViewerWindow(),
    buildApplicationMenu: factoryContext.buildApplicationMenu,
    refreshTrayContextMenu: () => factoryContext.appShellRuntime.refreshTrayContextMenu(),
    reloadDesktopPetSettings: factoryContext.petRuntime.reloadSettings,
    getDesktopPetEnabled: () => factoryContext.petRuntime.getSettings()?.enabled === true,
    isDesktopPetSupported: () => isDesktopPetSupportedPlatform(factoryContext.startupPlatform),
    showDesktopPetWindow: () => factoryContext.showDesktopPetWindow(),
    hideDesktopPetWindow: () => factoryContext.hideDesktopPetWindow(),
    broadcastDesktopSsoStatus: (status) => factoryContext.desktopSsoController.broadcastStatus(status),
    notifyServicesChanged: factoryContext.notifyServicesChanged,
    emitKanbanChanged: factoryContext.emitKanbanChanged,
    refreshDesktopActionBridge: () => factoryContext.assistantBridgeRuntime.refreshDesktopActionBridge(),
    refreshEnterpriseChat: () => {
        void factoryContext.enterpriseChatRuntime.reloadConfiguration(readEnterpriseImSettings(app, factoryContext.startupPlatform).enabled);
    }
}); }

export function createMainProcessRuntime_block77_10(factoryContext: CreateMainProcessRuntimeContext): void {
factoryContext.assistantBridgeRuntime = createAssistantBridgeRuntime({
    integrationPorts: factoryContext.assistantIntegrationPorts,
    app,
    desktopAppInfo: factoryContext.desktopAppInfo,
    platform: factoryContext.startupPlatform,
    getMainWindow: factoryContext.getMainWindow,
    getCurrentPageSnapshot: factoryContext.webSurfaceRuntime.getCurrentPageSnapshot,
    assistantRunWakeLock: factoryContext.assistantRunWakeLock,
    cdpIntegration: factoryContext.cdpIntegration,
    browserSurfaces: factoryContext.webSurfaceRuntime.browserSurfaceRegistry,
    getResponsiveServiceState,
    issueAgentAccessToken: factoryContext.issueAgentAccessToken,
    realtimeBroker: factoryContext.realtimeBroker,
    agentPlatformPorts: {
        toDesktopPetAgentOptions,
        resolveAssistantAttachmentPath,
        resolveAssistantChatFile: (targetApp, chatId) => resolveAssistantChatStoragePaths(targetApp, chatId)?.chatFilePath ?? "",
        readNavigationAgents: readAssistantNavigationAgentsFromPlatform,
        readCopilotAgents: readAssistantCopilotAgentsFromPlatform
    },
    refreshDesktopSsoAccessToken: () => factoryContext.refreshDesktopSsoIdentityToken(true),
    canUseDesktopSsoCredentials: isDesktopSsoCredentialRuntimeReady,
    callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
        ...requestOptions,
        issueAgentAccessToken: factoryContext.issueAgentAccessToken
    }),
    showMainWindow: factoryContext.showMainWindow,
    showFileDialog: factoryContext.showFileDialog,
    showSaveDialog: factoryContext.showSaveDialog,
    openLogViewerWindow: factoryContext.openLogViewerWindow,
    listKanbanLocalAgents: () => factoryContext.petRuntime.listKanbanLocalAgents(),
    emitKanbanChanged: factoryContext.emitKanbanChanged,
    emitAssistantNavigationAgentsChanged: factoryContext.emitAssistantNavigationAgentsChanged,
    emitAssistantNavigationPushEvent: factoryContext.emitAssistantNavigationPushEvent,
    onTunnelConnected: () => factoryContext.websFacade.restorePublishedWebapps(app),
    desktopPet: {
        refreshState: () => factoryContext.petRuntime.refreshState(),
        showWindow: () => factoryContext.petRuntime.showWindow(),
        hideWindow: () => factoryContext.petRuntime.hideWindow(),
        saveSettings: factoryContext.petRuntime.saveSettings
    },
    safeConsoleError,
    logger: console
});
}

export function createMainProcessRuntime_startupPipeline_11(factoryContext: CreateMainProcessRuntimeContext) { return createStartupPipeline({
    app,
    desktopVersion: factoryContext.desktopAppInfo.version,
    isFirstDesktopInstall: factoryContext.isFirstDesktopInstall,
    getEnvImportFailureMessage: () => factoryContext.startupEnvImportFailureMessage,
    startupRestoreController: factoryContext.startupRestoreController,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyCoreServicesChanged: factoryContext.notifyCoreServicesChanged,
    startShellRuntime: () => factoryContext.runNonCoreStartupTask("app tray", () => factoryContext.createAppTray()),
    startNonCoreRuntime: factoryContext.startNonCoreDesktopRuntime,
    setStartupPhase: factoryContext.setStartupPhase,
    runServiceMutation: factoryContext.servicesRuntime.runServiceMutation,
    runStartupPreparation: (targetApp, callbacks) => factoryContext.servicesFacade.runStartupPreparation(targetApp, {
        ...callbacks,
        applyDesktopConfiguration: applyDesktopInitVersionUpgrade
    }),
    t,
    onError: safeConsoleError
}); }
