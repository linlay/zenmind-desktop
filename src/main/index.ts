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
  nativeTheme,
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
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import {
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoCookieLogin,
  failDesktopSsoFlow,
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
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
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
import { AgentPlatformMonitorWindowController } from "./app-shell/agent-platform-monitor-window";
import { DebugViewerWindowController } from "./app-shell/debug-viewer-window";
import { LogViewerWindowController } from "./app-shell/log-viewer-window";
import { NativeDialogVisibilityController } from "./app-shell/native-dialogs";
import { AppTrayController } from "./app-shell/tray";
import {
  addCustomSidebarItem,
  exportCustomSidebarItems,
  importCustomSidebarItems,
  listCustomSidebarItems,
  removeCustomSidebarItem,
  updateCustomSidebarItem
} from "./navigation/custom-sidebar-store";
import {
  createTaskBoardIssue,
  listTaskBoardIssues,
  moveTaskBoardIssue,
  updateTaskBoardIssue
} from "./task-board-store";
import {
  deleteTaskBoardIssueWithAutomation,
  syncTaskBoardIssueAutomation,
  syncTaskBoardIssueFromAssistantEvent
} from "./task-board-sync";
import {
  getAgentPlatformMinimaxSettingsPublic,
  loadAgentPlatformMinimaxSettings
} from "./copilot/core/agent-platform-config";
import {
  getAssistantSettings,
  readAssistantSettings,
  saveAssistantSettings
} from "./copilot/core/settings-store";
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
  DebugEvent,
  DesktopPetAgentOption,
  DesktopPetSettingsInput,
  RendererDiagnosticReport,
  AssistantPastedImageInput,
  AssistantWorkerOpenRequest,
  CustomSidebarItemInput,
  CustomSidebarUpdateInput,
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
  desktopDataRootExists,
  ensureDataRoot,
  getDataRoot,
  getElectronUserDataRoot
} from "./user-paths";
import {
  homeZenmindEnvExists,
  importEnvZipToZenmind,
  resolveHomeZenmindRoot,
  shouldRequireEnvZipImport
} from "./env-bootstrap";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { safeConsoleError } from "./safe-console";
import { callAgentPlatform, handleDesktopActionRequest, startDesktopActionBridge } from "./desktop-action-bridge";
import { callDesktopActionRenderer } from "./desktop-action-renderer";
import { DESKTOP_ACTION_DEFINITIONS } from "../shared/desktop-actions";
import { AgentPlatformPetStatusClient } from "./copilot/pet-copilot/pet-status-client";
import { AgentPlatformPetStreamClient } from "./copilot/pet-copilot/pet-stream-client";
import { createDesktopPetBrowserWindow } from "./copilot/pet-copilot/window";
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
import { registerAgentPlatformIpcHandlers } from "./ipc/agent-platform-handlers";
import { registerServicesIpcHandlers } from "./ipc/services-handlers";
import { registerTaskBoardIpcHandlers } from "./ipc/task-board-handlers";
import { registerSsoIpcHandlers } from "./ipc/sso-handlers";
import { registerSettingsIpcHandlers } from "./ipc/settings-handlers";
import { registerMarketplaceIpcHandlers } from "./ipc/marketplace-handlers";
import { registerDebugIpcHandlers } from "./ipc/debug-handlers";
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
  type ScreenshotCaptureSource
} from "./copilot/sidebar-copilot/screenshot";
import { getMainLocaleSettings, initializeMainI18n, setMainLocale, t } from "./i18n/main-i18n";
import { isSupportedLocale } from "../shared/i18n";
import { createStartupRestoreController, STARTUP_RESTORE_SERVICE_ORDER } from "./startup-restore";
import { createDebugEventStore } from "./debug/debug-events";
import { WebviewDebugManager } from "./debug/webview-debug-manager";
import {
  applyPlatformAppInit,
  getArchiveExtensions,
  isDevToolsShortcut
} from "./platform-adapter";
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
const ASSISTANT_TARGET_PATH = "/service/agent-webclient";
const LOG_VIEWER_ROUTE = "/log-viewer";
const DEBUG_VIEWER_SHORTCUT = "CommandOrControl+Shift+D";
const SHUTDOWN_CLEANUP_DEADLINE_MS = 10_000;
const ZENMIND_APP_ID = "cc.zenmind.desktop";
const ZENMIND_PRODUCT_NAME = "ZenMind";
const INSTALLER_SHUTDOWN_ARG = "--zenmind-shutdown-for-update";
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

const startupRestoreController = createStartupRestoreController({
  onChange: (state) => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed()) {
      return;
    }
    appState.mainWindow.webContents.send("services.startupRestoreState", state);
  }
});
const browserSurfaceRegistry = createBrowserSurfaceRegistry({
  webContents,
  listCustomSidebarItems: () => listCustomSidebarItems(app),
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
  version: `ZenMind/${app.getVersion()} Electron/${process.versions.electron}`
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
app.setName(ZENMIND_PRODUCT_NAME);
const isFirstDesktopInstall = !desktopDataRootExists(app);
const initialLocaleSettings = initializeMainI18n(app, { isFirstInstall: isFirstDesktopInstall });
if (isFirstDesktopInstall) {
  setMainLocale(app, initialLocaleSettings.locale);
}
const homeZenmindRootAtProcessStart = resolveHomeZenmindRoot(app, mainProcessContext.platform);
const requireEnvZipImportAtStartup = shouldRequireEnvZipImport({
  platform: mainProcessContext.platform,
  homeZenmindEnvExistedAtStartup: homeZenmindEnvExists(app, mainProcessContext.platform)
});
const electronUserDataRoot = getElectronUserDataRoot(app);
fs.mkdirSync(electronUserDataRoot, { recursive: true });
app.setPath("userData", electronUserDataRoot);
applyPlatformAppInit(mainProcessContext.platform, app, ZENMIND_APP_ID);

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
  agentOptions: appState.desktopPetAgentOptions
});
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
  getServiceState,
  issueAccessToken: issueAgentAccessToken,
  getSettings: () => appState.desktopPetSettings,
  saveSettings: (settings) => {
    appState.desktopPetSettings = saveDesktopPetSettings(app, settings, mainProcessContext.platform);
  },
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

if (process.argv.includes(INSTALLER_SHUTDOWN_ARG)) {
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

const debugEventStore = createDebugEventStore({ maxEvents: 1000 });
const debugViewerWindowController = new DebugViewerWindowController({
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  platform: mainProcessContext.platform,
  getOwnerWindow: () => appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null,
  loadRendererRoute,
  onRendererError: safeConsoleError
});
const webviewDebugManager = new WebviewDebugManager({
  store: debugEventStore,
  emitEvent: emitDebugEvent,
  onError: safeConsoleError
});

const nativeDialogController = new NativeDialogVisibilityController({
  platform: mainProcessContext.platform,
  getTargetWindows: () => [appState.mainWindow, quickCopilotWindowController.getWindow()],
  hideQuickCopilot: hideQuickAssistantForNativeDialog,
  restoreQuickCopilot: restoreQuickAssistantAfterNativeDialog
});

const appTrayController = new AppTrayController({
  platform: mainProcessContext.platform,
  appName: ZENMIND_PRODUCT_NAME,
  t,
  mainDir: __dirname,
  resourcesPath: process.resourcesPath,
  getDesktopPetEnabled: () => appState.desktopPetSettings.enabled,
  isDesktopPetSupported: () => isDesktopPetSupportedPlatform(mainProcessContext.platform),
  openAssistantChat: () => {
    void openAssistantWorker({
      displayName: "ZenMind",
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
  openBrowserUrl
});

async function handleDesktopSsoWebviewNavigation(url: string) {
  try {
    const status = getDesktopSsoStatus(app);
    if (appState.desktopSsoWebviewCompletionInFlight || !status.pending || !isDesktopSsoLoginCompletionUrl(app, url)) {
      return;
    }
    appState.desktopSsoWebviewCompletionInFlight = true;
    await desktopSsoController.syncBrowserCookies();
    const accessToken = await desktopSsoController.exchangeBrowserCookieAccessToken();
    if (accessToken) {
      completeDesktopSsoCookieLogin(app, accessToken);
      return;
    }
    completeDesktopSsoBrowserLogin(app, url);
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
    return listTaskBoardIssues(app).issues
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

function getDesktopPetAgentStatusForState() {
  return desktopPetDonePreviewDismissalTracker.filterAgentStatus(appState.desktopPetAgentStatus);
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
  const refresh = computeDesktopPetStateRefresh({
    settings: appState.desktopPetSettings,
    supported: isDesktopPetSupportedPlatform(mainProcessContext.platform),
    visible,
    localStatus: appState.desktopPetLocalStatus,
    patch,
    agentStatus: getDesktopPetAgentStatusForState(),
    agentOptions: appState.desktopPetAgentOptions,
    previewPanel: desktopPetPreviewController.getPanel(),
    runningTaskCount: getDesktopPetRunningTaskCountForState(),
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
      unreadCount: refresh.settingsPatch.unreadCount,
      lastVisible: refresh.settingsPatch.lastVisible
    }, mainProcessContext.platform);
  }
  for (const targetWindow of [appState.mainWindow, appState.desktopPetWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("desktopPet.state", appState.desktopPetState);
  }
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
  const failures = await runServiceMutation(() => ensureAssistantTargetServicesRunning(source));
  if (failures.length > 0) {
    showMainWindow("/control-center");
    return {
      ok: false,
      message: `智能助理服务恢复失败：${failures.join("，")}`,
      window: appState.mainWindow && !appState.mainWindow.isDestroyed() ? appState.mainWindow : null
    };
  }

  showMainWindow(targetPath);
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
    const serviceState = await getServiceState(app, "agent-platform");
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
    message: targetWindow ? "ZenMind 已打开。" : "ZenMind 主窗口不可用。"
  };
}

function requestDesktopPetDance() {
  if (!appState.desktopPetWindow || appState.desktopPetWindow.isDestroyed()) {
    return { ok: false };
  }
  appState.desktopPetWindow.webContents.send("desktopPet.danceRequested");
  return { ok: true };
}

function buildDesktopPetContextMenu() {
  const template = getDesktopPetContextMenuItems(appState.desktopPetSettings.appearanceId)
    .map((item): MenuItemConstructorOptions => ({
      label: item.label,
      click: () => {
        if (item.action === "dance") {
          requestDesktopPetDance();
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

function emitDebugEvent(event: DebugEvent) {
  const targetWindow = debugViewerWindowController.getWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.webContents.send("debug.event", event);
}

async function openDebugViewerWindow() {
  return debugViewerWindowController.open();
}

function closeDebugViewerWindow() {
  return debugViewerWindowController.close();
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

function registerQuickAssistantShortcut() {
  registerQuickCopilotShortcut({
    platform: mainProcessContext.platform,
    globalShortcut,
    controller: quickCopilotWindowController
  });
}

function registerDebugViewerShortcut() {
  const registered = globalShortcut.register(DEBUG_VIEWER_SHORTCUT, () => {
    void openDebugViewerWindow();
  });
  if (!registered) {
    console.warn(`failed to register debug viewer shortcut: ${DEBUG_VIEWER_SHORTCUT}`);
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
  targetWindow.webContents.on("did-attach-webview", (_event, contents) => {
    webviewDebugManager.attachWebContents(contents);
  });

  void loadMainWindowRenderer(targetWindow, {
    mode: process.env.VITE_DEV_SERVER_URL ? "dev" : "file",
    rendererEntry: getRendererEntry(),
    quit: () => app.quit(),
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

function ensureDarwinDockIdentity() {
  if (mainProcessContext.platform !== "darwin") {
    return;
  }

  app.setActivationPolicy("regular");
  const dock = app.dock;
  if (!dock) {
    return;
  }

  void dock.show().catch((error) => {
    safeConsoleError("failed to show macOS dock icon", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function notifyServicesChanged() {
  scheduleAgentPlatformPetStatusRefresh(1000);
  appState.assistantNavigationStatusClient?.scheduleRefresh(1000);
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("services.changed");
  }
}

function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
  for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
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
  const surface = surfaces.find((candidate) => browserSurfaceRegistry.customSidebarItemMatchesSurfaceTarget(candidate, target));
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

  navigateMainWindow(`/custom-sidebar/${surface.id}`);
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
    openSettings: () => navigateMainWindow("/settings")
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

async function ensureFirstInstallEnvZipImported() {
  if (!requireEnvZipImportAtStartup) {
    return true;
  }

  while (true) {
    const choice = await nativeDialogController.showMessageBox({
      type: "warning",
      title: "首次安装需要导入 env.zip",
      message: "检测到 ~/.zenmind 环境未初始化，请先导入 env.zip。",
      detail: `Target directory: ${homeZenmindRootAtProcessStart}\nImport only fills missing files and does not overwrite existing content.`,
      buttons: ["选择 env.zip", "退出 ZenMind"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (choice.response !== 0) {
      return false;
    }

    const result = await showFileDialog({
      title: "选择 env.zip",
      properties: ["openFile"],
      filters: [{ name: "env.zip", extensions: ["zip"] }]
    }, null);

    if (result.canceled || result.filePaths.length === 0) {
      const retryChoice = await nativeDialogController.showMessageBox({
        type: "warning",
        title: "未导入 env.zip",
        message: "首次安装必须导入 env.zip 后才能继续。",
        buttons: ["重新选择", "退出 ZenMind"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (retryChoice.response === 0) {
        continue;
      }
      return false;
    }

    try {
      const importResult = await importEnvZipToZenmind(app, result.filePaths[0], mainProcessContext.platform);
      console.info(
        `[main] imported env.zip into ${importResult.targetRoot}: copied=${importResult.copiedFiles}, skipped=${importResult.skippedFiles}`
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryChoice = await nativeDialogController.showMessageBox({
        type: "error",
        title: "env.zip 导入失败",
        message,
        buttons: ["重新选择", "退出 ZenMind"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (retryChoice.response !== 0) {
        return false;
      }
    }
  }
}

async function pickAssistantAttachments(chatId: string | null | undefined, ownerWindow: BrowserWindow | null) {
  const result = await showFileDialog({
    title: "选择要给 ZenMind 读取的附件",
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

function showArchiveDialog(title: string) {
  return showFileDialog({
    title,
    properties: ["openFile"],
    filters: [{ name: "Archive", extensions: getArchiveExtensions(mainProcessContext.platform) }]
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
  webviewDebugManager.start();
  webviewDebugManager.attachSession(session.defaultSession);
  const assistantBridge = new AgentPlatformAssistantBridge({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onEvent: (event) => {
      syncTaskBoardIssueFromAssistantEvent(app, event);
      for (const targetWindow of [appState.mainWindow, quickCopilotWindowController.getWindow()]) {
        if (!targetWindow || targetWindow.isDestroyed()) {
          continue;
        }
        targetWindow.webContents.send("assistant.event", event);
      }
      handleDesktopPetAssistantEvent(event);
    }
  });
  state.assistantNavigationStatusClient = new AssistantNavigationStatusClient({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onSnapshot: emitAssistantNavigationAgentsChanged,
    onPushEvent: (event) => syncTaskBoardIssueFromAssistantEvent(app, event),
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

  registerShellIpcHandlers(ipcMain, createShellIpcHandlerOptions(context, {
    showFileDialog,
    revealPathInFileManager,
    reportRendererDiagnostic
  }));
  registerDebugIpcHandlers(ipcMain, {
    openViewer: openDebugViewerWindow,
    closeViewer: closeDebugViewerWindow,
    debugEventStore,
    webviewDebugManager,
    webContents
  });

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

  registerAgentPlatformIpcHandlers(ipcMain, {
    app,
    callAgentPlatform
  });

  registerQuickCopilotIpcHandlers(ipcMain, quickCopilotWindowController);

  registerServicesIpcHandlers(ipcMain, createServicesIpcHandlerOptions(context, {
    listServices,
    getServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation,
    handleServiceStart,
    showFileDialog,
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
    importEnvZipToZenmind,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged,
    runStartupPreparation
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
    importPanPrivateKey
  }));
  registerSsoIpcHandlers(ipcMain, createSsoIpcHandlerOptions(context, {
    desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    issueAgentAccessToken
  }));
  registerTaskBoardIpcHandlers(ipcMain, createTaskBoardIpcHandlerOptions(context, {
    listTaskBoardIssues,
    createTaskBoardIssue,
    updateTaskBoardIssue,
    deleteTaskBoardIssueWithAutomation,
    moveTaskBoardIssue,
    syncTaskBoardIssueAutomation,
    callAgentPlatform,
    listCustomSidebarItems,
    addCustomSidebarItem,
    updateCustomSidebarItem,
    removeCustomSidebarItem,
    importCustomSidebarItems,
    exportCustomSidebarItems,
    showFileDialog,
    showSaveDialog,
    getDataRoot
  }));
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
    initializeMainI18n,
    isSupportedLocale,
    setMainLocale,
    buildApplicationMenu,
    refreshTrayContextMenu: () => appTrayController.refreshContextMenu(),
    emitLocaleChanged
  }));
}

if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, commandLine) => {
    if (hasInstallerShutdownArg(commandLine)) {
      requestAppQuit();
      return;
    }
    showMainWindow();
  });

  app.whenReady().then(() => {
    ensureDarwinDockIdentity();
    ensureDataRoot(app);
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
    registerDebugViewerShortcut();

    if (appState.mainWindow) {
      let pipelineStarted = false;
      const startPipeline = () => {
        if (pipelineStarted) return;
        pipelineStarted = true;
        void handleStartupPipeline();
      };
      appState.mainWindow.once("ready-to-show", startPipeline);
      // Fallback timeout to ensure startup progress starts even if ready-to-show is delayed or skipped
      setTimeout(startPipeline, 1000);
    } else {
      void handleStartupPipeline();
    }

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
    if (requireEnvZipImportAtStartup) {
      startupRestoreController.setEnvImportRequired();
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

function runShutdownCleanup(): Promise<void> {
  if (appState.shutdownCleanupPromise) {
    return appState.shutdownCleanupPromise;
  }
  const shutdownStartedAt = Date.now();
  const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(app);
  appState.shutdownCleanupPromise = runWithShutdownDeadline(
    () => stopRunningServicesForShutdown(app)
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
  return commandLine.includes(INSTALLER_SHUTDOWN_ARG);
}

function prepareQuitUi() {
  prepareQuitUiFromCleanup({
    getAllWindows: () => BrowserWindow.getAllWindows(),
    destroyTray: () => appTrayController.destroy()
  });
}

function requestAppQuit() {
  appState.isHandlingQuit = true;
  prepareQuitUi();
  app.quit();
}

app.on("before-quit", (event) => {
  if (appState.shutdownCleanupComplete) {
    return;
  }
  event.preventDefault();
  appState.isHandlingQuit = true;
  prepareQuitUi();
  hideWindowsForShutdown(appState);
  void runShutdownCleanup().finally(() => {
    app.quit();
  });
});

app.on("will-quit", () => {
  clearDesktopPetIdleResetTimer();
  void cdpIntegration.stop();
  appState.assistantNavigationStatusClient?.stop();
  appState.assistantNavigationStatusClient = null;
  stopAgentPlatformPetStatusClient();
  unregisterQuickCopilotShortcut({
    platform: mainProcessContext.platform,
    globalShortcut
  });
  globalShortcut.unregister(DEBUG_VIEWER_SHORTCUT);
  webviewDebugManager.stop();
});

app.on("window-all-closed", () => {
  if (mainProcessContext.platform !== "darwin" && appState.isHandlingQuit) {
    app.quit();
  }
});
