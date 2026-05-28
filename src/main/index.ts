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
  type CookiesSetDetails,
  type MediaAccessPermissionRequest,
  type MenuItemConstructorOptions,
  type Rectangle,
  type Session,
  type WebContents,
  type WebFrameMain
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import {
  failDesktopSsoFlow,
  getDesktopSsoCookieMirrorOrigins,
  getDesktopSsoStatus,
  getDesktopSsoProxyBrowserCookieDetails,
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
import { LogViewerWindowController } from "./app-shell/log-viewer-window";
import { NativeDialogVisibilityController } from "./app-shell/native-dialogs";
import { AppTrayController } from "./app-shell/tray";
import {
  EmbeddedCdpGateway,
  type EmbeddedCdpCommandRequest,
  type EmbeddedCdpSurface
} from "./embedded-cdp-gateway";
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
  deleteTaskBoardIssue,
  listTaskBoardIssues,
  moveTaskBoardIssue,
  updateTaskBoardIssue,
  updateTaskBoardIssueByChatId,
  updateTaskBoardIssueByRunId
} from "./task-board-store";
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
  AssistantNavActionResult,
  AssistantNavAgentItemsResult,
  AssistantSettingsInput,
  AssistantStartRunRequest,
  AssistantSubmitAwaitingRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse,
  DesktopPageContextSnapshot,
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
  ServiceState,
  SandboxImageImportProgressEvent,
  StartupRestoreMode,
  StartupRestoreServiceState,
  StartupRestoreState,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueUpdateInput,
  TaskBoardStatus
} from "../shared/contracts";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
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
import { DESKTOP_ACTION_DEFINITIONS } from "../shared/desktop-actions";
import { AgentPlatformPetStatusClient } from "./copilot/pet-copilot/pet-status-client";
import { AgentPlatformPetStreamClient } from "./copilot/pet-copilot/pet-stream-client";
import {
  applyDesktopPetActiveRunEvent,
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
  resolveDesktopPetRunningTaskCount,
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
  isQuickAssistantMediaPermissionAllowed,
} from "./copilot/quick-copilot/quick-copilot";
import { QuickCopilotWindowController } from "./copilot/quick-copilot/window";
import { registerQuickCopilotIpcHandlers } from "./copilot/quick-copilot/ipc";
import {
  registerQuickCopilotShortcut,
  unregisterQuickCopilotShortcut
} from "./copilot/quick-copilot/shortcut";
import {
  captureAssistantScreenshot as captureCopilotScreenshot,
  type ScreenshotCaptureSource
} from "./copilot/sidebar-copilot/screenshot";
import { initializeMainI18n, setMainLocale, t } from "./i18n/main-i18n";
import { isSupportedLocale } from "../shared/i18n";

let mainWindow: BrowserWindow | null = null;
let desktopPetWindow: BrowserWindow | null = null;
let isHandlingQuit = false;
let shutdownCleanupPromise: Promise<void> | null = null;
let shutdownCleanupComplete = false;
let pendingMainWindowCloseCancel: (() => void) | null = null;
let serviceMutationQueue = Promise.resolve();
let mainWindowSidebarTranslucencyEnabled = true;
const desktopActionRendererRequests = new Map<string, {
  resolve: (response: DesktopActionRendererResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
const ASSISTANT_TARGET_PATH = "/service/agent-webclient";
const LOG_VIEWER_ROUTE = "/log-viewer";
const QUICK_AGENT_WEBCLIENT_PATHNAMES = new Set(["/copilot"]);
const QUICK_AGENT_OPEN_RETRY_COUNT = 24;
const QUICK_AGENT_OPEN_RETRY_MS = 180;
const DESKTOP_ACTION_RENDERER_TIMEOUT_MS = 8_000;
const DESKTOP_PET_DRAG_FORCE_END_MS = 4_000;
const STARTUP_RESTORE_SERVICE_ORDER = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const MAC_FULLSCREEN_CLOSE_DELAY_MS = 500;
const MAC_FULLSCREEN_CLOSE_FALLBACK_MS = 2200;
const ZENMIND_APP_ID = "cc.zenmind.desktop";
const ZENMIND_PRODUCT_NAME = "ZenMind";
const DESKTOP_SSO_WEBVIEW_PARTITION = "persist:zenmind-desktop-sso";
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

type BrowserSurface = {
  id: string;
  label: string;
  url: string;
  kind?: "webview";
  active?: boolean;
  title?: string;
  currentUrl?: string;
  webContentsId?: number;
  agentKey?: string;
  surfaceRoute?: string;
  embedPath?: string;
};
let startupRestoreState = createStartupRestoreState();
let embeddedCdpGateway: EmbeddedCdpGateway | null = null;
let currentPageSnapshot: DesktopPageContextSnapshot | null = null;

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
const homeZenmindRootAtProcessStart = resolveHomeZenmindRoot(app, process.platform);
const requireEnvZipImportAtStartup = shouldRequireEnvZipImport({
  platform: process.platform,
  homeZenmindEnvExistedAtStartup: homeZenmindEnvExists(app, process.platform)
});
const electronUserDataRoot = getElectronUserDataRoot(app);
fs.mkdirSync(electronUserDataRoot, { recursive: true });
app.setPath("userData", electronUserDataRoot);
if (process.platform === "win32") {
  app.setAppUserModelId(ZENMIND_APP_ID);
}

let desktopPetSettings = readDesktopPetStoredState(app, process.platform, { isFirstInstall: isFirstDesktopInstall });
if (isFirstDesktopInstall) {
  desktopPetSettings = saveDesktopPetSettings(app, desktopPetSettings, process.platform);
}
let desktopPetLocalStatus: DesktopPetLocalStatus = createDefaultDesktopPetLocalStatus(desktopPetSettings);
let desktopPetAgentStatus: DesktopPetBoundAgentStatus | null = null;
let desktopPetAgentOptions: DesktopPetAgentOption[] = [];
let desktopPetState = createDesktopPetState(desktopPetSettings, {
  supported: isDesktopPetSupportedPlatform(process.platform),
  visible: false,
  localStatus: desktopPetLocalStatus,
  agentStatus: desktopPetAgentStatus,
  agentOptions: desktopPetAgentOptions
});
let desktopPetIdleResetTimer: ReturnType<typeof setTimeout> | null = null;
let desktopPetDragTimer: ReturnType<typeof setInterval> | null = null;
let desktopPetDragState: {
  startPoint: { x: number; y: number };
  lastPoint: { x: number; y: number };
  moved: boolean;
  startedAt: number;
} | null = null;
let agentPlatformPetStatusClient: AgentPlatformPetStatusClient | null = null;
let agentPlatformPetStreamClient: AgentPlatformPetStreamClient | null = null;
let assistantNavigationStatusClient: AssistantNavigationStatusClient | null = null;
const desktopPetPreviewProjector = new DesktopPetPreviewProjector();
let desktopPetPreviewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let dismissedDesktopPetDonePreview: { chatId: string; runId: string } | null = null;
let desktopPetPendingProgrammaticBoundsSignature: string | null = null;
let desktopPetProgrammaticBoundsGuardTimer: ReturnType<typeof setTimeout> | null = null;
let desktopPetMouseInteractive = true;
let desktopPetActiveRunIds = new Set<string>();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRendererEntry() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return devServerUrl;
  }
  return path.join(__dirname, "..", "..", "dist-renderer", "index.html");
}

function getRendererRouteUrl(routePath: string) {
  const rendererEntry = getRendererEntry();
  if (process.env.VITE_DEV_SERVER_URL) {
    return `${rendererEntry.replace(/\/$/u, "")}/#${routePath}`;
  }
  return rendererEntry;
}

function loadRendererRoute(targetWindow: BrowserWindow, routePath: string) {
  const rendererEntry = getRendererEntry();
  if (process.env.VITE_DEV_SERVER_URL) {
    return targetWindow.loadURL(getRendererRouteUrl(routePath));
  }
  return targetWindow.loadFile(rendererEntry, { hash: routePath });
}

const quickCopilotWindowController = new QuickCopilotWindowController({
  app,
  platform: () => process.platform,
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  loadRendererRoute,
  prepareServices: () => runServiceMutation(() => ensureAssistantTargetServicesRunning("quick-assistant")),
  showControlCenter: () => showMainWindow("/control-center"),
  openAgent: scheduleQuickAgentOpenRequest
});

const logViewerWindowController = new LogViewerWindowController({
  preloadPath: path.join(__dirname, "..", "preload", "index.js"),
  routePath: LOG_VIEWER_ROUTE,
  platform: process.platform,
  getOwnerWindow: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
  loadRendererRoute,
  onRendererError: safeConsoleError
});

const nativeDialogController = new NativeDialogVisibilityController({
  platform: process.platform,
  getTargetWindows: () => [mainWindow, quickCopilotWindowController.getWindow()],
  hideQuickCopilot: hideQuickAssistantForNativeDialog,
  restoreQuickCopilot: restoreQuickAssistantAfterNativeDialog
});

const appTrayController = new AppTrayController({
  platform: process.platform,
  appName: ZENMIND_PRODUCT_NAME,
  t,
  mainDir: __dirname,
  resourcesPath: process.resourcesPath,
  getDesktopPetEnabled: () => desktopPetSettings.enabled,
  isDesktopPetSupported: () => isDesktopPetSupportedPlatform(process.platform),
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
  quit: () => app.quit()
});

function clearDesktopPetIdleResetTimer() {
  if (desktopPetIdleResetTimer) {
    clearTimeout(desktopPetIdleResetTimer);
    desktopPetIdleResetTimer = null;
  }
}

function clearDesktopPetPreviewRefreshTimer() {
  if (desktopPetPreviewRefreshTimer) {
    clearTimeout(desktopPetPreviewRefreshTimer);
    desktopPetPreviewRefreshTimer = null;
  }
}

function rememberDismissedDesktopPetDonePreview() {
  const panel = desktopPetPreviewProjector.getPanel();
  const chatId = panel?.chatId || desktopPetAgentStatus?.chatId || "";
  if (panel?.status !== "done" || !chatId) {
    return;
  }
  dismissedDesktopPetDonePreview = {
    chatId,
    runId: panel.runId
  };
}

function clearDismissedDesktopPetDonePreview(chatId?: string | null, runId?: string | null) {
  if (!dismissedDesktopPetDonePreview) {
    return;
  }
  if (
    !chatId ||
    dismissedDesktopPetDonePreview.chatId === chatId ||
    (runId && dismissedDesktopPetDonePreview.runId === runId)
  ) {
    dismissedDesktopPetDonePreview = null;
  }
}

function isDismissedDesktopPetDoneChat(chatId: string | null | undefined) {
  return Boolean(chatId && dismissedDesktopPetDonePreview?.chatId === chatId);
}

function isDismissedDesktopPetDoneEvent(event: ReturnType<typeof normalizeDesktopPetAgentEvent>) {
  if (!event || (event.type !== "run.complete" && event.type !== "done")) {
    return false;
  }
  if (!dismissedDesktopPetDonePreview || dismissedDesktopPetDonePreview.chatId !== event.chatId) {
    return false;
  }
  return !event.runId || dismissedDesktopPetDonePreview.runId === event.runId;
}

function updateDesktopPetActiveRuns(event: { type?: unknown; runId?: unknown; data?: unknown } | null | undefined) {
  const result = applyDesktopPetActiveRunEvent(desktopPetActiveRunIds, event);
  if (!result.changed) {
    return false;
  }
  desktopPetActiveRunIds = result.activeRunIds;
  refreshDesktopPetState();
  return true;
}

function clearDesktopPetActiveRuns() {
  if (desktopPetActiveRunIds.size === 0) {
    return false;
  }
  desktopPetActiveRunIds = new Set();
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
  const fallbackRunning = desktopPetLocalStatus.status === "running" ||
    desktopPetLocalStatus.status === "awaiting" ||
    desktopPetAgentStatus?.presence === "busy" ||
    Boolean(desktopPetAgentStatus?.hasPendingAwaiting);
  return resolveDesktopPetRunningTaskCount({
    activeRunIds: desktopPetActiveRunIds,
    taskBoardRunIds: getTaskBoardActiveRunIdsForDesktopPet(),
    fallbackRunning
  });
}

function getDesktopPetAgentStatusForState() {
  if (
    !desktopPetAgentStatus ||
    desktopPetAgentStatus.presence !== "away" ||
    !isDismissedDesktopPetDoneChat(desktopPetAgentStatus.chatId)
  ) {
    return desktopPetAgentStatus;
  }
  return {
    ...desktopPetAgentStatus,
    presence: "available" as const,
    latestPreview: "",
    unreadCount: 0
  };
}

function getDesktopPetWindowMode(): DesktopPetWindowMode {
  if (desktopPetDragState) {
    return "base";
  }
  const panel = desktopPetPreviewProjector.getPanel();
  if (!panel?.visible) {
    const messagePreview = typeof desktopPetState.messagePreview === "string"
      ? desktopPetState.messagePreview.trim()
      : "";
    const hint = typeof desktopPetState.hint === "string"
      ? desktopPetState.hint.trim()
      : "";
    const shouldShowBubble = desktopPetState.status === "idle"
      ? messagePreview.length > 0 || desktopPetState.unreadCount > 0
      : hint.length > 0 ||
        desktopPetState.status === "running" ||
        desktopPetState.status === "awaiting" ||
        desktopPetState.status === "done" ||
        desktopPetState.status === "error";
    return shouldShowBubble ? "bubble" : "base";
  }
  return panel.expanded ? "preview-expanded" : "preview-collapsed";
}

function getDesktopPetVisible() {
  return Boolean(
    desktopPetSettings.enabled &&
    desktopPetWindow &&
    !desktopPetWindow.isDestroyed() &&
    desktopPetWindow.isVisible()
  );
}

function ensureAgentPlatformPetStatusClient() {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return null;
  }
  if (agentPlatformPetStatusClient) {
    return agentPlatformPetStatusClient;
  }
  agentPlatformPetStatusClient = new AgentPlatformPetStatusClient({
    app,
    getBoundAgentKey: () => desktopPetSettings.boundAgentKey,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onStatus: (status) => {
      desktopPetAgentStatus = status;
      if (!status) {
        clearDesktopPetActiveRuns();
      }
      if (refreshCompletedDesktopPetPreviewFromAgentStatus(status)) {
        return;
      }
      refreshDesktopPetState();
    },
    onAgents: (agents) => {
      desktopPetAgentOptions = agents;
      refreshDesktopPetState();
    },
    onBoundAgentKeyResolved: (resolvedKey, previousKey) => {
      if (resolvedKey === previousKey || resolvedKey === desktopPetSettings.boundAgentKey) {
        return;
      }
      desktopPetSettings = saveDesktopPetSettings(app, {
        boundAgentKey: resolvedKey
      }, process.platform);
      refreshDesktopPetState();
    },
    onRunStarted: ({ runId, chatId }) => {
      // AgentPlatformPetStatusClient already filters this callback to the bound agent.
      updateDesktopPetActiveRuns({ type: "run.started", runId });
      clearDismissedDesktopPetDonePreview(chatId, runId);
      ensureAgentPlatformPetStreamClient()?.attach(runId, chatId);
    },
    onRunFinished: ({ runId, chatId, message }) => {
      updateDesktopPetActiveRuns({ type: "run.finished", runId });
      const panel = desktopPetPreviewProjector.getPanel();
      const resolvedRunId = runId || (panel && (!chatId || panel.chatId === chatId) ? panel.runId : "");
      if (!resolvedRunId) {
        return;
      }
      ingestDesktopPetAgentEvent({
        runId: resolvedRunId,
        chatId: chatId ?? panel?.chatId ?? null,
        type: "run.complete",
        createdAt: new Date().toISOString(),
        message
      }, {
        source: "agent-platform-status",
        transportMode: "ws"
      });
    },
    onDebug: (message) => {
      console.warn(`[desktop-pet] agent-platform status unavailable: ${message}`);
    }
  });
  return agentPlatformPetStatusClient;
}

function ensureAgentPlatformPetStreamClient() {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return null;
  }
  if (agentPlatformPetStreamClient) {
    return agentPlatformPetStreamClient;
  }
  agentPlatformPetStreamClient = new AgentPlatformPetStreamClient({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onEvent: (event) => {
      ingestDesktopPetAgentEvent(event, {
        source: "agent-platform-attach",
        transportMode: "sse"
      });
    },
    onDebug: (message) => {
      console.warn(`[desktop-pet] agent-platform stream unavailable: ${message}`);
    }
  });
  return agentPlatformPetStreamClient;
}

function startAgentPlatformPetStatusClient() {
  if (!desktopPetSettings.enabled) {
    return;
  }
  ensureAgentPlatformPetStatusClient()?.start();
}

function stopAgentPlatformPetStatusClient() {
  agentPlatformPetStatusClient?.stop();
  agentPlatformPetStatusClient = null;
  agentPlatformPetStreamClient?.stop();
  agentPlatformPetStreamClient = null;
  desktopPetAgentStatus = null;
  desktopPetAgentOptions = [];
  clearDesktopPetActiveRuns();
}

function scheduleAgentPlatformPetStatusRefresh(delayMs = 0, force = false) {
  if (!force && !desktopPetSettings.enabled) {
    return;
  }
  ensureAgentPlatformPetStatusClient()?.scheduleRefresh(delayMs);
}

function refreshDesktopPetState(patch: Partial<DesktopPetLocalStatus> = {}) {
  if (Object.keys(patch).length > 0) {
    desktopPetLocalStatus = {
      ...desktopPetLocalStatus,
      ...patch
    };
  }
  const visible = getDesktopPetVisible();
  desktopPetState = createDesktopPetState(desktopPetSettings, {
    supported: isDesktopPetSupportedPlatform(process.platform),
    visible,
    localStatus: desktopPetLocalStatus,
    agentStatus: getDesktopPetAgentStatusForState(),
    agentOptions: desktopPetAgentOptions,
    previewPanel: desktopPetPreviewProjector.getPanel(),
    runningTaskCount: getDesktopPetRunningTaskCountForState(),
    edgeDock: resolveDesktopPetEdgeDock(
      desktopPetSettings.position,
      getDesktopPetDisplayBounds(desktopPetSettings.position)
    )
  });
  applyDesktopPetWindowBounds();
  if (
    desktopPetSettings.unreadCount !== desktopPetState.unreadCount ||
    desktopPetSettings.lastVisible !== visible
  ) {
    desktopPetSettings = saveDesktopPetSettings(app, {
      unreadCount: desktopPetState.unreadCount,
      lastVisible: visible
    }, process.platform);
  }
  for (const targetWindow of [mainWindow, desktopPetWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("desktopPet.state", desktopPetState);
  }
  appTrayController.refreshContextMenu();
  return desktopPetState;
}

function scheduleDesktopPetIdleReset(timeoutMs = 4200, clearPreview = false) {
  clearDesktopPetIdleResetTimer();
  desktopPetIdleResetTimer = setTimeout(() => {
    if (clearPreview) {
      rememberDismissedDesktopPetDonePreview();
      desktopPetPreviewProjector.clear();
    }
    refreshDesktopPetState({
      status: "idle",
      hint: "",
      unreadCount: 0
    });
    desktopPetIdleResetTimer = null;
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
    desktopPetSettings.position,
    getDesktopPetDisplayBounds(desktopPetSettings.position),
    getDesktopPetWindowMode()
  );
}

function getDesktopPetBoundsSignature(bounds: Pick<Rectangle, "x" | "y" | "width" | "height">) {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

function clearDesktopPetProgrammaticBoundsGuard() {
  if (desktopPetProgrammaticBoundsGuardTimer) {
    clearTimeout(desktopPetProgrammaticBoundsGuardTimer);
    desktopPetProgrammaticBoundsGuardTimer = null;
  }
}

function armDesktopPetProgrammaticBoundsGuard(signature: string) {
  desktopPetPendingProgrammaticBoundsSignature = signature;
  clearDesktopPetProgrammaticBoundsGuard();
  desktopPetProgrammaticBoundsGuardTimer = setTimeout(() => {
    desktopPetPendingProgrammaticBoundsSignature = null;
    desktopPetProgrammaticBoundsGuardTimer = null;
  }, 180);
}

function applyDesktopPetWindowBounds() {
  if (!isDesktopPetSupportedPlatform(process.platform) || !desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return;
  }
  if (desktopPetDragState) {
    return;
  }
  const nextBounds = getDesktopPetBounds();
  const currentBounds = desktopPetWindow.getBounds();
  if (
    currentBounds.x === nextBounds.x &&
    currentBounds.y === nextBounds.y &&
    currentBounds.width === nextBounds.width &&
    currentBounds.height === nextBounds.height
  ) {
    desktopPetPendingProgrammaticBoundsSignature = null;
    clearDesktopPetProgrammaticBoundsGuard();
    return;
  }
  armDesktopPetProgrammaticBoundsGuard(getDesktopPetBoundsSignature(nextBounds));
  desktopPetWindow.setBounds(nextBounds, false);
}

function persistDesktopPetPosition(mode: DesktopPetWindowMode = getDesktopPetWindowMode()) {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return;
  }
  if (desktopPetDragState) {
    return;
  }
  const bounds = desktopPetWindow.getBounds();
  const boundsSignature = getDesktopPetBoundsSignature(bounds);
  if (desktopPetPendingProgrammaticBoundsSignature) {
    if (boundsSignature === desktopPetPendingProgrammaticBoundsSignature) {
      desktopPetPendingProgrammaticBoundsSignature = null;
      clearDesktopPetProgrammaticBoundsGuard();
    }
    return;
  }
  const logicalPosition = getDesktopPetLogicalPositionFromBounds(bounds, mode);
  const currentPosition = desktopPetSettings.position;
  if (currentPosition && currentPosition.x === logicalPosition.x && currentPosition.y === logicalPosition.y) {
    return;
  }
  desktopPetSettings = saveDesktopPetSettings(app, {
    position: logicalPosition
  }, process.platform);
  refreshDesktopPetState();
}

function moveDesktopPetWindowBy(delta: { x?: unknown; y?: unknown }) {
  if (!isDesktopPetSupportedPlatform(process.platform) || !desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return { ok: false };
  }
  const deltaX = Number(delta.x);
  const deltaY = Number(delta.y);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return { ok: false };
  }
  if (deltaX === 0 && deltaY === 0) {
    return { ok: true };
  }

  const currentBounds = desktopPetWindow.getBounds();
  const cursorPoint = screen.getCursorScreenPoint();
  const mode = getDesktopPetWindowMode();
  const size = getDesktopPetWindowSize(mode);
  const nextBounds = clampDesktopPetPosition({
    x: currentBounds.x + Math.round(deltaX),
    y: currentBounds.y + Math.round(deltaY)
  }, getDesktopPetPointDisplayBounds(cursorPoint), size, {
    allowVisibleEdgeDock: mode === "base"
  });
  desktopPetWindow.setBounds(nextBounds, false);
  desktopPetWindow.moveTop();
  return { ok: true };
}

function stickDesktopPetWindowToEdge(mode: DesktopPetWindowMode = getDesktopPetWindowMode()) {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return;
  }
  const currentBounds = desktopPetWindow.getBounds();
  const logicalPosition = getDesktopPetLogicalPositionFromBounds(currentBounds, mode);
  const displayBounds = getDesktopPetDisplayBounds(logicalPosition);
  const snappedBounds = clampDesktopPetPosition(logicalPosition, displayBounds, DESKTOP_PET_WINDOW_SIZE, {
    allowVisibleEdgeDock: true,
    stickToEdges: true
  });
  const snappedPosition = {
    x: snappedBounds.x,
    y: snappedBounds.y
  };
  const nextBounds = getAnchoredDesktopPetBounds(snappedPosition, displayBounds, mode);
  if (
    currentBounds.x === nextBounds.x &&
    currentBounds.y === nextBounds.y &&
    currentBounds.width === nextBounds.width &&
    currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopPetWindow.setBounds(nextBounds, false);
}

function clearDesktopPetDragTimer() {
  if (desktopPetDragTimer) {
    clearInterval(desktopPetDragTimer);
    desktopPetDragTimer = null;
  }
}

function prepareDesktopPetWindowForDrag(mode: DesktopPetWindowMode) {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed() || mode === "base") {
    return;
  }
  const currentBounds = desktopPetWindow.getBounds();
  const logicalPosition = getDesktopPetLogicalPositionFromBounds(currentBounds, mode);
  const displayBounds = getDesktopPetDisplayBounds(logicalPosition);
  const nextBounds = getAnchoredDesktopPetBounds(logicalPosition, displayBounds, "base");
  if (
    currentBounds.x === nextBounds.x &&
    currentBounds.y === nextBounds.y &&
    currentBounds.width === nextBounds.width &&
    currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopPetWindow.setBounds(nextBounds, false);
}

function beginDesktopPetWindowDrag(point: { x?: unknown; y?: unknown }) {
  if (!isDesktopPetSupportedPlatform(process.platform) || !desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return { ok: false };
  }
  const startX = Number(point.x);
  const startY = Number(point.y);
  const fallbackPoint = screen.getCursorScreenPoint();
  const startPoint = {
    x: Number.isFinite(startX) ? startX : fallbackPoint.x,
    y: Number.isFinite(startY) ? startY : fallbackPoint.y
  };
  const initialMode = getDesktopPetWindowMode();
  clearDesktopPetDragTimer();
  desktopPetDragState = {
    startPoint,
    lastPoint: startPoint,
    moved: false,
    startedAt: Date.now()
  };
  prepareDesktopPetWindowForDrag(initialMode);

  desktopPetDragTimer = setInterval(() => {
    if (!desktopPetDragState || !desktopPetWindow || desktopPetWindow.isDestroyed()) {
      clearDesktopPetDragTimer();
      return;
    }
    if (Date.now() - desktopPetDragState.startedAt > DESKTOP_PET_DRAG_FORCE_END_MS) {
      endDesktopPetWindowDrag();
      return;
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const totalDeltaX = cursorPoint.x - desktopPetDragState.startPoint.x;
    const totalDeltaY = cursorPoint.y - desktopPetDragState.startPoint.y;
    if (!desktopPetDragState.moved && Math.hypot(totalDeltaX, totalDeltaY) < 4) {
      return;
    }

    const deltaX = cursorPoint.x - desktopPetDragState.lastPoint.x;
    const deltaY = cursorPoint.y - desktopPetDragState.lastPoint.y;
    desktopPetDragState.moved = true;
    desktopPetDragState.lastPoint = cursorPoint;
    if (deltaX !== 0 || deltaY !== 0) {
      moveDesktopPetWindowBy({ x: deltaX, y: deltaY });
    }
  }, 16);

  return { ok: true };
}

function endDesktopPetWindowDrag() {
  const moved = Boolean(desktopPetDragState?.moved);
  desktopPetDragState = null;
  clearDesktopPetDragTimer();
  if (moved) {
    stickDesktopPetWindowToEdge("base");
    persistDesktopPetPosition("base");
  }
  return {
    ok: true,
    moved
  };
}

function hideDesktopPetWindow(disable = false) {
  endDesktopPetWindowDrag();
  setDesktopPetWindowMouseInteractive(false);
  if (disable && desktopPetSettings.enabled) {
    clearDesktopPetIdleResetTimer();
    clearDesktopPetPreviewRefreshTimer();
    desktopPetPreviewProjector.clear();
    desktopPetSettings = saveDesktopPetSettings(app, {
      enabled: false,
      lastVisible: false,
      unreadCount: 0
    }, process.platform);
    desktopPetLocalStatus = createDefaultDesktopPetLocalStatus({
      ...desktopPetSettings,
      unreadCount: 0
    });
    stopAgentPlatformPetStatusClient();
  }
  if (desktopPetWindow && !desktopPetWindow.isDestroyed() && desktopPetWindow.isVisible()) {
    desktopPetWindow.hide();
  }
  return refreshDesktopPetState({
    ...(disable ? { unreadCount: 0 } : {})
  });
}

function setDesktopPetWindowMouseInteractive(interactive: boolean) {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) {
    desktopPetMouseInteractive = true;
    return { ok: false };
  }
  if (desktopPetMouseInteractive === interactive) {
    return { ok: true };
  }
  desktopPetMouseInteractive = interactive;
  if (process.platform === "darwin") {
    desktopPetWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return { ok: true };
  }
  if (process.platform === "win32") {
    // Windows cannot forward mousemove events while ignored, so keep the pet window interactive there.
    desktopPetWindow.setIgnoreMouseEvents(false);
    return { ok: true };
  }
  desktopPetWindow.setIgnoreMouseEvents(false);
  return { ok: true };
}

function collectWebFrames(frame: WebFrameMain, frames: WebFrameMain[] = []) {
  frames.push(frame);
  for (const childFrame of frame.frames) {
    collectWebFrames(childFrame, frames);
  }
  return frames;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function parseSafeLoopbackWebUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return isLoopbackHostname(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

function createAgentWebclientRoute(request: {
  agentKey?: string | null;
  chatId?: string | null;
}) {
  const agentKey = request.agentKey?.trim() ?? "";
  if (!agentKey) {
    return ASSISTANT_TARGET_PATH;
  }

  const params = new URLSearchParams();
  const chatId = request.chatId?.trim() ?? "";
  if (chatId) {
    params.set("chatId", chatId);
  }
  const query = params.toString();
  return `/agent/${encodeURIComponent(agentKey)}${query ? `?${query}` : ""}`;
}

function isQuickAgentWebclientFrame(frame: WebFrameMain) {
  try {
    return QUICK_AGENT_WEBCLIENT_PATHNAMES.has(new URL(frame.url).pathname);
  } catch {
    return false;
  }
}

function createQuickAgentOpenScript(request: {
  agentKey: string;
  focusComposerOnComplete: boolean;
}) {
  const agentKey = request.agentKey.trim();
  if (!agentKey) {
    return "true;";
  }
  return [
    "window.dispatchEvent(new CustomEvent('agent:select-worker', {",
    `  detail: ${JSON.stringify({
      agentKey,
      focusComposerOnComplete: request.focusComposerOnComplete
    })}`,
    "}));",
    "true;"
  ].join("\n");
}

function dispatchQuickAgentOpenRequest(
  targetWindow: BrowserWindow,
  request: {
    agentKey: string;
    focusComposerOnComplete: boolean;
  }
) {
  const script = createQuickAgentOpenScript(request);
  const frames = collectWebFrames(targetWindow.webContents.mainFrame).filter(isQuickAgentWebclientFrame);
  let dispatched = false;
  for (const frame of frames) {
    dispatched = true;
    frame.executeJavaScript(script).catch((error) => {
      console.warn("[quick-assistant] failed to open agent webclient copilot", error);
    });
  }
  return dispatched;
}

function scheduleQuickAgentOpenRequest(
  targetWindow: BrowserWindow,
  request: {
    chatId: string;
    agentKey: string;
    focusComposerOnComplete: boolean;
  },
  attempt = 0
) {
  if (targetWindow.isDestroyed()) {
    return;
  }
  if (dispatchQuickAgentOpenRequest(targetWindow, request)) {
    return;
  }
  if (attempt >= QUICK_AGENT_OPEN_RETRY_COUNT) {
    console.warn("[quick-assistant] agent webclient copilot frame was not ready");
    return;
  }
  setTimeout(() => {
    scheduleQuickAgentOpenRequest(targetWindow, request, attempt + 1);
  }, QUICK_AGENT_OPEN_RETRY_MS);
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
      message: `智能助理服务恢复失败：${failures.join("；")}`,
      window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    };
  }

  showMainWindow(targetPath);
  return {
    ok: true,
    message: "智能助理已打开。",
    window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
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
    const fallbackUnreadCount = Math.max(0, (desktopPetAgentStatus?.unreadCount ?? 1) - 1);
    const unreadCount = Number.isFinite(rawUnreadCount) && rawUnreadCount >= 0
      ? Math.round(rawUnreadCount)
      : fallbackUnreadCount;

    if (!desktopPetAgentStatus || (agentKey && agentKey !== desktopPetAgentStatus.agentKey)) {
      return;
    }
    desktopPetAgentStatus = {
      ...desktopPetAgentStatus,
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
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return {
    ok: Boolean(targetWindow),
    message: targetWindow ? "ZenMind 已打开。" : "ZenMind 主窗口不可用。"
  };
}

function requestDesktopPetDance() {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) {
    return { ok: false };
  }
  desktopPetWindow.webContents.send("desktopPet.danceRequested");
  return { ok: true };
}

function buildDesktopPetContextMenu() {
  const template = getDesktopPetContextMenuItems(desktopPetSettings.appearanceId)
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
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return null;
  }
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) {
    return desktopPetWindow;
  }
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  desktopPetWindow = new BrowserWindow({
    ...getDesktopPetBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: "ZenMind Desktop Xianzun",
    backgroundColor: "#00000000",
    ...(isWindows ? { thickFrame: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false
    }
  });

  if (isMac) {
    desktopPetWindow.setAlwaysOnTop(true, "floating");
    desktopPetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else if (isWindows) {
    desktopPetWindow.setAlwaysOnTop(true);
  }
  setDesktopPetWindowMouseInteractive(false);
  desktopPetWindow.on("move", () => persistDesktopPetPosition());
  desktopPetWindow.on("show", () => {
    setDesktopPetWindowMouseInteractive(false);
    refreshDesktopPetState();
  });
  desktopPetWindow.on("hide", () => {
    setDesktopPetWindowMouseInteractive(false);
    refreshDesktopPetState();
  });
  desktopPetWindow.on("close", (event) => {
    if (isHandlingQuit) {
      return;
    }
    event.preventDefault();
    hideDesktopPetWindow(true);
  });
  desktopPetWindow.on("closed", () => {
    endDesktopPetWindowDrag();
    desktopPetWindow = null;
    desktopPetMouseInteractive = true;
    refreshDesktopPetState();
  });
  desktopPetWindow.webContents.on("context-menu", (_event, params) => {
    endDesktopPetWindowDrag();
    if (!desktopPetWindow || desktopPetWindow.isDestroyed()) {
      return;
    }
    buildDesktopPetContextMenu().popup({
      window: desktopPetWindow,
      x: params.x,
      y: params.y
    });
  });

  loadRendererRoute(desktopPetWindow, DESKTOP_PET_ROUTE).catch((error) => {
    console.error("failed to load desktop pet renderer", error);
  });
  return desktopPetWindow;
}

function showDesktopPetWindow() {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return refreshDesktopPetState();
  }
  desktopPetSettings = saveDesktopPetSettings(app, {
    enabled: true,
    lastVisible: true
  }, process.platform);
  startAgentPlatformPetStatusClient();
  const targetWindow = createDesktopPetWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return refreshDesktopPetState();
  }

  const bounds = getDesktopPetBounds();
  targetWindow.setBounds(bounds, true);
  targetWindow.showInactive();
  targetWindow.moveTop();
  return refreshDesktopPetState();
}

function getDesktopPetStatusPatchFromPreview(panel: ReturnType<DesktopPetPreviewProjector["getPanel"]>) {
  if (!panel) {
    return null;
  }
  if (panel.status === "waiting") {
    return {
      status: "awaiting" as const,
      hint: "思考中",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "done") {
    return {
      status: "done" as const,
      hint: panel.summary,
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "error") {
    return {
      status: "error" as const,
      hint: "出错了",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "stopped") {
    return {
      status: "idle" as const,
      hint: "",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  return {
    status: "running" as const,
    hint: "思考中",
    chatId: panel.chatId,
    unreadCount: 0
  };
}

function normalizeDesktopPetReplyPreview(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function getUsableDesktopPetReplyPreview(value: unknown) {
  const preview = normalizeDesktopPetReplyPreview(value);
  return preview && !DESKTOP_PET_GENERIC_DONE_PREVIEWS.has(preview) ? preview : "";
}

function refreshCompletedDesktopPetPreviewFromAgentStatus(status: DesktopPetBoundAgentStatus | null) {
  if (!status || status.stale || status.presence !== "away") {
    return false;
  }
  if (isDismissedDesktopPetDoneChat(status.chatId)) {
    return false;
  }
  const replyPreview = getUsableDesktopPetReplyPreview(status.latestPreview);
  if (!replyPreview) {
    return false;
  }
  const panel = desktopPetPreviewProjector.getPanel();
  if (!panel || panel.status !== "done") {
    return false;
  }
  if (panel.chatId && status.chatId && panel.chatId !== status.chatId) {
    return false;
  }
  if (
    normalizeDesktopPetReplyPreview(panel.title) === replyPreview &&
    normalizeDesktopPetReplyPreview(panel.summary) === replyPreview
  ) {
    return false;
  }

  ingestDesktopPetAgentEvent({
    runId: panel.runId,
    chatId: panel.chatId ?? status.chatId,
    type: "run.complete",
    createdAt: new Date().toISOString(),
    message: replyPreview
  }, {
    source: "agent-platform-status",
    transportMode: "snapshot"
  });
  return true;
}

function refreshDesktopPetPreviewThrottled() {
  if (desktopPetPreviewRefreshTimer) {
    return;
  }
  desktopPetPreviewRefreshTimer = setTimeout(() => {
    desktopPetPreviewRefreshTimer = null;
    const patch = getDesktopPetStatusPatchFromPreview(desktopPetPreviewProjector.getPanel());
    refreshDesktopPetState(patch ?? {});
  }, 120);
}

function ingestDesktopPetAgentEvent(event: unknown, meta: { source?: string; transportMode?: string } = {}) {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return;
  }
  const normalizedEvent = normalizeDesktopPetAgentEvent(event);
  if (normalizedEvent?.type === "request.query" || normalizedEvent?.type === "run.start") {
    clearDismissedDesktopPetDonePreview(normalizedEvent.chatId, normalizedEvent.runId);
  }
  updateDesktopPetActiveRuns(normalizedEvent);
  if (isDismissedDesktopPetDoneEvent(normalizedEvent)) {
    return;
  }
  const result = desktopPetPreviewProjector.ingest(normalizedEvent ?? event, meta);
  if (!result.changed) {
    return;
  }

  if (result.holdMs) {
    scheduleDesktopPetIdleReset(result.holdMs, true);
  } else {
    clearDesktopPetIdleResetTimer();
  }

  if (result.refresh === "throttled") {
    refreshDesktopPetPreviewThrottled();
    return;
  }

  clearDesktopPetPreviewRefreshTimer();
  const patch = getDesktopPetStatusPatchFromPreview(result.panel);
  refreshDesktopPetState(patch ?? {});
}

function dismissDesktopPetPreview() {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
    return { ok: false };
  }
  clearDesktopPetIdleResetTimer();
  clearDesktopPetPreviewRefreshTimer();
  rememberDismissedDesktopPetDonePreview();
  desktopPetPreviewProjector.clear();
  refreshDesktopPetState({
    status: "idle",
    hint: "",
    unreadCount: 0,
    chatId: null
  });
  return { ok: true };
}

function handleDesktopPetAssistantEvent(event: AssistantEvent) {
  if (!isDesktopPetSupportedPlatform(process.platform)) {
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
    platform: process.platform,
    getMainWindow: () => mainWindow,
    getQuickCopilotWindow: () => quickCopilotWindowController.getWindow(),
    hideQuickCopilotDismissWindow: hideQuickAssistantDismissWindow,
    showQuickCopilotDismissWindow: showQuickAssistantDismissWindow,
    delay
  });
}

function registerQuickAssistantShortcut() {
  registerQuickCopilotShortcut({
    platform: process.platform,
    globalShortcut,
    controller: quickCopilotWindowController
  });
}

function applyMainWindowAppearance(targetWindow: BrowserWindow | null) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (process.platform === "darwin") {
    const useSidebarTranslucency =
      mainWindowSidebarTranslucencyEnabled && !targetWindow.isFullScreen();
    // Native macOS fullscreen can expose transparent window regions as desktop background.
    if (useSidebarTranslucency) {
      targetWindow.setVibrancy("under-window");
    } else {
      targetWindow.setVibrancy(null);
    }
    targetWindow.setBackgroundColor(useSidebarTranslucency ? "#00000000" : "#FFFFFF");
    return;
  }

  if (process.platform === "win32") {
    targetWindow.setBackgroundColor("#FFFFFF");
    return;
  }

  targetWindow.setBackgroundColor("#FFFFFF");
}

function setNativeThemeSource(themeMode: string) {
  nativeTheme.themeSource = themeMode === "dark" ? "dark" : "light";
  return {
    ok: true,
    themeSource: nativeTheme.themeSource
  };
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

function cancelPendingMainWindowClose() {
  pendingMainWindowCloseCancel?.();
  pendingMainWindowCloseCancel = null;
}

function hideMainWindowImmediately(targetWindow: BrowserWindow) {
  pendingMainWindowCloseCancel = null;
  if (targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.hide();
}

function hideDarwinMainWindowForClose(targetWindow: BrowserWindow) {
  if (!targetWindow.isFullScreen()) {
    hideMainWindowImmediately(targetWindow);
    return;
  }

  cancelPendingMainWindowClose();

  let completed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clearPendingClose = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    if (!targetWindow.isDestroyed()) {
      targetWindow.off("leave-full-screen", scheduleDestroy);
    }
    pendingMainWindowCloseCancel = null;
  };
  const scheduleTimer = (callback: () => void, timeoutMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, timeoutMs);
    timers.add(timer);
  };
  const destroyWindow = () => {
    if (completed) {
      return;
    }
    completed = true;
    clearPendingClose();
    targetWindow.destroy();
  };
  const scheduleDestroy = () => {
    scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_DELAY_MS);
  };

  pendingMainWindowCloseCancel = () => {
    if (completed) {
      return;
    }
    completed = true;
    clearPendingClose();
  };

  targetWindow.once("leave-full-screen", scheduleDestroy);
  scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_FALLBACK_MS);
  // macOS native fullscreen lives in its own Space; hiding there can leave a black Space behind.
  targetWindow.setFullScreen(false);
}

function hideWindowsMainWindowForClose(targetWindow: BrowserWindow) {
  if (targetWindow.isFullScreen()) {
    targetWindow.setFullScreen(false);
  }
  hideMainWindowImmediately(targetWindow);
}

function hideMainWindowForClose(targetWindow: BrowserWindow) {
  if (process.platform === "darwin") {
    hideDarwinMainWindowForClose(targetWindow);
    return;
  }

  if (process.platform === "win32") {
    hideWindowsMainWindowForClose(targetWindow);
    return;
  }

  hideMainWindowImmediately(targetWindow);
}

function shouldRecreateDarwinMainWindowForActivation(targetWindow: BrowserWindow) {
  if (process.platform !== "darwin") {
    return false;
  }
  return Boolean(pendingMainWindowCloseCancel) || targetWindow.isFullScreen();
}

function discardDarwinMainWindowForActivation(targetWindow: BrowserWindow) {
  cancelPendingMainWindowClose();
  if (!targetWindow.isDestroyed()) {
    targetWindow.destroy();
  }
  if (mainWindow === targetWindow) {
    mainWindow = null;
  }
}

function getMainWindowForActivation() {
  const existingWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!existingWindow) {
    return createWindow();
  }

  if (shouldRecreateDarwinMainWindowForActivation(existingWindow)) {
    discardDarwinMainWindowForActivation(existingWindow);
    return createWindow();
  }

  return existingWindow;
}

function normalizeMainWindowBeforeShow(targetWindow: BrowserWindow) {
  cancelPendingMainWindowClose();

  if (process.platform === "darwin") {
    return;
  }

  if (process.platform === "win32") {
    if (targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }
  }
}

function reportRendererDiagnostic(source: string, details: Record<string, unknown>) {
  safeConsoleError("[renderer-diagnostic]", {
    source,
    ...details
  });
}

function attachRendererDiagnostics(targetWindow: BrowserWindow) {
  if (process.platform === "darwin") {
    targetWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level < 2) {
        return;
      }
      reportRendererDiagnostic("console-message", {
        platform: "darwin",
        level,
        message,
        line,
        sourceId
      });
    });
    return;
  }

  if (process.platform === "win32") {
    targetWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level < 2) {
        return;
      }
      reportRendererDiagnostic("console-message", {
        platform: "win32",
        level,
        message,
        line,
        sourceId
      });
    });
    return;
  }

  targetWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2) {
      return;
    }
    reportRendererDiagnostic("console-message", {
      platform: process.platform,
      level,
      message,
      line,
      sourceId
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#FFFFFF",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  applyMainWindowAppearance(mainWindow);
  attachRendererDiagnostics(mainWindow);

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    safeConsoleError("renderer failed to load", {
      errorCode,
      errorDescription,
      validatedUrl
    });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    safeConsoleError("renderer process exited unexpectedly", details);
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    safeConsoleError("preload failed", {
      preloadPath,
      error: error?.stack || String(error)
    });
  });

  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const servicePreloadPath = getServiceWebviewPreloadPath();
    const servicePreloadUrl = getServiceWebviewPreloadUrl();
    const requestedPreload = String(webPreferences.preload || params.preload || "");
    const usesServicePreload = requestedPreload === servicePreloadPath || requestedPreload === servicePreloadUrl;

    if (requestedPreload && !usesServicePreload) {
      event.preventDefault();
      safeConsoleError("blocked unexpected webview preload", {
        preload: requestedPreload,
        src: params.src
      });
      return;
    }

    if (usesServicePreload && !parseSafeLoopbackWebUrl(String(params.src || ""))) {
      event.preventDefault();
      safeConsoleError("blocked service webview with unsafe url", {
        src: params.src
      });
      return;
    }

    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    if (usesServicePreload) {
      webPreferences.preload = servicePreloadPath;
    }
  });

  mainWindow.on("focus", () => {
    if (nativeDialogController.isOpen()) {
      return;
    }
    quickCopilotWindowController.hideAfterOutsideFocus();
  });

  mainWindow.on("enter-full-screen", () => {
    applyMainWindowAppearance(mainWindow);
  });

  mainWindow.on("leave-full-screen", () => {
    applyMainWindowAppearance(mainWindow);
  });

  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    const downloadFromWebview = (url: string) => {
      try {
        contents.downloadURL(url);
      } catch (error) {
        safeConsoleError("failed to start webview download", { url, error });
      }
    };

    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "i") {
        return;
      }

      const isMacDevToolsShortcut =
        process.platform === "darwin" && input.meta && input.alt && !input.control && !input.shift;
      const isDesktopDevToolsShortcut =
        process.platform !== "darwin" && input.control && input.shift && !input.meta && !input.alt;

      if (!isMacDevToolsShortcut && !isDesktopDevToolsShortcut) {
        return;
      }

      event.preventDefault();
      contents.openDevTools({ mode: "detach" });
    });

    contents.on("did-fail-load", (_guestEvent, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (errorCode === -3) {
        return;
      }
      void collectWebviewLoadDiagnostics(contents, validatedUrl)
        .then((diagnostics) => {
          safeConsoleError("webview failed to load", {
            errorCode,
            errorDescription,
            isMainFrame,
            ...diagnostics
          });
        })
        .catch((error) => {
          safeConsoleError("webview failed to load", {
            guestId: contents.id,
            errorCode,
            errorDescription,
            validatedUrl,
            isMainFrame,
            diagnosticsError: error instanceof Error ? error.message : String(error)
          });
      });
    });

    contents.on("will-navigate", (event, url) => {
      if (!shouldDownloadUrlFromWebview(url)) {
        return;
      }

      event.preventDefault();
      downloadFromWebview(url);
    });

    contents.on("render-process-gone", (_guestEvent, details) => {
      safeConsoleError("webview render process exited unexpectedly", {
        guestId: contents.id,
        details
      });
    });

    contents.setWindowOpenHandler(({ url }) => {
      const disposition = resolveWebviewOpenDisposition(url);
      if (disposition === "download") {
        downloadFromWebview(url);
        return { action: "deny" };
      }

      if (disposition === "tab") {
        setImmediate(() => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            void shell.openExternal(url).catch((error) => {
              safeConsoleError("failed to recover webview tab request externally", { url, error });
            });
            return;
          }

          mainWindow.webContents.send("webview.openTab", {
            sourceGuestId: contents.id,
            url
          });
        });
        return { action: "deny" };
      }

      void shell.openExternal(url).catch((error) => {
        safeConsoleError("failed to open external popup url", { url, error });
      });
      return { action: "deny" };
    });
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(getRendererEntry()).catch((error) => {
      console.error("failed to load dev renderer", error);
      app.quit();
    });
  } else {
    mainWindow.loadFile(getRendererEntry()).catch((error) => {
      console.error("failed to load renderer file", error);
      app.quit();
    });
  }

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "i") {
      return;
    }

    const isMacDevToolsShortcut =
      process.platform === "darwin" && input.meta && input.alt && !input.control && !input.shift;
    const isDesktopDevToolsShortcut =
      process.platform !== "darwin" && input.control && input.shift && !input.meta && !input.alt;

    if (!isMacDevToolsShortcut && !isDesktopDevToolsShortcut) {
      return;
    }

    event.preventDefault();
    mainWindow?.webContents.toggleDevTools();
  });

  mainWindow.on("close", (event) => {
    if (isHandlingQuit) {
      return;
    }
    event.preventDefault();
    const targetWindow = mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    hideMainWindowForClose(targetWindow);
  });

  mainWindow.on("closed", () => {
    cancelPendingMainWindowClose();
    mainWindow = null;
  });

  return mainWindow;
}

function getOrCreateMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return createWindow();
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaDetails = details as MediaAccessPermissionRequest;
    const mainContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
    const quickAssistantWindow = quickCopilotWindowController.getWindow();
    const quickContentsId = quickAssistantWindow && !quickAssistantWindow.isDestroyed()
      ? quickAssistantWindow.webContents.id
      : null;
    if (!isQuickAssistantMediaPermissionAllowed({
      permission,
      contentsId: contents.id,
      mainContentsId,
      quickContentsId,
      mediaTypes: mediaDetails.mediaTypes
    })) {
      callback(false);
      return;
    }

    if (process.platform === "darwin") {
      void systemPreferences.askForMediaAccess("microphone")
        .then((granted) => {
          callback(granted);
        })
        .catch(() => {
          callback(false);
        });
      return;
    }

    if (process.platform === "win32") {
      callback(true);
      return;
    }

    callback(true);
  });
}

function showMainWindow(targetPath?: string) {
  ensureDarwinDockIdentity();
  const targetWindow = getMainWindowForActivation();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  normalizeMainWindowBeforeShow(targetWindow);

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();

  if (targetPath) {
    navigateMainWindow(targetPath);
  }
}

function ensureDarwinDockIdentity() {
  if (process.platform !== "darwin") {
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
  assistantNavigationStatusClient?.scheduleRefresh(1000);
  for (const targetWindow of [mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("services.changed");
  }
}

function emitAssistantNavigationAgentsChanged(result: AssistantNavAgentItemsResult) {
  for (const targetWindow of [mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.navigationAgentsChanged", result);
  }
}

function workspaceNameFromPath(workspaceDir: string): string {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
}

function coderAgentKeyFromWorkspace(workspaceDir: string): string {
  const base = workspaceNameFromPath(workspaceDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `coder-${base || "project"}`;
}

function buildCoderProjectAgentCreateRequest(workspaceDir: string) {
  const key = coderAgentKeyFromWorkspace(workspaceDir);
  const name = key;
  return {
    key,
    definition: {
      key,
      name,
      mode: "CODER",
      workspace: {
        root: workspaceDir
      },
      runtimeConfig: {
        workspaceRoot: workspaceDir
      },
      visibility: {
        scopes: ["nav", "copilot"]
      }
    }
  };
}

function sanitizeDownloadFilename(filename: string, fallback: string) {
  const normalized = filename.trim() || fallback;
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").slice(0, 180) || fallback;
}

function getAssistantExportDefaultPath(filename: string) {
  const safeFilename = sanitizeDownloadFilename(filename, "chat-export.json");
  if (process.platform === "win32") {
    return path.join(app.getPath("downloads"), safeFilename);
  }
  if (process.platform === "darwin") {
    return path.join(app.getPath("downloads"), safeFilename);
  }
  return path.join(app.getPath("home"), safeFilename);
}

function getDesktopDownloadDefaultPath(filename: string) {
  const safeFilename = sanitizeDownloadFilename(filename, "download");
  if (process.platform === "win32") {
    return path.join(app.getPath("downloads"), safeFilename);
  }
  if (process.platform === "darwin") {
    return path.join(app.getPath("downloads"), safeFilename);
  }
  return path.join(app.getPath("home"), safeFilename);
}

async function getAvailableFilePath(targetPath: string) {
  const parsedPath = path.parse(targetPath);
  for (let index = 0; index < 1000; index += 1) {
    const candidatePath =
      index === 0
        ? targetPath
        : path.join(parsedPath.dir, `${parsedPath.name} (${index})${parsedPath.ext}`);
    try {
      await fs.promises.access(candidatePath, fs.constants.F_OK);
    } catch {
      return candidatePath;
    }
  }
  return path.join(parsedPath.dir, `${parsedPath.name}-${Date.now()}${parsedPath.ext}`);
}

function getSandboxImageExportDefaultPath(imageRef: string) {
  const safeFilename = sanitizeDownloadFilename(`${imageRef || "sandbox-image"}.tar`, "sandbox-image.tar");
  if (process.platform === "win32" || process.platform === "darwin") {
    return path.join(app.getPath("desktop"), safeFilename);
  }
  return path.join(app.getPath("home"), safeFilename);
}

async function saveAssistantChatExport(
  assistantBridge: AgentPlatformAssistantBridge,
  chatId: string
): Promise<AssistantNavActionResult> {
  const result = await assistantBridge.downloadChatExport(chatId);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const exportPath = await getAvailableFilePath(getAssistantExportDefaultPath(result.filename));
  await fs.promises.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.promises.writeFile(exportPath, result.bytes);
  return { ok: true, message: "已下载会话导出。", filePath: exportPath };
}

function createStartupRestoreState(
  phase: StartupRestoreState["phase"] = "idle",
  mode: StartupRestoreMode = "restore"
): StartupRestoreState {
  return {
    mode,
    phase,
    serviceOrder: [...STARTUP_RESTORE_SERVICE_ORDER],
    currentServiceId: null,
    failedServiceId: null,
    message: "",
    updatedAt: new Date().toISOString(),
    services: STARTUP_RESTORE_SERVICE_ORDER.map<StartupRestoreServiceState>((serviceId) => ({
      serviceId,
      phase: "pending"
    }))
  };
}

function cloneStartupRestoreState(state: StartupRestoreState) {
  return {
    ...state,
    serviceOrder: [...state.serviceOrder],
    services: state.services.map((service) => ({ ...service }))
  } satisfies StartupRestoreState;
}

function commitStartupRestoreState(nextState: StartupRestoreState) {
  startupRestoreState = {
    ...cloneStartupRestoreState(nextState),
    updatedAt: new Date().toISOString()
  };
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("services.startupRestoreState", cloneStartupRestoreState(startupRestoreState));
}

function beginStartupRestoreSession(mode: StartupRestoreMode) {
  commitStartupRestoreState(createStartupRestoreState("running", mode));
}

function updateStartupRestoreService(serviceId: ServiceId, phase: StartupRestoreServiceState["phase"], message = "") {
  const currentState = cloneStartupRestoreState(startupRestoreState);
  if (!currentState.serviceOrder.includes(serviceId)) {
    console.warn(`[startup] Ignoring non-core startup progress for ${serviceId}: ${phase}${message ? ` - ${message}` : ""}`);
    return;
  }

  const nextServices = currentState.services.map((service) =>
    service.serviceId === serviceId
      ? {
          ...service,
          phase,
          message
        }
      : service
  );

  if (phase === "installing" || phase === "initializing" || phase === "starting") {
    commitStartupRestoreState({
      ...currentState,
      phase: "running",
      currentServiceId: serviceId,
      message,
      services: nextServices
    });
    return;
  }

  const allCompleted = nextServices.every((service) =>
    service.phase === "succeeded" || service.phase === "skipped"
  );
  commitStartupRestoreState({
    ...currentState,
    phase: allCompleted ? "succeeded" : "running",
    currentServiceId: null,
    failedServiceId: phase === "failed" ? serviceId : currentState.failedServiceId,
    message: allCompleted ? "核心服务已全部就绪。" : message,
    services: nextServices
  });
}

function finishStartupRestoreSession(mode: StartupRestoreMode, failures: string[]) {
  const currentState = cloneStartupRestoreState(startupRestoreState);
  const failedServiceId = failures.length > 0
    ? currentState.services.find((service) => service.phase === "failed")?.serviceId ?? currentState.failedServiceId
    : null;
  commitStartupRestoreState({
    ...currentState,
    mode,
    phase: failures.length > 0 ? "failed" : "succeeded",
    currentServiceId: null,
    failedServiceId,
    message: failures.length > 0 ? failures.join("；") : "核心服务已全部就绪。"
  });
}

async function runServiceMutation<T>(task: () => Promise<T>) {
  const previousTask = serviceMutationQueue;
  let releaseQueue = () => {};
  serviceMutationQueue = new Promise<void>((resolve) => {
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

async function callDesktopActionRenderer(
  request: DesktopActionRendererRequest
): Promise<DesktopActionRendererResponse> {
  const targetWindow = mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
    return {
      requestId: request.requestId,
      action: request.action,
      ok: false,
      error: {
        code: "renderer_unavailable",
        message: "Desktop 主窗口不可用。"
      }
    };
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      desktopActionRendererRequests.delete(request.requestId);
      resolve({
        requestId: request.requestId,
        action: request.action,
        ok: false,
        error: {
          code: "renderer_timeout",
          message: "当前页面未及时响应 Desktop 动作请求。"
        }
      });
    }, DESKTOP_ACTION_RENDERER_TIMEOUT_MS);

    desktopActionRendererRequests.set(request.requestId, { resolve, timeout });
    targetWindow.webContents.send("desktopActions.call", request);
  });
}

function navigateMainWindow(targetPath: string) {
  const targetWindow = getMainWindowForActivation();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  normalizeMainWindowBeforeShow(targetWindow);

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();

  const sendNavigate = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("app.navigate", targetPath);
    }
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendNavigate);
    return;
  }

  sendNavigate();
}

function normalizeSurfaceMatchText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
}

function customSidebarItemMatchesSurfaceTarget(item: BrowserSurface, target: string) {
  const normalizedTarget = normalizeSurfaceMatchText(target);
  if (!normalizedTarget) {
    return false;
  }
  const candidates = [
    item.id,
    item.label,
    item.url,
    (() => {
      try {
        return new URL(item.url).hostname;
      } catch {
        return "";
      }
    })()
  ].map(normalizeSurfaceMatchText);

  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.includes(normalizedTarget) ||
    normalizedTarget.includes(candidate)
  );
}

function findWebContentsForSurfaceUrl(surfaceUrl: string) {
  let target: URL | null = null;
  try {
    target = new URL(surfaceUrl);
  } catch {
    return null;
  }

  return webContents.getAllWebContents().find((contents) => {
    if (contents.isDestroyed()) {
      return false;
    }
    if (contents.getType() !== "webview") {
      return false;
    }
    try {
      const current = new URL(contents.getURL());
      return (
        current.href === target.href ||
        current.hostname === target.hostname ||
        current.href.startsWith(target.href)
      );
    } catch {
      return false;
    }
  }) ?? null;
}

function currentPageSnapshotMatchesSurface(surfaceId: string, contents?: WebContents | null) {
  const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
  return currentPageSnapshot?.pageKind === "webview" && (
    currentPageSnapshot.surfaceId === surfaceId ||
    snapshotBrowserTarget?.surfaceId === surfaceId ||
    (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id)
  );
}

function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserSurface {
  return {
    id: BUILTIN_BROWSER_SURFACE_ID,
    label: BUILTIN_BROWSER_SURFACE_LABEL,
    url,
    active: currentPageSnapshotMatchesSurface(BUILTIN_BROWSER_SURFACE_ID, contents),
    currentUrl: contents?.getURL(),
    title: contents?.getTitle(),
    webContentsId: contents?.id
  };
}

function listBrowserSurfaces(): BrowserSurface[] {
  const builtinContents = findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
  return [
    builtinBrowserSurface(builtinContents),
    ...listCustomSidebarItems(app).items.map((item) => {
      const contents = findWebContentsForSurfaceUrl(item.url);
      return {
        id: item.id,
        label: item.label,
        url: item.url,
        active: currentPageSnapshotMatchesSurface(item.id, contents),
        currentUrl: contents?.getURL(),
        title: contents?.getTitle(),
        webContentsId: contents?.id
      };
    })
  ];
}

async function listEmbeddedCdpSurfaces(): Promise<EmbeddedCdpSurface[]> {
  const webviewSurfaces = listBrowserSurfaces().map((surface) => ({
    ...surface,
    kind: "webview" as const,
    agentKey: surface.agentKey || ""
  }));

  let serviceSurfaces: EmbeddedCdpSurface[] = [];
  try {
    const services = await listServices(app);
    const surfaces = await Promise.all(services.map(async (service): Promise<EmbeddedCdpSurface | null> => {
      const surface = createEmbeddedCdpServiceSurface(service);
      if (!surface) {
        return null;
      }
      return surface;
    }));
    serviceSurfaces = surfaces.filter((surface): surface is EmbeddedCdpSurface => surface !== null);
  } catch (error) {
    console.warn("[embedded-cdp] failed to list service webview targets", error);
  }

  return [...webviewSurfaces, ...serviceSurfaces];
}

function createEmbeddedCdpServiceSurface(service: ServiceState): EmbeddedCdpSurface | null {
  const webUrl = service.status === "running" ? service.healthMeta.webUrl.trim() : "";
  if (service.frontendMode === "none" || !webUrl || !parseSafeLoopbackWebUrl(webUrl)) {
    return null;
  }
  const contents = findWebContentsForSurfaceUrl(webUrl);
  const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
  const snapshotMatchesService = currentPageSnapshot?.pageKind === "webview" && (
    currentPageSnapshot.surfaceId === service.id ||
    snapshotBrowserTarget?.surfaceId === service.id ||
    (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id)
  );
  const surfaceRoute = snapshotMatchesService
    ? currentPageSnapshot?.surfaceRoute || snapshotBrowserTarget?.surfaceRoute || currentPageSnapshot?.route
    : "";
  const snapshotCurrentUrl = snapshotMatchesService && snapshotBrowserTarget?.kind === "webview"
    ? snapshotBrowserTarget.currentUrl
    : "";
  const documentTitle = snapshotMatchesService ? currentPageSnapshot?.pageContext?.title : "";
  return {
    id: service.id,
    label: service.name || service.id,
    url: webUrl,
    kind: "webview",
    active: snapshotMatchesService,
    currentUrl: snapshotCurrentUrl || contents?.getURL(),
    title: documentTitle || service.name || service.id,
    webContentsId: contents?.id,
    ...(surfaceRoute ? { surfaceRoute } : {}),
    ...(snapshotMatchesService && currentPageSnapshot?.embedPath ? { embedPath: currentPageSnapshot.embedPath } : {})
  };
}

function resolveEmbeddedCdpWebContents(surface: EmbeddedCdpSurface): WebContents | null {
  if (surface.webContentsId) {
    const contents = webContents.fromId(surface.webContentsId);
    if (contents && !contents.isDestroyed() && contents.getType() === "webview") {
      return contents;
    }
  }
  return findWebContentsForSurfaceUrl(surface.currentUrl || surface.url);
}

async function activateEmbeddedCdpSurface(surface: EmbeddedCdpSurface) {
  if (surface.id === BUILTIN_BROWSER_SURFACE_ID) {
    await openBrowserUrl({ url: surface.currentUrl || surface.url, label: surface.label });
    return;
  }
  try {
    const services = await listServices(app);
    if (services.some((service) => service.id === surface.id)) {
      const targetPath = surface.id === "agent-webclient" ? ASSISTANT_TARGET_PATH : `/service/${surface.id}`;
      showMainWindow(targetPath);
      await delay(450);
      return;
    }
  } catch {
    // Fall through to custom sidebar activation if service state is unavailable.
  }
  await activateBrowserSurface(surface.id || surface.url);
}

async function openEmbeddedCdpUrl(url: string) {
  await openBrowserUrl({ url });
}

function startEmbeddedCdpGateway() {
  if (embeddedCdpGateway) {
    return embeddedCdpGateway;
  }
  embeddedCdpGateway = new EmbeddedCdpGateway({
    getSurfaces: listEmbeddedCdpSurfaces,
    resolveWebContents: resolveEmbeddedCdpWebContents,
    activateSurface: activateEmbeddedCdpSurface,
    openUrl: openEmbeddedCdpUrl,
    version: `ZenMind/${app.getVersion()} Electron/${process.versions.electron}`
  });
  embeddedCdpGateway.start();
  return embeddedCdpGateway;
}

function broadcastDesktopSsoStatus(status: ReturnType<typeof getDesktopSsoStatus>) {
  mainWindow?.webContents.send("sso.statusChanged", status);
  if (status.authenticated) {
    focusMainWindowAfterDesktopSso();
  }
}

function focusMainWindowAfterDesktopSso() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
    mainWindow.focus();
    return;
  }
  if (process.platform === "win32") {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  mainWindow.focus();
}

function getDesktopSsoBrowserUserAgent() {
  const chromeVersion = process.versions.chrome || "120.0.0.0";
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Electron/${process.versions.electron} Safari/537.36`
      .replace(/\sElectron\/[^\s]+/u, "");
  }
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Electron/${process.versions.electron} Safari/537.36`
      .replace(/\sElectron\/[^\s]+/u, "");
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Electron/${process.versions.electron} Safari/537.36`
    .replace(/\sElectron\/[^\s]+/u, "");
}

function splitDesktopSsoSetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getDesktopSsoSetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoSetCookieHeader(setCookieHeader) : [];
}

function getDesktopSsoDefaultCookiePath(url: URL) {
  const pathname = url.pathname || "/";
  if (pathname === "/" || !pathname.startsWith("/")) {
    return "/";
  }
  const lastSlashIndex = pathname.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : pathname.slice(0, lastSlashIndex);
}

function toDesktopSsoSameSite(value: string): CookiesSetDetails["sameSite"] {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "none") {
    return "no_restriction";
  }
  if (normalizedValue === "strict") {
    return "strict";
  }
  if (normalizedValue === "lax") {
    return "lax";
  }
  return "unspecified";
}

function rewriteDesktopSsoUrlOrigin(value: string, browserOrigin?: string) {
  if (!browserOrigin) {
    return value;
  }
  const url = new URL(value);
  const originUrl = new URL(browserOrigin);
  if (!["http:", "https:"].includes(originUrl.protocol)) {
    return value;
  }
  url.protocol = originUrl.protocol;
  url.host = originUrl.host;
  return url.toString();
}

function parseDesktopSsoSetCookieHeader(header: string, responseUrl: string): CookiesSetDetails | null {
  const responseUrlObject = new URL(responseUrl);
  const [nameValuePair, ...attributes] = header.split(";");
  const separatorIndex = nameValuePair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const name = nameValuePair.slice(0, separatorIndex).trim();
  if (!name) {
    return null;
  }

  const details: CookiesSetDetails = {
    url: responseUrlObject.origin,
    name,
    value: nameValuePair.slice(separatorIndex + 1).trim(),
    path: getDesktopSsoDefaultCookiePath(responseUrlObject)
  };

  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }

    const attributeSeparatorIndex = attribute.indexOf("=");
    const attributeName = (attributeSeparatorIndex >= 0
      ? attribute.slice(0, attributeSeparatorIndex)
      : attribute).trim().toLowerCase();
    const attributeValue = attributeSeparatorIndex >= 0
      ? attribute.slice(attributeSeparatorIndex + 1).trim()
      : "";

    if (attributeName === "domain" && attributeValue) {
      details.domain = attributeValue;
    } else if (attributeName === "path" && attributeValue) {
      details.path = attributeValue;
    } else if (attributeName === "secure") {
      details.secure = true;
    } else if (attributeName === "httponly") {
      details.httpOnly = true;
    } else if (attributeName === "samesite" && attributeValue) {
      details.sameSite = toDesktopSsoSameSite(attributeValue);
    } else if (attributeName === "expires" && attributeValue) {
      const expiresAt = Date.parse(attributeValue);
      if (Number.isFinite(expiresAt)) {
        details.expirationDate = Math.floor(expiresAt / 1000);
      }
    } else if (attributeName === "max-age" && attributeValue) {
      const maxAgeSeconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(maxAgeSeconds)) {
        details.expirationDate = Math.floor(Date.now() / 1000) + maxAgeSeconds;
      }
    }
  }

  return details;
}

async function applyDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  setCookieHeaders: string[]
) {
  await Promise.all(setCookieHeaders.map(async (header) => {
    const cookieDetails = parseDesktopSsoSetCookieHeader(header, responseUrl);
    if (!cookieDetails) {
      return;
    }
    await ssoSession.cookies.set(cookieDetails);
  }));
}

async function buildDesktopSsoCookieHeader(ssoSession: Session, targetUrl: string) {
  const cookies = await ssoSession.cookies.get({ url: targetUrl });
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function mirrorDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  browserOrigin: string | undefined,
  setCookieHeaders: string[]
) {
  await applyDesktopSsoSetCookieHeaders(ssoSession, responseUrl, setCookieHeaders);
  const mirroredResponseUrl = rewriteDesktopSsoUrlOrigin(responseUrl, browserOrigin);
  if (mirroredResponseUrl !== responseUrl) {
    await applyDesktopSsoSetCookieHeaders(ssoSession, mirroredResponseUrl, setCookieHeaders);
  }
}

async function resolveDesktopSsoNavigationUrl(
  ssoSession: Session,
  targetUrl: string,
  browserOrigin?: string
) {
  try {
    const requestUrl = new URL(targetUrl);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, targetUrl);
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": getDesktopSsoBrowserUserAgent()
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await fetch(targetUrl, {
      redirect: "manual",
      headers
    });
    await mirrorDesktopSsoSetCookieHeaders(
      ssoSession,
      response.url || targetUrl,
      browserOrigin,
      getDesktopSsoSetCookieHeaders(response.headers)
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const resolvedLocation = new URL(location, requestUrl).toString();
        return rewriteDesktopSsoUrlOrigin(resolvedLocation, browserOrigin);
      }
    }
  } catch (error) {
    safeConsoleError("failed to resolve desktop sso navigation url", {
      url: targetUrl,
      error
    });
  }
  return rewriteDesktopSsoUrlOrigin(targetUrl, browserOrigin);
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
  mainWindow?.webContents.send("webview.openTab", {
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
    const contents = findWebContentsForSurfaceUrl(targetUrl);
    if (contents) {
      const surface = builtinBrowserSurface(contents, targetUrl);
      return {
        ok: true,
        action: "open_url",
        target: targetUrl,
        url: contents.getURL(),
        title: contents.getTitle(),
        message: `已打开「${input.label || BUILTIN_BROWSER_SURFACE_LABEL}」。`,
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
    message: `已尝试打开「${input.label || targetUrl}」，但没有拿到可操作的网页目标。`
  };
}

async function openDesktopSsoBrowserUrl(input: {
  url: string;
  label?: string;
  browserOrigin?: string;
  resolveRedirect?: boolean;
}) {
  const ssoSession = session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
  await ssoSession.setProxy({ proxyRules: "direct://" });
  return openBrowserUrl({
    ...input,
    url: input.resolveRedirect === false
      ? rewriteDesktopSsoUrlOrigin(input.url, input.browserOrigin)
      : await resolveDesktopSsoNavigationUrl(ssoSession, input.url, input.browserOrigin),
    requireOperableTarget: false,
    partition: DESKTOP_SSO_WEBVIEW_PARTITION,
    userAgent: getDesktopSsoBrowserUserAgent()
  });
}

async function syncDesktopSsoBrowserCookies() {
  const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
  const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(app);
  const ssoSession = session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
  const targetSessions = [
    session.defaultSession,
    ssoSession
  ];
  await Promise.all(cookieDetails.flatMap((details) =>
    targetSessions.map(async (targetSession) => {
      await targetSession.cookies.set(details);
    })
  ));
  await Promise.all(mirrorOrigins.map(async (origin) => {
    const cookies = await ssoSession.cookies.get({ url: origin });
    await Promise.all(cookies.map(async (cookie) => {
      await session.defaultSession.cookies.set({
        url: origin,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || undefined,
        path: cookie.path || "/",
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite
      });
    }));
  }));
}

async function clearDesktopSsoBrowserCookies() {
  const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
  const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(app);
  const targetSessions = [
    session.defaultSession,
    session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
  ];
  await Promise.all(cookieDetails.flatMap((details) =>
    targetSessions.map(async (targetSession) => {
      try {
        await targetSession.cookies.remove(details.url, details.name);
      } catch {
        // Cookie removal is best effort; local Desktop auth state is already cleared.
      }
    })
  ));
  await Promise.all(targetSessions.flatMap((targetSession) =>
    mirrorOrigins.map(async (origin) => {
      const cookies = await targetSession.cookies.get({ url: origin });
      await Promise.all(cookies.map(async (cookie) => {
        try {
          await targetSession.cookies.remove(origin, cookie.name);
        } catch {
          // Cookie removal is best effort; local Desktop auth state is already cleared.
        }
      }));
    })
  ));
}

async function activateBrowserSurface(target: string) {
  if (isBuiltinBrowserSurfaceTarget(target)) {
    return openBrowserUrl(resolveBuiltinBrowserUrl(target));
  }
  const surfaces = listBrowserSurfaces();
  const surface = surfaces.find((candidate) => customSidebarItemMatchesSurfaceTarget(candidate, target));
  if (!surface) {
    return {
      ok: false,
      action: "activate_surface",
      target,
      error: "surface_not_found",
      message: `没有找到匹配的内嵌网站：${target}`,
      data: {
        surfaces
      }
    };
  }

  navigateMainWindow(`/custom-sidebar/${surface.id}`);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(250);
    const contents = findWebContentsForSurfaceUrl(surface.url);
    if (contents) {
      const activatedSurface = {
        ...surface,
        active: true,
        currentUrl: contents.getURL(),
        title: contents.getTitle(),
        webContentsId: contents.id
      } satisfies BrowserSurface;
      return {
        ok: true,
        action: "activate_surface",
        target,
        url: activatedSurface.currentUrl,
        title: activatedSurface.title,
        message: `已打开「${activatedSurface.label}」。`,
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
    message: `已切换到「${surface.label}」，但还没有拿到可操作的网页实例。`,
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
  ownerWindow: BrowserWindow | null = mainWindow
) {
  return nativeDialogController.showFileDialog(options, ownerWindow);
}

async function showSaveDialog(
  options: Parameters<NativeDialogVisibilityController["showSaveDialog"]>[0],
  ownerWindow: BrowserWindow | null = mainWindow
) {
  return nativeDialogController.showSaveDialog(options, ownerWindow);
}

function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) {
  for (const targetWindow of [mainWindow, quickCopilotWindowController.getWindow()]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.attachmentProgress", progress);
  }
}

function buildApplicationMenu() {
  installApplicationMenu({
    appName: app.name,
    platform: process.platform,
    t,
    openSettings: () => navigateMainWindow("/settings")
  });
}

function emitLocaleChanged(settings: ReturnType<typeof setMainLocale>) {
  for (const targetWindow of [
    mainWindow,
    desktopPetWindow,
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
      detail: `目标目录：${homeZenmindRootAtProcessStart}\n导入时只补齐缺失文件，不覆盖已有内容。`,
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
      const importResult = await importEnvZipToZenmind(app, result.filePaths[0], process.platform);
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
  const isWindows = process.platform === "win32";
  return showFileDialog({
    title,
    properties: ["openFile"],
    filters: [{ name: "Archive", extensions: isWindows ? ["zip"] : ["gz", "tgz"] }]
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

    const confirmed = await showPortConflictDialog(mainWindow, conflict.port, conflict.processInfo);
    if (!confirmed) {
      throw error;
    }

    const killed = await killProcessByPid(conflict.processInfo.pid);
    if (!killed) {
      throw new Error(
        `无法终止占用端口 ${conflict.port} 的进程 ${conflict.processInfo.name} (PID ${conflict.processInfo.pid})。`
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

const logStreamSubscriptions = new Map<
  string,
  {
    webContentsId: number;
    cleanup: () => void;
  }
>();

type TaskBoardAssistantSyncEvent = {
  type?: string;
  status?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

function resolveTaskBoardStatusFromAssistantEvent(event: TaskBoardAssistantSyncEvent): TaskBoardStatus | null {
  if (event.type === "done" || event.type === "run.complete") {
    return "completed";
  }
  return null;
}

function isCancelledTaskBoardAssistantEvent(event: TaskBoardAssistantSyncEvent) {
  return (
    event.type === "run.cancel" ||
    event.type === "task.cancel" ||
    event.type === "stopped" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.status === "cancelled" ||
    event.status === "canceled" ||
    event.status === "stopped"
  );
}

function resolveTaskBoardRunStateFromAssistantEvent(event: TaskBoardAssistantSyncEvent): TaskBoardIssue["runState"] {
  const status = resolveTaskBoardStatusFromAssistantEvent(event);
  if (status === "completed") {
    return "completed";
  }
  if (isCancelledTaskBoardAssistantEvent(event)) {
    return "cancelled";
  }
  if (
    event.type === "error" ||
    event.type === "run.error" ||
    event.type === "run.expired" ||
    event.status === "error" ||
    event.status === "timeout"
  ) {
    return "failed";
  }
  return null;
}

function syncTaskBoardIssueFromAssistantEvent(event: TaskBoardAssistantSyncEvent) {
  const status = resolveTaskBoardStatusFromAssistantEvent(event);
  const runState = resolveTaskBoardRunStateFromAssistantEvent(event);
  if (!runState || (!event.runId && !event.chatId)) {
    return;
  }

  const input: TaskBoardIssueUpdateInput = {
    runId: null,
    runState
  };
  if (status) {
    input.status = status;
  }
  if (event.chatId) {
    input.chatId = event.chatId;
  }

  const runResult = event.runId ? updateTaskBoardIssueByRunId(app, event.runId, input) : null;
  if (runResult?.ok) {
    return;
  }

  const chatResult = event.chatId ? updateTaskBoardIssueByChatId(app, event.chatId, input) : null;
  if (chatResult?.ok) {
    return;
  }

  const result = chatResult ?? runResult;
  if (result && result.message !== "任务运行不存在。" && result.message !== "任务会话不存在。") {
    console.warn(`[task-board] failed to sync assistant run ${event.runId ?? event.chatId}: ${result.message}`);
  }
}

type TaskBoardAutomationDetail = {
  id?: string;
  scheduleId?: string;
};

function readPlatformAutomationId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as TaskBoardAutomationDetail;
  return typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : typeof record.scheduleId === "string" && record.scheduleId.trim()
      ? record.scheduleId.trim()
      : "";
}

function buildTaskBoardAutomationMessage(issue: TaskBoardIssue) {
  const message = issue.automationMessage?.trim() || issue.description.trim() || issue.title.trim();
  return [
    message,
    "",
    "关联 ZenMind 任务看板任务：",
    `任务编号：${issue.id}`,
    `标题：${issue.title}`
  ].join("\n");
}

function buildTaskBoardAutomationPayload(issue: TaskBoardIssue) {
  return {
    name: `任务看板 ${issue.id}: ${issue.title}`.slice(0, 120),
    description: `来自 ZenMind Desktop 任务看板：${issue.id}`,
    cron: issue.automationCron?.trim() ?? "",
    agentKey: issue.assigneeAgentKey?.trim() ?? "",
    enabled: true,
    zoneId: issue.automationTimezone?.trim() || "Asia/Shanghai",
    query: {
      message: buildTaskBoardAutomationMessage(issue),
      hidden: true,
      params: {
        source: "task-board",
        issueId: issue.id
      }
    }
  };
}

async function syncTaskBoardIssueAutomation(issueId: string) {
  const issue = listTaskBoardIssues(app).issues.find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (!issue) {
    return {
      ok: false,
      message: "任务不存在。",
      issues: listTaskBoardIssues(app).issues
    };
  }

  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await callAgentPlatform(app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    return updateTaskBoardIssue(app, issue.id, {
      automationId: null,
      automationEnabled: false
    });
  }

  if (!issue.assigneeAgentKey?.trim()) {
    return {
      ok: false,
      message: "请选择智能体后再启用定时任务。",
      issues: listTaskBoardIssues(app).issues
    };
  }
  if (!issue.automationCron?.trim()) {
    return {
      ok: false,
      message: "请设置自动化 cron。",
      issues: listTaskBoardIssues(app).issues
    };
  }
  if (!issue.automationMessage?.trim()) {
    return {
      ok: false,
      message: "请填写自动化要执行的内容。",
      issues: listTaskBoardIssues(app).issues
    };
  }

  const payload = buildTaskBoardAutomationPayload(issue);
  const detail = issue.automationId
    ? await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/automation/update", {
      method: "POST",
      body: { id: issue.automationId, ...payload }
    })
    : await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/automation/create", {
      method: "POST",
      body: payload
    });
  const automationId = readPlatformAutomationId(detail) || issue.automationId;
  if (!automationId) {
    return {
      ok: false,
      message: "agent-platform 未返回自动化 ID。",
      issues: listTaskBoardIssues(app).issues
    };
  }
  return updateTaskBoardIssue(app, issue.id, {
    automationId,
    automationEnabled: true
  });
}

async function deleteTaskBoardIssueWithAutomation(issueId: string) {
  const currentIssues = listTaskBoardIssues(app).issues;
  const issue = currentIssues.find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (issue?.automationId) {
    try {
      await callAgentPlatform(app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    } catch (error) {
      return {
        ok: false,
        message: `自动化删除失败：${error instanceof Error ? error.message : String(error)}`,
        issues: currentIssues
      };
    }
  }
  return deleteTaskBoardIssue(app, issueId);
}

function registerIpcHandlers() {
  const assistantBridge = new AgentPlatformAssistantBridge({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onEvent: (event) => {
      syncTaskBoardIssueFromAssistantEvent(event);
      for (const targetWindow of [mainWindow, quickCopilotWindowController.getWindow()]) {
        if (!targetWindow || targetWindow.isDestroyed()) {
          continue;
        }
        targetWindow.webContents.send("assistant.event", event);
      }
      handleDesktopPetAssistantEvent(event);
    }
  });
  assistantNavigationStatusClient = new AssistantNavigationStatusClient({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onSnapshot: emitAssistantNavigationAgentsChanged,
    onPushEvent: syncTaskBoardIssueFromAssistantEvent,
    onDebug: (message) => {
      console.warn(`[assistant-navigation] status unavailable: ${message}`);
    }
  });
  assistantNavigationStatusClient.start();

  startEmbeddedCdpGateway();
  const desktopActionOptions = {
    app,
    assistantBridge,
    getMainWindow: () => mainWindow,
    getCurrentPageSnapshot: () => currentPageSnapshot,
    navigate: showMainWindow,
    openLogViewer: openLogViewerWindow,
    callRendererAction: callDesktopActionRenderer,
    executeCdpCommand: async (request: EmbeddedCdpCommandRequest) => {
      const gateway = embeddedCdpGateway ?? startEmbeddedCdpGateway();
      if (!gateway) {
        throw new Error("Desktop CDP gateway is not available.");
      }
      return gateway.executeCommand(request);
    }
  };
  startDesktopActionBridge({
    ...desktopActionOptions
  });

  ipcMain.on("diagnostics.rendererError", (event, report: RendererDiagnosticReport) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    reportRendererDiagnostic("renderer-error", {
      windowId: ownerWindow?.id ?? null,
      route: event.sender.getURL(),
      source: typeof report?.source === "string" ? report.source : "unknown",
      message: typeof report?.message === "string" ? report.message : String(report),
      stack: typeof report?.stack === "string" ? report.stack : undefined,
      componentStack: typeof report?.componentStack === "string" ? report.componentStack : undefined,
      filename: typeof report?.filename === "string" ? report.filename : undefined,
      lineno: typeof report?.lineno === "number" ? report.lineno : undefined,
      colno: typeof report?.colno === "number" ? report.colno : undefined
    });
  });

  ipcMain.handle("shell.openExternal", async (_event, url: string) => {
    if (typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"))) {
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }
    return { ok: false, error: "invalid_protocol" };
  });
  ipcMain.handle("desktopDialog.selectDirectory", async (event) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const isMac = process.platform === "darwin";
      const isWindows = process.platform === "win32";
      let properties: Array<"openDirectory" | "createDirectory">;
      if (isMac) {
        properties = ["openDirectory", "createDirectory"];
      } else if (isWindows) {
        properties = ["openDirectory", "createDirectory"];
      } else {
        properties = ["openDirectory", "createDirectory"];
      }
      const result = await showFileDialog({
        title: "选择项目目录",
        properties
      }, ownerWindow);
      if (result.canceled || result.filePaths.length === 0) {
        return {
          ok: false as const,
          path: "",
          message: "已取消选择目录。"
        };
      }
      return {
        ok: true as const,
        path: result.filePaths[0],
        message: "已选择目录。"
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle("desktopShell.openPath", async (_event, targetPath: string) => {
    try {
      return await revealPathInFileManager(targetPath, { targetType: "directory" }, {
        showItemInFolder: (pathToReveal) => shell.showItemInFolder(pathToReveal),
        openPath: (pathToOpen) => shell.openPath(pathToOpen),
        platform: process.platform
      });
    } catch (error) {
      return {
        ok: false as const,
        path: typeof targetPath === "string" ? targetPath : "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle("desktopDownloads.saveFile", async (_event, input: unknown) => {
    try {
      const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      const dataBase64 = typeof payload.dataBase64 === "string" ? payload.dataBase64 : "";
      const downloadPath = await getAvailableFilePath(getDesktopDownloadDefaultPath(filename));
      await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
      await fs.promises.writeFile(downloadPath, Buffer.from(dataBase64, "base64"));
      return {
        ok: true as const,
        path: downloadPath,
        message: "已下载文件。"
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("assistant.getSettings", async () => getAgentPlatformMinimaxSettingsPublic(app) ?? getAssistantSettings(app));
  ipcMain.handle("assistant.saveSettings", async (_event, input: AssistantSettingsInput) =>
    saveAssistantSettings(app, input)
  );
  ipcMain.handle("assistant.getMemorySettings", async () => assistantBridge.getMemorySettings());
  ipcMain.handle("assistant.saveMemorySettings", async (_event, input) =>
    assistantBridge.saveMemorySettings(input)
  );
  ipcMain.handle("assistant.getMemorySummary", async () => assistantBridge.getMemorySummary());
  ipcMain.handle("assistant.listAgents", async () => {
    try {
      return await assistantBridge.listAgents();
    } catch (error) {
      console.warn("[assistant] failed to list agent-platform agents", error);
      return [];
    }
  });
  ipcMain.handle("assistant.listNavigationAgents", async (): Promise<AssistantNavAgentItemsResult> => {
    try {
      const cached = assistantNavigationStatusClient?.getSnapshot();
      if (cached?.ok) {
        return cached;
      }
      return await (assistantNavigationStatusClient?.refreshNow() ?? assistantBridge.listNavigationAgents());
    } catch (error) {
      console.warn("[assistant] failed to list navigation agents", error);
      return {
        ok: false,
        items: [],
        message: error instanceof Error ? error.message : "agent-platform 暂不可用。",
        updatedAt: new Date().toISOString()
      };
    }
  });
  ipcMain.handle("assistant.listCopilotAgents", async (): Promise<AssistantNavAgentItemsResult> => {
    try {
      return await assistantBridge.listCopilotAgents();
    } catch (error) {
      console.warn("[assistant] failed to list copilot agents", error);
      return {
        ok: false,
        items: [],
        message: error instanceof Error ? error.message : "agent-platform 暂不可用。",
        updatedAt: new Date().toISOString()
      };
    }
  });
  ipcMain.handle("assistant.createCoderProject", async (
    _event,
    input: AssistantCreateCoderProjectRequest
  ): Promise<AssistantCreateCoderProjectResult> => {
    const workspaceDir = String(input?.workspaceDir || "").trim();
    if (!workspaceDir) {
      return {
        ok: false,
        message: "缺少项目目录，无法创建 CODER 智能体。"
      };
    }
    const request = buildCoderProjectAgentCreateRequest(workspaceDir);
    try {
      const response = await callAgentPlatform<{ key?: string }>(app, "/api/agent/create", {
        method: "POST",
        body: request
      });
      const agentKey = String(response?.key || request.key).trim();
      assistantNavigationStatusClient?.scheduleRefresh(0);
      return {
        ok: true,
        message: "已创建 CODER 智能体。",
        agentKey,
        workspaceDir
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        agentKey: request.key,
        workspaceDir
      };
    }
  });
  ipcMain.handle("assistant.openMemoryDirectory", async () => {
    return {
      ok: false,
      message: "记忆现在由 agent-platform 管理，Desktop 不再维护本地记忆目录。",
      path: ""
    };
  });
  ipcMain.handle("assistant.listMemoryItems", async () => assistantBridge.listMemoryItems());
  ipcMain.handle("assistant.deleteMemoryItem", async (_event, memoryId: string) =>
    assistantBridge.deleteMemoryItem(memoryId)
  );
  ipcMain.handle("assistant.clearMemoryItems", async () => assistantBridge.clearMemoryItems());
  ipcMain.handle("assistant.listChats", async () => assistantBridge.listChats());
  ipcMain.handle("assistant.getChat", async (_event, chatId: string) => assistantBridge.getChat(chatId));
  ipcMain.handle("assistant.pickAttachments", async (_event, chatId?: string | null) =>
    pickAssistantAttachments(chatId, mainWindow)
  );
  ipcMain.handle("assistant.cancelAttachmentTask", async (_event, taskId: string) =>
    cancelAssistantAttachmentTask(taskId)
  );
  ipcMain.handle(
    "assistant.addPastedImage",
    async (_event, chatId: string | null | undefined, input: AssistantPastedImageInput) =>
      createAssistantAttachmentFromPastedImage(app, chatId, input)
  );
  ipcMain.handle("assistant.captureScreenshot", async (_event, chatId?: string | null) =>
    captureAssistantScreenshot(chatId, "sidebar")
  );
  ipcMain.handle("assistant.deleteChat", async (_event, chatId: string) => {
    const result = await assistantBridge.deleteChat(chatId);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });
  ipcMain.handle("assistant.markAgentChatsRead", async (_event, agentKey: string) => {
    const result = await assistantBridge.markAgentChatsRead(agentKey);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });
  ipcMain.handle("assistant.renameChat", async (_event, chatId: string, chatName: string) => {
    const result = await assistantBridge.renameChat(chatId, chatName);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });
  ipcMain.handle("assistant.archiveChat", async (_event, chatId: string) => {
    const result = await assistantBridge.archiveChat(chatId);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });
  ipcMain.handle("assistant.exportChat", async (_event, chatId: string) =>
    saveAssistantChatExport(assistantBridge, chatId)
  );
  ipcMain.handle("assistant.startRun", async (_event, request: AssistantStartRunRequest) =>
    assistantBridge.startRun(request)
  );
  ipcMain.handle("assistant.stopRun", async (_event, runId: string) => assistantBridge.stopRun(runId));
  ipcMain.handle("assistant.correctVoiceText", async (_event, request: AssistantVoiceCorrectionRequest) =>
    assistantBridge.correctVoiceText(request)
  );
  ipcMain.handle("assistant.transcribeVoiceAudio", async (_event, request: AssistantVoiceTranscriptionRequest) =>
    assistantBridge.transcribeVoiceAudio(request)
  );
  ipcMain.handle("assistant.submitAwaiting", async (_event, request: AssistantSubmitAwaitingRequest) =>
    assistantBridge.submitAwaiting(request)
  );
  ipcMain.handle("desktopActions.respond", async (_event, response: DesktopActionRendererResponse) => {
    const requestId = typeof response?.requestId === "string" ? response.requestId : "";
    if (!requestId) {
      return { ok: false };
    }
    const pending = desktopActionRendererRequests.get(requestId);
    if (!pending) {
      return { ok: false };
    }
    desktopActionRendererRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(response);
    return { ok: true };
  });
  ipcMain.handle("desktopActions.list", async () => ({
    ok: true,
    actions: DESKTOP_ACTION_DEFINITIONS
  }));
  ipcMain.handle("desktopActions.call", async (_event, request) =>
    handleDesktopActionRequest(desktopActionOptions, request)
  );
  ipcMain.handle("currentPage.publishSnapshot", async (_event, snapshot: DesktopPageContextSnapshot) => {
    currentPageSnapshot = snapshot;
    return { ok: true };
  });
  ipcMain.handle("currentPage.getSnapshot", async () => currentPageSnapshot);
  ipcMain.handle("assistant.openAttachment", async (_event, chatId: string, attachmentId: string) => {
    try {
      const attachmentPath = resolveAssistantAttachmentPath(app, chatId, attachmentId);
      // macOS and Windows both use Electron's shell helper, but keep the platform
      // branch explicit because packaged file-opening behavior is platform-sensitive.
      let error = "";
      if (process.platform === "darwin") {
        error = await shell.openPath(attachmentPath);
      } else if (process.platform === "win32") {
        error = await shell.openPath(attachmentPath);
      } else {
        error = await shell.openPath(attachmentPath);
      }
      return {
        ok: !error,
        message: error ? `打开附件失败：${error}` : "已打开附件。",
        path: attachmentPath
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        path: ""
      };
    }
  });

  registerQuickCopilotIpcHandlers(ipcMain, quickCopilotWindowController);

  ipcMain.handle("services.list", async () => listServices(app));
  ipcMain.handle("services.getStartupRestoreState", async () => cloneStartupRestoreState(startupRestoreState));
  ipcMain.handle("services.installBuiltinFromBundle", async (_event, serviceId: ServiceId) => runServiceMutation(async () => {
    const current = await getServiceState(app, serviceId);
    if (current.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    if (current.status === "running") {
      return {
        ok: false,
        message: "服务正在运行中，请先停止后再安装。",
        service: current
      };
    }

    await installBuiltinService(app, serviceId);
    await session.defaultSession.clearCache();
    return {
      ok: true,
      message: "内置服务已安装。",
      service: await getServiceState(app, serviceId)
    };
  }));
  ipcMain.handle("services.installBuiltin", async (_event, serviceId: ServiceId) => runServiceMutation(async () => {
    const current = await getServiceState(app, serviceId);
    if (current.kind !== "builtin") {
      throw new Error(`service ${serviceId} is not a builtin service`);
    }
    if (current.status === "running") {
      return {
        ok: false,
        message: "服务正在运行中，请先停止后再安装。",
        service: current
      };
    }

    const result = await showArchiveDialog(
      process.platform === "win32" ? "选择内置服务安装包 (.zip)" : "选择内置服务安装包 (.tar.gz)"
    );
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        message: "已取消安装。",
        service: await getServiceState(app, serviceId)
      };
    }

    await installBuiltinService(app, serviceId, {
      force: true,
      archivePath: result.filePaths[0]
    });
    await session.defaultSession.clearCache();
    return {
      ok: true,
      message: "内置服务已安装。",
      service: await getServiceState(app, serviceId)
    };
  }));
  ipcMain.handle("services.initialize", async (_event, serviceId: ServiceId) => {
    return runServiceMutation(() => initializeService(app, serviceId));
  });
  ipcMain.handle("services.getStatus", async (_event, serviceId: ServiceId) => getServiceState(app, serviceId));
  ipcMain.handle("services.start", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => handleServiceStart(serviceId)));
  ipcMain.handle("services.stop", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => stopService(app, serviceId)));
  ipcMain.handle("services.restart", async (_event, serviceId: ServiceId) =>
    runServiceMutation(() => restartService(app, serviceId)));
  ipcMain.handle("services.readConfig", async (_event, serviceId: ServiceId, key: string) => {
    return readServiceConfig(app, serviceId, key);
  });
  ipcMain.handle("services.writeConfig", async (_event, serviceId: ServiceId, key: string, content: string) => {
    return runServiceMutation(() => writeServiceConfig(app, serviceId, key, content));
  });
  ipcMain.handle("services.importFile", async (_event, serviceId: ServiceId, targetKey: string) => {
    return runServiceMutation(async () => {
      const result = await showFileDialog({
        title: "选择要导入的文件",
        properties: ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return {
          ok: false,
          message: "已取消导入。",
          targetPath: "",
          service: await getServiceState(app, serviceId)
        };
      }
      return importServiceFile(app, serviceId, targetKey, result.filePaths[0]);
    });
  });
  ipcMain.handle("services.getLogsMeta", async (_event, serviceId: ServiceId) => {
    return getServiceLogsMeta(app, serviceId);
  });
  ipcMain.handle("services.openLogViewer", async (_event, request: ServiceOpenLogViewerRequest) => {
    const serviceId = typeof request.serviceId === "string" ? request.serviceId.trim() : "";
    const target: ServiceLogTarget = request.target === "error" ? "error" : "main";
    const title = typeof request.title === "string" && request.title.trim() ? request.title.trim() : "日志文件";
    if (!serviceId) {
      throw new Error("缺少日志服务标识。");
    }
    return openLogViewerWindow({
      serviceId,
      target,
      title
    });
  });
  ipcMain.handle("services.revealPath", async (_event, targetPath: string, options?: ServiceRevealPathOptions) => {
    return revealPathInFileManager(targetPath, options, {
      showItemInFolder: (pathToReveal) => shell.showItemInFolder(pathToReveal),
      openPath: (pathToOpen) => shell.openPath(pathToOpen),
      platform: process.platform
    });
  });
  ipcMain.handle("services.closeLogViewer", async () => closeLogViewerWindow());
  ipcMain.handle("services.minimizeLogViewer", async () => minimizeLogViewerWindow());
  ipcMain.handle("services.maximizeLogViewer", async () => maximizeLogViewerWindow());
  ipcMain.handle(
    "services.readLog",
    async (_event, serviceId: ServiceId, target: ServiceLogTarget, options?: ServiceLogReadOptions) => {
      return readServiceLog(app, serviceId, target, options);
    }
  );
  ipcMain.handle(
    "services.watchLog.start",
    async (
      event,
      subscriptionId: string,
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options?: ServiceLogStreamOptions
    ) => {
      logStreamSubscriptions.get(subscriptionId)?.cleanup();
      const ownerContents = event.sender;
      const cleanup = watchServiceLog(app, subscriptionId, serviceId, target, options, (payload) => {
        if (ownerContents.isDestroyed()) {
          logStreamSubscriptions.get(subscriptionId)?.cleanup();
          logStreamSubscriptions.delete(subscriptionId);
          return;
        }
        ownerContents.send("services.logStream", payload);
      });

      logStreamSubscriptions.set(subscriptionId, {
        webContentsId: ownerContents.id,
        cleanup
      });
      ownerContents.once("destroyed", () => {
        const current = logStreamSubscriptions.get(subscriptionId);
        if (current?.webContentsId === ownerContents.id) {
          current.cleanup();
          logStreamSubscriptions.delete(subscriptionId);
        }
      });
      return { ok: true };
    }
  );
  ipcMain.handle("services.watchLog.stop", async (event, subscriptionId: string) => {
    const current = logStreamSubscriptions.get(subscriptionId);
    if (current && current.webContentsId === event.sender.id) {
      current.cleanup();
      logStreamSubscriptions.delete(subscriptionId);
    }
    return { ok: true };
  });
  ipcMain.handle("plugins.install", async () => runServiceMutation(async () => {
    const result = await showArchiveDialog(
      process.platform === "win32" ? "选择插件包 (.zip)" : "选择插件包 (.tar.gz)"
    );
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入。" };
    }
    const installResult = await installPluginFromArchive(app, result.filePaths[0]);
    if (installResult.ok) {
      await session.defaultSession.clearCache();
    }
    return installResult;
  }));
  ipcMain.handle("plugins.uninstall", async (_event, serviceId: ServiceId) => {
    return runServiceMutation(() => handlePluginUninstall(app, serviceId, mainWindow, { t }));
  });
  ipcMain.handle("plugins.getServiceWebviewPreloadPath", async () => getServiceWebviewPreloadPath());
  ipcMain.handle("plugins.getServiceWebviewPreloadUrl", async () => getServiceWebviewPreloadUrl());
  ipcMain.handle("market.getSettings", async () => getMarketSettings(app));
  ipcMain.handle("market.saveSettings", async (_event, input) => saveMarketSettings(app, input));
  ipcMain.handle("market.list", async () => listMarketItems(app));
  ipcMain.handle("market.refresh", async () => refreshMarketCatalog(app));
  ipcMain.handle("market.install", async (_event, itemId: string) => runServiceMutation(async () => {
    const result = await installMarketItem(app, itemId);
    if (result.ok) {
      await session.defaultSession.clearCache();
    }
    return result;
  }));
  ipcMain.handle("market.update", async (_event, itemId: string) => runServiceMutation(async () => {
    const result = await updateMarketItem(app, itemId);
    if (result.ok) {
      await session.defaultSession.clearCache();
    }
    return result;
  }));
  ipcMain.handle("market.uninstall", async (_event, itemId: string) =>
    runServiceMutation(() => uninstallMarketItem(app, itemId)));
  ipcMain.handle("market.buildSandboxImage", async (_event, itemId: string) =>
    runServiceMutation(() => buildSandboxImage(app, itemId)));
  ipcMain.handle("market.deleteSandboxImage", async (_event, itemId: string) =>
    runServiceMutation(() => deleteSandboxImage(app, itemId)));
  ipcMain.handle("market.exportSandboxImage", async (_event, itemId: string) => runServiceMutation(async () => {
    const imageRef = String(itemId ?? "").trim();
    const saveResult = await showSaveDialog({
      title: "导出沙箱镜像",
      defaultPath: getSandboxImageExportDefaultPath(imageRef),
      filters: [{ name: "Docker / Podman 镜像归档", extensions: ["tar"] }]
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        itemId: imageRef,
        type: "sandbox-image",
        state: "failed",
        message: "已取消导出。",
        imageRef
      };
    }
    return exportSandboxImageToPath(app, imageRef, saveResult.filePath);
  }));
  ipcMain.handle("market.importSandboxImage", async (event) => runServiceMutation(async () => {
    const taskId = `sandbox-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const emitImportProgress = (progress: SandboxImageImportProgressEvent) => {
      event.sender.send("market.sandboxImageImportProgress", {
        taskId,
        ...progress
      });
    };
    const result = await showFileDialog({
      title: "选择沙箱镜像压缩包",
      properties: ["openFile"],
      filters: [
        {
          name: "镜像压缩包",
          extensions: process.platform === "win32" ? ["tar", "gz", "tgz", "zip"] : ["tar", "gz", "tgz"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        itemId: "",
        type: "sandbox-image",
        state: "failed",
        message: "已取消导入。"
      };
    }
    return importSandboxImageFromPath(app, result.filePaths[0], {
      taskId,
      onProgress: emitImportProgress
    });
  }));
  ipcMain.handle("market.importSkill", async () => runServiceMutation(async () => {
    const result = await showFileDialog({
      title: "选择 Skill 包或 SKILL.md",
      properties: ["openFile"],
      filters: [
        {
          name: "Skill",
          extensions: process.platform === "win32" ? ["zip", "skill", "md"] : ["gz", "tgz", "skill", "md"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        itemId: "",
        type: "skill",
        state: "failed",
        message: "已取消导入。"
      };
    }
    return importSkillFromPath(app, result.filePaths[0]);
  }));
  ipcMain.handle("market.importSkillFromCommand", async (_event, commandText: string) => runServiceMutation(async () => {
    const result = await importSkillFromCommand(app, commandText);
    if (result.ok) {
      await session.defaultSession.clearCache();
    }
    return result;
  }));
  ipcMain.handle("panAuth.importPrivateKey", async () => {
    const result = await showFileDialog({
      title: "选择要导入的 App 私钥",
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      const status = getPanAuthStatus(app);
      return {
        ok: false,
        message: "已取消导入 Desktop App 私钥。",
        status
      };
    }

    const status = importPanPrivateKey(app, result.filePaths[0]);
    return {
      ok: true,
      message: status.message,
      status
    };
  });
  ipcMain.handle("panAuth.getStatus", async () => getPanAuthStatus(app));
  ipcMain.handle("agentAuth.issueAccessToken", async (_event, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });
  ipcMain.handle("sso.getStatus", async () => getDesktopSsoStatus(app));
  ipcMain.handle("sso.startLogin", async () => {
    const result = await startDesktopSsoLogin(app, {
      onBeforeStatusChanged: async (status) => {
        if (status.authenticated) {
          await syncDesktopSsoBrowserCookies();
        }
      },
      onStatusChanged: broadcastDesktopSsoStatus
    });
    if (result.ok && result.authorizeUrl) {
      const browserOpenResult = await openDesktopSsoBrowserUrl({
        url: result.browserUrl || result.authorizeUrl,
        label: "IAM 登录",
        browserOrigin: result.browserUrl ? undefined : result.browserOrigin,
        resolveRedirect: Boolean(result.browserUrl)
      });
      if (!browserOpenResult.ok) {
        const status = failDesktopSsoFlow(browserOpenResult.message);
        broadcastDesktopSsoStatus(status);
        return {
          ...result,
          ok: false,
          status,
          message: browserOpenResult.message
        };
      }
    }
    return result;
  });
  ipcMain.handle("sso.logout", async () => {
    const result = await logoutDesktopSso(app, {
      onStatusChanged: broadcastDesktopSsoStatus
    });
    await clearDesktopSsoBrowserCookies();
    if (result.ok && result.logoutUrl) {
      const browserOpenResult = await openDesktopSsoBrowserUrl({
        url: result.browserUrl || result.logoutUrl,
        label: "IAM 登出",
        browserOrigin: result.browserUrl ? undefined : result.browserOrigin,
        resolveRedirect: false
      });
      if (!browserOpenResult.ok) {
        const status = failDesktopSsoFlow(browserOpenResult.message);
        broadcastDesktopSsoStatus(status);
        return {
          ...result,
          ok: false,
          status,
          message: browserOpenResult.message
        };
      }
    }
    return result;
  });
  ipcMain.handle("clipboard.writeText", async (_event, text: string) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle("taskBoard.listIssues", async () => listTaskBoardIssues(app));
  ipcMain.handle("taskBoard.createIssue", async (_event, input: TaskBoardIssueInput) =>
    createTaskBoardIssue(app, input)
  );
  ipcMain.handle("taskBoard.updateIssue", async (_event, issueId: string, input: TaskBoardIssueUpdateInput) =>
    updateTaskBoardIssue(app, issueId, input)
  );
  ipcMain.handle("taskBoard.deleteIssue", async (_event, issueId: string) =>
    deleteTaskBoardIssueWithAutomation(issueId)
  );
  ipcMain.handle("taskBoard.moveIssue", async (_event, input: TaskBoardIssueMoveInput) =>
    moveTaskBoardIssue(app, input)
  );
  ipcMain.handle("taskBoard.syncIssueAutomation", async (_event, issueId: string) =>
    syncTaskBoardIssueAutomation(issueId)
  );
  ipcMain.handle("customSidebar.list", async () => listCustomSidebarItems(app));
  ipcMain.handle("customSidebar.add", async (_event, input: CustomSidebarItemInput) => {
    return addCustomSidebarItem(app, input);
  });
  ipcMain.handle("customSidebar.update", async (_event, id: string, input: CustomSidebarUpdateInput) => {
    return updateCustomSidebarItem(app, id, input);
  });
  ipcMain.handle("customSidebar.remove", async (_event, id: string) => {
    return removeCustomSidebarItem(app, id);
  });
  ipcMain.handle("customSidebar.import", async () => {
    const result = await showFileDialog({
      title: "导入内嵌网站配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导入内嵌网站配置。"
      };
    }

    const importPath = result.filePaths[0];
    const fileContent = await fs.promises.readFile(importPath, "utf8");
    const importResult = importCustomSidebarItems(app, fileContent);
    return {
      ...importResult,
      path: importPath
    };
  });
  ipcMain.handle("customSidebar.export", async () => {
    const saveResult = await showSaveDialog({
      title: "导出内嵌网站配置",
      defaultPath: path.join(getDataRoot(app), "custom-sidebar-items.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导出内嵌网站配置。"
      };
    }

    const filePath = saveResult.filePath;
    await fs.promises.writeFile(filePath, `${exportCustomSidebarItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listCustomSidebarItems(app).items,
      path: filePath,
      message: "已导出内嵌网站配置。"
    };
  });
  ipcMain.handle("desktopPet.getSettings", async () => toDesktopPetSettings(desktopPetSettings));
  ipcMain.handle("desktopPet.getState", async () => {
    if (desktopPetSettings.enabled) {
      scheduleAgentPlatformPetStatusRefresh(0);
    }
    return refreshDesktopPetState();
  });
  ipcMain.handle("desktopPet.saveSettings", async (_event, input: DesktopPetSettingsInput) => {
    if (!isDesktopPetSupportedPlatform(process.platform)) {
      return refreshDesktopPetState();
    }
    const nextBoundAgentKey = typeof input.boundAgentKey === "string"
      ? sanitizeDesktopPetBoundAgentKey(input.boundAgentKey)
      : desktopPetSettings.boundAgentKey;
    const nextAppearanceId = typeof input.appearanceId === "string"
      ? sanitizeDesktopPetAppearanceId(input.appearanceId)
      : desktopPetSettings.appearanceId;
    const boundAgentChanged = nextBoundAgentKey !== desktopPetSettings.boundAgentKey;
    const appearanceChanged = nextAppearanceId !== desktopPetSettings.appearanceId;
    if (boundAgentChanged || appearanceChanged) {
      desktopPetSettings = saveDesktopPetSettings(app, {
        boundAgentKey: nextBoundAgentKey,
        appearanceId: nextAppearanceId
      }, process.platform);
    }
    if (boundAgentChanged) {
      desktopPetAgentStatus = null;
      clearDesktopPetActiveRuns();
    }
    if (typeof input.enabled === "boolean") {
      if (input.enabled) {
        showDesktopPetWindow();
      } else {
        hideDesktopPetWindow(true);
      }
    }
    if (boundAgentChanged) {
      scheduleAgentPlatformPetStatusRefresh(0);
    }
    return refreshDesktopPetState();
  });
  ipcMain.handle("desktopPet.show", async () => showDesktopPetWindow());
  ipcMain.handle("desktopPet.hide", async () => hideDesktopPetWindow(true));
  ipcMain.handle("desktopPet.openAssistant", async () => openAssistantFromDesktopPet());
  ipcMain.handle("desktopPet.moveBy", async (event, delta: { x?: unknown; y?: unknown }) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false };
    }
    return moveDesktopPetWindowBy(delta);
  });
  ipcMain.handle("desktopPet.beginDrag", async (event, point: { x?: unknown; y?: unknown }) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false };
    }
    return beginDesktopPetWindowDrag(point);
  });
  ipcMain.handle("desktopPet.endDrag", async (event) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false, moved: false };
    }
    return endDesktopPetWindowDrag();
  });
  ipcMain.handle("desktopPet.setPreviewExpanded", async (event, expanded: boolean) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false };
    }
    desktopPetPreviewProjector.setExpanded(Boolean(expanded));
    refreshDesktopPetState();
    return { ok: true };
  });
  ipcMain.handle("desktopPet.dismissPreview", async (event) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false };
    }
    return dismissDesktopPetPreview();
  });
  ipcMain.handle("desktopPet.setMouseInteractive", async (event, interactive: boolean) => {
    if (!desktopPetWindow || desktopPetWindow.isDestroyed() || event.sender !== desktopPetWindow.webContents) {
      return { ok: false };
    }
    return setDesktopPetWindowMouseInteractive(Boolean(interactive));
  });
  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => process.platform);
  ipcMain.handle("settings.getAppInfo", async () => ({
    version: app.getVersion()
  }));
  ipcMain.handle("settings.setNativeThemeSource", async (_event, themeMode: string) =>
    setNativeThemeSource(themeMode)
  );
  ipcMain.handle("settings.getLocale", async () => initializeMainI18n(app));
  ipcMain.handle("settings.setLocale", async (_event, locale: unknown) => {
    if (!isSupportedLocale(locale)) {
      return initializeMainI18n(app);
    }
    const settings = setMainLocale(app, locale);
    buildApplicationMenu();
    appTrayController.refreshContextMenu();
    emitLocaleChanged(settings);
    return settings;
  });
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    ensureDarwinDockIdentity();
    if (!(await ensureFirstInstallEnvZipImported())) {
      app.quit();
      return;
    }
    ensureDataRoot(app);
    loadBuiltinServices(app);
    loadInstalledPlugins(app);
    registerIpcHandlers();
    configureMediaPermissions();
    createWindow();
    if (isDesktopPetSupportedPlatform(process.platform) && desktopPetSettings.enabled) {
      showDesktopPetWindow();
    } else {
      refreshDesktopPetState();
    }
    createAppTray();
    buildApplicationMenu();
    registerQuickAssistantShortcut();
    void runServiceMutation(() => runStartupPreparation(app, {
      onModeResolved: (mode) => {
        beginStartupRestoreSession(mode);
      },
      onStarting: (serviceId) => {
        updateStartupRestoreService(serviceId, "starting", "启动中...");
      },
      onProgress: (serviceId, phase, message) => {
        updateStartupRestoreService(serviceId, phase, message);
        notifyServicesChanged();
      }
    }))
      .then((result) => {
        finishStartupRestoreSession(result.mode, result.failures);
        notifyServicesChanged();
        if (result.failures.length > 0) {
          console.error("failed to prepare startup services", result.failures);
        }
      })
      .catch((error) => {
        if (startupRestoreState.phase === "running") {
          commitStartupRestoreState({
            ...startupRestoreState,
            phase: "failed",
            currentServiceId: null,
            failedServiceId: startupRestoreState.currentServiceId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        console.error("failed to prepare startup services", error);
      });
    app.on("activate", () => {
      if (nativeDialogController.isOpen()) {
        return;
      }
      showMainWindow();
    });
  });
}

function runShutdownCleanup() {
  if (shutdownCleanupPromise) {
    return shutdownCleanupPromise;
  }
  const shutdownStartedAt = Date.now();
  const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(app);
  shutdownCleanupPromise = stopRunningServicesForShutdown(app)
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
    })
    .finally(() => {
      shutdownCleanupComplete = true;
      console.log(`[main] app shutdown cleanup finished in ${Date.now() - shutdownStartedAt}ms`);
    });
  return shutdownCleanupPromise;
}

app.on("before-quit", (event) => {
  if (shutdownCleanupComplete) {
    return;
  }
  event.preventDefault();
  isHandlingQuit = true;
  void runShutdownCleanup().finally(() => {
    app.quit();
  });
});

app.on("will-quit", () => {
  clearDesktopPetIdleResetTimer();
  embeddedCdpGateway?.stop();
  embeddedCdpGateway = null;
  assistantNavigationStatusClient?.stop();
  assistantNavigationStatusClient = null;
  stopAgentPlatformPetStatusClient();
  unregisterQuickCopilotShortcut({
    platform: process.platform,
    globalShortcut
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isHandlingQuit) {
    app.quit();
  }
});
