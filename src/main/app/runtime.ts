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
  type Session,
  webContents,
} from "electron";
import { issueAgentAccessToken } from "../agent-auth";
import {
  cancelDesktopSsoLogin,
  completeDesktopSsoCookieLogin,
  desktopSsoAccessTokenNeedsRefresh,
  finalizeDesktopSsoLoginAttempt,
  failDesktopSsoFlow,
  failDesktopSsoStep,
  getDesktopSsoAccessToken,
  getDesktopSsoStatus,
  isDesktopSsoCredentialRuntimeReady,
  isDesktopSsoLoginCompletionUrl,
  logoutDesktopSso,
  startDesktopSsoLogin,
} from "../oidc-sso";
import { loadBuiltinServices } from "../builtin-loader";
import {
  getResponsiveServiceState,
  getServiceState,
  listServices,
  readServiceLog,
  runStartupPreparation,
} from "../services/manager";
import { restorePublishedWebapps } from "../webs/webapps/publication-runtime";
import { webappManager } from "../webs/webapps/manager";
import { webappWindowManager } from "../webs/webapps/window-manager";
import { loadInstalledPlugins } from "../plugin-loader";
import { configurePluginResources, retryPendingPluginResourceSync } from "../plugin-resources";
import { revealPathInFileManager } from "../reveal-path";
import { createAppShellRuntime, type AppShellRuntime } from "../app-shell/runtime";
import { readDesktopProfileFromRoot } from "../desktop-profile-store";
import { createServicesRuntime } from "../services/runtime";
import type {
  AssistantAttachmentTaskProgress,
  AssistantEvent,
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
  SURFACE_RUNTIME_DOWNLOAD_STATE_CHANNEL,
  type SurfaceRuntimeDownloadState,
} from "../../shared/surface-runtime-budget";
import {
  desktopDataRootExists,
  ensureDataRoot,
  getDataRoot,
  getDesktopConfigRoot,
  getElectronUserDataRoot,
} from "../user-paths";
import { EnterpriseChatRuntime } from "../enterprise-chat-runtime";
import { redactEnterpriseChatSupportText } from "../enterprise-chat-support-bundle";
import { readEnterpriseImSettings } from "../enterprise-im-settings";
import { createLogsRuntime } from "../logs/runtime";
import { applyDesktopInitBootstrap } from "../desktop-init-bootstrap";
import {
  bundledEnvZipExists,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeEnvNeedsBundledSeedRefresh,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  shouldRequireEnvZipImport,
  type EnvRootConflictDecision,
} from "../env-bootstrap";
import { createStartupEnvironmentRuntime } from "./startup-environment";
import { safeConsoleError } from "../safe-console";
import {
  callAgentPlatform,
  handleDesktopActionRequest
} from "../desktop-action-bridge";
import { callDesktopActionRenderer } from "../desktop-action-renderer";
import { emitDesktopWsPush } from "../desktop-ws-server";
import {
  startTunnelHubRuntimeIfEnabled,
  stopTunnelHubRuntime,
} from "../tunnel-hub-runtime";
import {
  AGENT_WEBCLIENT_TARGET_PATH,
  createAgentWebclientRoute
} from "../../shared/agent-webclient-routes";
import {
  registerDesktopPetAssetProtocol,
  registerDesktopPetAssetProtocolScheme,
} from "../assistant/pet/pet-asset-protocol";
import {
  registerWebsiteFaviconProtocol,
  registerWebsiteFaviconProtocolScheme,
} from "../webs/websites/favicon-protocol";
import {
  registerDesktopSsoAvatarProtocol,
  registerDesktopSsoAvatarProtocolScheme,
} from "../sso-avatar-protocol";
import { registerChatWorkPanelLocalFileProtocolScheme } from "../chat-work-panel-local-files";
import {
  isDesktopPetSupportedPlatform,
  saveDesktopPetSettings,
} from "../assistant/pet/desktop-pet";
import { createDesktopPetRuntime, type DesktopPetRuntime } from "../assistant/pet/runtime";
import { registerMainIpcHandlers } from "../ipc/register";
import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge
} from "../assistant/copilot/screenshot";
import { initializeMainI18n, setMainLocale, t } from "../i18n/main-i18n";
import { createStartupRestoreController } from "../startup-restore";
import {
  getFocusedWebviewDevToolsShortcut,
  isDevToolsShortcut,
  isGlobalSearchShortcut,
  isWorkPanelCloseShortcut,
  resolveGlobalSearchCommandShortcut,
} from "../platform-adapter";
import { MAIN_CHAT_SURFACE_ID } from "../../shared/surface-identity";
import { configureSystemIdentity } from "./system-identity";
import { openCurrentWebviewDevTools } from "../focused-webview-devtools";
import {
  createDesktopSsoController,
  type DesktopSsoRestoreResult
} from "../sso-controller";
import { createCdpIntegration } from "../cdp-integration";
import { createWebSurfaceRuntime } from "../webs/surface-runtime";
import { createWebviewContextMenuController } from "../webview-context-menu-controller";
import { createSettingsRuntime } from "../settings/runtime";
import { createMainAppState } from "../app-state";
import {
  createMainProcessContext,
  type MainProcessContext,
} from "../main-process-context";
import { getMainPreloadPath, resolveElectronBundleRootFromRuntimeDir } from "../electron-bundle-paths";
import {
  loadRendererRoute,
} from "../renderer-route";
import { parseSafeLoopbackWebUrl } from "../loopback-url";
import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues,
} from "../plugin-settings";
import {
  refreshPluginGlobalShortcuts,
  unregisterPluginGlobalShortcuts,
} from "../plugin-global-shortcuts";
import { invokePluginDesktopAction } from "../plugin-actions";
import { cleanupRetiredPluginUserData } from "../retired-plugins";
import { cleanupProgramDataForVersion } from "../program-data-cleanup";
import { createAssistantBridgeRuntime, type AssistantBridgeRuntime } from "../bridge/assistant-runtime";
import { createAssistantRunWakeLock } from "../bridge/assistant-wake-lock";
import { createFirstInstallBootstrapNavigation } from "../assistant/core/first-install-bootstrap-navigation";
import { RealtimeBroker } from "../realtime/realtime-broker";
import { createPluginClipboardBridge } from "../bridge/plugin-clipboard";
import { createPluginBridgeRuntime, type PluginBridgeRuntime } from "../bridge/plugin-runtime";
import {
  createInstallerShutdownArgs,
  requestMainSingleInstanceLock,
} from "../lifecycle/single-instance";
import { createStartupPipeline } from "../lifecycle/startup";
import {
  isStartupPhaseAtLeast,
  type StartupPhase,
} from "../lifecycle/startup-phases";
import { createShutdownCleanupRunner } from "../lifecycle/shutdown";
import {
  createNoPrimaryShutdownReport,
  parseInstallerShutdownRequest,
  writeShutdownAck
} from "../lifecycle/shutdown-ack";
import { registerMainAppEvents } from "./app-events";
import { registerDesktopOpenProtocolClient } from "./deep-link";
import {
  createResourceDirectoryWatcher,
  type ResourceDirectoryWatcher
} from "../resource-directory-watcher";
import { recoverWebappInstallTransactions } from "../webs/webapps/install-transaction";
import { configureMarketAccessTokenIssuer, refreshMarketCatalog } from "../marketplace";
import { configureAgentMarketPlatformCaller } from "../marketplace/agent-market";

export function createMainProcessRuntime() {
  const startupPlatform = process.platform;
  const isFirstDesktopInstall = !desktopDataRootExists(app, startupPlatform);
  const runtimeRootAtProcessStart = resolveRuntimeRoot(app, startupPlatform);
  const runtimeRootExistedAtStartup = runtimeRootExists(app, startupPlatform);
  const runtimeEnvExistedAtStartup = runtimeEnvExists(app, startupPlatform);
  const firstInstallBootstrapNavigation = createFirstInstallBootstrapNavigation(isFirstDesktopInstall);
  configureAgentMarketPlatformCaller((targetPath, options) =>
    callAgentPlatform(app, targetPath, options)
  );
  const appState = createMainAppState();
  const instrumentedSurfaceDownloadSessions = new WeakSet<Session>();
  let surfaceDownloadSequence = 0;
  const instrumentSurfaceDownloads = (targetSession: Session) => {
    if (instrumentedSurfaceDownloadSessions.has(targetSession)) return;
    instrumentedSurfaceDownloadSessions.add(targetSession);
    targetSession.on("will-download", (_event, item, sourceContents) => {
      if (sourceContents.getType() !== "webview") return;
      const ownerContents = sourceContents.hostWebContents;
      if (!ownerContents || ownerContents.isDestroyed()) return;

      surfaceDownloadSequence += 1;
      const downloadId = `surface-download-${surfaceDownloadSequence}`;
      const publishDownloadState = (active: boolean) => {
        if (ownerContents.isDestroyed()) return;
        const state: SurfaceRuntimeDownloadState = {
          downloadId,
          webContentsId: sourceContents.id,
          active,
        };
        ownerContents.send(SURFACE_RUNTIME_DOWNLOAD_STATE_CHANNEL, state);
      };
      publishDownloadState(true);
      item.once("done", () => publishDownloadState(false));
    });
  };
  app.on("session-created", instrumentSurfaceDownloads);
  void app.whenReady().then(() => instrumentSurfaceDownloads(session.defaultSession));
  const mainProcessContext = createMainProcessContext({
    state: appState,
    app,
    ipcMain,
    platform: process.platform,
    shell,
    session,
    nativeTheme,
    webContents
  });
  const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
  const LOG_VIEWER_ROUTE = "/log-viewer";
  const AGENT_REALTIME_INSPECTOR_ROUTE = "/agent-realtime-inspector";
  const DESKTOP_ACTION_WORKBENCH_ROUTE = "/desktop-action-workbench";
  const MAIN_PROCESS_DIR = resolveElectronBundleRootFromRuntimeDir(__dirname, mainProcessContext.platform);
  const MAIN_PRELOAD_PATH = getMainPreloadPath(MAIN_PROCESS_DIR, mainProcessContext.platform);
  const FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT = getFocusedWebviewDevToolsShortcut(mainProcessContext.platform);
  const INSTALLER_SHUTDOWN_ARGS = createInstallerShutdownArgs(INSTALLER_SHUTDOWN_ARG);
  const ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS =
    ".enterprise-chat-floating { visibility: hidden !important; }";
  
  const assistantRunWakeLock = createAssistantRunWakeLock(mainProcessContext.platform, {
    isEnabled: () => readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.preventSleepWhileRunning
  });
  const realtimeBroker = new RealtimeBroker({
    app,
    issueAccessToken: issueAgentAccessToken,
    onDiagnostic: (message) => console.warn(`[agent-platform-realtime] ${message}`)
  });
  const pluginClipboardBridge = createPluginClipboardBridge({
    platform: mainProcessContext.platform,
    clipboard,
    globalShortcut
  });
  let petRuntime: DesktopPetRuntime;
  let assistantBridgeRuntime: AssistantBridgeRuntime;
  let pluginBridgeRuntime: PluginBridgeRuntime;
  let appShellRuntime: AppShellRuntime;
  let resourceDirectoryWatcher: ResourceDirectoryWatcher | null = null;
  const startupRestoreController = createStartupRestoreController({
    onChange: (state) => {
      if (!appState.mainWindow || appState.mainWindow.isDestroyed()) {
        return;
      }
      appState.mainWindow.webContents.send("services.startupRestoreState", state);
    }
  });
  const servicesRuntime = createServicesRuntime({
    app,
    state: appState,
    getMainWindow: () => appState.mainWindow,
    notifyServicesChanged,
    delay
  });
  
  registerDesktopPetAssetProtocolScheme(protocol);
  registerWebsiteFaviconProtocolScheme(protocol);
  registerDesktopSsoAvatarProtocolScheme(protocol);
  registerChatWorkPanelLocalFileProtocolScheme(protocol);
  
  const webSurfaceRuntime = createWebSurfaceRuntime({
    app,
    state: appState,
    webContents,
    reportRegistrationDiagnostic: (diagnostic) => {
      safeConsoleError("[surface-registration]", diagnostic);
    },
    navigateMainWindow,
    delay,
    t
  });
  const webviewContextMenuController = createWebviewContextMenuController({
    platform: mainProcessContext.platform,
    browserSurfaces: webSurfaceRuntime.browserSurfaceRegistry,
    getMainWindow: () => appState.mainWindow,
    openBrowserUrl: webSurfaceRuntime.openBrowserUrl,
    openWorkPanelUrl: ({ sourceGuestId, url }) => {
      const target = webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(sourceGuestId);
      const mainWindow = appState.mainWindow;
      if (
        !target ||
        (target.surfaceType !== "chat-work-panel" && target.presentationScope !== "workpanel") ||
        !mainWindow ||
        mainWindow.isDestroyed()
      ) {
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
      if (
        target.serviceId !== "agent-webclient" ||
        contents.session !== session.fromPartition(`persist:${STORAGE_NAMESPACE}-service-agent-webclient`)
      ) {
        return false;
      }
      const liveUrl = parseSafeLoopbackWebUrl(contents.getURL());
      if (!liveUrl) return false;
      const service = await getResponsiveServiceState(app, "agent-webclient");
      const serviceUrl = parseSafeLoopbackWebUrl(service.healthMeta.webUrl);
      return Boolean(
        service.status === "running" &&
        serviceUrl &&
        new URL(liveUrl.toString()).origin === new URL(serviceUrl.toString()).origin
      );
    },
    t,
    report: reportRendererDiagnostic
  });
  let refreshDesktopSsoIdentityToken = async (_force = false) => getDesktopSsoAccessToken() || "";
  const enterpriseChatRuntime = new EnterpriseChatRuntime({
    app,
    platform: mainProcessContext.platform,
    getServerUrl: () =>
      readEnterpriseImSettings(app, mainProcessContext.platform).baseUrl,
    initialEnabled: readEnterpriseImSettings(
      app,
      mainProcessContext.platform
    ).enabled,
    refreshIdentityToken: () => refreshDesktopSsoIdentityToken(true),
    selectFiles: async () => {
      const result = await showFileDialog({
        title: t("enterpriseChat.selectFiles"),
        properties: ["openFile", "multiSelections"]
      });
      return result.canceled ? [] : result.filePaths;
    },
    selectAvatar: async () => {
      const result = await showFileDialog({
        title: t("enterpriseChat.selectAvatar"),
        properties: ["openFile"],
        filters: [{ name: t("enterpriseChat.avatarImage"), extensions: ["png", "jpg", "jpeg", "webp"] }]
      });
      return result.canceled ? [] : result.filePaths;
    },
    showSaveDialog: (options) => showSaveDialog(options),
    captureScreenshot: (mode) => captureEnterpriseChatScreenshot(mode),
    createSupportArtifact: async (action, args) => {
      const readArg = (key: string) => typeof args[key] === "string" ? args[key].trim() : "";
      let filename = "desktop-support.txt";
      let content = "";
      if (action === "desktop.support.requestServiceLogs") {
        const serviceId = (readArg("serviceId") || readArg("id")) as Parameters<typeof readServiceLog>[1];
        const target = readArg("target") === "error" ? "error" : "main";
        const result = await readServiceLog(app, serviceId, target, { limitBytes: 512 * 1024 });
        filename = `service-${serviceId}-${target}.log`;
        content = result.content;
      } else if (action === "desktop.support.requestWebappLogs") {
        const webappId = readArg("webappId") || readArg("id");
        const target = readArg("target") === "error" ? "error" : "main";
        const result = webappManager.runtime.readLog(app, webappId, target, { limitBytes: 512 * 1024 });
        filename = `webapp-${webappId}-${target}.log`;
        content = result.content;
      } else if (action === "desktop.support.requestSystemInfo") {
        filename = "desktop-system-info.json";
        content = `${JSON.stringify({
          appVersion: app.getVersion(),
          platform: mainProcessContext.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          locale: app.getLocale()
        }, null, 2)}\n`;
      } else {
        throw new Error("Unsupported support artifact request.");
      }
      return {
        filename,
        contentType: filename.endsWith(".json") ? "application/json" : "text/plain",
        bytes: Buffer.from(redactEnterpriseChatSupportText(
          content,
          app.getPath("home"),
          getDataRoot(app)
        ), "utf8")
      };
    },
    executeDesktopAction: async (request) => {
      const response = await handleDesktopActionRequest(
        assistantBridgeRuntime.desktopActionOptions,
        {
          requestId: `enterprise-im-${request.messageId}`,
          action: request.action,
          args: request.args,
          permissionMode: "full_access",
          source: {
            chatId: `enterprise-im:${request.conversationId}`
          }
        }
      );
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
      const targetWindow = appState.mainWindow;
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("enterpriseChat.stateChanged", snapshot);
      }
    }
  });
  const cdpIntegration = createCdpIntegration({
    browserSurfaces: webSurfaceRuntime.browserSurfaceRegistry,
    getCurrentPageSnapshot: () => appState.currentPageSnapshot,
    listServices: () => listServices(app),
    isLoopbackUrl: parseSafeLoopbackWebUrl,
    switchTab: async (surfaceId, tabId, ownerChatId) => {
      const response = await callDesktopActionRenderer({
        requestId: `cdp-switch-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action: ownerChatId ? "desktop.workpanel.activateTab" : "desktop.web.switchTab",
        args: ownerChatId ? { tabId } : { surfaceId, tabId },
        ...(ownerChatId ? { source: { chatId: ownerChatId } } : {})
      }, {
        getMainWindow: () => appState.mainWindow,
        pendingRequests: appState.desktopActionRendererRequests
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
        getMainWindow: () => appState.mainWindow,
        pendingRequests: appState.desktopActionRendererRequests
      });
      if (!response.ok) {
        throw new Error(response.error?.message || "Desktop tab could not be closed.");
      }
      return response.result;
    },
    version: `${PRODUCT_NAME}/${app.getVersion()} Electron/${process.versions.electron}`
  });
  
  // Keep dev Electron runs on the same data root as packaged builds.
  const systemIdentityRuntime = configureSystemIdentity({
    app,
    platform: mainProcessContext.platform,
    appId: APP_ID,
    productName: PRODUCT_NAME,
    mainProcessDir: MAIN_PROCESS_DIR,
    resourcesPath: process.resourcesPath,
    nativeImage,
    safeConsoleError
  });
  const desktopAppInfo = systemIdentityRuntime.desktopAppInfo;
  const bundledEnvZipExistsAtStartup = bundledEnvZipExists(app, mainProcessContext.platform);
  const bundledSeedRefreshNeededAtStartup =
    bundledEnvZipExistsAtStartup &&
    runtimeEnvNeedsBundledSeedRefresh(app, mainProcessContext.platform);
  const requireEnvZipImportAtStartup = shouldRequireEnvZipImport({
    platform: mainProcessContext.platform,
    runtimeEnvExistedAtStartup
  }) || bundledSeedRefreshNeededAtStartup;
  const envZipConflictNeedsDecision = shouldPromptEnvRootConflict({
    platform: mainProcessContext.platform,
    isFirstDesktopInstall,
    bundledEnvZipExists: bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup
  });
  const oldRootDecisionRef: { current: EnvRootConflictDecision | undefined } = { current: undefined };
  let startupEnvImportFailureMessage: string | null = null;
  let nonCoreDesktopRuntimeStarted = false;
  let ssoCredentialDependentRuntimesStarted = false;
  let desktopSsoRestoreState: DesktopSsoRestoreResult["state"] = "signed_out";
  let focusedWebviewDevToolsShortcutRegistered = false;
  function setStartupPhase(phase: StartupPhase) {
    if (appState.startupPhase === phase) {
      return;
    }
    appState.startupPhase = phase;
    console.info(`[main] startup phase: ${phase}`);
  }

  function initializeUserDataRootsAndSettings() {
    ensureDataRoot(app);
    applyDesktopInitBootstrap(app, mainProcessContext.platform);
    const initialLocaleSettings = initializeMainI18n(app, { isFirstInstall: isFirstDesktopInstall });
    if (isFirstDesktopInstall) {
      setMainLocale(app, initialLocaleSettings.locale);
    }
  
    const electronUserDataRoot = getElectronUserDataRoot(app);
    fs.mkdirSync(electronUserDataRoot, { recursive: true });
    app.setPath("userData", electronUserDataRoot);
    const programDataCleanup = cleanupProgramDataForVersion(app, desktopAppInfo.version);
    if (programDataCleanup.cleaned) {
      console.info(
        `[main] refreshed program data for ${desktopAppInfo.version}: ${programDataCleanup.removedPaths.length} path(s) removed`
      );
    } else if (programDataCleanup.failedPaths.length > 0) {
      console.warn(
        `[main] program data cleanup incomplete for ${desktopAppInfo.version}: ${
          programDataCleanup.failedPaths.map((item) => `${item.path}: ${item.message}`).join("; ")
        }`
      );
    }
    cleanupRetiredPluginUserData(app);
  
    petRuntime.initializeState(isFirstDesktopInstall);
  }
  
  const gotSingleInstanceLock = requestMainSingleInstanceLock(app);
  
  const startupInstallerShutdownRequest = parseInstallerShutdownRequest(
    process.argv,
    INSTALLER_SHUTDOWN_ARGS,
    STORAGE_NAMESPACE
  );
  if (startupInstallerShutdownRequest.requested && gotSingleInstanceLock) {
    if (startupInstallerShutdownRequest.ackPath) {
      try {
        writeShutdownAck(
          startupInstallerShutdownRequest.ackPath,
          "NO_PRIMARY",
          createNoPrimaryShutdownReport()
        );
      } catch (error) {
        console.error("[main] failed to write NO_PRIMARY shutdown acknowledgement", error);
      }
    }
    app.exit(0);
    return { start() {} };
  }
  if (!gotSingleInstanceLock) {
    return { start() {} };
  }
  
  function delay(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  
  const logsRuntime = createLogsRuntime({
    app,
    preloadPath: MAIN_PRELOAD_PATH,
    routePath: LOG_VIEWER_ROUTE,
    platform: mainProcessContext.platform,
    getOwnerWindow: () => appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null,
    loadRendererRoute,
    onRendererError: safeConsoleError
  });
  appShellRuntime = createAppShellRuntime({
    app,
    state: appState,
    platform: mainProcessContext.platform,
    mainProcessDir: MAIN_PROCESS_DIR,
    productName: PRODUCT_NAME,
    resourcesPath: process.resourcesPath,
    session,
    shell,
    nativeTheme,
    systemPreferences,
    t,
    logsRuntime,
    agentRealtimeInspectorRoute: AGENT_REALTIME_INSPECTOR_ROUTE,
    desktopActionWorkbenchRoute: DESKTOP_ACTION_WORKBENCH_ROUTE,
    loadRendererRoute,
    parseSafeLoopbackWebUrl,
    isDevToolsShortcut,
    isGlobalSearchShortcut,
    isWorkPanelCloseShortcut,
    isWorkPanelWebview: (contents) => {
      const target = webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      return Boolean(
        target &&
        (target.presentationScope === "workpanel" || (target.active &&
          target.surfaceLevel === "child" &&
          target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
          target.ownerChatId &&
          [
            "overview",
            "debug",
            "project",
            "file-diff",
            "artifact",
            "planning",
            "agent",
            "copilot",
            "skill",
            "workpanel-web",
          ].includes(target.surfaceRole)
        ))
      );
    },
    resolveGlobalSearchCommandShortcut,
    handleDesktopSsoWebviewNavigation,
    shouldOpenWebviewPopupInWorkPanelTab: (contents) =>
      (() => {
        const target = webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
        return target?.surfaceType === "chat-work-panel" || target?.presentationScope === "workpanel";
      })(),
    resolveBlobPopupTarget: (contents) => {
      const target = webSurfaceRuntime.browserSurfaceRegistry.resolveWebviewSurfaceTarget(contents.id);
      if (target?.surfaceType === "chat-work-panel" || target?.presentationScope === "workpanel") return "work-panel";
      if (target?.surfaceType === "website" || target?.surfaceType === "browser") {
        return "desktop-browser";
      }
      return null;
    },
    attachWebviewContextMenu: webviewContextMenuController.attach,
    collectWebviewLoadDiagnostics,
    reportRendererDiagnostic,
    safeConsoleError,
    ensureDockIdentity: () => systemIdentityRuntime.ensureDockIdentity(),
    beginAppQuitWithoutConfirmation,
    requestAppQuit,
    openAssistantWorker,
    getDesktopPetEnabled: () => appState.desktopPetSettings?.enabled === true,
    isDesktopPetSupported: () => isDesktopPetSupportedPlatform(mainProcessContext.platform),
    showDesktopPetWindow,
    hideDesktopPetWindow,
    restoreDesktopPetWindowLayering,
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
      } catch {
        return false;
      }
      return webappManager.runtime.allowsLocalPageCapability(requestingUrl, "native.microphone");
    }
  });
  webappWindowManager.setDisposalListener((webappId) => {
    emitWebsChanged({
      phase: "disposing",
      webappId
    });
  });
  const startupEnvironmentRuntime = createStartupEnvironmentRuntime({
    app,
    platform: mainProcessContext.platform,
    productName: PRODUCT_NAME,
    envZipConflictNeedsDecision,
    requireEnvZipImportAtStartup,
    runtimeRootAtProcessStart,
    oldRootDecisionRef,
    startupRestoreController,
    showMessageBox: (options) => appShellRuntime.showMessageBox(options),
    t
  });
  petRuntime = createDesktopPetRuntime({
    app,
    platform: mainProcessContext.platform,
    state: appState,
    screen,
    preloadPath: MAIN_PRELOAD_PATH,
    loadRendererRoute,
    showMainWindow,
    openAssistantWorker,
    publishPluginAssistantActiveTasks: (tasks, runningTaskCount) =>
      pluginBridgeRuntime.publishAssistantActiveTasks(tasks, runningTaskCount),
    refreshTrayContextMenu: () => appShellRuntime.refreshTrayContextMenu(),
    getResponsiveServiceState,
    issueAgentAccessToken,
    realtimeBroker
  });
  pluginBridgeRuntime = createPluginBridgeRuntime({
    app,
    clipboardBridge: pluginClipboardBridge,
    getServiceState: (serviceId) => getServiceState(app, serviceId),
    listServices: (targetApp) => listServices(targetApp),
    retryPendingPluginResourceSync,
    notifyAgentPlatformConfigChanged: () => notifyServicesChanged(),
    getAssistantActiveTasks: () => petRuntime.getAssistantActiveTasksSnapshotForPlugins(),
    queryAgentPlatform: (params) => callAgentPlatform(app, "/api/query", {
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
  const desktopSsoController = createDesktopSsoController({
    app,
    platform: mainProcessContext.platform,
    session,
    getMainWindow: () => appState.mainWindow,
    openBrowserUrl: webSurfaceRuntime.openBrowserUrl,
    openExternal: shell.openExternal,
    onRestoreResult: applyDesktopSsoRestoreResult
  });
  configureMarketAccessTokenIssuer(async (_marketApp, reason) => {
    const currentToken = isDesktopSsoCredentialRuntimeReady()
      ? getDesktopSsoAccessToken() || ""
      : "";
    if (currentToken && reason === "missing") {
      return currentToken;
    }
    return desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(true);
  });
  refreshDesktopSsoIdentityToken = async (force = false) => {
    const restoreResult = await desktopSsoController.retryDesktopSsoSessionRestoreIfNeeded();
    applyDesktopSsoRestoreResult(restoreResult);
    if (desktopSsoRestoreState === "temporarily_unavailable") {
      return "";
    }
    const needsRefresh = force || desktopSsoAccessTokenNeedsRefresh(app);
    const accessToken = await desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded(force);
    if (needsRefresh && accessToken) {
      appState.kanbanRuntime?.refreshDeviceInfo();
      void enterpriseChatRuntime.refresh().catch((error) => {
        safeConsoleError("failed to refresh enterprise chat after desktop sso token renewal", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return accessToken;
  };

  const settingsRuntime = createSettingsRuntime({
    app,
    platform: mainProcessContext.platform,
    state: appState,
    getLogViewerWindow: () => logsRuntime.getLogViewerWindow(),
    buildApplicationMenu,
    refreshTrayContextMenu: () => appShellRuntime.refreshTrayContextMenu(),
    refreshDesktopPetState: () => refreshDesktopPetState(),
    showDesktopPetWindow: () => showDesktopPetWindow(),
    hideDesktopPetWindow: () => hideDesktopPetWindow(),
    broadcastDesktopSsoStatus: (status) => desktopSsoController.broadcastStatus(status),
    notifyServicesChanged,
    emitKanbanChanged,
    refreshDesktopActionBridge: () => assistantBridgeRuntime.refreshDesktopActionBridge(),
    refreshEnterpriseChat: () => {
      void enterpriseChatRuntime.reloadConfiguration(
        readEnterpriseImSettings(app, mainProcessContext.platform).enabled
      );
    }
  });
  assistantBridgeRuntime = createAssistantBridgeRuntime({
    app,
    desktopAppInfo,
    context: mainProcessContext,
    assistantRunWakeLock,
    cdpIntegration,
    getResponsiveServiceState,
    issueAgentAccessToken,
    realtimeBroker,
    refreshDesktopSsoAccessToken: () => refreshDesktopSsoIdentityToken(true),
    canUseDesktopSsoCredentials: isDesktopSsoCredentialRuntimeReady,
    callAgentPlatform,
    showMainWindow,
    showFileDialog,
    showSaveDialog,
    openLogViewerWindow,
    listKanbanLocalAgents: () => petRuntime.listKanbanLocalAgents(),
    emitKanbanChanged,
    emitAssistantNavigationAgentsChanged,
    emitAssistantNavigationPushEvent,
    handleDesktopPetAssistantEvent: (event) => petRuntime.handleAssistantEvent(event),
    onTunnelConnected: () => restorePublishedWebapps(app),
    desktopPet: {
      refreshState: () => petRuntime.refreshState(),
      showWindow: () => petRuntime.showWindow(),
      hideWindow: () => petRuntime.hideWindow(),
      saveSettings: (input) => {
        appState.desktopPetSettings = saveDesktopPetSettings(app, input, mainProcessContext.platform);
        return petRuntime.refreshState();
      }
    },
    safeConsoleError,
    logger: console
  });
  const startupPipeline = createStartupPipeline({
    app,
    desktopVersion: desktopAppInfo.version,
    isFirstDesktopInstall,
    getEnvImportFailureMessage: () => startupEnvImportFailureMessage,
    startupRestoreController,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyCoreServicesChanged,
    startShellRuntime: () => runNonCoreStartupTask("app tray", () => createAppTray()),
    startNonCoreRuntime: startNonCoreDesktopRuntime,
    setStartupPhase,
    runServiceMutation: servicesRuntime.runServiceMutation,
    runStartupPreparation,
    t,
    onError: safeConsoleError
  });
  const runShutdownCleanup = createShutdownCleanupRunner({
    app,
    getMode: () => appState.shutdownMode,
    getExistingPromise: () => appState.shutdownCleanupPromise,
    setPromise: (promise) => {
      appState.shutdownCleanupPromise = promise;
    },
    markComplete: (report) => {
      appState.shutdownReport = report;
      appState.shutdownCleanupComplete = true;
    },
    emitProgress: (progress) => {
      const targetWindow = appState.mainWindow;
      if (!targetWindow || targetWindow.isDestroyed()) {
        return;
      }
      try {
        targetWindow.webContents.send("desktopShell.shutdownProgress", progress);
      } catch (error) {
        console.warn("[main] failed to render shutdown progress", error);
      }
    }
  });
  
  async function handleDesktopSsoWebviewNavigation(url: string) {
    let sessionCompleted = false;
    try {
      const status = getDesktopSsoStatus(app);
      if (appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
        return;
      }
      appState.desktopSsoWebviewCompletionInFlight = true;
      await desktopSsoController.syncBrowserCookies();

      const browserSessionStatus = await desktopSsoController.validateBrowserSession();
      if (!browserSessionStatus) {
        const accessToken = await desktopSsoController.exchangeBrowserCookieAccessToken();
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
        await desktopSsoController.fetchBrowserUserInfo();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stepErrors.push(message);
        safeConsoleError("failed to fetch desktop sso browser userinfo", { url, error: message });
      }

      let accessToken = "";
      try {
        accessToken = await desktopSsoController.exchangeBrowserCookieAccessToken();
        if (!accessToken) {
          stepErrors.push(t("main.ssoCookieExchangeNoAccessToken"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stepErrors.push(message);
        safeConsoleError("failed to exchange desktop sso browser access token", { url, error: message });
      }

      finalizeDesktopSsoLoginAttempt(stepErrors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionCompleted) {
        failDesktopSsoStep(message);
      } else {
        failDesktopSsoFlow(message);
      }
      safeConsoleError("failed to complete desktop sso from webview navigation", {
        url,
        error: message
      });
    } finally {
      appState.desktopSsoWebviewCompletionInFlight = false;
    }
  }
  
  function clearDesktopPetIdleResetTimer() {
    return petRuntime.clearIdleResetTimer();
  }
  
  function clearDesktopPetActiveRuns() {
    return petRuntime.clearActiveRuns();
  }
  
  function setDesktopPetRendererWindowMode(mode: unknown) {
    return petRuntime.setWindowMode(mode);
  }
  
  function stopAgentPlatformPetStatusClient() {
    return petRuntime.stopStatusClient();
  }
  
  function scheduleAgentPlatformPetStatusRefresh(delayMs = 0, force = false) {
    if (!appState.desktopPetSettings) {
      return;
    }
    return petRuntime.scheduleStatusRefresh(delayMs, force);
  }
  
  function refreshDesktopPetState(patch: any = {}) {
    return petRuntime.refreshState(patch);
  }
  
  function moveDesktopPetWindowBy(delta: { x?: unknown; y?: unknown }) {
    return petRuntime.moveWindowBy(delta);
  }
  
  function beginDesktopPetWindowDrag(point: { x?: unknown; y?: unknown }) {
    return petRuntime.beginDrag(point);
  }
  
  function endDesktopPetWindowDrag() {
    return petRuntime.endDrag();
  }
  
  function hideDesktopPetWindow() {
    return petRuntime.hideWindow();
  }
  
  function setDesktopPetWindowMouseInteractive(interactive: boolean) {
    return petRuntime.setMouseInteractive(interactive);
  }
  
  async function showAssistantTargetWindow(source: string, targetPath = ASSISTANT_TARGET_PATH) {
    // Keep Windows tray activation responsive while service probes/startup finish.
    showMainWindow(targetPath);
    const failures = await servicesRuntime.runServiceMutation(() =>
      servicesRuntime.ensureAssistantTargetServicesRunning(source)
    );
    if (failures.length > 0) {
      showMainWindow("/control-center");
      return {
        ok: false,
        message: t("main.assistantServicesRecoveryFailed", { failures: failures.join(t("common.nameSeparator")) }),
        window: appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null
      };
    }
  
    return {
      ok: true,
      message: t("main.assistantOpened"),
      window: appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null
    };
  }
  
  async function openAssistantFromDesktopPet() {
    return petRuntime.openAssistant();
  }
  
  async function openDesktopPetTaskChat(input: { agentKey?: unknown; chatId?: unknown } = {}) {
    return petRuntime.openTaskChat(input);
  }
  
  function requestDesktopPetSignature(signatureId: string) {
    return petRuntime.requestSignature(signatureId);
  }
  
  function buildDesktopPetContextMenu() {
    return petRuntime.buildContextMenu();
  }
  
  function createDesktopPetWindow() {
    return petRuntime.createWindow();
  }
  
  function showDesktopPetWindow() {
    return petRuntime.showWindow();
  }

  function restoreDesktopPetWindowLayering() {
    return petRuntime.restoreWindowLayering();
  }
  
  function ingestDesktopPetAgentEvent(event: unknown, meta: { source?: string; transportMode?: string } = {}) {
    return petRuntime.ingestAgentEvent(event, meta);
  }
  
  function dismissDesktopPetPreview() {
    return petRuntime.dismissPreview();
  }
  
  function handleDesktopPetAssistantEvent(event: AssistantEvent) {
    return petRuntime.handleAssistantEvent(event);
  }
  
  async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
    return logsRuntime.openLogViewerWindow(request);
  }
  
  async function openAgentPlatformMonitorWindow(url: string) {
    return appShellRuntime.openAgentPlatformMonitorWindow(url);
  }

  async function openDesktopActionWorkbenchWindow() {
    return appShellRuntime.openDesktopActionWorkbenchWindow();
  }

  async function openAgentRealtimeInspectorWindow() {
    return appShellRuntime.openAgentRealtimeInspectorWindow();
  }

  function closeDesktopActionWorkbenchWindow() {
    return appShellRuntime.closeDesktopActionWorkbenchWindow();
  }

  function closeLogViewerWindow() {
    return logsRuntime.closeLogViewerWindow();
  }
  
  function getServiceWebviewPreloadPath() {
    return appShellRuntime.getServiceWebviewPreloadPath();
  }
  
  function getServiceWebviewPreloadUrl() {
    return appShellRuntime.getServiceWebviewPreloadUrl();
  }
  
  function minimizeLogViewerWindow() {
    return logsRuntime.minimizeLogViewerWindow();
  }
  
  function maximizeLogViewerWindow() {
    return logsRuntime.maximizeLogViewerWindow();
  }
  
  async function captureAssistantScreenshot(chatId: string | null | undefined) {
    return captureCopilotScreenshot({
      app,
      chatId,
      platform: mainProcessContext.platform,
      getMainWindow: () => appState.mainWindow,
      delay
    });
  }
  
  async function captureDesktopScreenshotForWebview(
    mode: EnterpriseChatScreenshotMode = "region"
  ) {
    return captureScreenshotForBridge({
      platform: mainProcessContext.platform,
      getMainWindow: () => appState.mainWindow,
      delay
    }, mode);
  }

  async function captureEnterpriseChatScreenshot(mode: EnterpriseChatScreenshotMode) {
    if (mode !== "window") {
      return captureDesktopScreenshotForWebview(mode);
    }
    const targetWindow = appState.mainWindow;
    if (
      !targetWindow ||
      targetWindow.isDestroyed() ||
      targetWindow.webContents.isDestroyed()
    ) {
      return captureDesktopScreenshotForWebview(mode);
    }

    let insertedCssKey = "";
    try {
      insertedCssKey = await targetWindow.webContents.insertCSS(
        ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS
      );
      return await captureDesktopScreenshotForWebview(mode);
    } finally {
      if (insertedCssKey && !targetWindow.webContents.isDestroyed()) {
        await targetWindow.webContents.removeInsertedCSS(insertedCssKey).catch(() => undefined);
      }
    }
  }
  
  function refreshPluginDesktopGlobalShortcuts() {
    return refreshPluginGlobalShortcuts({
      app,
      globalShortcut,
      platform: mainProcessContext.platform,
      invokePluginAction: (serviceId, actionId) => {
        void servicesRuntime.runServiceMutation(() => invokePluginDesktopAction({
          app,
          serviceId,
          actionId,
          getServiceState,
          handleServiceStart: servicesRuntime.handleServiceStart
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
  
  function registerFocusedWebviewDevToolsShortcut() {
    if (focusedWebviewDevToolsShortcutRegistered) {
      return;
    }
    const registered = globalShortcut.register(FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT, () => {
      openCurrentWebviewDevTools({
        focusedWebviewDevToolsTarget: Number.isSafeInteger(appState.focusedWebviewDevToolsTargetId) &&
          Number(appState.focusedWebviewDevToolsTargetId) > 0
          ? { webContentsId: Number(appState.focusedWebviewDevToolsTargetId) }
          : null,
        preferredWebviewDevToolsTarget: appState.copilotDevToolsTarget,
        currentPageSnapshot: appState.currentPageSnapshot,
        webContents,
      });
    });
    if (!registered) {
      console.warn(`failed to register focused webview DevTools shortcut: ${FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT}`);
      return;
    }
    focusedWebviewDevToolsShortcutRegistered = true;
  }
  
  async function collectWebviewLoadDiagnostics(
    contents: Electron.WebContents,
    validatedUrl: string
  ): Promise<Record<string, unknown>> {
    const sessionRef = contents.session;
    let resolvedProxy = "unknown";
    try {
      resolvedProxy = await sessionRef.resolveProxy(validatedUrl);
    } catch (error) {
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
  
  function reportRendererDiagnostic(source: string, details: Record<string, unknown>) {
    safeConsoleError("[renderer-diagnostic]", {
      source,
      ...details
    });
  }
  
  function createWindow() {
    return appShellRuntime.createWindow();
  }
  
  function configureAppMediaPermissions() {
    return appShellRuntime.configureAppMediaPermissions();
  }
  
  function showMainWindow(targetPath?: string) {
    return appShellRuntime.showMainWindow(targetPath);
  }
  
  function notifyServicesChanged() {
    notifyCoreServicesChanged();
    notifyDesktopDecorationsChanged();
  }

  function notifyCoreServicesChanged() {
    if (!isStartupPhaseAtLeast(appState.startupPhase, "shell-ready")) {
      console.info(`[main] skipped core service notification before shell-ready: ${appState.startupPhase}`);
      return;
    }
    void pluginBridgeRuntime.publishServiceStates();
    emitDesktopWsPush("service.changed", { changedAt: new Date().toISOString() });
    appState.assistantNavigationStatusClient?.scheduleRefresh(1000);
    const targetWindow = appState.mainWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("services.changed");
    }
  }

  function notifyDesktopDecorationsChanged() {
    if (appState.startupPhase !== "non-core-ready") {
      return;
    }
    if (app.isReady()) {
      refreshPluginDesktopGlobalShortcuts();
    }
    scheduleAgentPlatformPetStatusRefresh(1000);
  }

  function emitWebsChanged(
    details: Partial<Omit<WebsChangedEvent, "changedAt">> = {}
  ) {
    const payload: WebsChangedEvent = {
      changedAt: new Date().toISOString(),
      ...details
    };
    const targetWindow = appState.mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send("webs.changed", payload);
  }

  function startResourceDirectoryWatcher() {
    if (resourceDirectoryWatcher) {
      return;
    }
    resourceDirectoryWatcher = createResourceDirectoryWatcher({
      app,
      platform: mainProcessContext.platform,
      onWebsChanged: emitWebsChanged,
      onPetsChanged: () => {
        petRuntime.refreshState();
      },
      onPluginsChanged: () => {
        loadInstalledPlugins(app);
        notifyServicesChanged();
      },
      onError: (message, error) => safeConsoleError(message, error)
    });
    resourceDirectoryWatcher.start();
  }

  function stopResourceDirectoryWatcher() {
    resourceDirectoryWatcher?.stop();
    resourceDirectoryWatcher = null;
  }
  
  function emitKanbanChanged() {
    emitDesktopWsPush("snapshot.updated", { changedAt: new Date().toISOString() });
    const targetWindow = appState.mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send("kanban.changed");
  }
  
  function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
    const targetWindow = appState.mainWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
    }
    if (petRuntime.isVisible()) {
      refreshDesktopPetState();
    }
  }

  function emitAssistantNavigationPushEvent(event: AssistantNavigationPushEvent) {
    const targetWindow = appState.mainWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("assistant.navigationPushEvent", event);
    }
  }
  
  function navigateMainWindow(targetPath: string) {
    return appShellRuntime.navigateMainWindow(targetPath);
  }
  
  async function openAssistantWorker(request: AssistantWorkerOpenRequest) {
    const targetAgentKey = request.agentKey ?? request.workerKey ?? "";
    const openResult = await showAssistantTargetWindow(
      "assistant-worker",
      createAgentWebclientRoute({
        agentKey: targetAgentKey,
        chatId: request.chatId
      })
    );
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
  
  function createAppTray() {
    return appShellRuntime.createAppTray();
  }

  function runNonCoreStartupTask(label: string, task: () => void) {
    try {
      task();
    } catch (error) {
      safeConsoleError(`failed to start non-core runtime: ${label}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function startSsoCredentialDependentRuntimes() {
    if (
      !nonCoreDesktopRuntimeStarted ||
      ssoCredentialDependentRuntimesStarted ||
      !isDesktopSsoCredentialRuntimeReady()
    ) {
      return;
    }
    ssoCredentialDependentRuntimesStarted = true;
    runNonCoreStartupTask("enterprise chat", () => {
      void enterpriseChatRuntime.setEnabled(
        readEnterpriseImSettings(app, mainProcessContext.platform).enabled
      );
    });
    void startTunnelHubRuntimeIfEnabled().catch((error) => {
      safeConsoleError("failed to start Desktop Tunnel Hub", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  function applyDesktopSsoRestoreResult(result: DesktopSsoRestoreResult) {
    const previousRestoreState = desktopSsoRestoreState;
    desktopSsoRestoreState = result.state;
    if (result.state === "signed_out") {
      ssoCredentialDependentRuntimesStarted = false;
      return;
    }
    if (
      result.state !== "authenticated" ||
      previousRestoreState === "authenticated" ||
      !isDesktopSsoCredentialRuntimeReady()
    ) {
      return;
    }
    startSsoCredentialDependentRuntimes();
    appState.kanbanRuntime?.refreshDeviceInfo();
    void refreshMarketCatalog(app).catch((error) => {
      safeConsoleError("failed to refresh Market after desktop sso restore", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void enterpriseChatRuntime.refresh().catch((error) => {
      safeConsoleError("failed to refresh enterprise chat after desktop sso restore", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  function startNonCoreDesktopRuntime() {
    if (nonCoreDesktopRuntimeStarted) {
      return;
    }
    nonCoreDesktopRuntimeStarted = true;

    void refreshDesktopSsoIdentityToken().catch((error) => {
      safeConsoleError("failed to refresh desktop sso token during startup", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    const desktopSsoRefreshTimer = setInterval(() => {
      void refreshDesktopSsoIdentityToken().catch((error) => {
        safeConsoleError("failed to refresh desktop sso token before expiry", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 5 * 60_000);
    desktopSsoRefreshTimer.unref();
    app.once("before-quit", () => clearInterval(desktopSsoRefreshTimer));

    runNonCoreStartupTask("webapp install recovery", () => {
      recoverWebappInstallTransactions(app);
    });
    runNonCoreStartupTask("desktop pet", () => {
      if (isDesktopPetSupportedPlatform(mainProcessContext.platform) && appState.desktopPetSettings?.enabled === true) {
        showDesktopPetWindow();
      } else if (appState.desktopPetSettings) {
        refreshDesktopPetState();
      }
    });
    runNonCoreStartupTask("application menu", () => buildApplicationMenu());
    runNonCoreStartupTask("plugin desktop bridge", () => pluginBridgeRuntime.setDesktopReady());
    runNonCoreStartupTask("desktop ws server", () => {
      assistantBridgeRuntime.startDesktopWsServerIfEnabled(
        readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled
      );
    });
    startSsoCredentialDependentRuntimes();

    setStartupPhase("non-core-ready");
    notifyDesktopDecorationsChanged();
  }
  
  async function showFileDialog(options: any, ownerWindow = appState.mainWindow) {
    return appShellRuntime.showFileDialog(options, ownerWindow);
  }
  
  async function showSaveDialog(options: any, ownerWindow = appState.mainWindow) {
    return appShellRuntime.showSaveDialog(options, ownerWindow);
  }
  
  async function showMessageBox(options: any, ownerWindow = appState.mainWindow) {
    return appShellRuntime.showMessageBox(options, ownerWindow);
  }
  
  function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) {
    const targetWindow = appState.mainWindow;
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("assistant.attachmentProgress", progress);
    }
  }
  
  function buildApplicationMenu() {
    return appShellRuntime.buildApplicationMenu();
  }
  
  function showArchiveDialog(title: string, extensions?: string[]) {
    return appShellRuntime.showArchiveDialog(title, extensions);
  }
  
  async function handleAppReady() {
    setStartupPhase("platform-preflight");
    systemIdentityRuntime.ensureDockIdentity();
    registerDesktopPetAssetProtocol(app, protocol, net, mainProcessContext.platform);
    registerWebsiteFaviconProtocol(app, protocol, net, mainProcessContext.platform);
    registerDesktopSsoAvatarProtocol(
      app,
      protocol,
      net,
      session,
      mainProcessContext.platform,
    );
  
    setStartupPhase("runtime-env");
    const canContinueStartup = await startupEnvironmentRuntime.handleStartupEnvRootConflict();
    if (!canContinueStartup) {
      app.exit(0);
      return;
    }
  
    const startupRuntimeReady = await startupEnvironmentRuntime.prepareStartupRuntimeEnvironment();
    if (!startupRuntimeReady.ok) {
      startupEnvImportFailureMessage =
        startupRuntimeReady.message || startupEnvironmentRuntime.getDefaultEnvImportRequiredMessage();
      startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
    }
    setStartupPhase("runtime-env-ready");
  
    initializeUserDataRootsAndSettings();
    setStartupPhase("desktop-state-ready");
    const desktopSsoRestoreResult = await desktopSsoController.restoreDesktopSsoSession();
    applyDesktopSsoRestoreResult(desktopSsoRestoreResult);
    logsRuntime.installConsoleTee();
    pluginBridgeRuntime.configure();
    configurePluginResources({ callAgentPlatform });
    assistantBridgeRuntime.start();
    registerMainIpcHandlers({
      app,
      ipcMain,
      context: mainProcessContext,
      assistantBridgeRuntime,
      assistantRunWakeLock,
      logsRuntime,
      petRuntime,
      browserSurfaces: webSurfaceRuntime.browserSurfaceRegistry,
      isTrustedAgentWebclientSession: (sender) => sender.session === session.fromPartition(
        `persist:${STORAGE_NAMESPACE}-service-agent-webclient`,
      ),
      enterpriseChatRuntime,
      desktopSsoController,
      startupRestoreController,
      desktopAppInfo,
      oldRootDecisionRef,
      isFirstDesktopInstall,
      bundledEnvZipExistsAtStartup,
      runtimeRootExistedAtStartup,
      runtimeRootAtProcessStart,
      consumeFirstInstallBootstrapNavigation: () => firstInstallBootstrapNavigation.consume(),
      showFileDialog,
      showSaveDialog,
      showMessageBox,
      showArchiveDialog,
      openLogViewerWindow,
      closeLogViewerWindow,
      minimizeLogViewerWindow,
      maximizeLogViewerWindow,
      openAgentPlatformMonitorWindow,
      openAgentRealtimeInspectorWindow,
      openDesktopActionWorkbenchWindow,
      closeDesktopActionWorkbenchWindow,
      revealPathInFileManager,
      getServiceWebviewPreloadPath,
      getServiceWebviewPreloadUrl,
      runServiceMutation: servicesRuntime.runServiceMutation,
      handleServiceStart: servicesRuntime.handleServiceStart,
      refreshPluginDesktopGlobalShortcuts,
      notifyServicesChanged,
      onStartupPreparationSucceeded: () => {
        setStartupPhase("core-ready");
        startNonCoreDesktopRuntime();
      },
      onStartupPreparationBlocked: () => setStartupPhase("degraded"),
      refreshDesktopRuntimeConfigFromCanonicalFiles: settingsRuntime.refreshDesktopRuntimeConfigFromCanonicalFiles,
      buildApplicationMenu,
      refreshTrayContextMenu: () => appShellRuntime.refreshTrayContextMenu(),
      refreshMainWindowAppearance: () => appShellRuntime.refreshMainWindowAppearance(),
      setGlobalSearchOverlayVisible: (visible) => appShellRuntime.setGlobalSearchOverlayVisible(visible),
      setWebviewModalOverlayVisible: (sourceId, visible) =>
        appShellRuntime.setWebviewModalOverlayVisible(sourceId, visible),
      emitLocaleChanged: settingsRuntime.emitLocaleChanged,
      captureDesktopScreenshotForWebview,
      reportRendererDiagnostic,
      emitAssistantAttachmentProgress,
      captureAssistantScreenshot
    });
    configureAppMediaPermissions();
    registerFocusedWebviewDevToolsShortcut();
    createWindow();
    setStartupPhase("shell-ready");
    startResourceDirectoryWatcher();
  
    void startupPipeline.run();
  }
  
  function start() {
    registerDesktopOpenProtocolClient(app, mainProcessContext.platform, {
      isDefaultApp: Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp),
      execPath: process.execPath,
      appEntryPath: process.argv[1]
    });
    registerMainAppEvents({
      app,
      platform: mainProcessContext.platform,
      state: appState,
      gotSingleInstanceLock,
      installerShutdownArgs: INSTALLER_SHUTDOWN_ARGS,
      globalShortcut,
      focusedWebviewDevToolsShortcut: FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT,
      initialCommandLine: process.argv,
      onReady: handleAppReady,
      showMainWindow,
      beginAppQuitWithoutConfirmation,
      beginInstallerShutdown,
      isNativeDialogOpen: () => appShellRuntime.isNativeDialogOpen(),
      emitPluginBeforeQuit: () => pluginBridgeRuntime.emitBeforeQuit(),
      prepareQuitUi,
      beginRealtimeShutdown: () => realtimeBroker.beginShutdown(),
      runShutdownCleanup,
      writeInstallerShutdownAcks,
      releaseAssistantRunWakeLock: () => assistantRunWakeLock.release(),
      clearDesktopPetIdleResetTimer,
      stopAssistantBridgeRuntime: () => assistantBridgeRuntime.stop(),
      stopTunnelHubRuntime,
      stopAgentPlatformPetStatusClient,
      disposeRealtimeBroker: () => realtimeBroker.dispose(),
      unregisterPluginGlobalShortcuts: () => unregisterPluginGlobalShortcuts(globalShortcut),
      stopResourceDirectoryWatcher,
      stopPluginBridgeRuntime: () => pluginBridgeRuntime.stop(),
      stopEnterpriseChatRuntime: () => enterpriseChatRuntime.stop()
    });
  }
  
  function prepareQuitUi() {
    appShellRuntime.prepareQuitUi();
  }
  
  function beginAppQuitWithoutConfirmation() {
    appState.isHandlingQuit = true;
    prepareQuitUi();
    app.quit();
  }

  function beginInstallerShutdown(commandLine: string[]) {
    const request = parseInstallerShutdownRequest(
      commandLine,
      INSTALLER_SHUTDOWN_ARGS,
      STORAGE_NAMESPACE
    );
    appState.shutdownMode = "installer";
    if (request.ackPath) {
      if (appState.shutdownReport) {
        writeInstallerShutdownAck(request.ackPath, appState.shutdownReport);
      } else {
        appState.shutdownAckPaths.add(request.ackPath);
      }
    }
    beginAppQuitWithoutConfirmation();
  }

  function writeInstallerShutdownAck(
    ackPath: string,
    report: import("../../shared/shutdown").ShutdownReport
  ) {
    const status = report.ok ? "OK" : "FAILED";
    try {
      writeShutdownAck(ackPath, status, report);
    } catch (error) {
      console.error(`[main] failed to write shutdown acknowledgement ${ackPath}`, error);
    }
  }

  function writeInstallerShutdownAcks(report: import("../../shared/shutdown").ShutdownReport) {
    if (appState.shutdownAckPaths.size === 0) {
      return;
    }
    for (const ackPath of appState.shutdownAckPaths) {
      writeInstallerShutdownAck(ackPath, report);
    }
    appState.shutdownAckPaths.clear();
  }
  
  function requestAppQuit() {
    void appShellRuntime.confirmAndRequestAppQuit();
  }
  
  return { start };
}
