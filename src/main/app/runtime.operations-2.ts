import fs from "node:fs";
import { resolveRegisteredWebviewPopupTarget } from "../modules/web-surfaces";

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
    isWorkPanelCloseShortcut,
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
    resolveGlobalSearchCommandShortcut,
    handleDesktopSsoWebviewNavigation: factoryContext.handleDesktopSsoWebviewNavigation,
    shouldOpenWebviewPopupInWorkPanelTab: (contents) => (() => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return resolveRegisteredWebviewPopupTarget(target) === "work-panel";
    })(),
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
    openAssistantWorker: factoryContext.openAssistantWorker,
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
