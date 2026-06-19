import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
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
import { issueAgentAccessToken } from "./agent-auth";
import { createAppPairingPayload } from "./app-pairing";
import {
  cancelDesktopSsoLogin,
  completeDesktopSsoCookieLogin,
  failDesktopSsoFlow,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoStatus,
  isDesktopSsoLoginCompletionUrl,
  logoutDesktopSso,
  startDesktopSsoLogin,
  startDesktopSsoSiteTokenBridge
} from "./oidc-sso";
import { loadBuiltinServices } from "./builtin-loader";
import {
  getServiceState,
  getResponsiveServiceState,
  listServices,
  runStartupPreparation,
  startService,
} from "./services/manager";
import {
  hideWindowsForShutdown,
  prepareQuitUi as prepareQuitUiFromCleanup
} from "./shutdown-cleanup";
import { webappRuntime } from "./webs/webapps/runtime";
import { installBundledWebappTemplates } from "./webs/webapps/template-installer";
import { loadInstalledPlugins } from "./plugin-loader";
import { configurePluginResources, retryPendingPluginResourceSync } from "./plugin-resources";
import {
  detectPortConflict,
  isPortConflictError,
  killProcessByPid,
  showPortConflictDialog
} from "./services/port-conflict";
import { resolveWebviewOpenDisposition, shouldDownloadUrlFromWebview } from "./webview-open-tab";
import { revealPathInFileManager } from "./reveal-path";
import { buildApplicationMenu as installApplicationMenu } from "./app-shell/app-menu";
import { createQuitConfirmationController } from "./app-shell/quit-confirmation";
import { AgentPlatformMonitorWindowController } from "./app-shell/agent-platform-monitor-window";
import { NativeDialogVisibilityController } from "./app-shell/native-dialogs";
import { AppTrayController } from "./app-shell/tray";
import { readDesktopProfileFromRoot } from "./desktop-profile-store";
import { getService } from "./services/service-registry";
import type {
  AssistantEvent,
  AssistantAttachmentTaskProgress,
  AssistantNavAgentItemsResult,
  AssistantWorkerOpenRequest,
  ServiceId,
  ServiceOpenLogViewerRequest,
} from "../shared/contracts";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_LABEL,
  isBuiltinBrowserSurfaceTarget,
  resolveBuiltinBrowserUrl
} from "../shared/browser-surfaces";
import {
  APP_ID,
  INSTALLER_SHUTDOWN_ARG,
  LEGACY_INSTALLER_SHUTDOWN_ARGS,
  PRODUCT_NAME
} from "../shared/generated/brand";
import { APP_ICON_ASSET_DIRECTORIES, APP_ICON_ASSET_FILENAMES } from "../shared/app-icon-assets";
import {
  desktopDataRootExists,
  ensureDataRoot,
  getDesktopConfigRoot,
  getDataRoot,
  getElectronUserDataRoot
} from "./user-paths";
import { createLogsRuntime } from "./logs/runtime";
import { applyDesktopInitBootstrap } from "./desktop-init-bootstrap";
import {
  bundledEnvZipExists,
  generateBackupDirName,
  importBundledEnvZipToRuntime,
  migrateOldRootToBackup,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  shouldRequireEnvZipImport,
  type EnvRootConflictDecision
} from "./env-bootstrap";
import { safeConsoleError } from "./safe-console";
import { callAgentPlatform } from "./desktop-action-bridge";
import { emitDesktopWsPush } from "./desktop-ws-server";
import {
  startTunnelHubRuntimeIfEnabled,
  stopTunnelHubRuntime
} from "./tunnel-hub-runtime";
import { AGENT_WEBCLIENT_TARGET_PATH } from "../shared/agent-webclient-routes";
import {
  registerDesktopPetAssetProtocol,
  registerDesktopPetAssetProtocolScheme
} from "./assistant/pet/pet-asset-protocol";
import {
  isDesktopPetSupportedPlatform,
  readDesktopPetStoredState
} from "./assistant/pet/desktop-pet";
import { createDesktopPetRuntime, type DesktopPetRuntime } from "./assistant/pet/runtime";
import { listWebEntries } from "./ipc/web-handlers";
import {
  isQuickAssistantMediaPermissionAllowed,
} from "./assistant/quick/quick-copilot";
import { QuickCopilotWindowController } from "./assistant/quick/window";
import { registerMainIpcHandlers } from "./ipc/register";
import {
  createAgentWebclientRoute,
  scheduleQuickAgentOpenRequest
} from "./assistant/quick/routing";
import {
  registerQuickCopilotShortcut,
  unregisterQuickCopilotShortcut
} from "./assistant/quick/shortcut";
import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge,
  type ScreenshotCaptureSource
} from "./assistant/copilot/screenshot";
import { getMainLocaleSettings, initializeMainI18n, setMainLocale, t } from "./i18n/main-i18n";
import { createStartupRestoreController, STARTUP_RESTORE_SERVICE_ORDER } from "./startup-restore";
import {
  applyPlatformAppInit,
  getFocusedWebviewDevToolsShortcut,
  getArchiveExtensions,
  isDevToolsShortcut
} from "./platform-adapter";
import {
  configureNativeAboutPanel,
  resolveDesktopAppInfo
} from "./app-metadata";
import { openFocusedWebviewDevTools } from "./focused-webview-devtools";
import { createDesktopSsoController } from "./sso-controller";
import { createBrowserSurfaceRegistry } from "./browser-surface-registry";
import { createCdpIntegration } from "./cdp-integration";
import { createMainAppState } from "./app-state";
import {
  createMainProcessContext,
  type MainProcessContext
} from "./main-process-context";
import {
  buildMainWindowOptions,
  configureMediaPermissions as configureWindowMediaPermissions,
  configureMainWindowLifecycleEvents,
  configureMainWindowWebContents,
  createMainWindowActivationController,
  createMainWindowLifecycleController,
  loadMainWindowRenderer
} from "./window-manager";
import {
  getRendererEntry,
  loadRendererRoute
} from "./renderer-route";
import { parseSafeLoopbackWebUrl } from "./loopback-url";
import {
  openPluginSettingsPage,
  readPluginSettingsSnapshot,
  writePluginSettingsValues
} from "./plugin-settings";
import {
  refreshPluginGlobalShortcuts,
  unregisterPluginGlobalShortcuts
} from "./plugin-global-shortcuts";
import { invokePluginDesktopAction } from "./plugin-actions";
import { cleanupRetiredPluginUserData } from "./retired-plugins";
import { createAssistantBridgeRuntime, type AssistantBridgeRuntime } from "./bridge/assistant-runtime";
import { createAssistantRunWakeLock } from "./bridge/assistant-wake-lock";
import { createPluginClipboardBridge } from "./bridge/plugin-clipboard";
import { createPluginBridgeRuntime, type PluginBridgeRuntime } from "./bridge/plugin-runtime";
import {
  createInstallerShutdownArgs,
  hasInstallerShutdownArg,
  requestMainSingleInstanceLock
} from "./lifecycle/single-instance";
import { createStartupPipeline } from "./lifecycle/startup";
import { createShutdownCleanupRunner } from "./lifecycle/shutdown";

const appState = createMainAppState();
const mainProcessContext = createMainProcessContext({
  state: appState,
  app,
  ipcMain,
  platform: process.platform,
  shell,
  session,
  nativeTheme
});
const ASSISTANT_TARGET_PATH = AGENT_WEBCLIENT_TARGET_PATH;
const LOG_VIEWER_ROUTE = "/log-viewer";
const FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT = getFocusedWebviewDevToolsShortcut(mainProcessContext.platform);
const SHUTDOWN_CLEANUP_DEADLINE_MS = 10_000;
const INSTALLER_SHUTDOWN_ARGS = createInstallerShutdownArgs(
  INSTALLER_SHUTDOWN_ARG,
  LEGACY_INSTALLER_SHUTDOWN_ARGS
);

const assistantRunWakeLock = createAssistantRunWakeLock(mainProcessContext.platform, {
  isEnabled: () => readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.preventSleepWhileRunning
});
const pluginClipboardBridge = createPluginClipboardBridge({
  platform: mainProcessContext.platform,
  clipboard,
  globalShortcut
});
let petRuntime: DesktopPetRuntime;
let assistantBridgeRuntime: AssistantBridgeRuntime;
let pluginBridgeRuntime: PluginBridgeRuntime;

const startupRestoreController = createStartupRestoreController({
  onChange: (state) => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed()) {
      return;
    }
    appState.mainWindow.webContents.send("services.startupRestoreState", state);
  }
});

registerDesktopPetAssetProtocolScheme(protocol);

function listBrowserRegistryWebItems() {
  const entries = listWebEntries(app).items;
  const items: Array<{ id: string; entryKey: string; label: string; url: string; agentKey?: string }> = [];
  for (const item of entries) {
    if (item.kind === "website") {
      items.push({ id: item.id, entryKey: item.entryKey, label: item.label, url: item.url, agentKey: item.agentKey });
      continue;
    }
    const state = webappRuntime.getStatus(app, item.id);
    if (state?.webUrl) {
      items.push({ id: item.id, entryKey: item.entryKey, label: item.label, url: state.webUrl, agentKey: item.agentKey });
    }
  }
  return {
    items
  };
}
const browserSurfaceRegistry = createBrowserSurfaceRegistry({
  webContents,
  listWebEntries: listBrowserRegistryWebItems,
  getCurrentPageSnapshot: () => appState.currentPageSnapshot
});
const cdpIntegration = createCdpIntegration({
  browserSurfaces: browserSurfaceRegistry,
  getCurrentPageSnapshot: () => appState.currentPageSnapshot,
  listServices: () => listServices(app),
  isLoopbackUrl: parseSafeLoopbackWebUrl,
  openBrowserUrl,
  activateBrowserSurface,
  showMainWindow,
  delay,
  assistantTargetPath: ASSISTANT_TARGET_PATH,
  version: `${PRODUCT_NAME}/${app.getVersion()} Electron/${process.versions.electron}`
});
const mainWindowLifecycle = createMainWindowLifecycleController({
  platform: mainProcessContext.platform,
  getWindow: () => appState.mainWindow,
  createWindow: () => createWindow(),
  clearWindow: (targetWindow) => {
    if (appState.mainWindow === targetWindow) {
      appState.mainWindow = null;
    }
  },
  isSidebarTranslucencyEnabled: () => appState.mainWindowSidebarTranslucencyEnabled,
  reportRendererDiagnostic
});
const mainWindowActivation = createMainWindowActivationController({
  lifecycle: mainWindowLifecycle,
  ensureDockIdentity: ensureDarwinDockIdentity
});

function getServiceWebviewPreloadPath() {
  return path.join(__dirname, "..", "preload", "service-webview.js");
}

function getServiceWebviewPreloadUrl() {
  return pathToFileURL(getServiceWebviewPreloadPath()).toString();
}

// Keep dev Electron runs on the same data root as packaged builds.
app.setName(PRODUCT_NAME);
applyPlatformAppInit(mainProcessContext.platform, app, APP_ID);
const desktopAppInfo = resolveDesktopAppInfo(app);
configureNativeAboutPanel(mainProcessContext.platform, app, desktopAppInfo);
const isFirstDesktopInstall = !desktopDataRootExists(app);
const runtimeRootAtProcessStart = resolveRuntimeRoot(app, mainProcessContext.platform);
const runtimeRootExistedAtStartup = runtimeRootExists(app, mainProcessContext.platform);
const runtimeEnvExistedAtStartup = runtimeEnvExists(app, mainProcessContext.platform);
const bundledEnvZipExistsAtStartup = bundledEnvZipExists(app, mainProcessContext.platform);
const requireEnvZipImportAtStartup = shouldRequireEnvZipImport({
  platform: mainProcessContext.platform,
  runtimeEnvExistedAtStartup
});
const envZipConflictNeedsDecision = shouldPromptEnvRootConflict({
  platform: mainProcessContext.platform,
  isFirstDesktopInstall,
  bundledEnvZipExists: bundledEnvZipExistsAtStartup,
  runtimeRootExistedAtStartup
});
const oldRootDecisionRef: { current: EnvRootConflictDecision | undefined } = { current: undefined };
let startupEnvImportFailureMessage: string | null = null;

function getDefaultEnvImportRequiredMessage() {
  return t("startup.envImport.requiredTitle");
}
function initializeUserDataRootsAndSettings() {
  ensureDataRoot(app);
  applyDesktopInitBootstrap(app, mainProcessContext.platform);
  const webappTemplateResult = installBundledWebappTemplates(app);
  if (!webappTemplateResult.ok) {
    console.warn(`[main] ${webappTemplateResult.message}`);
  }
  const initialLocaleSettings = initializeMainI18n(app, { isFirstInstall: isFirstDesktopInstall });
  if (isFirstDesktopInstall) {
    setMainLocale(app, initialLocaleSettings.locale);
  }

  const electronUserDataRoot = getElectronUserDataRoot(app);
  fs.mkdirSync(electronUserDataRoot, { recursive: true });
  app.setPath("userData", electronUserDataRoot);
  cleanupRetiredPluginUserData(app);

  petRuntime.initializeState(isFirstDesktopInstall);
}

const gotSingleInstanceLock = requestMainSingleInstanceLock(app);

if (hasInstallerShutdownArg(process.argv, INSTALLER_SHUTDOWN_ARGS)) {
  app.exit(0);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const quickCopilotWindowController = new QuickCopilotWindowController({
  app,
  platform: () => mainProcessContext.platform,
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  loadRendererRoute,
  prepareServices: () => runServiceMutation(() => ensureAssistantTargetServicesRunning("quick-assistant")),
  showControlCenter: () => showMainWindow("/control-center"),
  openAgent: scheduleQuickAgentOpenRequest
});

const logsRuntime = createLogsRuntime({
  app,
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  routePath: LOG_VIEWER_ROUTE,
  platform: mainProcessContext.platform,
  getOwnerWindow: () => appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null,
  loadRendererRoute,
  onRendererError: safeConsoleError
});

const agentPlatformMonitorWindowController = new AgentPlatformMonitorWindowController({
  platform: mainProcessContext.platform,
  onRendererError: safeConsoleError
});

const nativeDialogController = new NativeDialogVisibilityController({
  platform: mainProcessContext.platform,
  getTargetWindows: () => [appState.mainWindow, quickCopilotWindowController.getWindow()],
  hideQuickCopilot: hideQuickAssistantForNativeDialog,
  restoreQuickCopilot: restoreQuickAssistantAfterNativeDialog
});
const quitConfirmationController = createQuitConfirmationController({
  platform: mainProcessContext.platform,
  appName: PRODUCT_NAME,
  t,
  getOwnerWindow: () => appState.mainWindow,
  showMessageBox: (options, ownerWindow) => nativeDialogController.showMessageBox(options, ownerWindow),
  requestQuitWithoutConfirmation: () => beginAppQuitWithoutConfirmation()
});

const appTrayController = new AppTrayController({
  platform: mainProcessContext.platform,
  isPackaged: app.isPackaged,
  appName: PRODUCT_NAME,
  t,
  mainDir: __dirname,
  resourcesPath: process.resourcesPath,
  getDesktopPetEnabled: () => appState.desktopPetSettings.enabled,
  isDesktopPetSupported: () => isDesktopPetSupportedPlatform(mainProcessContext.platform),
  openAssistantChat: () => {
    void openAssistantWorker({
      displayName: PRODUCT_NAME,
      role: t("main.confirmationExampleRole"),
      focusComposerOnComplete: true
    });
  },
  openAssistantTarget: (source) => {
    void showAssistantTargetWindow(source);
  },
  openSettings: () => showMainWindow("/settings"),
  showDesktopPet: () => showDesktopPetWindow(),
  hideDesktopPet: () => hideDesktopPetWindow(true),
  quit: () => requestAppQuit()
});
petRuntime = createDesktopPetRuntime({
  app,
  platform: mainProcessContext.platform,
  state: appState,
  screen,
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  loadRendererRoute,
  showMainWindow,
  openAssistantWorker,
  publishPluginAssistantActiveTasks: (tasks, runningTaskCount) =>
    pluginBridgeRuntime.publishAssistantActiveTasks(tasks, runningTaskCount),
  refreshTrayContextMenu: () => appTrayController.refreshContextMenu(),
  getResponsiveServiceState,
  issueAgentAccessToken
});
pluginBridgeRuntime = createPluginBridgeRuntime({
  app,
  clipboardBridge: pluginClipboardBridge,
  getServiceState: (serviceId) => getServiceState(app, serviceId),
  listServices: (targetApp) => listServices(targetApp),
  retryPendingPluginResourceSync,
  notifyAgentPlatformConfigChanged: () => notifyServicesChanged(),
  getAssistantActiveTasks: () => petRuntime.getAssistantActiveTasksSnapshotForPlugins(),
  onError: safeConsoleError
});
const desktopSsoController = createDesktopSsoController({
  app,
  platform: mainProcessContext.platform,
  session,
  getMainWindow: () => appState.mainWindow,
  openBrowserUrl,
  openExternal: shell.openExternal
});
assistantBridgeRuntime = createAssistantBridgeRuntime({
  app,
  context: mainProcessContext,
  assistantRunWakeLock,
  cdpIntegration,
  getResponsiveServiceState,
  issueAgentAccessToken,
  callAgentPlatform,
  showMainWindow,
  openLogViewerWindow,
  getQuickAssistantWindow: () => quickCopilotWindowController.getWindow(),
  listTaskBoardLocalAgents: () => petRuntime.listTaskBoardLocalAgents(),
  emitTaskBoardChanged,
  emitAssistantNavigationAgentsChanged,
  handleDesktopPetAssistantEvent: (event) => petRuntime.handleAssistantEvent(event),
  safeConsoleError,
  logger: console
});
const startupPipeline = createStartupPipeline({
  app,
  getEnvImportFailureMessage: () => startupEnvImportFailureMessage,
  startupRestoreController,
  loadBuiltinServices,
  loadInstalledPlugins,
  notifyServicesChanged,
  startTunnelHubRuntimeIfEnabled,
  runServiceMutation,
  runStartupPreparation,
  t,
  onError: safeConsoleError
});
const runShutdownCleanup = createShutdownCleanupRunner({
  app,
  timeoutMs: SHUTDOWN_CLEANUP_DEADLINE_MS,
  getExistingPromise: () => appState.shutdownCleanupPromise,
  setPromise: (promise) => {
    appState.shutdownCleanupPromise = promise;
  },
  markComplete: () => {
    appState.shutdownCleanupComplete = true;
  }
});

async function handleDesktopSsoWebviewNavigation(url: string) {
  try {
    const status = getDesktopSsoStatus(app);
    if (appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
      return;
    }
    appState.desktopSsoWebviewCompletionInFlight = true;
    const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(app);
    if (!exchangeUrl) {
      failDesktopSsoFlow(t("main.ssoCookieExchangeMissing"));
      return;
    }
    await desktopSsoController.syncBrowserCookies();
    const accessToken = await desktopSsoController.exchangeBrowserCookieAccessToken();
    if (!accessToken) {
      failDesktopSsoFlow(t("main.ssoCookieExchangeNoAccessToken"));
      return;
    }
    completeDesktopSsoCookieLogin(app, accessToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failDesktopSsoFlow(message);
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

function hideDesktopPetWindow(disable = false) {
  return petRuntime.hideWindow(disable);
}

function setDesktopPetWindowMouseInteractive(interactive: boolean) {
  return petRuntime.setMouseInteractive(interactive);
}

async function ensureAssistantTargetServicesRunning(source: string) {
  const failures: string[] = [];

  for (const serviceId of STARTUP_RESTORE_SERVICE_ORDER) {
    try {
      const current = await getServiceState(app, serviceId);
      if (current.status === "running") {
        continue;
      }

      const result = await startService(app, serviceId);
      if (!result.ok || result.service.status !== "running") {
        failures.push(`${result.service.name}: ${result.message}`);
      }
    } catch (error) {
      failures.push(`${serviceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.warn(`[assistant-entry] failed to prepare assistant services from ${source}`, failures);
  }

  return failures;
}

async function showAssistantTargetWindow(source: string, targetPath = ASSISTANT_TARGET_PATH) {
  // Keep Windows tray activation responsive while service probes/startup finish.
  showMainWindow(targetPath);
  const failures = await runServiceMutation(() => ensureAssistantTargetServicesRunning(source));
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

function ingestDesktopPetAgentEvent(event: unknown, meta: { source?: string; transportMode?: string } = {}) {
  return petRuntime.ingestAgentEvent(event, meta);
}

function dismissDesktopPetPreview() {
  return petRuntime.dismissPreview();
}

function handleDesktopPetAssistantEvent(event: AssistantEvent) {
  return petRuntime.handleAssistantEvent(event);
}

function showQuickAssistantDismissWindow() {
  quickCopilotWindowController.showDismissWindow();
}

function hideQuickAssistantDismissWindow() {
  quickCopilotWindowController.hideDismissWindow();
}

async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
  return logsRuntime.openLogViewerWindow(request);
}

async function openAgentPlatformMonitorWindow(url: string) {
  return agentPlatformMonitorWindowController.open(url);
}

function closeLogViewerWindow() {
  return logsRuntime.closeLogViewerWindow();
}

function minimizeLogViewerWindow() {
  return logsRuntime.minimizeLogViewerWindow();
}

function maximizeLogViewerWindow() {
  return logsRuntime.maximizeLogViewerWindow();
}

function hideQuickAssistantForNativeDialog() {
  quickCopilotWindowController.hideForNativeDialog();
}

function restoreQuickAssistantAfterNativeDialog() {
  quickCopilotWindowController.restoreAfterNativeDialog();
}

function showQuickAssistantWindow() {
  quickCopilotWindowController.showWindow();
}

function toggleQuickAssistantWindow() {
  quickCopilotWindowController.toggleWindow();
}

async function captureAssistantScreenshot(
  chatId: string | null | undefined,
  source: ScreenshotCaptureSource
) {
  return captureCopilotScreenshot({
    app,
    chatId,
    source,
    platform: mainProcessContext.platform,
    getMainWindow: () => appState.mainWindow,
    getQuickCopilotWindow: () => quickCopilotWindowController.getWindow(),
    hideQuickCopilotDismissWindow: hideQuickAssistantDismissWindow,
    showQuickCopilotDismissWindow: showQuickAssistantDismissWindow,
    delay
  });
}

async function captureDesktopScreenshotForWebview() {
  return captureScreenshotForBridge({
    source: "sidebar",
    platform: mainProcessContext.platform,
    getMainWindow: () => appState.mainWindow,
    getQuickCopilotWindow: () => quickCopilotWindowController.getWindow(),
    hideQuickCopilotDismissWindow: hideQuickAssistantDismissWindow,
    showQuickCopilotDismissWindow: showQuickAssistantDismissWindow,
    delay
  });
}

function registerQuickAssistantShortcut() {
  registerQuickCopilotShortcut({
    platform: mainProcessContext.platform,
    globalShortcut,
    controller: quickCopilotWindowController
  });
}

function refreshPluginDesktopGlobalShortcuts() {
  return refreshPluginGlobalShortcuts({
    app,
    globalShortcut,
    platform: mainProcessContext.platform,
    invokePluginAction: (serviceId, actionId) => {
      void runServiceMutation(() => invokePluginDesktopAction({
        app,
        serviceId,
        actionId,
        getServiceState,
        handleServiceStart
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
  const registered = globalShortcut.register(FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT, () => {
    openFocusedWebviewDevTools(webContents.getFocusedWebContents());
  });
  if (!registered) {
    console.warn(`failed to register focused webview DevTools shortcut: ${FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT}`);
  }
}

async function collectWebviewLoadDiagnostics(contents: Electron.WebContents, validatedUrl: string) {
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
  appState.mainWindow = new BrowserWindow(buildMainWindowOptions({
    platform: mainProcessContext.platform,
    preloadPath: path.join(__dirname, "..", "preload", "index.js"),
    initialLocaleSettings: getMainLocaleSettings()
  }));
  const targetWindow = appState.mainWindow;

  mainWindowLifecycle.applyAppearance(targetWindow);
  mainWindowLifecycle.attachRendererDiagnostics(targetWindow);

  configureMainWindowWebContents(targetWindow, {
    platform: mainProcessContext.platform,
    getMainWindow: () => appState.mainWindow,
    servicePreloadPath: getServiceWebviewPreloadPath(),
    servicePreloadUrl: getServiceWebviewPreloadUrl(),
    isSafeServiceUrl: parseSafeLoopbackWebUrl,
    isDevToolsShortcut,
    shouldDownloadUrl: shouldDownloadUrlFromWebview,
    resolveOpenDisposition: resolveWebviewOpenDisposition,
    collectLoadDiagnostics: collectWebviewLoadDiagnostics,
    report: safeConsoleError,
    onWebviewNavigation: handleDesktopSsoWebviewNavigation,
    openExternal: shell.openExternal,
    schedule: setImmediate
  });
  void loadMainWindowRenderer(targetWindow, {
    mode: process.env.VITE_DEV_SERVER_URL ? "dev" : "file",
    rendererEntry: getRendererEntry(),
    quit: () => beginAppQuitWithoutConfirmation(),
    report: (message, error) => console.error(message, error)
  });

  configureMainWindowLifecycleEvents<BrowserWindow>(targetWindow, {
    platform: mainProcessContext.platform,
    lifecycle: mainWindowLifecycle,
    isDevToolsShortcut,
    isHandlingQuit: () => appState.isHandlingQuit,
    clearWindow: (targetWindow) => {
      if (appState.mainWindow === targetWindow) {
        appState.mainWindow = null;
      }
    },
    isNativeDialogOpen: () => nativeDialogController.isOpen(),
    hideQuickAssistantAfterOutsideFocus: () => quickCopilotWindowController.hideAfterOutsideFocus()
  });

  return targetWindow;
}

function configureAppMediaPermissions() {
  configureWindowMediaPermissions({
    platform: mainProcessContext.platform,
    permissionSession: session.defaultSession,
    getMainWindow: () => appState.mainWindow,
    getQuickAssistantWindow: () => quickCopilotWindowController.getWindow(),
    isMediaPermissionAllowed: isQuickAssistantMediaPermissionAllowed,
    askForMicrophoneAccess: () => systemPreferences.askForMediaAccess("microphone")
  });
}

function showMainWindow(targetPath?: string) {
  mainWindowActivation.showMainWindow(targetPath);
}

function projectRootFromMainDir(mainDir: string) {
  return path.join(mainDir, "..", "..");
}

function getDarwinDockIconCandidatePaths() {
  const projectRoot = projectRootFromMainDir(__dirname);
  const bundledMacDockIconPath = path.join(
    process.resourcesPath,
    APP_ICON_ASSET_FILENAMES.macDockIcon
  );
  const packagedBrandIconPath = path.join(process.resourcesPath, APP_ICON_ASSET_FILENAMES.brandIcon);
  const buildAppIconPath = path.join(
    projectRoot,
    APP_ICON_ASSET_DIRECTORIES.buildIcons,
    APP_ICON_ASSET_FILENAMES.macDockIcon
  );
  const generatedBrandIconPath = path.join(
    projectRoot,
    APP_ICON_ASSET_DIRECTORIES.brandAssets,
    APP_ICON_ASSET_FILENAMES.brandIcon
  );
  const rendererBrandIconPath = path.join(
    projectRoot,
    APP_ICON_ASSET_DIRECTORIES.distRenderer,
    APP_ICON_ASSET_FILENAMES.brandIcon
  );

  if (app.isPackaged) {
    return [
      packagedBrandIconPath,
      bundledMacDockIconPath,
      rendererBrandIconPath,
      buildAppIconPath,
      generatedBrandIconPath
    ];
  }

  return [
    bundledMacDockIconPath,
    buildAppIconPath,
    generatedBrandIconPath,
    rendererBrandIconPath
  ];
}

function applyDarwinDockIcon(dock: NonNullable<typeof app.dock>) {
  for (const iconPath of getDarwinDockIconCandidatePaths()) {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      continue;
    }
    dock.setIcon(icon);
    return;
  }

  safeConsoleError("failed to load macOS dock icon", {
    candidates: getDarwinDockIconCandidatePaths()
  });
}

function ensureDarwinDockIdentity() {
  if (mainProcessContext.platform !== "darwin") {
    return;
  }

  app.setActivationPolicy("regular");
  const dock = app.dock;
  if (!dock) {
    return;
  }

  applyDarwinDockIcon(dock);
  void dock.show()
    .then(() => {
      applyDarwinDockIcon(dock);
    })
    .catch((error) => {
      safeConsoleError("failed to show macOS dock icon", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

function notifyServicesChanged() {
  if (app.isReady()) {
    refreshPluginDesktopGlobalShortcuts();
  }
  void pluginBridgeRuntime.publishServiceStates();
  emitDesktopWsPush("service.changed", { changedAt: new Date().toISOString() });
  scheduleAgentPlatformPetStatusRefresh(1000);
  appState.assistantNavigationStatusClient?.scheduleRefresh(1000);
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("services.changed");
  }
}

function emitTaskBoardChanged() {
  emitDesktopWsPush("snapshot.updated", { changedAt: new Date().toISOString() });
  const targetWindow = appState.mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send("taskBoard.changed");
}

function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
  }
  if (petRuntime.isVisible()) {
    refreshDesktopPetState();
  }
}

async function runServiceMutation<T>(task: () => Promise<T>) {
  const previousTask = appState.serviceMutationQueue;
  let releaseQueue = () => {};
  appState.serviceMutationQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previousTask;
  try {
    return await task();
  } finally {
    releaseQueue();
    notifyServicesChanged();
  }
}

function navigateMainWindow(targetPath: string) {
  mainWindowActivation.navigateMainWindow(targetPath);
}

async function openBrowserUrl(input: {
  url: string;
  label?: string;
  requireOperableTarget?: boolean;
  partition?: string;
  userAgent?: string;
}) {
  const targetUrl = input.url || BUILTIN_BROWSER_DEFAULT_URL;
  navigateMainWindow(BUILTIN_BROWSER_ROUTE);
  await delay(450);
  appState.mainWindow?.webContents.send("webview.openTab", {
    sourceGuestId: -1,
    url: targetUrl,
    partition: input.partition,
    userAgent: input.userAgent
  });
  if (input.requireOperableTarget === false) {
    return {
      ok: true,
      action: "open_url",
      target: targetUrl,
      url: targetUrl,
      message: t("main.sentToBuiltinBrowser", { label: input.label || targetUrl })
    };
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await delay(250);
    const contents = browserSurfaceRegistry.findWebContentsForSurfaceUrl(targetUrl);
    if (contents) {
      const surface = browserSurfaceRegistry.builtinBrowserSurface(contents, targetUrl);
      return {
        ok: true,
        action: "open_url",
        target: targetUrl,
        url: contents.getURL(),
        title: contents.getTitle(),
        message: t("main.builtinBrowserOpened", { label: input.label || BUILTIN_BROWSER_SURFACE_LABEL }),
        data: {
          surface
        }
      };
    }
  }
  return {
    ok: false,
    action: "open_url",
    target: targetUrl,
    url: targetUrl,
    error: "browser_webview_not_ready",
    message: t("main.builtinBrowserNotReady", { label: input.label || targetUrl })
  };
}

async function activateBrowserSurface(target: string) {
  if (isBuiltinBrowserSurfaceTarget(target)) {
    return openBrowserUrl(resolveBuiltinBrowserUrl(target));
  }
  const surfaces = browserSurfaceRegistry.listBrowserSurfaces();
  const surface = surfaces.find((candidate) => browserSurfaceRegistry.webEntryMatchesSurfaceTarget(candidate, target));
  if (!surface) {
    return {
      ok: false,
      action: "activate_surface",
      target,
      error: "surface_not_found",
      message: t("main.embeddedSurfaceNotFound", { target }),
      data: {
        surfaces
      }
    };
  }

  navigateMainWindow(`/webs/${surface.id}`);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(250);
    const contents = browserSurfaceRegistry.findWebContentsForSurfaceUrl(surface.url);
    if (contents) {
      const activatedSurface = {
        ...surface,
        active: true,
        currentUrl: contents.getURL(),
        title: contents.getTitle(),
        webContentsId: contents.id
      };
      return {
        ok: true,
        action: "activate_surface",
        target,
        url: activatedSurface.currentUrl,
        title: activatedSurface.title,
        message: t("main.embeddedSurfaceOpened", { label: activatedSurface.label }),
        data: {
          surface: activatedSurface
        }
      };
    }
  }

  return {
    ok: false,
    action: "activate_surface",
    target,
    url: surface.url,
    error: "surface_load_timeout",
    message: t("main.embeddedSurfaceNotReady", { label: surface.label }),
    data: {
      surface
    }
  };
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
  return appTrayController.create();
}

async function showFileDialog(
  options: Parameters<NativeDialogVisibilityController["showFileDialog"]>[0],
  ownerWindow: BrowserWindow | null = appState.mainWindow
) {
  return nativeDialogController.showFileDialog(options, ownerWindow);
}

async function showSaveDialog(
  options: Parameters<NativeDialogVisibilityController["showSaveDialog"]>[0],
  ownerWindow: BrowserWindow | null = appState.mainWindow
) {
  return nativeDialogController.showSaveDialog(options, ownerWindow);
}

async function showMessageBox(
  options: Parameters<NativeDialogVisibilityController["showMessageBox"]>[0],
  ownerWindow: BrowserWindow | null = appState.mainWindow
) {
  return nativeDialogController.showMessageBox(options, ownerWindow);
}

function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) {
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.attachmentProgress", progress);
  }
}

function buildApplicationMenu() {
  installApplicationMenu({
    appName: app.name,
    platform: mainProcessContext.platform,
    t,
    openSettings: () => navigateMainWindow("/settings"),
    requestQuit: () => requestAppQuit()
  });
}

function emitLocaleChanged(settings: ReturnType<typeof setMainLocale>) {
  for (const targetWindow of [
    appState.mainWindow,
    appState.desktopPetWindow,
    quickCopilotWindowController.getWindow(),
    logsRuntime.getLogViewerWindow()
  ]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("settings.localeChanged", settings);
  }
}

function emitDesktopConfigChanged(reason: string) {
  const event = {
    reason,
    changedAt: new Date().toISOString()
  };
  for (const targetWindow of [
    appState.mainWindow,
    appState.desktopPetWindow,
    quickCopilotWindowController.getWindow(),
    logsRuntime.getLogViewerWindow()
  ]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("settings.desktopConfigChanged", event);
  }
}

function refreshDesktopRuntimeConfigFromCanonicalFiles(reason: string) {
  const settings = initializeMainI18n(app);
  buildApplicationMenu();
  appTrayController.refreshContextMenu();
  emitLocaleChanged(settings);

  appState.desktopPetSettings = readDesktopPetStoredState(app, mainProcessContext.platform);
  refreshDesktopPetState();
  if (isDesktopPetSupportedPlatform(mainProcessContext.platform) && appState.desktopPetSettings.enabled) {
    void showDesktopPetWindow();
  } else {
    hideDesktopPetWindow(false);
  }

  desktopSsoController.broadcastStatus(getDesktopSsoStatus(app));
  notifyServicesChanged();
  emitTaskBoardChanged();
  emitDesktopConfigChanged(reason);
}

async function handleStartupEnvRootConflict() {
  if (!envZipConflictNeedsDecision) {
    return true;
  }

  const backupPath = generateBackupDirName(runtimeRootAtProcessStart, mainProcessContext.platform);
  const choice = await nativeDialogController.showMessageBox({
    type: "warning",
    title: t("startup.envConflict.title"),
    message: t("startup.envConflict.message", { path: runtimeRootAtProcessStart }),
    detail: t("startup.envConflict.detail", { backupPath }),
    buttons: [t("startup.envConflict.migrate"), t("startup.envConflict.keep"), t("menu.quit", { appName: PRODUCT_NAME })],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });

  if (choice.response === 1) {
    oldRootDecisionRef.current = "keep";
    return true;
  }
  if (choice.response !== 0) {
    oldRootDecisionRef.current = "cancel";
    return false;
  }

  try {
    migrateOldRootToBackup(mainProcessContext.platform, runtimeRootAtProcessStart, backupPath);
    oldRootDecisionRef.current = "migrate";
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryChoice = await nativeDialogController.showMessageBox({
      type: "error",
      title: t("startup.envConflict.migrationFailedTitle"),
      message,
      detail: t("startup.envConflict.migrationFailedDetail", { path: runtimeRootAtProcessStart, backupPath }),
      buttons: [t("menu.quit", { appName: PRODUCT_NAME }), t("startup.envConflict.keep")],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (retryChoice.response === 1) {
      oldRootDecisionRef.current = "keep";
      return true;
    }
    oldRootDecisionRef.current = "cancel";
    return false;
  }
}

function showArchiveDialog(title: string, extensions = getArchiveExtensions(mainProcessContext.platform)) {
  return showFileDialog({
    title,
    properties: ["openFile"],
    filters: [{ name: "Archive", extensions }]
  });
}

async function handleServiceStart(serviceId: ServiceId) {
  try {
    return await startService(app, serviceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isPortConflictError(message)) {
      throw error;
    }

    const service = getService(serviceId);
    const currentState = await getServiceState(app, serviceId).catch(() => null);
    const conflict = await detectPortConflict(message, service, {
      fallbackPort: currentState?.healthMeta.port ?? null
    });
    if (!conflict?.processInfo) {
      throw error;
    }

    const confirmed = await showPortConflictDialog(appState.mainWindow, conflict.port, conflict.processInfo);
    if (!confirmed) {
      throw error;
    }

    const killed = await killProcessByPid(conflict.processInfo.pid);
    if (!killed) {
      throw new Error(
        `Unable to stop process ${conflict.processInfo.name} (PID ${conflict.processInfo.pid}) using port ${conflict.port}.`
      );
    }

    await delay(500);
    return startService(app, serviceId);
  }
}

if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, commandLine) => {
    if (hasInstallerShutdownArg(commandLine, INSTALLER_SHUTDOWN_ARGS)) {
      beginAppQuitWithoutConfirmation();
      return;
    }
    showMainWindow();
  });

  app.whenReady().then(async () => {
    ensureDarwinDockIdentity();
    registerDesktopPetAssetProtocol(app, protocol, net, mainProcessContext.platform);

    const canContinueStartup = await handleStartupEnvRootConflict();
    if (!canContinueStartup) {
      app.exit(0);
      return;
    }

    const startupRuntimeReady = await prepareStartupRuntimeEnvironment();
    if (!startupRuntimeReady.ok) {
      startupEnvImportFailureMessage = startupRuntimeReady.message || getDefaultEnvImportRequiredMessage();
      startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
    }

    initializeUserDataRootsAndSettings();
    ensureDataRoot(app);
    logsRuntime.installConsoleTee();
    pluginBridgeRuntime.configure();
    configurePluginResources({ callAgentPlatform });
    assistantBridgeRuntime.start();
    assistantBridgeRuntime.startDesktopWsServerIfEnabled(
      readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled
    );
    registerMainIpcHandlers({
      app,
      ipcMain,
      context: mainProcessContext,
      assistantBridgeRuntime,
      assistantRunWakeLock,
      logsRuntime,
      petRuntime,
      quickCopilotWindowController,
      desktopSsoController,
      startupRestoreController,
      desktopAppInfo,
      oldRootDecisionRef,
      isFirstDesktopInstall,
      bundledEnvZipExistsAtStartup,
      runtimeRootExistedAtStartup,
      runtimeRootAtProcessStart,
      showFileDialog,
      showSaveDialog,
      showMessageBox,
      showArchiveDialog,
      openLogViewerWindow,
      closeLogViewerWindow,
      minimizeLogViewerWindow,
      maximizeLogViewerWindow,
      openAgentPlatformMonitorWindow,
      revealPathInFileManager,
      getServiceWebviewPreloadPath,
      getServiceWebviewPreloadUrl,
      runServiceMutation,
      handleServiceStart,
      refreshPluginDesktopGlobalShortcuts,
      notifyServicesChanged,
      refreshDesktopRuntimeConfigFromCanonicalFiles,
      buildApplicationMenu,
      refreshTrayContextMenu: () => appTrayController.refreshContextMenu(),
      emitLocaleChanged,
      captureDesktopScreenshotForWebview,
      reportRendererDiagnostic,
      emitAssistantAttachmentProgress,
      captureAssistantScreenshot
    });
    configureAppMediaPermissions();
    createWindow();
    if (isDesktopPetSupportedPlatform(mainProcessContext.platform) && appState.desktopPetSettings.enabled) {
      showDesktopPetWindow();
    } else {
      refreshDesktopPetState();
    }
    createAppTray();
    buildApplicationMenu();
    registerQuickAssistantShortcut();
    registerFocusedWebviewDevToolsShortcut();
    pluginBridgeRuntime.setDesktopReady();

    void startupPipeline.run();

    app.on("activate", () => {
      if (nativeDialogController.isOpen()) {
        return;
      }
      showMainWindow();
    });
  });
}

async function prepareStartupRuntimeEnvironment(): Promise<{ ok: true } | { ok: false; message: string }> {
  const shouldImportBundledEnvZip =
    oldRootDecisionRef.current === "migrate" ||
    (requireEnvZipImportAtStartup && oldRootDecisionRef.current !== "keep");
  if (!shouldImportBundledEnvZip) {
    return { ok: true };
  }
  return tryImportBundledEnvZipAtStartup();
}

async function tryImportBundledEnvZipAtStartup(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const importResult = await importBundledEnvZipToRuntime(app, mainProcessContext.platform);
    if (!importResult) {
      return {
        ok: false,
        message: getDefaultEnvImportRequiredMessage()
      };
    }

    startupRestoreController.beginSession("bootstrap");
    startupRestoreController.updateService(
      "identity-center",
      "installing",
      t("startup.envImport.importingBundled")
    );
    notifyServicesChanged();
    console.info(
      `[main] imported bundled env.zip from ${importResult.sourceZipPath} into ${importResult.targetRoot}: copied=${importResult.copiedFiles}, skipped=${importResult.skippedFiles}`
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("failed to import bundled env.zip", error);
    return {
      ok: false,
      message: t("startup.envImport.bundledFailed", { message })
    };
  }
}

function prepareQuitUi() {
  prepareQuitUiFromCleanup({
    getAllWindows: () => BrowserWindow.getAllWindows(),
    destroyTray: () => appTrayController.destroy()
  });
}

function beginAppQuitWithoutConfirmation() {
  appState.isHandlingQuit = true;
  prepareQuitUi();
  app.quit();
}

function requestAppQuit() {
  void quitConfirmationController.confirmAndRequestAppQuit();
}

app.on("before-quit", (event) => {
  if (appState.shutdownCleanupComplete) {
    return;
  }
  if (mainProcessContext.platform === "darwin" && !appState.isHandlingQuit) {
    event.preventDefault();
    requestAppQuit();
    return;
  }
  event.preventDefault();
  appState.isHandlingQuit = true;
  pluginBridgeRuntime.emitBeforeQuit();
  prepareQuitUi();
  hideWindowsForShutdown(appState);
  void runShutdownCleanup().finally(() => {
    beginAppQuitWithoutConfirmation();
  });
});

app.on("will-quit", () => {
  assistantRunWakeLock.release();
  clearDesktopPetIdleResetTimer();
  assistantBridgeRuntime.stop();
  void stopTunnelHubRuntime();
  stopAgentPlatformPetStatusClient();
  unregisterQuickCopilotShortcut({
    platform: mainProcessContext.platform,
    globalShortcut
  });
  unregisterPluginGlobalShortcuts(globalShortcut);
  globalShortcut.unregister(FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT);
  pluginBridgeRuntime.stop();
});

app.on("window-all-closed", () => {
  if (mainProcessContext.platform !== "darwin" && appState.isHandlingQuit) {
    app.quit();
  }
});
