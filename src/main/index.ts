import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
  screen,
  shell,
  session,
  systemPreferences,
  Tray,
  webContents,
  type MediaAccessPermissionRequest,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type Display,
  type NativeImage,
  type Rectangle,
  type SaveDialogOptions,
  type WebContents,
  type WebFrameMain
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
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
} from "./service-manager";
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
import {
  buildSandboxImage,
  getMarketSettings,
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
} from "./port-conflict";
import { resolveWebviewOpenDisposition } from "./webview-open-tab";
import { revealPathInFileManager } from "./reveal-path";
import {
  EmbeddedCdpGateway,
  type EmbeddedCdpCommandRequest,
  type EmbeddedCdpFrameTarget,
  type EmbeddedCdpSurface
} from "./embedded-cdp-gateway";
import {
  addCustomSidebarItem,
  exportCustomSidebarItems,
  importCustomSidebarItems,
  listCustomSidebarItems,
  removeCustomSidebarItem,
  updateCustomSidebarItem
} from "./custom-sidebar-store";
import {
  getAgentPlatformMinimaxSettingsPublic,
  loadAgentPlatformMinimaxSettings
} from "./assistant/agent-platform-config";
import {
  getAssistantSettings,
  readAssistantSettings,
  saveAssistantSettings
} from "./assistant/settings-store";
import { AgentPlatformAssistantBridge } from "./assistant/agent-platform-bridge";
import {
  cancelAssistantAttachmentTask,
  createAssistantAttachmentFromImageBuffer,
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "./assistant/attachment-store";
import { getService } from "./service-registry";
import type {
  AssistantEvent,
  AssistantAttachmentTaskProgress,
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
  EmbeddedWebExecuteInFrameRequest,
  EmbeddedWebExecuteInFrameResult,
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
  StartupRestoreMode,
  StartupRestoreServiceState,
  StartupRestoreState
} from "../shared/contracts";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL,
  isBuiltinBrowserSurfaceTarget,
  resolveBuiltinBrowserUrl
} from "../shared/browser-surfaces";
import { APP_ICON_ASSET_DIRECTORIES, APP_ICON_ASSET_FILENAMES } from "../shared/app-icon-assets";
import {
  ensureDataRoot,
  getDataRoot,
  getElectronUserDataRoot
} from "./user-paths";
import {
  homeZenmindEnvExists,
  importEnvZipToZenmind,
  resolveHomeZenmindRoot,
  shouldRequireMacEnvZipImport
} from "./env-bootstrap";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { safeConsoleError } from "./safe-console";
import { handleDesktopActionRequest, startDesktopActionBridge } from "./desktop-action-bridge";
import { DESKTOP_ACTION_DEFINITIONS } from "../shared/desktop-actions";
import { AgentPlatformPetStatusClient } from "./agent-platform-pet-status";
import { AgentPlatformPetStreamClient } from "./agent-platform-pet-stream";
import {
  clampDesktopPetPosition,
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  getDesktopPetContextMenuItems,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetWindowSize,
  type DesktopPetBoundAgentStatus,
  type DesktopPetLocalStatus,
  type DesktopPetWindowMode,
  isDesktopPetSupportedPlatform,
  readDesktopPetStoredState,
  saveDesktopPetSettings,
  sanitizeDesktopPetAppearanceId,
  sanitizeDesktopPetBoundAgentKey,
  toDesktopPetSettings
} from "./desktop-pet";
import { DesktopPetPreviewProjector, normalizeDesktopPetAgentEvent } from "./desktop-pet-preview";
import {
  getQuickAssistantWebCopilotBounds,
  isQuickAssistantMediaPermissionAllowed,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_ROUTE,
  QUICK_ASSISTANT_SHORTCUT
} from "./quick-assistant";

let mainWindow: BrowserWindow | null = null;
let desktopPetWindow: BrowserWindow | null = null;
let quickAssistantWindow: BrowserWindow | null = null;
let quickAssistantDismissWindow: BrowserWindow | null = null;
let logViewerWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isHandlingQuit = false;
let pendingMainWindowCloseCancel: (() => void) | null = null;
let serviceMutationQueue = Promise.resolve();
let nativeDialogVisibilityDepth = 0;
let quickAssistantVisibleBeforeNativeDialog = false;
let mainWindowSidebarTranslucencyEnabled = true;
const desktopActionRendererRequests = new Map<string, {
  resolve: (response: DesktopActionRendererResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
const ASSISTANT_TARGET_PATH = "/service/agent-webclient";
const AGENT_WEBCLIENT_APP_PATHNAMES = new Set(["/", "/copilot"]);
const LOG_VIEWER_ROUTE = "/log-viewer";
const AGENT_WEBCLIENT_OPEN_RETRY_COUNT = 24;
const AGENT_WEBCLIENT_OPEN_RETRY_MS = 180;
const DESKTOP_ACTION_RENDERER_TIMEOUT_MS = 8_000;
const EMBEDDED_WEB_FRAME_SCRIPT_TIMEOUT_MS = 15_000;
const EMBEDDED_WEB_FRAME_SCRIPT_MAX_BYTES = 256 * 1024;
const DESKTOP_PET_DRAG_FORCE_END_MS = 4_000;
const QUICK_ASSISTANT_DISMISS_URL = "zenmind://quick-assistant-dismiss";
const STARTUP_RESTORE_SERVICE_ORDER = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const MAC_FULLSCREEN_CLOSE_DELAY_MS = 500;
const MAC_FULLSCREEN_CLOSE_FALLBACK_MS = 2200;
const ZENMIND_APP_ID = "cc.zenmind.desktop";
const ZENMIND_PRODUCT_NAME = "ZenMind";
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
  kind?: "webview" | "iframe";
  active?: boolean;
  title?: string;
  currentUrl?: string;
  webContentsId?: number;
  agentKey?: string;
  frameMatchUrl?: string;
  navigationRoute?: string;
  navigationLabel?: string;
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
const homeZenmindRootAtProcessStart = resolveHomeZenmindRoot(app, process.platform);
const requireEnvZipImportAtStartup = shouldRequireMacEnvZipImport({
  platform: process.platform,
  homeZenmindEnvExistedAtStartup: homeZenmindEnvExists(app, process.platform)
});
const electronUserDataRoot = getElectronUserDataRoot(app);
fs.mkdirSync(electronUserDataRoot, { recursive: true });
app.setPath("userData", electronUserDataRoot);
if (process.platform === "win32") {
  app.setAppUserModelId(ZENMIND_APP_ID);
}

let desktopPetSettings = readDesktopPetStoredState(app, process.platform);
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
const desktopPetPreviewProjector = new DesktopPetPreviewProjector();
let desktopPetPreviewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let dismissedDesktopPetDonePreview: { chatId: string; runId: string } | null = null;
let desktopPetPendingProgrammaticBoundsSignature: string | null = null;
let desktopPetProgrammaticBoundsGuardTimer: ReturnType<typeof setTimeout> | null = null;
let desktopPetMouseInteractive = true;

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
      clearDismissedDesktopPetDonePreview(chatId, runId);
      ensureAgentPlatformPetStreamClient()?.attach(runId, chatId);
    },
    onRunFinished: ({ runId, chatId, message }) => {
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
    previewPanel: desktopPetPreviewProjector.getPanel()
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
  if (tray && process.platform !== "darwin") {
    tray.setContextMenu(buildTrayMenu());
  }
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
    return screen.getDisplayMatching({
      x: position.x,
      y: position.y,
      width: 1,
      height: 1
    }).bounds;
  }
  return screen.getPrimaryDisplay().bounds;
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

function persistDesktopPetPosition() {
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
  const logicalPosition = getDesktopPetLogicalPositionFromBounds(bounds, getDesktopPetWindowMode());
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
  const size = getDesktopPetWindowSize(getDesktopPetWindowMode());
  const nextBounds = clampDesktopPetPosition({
    x: currentBounds.x + Math.round(deltaX),
    y: currentBounds.y + Math.round(deltaY)
  }, getDesktopPetDisplayBounds(cursorPoint), size);
  desktopPetWindow.setBounds(nextBounds, false);
  desktopPetWindow.moveTop();
  return { ok: true };
}

function clearDesktopPetDragTimer() {
  if (desktopPetDragTimer) {
    clearInterval(desktopPetDragTimer);
    desktopPetDragTimer = null;
  }
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
  clearDesktopPetDragTimer();
  desktopPetDragState = {
    startPoint,
    lastPoint: startPoint,
    moved: false,
    startedAt: Date.now()
  };

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
    persistDesktopPetPosition();
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

function embeddedWebFrameError(
  code: string,
  message: string,
  details?: unknown
): EmbeddedWebExecuteInFrameResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function parseSafeFrameMatchUrl(frameMatchUrl: string) {
  try {
    const parsed = new URL(frameMatchUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return isLoopbackHostname(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

function isTrustedDesktopRendererSender(contents: WebContents) {
  return [mainWindow, quickAssistantWindow].some((targetWindow) =>
    targetWindow && !targetWindow.isDestroyed() && targetWindow.webContents.id === contents.id
  );
}

function parseFrameUrl(frame: WebFrameMain) {
  try {
    return new URL(frame.url);
  } catch {
    return null;
  }
}

function findMatchingWebFrame(frames: WebFrameMain[], targetUrl: URL) {
  const originMatches = frames.filter((frame) => parseFrameUrl(frame)?.origin === targetUrl.origin);
  return originMatches.find((frame) => parseFrameUrl(frame)?.href === targetUrl.href) ??
    originMatches.find((frame) => {
      const frameUrl = parseFrameUrl(frame);
      return Boolean(frameUrl && targetUrl.pathname !== "/" && frameUrl.pathname === targetUrl.pathname);
    }) ??
    originMatches[0] ??
    null;
}

async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function executeEmbeddedWebFrameScript(
  sender: WebContents,
  input: EmbeddedWebExecuteInFrameRequest
): Promise<EmbeddedWebExecuteInFrameResult> {
  if (!isTrustedDesktopRendererSender(sender)) {
    return embeddedWebFrameError("forbidden", "Only Desktop renderer windows can execute embedded frame scripts.");
  }

  const frameMatchUrl = typeof input?.frameMatchUrl === "string" ? input.frameMatchUrl.trim() : "";
  const targetUrl = parseSafeFrameMatchUrl(frameMatchUrl);
  if (!targetUrl) {
    return embeddedWebFrameError("invalid_frame_match_url", "frameMatchUrl must be an http(s) localhost or loopback URL.", {
      frameMatchUrl
    });
  }

  const script = typeof input?.script === "string" ? input.script : "";
  if (!script.trim()) {
    return embeddedWebFrameError("invalid_script", "script is required.");
  }
  if (Buffer.byteLength(script, "utf8") > EMBEDDED_WEB_FRAME_SCRIPT_MAX_BYTES) {
    return embeddedWebFrameError("script_too_large", "script exceeds the embedded frame size limit.");
  }

  const frames = collectWebFrames(sender.mainFrame);
  const frame = findMatchingWebFrame(frames, targetUrl);
  if (!frame) {
    return embeddedWebFrameError("frame_not_found", "No embedded frame matched the requested localhost origin.", {
      frameMatchUrl,
      origin: targetUrl.origin,
      frames: frames.map((candidate) => candidate.url).filter(Boolean)
    });
  }

  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? Math.min(Math.max(Math.round(input.timeoutMs), 1_000), EMBEDDED_WEB_FRAME_SCRIPT_TIMEOUT_MS)
    : EMBEDDED_WEB_FRAME_SCRIPT_TIMEOUT_MS;
  try {
    const result = await executeWithTimeout(frame.executeJavaScript(script), timeoutMs);
    return {
      ok: true,
      frameUrl: frame.url,
      result
    };
  } catch (error) {
    return embeddedWebFrameError(
      "script_execution_failed",
      error instanceof Error ? error.message : String(error),
      { frameUrl: frame.url }
    );
  }
}

function isAgentWebclientAppFrame(frame: WebFrameMain) {
  try {
    return AGENT_WEBCLIENT_APP_PATHNAMES.has(new URL(frame.url).pathname);
  } catch {
    return false;
  }
}

function createAgentWebclientOpenScript(request: {
  chatId: string;
  agentKey: string;
  focusComposerOnComplete: boolean;
}) {
  const chatId = request.chatId.trim();
  const agentKey = request.agentKey.trim();
  if (chatId) {
    return [
      "window.dispatchEvent(new CustomEvent('agent:load-chat', {",
      `  detail: ${JSON.stringify({
        chatId,
        focusComposerOnComplete: request.focusComposerOnComplete
      })}`,
      "}));",
      "true;"
    ].join("\n");
  }
  if (agentKey) {
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
  return "true;";
}

function dispatchAgentWebclientOpenRequest(
  targetWindow: BrowserWindow,
  request: {
    chatId: string;
    agentKey: string;
    focusComposerOnComplete: boolean;
  }
) {
  const script = createAgentWebclientOpenScript(request);
  const frames = collectWebFrames(targetWindow.webContents.mainFrame).filter(isAgentWebclientAppFrame);
  let dispatched = false;
  for (const frame of frames) {
    dispatched = true;
    frame.executeJavaScript(script).catch((error) => {
      console.warn("[desktop-pet] failed to open agent webclient chat", error);
    });
  }
  return dispatched;
}

function scheduleAgentWebclientOpenRequest(
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
  if (dispatchAgentWebclientOpenRequest(targetWindow, request)) {
    return;
  }
  if (attempt >= AGENT_WEBCLIENT_OPEN_RETRY_COUNT) {
    console.warn("[desktop-pet] agent webclient frame was not ready for desktop pet open request");
    return;
  }
  setTimeout(() => {
    scheduleAgentWebclientOpenRequest(targetWindow, request, attempt + 1);
  }, AGENT_WEBCLIENT_OPEN_RETRY_MS);
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

async function showAssistantTargetWindow(source: string) {
  const failures = await runServiceMutation(() => ensureAssistantTargetServicesRunning(source));
  if (failures.length > 0) {
    showMainWindow("/control-center");
    return {
      ok: false,
      message: `智能助理服务恢复失败：${failures.join("；")}`,
      window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    };
  }

  showMainWindow(ASSISTANT_TARGET_PATH);
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
  const targetChatId = desktopPetState.chatId ??
    (desktopPetLocalStatus.status !== "idle" ? desktopPetLocalStatus.chatId : null);
  const agentKey = desktopPetAgentStatus?.agentKey ||
    desktopPetState.boundAgentKey ||
    desktopPetSettings.boundAgentKey;
  const openResult = await showAssistantTargetWindow("desktop-pet");
  const targetWindow = openResult.window;
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("app.openAssistantWorker", {
      chatId: targetChatId ?? undefined,
      agentKey,
      focusComposerOnComplete: desktopPetState.status !== "running"
    } satisfies AssistantWorkerOpenRequest);
    scheduleAgentWebclientOpenRequest(targetWindow, {
      chatId: targetChatId ?? "",
      agentKey,
      focusComposerOnComplete: desktopPetState.status !== "running"
    });
  }
  if (targetChatId && desktopPetState.unreadCount > 0) {
    void markAgentPlatformChatReadFromDesktopPet(targetChatId);
  }
  return {
    ok: openResult.ok,
    message: openResult.message
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
  desktopPetWindow.on("move", persistDesktopPetPosition);
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

function getQuickAssistantWorkArea() {
  const cursorPoint = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursorPoint).workArea;
}

function getQuickAssistantDismissHtml() {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "html,body,#hit{width:100%;height:100%;margin:0;background:transparent;}",
    "</style>",
    "</head>",
    "<body>",
    "<div id=\"hit\" aria-hidden=\"true\"></div>",
    "<script>",
    "const dismiss=()=>{",
    "  if(window.electronAPI?.quickAssistant?.hide){",
    "    void window.electronAPI.quickAssistant.hide();",
    "    return;",
    "  }",
    `  window.location.href=${JSON.stringify(QUICK_ASSISTANT_DISMISS_URL)};`,
    "};",
    "[\"pointerdown\",\"mousedown\",\"click\",\"touchstart\"].forEach((eventName)=>{",
    "  document.addEventListener(eventName,dismiss,{capture:true});",
    "});",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}

function createQuickAssistantDismissWindow() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return null;
  }
  if (quickAssistantDismissWindow && !quickAssistantDismissWindow.isDestroyed()) {
    return quickAssistantDismissWindow;
  }

  quickAssistantDismissWindow = new BrowserWindow({
    ...getQuickAssistantWorkArea(),
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "ZenMind Quick Assistant Dismiss Layer",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false
    }
  });

  quickAssistantDismissWindow.setAlwaysOnTop(true, "floating");
  quickAssistantDismissWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickAssistantDismissWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(QUICK_ASSISTANT_DISMISS_URL)) {
      return;
    }
    event.preventDefault();
    hideQuickAssistantAfterOutsideFocus();
  });
  quickAssistantDismissWindow.on("closed", () => {
    quickAssistantDismissWindow = null;
  });
  void quickAssistantDismissWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getQuickAssistantDismissHtml())}`);

  return quickAssistantDismissWindow;
}

function showQuickAssistantDismissWindow() {
  const dismissWindow = createQuickAssistantDismissWindow();
  if (!dismissWindow || dismissWindow.isDestroyed()) {
    return;
  }
  dismissWindow.setBounds(getQuickAssistantWorkArea(), true);
  dismissWindow.showInactive();
}

function hideQuickAssistantDismissWindow() {
  if (!quickAssistantDismissWindow || quickAssistantDismissWindow.isDestroyed() || !quickAssistantDismissWindow.isVisible()) {
    return;
  }
  quickAssistantDismissWindow.hide();
}

function createQuickAssistantWindow() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return null;
  }
  if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
    return quickAssistantWindow;
  }

  quickAssistantWindow = new BrowserWindow({
    ...getQuickAssistantWebCopilotBounds({
      workArea: getQuickAssistantWorkArea()
    }),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "ZenMind Quick Assistant",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false,
      webviewTag: true
    }
  });

  quickAssistantWindow.setAlwaysOnTop(true, "floating");
  quickAssistantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickAssistantWindow.on("hide", () => {
    hideQuickAssistantDismissWindow();
  });

  quickAssistantWindow.on("blur", () => {
    setTimeout(() => {
      if (
        !quickAssistantWindow ||
        quickAssistantWindow.isDestroyed() ||
        quickAssistantWindow.isFocused()
      ) {
        return;
      }
      quickAssistantWindow.hide();
    }, 120);
  });

  quickAssistantWindow.on("closed", () => {
    quickAssistantWindow = null;
    hideQuickAssistantDismissWindow();
  });

  loadRendererRoute(quickAssistantWindow, QUICK_ASSISTANT_ROUTE).catch((error) => {
    console.error("failed to load quick assistant renderer", error);
  });

  return quickAssistantWindow;
}

function buildLogViewerRoute(request: ServiceOpenLogViewerRequest) {
  const params = new URLSearchParams({
    serviceId: request.serviceId,
    target: request.target,
    title: request.title
  });
  return `${LOG_VIEWER_ROUTE}?${params.toString()}`;
}

function createLogViewerWindow() {
  if (logViewerWindow && !logViewerWindow.isDestroyed()) {
    return logViewerWindow;
  }

  const ownerWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const commonWindowOptions = {
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    ...(ownerWindow ? { parent: ownerWindow, modal: false } : {}),
    title: "ZenMind Logs",
    backgroundColor: "#F6F8FC",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      sandbox: false
    }
  };

  if (process.platform === "darwin") {
    logViewerWindow = new BrowserWindow({
      ...commonWindowOptions,
      skipTaskbar: true,
      transparent: false,
      titleBarStyle: "hidden" as const
    });
  } else if (process.platform === "win32") {
    logViewerWindow = new BrowserWindow({
      ...commonWindowOptions,
      skipTaskbar: false,
      transparent: false
    });
  } else {
    logViewerWindow = new BrowserWindow({
      ...commonWindowOptions,
      skipTaskbar: false,
      transparent: false
    });
  }

  logViewerWindow.once("ready-to-show", () => {
    if (!logViewerWindow || logViewerWindow.isDestroyed()) {
      return;
    }
    logViewerWindow.show();
    logViewerWindow.focus();
  });

  logViewerWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    safeConsoleError("log viewer renderer failed to load", {
      errorCode,
      errorDescription,
      validatedUrl
    });
  });

  logViewerWindow.webContents.on("render-process-gone", (_event, details) => {
    safeConsoleError("log viewer render process exited unexpectedly", details);
  });

  logViewerWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    safeConsoleError("log viewer preload failed", {
      preloadPath,
      error: error?.stack || String(error)
    });
  });

  logViewerWindow.on("closed", () => {
    logViewerWindow = null;
  });

  return logViewerWindow;
}

async function openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
  const targetWindow = createLogViewerWindow();
  const routePath = buildLogViewerRoute(request);
  await loadRendererRoute(targetWindow, routePath);
  if (targetWindow.isDestroyed()) {
    return { ok: false };
  }
  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }
  targetWindow.focus();
  targetWindow.moveTop();
  return { ok: true };
}

function closeLogViewerWindow() {
  if (logViewerWindow && !logViewerWindow.isDestroyed()) {
    logViewerWindow.close();
  }
  return { ok: true };
}

function hideQuickAssistantForNativeDialog() {
  quickAssistantVisibleBeforeNativeDialog = Boolean(
    quickAssistantWindow &&
      !quickAssistantWindow.isDestroyed() &&
      quickAssistantWindow.isVisible()
  );
  if (!quickAssistantVisibleBeforeNativeDialog || !quickAssistantWindow || quickAssistantWindow.isDestroyed()) {
    return;
  }
  quickAssistantWindow.hide();
}

function restoreQuickAssistantAfterNativeDialog() {
  if (!quickAssistantVisibleBeforeNativeDialog) {
    return;
  }
  quickAssistantVisibleBeforeNativeDialog = false;
  if (!quickAssistantWindow || quickAssistantWindow.isDestroyed()) {
    return;
  }
  showQuickAssistantDismissWindow();
  quickAssistantWindow.show();
  quickAssistantWindow.focus();
}

function hideQuickAssistantAfterOutsideFocus() {
  if (!quickAssistantWindow || quickAssistantWindow.isDestroyed() || !quickAssistantWindow.isVisible()) {
    return;
  }
  quickAssistantWindow.hide();
}

function showQuickAssistantWindow() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return;
  }
  const quickSettings = readAssistantSettings(app);
  if (!quickSettings.quickAssistantEnabled) {
    return;
  }
  const targetWindow = createQuickAssistantWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.setBounds(getQuickAssistantWebCopilotBounds({
    workArea: getQuickAssistantWorkArea()
  }), true);
  showQuickAssistantDismissWindow();
  targetWindow.show();
  targetWindow.moveTop();
  targetWindow.focus();
  void runServiceMutation(() => ensureAssistantTargetServicesRunning("quick-assistant"))
    .then((failures) => {
      if (failures.length > 0) {
        showMainWindow("/control-center");
        return;
      }
      scheduleAgentWebclientOpenRequest(targetWindow, {
        chatId: "",
        agentKey: quickSettings.quickAssistantAgentKey,
        focusComposerOnComplete: true
      });
    })
    .catch((error) => {
      console.warn("[quick-assistant] failed to prepare web copilot services", error);
      showMainWindow("/control-center");
    });
}

function toggleQuickAssistantWindow() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return;
  }
  if (quickAssistantWindow && !quickAssistantWindow.isDestroyed() && quickAssistantWindow.isVisible()) {
    quickAssistantWindow.hide();
    return;
  }
  showQuickAssistantWindow();
}

type ScreenshotCaptureSource = "sidebar" | "quick-assistant";

type ScreenshotSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function createScreenshotSelectionHtml(selectionId: string) {
  const doneUrl = `zenmind://screenshot-selection/${selectionId}`;
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;}",
    "body{cursor:crosshair;user-select:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
    "#shade{position:fixed;inset:-2px;background:rgba(15,23,42,.24);pointer-events:none;}",
    "#box{position:fixed;display:none;border:2px solid rgba(59,130,246,.98);background:rgba(59,130,246,.16);box-shadow:0 0 0 9999px rgba(15,23,42,.38),0 12px 30px rgba(15,23,42,.22);}",
    "#hint{position:fixed;left:50%;top:28px;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:rgba(17,24,39,.82);color:#fff;font-size:13px;font-weight:650;letter-spacing:.01em;box-shadow:0 10px 30px rgba(15,23,42,.24);}",
    "</style>",
    "</head>",
    "<body>",
    "<div id=\"shade\" aria-hidden=\"true\"></div>",
    "<div id=\"box\" aria-hidden=\"true\"></div>",
    "<div id=\"hint\">拖拽选择截屏范围，Esc 取消</div>",
    "<script>",
    `const doneUrl=${JSON.stringify(doneUrl)};`,
    "const box=document.getElementById('box');",
    "const hint=document.getElementById('hint');",
    "const minSize=8;",
    "let dragging=false;",
    "let startX=0;",
    "let startY=0;",
    "let currentRect=null;",
    "function clamp(value,min,max){return Math.max(min,Math.min(value,max));}",
    "function finish(action,rect){const params=new URLSearchParams({action});if(rect){params.set('rect',JSON.stringify(rect));}window.location.href=doneUrl+'?'+params.toString();}",
    "function updateBox(clientX,clientY){const endX=clamp(clientX,0,window.innerWidth);const endY=clamp(clientY,0,window.innerHeight);const x=Math.min(startX,endX);const y=Math.min(startY,endY);const width=Math.abs(endX-startX);const height=Math.abs(endY-startY);currentRect={x,y,width,height};box.style.display='block';box.style.left=x+'px';box.style.top=y+'px';box.style.width=width+'px';box.style.height=height+'px';}",
    "window.addEventListener('pointerdown',(event)=>{if(event.button!==0){return;}dragging=true;startX=clamp(event.clientX,0,window.innerWidth);startY=clamp(event.clientY,0,window.innerHeight);currentRect={x:startX,y:startY,width:0,height:0};hint.textContent='松开鼠标完成截屏，Esc 取消';box.style.display='block';updateBox(event.clientX,event.clientY);try{document.body.setPointerCapture(event.pointerId);}catch{}});",
    "window.addEventListener('pointermove',(event)=>{if(!dragging){return;}updateBox(event.clientX,event.clientY);});",
    "window.addEventListener('pointerup',(event)=>{if(!dragging){return;}dragging=false;try{document.body.releasePointerCapture(event.pointerId);}catch{}updateBox(event.clientX,event.clientY);if(!currentRect||currentRect.width<minSize||currentRect.height<minSize){box.style.display='none';hint.textContent='范围太小，请拖拽选择更大的区域，Esc 取消';return;}finish('select',currentRect);});",
    "window.addEventListener('keydown',(event)=>{if(event.key==='Escape'){finish('cancel');}});",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}

function parseScreenshotSelectionUrl(value: string, selectionId: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "zenmind:" ||
      url.hostname !== "screenshot-selection" ||
      url.pathname !== `/${selectionId}`
    ) {
      return undefined;
    }
    if (url.searchParams.get("action") === "cancel") {
      return null;
    }
    const rawRect = url.searchParams.get("rect");
    if (!rawRect) {
      return null;
    }
    const rect = JSON.parse(rawRect) as Partial<ScreenshotSelectionRect>;
    if (
      typeof rect.x !== "number" ||
      typeof rect.y !== "number" ||
      typeof rect.width !== "number" ||
      typeof rect.height !== "number" ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      return null;
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  } catch {
    return undefined;
  }
}

function selectScreenshotRegion(display: Display) {
  return new Promise<ScreenshotSelectionRect | null>((resolve) => {
    const selectionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const overlayWindow = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      ...(process.platform === "darwin" ? { roundedCorners: false } : {}),
      backgroundColor: "#00000000",
      title: "ZenMind Screenshot Selection",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    let settled = false;
    const settle = (rect: ScreenshotSelectionRect | null) => {
      if (settled) {
        return;
      }
      settled = true;
      overlayWindow.webContents.off("will-navigate", handleNavigate);
      if (!overlayWindow.isDestroyed()) {
        overlayWindow.close();
      }
      resolve(rect);
    };
    const handleNavigate = (event: Electron.Event, url: string) => {
      const selection = parseScreenshotSelectionUrl(url, selectionId);
      if (selection === undefined) {
        return;
      }
      event.preventDefault();
      settle(selection);
    };

    if (process.platform === "darwin") {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else if (process.platform === "win32") {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    } else {
      overlayWindow.setAlwaysOnTop(true);
    }

    overlayWindow.webContents.on("will-navigate", handleNavigate);
    overlayWindow.on("closed", () => settle(null));
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createScreenshotSelectionHtml(selectionId))}`)
      .then(() => {
        if (overlayWindow.isDestroyed()) {
          return;
        }
        overlayWindow.show();
        overlayWindow.moveTop();
        overlayWindow.focus();
      })
      .catch(() => settle(null));
  });
}

function getScreenshotPermissionMessage() {
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "denied" || status === "restricted") {
      return "ZenMind 没有屏幕录制权限。请在系统设置 > 隐私与安全性 > 屏幕录制中允许 ZenMind 后重试。";
    }
    return "";
  }
  if (process.platform === "win32") {
    return "";
  }
  return "当前平台暂不支持截屏提问。";
}

function getDisplayThumbnailSize(display: Display) {
  const scaleFactor = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
    ? display.scaleFactor
    : 1;
  if (process.platform === "darwin") {
    return {
      width: Math.max(1, Math.round(display.size.width * scaleFactor)),
      height: Math.max(1, Math.round(display.size.height * scaleFactor))
    };
  }
  if (process.platform === "win32") {
    return {
      width: Math.max(1, Math.round(display.size.width * scaleFactor)),
      height: Math.max(1, Math.round(display.size.height * scaleFactor))
    };
  }
  return {
    width: Math.max(1, Math.round(display.size.width * scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * scaleFactor))
  };
}

function chooseDisplaySource(
  sources: Electron.DesktopCapturerSource[],
  display: Display,
  thumbnailSize: { width: number; height: number }
) {
  const displayId = String(display.id);
  return sources.find((source) => source.display_id === displayId) ??
    sources.find((source) => {
      const size = source.thumbnail.getSize();
      return Math.abs(size.width - thumbnailSize.width) <= 2 &&
        Math.abs(size.height - thumbnailSize.height) <= 2;
    }) ??
    sources[0] ??
    null;
}

async function captureDisplayImage(display: Display) {
  const thumbnailSize = getDisplayThumbnailSize(display);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false
  });
  const source = chooseDisplaySource(sources, display, thumbnailSize);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("没有获取到可用的屏幕截图，请检查系统截屏权限后重试。");
  }
  return source.thumbnail;
}

function intersectRect(a: Rectangle, b: Rectangle): Rectangle | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    return null;
  }
  return {
    x: left,
    y: top,
    width,
    height
  };
}

function getScreenshotSelectionGlobalRect(
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect
): Rectangle {
  return {
    x: displayBounds.x + selection.x,
    y: displayBounds.y + selection.y,
    width: selection.width,
    height: selection.height
  };
}

function getScreenshotWindowFallbackTargets(source: ScreenshotCaptureSource) {
  const targets: BrowserWindow[] = [];
  const addTarget = (targetWindow: BrowserWindow | null) => {
    if (
      targetWindow &&
      !targetWindow.isDestroyed() &&
      targetWindow.isVisible() &&
      !targets.includes(targetWindow)
    ) {
      targets.push(targetWindow);
    }
  };

  if (source === "quick-assistant") {
    addTarget(mainWindow);
    addTarget(quickAssistantWindow);
    return targets;
  }

  addTarget(mainWindow);
  return targets;
}

async function captureWindowSelectionFallback(
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect,
  source: ScreenshotCaptureSource
) {
  const selectionBounds = getScreenshotSelectionGlobalRect(displayBounds, selection);
  for (const targetWindow of getScreenshotWindowFallbackTargets(source)) {
    const contentBounds = targetWindow.getContentBounds();
    const intersection = intersectRect(selectionBounds, contentBounds);
    if (!intersection) {
      continue;
    }
    const captured = await targetWindow.webContents.capturePage({
      x: clampInteger(intersection.x - contentBounds.x, 0, Math.max(0, contentBounds.width - 1)),
      y: clampInteger(intersection.y - contentBounds.y, 0, Math.max(0, contentBounds.height - 1)),
      width: clampInteger(intersection.width, 1, contentBounds.width),
      height: clampInteger(intersection.height, 1, contentBounds.height)
    });
    if (!captured.isEmpty()) {
      return captured;
    }
  }
  return null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.round(value), max));
}

function cropScreenshotImage(
  image: NativeImage,
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect
) {
  const imageSize = image.getSize();
  const ratioX = imageSize.width / Math.max(1, displayBounds.width);
  const ratioY = imageSize.height / Math.max(1, displayBounds.height);
  const x = clampInteger(selection.x * ratioX, 0, Math.max(0, imageSize.width - 1));
  const y = clampInteger(selection.y * ratioY, 0, Math.max(0, imageSize.height - 1));
  const width = clampInteger(selection.width * ratioX, 1, Math.max(1, imageSize.width - x));
  const height = clampInteger(selection.height * ratioY, 1, Math.max(1, imageSize.height - y));
  return image.crop({ x, y, width, height });
}

async function captureScreenshotImage(
  display: Display,
  selection: ScreenshotSelectionRect,
  source: ScreenshotCaptureSource
) {
  let screenCaptureFailure: Error | null = null;
  try {
    const image = await captureDisplayImage(display);
    const cropped = cropScreenshotImage(image, display.bounds, selection);
    if (cropped.isEmpty()) {
      throw new Error("截屏区域为空，请重新选择更大的范围。");
    }
    return cropped;
  } catch (error) {
    screenCaptureFailure = error instanceof Error ? error : new Error(String(error));
  }

  const fallback = await captureWindowSelectionFallback(display.bounds, selection, source);
  if (fallback && !fallback.isEmpty()) {
    return fallback;
  }

  if (process.platform === "darwin" && screenCaptureFailure.message.includes("没有获取到可用的屏幕截图")) {
    throw new Error(
      "没有获取到系统屏幕截图源，也无法从当前 ZenMind 窗口截取该区域。请确认选择范围在 ZenMind 窗口内，或在系统设置 > 隐私与安全性 > 屏幕录制中允许 ZenMind。"
    );
  }

  if (process.platform === "win32" && screenCaptureFailure.message.includes("没有获取到可用的屏幕截图")) {
    throw new Error("没有获取到系统屏幕截图源，也无法从当前 ZenMind 窗口截取该区域，请重新选择窗口内区域后重试。");
  }

  throw screenCaptureFailure;
}

function createScreenshotAttachmentName() {
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/u, "")
    .replace(/[-:T]/gu, "");
  return `screenshot-${timestamp}.png`;
}

async function captureAssistantScreenshot(
  chatId: string | null | undefined,
  source: ScreenshotCaptureSource
) {
  const permissionMessage = getScreenshotPermissionMessage();
  if (permissionMessage) {
    return {
      ok: false,
      chatId: chatId ?? "",
      message: permissionMessage,
      attachments: []
    };
  }

  const shouldRestoreQuickAssistant = source === "quick-assistant" &&
    Boolean(quickAssistantWindow && !quickAssistantWindow.isDestroyed() && quickAssistantWindow.isVisible());
  if (source === "quick-assistant") {
    hideQuickAssistantDismissWindow();
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    await delay(140);
  }

  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const selection = await selectScreenshotRegion(display);
    if (!selection) {
      return {
        ok: false,
        chatId: chatId ?? "",
        message: "已取消截屏。",
        attachments: []
      };
    }

    await delay(80);
    const cropped = await captureScreenshotImage(display, selection, source);
    return createAssistantAttachmentFromImageBuffer(app, chatId, {
      name: createScreenshotAttachmentName(),
      mimeType: "image/png",
      buffer: cropped.toPNG(),
      fallbackBaseName: "screenshot",
      unsupportedMessage: "截屏图片格式暂不支持。",
      readableMessage: "已截取 1 张屏幕图片，图片已进入视觉上下文。",
      oversizedVisionMessage: "截屏已保存，但过大，未发送给模型视觉接口。"
    });
  } catch (error) {
    return {
      ok: false,
      chatId: chatId ?? "",
      message: error instanceof Error ? error.message : String(error),
      attachments: []
    };
  } finally {
    if (source === "quick-assistant") {
      if (shouldRestoreQuickAssistant && quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
        showQuickAssistantDismissWindow();
        quickAssistantWindow.show();
        quickAssistantWindow.focus();
      }
    }
  }
}

function registerQuickAssistantShortcut() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return;
  }
  const registered = globalShortcut.register(QUICK_ASSISTANT_SHORTCUT, toggleQuickAssistantWindow);
  if (!registered) {
    console.warn(`failed to register quick assistant shortcut: ${QUICK_ASSISTANT_SHORTCUT}`);
  }
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

    if (usesServicePreload && !parseSafeFrameMatchUrl(String(params.src || ""))) {
      event.preventDefault();
      safeConsoleError("blocked service webview with unsafe url", {
        src: params.src
      });
      return;
    }

    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
  });

  mainWindow.on("focus", () => {
    if (nativeDialogVisibilityDepth > 0) {
      return;
    }
    hideQuickAssistantAfterOutsideFocus();
  });

  mainWindow.on("enter-full-screen", () => {
    applyMainWindowAppearance(mainWindow);
  });

  mainWindow.on("leave-full-screen", () => {
    applyMainWindowAppearance(mainWindow);
  });

  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
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

    contents.on("render-process-gone", (_guestEvent, details) => {
      safeConsoleError("webview render process exited unexpectedly", {
        guestId: contents.id,
        details
      });
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (resolveWebviewOpenDisposition(url) === "tab") {
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
  for (const targetWindow of [mainWindow, quickAssistantWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("services.changed");
  }
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

function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserSurface {
  return {
    id: BUILTIN_BROWSER_SURFACE_ID,
    label: BUILTIN_BROWSER_SURFACE_LABEL,
    url,
    active: Boolean(contents),
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
        active: Boolean(contents),
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
      return {
        ...surface,
        active: Boolean(resolveEmbeddedCdpWebContents(surface))
      };
    }));
    serviceSurfaces = surfaces.filter((surface): surface is EmbeddedCdpSurface => surface !== null);
  } catch (error) {
    console.warn("[embedded-cdp] failed to list service webview targets", error);
  }

  return [...webviewSurfaces, ...serviceSurfaces];
}

function createEmbeddedCdpServiceSurface(service: ServiceState): EmbeddedCdpSurface | null {
  const webUrl = service.status === "running" ? service.healthMeta.webUrl.trim() : "";
  if (service.frontendMode === "none" || !webUrl || !parseSafeFrameMatchUrl(webUrl)) {
    return null;
  }
  const contents = findWebContentsForSurfaceUrl(webUrl);
  const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
  const snapshotMatchesService = currentPageSnapshot?.pageKind === "webview" && (
    currentPageSnapshot.surfaceId === service.id ||
    snapshotBrowserTarget?.surfaceId === service.id ||
    (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id) ||
    (typeof contents?.id === "number" && snapshotBrowserTarget?.kind === "webview" && snapshotBrowserTarget.webContentsId === contents.id)
  );
  const navigationRoute = snapshotMatchesService
    ? currentPageSnapshot?.navigationRoute || snapshotBrowserTarget?.navigationRoute || currentPageSnapshot?.route
    : "";
  const navigationLabel = snapshotMatchesService
    ? currentPageSnapshot?.navigationLabel || snapshotBrowserTarget?.navigationLabel || currentPageSnapshot?.surfaceLabel
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
    active: Boolean(contents),
    currentUrl: snapshotCurrentUrl || contents?.getURL(),
    title: documentTitle || service.name || service.id,
    webContentsId: contents?.id,
    ...(navigationRoute ? { navigationRoute } : {}),
    ...(navigationLabel ? { navigationLabel } : {}),
    ...(snapshotMatchesService && currentPageSnapshot?.embedPath ? { embedPath: currentPageSnapshot.embedPath } : {})
  };
}

function resolveEmbeddedCdpWebContents(surface: EmbeddedCdpSurface): WebContents | null {
  if (surface.kind === "iframe") {
    return null;
  }
  if (surface.webContentsId) {
    const contents = webContents.fromId(surface.webContentsId);
    if (contents && !contents.isDestroyed() && contents.getType() === "webview") {
      return contents;
    }
  }
  return findWebContentsForSurfaceUrl(surface.currentUrl || surface.url);
}

function resolveEmbeddedCdpFrameTarget(surface: EmbeddedCdpSurface): EmbeddedCdpFrameTarget | null {
  const frameMatchUrl = surface.frameMatchUrl || surface.currentUrl || surface.url;
  const targetUrl = parseSafeFrameMatchUrl(frameMatchUrl);
  if (!targetUrl) {
    return null;
  }

  for (const targetWindow of [mainWindow, quickAssistantWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    const frame = findMatchingWebFrame(collectWebFrames(targetWindow.webContents.mainFrame), targetUrl);
    if (frame) {
      return {
        frame,
        ownerContents: targetWindow.webContents
      };
    }
  }
  return null;
}

async function activateEmbeddedCdpSurface(surface: EmbeddedCdpSurface) {
  if (surface.kind === "iframe") {
    const targetPath = surface.id === "agent-webclient" ? ASSISTANT_TARGET_PATH : `/service/${surface.id}`;
    showMainWindow(targetPath);
    await delay(450);
    return;
  }

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
    resolveFrameTarget: resolveEmbeddedCdpFrameTarget,
    activateSurface: activateEmbeddedCdpSurface,
    openUrl: openEmbeddedCdpUrl,
    version: `ZenMind/${app.getVersion()} Electron/${process.versions.electron}`
  });
  embeddedCdpGateway.start();
  return embeddedCdpGateway;
}

async function openBrowserUrl(input: { url: string; label?: string }) {
  const targetUrl = input.url || BUILTIN_BROWSER_DEFAULT_URL;
  navigateMainWindow(BUILTIN_BROWSER_ROUTE);
  await delay(450);
  mainWindow?.webContents.send("webview.openTab", {
    sourceGuestId: -1,
    url: targetUrl
  });
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
  const openResult = await showAssistantTargetWindow("assistant-worker");
  const targetWindow = openResult.window;
  if (!openResult.ok || !targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const sendOpenAssistantWorker = () => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("app.openAssistantWorker", request);
      scheduleAgentWebclientOpenRequest(targetWindow, {
        chatId: request.chatId ?? "",
        agentKey: request.agentKey ?? request.workerKey ?? "",
        focusComposerOnComplete: request.focusComposerOnComplete !== false
      });
    }
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendOpenAssistantWorker);
    return;
  }

  setTimeout(sendOpenAssistantWorker, 100);
}

function createTrayIcon() {
  const platformIconPath =
    process.platform === "win32"
      ? path.join(
          __dirname,
          "..",
          "..",
          ...APP_ICON_ASSET_DIRECTORIES.buildIcons.split("/"),
          APP_ICON_ASSET_FILENAMES.windowsAppIcon
        )
      : path.join(
          __dirname,
          "..",
          "..",
          ...APP_ICON_ASSET_DIRECTORIES.buildIcons.split("/"),
          APP_ICON_ASSET_FILENAMES.fallbackSmallIcon
        );
  const iconPaths = [
    path.join(
      process.resourcesPath,
      APP_ICON_ASSET_DIRECTORIES.packagedResources,
      APP_ICON_ASSET_FILENAMES.trayIcon
    ),
    path.join(
      __dirname,
      "..",
      "..",
      APP_ICON_ASSET_DIRECTORIES.distRenderer,
      APP_ICON_ASSET_FILENAMES.trayIcon
    ),
    path.join(__dirname, "..", "..", APP_ICON_ASSET_DIRECTORIES.public, APP_ICON_ASSET_FILENAMES.trayIcon),
    platformIconPath,
    path.join(__dirname, "..", "..", APP_ICON_ASSET_DIRECTORIES.public, APP_ICON_ASSET_FILENAMES.brandIcon)
  ];
  const icon =
    iconPaths
      .map((iconPath) => nativeImage.createFromPath(iconPath))
      .find((candidate) => !candidate.isEmpty()) ?? nativeImage.createEmpty();
  const resizedIcon = icon.resize({ width: 20, height: 20 });
  if (process.platform === "darwin") {
    resizedIcon.setTemplateImage(true);
  }
  return resizedIcon;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "和 ZenMind 聊天",
      click: () => {
        void openAssistantWorker({
          displayName: "ZenMind",
          role: "确认对话示例",
          focusComposerOnComplete: true
        });
      }
    },
    {
      label: "打开 ZenMind",
      click: () => {
        void showAssistantTargetWindow("tray-menu");
      }
    },
    {
      label: "设置",
      click: () => showMainWindow("/settings")
    },
    ...(isDesktopPetSupportedPlatform(process.platform)
      ? [
          { type: "separator" as const },
          {
            label: desktopPetSettings.enabled ? "关闭桌面宠物" : "显示桌面宠物",
            click: () => {
              if (desktopPetSettings.enabled) {
                hideDesktopPetWindow(true);
                return;
              }
              showDesktopPetWindow();
            }
          }
        ]
      : []),
    { type: "separator" },
    {
      label: "退出",
      click: () => app.quit()
    }
  ]);
}

function createAppTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("ZenMind");
  if (process.platform !== "darwin") {
    tray.setContextMenu(buildTrayMenu());
  }
  tray.on("click", () => {
    void showAssistantTargetWindow("tray-click");
  });
  tray.on("right-click", () => tray?.popUpContextMenu(buildTrayMenu()));

  return tray;
}

function emitNativeDialogVisibility(open: boolean) {
  const payload = {
    open,
    platform: process.platform
  };

  for (const targetWindow of [mainWindow, quickAssistantWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("app.nativeDialogVisibility", payload);
  }
}

function emitAssistantAttachmentProgress(progress: AssistantAttachmentTaskProgress) {
  for (const targetWindow of [mainWindow, quickAssistantWindow]) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      continue;
    }
    targetWindow.webContents.send("assistant.attachmentProgress", progress);
  }
}

function beginNativeDialogVisibility() {
  if (process.platform !== "darwin") {
    return () => undefined;
  }

  nativeDialogVisibilityDepth += 1;
  if (nativeDialogVisibilityDepth === 1) {
    hideQuickAssistantForNativeDialog();
    emitNativeDialogVisibility(true);
  }

  return () => {
    nativeDialogVisibilityDepth = Math.max(0, nativeDialogVisibilityDepth - 1);
    if (nativeDialogVisibilityDepth === 0) {
      emitNativeDialogVisibility(false);
      restoreQuickAssistantAfterNativeDialog();
    }
  };
}

function waitForNativeDialogLayout() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 16);
  });
}

async function showFileDialog(options: OpenDialogOptions, ownerWindow: BrowserWindow | null = mainWindow) {
  const endNativeDialogVisibility = beginNativeDialogVisibility();
  try {
    if (process.platform === "darwin") {
      // macOS sheets can appear below transparent-window renderer overlays; let the UI hide them first.
      await waitForNativeDialogLayout();
    }
    if (ownerWindow) {
      return await dialog.showOpenDialog(ownerWindow, options);
    }
    return await dialog.showOpenDialog(options);
  } finally {
    endNativeDialogVisibility();
  }
}

async function showSaveDialog(
  options: SaveDialogOptions,
  ownerWindow: BrowserWindow | null = mainWindow
) {
  const endNativeDialogVisibility = beginNativeDialogVisibility();
  try {
    if (process.platform === "darwin") {
      await waitForNativeDialogLayout();
    }
    if (ownerWindow) {
      return await dialog.showSaveDialog(ownerWindow, options);
    }
    return await dialog.showSaveDialog(options);
  } finally {
    endNativeDialogVisibility();
  }
}

async function ensureMacFirstInstallEnvZipImported() {
  if (!requireEnvZipImportAtStartup) {
    return true;
  }

  while (true) {
    const choice = await dialog.showMessageBox({
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
      const retryChoice = await dialog.showMessageBox({
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
      const retryChoice = await dialog.showMessageBox({
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

function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? "设置..." : "设置",
    accelerator: "CmdOrCtrl+,",
    click: () => navigateMainWindow("/settings")
  };

  const template: MenuItemConstructorOptions[] = [
    isMac
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            settingsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" }
          ]
        }
      : {
          label: "File",
          submenu: [settingsItem, { type: "separator" }, { role: "quit" }]
        },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function registerIpcHandlers() {
  const assistantBridge = new AgentPlatformAssistantBridge({
    app,
    getServiceState,
    issueAccessToken: issueAgentAccessToken,
    onEvent: (event) => {
    for (const targetWindow of [mainWindow, quickAssistantWindow]) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("assistant.event", event);
    }
    handleDesktopPetAssistantEvent(event);
    }
  });

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
  ipcMain.handle("assistant.deleteChat", async (_event, chatId: string) => assistantBridge.deleteChat(chatId));
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

  ipcMain.handle("quickAssistant.hide", async () => {
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.openControlCenter", async () => {
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    showMainWindow("/control-center");
    return { ok: true };
  });

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
    return runServiceMutation(() => handlePluginUninstall(app, serviceId, mainWindow));
  });
  ipcMain.handle("plugins.getServiceWebviewPreloadPath", async () => getServiceWebviewPreloadPath());
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
  ipcMain.handle("embeddedWeb.executeInFrame", async (event, request: EmbeddedWebExecuteInFrameRequest) => {
    return executeEmbeddedWebFrameScript(event.sender, request);
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
  ipcMain.handle("settings.setNativeThemeSource", async (_event, themeMode: string) =>
    setNativeThemeSource(themeMode)
  );
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    ensureDarwinDockIdentity();
    if (!(await ensureMacFirstInstallEnvZipImported())) {
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
      if (nativeDialogVisibilityDepth > 0) {
        return;
      }
      showMainWindow();
    });
  });
}

app.on("before-quit", (event) => {
  if (isHandlingQuit) {
    return;
  }
  event.preventDefault();
  isHandlingQuit = true;
  const shutdownStartedAt = Date.now();
  const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(app);
  stopRunningServicesForShutdown(app)
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
      console.log(`[main] app shutdown cleanup finished in ${Date.now() - shutdownStartedAt}ms`);
      app.quit();
    });
});

app.on("will-quit", () => {
  clearDesktopPetIdleResetTimer();
  embeddedCdpGateway?.stop();
  embeddedCdpGateway = null;
  stopAgentPlatformPetStatusClient();
  if (isQuickAssistantSupportedPlatform(process.platform)) {
    globalShortcut.unregister(QUICK_ASSISTANT_SHORTCUT);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isHandlingQuit) {
    app.quit();
  }
});
