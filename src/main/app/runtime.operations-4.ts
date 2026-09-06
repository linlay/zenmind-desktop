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

import type { CreateMainProcessRuntimeContext } from "./runtime.shared";

export function createMainProcessRuntime_notifyCoreServicesChanged_1(factoryContext: CreateMainProcessRuntimeContext) {
    if (!isStartupPhaseAtLeast(factoryContext.appState.startupPhase, "shell-ready")) {
        console.info(`[main] skipped core service notification before shell-ready: ${factoryContext.appState.startupPhase}`);
        return;
    }
    void factoryContext.pluginBridgeRuntime.publishServiceStates();
    emitDesktopWsPush("service.changed", { changedAt: new Date().toISOString() });
    factoryContext.assistantBridgeRuntime?.scheduleNavigationRefresh(1000);
    const targetWindow = factoryContext.getMainWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("services.changed");
    }
}

export function createMainProcessRuntime_notifyDesktopDecorationsChanged_2(factoryContext: CreateMainProcessRuntimeContext) {
    if (factoryContext.appState.startupPhase !== "non-core-ready") {
        return;
    }
    if (app.isReady()) {
        factoryContext.refreshPluginDesktopGlobalShortcuts();
    }
}

export function createMainProcessRuntime_emitWebsChanged_3(factoryContext: CreateMainProcessRuntimeContext, details: Partial<Omit<WebsChangedEvent, "changedAt">>) {
    const payload: WebsChangedEvent = {
        changedAt: new Date().toISOString(),
        ...details
    };
    const targetWindow = factoryContext.getMainWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
        return;
    }
    targetWindow.webContents.send("webs.changed", payload);
}

export function createMainProcessRuntime_startResourceDirectoryWatcher_4(factoryContext: CreateMainProcessRuntimeContext) {
    if (factoryContext.resourceDirectoryWatcher) {
        return;
    }
    factoryContext.resourceDirectoryWatcher = createResourceDirectoryWatcher({
        app,
        platform: factoryContext.startupPlatform,
        onWebsChanged: factoryContext.emitWebsChanged,
        onPetsChanged: () => {
            factoryContext.petRuntime.refreshState();
        },
        onPluginsChanged: () => {
            loadInstalledPlugins(app);
            factoryContext.notifyServicesChanged();
        },
        onError: (message, error) => safeConsoleError(message, error)
    });
    factoryContext.resourceDirectoryWatcher.start();
}

export function createMainProcessRuntime_stopResourceDirectoryWatcher_5(factoryContext: CreateMainProcessRuntimeContext) {
    factoryContext.resourceDirectoryWatcher?.stop();
    factoryContext.resourceDirectoryWatcher = null;
}

export function createMainProcessRuntime_emitKanbanChanged_6(factoryContext: CreateMainProcessRuntimeContext) {
    emitDesktopWsPush("snapshot.updated", { changedAt: new Date().toISOString() });
    const targetWindow = factoryContext.getMainWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
        return;
    }
    targetWindow.webContents.send("kanban.changed");
}

export function createMainProcessRuntime_emitAssistantNavigationAgentsChanged_7(factoryContext: CreateMainProcessRuntimeContext, result: AssistantNavAgentItemsResult) {
    const targetWindow = factoryContext.getMainWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
    }
    if (factoryContext.petRuntime.isVisible()) {
        factoryContext.refreshDesktopPetState();
    }
}

export function createMainProcessRuntime_emitAssistantNavigationPushEvent_8(factoryContext: CreateMainProcessRuntimeContext, event: AssistantNavigationPushEvent) {
    const targetWindow = factoryContext.getMainWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("assistant.navigationPushEvent", event);
    }
}

export function createMainProcessRuntime_navigateMainWindow_9(factoryContext: CreateMainProcessRuntimeContext, targetPath: string) {
    return factoryContext.appShellRuntime.navigateMainWindow(targetPath);
}

export async function createMainProcessRuntime_openAssistantWorker_10(factoryContext: CreateMainProcessRuntimeContext, request: AssistantWorkerOpenRequest) {
    const targetAgentKey = request.agentKey ?? request.workerKey ?? "";
    const openResult = await factoryContext.showAssistantTargetWindow("assistant-worker", createAgentWebclientRoute({
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

export function createMainProcessRuntime_createAppTray_11(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.createAppTray();
}

export function createMainProcessRuntime_runNonCoreStartupTask_12(factoryContext: CreateMainProcessRuntimeContext, label: string, task: () => void) {
    try {
        task();
    }
    catch (error) {
        safeConsoleError(`failed to start non-core runtime: ${label}`, {
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

export function createMainProcessRuntime_startSsoCredentialDependentRuntimes_13(factoryContext: CreateMainProcessRuntimeContext) {
    if (!factoryContext.nonCoreDesktopRuntimeStarted || factoryContext.ssoCredentialDependentRuntimesStarted ||
        !isDesktopSsoCredentialRuntimeReady()) {
        return;
    }
    factoryContext.ssoCredentialDependentRuntimesStarted = true;
    factoryContext.runNonCoreStartupTask("enterprise chat", () => {
        void factoryContext.enterpriseChatRuntime.setEnabled(readEnterpriseImSettings(app, factoryContext.startupPlatform).enabled);
    });
    void startTunnelHubRuntimeIfEnabled().catch((error) => {
        safeConsoleError("failed to start Desktop Tunnel Hub", {
            error: error instanceof Error ? error.message : String(error)
        });
    });
}

export function createMainProcessRuntime_applyDesktopSsoRestoreResult_14(factoryContext: CreateMainProcessRuntimeContext, result: DesktopSsoRestoreResult) {
    const previousRestoreState = factoryContext.desktopSsoRestoreState;
    factoryContext.desktopSsoRestoreState = result.state;
    if (result.state === "signed_out") {
        factoryContext.ssoCredentialDependentRuntimesStarted = false;
        return;
    }
    if (result.state !== "authenticated" ||
        previousRestoreState === "authenticated" ||
        !isDesktopSsoCredentialRuntimeReady()) {
        return;
    }
    factoryContext.startSsoCredentialDependentRuntimes();
    factoryContext.assistantBridgeRuntime?.refreshKanbanDeviceInfo();
    void refreshMarketCatalog(app).catch((error) => {
        safeConsoleError("failed to refresh Market after desktop sso restore", {
            error: error instanceof Error ? error.message : String(error)
        });
    });
    void factoryContext.enterpriseChatRuntime.refresh().catch((error) => {
        safeConsoleError("failed to refresh enterprise chat after desktop sso restore", {
            error: error instanceof Error ? error.message : String(error)
        });
    });
}

export function createMainProcessRuntime_startNonCoreDesktopRuntime_15(factoryContext: CreateMainProcessRuntimeContext) {
    if (factoryContext.nonCoreDesktopRuntimeStarted) {
        return;
    }
    factoryContext.nonCoreDesktopRuntimeStarted = true;
    void factoryContext.refreshDesktopSsoIdentityToken().catch((error: unknown) => {
        safeConsoleError("failed to refresh desktop sso token during startup", {
            error: error instanceof Error ? error.message : String(error)
        });
    });
    const desktopSsoRefreshTimer = setInterval(() => {
        void factoryContext.refreshDesktopSsoIdentityToken().catch((error: unknown) => {
            safeConsoleError("failed to refresh desktop sso token before expiry", {
                error: error instanceof Error ? error.message : String(error)
            });
        });
    }, 5 * 60000);
    desktopSsoRefreshTimer.unref();
    app.once("before-quit", () => clearInterval(desktopSsoRefreshTimer));
    factoryContext.runNonCoreStartupTask("webapp install recovery", () => {
        recoverWebappInstallTransactions(app);
    });
    factoryContext.runNonCoreStartupTask("desktop pet", () => {
        const desktopPetSettings = factoryContext.petRuntime.getSettings();
        if (isDesktopPetSupportedPlatform(factoryContext.startupPlatform) && desktopPetSettings?.enabled === true) {
            factoryContext.showDesktopPetWindow();
        }
        else if (desktopPetSettings) {
            factoryContext.refreshDesktopPetState();
        }
    });
    factoryContext.runNonCoreStartupTask("application menu", () => factoryContext.buildApplicationMenu());
    factoryContext.runNonCoreStartupTask("plugin desktop bridge", () => factoryContext.pluginBridgeRuntime.setDesktopReady());
    factoryContext.runNonCoreStartupTask("desktop ws server", () => {
        factoryContext.assistantBridgeRuntime.startDesktopWsServerIfEnabled(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled);
    });
    factoryContext.startSsoCredentialDependentRuntimes();
    factoryContext.setStartupPhase("non-core-ready");
    factoryContext.notifyDesktopDecorationsChanged();
}

export async function createMainProcessRuntime_showFileDialog_16(factoryContext: CreateMainProcessRuntimeContext, options: any, ownerWindow: Electron.CrossProcessExports.BrowserWindow | null) {
    return factoryContext.appShellRuntime.showFileDialog(options, ownerWindow);
}

export async function createMainProcessRuntime_showSaveDialog_17(factoryContext: CreateMainProcessRuntimeContext, options: any, ownerWindow: Electron.CrossProcessExports.BrowserWindow | null) {
    return factoryContext.appShellRuntime.showSaveDialog(options, ownerWindow);
}

export async function createMainProcessRuntime_showMessageBox_18(factoryContext: CreateMainProcessRuntimeContext, options: any, ownerWindow: Electron.CrossProcessExports.BrowserWindow | null) {
    return factoryContext.appShellRuntime.showMessageBox(options, ownerWindow);
}

export function createMainProcessRuntime_emitAssistantAttachmentProgress_19(factoryContext: CreateMainProcessRuntimeContext, progress: AssistantAttachmentTaskProgress) {
    const targetWindow = factoryContext.getMainWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("assistant.attachmentProgress", progress);
    }
}

export function createMainProcessRuntime_buildApplicationMenu_20(factoryContext: CreateMainProcessRuntimeContext) {
    return factoryContext.appShellRuntime.buildApplicationMenu();
}

export function createMainProcessRuntime_showArchiveDialog_21(factoryContext: CreateMainProcessRuntimeContext, title: string, extensions?: string[]) {
    return factoryContext.appShellRuntime.showArchiveDialog(title, extensions);
}
