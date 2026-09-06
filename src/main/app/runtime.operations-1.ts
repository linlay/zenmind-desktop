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
  ensureIdentityCenterJwk,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
} from "../modules/identity";

import { loadBuiltinServices } from "../modules/services";

import {
  type ServicesIntegrationPorts,
  getResponsiveServiceState,
  getServiceState,
  listServices,
  readServiceLog,
  runStartupPreparation,
} from "../modules/services";

import {
  type WebsIntegrationPorts,
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

export function createMainProcessRuntime_block14_2(
  factoryContext: CreateMainProcessRuntimeContext
): WebsIntegrationPorts {
return {
    getDesktopDeviceId,
    getConfiguredDesktopActionBridgePort,
    readInstalledRecords,
    removeInstalledRecordByResourceKey,
    installWebsiteAppArchiveFromPath: (targetApp, archivePath, options) =>
      installWebsiteAppArchiveFromPath(targetApp, archivePath, {
        ...options,
        webs: factoryContext.websFacade
      }),
    deriveTunnelHubRegistrationApiOrigin,
    getTunnelHubRuntimeStatus,
    startTunnelHubRuntime,
    readTunnelHubRegistrationBearerToken,
    readTunnelHubSettings,
    saveTunnelHubSettings
};
}

export function createMainProcessRuntime_block17_3(factoryContext: CreateMainProcessRuntimeContext) {
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
          factoryContext.servicesFacade.resolveDesktopCapability
        )
    }),
    stopDesktopWsServer,
    createDesktopActionOptions: (context, dependencies) => createDesktopActionOptions(context, {
        ...dependencies,
        issueAgentAccessToken: factoryContext.issueAgentAccessToken,
        getAssistantSettings,
        createContainerHubClient: (config) => new ContainerHubClient(config),
        services: factoryContext.servicesFacade,
        webs: factoryContext.websFacade
    }),
    createKanbanRuntime,
    configureTunnelHubRegistrationController,
    configureTunnelHubRuntime,
    createDesktopMobileWebappCatalog: factoryContext.websFacade.createDesktopMobileWebappCatalog,
    readDesktopMobileWebappItem: factoryContext.websFacade.readDesktopMobileWebappItem,
    setWebappPublicationChangeListener: (listener) =>
      factoryContext.websFacade.webappRuntime.setPublicationChangeListener(listener)
});
}

export function createMainProcessRuntime_block18_4(
  factoryContext: CreateMainProcessRuntimeContext
): ServicesIntegrationPorts {
return {
    issueAgentAccessToken: factoryContext.issueAgentAccessToken,
    getDesktopDeviceId,
    getDesktopDeviceInfo,
    ensureProviderRegisterApiKey: (targetApp) => ensureProviderRegisterApiKey(targetApp, { getDesktopDeviceId }),
    resolveConversationAssetOrigin,
    emitPluginBridgeHook,
    getPluginBridgeEnv,
    getPluginSettingsEnv,
    initializePluginResourceState,
    readPluginResourceDesiredStatus,
    stopPluginResources: (targetApp, service) =>
      stopPluginResources(targetApp, service, factoryContext.websFacade.webappManager),
    syncPluginResources: (targetApp, service, installDir) =>
      syncPluginResources(
        targetApp,
        service,
        installDir,
        factoryContext.websFacade.webappManager
      )
};
}

export function createMainProcessRuntime_startupRestoreController_5(factoryContext: CreateMainProcessRuntimeContext) { return createStartupRestoreController({
    onChange: (state) => {
        const mainWindow = factoryContext.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }
        mainWindow.webContents.send("services.startupRestoreState", state);
    }
}); }

export function createMainProcessRuntime_webSurfaceRuntime_6(factoryContext: CreateMainProcessRuntimeContext) { return createWebSurfaceRuntime({
    app,
    websFacade: factoryContext.websFacade,
    getMainWindow: factoryContext.getMainWindow,
    webContents,
    reportRegistrationDiagnostic: (diagnostic) => {
        safeConsoleError("[surface-registration]", diagnostic);
    },
    navigateMainWindow: factoryContext.navigateMainWindow,
    delay: factoryContext.delay,
    t
}); }

export function createMainProcessRuntime_webviewContextMenuController_7(factoryContext: CreateMainProcessRuntimeContext) { return createWebviewContextMenuController({
    platform: factoryContext.startupPlatform,
    browserSurfaces: factoryContext.webSurfaceRuntime.browserSurfaceRegistry,
    getMainWindow: () => factoryContext.getMainWindow(),
    openBrowserUrl: factoryContext.webSurfaceRuntime.openBrowserUrl,
    openWorkPanelUrl: ({ sourceGuestId, url }) => {
        const target = factoryContext.webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(sourceGuestId);
        const mainWindow = factoryContext.getMainWindow();
        if (!target ||
            (target.surfaceType !== "chat-work-panel" && target.presentationScope !== "workpanel") ||
            !mainWindow ||
            mainWindow.isDestroyed()) {
            return;
        }
        mainWindow.webContents.send("webview.openTab", {
            target: "work-panel",
            navigationKind: "network",
            sourceGuestId,
            url
        });
    },
    openExternal: (url) => shell.openExternal(url),
    isTrustedAgentWebclient: async (contents, target) => {
        if (target.serviceId !== "agent-webclient" ||
            contents.session !== session.fromPartition(`persist:${STORAGE_NAMESPACE}-service-agent-webclient`)) {
            return false;
        }
        const liveUrl = parseSafeLoopbackWebUrl(contents.getURL());
        if (!liveUrl)
            return false;
        const service = await factoryContext.servicesFacade.getResponsiveServiceState(app, "agent-webclient");
        const serviceUrl = parseSafeLoopbackWebUrl(service.healthMeta.webUrl);
        return Boolean(service.status === "running" &&
            serviceUrl &&
            new URL(liveUrl.toString()).origin === new URL(serviceUrl.toString()).origin);
    },
    t,
    report: factoryContext.reportRendererDiagnostic
}); }

export function createMainProcessRuntime_enterpriseChatRuntime_8(factoryContext: CreateMainProcessRuntimeContext) { return new EnterpriseChatRuntime({
    app,
    platform: factoryContext.startupPlatform,
    getServerUrl: () => readEnterpriseImSettings(app, factoryContext.startupPlatform).baseUrl,
    initialEnabled: readEnterpriseImSettings(app, factoryContext.startupPlatform).enabled,
    refreshIdentityToken: () => factoryContext.refreshDesktopSsoIdentityToken(true),
    selectFiles: async () => {
        const result = await factoryContext.showFileDialog({
            title: t("enterpriseChat.selectFiles"),
            properties: ["openFile", "multiSelections"]
        });
        return result.canceled ? [] : result.filePaths;
    },
    selectAvatar: async () => {
        const result = await factoryContext.showFileDialog({
            title: t("enterpriseChat.selectAvatar"),
            properties: ["openFile"],
            filters: [{ name: t("enterpriseChat.avatarImage"), extensions: ["png", "jpg", "jpeg", "webp"] }]
        });
        return result.canceled ? [] : result.filePaths;
    },
    showSaveDialog: (options) => factoryContext.showSaveDialog(options),
    captureScreenshot: (mode) => factoryContext.captureEnterpriseChatScreenshot(mode),
    createSupportArtifact: async (action, args) => {
        const readArg = (key: string) => typeof args[key] === "string" ? args[key].trim() : "";
        let filename = "desktop-support.txt";
        let content = "";
        if (action === "desktop.support.requestServiceLogs") {
            const serviceId = (readArg("serviceId") || readArg("id")) as Parameters<typeof readServiceLog>[1];
            const target = readArg("target") === "error" ? "error" : "main";
            const result = await factoryContext.servicesFacade.readServiceLog(
              app,
              serviceId,
              target,
              { limitBytes: 512 * 1024 }
            );
            filename = `service-${serviceId}-${target}.log`;
            content = result.content;
        }
        else if (action === "desktop.support.requestWebappLogs") {
            const webappId = readArg("webappId") || readArg("id");
            const target = readArg("target") === "error" ? "error" : "main";
            const result = factoryContext.websFacade.webappRuntime.readLog(
              app,
              webappId,
              target,
              { limitBytes: 512 * 1024 }
            );
            filename = `webapp-${webappId}-${target}.log`;
            content = result.content;
        }
        else if (action === "desktop.support.requestSystemInfo") {
            filename = "desktop-system-info.json";
            content = `${JSON.stringify({
                appVersion: app.getVersion(),
                platform: factoryContext.startupPlatform,
                arch: process.arch,
                electron: process.versions.electron,
                node: process.versions.node,
                locale: app.getLocale()
            }, null, 2)}\n`;
        }
        else {
            throw new Error("Unsupported support artifact request.");
        }
        return {
            filename,
            contentType: filename.endsWith(".json") ? "application/json" : "text/plain",
            bytes: Buffer.from(redactEnterpriseChatSupportText(content, app.getPath("home"), getDataRoot(app)), "utf8")
        };
    },
    executeDesktopAction: async (request) => {
        const response = await handleDesktopActionRequest(factoryContext.assistantBridgeRuntime.desktopActionOptions, {
            requestId: `enterprise-im-${request.messageId}`,
            action: request.action,
            args: request.args,
            permissionMode: "full_access",
            source: {
                chatId: `enterprise-im:${request.conversationId}`
            }
        });
        return {
            confirmed: true,
            status: response.ok ? "succeeded" : "failed",
            response,
            message: response.ok
                ? t("enterpriseChat.desktopActionExecuted")
                : response.error?.message || t("enterpriseChat.desktopActionFailed")
        };
    },
    onStateChanged: (snapshot) => {
        const targetWindow = factoryContext.getMainWindow();
        if (targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send("enterpriseChat.stateChanged", snapshot);
        }
    }
}); }

export function createMainProcessRuntime_cdpIntegration_9(factoryContext: CreateMainProcessRuntimeContext) { return createCdpIntegration({
    browserSurfaces: factoryContext.webSurfaceRuntime.browserSurfaceRegistry,
    getCurrentPageSnapshot: factoryContext.webSurfaceRuntime.getCurrentPageSnapshot,
    listServices: () => factoryContext.servicesFacade.listServices(app),
    isLoopbackUrl: parseSafeLoopbackWebUrl,
    switchTab: async (surfaceId, tabId, ownerChatId) => {
        const response = await callDesktopActionRenderer({
            requestId: `cdp-switch-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            action: ownerChatId ? "desktop.workpanel.activateTab" : "desktop.web.switchTab",
            args: ownerChatId ? { tabId } : { surfaceId, tabId },
            ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
        }, {
            getMainWindow: factoryContext.getMainWindow,
            pendingRequests: factoryContext.assistantBridgeRuntime.desktopActionRendererRequests
        });
        if (!response.ok) {
            throw new Error(response.error?.message || "Desktop tab could not be activated.");
        }
        return response.result;
    },
    closeTab: async (surfaceId, tabId, ownerChatId) => {
        const response = await callDesktopActionRenderer({
            requestId: `cdp-close-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            action: ownerChatId ? "desktop.workpanel.closeTab" : "desktop.web.closeTab",
            args: ownerChatId ? { tabId } : { surfaceId, tabId },
            ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
        }, {
            getMainWindow: factoryContext.getMainWindow,
            pendingRequests: factoryContext.assistantBridgeRuntime.desktopActionRendererRequests
        });
        if (!response.ok) {
            throw new Error(response.error?.message || "Desktop tab could not be closed.");
        }
        return response.result;
    },
    version: `${PRODUCT_NAME}/${app.getVersion()} Electron/${process.versions.electron}`
}); }

export function createMainProcessRuntime_systemIdentityRuntime_10(factoryContext: CreateMainProcessRuntimeContext) { return configureSystemIdentity({
    app,
    platform: factoryContext.startupPlatform,
    appId: APP_ID,
    productName: PRODUCT_NAME,
    mainProcessDir: factoryContext.MAIN_PROCESS_DIR,
    resourcesPath: process.resourcesPath,
    nativeImage,
    safeConsoleError
}); }

export function createMainProcessRuntime_setStartupPhase_11(factoryContext: CreateMainProcessRuntimeContext, phase: StartupPhase) {
    if (factoryContext.appState.startupPhase === phase) {
        return;
    }
    factoryContext.appState.startupPhase = phase;
    console.info(`[main] startup phase: ${phase}`);
}

export function createMainProcessRuntime_initializeUserDataRootsAndSettings_12(factoryContext: CreateMainProcessRuntimeContext) {
    ensureDataRoot(app);
    applyDesktopInitBootstrap(app, factoryContext.startupPlatform);
    const initialLocaleSettings = initializeMainI18n(app, { isFirstInstall: factoryContext.isFirstDesktopInstall });
    if (factoryContext.isFirstDesktopInstall) {
        setMainLocale(app, initialLocaleSettings.locale);
    }
    const electronUserDataRoot = getElectronUserDataRoot(app);
    fs.mkdirSync(electronUserDataRoot, { recursive: true });
    app.setPath("userData", electronUserDataRoot);
    const programDataCleanup = cleanupProgramDataForVersion(app, factoryContext.desktopAppInfo.version);
    if (programDataCleanup.cleaned) {
        console.info(`[main] refreshed program data for ${factoryContext.desktopAppInfo.version}: ${programDataCleanup.removedPaths.length} path(s) removed`);
    }
    else if (programDataCleanup.failedPaths.length > 0) {
        console.warn(`[main] program data cleanup incomplete for ${factoryContext.desktopAppInfo.version}: ${programDataCleanup.failedPaths.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
    }
    factoryContext.petRuntime.initializeState(factoryContext.isFirstDesktopInstall);
}

export function createMainProcessRuntime_delay_13(factoryContext: CreateMainProcessRuntimeContext, ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}
