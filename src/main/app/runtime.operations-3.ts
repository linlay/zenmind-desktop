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
import { staticSiteHostManager } from "../modules/webs";

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

export function createMainProcessRuntime_runShutdownCleanup_1(factoryContext: CreateMainProcessRuntimeContext) { return createShutdownCleanupRunner({
    app,
    getMode: () => factoryContext.appState.shutdownMode,
    getExistingPromise: () => factoryContext.appState.shutdownCleanupPromise,
    setPromise: (promise) => {
        factoryContext.appState.shutdownCleanupPromise = promise;
    },
    markComplete: (report) => {
        factoryContext.appState.shutdownReport = report;
        factoryContext.appState.shutdownCleanupComplete = true;
    },
    emitProgress: (progress) => {
        const targetWindow = factoryContext.getMainWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
            return;
        }
        try {
            targetWindow.webContents.send("desktopShell.shutdownProgress", progress);
        }
        catch (error) {
            console.warn("[main] failed to render shutdown progress", error);
        }
    },
    dependencies: {
      closeWebappWindows: () => factoryContext.websFacade.webappWindowManager.closeAll(),
      listOpenWebappWindowIds: () => factoryContext.websFacade.webappWindowManager.openIds(),
      listInitialPortTargets: (targetApp) =>
        [
          ...staticSiteHostManager.list().flatMap((site) =>
            site.running && site.port
              ? [{ kind: "gateway" as const, id: `static-site:${site.siteId}`, port: site.port }]
              : []
          ),
          ...factoryContext.websFacade.webappRuntime.listActivePorts(targetApp).map((target) => ({
            kind: "gateway" as const,
            id: `webapp:${target.id}`,
            port: target.port
          }))
        ],
      stopWebapps: (targetApp) => factoryContext.websFacade.webappRuntime.stopAll(targetApp),
      stopServices: (targetApp, serviceOptions) =>
        factoryContext.servicesFacade.stopRunningServicesForShutdown(targetApp, serviceOptions)
    }
}); }

export async function createMainProcessRuntime_handleDesktopSsoWebviewNavigation_2(factoryContext: CreateMainProcessRuntimeContext, url: string) {
    let sessionCompleted = false;
    try {
        const status = getDesktopSsoStatus(app);
        if (factoryContext.appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
            return;
        }
        factoryContext.appState.desktopSsoWebviewCompletionInFlight = true;
        await factoryContext.desktopSsoController.syncBrowserCookies();
        const browserSessionStatus = await factoryContext.desktopSsoController.validateBrowserSession();
        if (!browserSessionStatus) {
            const accessToken = await factoryContext.desktopSsoController.exchangeBrowserCookieAccessToken();
            if (!accessToken) {
                failDesktopSsoFlow(t("main.ssoCookieExchangeNoAccessToken"));
                return;
            }
            completeDesktopSsoCookieLogin(app, accessToken);
            finalizeDesktopSsoLoginAttempt();
            return;
        }
        sessionCompleted = true;
        const stepErrors: string[] = [];
        try {
            await factoryContext.desktopSsoController.fetchBrowserUserInfo();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stepErrors.push(message);
            safeConsoleError("failed to fetch desktop sso browser userinfo", { url, error: message });
        }
        let accessToken = "";
        try {
            accessToken = await factoryContext.desktopSsoController.exchangeBrowserCookieAccessToken();
            if (!accessToken) {
                stepErrors.push(t("main.ssoCookieExchangeNoAccessToken"));
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stepErrors.push(message);
            safeConsoleError("failed to exchange desktop sso browser access token", { url, error: message });
        }
        finalizeDesktopSsoLoginAttempt(stepErrors);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sessionCompleted) {
            failDesktopSsoStep(message);
        }
        else {
            failDesktopSsoFlow(message);
        }
        safeConsoleError("failed to complete desktop sso from webview navigation", {
            url,
            error: message
        });
    }
    finally {
        factoryContext.appState.desktopSsoWebviewCompletionInFlight = false;
    }
}

export function createMainProcessRuntime_clearDesktopPetIdleResetTimer_3(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.petRuntime.clearIdleResetTimer();
}

export function createMainProcessRuntime_refreshDesktopPetState_4(factoryContext: CreateMainProcessRuntimeContext, patch: any) {
    return factoryContext.petRuntime.refreshState(patch);
}

export function createMainProcessRuntime_hideDesktopPetWindow_5(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.petRuntime.hideWindow();
}

export async function createMainProcessRuntime_showAssistantTargetWindow_6(factoryContext: CreateMainProcessRuntimeContext, source: string, targetPath: string) {
    // Keep Windows tray activation responsive while service probes/startup finish.
    factoryContext.showMainWindow(targetPath);
    const failures = await factoryContext.servicesRuntime.runServiceMutation(() => factoryContext.servicesRuntime.ensureAssistantTargetServicesRunning(source));
    if (failures.length > 0) {
        factoryContext.showMainWindow("/control-center");
        const mainWindow = factoryContext.getMainWindow();
        return {
            ok: false,
            message: t("main.assistantServicesRecoveryFailed", { failures: failures.join(t("common.nameSeparator")) }),
            window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
        };
    }
    const mainWindow = factoryContext.getMainWindow();
    return {
        ok: true,
        message: t("main.assistantOpened"),
        window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    };
}

export function createMainProcessRuntime_showDesktopPetWindow_7(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.petRuntime.showWindow();
}

export function createMainProcessRuntime_restoreDesktopPetWindowLayering_8(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.petRuntime.restoreWindowLayering();
}

export async function createMainProcessRuntime_openLogViewerWindow_9(factoryContext: CreateMainProcessRuntimeContext, request: ServiceOpenLogViewerRequest) {
    return factoryContext.logsRuntime.openLogViewerWindow(request);
}

export async function createMainProcessRuntime_openAgentPlatformMonitorWindow_10(factoryContext: CreateMainProcessRuntimeContext, url: string) {
    return factoryContext.appShellRuntime.openAgentPlatformMonitorWindow(url);
}

export async function createMainProcessRuntime_openDesktopActionWorkbenchWindow_11(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.openDesktopActionWorkbenchWindow();
}

export async function createMainProcessRuntime_openAgentRealtimeInspectorWindow_12(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.openAgentRealtimeInspectorWindow();
}

export function createMainProcessRuntime_closeDesktopActionWorkbenchWindow_13(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.closeDesktopActionWorkbenchWindow();
}

export function createMainProcessRuntime_closeLogViewerWindow_14(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.logsRuntime.closeLogViewerWindow();
}

export function createMainProcessRuntime_getServiceWebviewPreloadPath_15(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.getServiceWebviewPreloadPath();
}

export function createMainProcessRuntime_getServiceWebviewPreloadUrl_16(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.getServiceWebviewPreloadUrl();
}

export function createMainProcessRuntime_minimizeLogViewerWindow_17(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.logsRuntime.minimizeLogViewerWindow();
}

export function createMainProcessRuntime_maximizeLogViewerWindow_18(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.logsRuntime.maximizeLogViewerWindow();
}

export async function createMainProcessRuntime_captureAssistantScreenshot_19(factoryContext: CreateMainProcessRuntimeContext, chatId: string | null | undefined) {
    return captureCopilotScreenshot({
        app,
        chatId,
        platform: factoryContext.startupPlatform,
        getMainWindow: () => factoryContext.getMainWindow(),
        delay: factoryContext.delay
    });
}

export async function createMainProcessRuntime_captureDesktopScreenshotForWebview_20(factoryContext: CreateMainProcessRuntimeContext, mode: EnterpriseChatScreenshotMode) {
    return captureScreenshotForBridge({
        platform: factoryContext.startupPlatform,
        getMainWindow: () => factoryContext.getMainWindow(),
        delay: factoryContext.delay
    }, mode);
}

export async function createMainProcessRuntime_captureEnterpriseChatScreenshot_21(factoryContext: CreateMainProcessRuntimeContext, mode: EnterpriseChatScreenshotMode) {
    if (mode !== "window") {
        return factoryContext.captureDesktopScreenshotForWebview(mode);
    }
    const targetWindow = factoryContext.getMainWindow();
    if (!targetWindow ||
        targetWindow.isDestroyed() ||
        targetWindow.webContents.isDestroyed()) {
        return factoryContext.captureDesktopScreenshotForWebview(mode);
    }
    let insertedCssKey = "";
    try {
        insertedCssKey = await targetWindow.webContents.insertCSS(factoryContext.ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS);
        return await factoryContext.captureDesktopScreenshotForWebview(mode);
    }
    finally {
        if (insertedCssKey && !targetWindow.webContents.isDestroyed()) {
            await targetWindow.webContents.removeInsertedCSS(insertedCssKey).catch(() => undefined);
        }
    }
}

export function createMainProcessRuntime_refreshPluginDesktopGlobalShortcuts_22(factoryContext: CreateMainProcessRuntimeContext) {
    return refreshPluginGlobalShortcuts({
        app,
        globalShortcut,
        platform: factoryContext.startupPlatform,
        invokePluginAction: (serviceId, actionId) => {
            void factoryContext.servicesRuntime.runServiceMutation(() => invokePluginDesktopAction({
                app,
                serviceId,
                actionId,
                getServiceState,
                handleServiceStart: factoryContext.servicesRuntime.handleServiceStart
            })).catch((error) => {
                safeConsoleError("failed to invoke plugin global shortcut", {
                    serviceId,
                    actionId,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }
    });
}

export function createMainProcessRuntime_registerFocusedWebviewDevToolsShortcut_23(factoryContext: CreateMainProcessRuntimeContext) {
    if (factoryContext.focusedWebviewDevToolsShortcutRegistered) {
        return;
    }
    const registered = globalShortcut.register(factoryContext.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT, () => {
        const focusedWebviewDevToolsTargetId = factoryContext.appShellRuntime.getFocusedWebviewDevToolsTargetId();
        openCurrentWebviewDevTools({
            focusedWebviewDevToolsTarget: Number.isSafeInteger(focusedWebviewDevToolsTargetId) &&
                Number(focusedWebviewDevToolsTargetId) > 0
                ? { webContentsId: Number(focusedWebviewDevToolsTargetId) }
                : null,
            preferredWebviewDevToolsTarget: factoryContext.webSurfaceRuntime.getCopilotDevToolsTarget(),
            currentPageSnapshot: factoryContext.webSurfaceRuntime.getCurrentPageSnapshot(),
            webContents,
        });
    });
    if (!registered) {
        console.warn(`failed to register focused webview DevTools shortcut: ${factoryContext.FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT}`);
        return;
    }
    factoryContext.focusedWebviewDevToolsShortcutRegistered = true;
}

export async function createMainProcessRuntime_collectWebviewLoadDiagnostics_24(factoryContext: CreateMainProcessRuntimeContext, contents: Electron.WebContents, validatedUrl: string): Promise<Record<string, unknown>> {
    const sessionRef = contents.session;
    let resolvedProxy = "unknown";
    try {
        resolvedProxy = await sessionRef.resolveProxy(validatedUrl);
    }
    catch (error) {
        resolvedProxy = `resolve-proxy-failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
        guestId: contents.id,
        currentUrl: contents.getURL(),
        validatedUrl,
        userAgent: contents.getUserAgent(),
        resolvedProxy,
        sessionPartition: sessionRef.getStoragePath() || "default"
    };
}

export function createMainProcessRuntime_reportRendererDiagnostic_25(factoryContext: CreateMainProcessRuntimeContext, source: string, details: Record<string, unknown>) {
    const diagnosticLevel = details.diagnosticLevel === "debug" ||
        details.diagnosticLevel === "warn" ||
        details.diagnosticLevel === "error"
        ? details.diagnosticLevel
        : "error";
    const payload = {
        source,
        ...(source === "deprecated-compatibility" ? { desktopVersion: app.getVersion() } : {}),
        ...details
    };
    if (diagnosticLevel === "debug") {
        if (!isDesktopDevelopmentRuntime(app))
            return;
        console.debug("[renderer-diagnostic]", payload);
    }
    else if (diagnosticLevel === "warn") {
        console.warn("[renderer-diagnostic]", payload);
    }
    else {
        safeConsoleError("[renderer-diagnostic]", payload);
    }
}

export function createMainProcessRuntime_createWindow_26(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.createWindow();
}

export function createMainProcessRuntime_configureAppMediaPermissions_27(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.configureAppMediaPermissions();
}

export function createMainProcessRuntime_showMainWindow_28(factoryContext: CreateMainProcessRuntimeContext, targetPath?: string) {
    return factoryContext.appShellRuntime.showMainWindow(targetPath);
}

export function createMainProcessRuntime_notifyServicesChanged_29(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.notifyCoreServicesChanged();
    factoryContext.notifyDesktopDecorationsChanged();
}
