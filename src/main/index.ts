import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  session,
  systemPreferences,
  webContents,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { createAppPairingPayload } from "./app-pairing";
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import {
  cancelDesktopSsoLogin,
  completeDesktopSsoCookieLogin,
  failDesktopSsoFlow,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoStatus,
  isDesktopSsoLoginCompletionUrl,
  logoutDesktopSso,
  startDesktopSsoLogin
} from "./oidc-sso";
import { loadBuiltinServices } from "./builtin-loader";
import {
  captureManagedProcessCleanupSnapshot,
  forceCleanupManagedProcesses,
  getServiceLogsMeta,
  readServiceLog,
  watchServiceLog,
  getServiceState,
  getResponsiveServiceState,
  initializeService,
  importServiceFile,
  installBuiltinService,
  listServices,
  readServiceConfig,
  restartService,
  runStartupPreparation,
  startService,
  stopService,
  stopRunningServicesForShutdown,
  verifyServiceState,
  writeServiceConfig
} from "./services/manager";
import {
  hideWindowsForShutdown,
  runWithShutdownDeadline,
  prepareQuitUi as prepareQuitUiFromCleanup
} from "./shutdown-cleanup";
import { stopAllStaticSiteHosts } from "./static-site-host-manager";
import { stopAllWebapps, webappRuntime } from "./webs/webapp-runtime";
import { installBundledWebappTemplates } from "./webs/webapp-template-installer";
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
import {
  configurePluginBridge,
  emitPluginBridgeHook,
  publishPluginBridgeAssistantActiveTasks,
  publishPluginBridgeServiceState,
  setPluginBridgeDesktopReady,
  stopPluginBridgeServers
} from "./plugin-bridge";
import { configurePluginResources, retryPendingPluginResourceSync } from "./plugin-resources";
import {
  hideDesktopActivityIsland,
  hideDesktopClipboardPalette,
  showDesktopClipboardPalette,
  showDesktopPetBanner,
  showSystemUpdateOverlay,
  updateDesktopActivityIsland
} from "./plugin-desktop-effects";
import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  importSkillFromCommand,
  importSandboxImageFromPath,
  importSkillFromPath,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
  toggleMarketFavorite,
  uninstallMarketItem,
  updateMarketItem
} from "./marketplace";
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
import { LogViewerWindowController } from "./app-shell/log-viewer-window";
import { NativeDialogVisibilityController } from "./app-shell/native-dialogs";
import { AppTrayController } from "./app-shell/tray";
import { createTaskBoardRuntime } from "./task-board-runtime";
import {
  getAgentPlatformMinimaxSettingsPublic,
  loadAgentPlatformMinimaxSettings
} from "./copilot/core/agent-platform-config";
import {
  getAssistantSettings,
  readAssistantSettings,
  saveAssistantSettings
} from "./copilot/core/settings-store";
import { readDesktopProfileFromRoot } from "./desktop-profile-store";
import { AgentPlatformAssistantBridge } from "./copilot/core/agent-platform-bridge";
import { AssistantNavigationStatusClient } from "./copilot/core/assistant-navigation-status-client";
import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "./copilot/attachments/attachment-store";
import { getService } from "./services/service-registry";
import type {
  AssistantEvent,
  AssistantCreateCoderProjectRequest,
  AssistantCreateCoderProjectResult,
  AssistantAttachmentTaskProgress,
  AssistantNavAgentItemsResult,
  AssistantSettingsInput,
  AssistantStartRunRequest,
  AssistantSubmitAwaitingRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  DesktopPetAgentOption,
  DesktopPetSettingsInput,
  DesktopPetTaskItem,
  RendererDiagnosticReport,
  AssistantPastedImageInput,
  AssistantWorkerOpenRequest,
  ServiceId,
  ServiceLogReadOptions,
  ServiceOpenLogViewerRequest,
  ServiceRevealPathOptions,
  ServiceLogStreamOptions,
  ServiceLogTarget,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueUpdateInput,
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
import { applyDesktopInitBootstrap } from "./desktop-init-bootstrap";
import {
  bundledEnvZipExists,
  generateBackupDirName,
  importBundledEnvZipToRuntime,
  importEnvZipToRuntime,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeRootExists,
  shouldPromptEnvRootConflict,
  shouldRequireEnvZipImport,
  type EnvRootConflictDecision
} from "./env-bootstrap";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { safeConsoleError } from "./safe-console";
import { callAgentPlatform, handleDesktopActionRequest, startDesktopActionBridge } from "./desktop-action-bridge";
import {
  emitDesktopWsPush,
  getDesktopWsServerRuntimeState,
  startDesktopWsServer,
  stopDesktopWsServer
} from "./desktop-ws-server";
import { callDesktopActionRenderer } from "./desktop-action-renderer";
import { DESKTOP_ACTION_DEFINITIONS } from "../shared/desktop-actions";
import { AGENT_WEBCLIENT_TARGET_PATH } from "../shared/agent-webclient-routes";
import { AgentPlatformPetStatusClient } from "./copilot/pet-copilot/pet-status-client";
import { AgentPlatformPetStreamClient } from "./copilot/pet-copilot/pet-stream-client";
import { createDesktopPetBrowserWindow } from "./copilot/pet-copilot/window";
import {
  registerDesktopPetAssetProtocol,
  registerDesktopPetAssetProtocolScheme
} from "./copilot/pet-copilot/pet-asset-protocol";
import {
  clampDesktopPetPosition,
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_WINDOW_SIZE,
  getDesktopPetContextMenuItems,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetWindowSize,
  listUserDesktopPetAppearanceOptions,
  resolveDesktopPetEdgeDock,
  type DesktopPetBoundAgentStatus,
  type DesktopPetLocalStatus,
  type DesktopPetWindowMode,
  isDesktopPetSupportedPlatform,
  readDesktopPetStoredState,
  saveDesktopPetSettings,
  sanitizeDesktopPetAppearanceId,
  sanitizeDesktopPetBoundAgentKey,
  toDesktopPetSettings
} from "./copilot/pet-copilot/desktop-pet";
import { DesktopPetPreviewProjector, normalizeDesktopPetAgentEvent } from "./copilot/pet-copilot/desktop-pet-preview";
import {
  computeDesktopPetBoundsUpdate,
  computeDesktopPetPositionPersistence,
  computeDesktopPetStateRefresh,
  createDesktopPetActiveRunTracker,
  createDesktopPetActiveTasksFromNavigationSnapshot,
  createDesktopPetDonePreviewDismissalTracker,
  createDesktopPetIdleResetAction,
  resolveDesktopPetWindowMode,
  createDesktopPetDragController,
  createDesktopPetWindowController,
  createDesktopPetClientLifecycleController,
  createDesktopPetPreviewController
} from "./desktop-pet-controller";
import { registerDesktopPetIpcHandlers } from "./ipc/desktop-pet-handlers";
import { registerShellIpcHandlers } from "./ipc/shell-handlers";
import { registerAssistantIpcHandlers } from "./ipc/assistant-handlers";
import { registerServicesIpcHandlers } from "./ipc/services-handlers";
import { registerTaskBoardIpcHandlers } from "./ipc/task-board-handlers";
import { registerSsoIpcHandlers } from "./ipc/sso-handlers";
import { registerSettingsIpcHandlers } from "./ipc/settings-handlers";
import { registerMarketplaceIpcHandlers } from "./ipc/marketplace-handlers";
import { registerWebviewDevToolsIpcHandlers } from "./ipc/webview-devtools-handlers";
import { listWebEntries, registerWebIpcHandlers } from "./ipc/web-handlers";
import {
  isQuickAssistantMediaPermissionAllowed,
} from "./copilot/quick-copilot/quick-copilot";
import { QuickCopilotWindowController } from "./copilot/quick-copilot/window";
import { registerQuickCopilotIpcHandlers } from "./copilot/quick-copilot/ipc";
import {
  createAgentWebclientRoute,
  scheduleQuickAgentOpenRequest
} from "./copilot/quick-copilot/routing";
import {
  registerQuickCopilotShortcut,
  unregisterQuickCopilotShortcut
} from "./copilot/quick-copilot/shortcut";
import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  captureScreenshotForBridge,
  type ScreenshotCaptureSource
} from "./copilot/sidebar-copilot/screenshot";
import { getMainLocaleSettings, initializeMainI18n, setMainLocale, t } from "./i18n/main-i18n";
import { isSupportedLocale } from "../shared/i18n";
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
  createAssistantIpcHandlerOptions,
  createDesktopActionOptions,
  createDesktopPetIpcHandlerOptions,
  createMainProcessContext,
  createMarketplaceIpcHandlerOptions,
  createShellIpcHandlerOptions,
  createSettingsIpcHandlerOptions,
  createServicesIpcHandlerOptions,
  createSsoIpcHandlerOptions,
  createTaskBoardIpcHandlerOptions,
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
const INSTALLER_SHUTDOWN_ARGS = new Set<string>([
  INSTALLER_SHUTDOWN_ARG,
  ...LEGACY_INSTALLER_SHUTDOWN_ARGS
]);

function createAssistantRunWakeLock(platform: NodeJS.Platform, options: {
  isEnabled?: () => boolean;
} = {}) {
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const blockerType = (() => {
    // The policy is the same today, but keep platform branches explicit for compatibility changes.
    if (isMac) {
      return "prevent-app-suspension" as const;
    }
    if (isWindows) {
      return "prevent-app-suspension" as const;
    }
    return null;
  })();
  let blockerId: number | null = null;
  let requested = false;

  function isEnabled() {
    try {
      return options.isEnabled?.() ?? true;
    } catch (error) {
      console.warn("[assistant] failed to read wake lock setting", error);
      return true;
    }
  }

  function startBlockerIfNeeded() {
    if (!blockerType || !requested || !isEnabled()) {
      return;
    }
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      return;
    }
    blockerId = powerSaveBlocker.start(blockerType);
  }

  function stopBlockerIfNeeded() {
    if (blockerId === null) {
      return;
    }
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
    blockerId = null;
  }

  function sync() {
    if (requested && isEnabled()) {
      startBlockerIfNeeded();
      return;
    }
    stopBlockerIfNeeded();
  }

  return {
    acquire() {
      requested = true;
      startBlockerIfNeeded();
    },
    release() {
      requested = false;
      stopBlockerIfNeeded();
    },
    sync
  };
}

const assistantRunWakeLock = createAssistantRunWakeLock(mainProcessContext.platform, {
  isEnabled: () => readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.preventSleepWhileRunning
});
const DESKTOP_PET_DONE_PREVIEW_FALLBACK = "暂无回复预览";
const DESKTOP_PET_GENERIC_DONE_PREVIEWS = new Set([
  "思考中",
  "已完成",
  "回复已生成",
  "正在生成回复",
  "生成完成",
  "生成完成。",
  "打开对话查看完整回复",
  DESKTOP_PET_DONE_PREVIEW_FALLBACK
]);
const DEFAULT_CLIPBOARD_PLUGIN_SHORTCUT = "Alt+V";
const pluginClipboardShortcuts = new Map<string, { accelerator: string; url: string; width: number; height: number }>();
let lastPluginAssistantActiveTasksSignature = "";

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
const DEFAULT_ENV_IMPORT_REQUIRED_MESSAGE = "首次安装需要导入 env.zip";
let startupEnvImportFailureMessage: string | null = null;
let desktopWsServerLastError = "";
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

  appState.desktopPetSettings = readDesktopPetStoredState(app, mainProcessContext.platform, { isFirstInstall: isFirstDesktopInstall });
  if (isFirstDesktopInstall) {
    appState.desktopPetSettings = saveDesktopPetSettings(app, appState.desktopPetSettings, mainProcessContext.platform);
  }
  appState.desktopPetLocalStatus = createDefaultDesktopPetLocalStatus(appState.desktopPetSettings);
  appState.desktopPetAgentStatus = null;
  appState.desktopPetAgentOptions = [];
  appState.desktopPetState = createDesktopPetState(appState.desktopPetSettings, {
    supported: isDesktopPetSupportedPlatform(mainProcessContext.platform),
    visible: false,
    localStatus: appState.desktopPetLocalStatus,
    agentStatus: appState.desktopPetAgentStatus,
    agentOptions: appState.desktopPetAgentOptions,
    appearanceOptions: listUserDesktopPetAppearanceOptions(app)
  });
}

const desktopPetPreviewProjector = new DesktopPetPreviewProjector();
const desktopPetDonePreviewDismissalTracker = createDesktopPetDonePreviewDismissalTracker();
const desktopPetActiveRunTracker = createDesktopPetActiveRunTracker();

const desktopPetPreviewController = createDesktopPetPreviewController({
  platform: mainProcessContext.platform,
  previewProjector: desktopPetPreviewProjector,
  dismissalTracker: desktopPetDonePreviewDismissalTracker,
  activeRunTracker: desktopPetActiveRunTracker,
  getAgentStatus: () => appState.desktopPetAgentStatus,
  scheduleIdleReset: (holdMs: number, force: boolean) => {
    scheduleDesktopPetIdleReset(holdMs, force);
  },
  clearIdleResetTimer: () => {
    clearDesktopPetIdleResetTimer();
  },
  refreshState: (patch: any) => {
    refreshDesktopPetState(patch);
  }
});
const desktopPetDragController = createDesktopPetDragController({
  platform: mainProcessContext.platform,
  getWindow: () => appState.desktopPetWindow,
  getSettings: () => appState.desktopPetSettings,
  saveSettings: (settings) => {
    appState.desktopPetSettings = saveDesktopPetSettings(app, settings, mainProcessContext.platform);
  },
  getMode: () => getDesktopPetWindowMode(),
  getCursorScreenPoint: () => screen.getCursorScreenPoint(),
  getDisplayBounds: (position) => getDesktopPetDisplayBounds(position),
  getPointDisplayBounds: (point) => getDesktopPetPointDisplayBounds(point),
  persistPosition: (mode) => persistDesktopPetPosition(mode),
  refreshState: () => refreshDesktopPetState()
});
const desktopPetWindowController = createDesktopPetWindowController({
  platform: mainProcessContext.platform,
  createWindow: (bounds) => {
    const win = createDesktopPetBrowserWindow({
      bounds,
      platform: mainProcessContext.platform,
      preloadPath: path.join(__dirname, "..", "preload", "index.js"),
      onClosed: () => {
        appState.desktopPetWindow = null;
      }
    });
    appState.desktopPetWindow = win;
    return win;
  },
  getSettings: () => appState.desktopPetSettings,
  saveSettings: (settings) => {
    appState.desktopPetSettings = saveDesktopPetSettings(app, settings, mainProcessContext.platform);
  },
  getMode: () => getDesktopPetWindowMode(),
  getBounds: () => getDesktopPetBounds(),
  isHandlingQuit: () => appState.isHandlingQuit,
  loadRendererRoute: async (win, route) => {
    await loadRendererRoute(win, route);
  },
  buildContextMenu: () => {
    return buildDesktopPetContextMenu();
  },
  startStatusClient: () => {
    startAgentPlatformPetStatusClient();
  },
  stopStatusClient: () => {
    stopAgentPlatformPetStatusClient();
  },
  endDrag: () => {
    endDesktopPetWindowDrag();
  },
  clearIdleResetTimer: () => {
    clearDesktopPetIdleResetTimer();
  },
  clearPreviewRefreshTimer: () => {
    desktopPetPreviewController.clearRefreshTimer();
  },
  clearPreview: () => {
    desktopPetPreviewController.clearPreview();
  },
  refreshState: (patch) => {
    return refreshDesktopPetState(patch);
  },
  setMouseInteractive: (interactive) => {
    setDesktopPetWindowMouseInteractive(interactive);
  },
  onWindowMove: () => {
    persistDesktopPetPosition();
  }
});
const desktopPetClientLifecycleController = createDesktopPetClientLifecycleController({
  platform: mainProcessContext.platform,
  app,
  AgentStatusClientClass: AgentPlatformPetStatusClient,
  AgentStreamClientClass: AgentPlatformPetStreamClient,
  getServiceState: getResponsiveServiceState,
  issueAccessToken: issueAgentAccessToken,
  getSettings: () => appState.desktopPetSettings,
  setAgentStatus: (status) => {
    appState.desktopPetAgentStatus = status;
  },
  setAgentOptions: (options) => {
    appState.desktopPetAgentOptions = options;
  },
  clearActiveRuns: () => {
    clearDesktopPetActiveRuns();
  },
  updateActiveRuns: (event) => {
    updateDesktopPetActiveRuns(event);
  },
  clearDismissedPreview: (chatId, runId) => {
    desktopPetDonePreviewDismissalTracker.clear(chatId, runId);
  },
  getPreviewPanel: () => {
    return desktopPetPreviewController.getPanel();
  },
  ingestAgentEvent: (event, context) => {
    desktopPetPreviewController.ingestAgentEvent(event, context);
  },
  refreshCompletedPreviewFromStatus: (status) => {
    return desktopPetPreviewController.refreshCompletedPreviewFromAgentStatus(status);
  },
  refreshState: () => {
    refreshDesktopPetState();
  }
});
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

if (hasInstallerShutdownArg(process.argv)) {
  app.exit(0);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asPluginRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizePluginShortcutAccelerator(value: unknown) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_CLIPBOARD_PLUGIN_SHORTCUT;
  return raw.replace(/^Option\+/iu, "Alt+");
}

function normalizePluginLocalHttpUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("url is required");
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:") {
    throw new Error("url must use http");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("url must point to localhost");
  }
  return parsed.toString();
}

function clampPluginWindowDimension(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function getDesktopClipboardTextForPlugin() {
  if (mainProcessContext.platform === "darwin") {
    return { text: clipboard.readText(), platform: "darwin" };
  }
  if (mainProcessContext.platform === "win32") {
    return { text: clipboard.readText(), platform: "win32" };
  }
  return { text: clipboard.readText(), platform: mainProcessContext.platform };
}

function writeDesktopClipboardTextForPlugin(params: unknown) {
  const text = String(asPluginRecord(params).text ?? "");
  if (mainProcessContext.platform === "darwin") {
    clipboard.writeText(text);
    return { written: true, platform: "darwin" };
  }
  if (mainProcessContext.platform === "win32") {
    clipboard.writeText(text);
    return { written: true, platform: "win32" };
  }
  clipboard.writeText(text);
  return { written: true, platform: mainProcessContext.platform };
}

function showDesktopClipboardPaletteForPlugin(pluginId: string, params: unknown) {
  if (mainProcessContext.platform !== "darwin") {
    return { shown: false, unsupported: true, platform: mainProcessContext.platform };
  }
  const record = asPluginRecord(params);
  return showDesktopClipboardPalette(pluginId, {
    url: normalizePluginLocalHttpUrl(record.url),
    width: clampPluginWindowDimension(record.width, 520, 360, 760),
    height: clampPluginWindowDimension(record.height, 520, 320, 760)
  });
}

function hideDesktopClipboardPaletteForPlugin(pluginId: string) {
  return hideDesktopClipboardPalette(pluginId);
}

function unregisterDesktopClipboardShortcutForPlugin(pluginId: string) {
  const owned = pluginClipboardShortcuts.get(pluginId);
  if (!owned) {
    return { unregistered: false };
  }
  globalShortcut.unregister(owned.accelerator);
  pluginClipboardShortcuts.delete(pluginId);
  hideDesktopClipboardPaletteForPlugin(pluginId);
  return { unregistered: true, accelerator: owned.accelerator };
}

function cleanupPluginBridgePlugin(pluginId: string) {
  unregisterDesktopClipboardShortcutForPlugin(pluginId);
}

function registerDesktopClipboardShortcutForPlugin(pluginId: string, params: unknown) {
  if (mainProcessContext.platform !== "darwin") {
    return { registered: false, unsupported: true, platform: mainProcessContext.platform };
  }
  const record = asPluginRecord(params);
  const accelerator = normalizePluginShortcutAccelerator(record.accelerator);
  const url = normalizePluginLocalHttpUrl(record.url);
  const width = clampPluginWindowDimension(record.width, 520, 360, 760);
  const height = clampPluginWindowDimension(record.height, 520, 320, 760);
  unregisterDesktopClipboardShortcutForPlugin(pluginId);
  const registered = globalShortcut.register(accelerator, () => {
    showDesktopClipboardPalette(pluginId, { url, width, height });
  });
  if (!registered) {
    return { registered: false, accelerator };
  }
  pluginClipboardShortcuts.set(pluginId, { accelerator, url, width, height });
  return { registered: true, accelerator };
}

function getAssistantActiveTasksSnapshotForPlugins() {
  const tasks = getDesktopPetActiveTasksForState();
  return {
    tasks,
    runningTaskCount: Math.max(getDesktopPetRunningTaskCountForState(), tasks.length),
    updatedAt: new Date().toISOString()
  };
}

function publishPluginAssistantActiveTasks(tasks: DesktopPetTaskItem[], runningTaskCount: number) {
  const signature = JSON.stringify({
    runningTaskCount,
    tasks: tasks.map((task) => ({
      id: task.id,
      runId: task.runId,
      status: task.status,
      title: task.title,
      preview: task.preview,
      updatedAt: task.updatedAt
    }))
  });
  if (signature === lastPluginAssistantActiveTasksSignature) {
    return;
  }
  lastPluginAssistantActiveTasksSignature = signature;
  publishPluginBridgeAssistantActiveTasks(tasks, runningTaskCount);
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

const logViewerWindowController = new LogViewerWindowController({
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
      role: "确认对话示例",
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
const desktopSsoController = createDesktopSsoController({
  app,
  platform: mainProcessContext.platform,
  session,
  getMainWindow: () => appState.mainWindow,
  openBrowserUrl,
  openExternal: shell.openExternal
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
      failDesktopSsoFlow("Desktop SSO 配置缺少 cookieAccessTokenExchange，无法从完成页捕捉用户信息。");
      return;
    }
    await desktopSsoController.syncBrowserCookies();
    const accessToken = await desktopSsoController.exchangeBrowserCookieAccessToken();
    if (!accessToken) {
      failDesktopSsoFlow("Desktop SSO cookieAccessTokenExchange 未返回 access_token，无法捕捉用户信息。");
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
  if (appState.desktopPetIdleResetTimer) {
    clearTimeout(appState.desktopPetIdleResetTimer);
    appState.desktopPetIdleResetTimer = null;
  }
}



function updateDesktopPetActiveRuns(event: { type?: unknown; runId?: unknown; data?: unknown } | null | undefined) {
  if (!desktopPetActiveRunTracker.update(event)) {
    return false;
  }
  refreshDesktopPetState();
  return true;
}

function clearDesktopPetActiveRuns() {
  if (!desktopPetActiveRunTracker.clear()) {
    return false;
  }
  refreshDesktopPetState();
  return true;
}

function getTaskBoardActiveRunIdsForDesktopPet() {
  try {
    return (appState.taskBoardRuntime?.listIssues().issues ?? [])
      .filter((issue) => issue.status === "in_progress" && Boolean(issue.runId))
      .map((issue) => issue.runId)
      .filter((runId): runId is string => Boolean(runId));
  } catch (error) {
    console.warn("[desktop-pet] failed to read task-board active runs", error);
    return [];
  }
}

function getDesktopPetRunningTaskCountForState() {
  const fallbackRunning = appState.desktopPetLocalStatus.status === "running" ||
    appState.desktopPetLocalStatus.status === "awaiting" ||
    appState.desktopPetAgentStatus?.presence === "busy" ||
    Boolean(appState.desktopPetAgentStatus?.hasPendingAwaiting);
  return desktopPetActiveRunTracker.getRunningTaskCount({
    taskBoardRunIds: getTaskBoardActiveRunIdsForDesktopPet(),
    fallbackRunning
  });
}

function getDesktopPetActiveTasksForState() {
  return createDesktopPetActiveTasksFromNavigationSnapshot(
    appState.assistantNavigationStatusClient?.getSnapshot()
  );
}

function getDesktopPetAgentStatusForState() {
  return desktopPetDonePreviewDismissalTracker.filterAgentStatus(appState.desktopPetAgentStatus);
}

function listTaskBoardLocalAgents(): DesktopPetAgentOption[] {
  const agents = new Map<string, DesktopPetAgentOption>();
  const fallbackTaskBoardAgentKey = "cutej";
  for (const agent of appState.desktopPetAgentOptions) {
    const agentKey = agent.agentKey?.trim();
    if (!agentKey || agents.has(agentKey)) {
      continue;
    }
    agents.set(agentKey, {
      ...agent,
      agentKey,
      displayName: agent.displayName?.trim() || agentKey,
      role: agent.role?.trim() || "",
      unreadCount: Math.max(0, Math.round(agent.unreadCount ?? 0))
    });
  }

  const status = getDesktopPetAgentStatusForState();
  const statusAgentKey = status?.agentKey?.trim() ?? "";
  if (status && !status.stale && statusAgentKey && !agents.has(statusAgentKey)) {
    agents.set(statusAgentKey, {
      agentKey: statusAgentKey,
      displayName: status.displayName?.trim() || statusAgentKey,
      role: status.role?.trim() || "",
      unreadCount: Math.max(0, Math.round(status.unreadCount ?? 0))
    });
  }
  if (agents.size === 0) {
    agents.set(fallbackTaskBoardAgentKey, {
      agentKey: fallbackTaskBoardAgentKey,
      displayName: "小君",
      role: "桌面智能体",
      unreadCount: 0
    });
  }
  return [...agents.values()];
}

function getDesktopPetWindowMode(): DesktopPetWindowMode {
  return resolveDesktopPetWindowMode({
    dragging: desktopPetDragController.isDragging(),
    state: appState.desktopPetState,
    previewPanel: desktopPetPreviewController.getPanel()
  });
}

function getDesktopPetVisible() {
  return desktopPetWindowController.isVisible();
}

function ensureAgentPlatformPetStatusClient() {
  return desktopPetClientLifecycleController.ensureStatusClient();
}

function ensureAgentPlatformPetStreamClient() {
  return desktopPetClientLifecycleController.ensureStreamClient();
}

function startAgentPlatformPetStatusClient() {
  desktopPetClientLifecycleController.startStatusClient();
}

function stopAgentPlatformPetStatusClient() {
  desktopPetClientLifecycleController.stopStatusClient();
}

function scheduleAgentPlatformPetStatusRefresh(delayMs = 0, force = false) {
  desktopPetClientLifecycleController.scheduleStatusRefresh(delayMs, force);
}

function refreshDesktopPetState(patch: Partial<DesktopPetLocalStatus> = {}) {
  const visible = getDesktopPetVisible();
  const activeTasks = getDesktopPetActiveTasksForState();
  const runningTaskCount = Math.max(getDesktopPetRunningTaskCountForState(), activeTasks.length);
  const refresh = computeDesktopPetStateRefresh({
    settings: appState.desktopPetSettings,
    supported: isDesktopPetSupportedPlatform(mainProcessContext.platform),
    visible,
    localStatus: appState.desktopPetLocalStatus,
    patch,
    agentStatus: getDesktopPetAgentStatusForState(),
    agentOptions: appState.desktopPetAgentOptions,
    appearanceOptions: listUserDesktopPetAppearanceOptions(app),
    activeTasks,
    previewPanel: desktopPetPreviewController.getPanel(),
    runningTaskCount,
    edgeDock: resolveDesktopPetEdgeDock(
      appState.desktopPetSettings.position,
      getDesktopPetDisplayBounds(appState.desktopPetSettings.position)
    )
  });
  appState.desktopPetLocalStatus = refresh.localStatus;
  appState.desktopPetState = refresh.state;
  applyDesktopPetWindowBounds();
  if (refresh.settingsPatch) {
    appState.desktopPetSettings = saveDesktopPetSettings(app, {
      unreadCount: refresh.settingsPatch.unreadCount
    }, mainProcessContext.platform);
  }
  for (const targetWindow of [appState.mainWindow, appState.desktopPetWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("desktopPet.state", appState.desktopPetState);
  }
  publishPluginAssistantActiveTasks(refresh.state.activeTasks, refresh.state.runningTaskCount);
  appTrayController.refreshContextMenu();
  return appState.desktopPetState;
}

function scheduleDesktopPetIdleReset(timeoutMs = 4200, clearPreview = false) {
  clearDesktopPetIdleResetTimer();
  appState.desktopPetIdleResetTimer = setTimeout(() => {
    const action = createDesktopPetIdleResetAction(clearPreview);
    if (action.rememberDismissedDonePreview) {
      desktopPetDonePreviewDismissalTracker.rememberFrom(desktopPetPreviewController.getPanel(), appState.desktopPetAgentStatus);
    }
    if (action.clearPreview) {
      desktopPetPreviewController.clearPreview();
    }
    refreshDesktopPetState(action.patch);
    appState.desktopPetIdleResetTimer = null;
  }, timeoutMs);
}

function getDesktopPetDisplayBounds(position?: { x: number; y: number }) {
  if (position) {
    return getDesktopPetPointDisplayBounds({
      x: position.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x +
        Math.round(DESKTOP_PET_VISIBLE_FOOTPRINT.width / 2),
      y: position.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y +
        Math.round(DESKTOP_PET_VISIBLE_FOOTPRINT.height / 2)
    });
  }
  return screen.getPrimaryDisplay().workArea;
}

function getDesktopPetPointDisplayBounds(point: { x: number; y: number }) {
  return screen.getDisplayMatching({
    x: point.x,
    y: point.y,
    width: 1,
    height: 1
  }).workArea;
}

function getDesktopPetBounds() {
  return getAnchoredDesktopPetBounds(
    appState.desktopPetSettings.position,
    getDesktopPetDisplayBounds(appState.desktopPetSettings.position),
    getDesktopPetWindowMode()
  );
}

function clearDesktopPetProgrammaticBoundsGuard() {
  if (appState.desktopPetProgrammaticBoundsGuardTimer) {
    clearTimeout(appState.desktopPetProgrammaticBoundsGuardTimer);
    appState.desktopPetProgrammaticBoundsGuardTimer = null;
  }
}

function armDesktopPetProgrammaticBoundsGuard(signature: string) {
  appState.desktopPetPendingProgrammaticBoundsSignature = signature;
  clearDesktopPetProgrammaticBoundsGuard();
  appState.desktopPetProgrammaticBoundsGuardTimer = setTimeout(() => {
    appState.desktopPetPendingProgrammaticBoundsSignature = null;
    appState.desktopPetProgrammaticBoundsGuardTimer = null;
  }, 180);
}

function applyDesktopPetWindowBounds() {
  if (!isDesktopPetSupportedPlatform(mainProcessContext.platform) || !appState.desktopPetWindow || appState.desktopPetWindow.isDestroyed()) {
    return;
  }
  if (desktopPetDragController.isDragging()) {
    return;
  }
  const nextBounds = getDesktopPetBounds();
  const currentBounds = appState.desktopPetWindow.getBounds();
  const update = computeDesktopPetBoundsUpdate({ currentBounds, nextBounds });
  if (update.clearPendingGuard) {
    appState.desktopPetPendingProgrammaticBoundsSignature = null;
    clearDesktopPetProgrammaticBoundsGuard();
    return;
  }
  if (update.pendingSignature) {
    armDesktopPetProgrammaticBoundsGuard(update.pendingSignature);
  }
  if (update.setBounds) {
    appState.desktopPetWindow.setBounds(update.setBounds, false);
  }
}

function persistDesktopPetPosition(mode: DesktopPetWindowMode = getDesktopPetWindowMode()) {
  if (!appState.desktopPetWindow || appState.desktopPetWindow.isDestroyed()) {
    return;
  }
  if (desktopPetDragController.isDragging()) {
    return;
  }
  const bounds = appState.desktopPetWindow.getBounds();
  const persistence = computeDesktopPetPositionPersistence({
    bounds,
    mode,
    pendingSignature: appState.desktopPetPendingProgrammaticBoundsSignature,
    currentPosition: appState.desktopPetSettings.position
  });
  if (persistence.clearPendingGuard) {
    appState.desktopPetPendingProgrammaticBoundsSignature = null;
    clearDesktopPetProgrammaticBoundsGuard();
  }
  if (!persistence.shouldPersist || !persistence.position) {
    return;
  }
  appState.desktopPetSettings = saveDesktopPetSettings(app, {
    position: persistence.position
  }, mainProcessContext.platform);
  refreshDesktopPetState();
}

function moveDesktopPetWindowBy(delta: { x?: unknown; y?: unknown }) {
  return desktopPetDragController.moveWindowBy(delta);
}

function stickDesktopPetWindowToEdge(mode: DesktopPetWindowMode = getDesktopPetWindowMode()) {
  desktopPetDragController.stickToEdge(mode);
}

function prepareDesktopPetWindowForDrag(mode: DesktopPetWindowMode) {
  desktopPetDragController.prepareWindowForDrag(mode);
}

function beginDesktopPetWindowDrag(point: { x?: unknown; y?: unknown }) {
  return desktopPetDragController.beginDrag(point);
}

function endDesktopPetWindowDrag() {
  return desktopPetDragController.endDrag();
}

function hideDesktopPetWindow(disable = false) {
  return desktopPetWindowController.hideWindow(disable);
}

function setDesktopPetWindowMouseInteractive(interactive: boolean) {
  if (!appState.desktopPetWindow || appState.desktopPetWindow.isDestroyed()) {
    appState.desktopPetMouseInteractive = true;
    return { ok: false };
  }
  if (appState.desktopPetMouseInteractive === interactive) {
    return { ok: true };
  }
  appState.desktopPetMouseInteractive = interactive;
  if (mainProcessContext.platform === "darwin") {
    appState.desktopPetWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return { ok: true };
  }
  if (mainProcessContext.platform === "win32") {
    // Windows cannot forward mousemove events while ignored, so keep the pet window interactive there.
    appState.desktopPetWindow.setIgnoreMouseEvents(false);
    return { ok: true };
  }
  appState.desktopPetWindow.setIgnoreMouseEvents(false);
  return { ok: true };
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
      message: `智能助理服务恢复失败：${failures.join("，")}`,
      window: appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null
    };
  }

  return {
    ok: true,
    message: "智能助理已打开。",
    window: appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null
  };
}

async function markAgentPlatformChatReadFromDesktopPet(chatId: string) {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) {
    return;
  }
  try {
    const serviceState = await getResponsiveServiceState(app, "agent-platform");
    const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
    if (!baseUrl) {
      return;
    }
    const tokenResult = await issueAgentAccessToken(app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      return;
    }
    const response = await fetch(new URL("/api/read", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.token.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ chatId: normalizedChatId })
    });
    if (!response.ok) {
      throw new Error(`agent-platform /api/read returned HTTP ${response.status}`);
    }
    const payload = await response.json() as { data?: unknown };
    const data = typeof payload.data === "object" && payload.data !== null
      ? payload.data as { agentKey?: unknown; agentUnreadCount?: unknown }
      : {};
    const agentKey = typeof data.agentKey === "string" ? data.agentKey.trim() : "";
    const rawUnreadCount = Number(data.agentUnreadCount);
    const fallbackUnreadCount = Math.max(0, (appState.desktopPetAgentStatus?.unreadCount ?? 1) - 1);
    const unreadCount = Number.isFinite(rawUnreadCount) && rawUnreadCount >= 0
      ? Math.round(rawUnreadCount)
      : fallbackUnreadCount;

    if (!appState.desktopPetAgentStatus || (agentKey && agentKey !== appState.desktopPetAgentStatus.agentKey)) {
      return;
    }
    appState.desktopPetAgentStatus = {
      ...appState.desktopPetAgentStatus,
      chatId: normalizedChatId,
      unreadCount,
      stale: false,
      updatedAt: new Date().toISOString()
    };
    refreshDesktopPetState();
  } catch (error) {
    console.warn("[desktop-pet] failed to mark agent chat read", error);
  } finally {
    scheduleAgentPlatformPetStatusRefresh(250, true);
  }
}

async function openAssistantFromDesktopPet() {
  showMainWindow();
  const targetWindow = appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null;
  return {
    ok: Boolean(targetWindow),
    message: targetWindow ? `${PRODUCT_NAME} 已打开。` : `${PRODUCT_NAME} 主窗口不可用。`
  };
}

async function openDesktopPetTaskChat(input: { agentKey?: unknown; chatId?: unknown } = {}) {
  const agentKey = typeof input.agentKey === "string" ? input.agentKey.trim() : "";
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  if (!agentKey || !chatId) {
    return {
      ok: false,
      message: "任务缺少智能体或聊天标识。"
    };
  }
  await openAssistantWorker({
    agentKey,
    chatId,
    focusComposerOnComplete: false
  });
  return {
    ok: true,
    message: "已打开任务聊天。"
  };
}

function requestDesktopPetSignature(signatureId: string) {
  if (!appState.desktopPetWindow || appState.desktopPetWindow.isDestroyed()) {
    return { ok: false };
  }
  appState.desktopPetWindow.webContents.send("desktopPet.signatureRequested", signatureId);
  return { ok: true };
}

function buildDesktopPetContextMenu() {
  const template = getDesktopPetContextMenuItems(
    appState.desktopPetState.appearanceId,
    appState.desktopPetState.signature ?? []
  )
    .map((item): MenuItemConstructorOptions => ({
      label: item.label,
      click: () => {
        if (item.action === "signature") {
          requestDesktopPetSignature(item.signatureId);
          return;
        }
        hideDesktopPetWindow(true);
      }
    }));
  return Menu.buildFromTemplate(template);
}

function createDesktopPetWindow() {
  return desktopPetWindowController.createWindow();
}

function showDesktopPetWindow() {
  return desktopPetWindowController.showWindow();
}

function ingestDesktopPetAgentEvent(event: unknown, meta: { source?: string; transportMode?: string } = {}) {
  desktopPetPreviewController.ingestAgentEvent(event, meta);
}

function dismissDesktopPetPreview() {
  return desktopPetPreviewController.dismissPreview();
}

function handleDesktopPetAssistantEvent(event: AssistantEvent) {
  if (!isDesktopPetSupportedPlatform(mainProcessContext.platform)) {
    return;
  }
  ingestDesktopPetAgentEvent(event, {
    source: "local",
    transportMode: "local"
  });
}

function showQuickAssistantDismissWindow() {
  quickCopilotWindowController.showDismissWindow();
}

function hideQuickAssistantDismissWindow() {
  quickCopilotWindowController.hideDismissWindow();
}

async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
  return logViewerWindowController.open(request);
}

async function openAgentPlatformMonitorWindow(url: string) {
  return agentPlatformMonitorWindowController.open(url);
}

function closeLogViewerWindow() {
  return logViewerWindowController.close();
}

function minimizeLogViewerWindow() {
  return logViewerWindowController.minimize();
}

function maximizeLogViewerWindow() {
  return logViewerWindowController.maximize();
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
      rendererBrandIconPath,
      buildAppIconPath,
      generatedBrandIconPath
    ];
  }

  return [
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
  void publishPluginBridgeServiceStates();
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

async function publishPluginBridgeServiceStates() {
  try {
    const services = await listServices(app);
    for (const service of services) {
      publishPluginBridgeServiceState(service);
    }
    const agentPlatform = services.find((service) => service.id === "agent-platform");
    if (agentPlatform?.status === "running") {
      void retryPendingPluginResourceSync(app).catch((error) => {
        safeConsoleError("failed to retry pending plugin resource sync", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  } catch (error) {
    safeConsoleError("failed to publish plugin bridge service states", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
  }
  if (getDesktopPetVisible()) {
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
      message: `已将「${input.label || targetUrl}」发送到内置浏览器。`
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
        message: `Opened ${input.label || BUILTIN_BROWSER_SURFACE_LABEL}.`,
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
    message: `Tried to open ${input.label || targetUrl}, but no operable web target was available.`
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
      message: `No matching embedded site found: ${target}`,
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
        message: `Opened ${activatedSurface.label}.`,
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
    message: `Switched to ${surface.label}, but no operable web instance is available yet.`,
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
    logViewerWindowController.getWindow()
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
    logViewerWindowController.getWindow()
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
    title: "检测到旧环境目录",
    message: `目录 ${runtimeRootAtProcessStart} 已存在，是否迁移旧数据？`,
    detail: `迁移后旧目录将重命名为 ${backupPath}，然后导入全新环境。\n选择“使用旧数据”将跳过环境导入，直接使用现有目录。`,
    buttons: ["迁移旧数据并初始化", "使用旧数据", `退出 ${PRODUCT_NAME}`],
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
      title: "旧环境迁移失败",
      message,
      detail: `旧目录：${runtimeRootAtProcessStart}\n目标备份：${backupPath}`,
      buttons: [`退出 ${PRODUCT_NAME}`, "使用旧数据"],
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

async function pickAssistantAttachments(chatId: string | null | undefined, ownerWindow: BrowserWindow | null) {
  const result = await showFileDialog({
    title: `选择要给 ${PRODUCT_NAME} 读取的附件`,
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "可读取文本或常见文档",
        extensions: [
          "txt",
          "md",
          "csv",
          "json",
          "jsonl",
          "log",
          "html",
          "xml",
          "yml",
          "yaml",
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
          "pdf",
          "docx",
          "xlsx",
          "pptx"
        ]
      },
      { name: "所有文件", extensions: ["*"] }
    ]
  }, ownerWindow);
  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      chatId: chatId ?? "",
      message: "已取消选择附件。",
      attachments: []
    };
  }
  return createAssistantAttachmentsFromFiles(app, chatId, result.filePaths, {
    onProgress: emitAssistantAttachmentProgress
  });
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

async function renderAssistantPdf(html: string) {
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 960,
    height: 1280,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try {
    pdfWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    pdfWindow.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
    await pdfWindow.loadURL(dataUrl);
    const pdf = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: "A4"
    });
    return Buffer.from(pdf);
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
  }
}


function registerIpcHandlers(context: MainProcessContext) {
  const state = context.state;
  const assistantBridge = new AgentPlatformAssistantBridge({
    app,
    getServiceState: getResponsiveServiceState,
    issueAccessToken: issueAgentAccessToken,
    wakeLock: assistantRunWakeLock,
    onEvent: (event) => {
      state.taskBoardRuntime?.sendAssistantEvent(event);
      emitDesktopWsPush("assistant.event", event);
      for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
        if (!targetWindow || targetWindow.isDestroyed()) {
          continue;
        }
        targetWindow.webContents.send("assistant.event", event);
      }
      handleDesktopPetAssistantEvent(event);
    }
  });
  state.taskBoardRuntime = createTaskBoardRuntime({
    app,
    assistantBridge,
    callAgentPlatform,
    listLocalAgents: listTaskBoardLocalAgents,
    onChanged: () => {
      emitTaskBoardChanged();
    },
    onDebug: (message) => {
      console.warn(`[task-board] ${message}`);
    }
  });
  state.taskBoardRuntime.start();
  state.assistantNavigationStatusClient = new AssistantNavigationStatusClient({
    app,
    getServiceState: getResponsiveServiceState,
    issueAccessToken: issueAgentAccessToken,
    onSnapshot: emitAssistantNavigationAgentsChanged,
    onPushEvent: (event) => state.taskBoardRuntime?.sendAssistantEvent(event),
    onDebug: (message) => {
      console.warn(`[assistant-navigation] status unavailable: ${message}`);
    }
  });
  state.assistantNavigationStatusClient.start();

  cdpIntegration.start();
  const desktopActionOptions = createDesktopActionOptions(context, {
    assistantBridge,
    navigate: showMainWindow,
    openLogViewer: openLogViewerWindow,
    callRendererAction: (request) => callDesktopActionRenderer(request, {
      getMainWindow: () => appState.mainWindow,
      pendingRequests: appState.desktopActionRendererRequests
    }),
    cdpIntegration
  });
  startDesktopActionBridge({
    ...desktopActionOptions
  });
  const desktopWsServerOptions = {
    app,
    desktopActionOptions,
    assistantBridge,
    getTaskBoardRuntime: () => state.taskBoardRuntime,
    agentPlatformBridge: {
      getServiceState: getResponsiveServiceState,
      issueAccessToken: issueAgentAccessToken
    },
    logger: console
  };
  const getDesktopWsServerRuntimeStateForSettings = () => {
    const state = getDesktopWsServerRuntimeState();
    return desktopWsServerLastError ? { ...state, message: desktopWsServerLastError } : state;
  };
  const startDesktopWsServerForSettings = async () => {
    desktopWsServerLastError = "";
    try {
      return await startDesktopWsServer(desktopWsServerOptions);
    } catch (error) {
      desktopWsServerLastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  const stopDesktopWsServerForSettings = async () => {
    desktopWsServerLastError = "";
    await stopDesktopWsServer();
    return getDesktopWsServerRuntimeState();
  };
  if (readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled) {
    void startDesktopWsServerForSettings().catch((error) => {
      safeConsoleError("failed to start Desktop WS server", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  registerShellIpcHandlers(ipcMain, createShellIpcHandlerOptions(context, {
    showFileDialog,
    revealPathInFileManager,
    captureDesktopScreenshot: captureDesktopScreenshotForWebview,
    reportRendererDiagnostic
  }));
  registerWebviewDevToolsIpcHandlers(ipcMain, { webContents });

  registerAssistantIpcHandlers(ipcMain, createAssistantIpcHandlerOptions(context, {
    assistantBridge,
    desktopActionOptions,
    showFileDialog,
    callAgentPlatform,
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot: captureAssistantScreenshot as any
  }));

  registerQuickCopilotIpcHandlers(ipcMain, quickCopilotWindowController);

  registerServicesIpcHandlers(ipcMain, createServicesIpcHandlerOptions(context, {
    listServices,
    getServiceState,
    getResponsiveServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readPluginSettings: readPluginSettingsSnapshot,
    writePluginSettings: writePluginSettingsValues,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts: refreshPluginDesktopGlobalShortcuts,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation,
    handleServiceStart,
    showFileDialog,
    showMessageBox,
    showArchiveDialog,
    openLogViewerWindow,
    closeLogViewerWindow,
    minimizeLogViewerWindow,
    maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow,
    issueAgentPlatformAccessToken: issueAgentAccessToken,
    revealPathInFileManager,
    getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl,
    startupRestoreController,
    importEnvZipToRuntime,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged,
    runStartupPreparation,
    applyDesktopInitBootstrap,
    refreshDesktopRuntimeConfigFromCanonicalFiles,
    oldRootDecisionRef,
    generateBackupDirName,
    migrateOldRootToBackup,
    shouldPromptEnvRootConflict,
    isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart
  }));

  registerMarketplaceIpcHandlers(ipcMain, createMarketplaceIpcHandlerOptions(context, {
    t,
    runServiceMutation,
    showArchiveDialog,
    showFileDialog,
    showSaveDialog,
    installPluginFromArchive,
    handlePluginUninstall,
    getMarketSettings,
    saveMarketSettings,
    listMarketItems,
    refreshMarketCatalog,
    toggleMarketFavorite: (marketApp, input) => toggleMarketFavorite(marketApp, input, { issueAgentAccessToken }),
    installMarketItem,
    updateMarketItem,
    uninstallMarketItem,
    buildSandboxImage,
    deleteSandboxImage,
    exportSandboxImageToPath,
    importSandboxImageFromPath,
    importSkillFromPath,
    importSkillFromCommand,
    getPanAuthStatus,
    importPanPrivateKey,
    onMarketCommandResult: (result) => {
      if (result?.type === "pet") {
        appState.desktopPetSettings = readDesktopPetStoredState(app, mainProcessContext.platform);
        refreshDesktopPetState();
      }
    }
  }));
  registerSsoIpcHandlers(ipcMain, createSsoIpcHandlerOptions(context, {
    desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken
  }));
  registerTaskBoardIpcHandlers(ipcMain, createTaskBoardIpcHandlerOptions(context, {
    listTaskBoardIssues: () => state.taskBoardRuntime?.listIssues() ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      issues: []
    },
    listTaskBoardOnlineDevices: () => state.taskBoardRuntime?.listOnlineDevices() ?? {
      ok: false,
      online: false,
      deviceCount: 0,
      sessionCount: 0,
      agentCount: 0,
      devices: [],
      message: "任务看板尚未初始化。"
    },
    getTaskBoardSettings: () => state.taskBoardRuntime?.getSettings() ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      settings: {
        enabled: false,
        cloud: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    saveTaskBoardSettings: (_app: any, input: any) => state.taskBoardRuntime?.saveSettings(input) ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      settings: {
        enabled: false,
        cloud: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" }
      },
      connectionState: "disabled"
    },
    getTaskBoardCloudConfig: () => state.taskBoardRuntime?.getCloudConfig() ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      config: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    saveTaskBoardCloudConfig: (_app: any, input: any) => state.taskBoardRuntime?.saveCloudConfig(input) ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      config: { serverUrl: "", token: "", selectedProjectId: "default", remoteControlEnabled: false, deviceAlias: "" },
      connectionState: "disabled"
    },
    createTaskBoardIssue: (_app: any, input: any) => state.taskBoardRuntime?.createIssue(input) ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      issues: []
    },
    updateTaskBoardIssue: (_app: any, issueId: string, input: any) => state.taskBoardRuntime?.updateIssue(issueId, input) ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      issues: []
    },
    deleteTaskBoardIssueWithAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.taskBoardRuntime?.deleteIssueWithAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: "任务看板尚未初始化。",
        issues: []
      },
    moveTaskBoardIssue: (_app: any, input: any) => state.taskBoardRuntime?.moveIssue(input) ?? {
      ok: false,
      message: "任务看板尚未初始化。",
      issues: []
    },
    syncTaskBoardIssueAutomation: (_app: any, issueId: string, agentPlatformCaller: any) =>
      state.taskBoardRuntime?.syncIssueAutomation(issueId, agentPlatformCaller) ?? {
        ok: false,
        message: "任务看板尚未初始化。",
        issues: []
      },
    callAgentPlatform
  }));
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog,
    showSaveDialog,
    getDataRoot
  });
  registerDesktopPetIpcHandlers(ipcMain, createDesktopPetIpcHandlerOptions(context, {
    clearActiveRuns: () => {
      clearDesktopPetActiveRuns();
    },
    showWindow: () => {
      showDesktopPetWindow();
    },
    hideWindow: (disable: boolean) => {
      hideDesktopPetWindow(disable);
    },
    openAssistant: () => {
      return openAssistantFromDesktopPet();
    },
    openTaskChat: (input: any) => {
      return openDesktopPetTaskChat(input);
    },
    moveWindowBy: (delta: any) => {
      return moveDesktopPetWindowBy(delta);
    },
    beginDrag: (point: any) => {
      return beginDesktopPetWindowDrag(point);
    },
    endDrag: () => {
      return endDesktopPetWindowDrag();
    },
    setPreviewExpanded: (expanded: boolean) => {
      desktopPetPreviewProjector.setExpanded(Boolean(expanded));
    },
    dismissPreview: () => {
      return dismissDesktopPetPreview();
    },
    setMouseInteractive: (interactive: boolean) => {
      return setDesktopPetWindowMouseInteractive(Boolean(interactive));
    },
    scheduleStatusRefresh: (delayMs: number) => {
      scheduleAgentPlatformPetStatusRefresh(delayMs);
    },
    refreshState: () => {
      return refreshDesktopPetState();
    }
  }));
  registerSettingsIpcHandlers(ipcMain, createSettingsIpcHandlerOptions(context, {
    getDataRoot,
    resetRuntimeEnv: resetBundledRuntimeEnv,
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    getAppInfo: () => desktopAppInfo,
    buildApplicationMenu,
    refreshTrayContextMenu: () => appTrayController.refreshContextMenu(),
    emitLocaleChanged,
    createAppPairingPayload,
    onGeneralSettingsChanged: () => assistantRunWakeLock.sync(),
    getDesktopWsServerRuntimeState: getDesktopWsServerRuntimeStateForSettings,
    startDesktopWsServer: startDesktopWsServerForSettings,
    stopDesktopWsServer: stopDesktopWsServerForSettings
  }));
}

if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, commandLine) => {
    if (hasInstallerShutdownArg(commandLine)) {
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
      startupEnvImportFailureMessage = startupRuntimeReady.message || DEFAULT_ENV_IMPORT_REQUIRED_MESSAGE;
      startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
    }

    initializeUserDataRootsAndSettings();
    ensureDataRoot(app);
    configurePluginBridge({
      getServiceState: (serviceId) => getServiceState(app, serviceId),
      notifyAgentPlatformConfigChanged: () => notifyServicesChanged(),
      runDesktopPetBanner: (params) => showDesktopPetBanner(app, params as any),
      showSystemUpdateOverlay: (params) => showSystemUpdateOverlay(params as any),
      getAssistantActiveTasks: () => getAssistantActiveTasksSnapshotForPlugins(),
      updateDesktopActivityIsland: (params) => updateDesktopActivityIsland(params as any),
      hideDesktopActivityIsland: () => hideDesktopActivityIsland(),
      readDesktopClipboardText: () => getDesktopClipboardTextForPlugin(),
      writeDesktopClipboardText: (params) => writeDesktopClipboardTextForPlugin(params),
      registerDesktopClipboardShortcut: (pluginId, params) =>
        registerDesktopClipboardShortcutForPlugin(pluginId, params),
      unregisterDesktopClipboardShortcut: (pluginId) =>
        unregisterDesktopClipboardShortcutForPlugin(pluginId),
      showDesktopClipboardPalette: (pluginId, params) =>
        showDesktopClipboardPaletteForPlugin(pluginId, params),
      hideDesktopClipboardPalette: (pluginId) =>
        hideDesktopClipboardPaletteForPlugin(pluginId),
      cleanupPluginBridgePlugin
    });
    configurePluginResources({ callAgentPlatform });
    registerIpcHandlers(mainProcessContext);
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
    setPluginBridgeDesktopReady();

    void handleStartupPipeline();

    app.on("activate", () => {
      if (nativeDialogController.isOpen()) {
        return;
      }
      showMainWindow();
    });
  });
}

async function handleStartupPipeline() {
  try {
    if (startupEnvImportFailureMessage !== null) {
      startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
      notifyServicesChanged();
      return;
    }
    loadBuiltinServices(app);
    loadInstalledPlugins(app);
    notifyServicesChanged();

    void runServiceMutation(() => runStartupPreparation(app, {
      onModeResolved: (mode) => {
        startupRestoreController.beginSession(mode);
      },
      onStarting: (serviceId) => {
        startupRestoreController.updateService(serviceId, "starting", "启动中...");
      },
      onProgress: (serviceId, phase, message) => {
        startupRestoreController.updateService(serviceId, phase, message);
        notifyServicesChanged();
      }
    }))
      .then((result) => {
        startupRestoreController.finishSession(result.mode, result.failures);
        notifyServicesChanged();
        if (result.failures.length > 0) {
          console.error("failed to prepare startup services", result.failures);
        }
      })
      .catch((error) => {
        startupRestoreController.failCurrentSession(error instanceof Error ? error.message : String(error));
        console.error("failed to prepare startup services", error);
      });
  } catch (error) {
    console.error("Failed in startup pipeline", error);
  }
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
        message: DEFAULT_ENV_IMPORT_REQUIRED_MESSAGE
      };
    }

    startupRestoreController.beginSession("bootstrap");
    startupRestoreController.updateService("zenmind-app-server", "installing", "正在导入内置 env.zip...");
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
      message: `内置 env.zip 导入失败：${message}`
    };
  }
}

function runShutdownCleanup(): Promise<void> {
  if (appState.shutdownCleanupPromise) {
    return appState.shutdownCleanupPromise;
  }
  const shutdownStartedAt = Date.now();
  const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(app);
  appState.shutdownCleanupPromise = runWithShutdownDeadline(
    () => stopAllStaticSiteHosts()
      .catch((error) => {
        console.error("failed while shutting down static site hosts", error);
      })
      .then(() => stopAllWebapps(app))
      .catch((error) => {
        console.error("failed while shutting down webapps", error);
      })
      .then(() => stopRunningServicesForShutdown(app))
      .catch((error) => {
        console.error("failed while shutting down desktop services", error);
      })
      .then(async () => {
        const cleanupStartedAt = Date.now();
        await forceCleanupManagedProcesses(app, processCleanupSnapshot);
        console.log(`[main] desktop service force cleanup finished in ${Date.now() - cleanupStartedAt}ms`);
      })
      .catch((error) => {
        console.error("failed while force-cleaning desktop service processes", error);
      }),
    { timeoutMs: SHUTDOWN_CLEANUP_DEADLINE_MS }
  )
    .then(() => undefined)
    .finally(() => {
      appState.shutdownCleanupComplete = true;
      console.log(`[main] app shutdown cleanup finished in ${Date.now() - shutdownStartedAt}ms`);
    });
  return appState.shutdownCleanupPromise;
}

function hasInstallerShutdownArg(commandLine: string[]) {
  return commandLine.some((arg) => INSTALLER_SHUTDOWN_ARGS.has(arg));
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
  emitPluginBridgeHook("desktop.beforeQuit", {});
  prepareQuitUi();
  hideWindowsForShutdown(appState);
  void runShutdownCleanup().finally(() => {
    beginAppQuitWithoutConfirmation();
  });
});

app.on("will-quit", () => {
  assistantRunWakeLock.release();
  clearDesktopPetIdleResetTimer();
  void cdpIntegration.stop();
  void stopDesktopWsServer();
  appState.taskBoardRuntime?.stop();
  appState.taskBoardRuntime = null;
  appState.assistantNavigationStatusClient?.stop();
  appState.assistantNavigationStatusClient = null;
  stopAgentPlatformPetStatusClient();
  unregisterQuickCopilotShortcut({
    platform: mainProcessContext.platform,
    globalShortcut
  });
  unregisterPluginGlobalShortcuts(globalShortcut);
  globalShortcut.unregister(FOCUSED_WEBVIEW_DEVTOOLS_SHORTCUT);
  hideDesktopActivityIsland();
  hideDesktopClipboardPalette();
  stopPluginBridgeServers();
});

app.on("window-all-closed", () => {
  if (mainProcessContext.platform !== "darwin" && appState.isHandlingQuit) {
    app.quit();
  }
});
