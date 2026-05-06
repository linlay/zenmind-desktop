import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
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
  type SaveDialogOptions,
  type WebContents
} from "electron";
import { issueAgentAccessToken } from "./agent-auth";
import { getPanAuthStatus, importPanPrivateKey } from "./pan-auth";
import { loadBuiltinServices } from "./builtin-loader";
import {
  cleanupAgentPlatformRelayForApp,
  captureManagedProcessCleanupSnapshot,
  forceCleanupManagedProcesses,
  getServiceLogsMeta,
  readServiceLog,
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
  stopRunningServices,
  verifyServiceState,
  writeServiceConfig
} from "./service-manager";
import { installPluginFromArchive, loadInstalledPlugins } from "./plugin-loader";
import { handlePluginUninstall } from "./plugin-uninstall";
import {
  importSkillFromPath,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
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
import {
  addCustomSidebarItem,
  exportCustomSidebarItems,
  importCustomSidebarItems,
  listCustomSidebarItems,
  removeCustomSidebarItem
} from "./custom-sidebar-store";
import {
  deleteAssistantChat,
  getAssistantChat,
  listAssistantChats
} from "./assistant/chat-store";
import {
  getAgentPlatformMinimaxSettingsPublic,
  loadAgentPlatformMinimaxSettings
} from "./assistant/agent-platform-config";
import {
  getAssistantSettings,
  readAssistantSettings,
  saveAssistantSettings
} from "./assistant/settings-store";
import {
  clearAssistantMemoryItems,
  deleteAssistantMemoryItem,
  getAssistantMemoryDirectory,
  getAssistantMemorySettings,
  getAssistantMemorySummary,
  getAssistantMemoryStats,
  getAssistantMemoryStorageFromRoot,
  listAssistantMemoryItems,
  saveAssistantMemorySettings
} from "./assistant/memory-store";
import { AssistantRuntime } from "./assistant/runtime";
import { BrowserUseController, type BrowserSurface } from "./assistant/browser-use";
import { SystemChromeController } from "./assistant/system-chrome";
import {
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  resolveAssistantAttachmentPath
} from "./assistant/attachment-store";
import { getService } from "./service-registry";
import type {
  AssistantMemorySettingsInput,
  AssistantSettingsInput,
  AssistantStartRunRequest,
  AssistantSubmitAwaitingRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  AssistantPastedImageInput,
  AssistantWorkerOpenRequest,
  ServiceId,
  ServiceLogReadOptions,
  ServiceLogTarget,
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
import {
  ensureDataRoot,
  getDataRoot,
} from "./user-paths";
import { safeConsoleError } from "./safe-console";
import {
  createQuickAssistantWindowState,
  getQuickAssistantBounds,
  isQuickAssistantMediaPermissionAllowed,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_COMPACT_REQUEST_CHANNEL,
  QUICK_ASSISTANT_ROUTE,
  QUICK_ASSISTANT_SHORTCUT,
  type QuickAssistantDisplayMode
} from "./quick-assistant";

let mainWindow: BrowserWindow | null = null;
let quickAssistantWindow: BrowserWindow | null = null;
let quickAssistantDismissWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isHandlingQuit = false;
let serviceMutationQueue = Promise.resolve();
let nativeDialogVisibilityDepth = 0;
let quickAssistantVisibleBeforeNativeDialog = false;
const quickAssistantState = createQuickAssistantWindowState();
const ASSISTANT_TARGET_PATH = "/plugin/agent-webclient";
const QUICK_ASSISTANT_DISMISS_URL = "zenmind://quick-assistant-dismiss";
const STARTUP_RESTORE_SERVICE_ORDER = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
let startupRestoreState = createStartupRestoreState();

// Keep dev Electron runs on the same data root as packaged builds.
app.setName("ZenMind");
app.setPath("userData", path.join(app.getPath("appData"), "zenmind-desktop"));

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

function getQuickAssistantWorkArea() {
  const cursorPoint = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursorPoint).workArea;
}

function applyQuickAssistantBounds(mode: QuickAssistantDisplayMode = quickAssistantState.getDisplayMode()) {
  if (!quickAssistantWindow || quickAssistantWindow.isDestroyed()) {
    return;
  }
  quickAssistantWindow.setBounds(getQuickAssistantBounds({
    mode,
    workArea: getQuickAssistantWorkArea()
  }), true);
}

function requestQuickAssistantCompactMode(targetWindow: BrowserWindow) {
  const snapshot = quickAssistantState.prepareCompactShow();
  applyQuickAssistantBounds(snapshot.displayMode);
  const sendCompactRequest = () => {
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send(QUICK_ASSISTANT_COMPACT_REQUEST_CHANNEL);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendCompactRequest);
    return;
  }
  sendCompactRequest();
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
    title: "Zman Quick Assistant Dismiss Layer",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
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
    ...getQuickAssistantBounds({
      expanded: false,
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
    title: "Zman Quick Assistant",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  quickAssistantWindow.setAlwaysOnTop(true, "floating");
  quickAssistantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickAssistantWindow.on("hide", () => {
    hideQuickAssistantDismissWindow();
  });

  quickAssistantWindow.on("blur", () => {
    setTimeout(() => {
      const interactionState = quickAssistantState.getInteractionState();
      if (
        !quickAssistantWindow ||
        quickAssistantWindow.isDestroyed() ||
        quickAssistantWindow.isFocused() ||
        interactionState.busy
      ) {
        return;
      }
      quickAssistantWindow.hide();
    }, 120);
  });

  quickAssistantWindow.on("closed", () => {
    quickAssistantWindow = null;
    hideQuickAssistantDismissWindow();
    quickAssistantState.prepareCompactShow();
  });

  loadRendererRoute(quickAssistantWindow, QUICK_ASSISTANT_ROUTE).catch((error) => {
    console.error("failed to load quick assistant renderer", error);
  });

  return quickAssistantWindow;
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
  if (quickAssistantState.getInteractionState().busy) {
    return;
  }
  quickAssistantWindow.hide();
}

function showQuickAssistantWindow() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return;
  }
  const targetWindow = createQuickAssistantWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  requestQuickAssistantCompactMode(targetWindow);
  showQuickAssistantDismissWindow();
  targetWindow.show();
  targetWindow.moveTop();
  targetWindow.focus();
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

function registerQuickAssistantShortcut() {
  if (!isQuickAssistantSupportedPlatform(process.platform)) {
    return;
  }
  const registered = globalShortcut.register(QUICK_ASSISTANT_SHORTCUT, toggleQuickAssistantWindow);
  if (!registered) {
    console.warn(`failed to register quick assistant shortcut: ${QUICK_ASSISTANT_SHORTCUT}`);
  }
}

function setSidebarTranslucency(enabled: boolean) {
  const effective = process.platform === "darwin";
  if (!effective) {
    return {
      ok: true,
      enabled: false,
      effective: false,
      message: "半透明侧边栏仅在 macOS 生效。"
    };
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setVibrancy(enabled ? "under-window" : null);
    mainWindow.setBackgroundColor(enabled ? "#00000000" : "#FFFFFF");
  }

  return {
    ok: true,
    enabled,
    effective: true,
    message: enabled ? "已开启半透明侧边栏。" : "已关闭半透明侧边栏。"
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#FFFFFF",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          transparent: true
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

  mainWindow.on("focus", () => {
    if (nativeDialogVisibilityDepth > 0) {
      return;
    }
    hideQuickAssistantAfterOutsideFocus();
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
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
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
  const targetWindow = getOrCreateMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();

  if (targetPath) {
    navigateMainWindow(targetPath);
  }
}

function notifyServicesChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("services.changed");
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

function navigateMainWindow(targetPath: string) {
  const targetWindow = getOrCreateMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

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
      message: `没有找到匹配的侧边栏入口：${target}`,
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

function openAssistantWorker(request: AssistantWorkerOpenRequest) {
  showMainWindow(ASSISTANT_TARGET_PATH);

  const targetWindow = mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
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

function createTrayIcon() {
  const platformIconPath =
    process.platform === "win32"
      ? path.join(__dirname, "..", "..", "build", "icons", "icon.ico")
      : path.join(__dirname, "..", "..", "build", "icons", "icon-16.png");
  const iconPaths = [
    path.join(__dirname, "..", "..", "dist-renderer", "tray-icon.png"),
    path.join(__dirname, "..", "..", "public", "tray-icon.png"),
    platformIconPath,
    path.join(__dirname, "..", "..", "public", "brand-icon.png")
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
      label: "和 ZenMind助手聊天",
      click: () =>
        openAssistantWorker({
          displayName: "ZenMind助手",
          role: "确认对话示例",
          focusComposerOnComplete: true
        })
    },
    {
      label: "打开 ZenMind",
      click: () => showMainWindow(ASSISTANT_TARGET_PATH)
    },
    {
      label: "设置",
      click: () => showMainWindow("/settings")
    },
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
  const trayMenu = buildTrayMenu();
  tray.setToolTip("ZenMind");
  if (process.platform !== "darwin") {
    tray.setContextMenu(trayMenu);
  }
  tray.on("click", () => showMainWindow(ASSISTANT_TARGET_PATH));
  tray.on("right-click", () => tray?.popUpContextMenu(trayMenu));

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

async function pickAssistantAttachments(chatId: string | null | undefined, ownerWindow: BrowserWindow | null) {
  const result = await showFileDialog({
    title: "选择要给 ZenMind助手读取的附件",
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
  return createAssistantAttachmentsFromFiles(app, chatId, result.filePaths);
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

function registerIpcHandlers() {
  const systemChromeController = new SystemChromeController(app);
  const browserUseController = new BrowserUseController({
    resolveWebContents: (webContentsId) => systemChromeController.resolveWebContents(webContentsId)
  });
  const assistantBrowserUse = {
    listSurfaces: async () => [
      ...listBrowserSurfaces(),
      ...await systemChromeController.listSurfaces()
    ],
    activateSurface: async (target: string) => {
      const embeddedResult = await activateBrowserSurface(target);
      if (embeddedResult.ok) {
        return embeddedResult;
      }
      return systemChromeController.activateSurface(target);
    },
    observePage: (webContentsId: number) => browserUseController.observePage(webContentsId),
    snapshotPage: (webContentsId: number) => browserUseController.snapshotPage(webContentsId),
    click: (webContentsId: number, input: { elementRef?: string; target?: string }) =>
      browserUseController.click(webContentsId, input),
    navigateUrl: (webContentsId: number, input: { url: string; label?: string }) =>
      browserUseController.navigateUrl(webContentsId, input),
    fillFields: (webContentsId: number, fields: Parameters<BrowserUseController["fillFields"]>[1]) =>
      browserUseController.fillFields(webContentsId, fields),
    autofillForm: (webContentsId: number, input?: Parameters<BrowserUseController["autofillForm"]>[1]) =>
      browserUseController.autofillForm(webContentsId, input),
    waitForPageSettle: (webContentsId: number, timeoutMs?: number) =>
      browserUseController.waitForPageSettle(webContentsId, timeoutMs),
    openUrl: (input: { url: string; label?: string }) => systemChromeController.openUrl(input),
    selectOption: (webContentsId: number, input: Parameters<BrowserUseController["selectOption"]>[1]) =>
      browserUseController.selectOption(webContentsId, input),
    setChecked: (webContentsId: number, input: Parameters<BrowserUseController["setChecked"]>[1]) =>
      browserUseController.setChecked(webContentsId, input),
    submit: (webContentsId: number, input?: Parameters<BrowserUseController["submit"]>[1]) =>
      browserUseController.submit(webContentsId, input),
    clickElementByText: (webContentsId: number, target: string) =>
      browserUseController.clickElementByText(webContentsId, target),
    fillBestInput: (webContentsId: number, value: string) =>
      browserUseController.fillBestInput(webContentsId, value),
    fillBestInputAndSubmit: (webContentsId: number, value: string) =>
      browserUseController.fillBestInputAndSubmit(webContentsId, value),
    readPageContext: (webContentsId: number) => browserUseController.readPageContext(webContentsId),
    captureScreenshot: (webContentsId: number) => browserUseController.captureScreenshot(webContentsId),
    readAccessibilitySnapshot: (webContentsId: number) => browserUseController.readAccessibilitySnapshot(webContentsId),
    createRuntimeSnapshot: (webContentsId: number) => browserUseController.createRuntimeSnapshot(webContentsId),
    waitForCondition: (webContentsId: number, condition?: Parameters<BrowserUseController["waitForCondition"]>[1]) =>
      browserUseController.waitForCondition(webContentsId, condition),
    extractPage: (webContentsId: number, extraction: Parameters<BrowserUseController["extractPage"]>[1]) =>
      browserUseController.extractPage(webContentsId, extraction),
    sendCdpCommand: (webContentsId: number, input: { method: string; params?: Record<string, unknown> }) =>
      browserUseController.sendCdpCommand(webContentsId, input)
  };
  const assistantRuntime = new AssistantRuntime(app, (event) => {
    for (const targetWindow of [mainWindow, quickAssistantWindow]) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("assistant.event", event);
    }
  }, assistantBrowserUse, {
    openExternalUrl: async (url) => {
      await shell.openExternal(url);
    },
    renderPdf: renderAssistantPdf,
    services: {
      list: async () => listServices(app),
      control: async (serviceId, operation) => {
        if (operation === "stop") {
          return stopService(app, serviceId);
        }
        if (operation === "restart") {
          return restartService(app, serviceId);
        }
        return handleServiceStart(serviceId);
      }
    },
    resolveContainerHub: async () => {
      const state = await getServiceState(app, "agent-container-hub").catch((error) => {
        return {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          healthMeta: {
            webUrl: "",
            port: null
          }
        };
      });
      if (state.status !== "running") {
        return {
          baseURL: "",
          unavailableReason: state.message || "Container Hub 未运行，请先在控制中心启动容器仓库服务。"
        };
      }
      const verification = await verifyServiceState(app, "agent-container-hub", "running").catch(() => null);
      if (verification && !verification.verified) {
        return {
          baseURL: "",
          unavailableReason: `Container Hub 未通过运行复查：${verification.issues.join("；") || "状态未验证"}`
        };
      }
      const baseURL = state.healthMeta.webUrl || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "");
      return {
        baseURL,
        defaultEnvironmentName: "shell",
        timeoutMs: 30000
      };
    }
  });

  ipcMain.handle("assistant.getSettings", async () => getAgentPlatformMinimaxSettingsPublic(app) ?? getAssistantSettings(app));
  ipcMain.handle("assistant.saveSettings", async (_event, input: AssistantSettingsInput) =>
    saveAssistantSettings(app, input)
  );
  ipcMain.handle("assistant.getMemorySettings", async () => getAssistantMemorySettings(app));
  ipcMain.handle("assistant.saveMemorySettings", async (_event, input: AssistantMemorySettingsInput) =>
    saveAssistantMemorySettings(app, input)
  );
  ipcMain.handle("assistant.getMemorySummary", async () => getAssistantMemorySummary(app));
  ipcMain.handle("assistant.openMemoryDirectory", async () => {
    const directoryPath = getAssistantMemoryDirectory(app);
    fs.mkdirSync(directoryPath, { recursive: true });
    // macOS and Windows both use Electron's shell helper, but keep the platform
    // branch explicit because packaged path/open behavior is platform-sensitive.
    let error = "";
    if (process.platform === "darwin") {
      error = await shell.openPath(directoryPath);
    } else if (process.platform === "win32") {
      error = await shell.openPath(directoryPath);
    } else {
      error = await shell.openPath(directoryPath);
    }
    return {
      ok: !error,
      message: error ? `打开记忆目录失败：${error}` : "已打开助手记忆目录。",
      path: directoryPath
    };
  });
  ipcMain.handle("assistant.listMemoryItems", async () => ({
    items: listAssistantMemoryItems(app),
    settings: getAssistantMemorySettings(app),
    stats: getAssistantMemoryStats(app),
    storage: getAssistantMemoryStorageFromRoot(app.getPath("userData"))
  }));
  ipcMain.handle("assistant.deleteMemoryItem", async (_event, memoryId: string) =>
    deleteAssistantMemoryItem(app, memoryId)
  );
  ipcMain.handle("assistant.clearMemoryItems", async () => clearAssistantMemoryItems(app));
  ipcMain.handle("assistant.listChats", async () => listAssistantChats(app));
  ipcMain.handle("assistant.getChat", async (_event, chatId: string) => getAssistantChat(app, chatId));
  ipcMain.handle("assistant.pickAttachments", async (_event, chatId?: string | null) =>
    pickAssistantAttachments(chatId, mainWindow)
  );
  ipcMain.handle(
    "assistant.addPastedImage",
    async (_event, chatId: string | null | undefined, input: AssistantPastedImageInput) =>
      createAssistantAttachmentFromPastedImage(app, chatId, input)
  );
  ipcMain.handle("assistant.deleteChat", async (_event, chatId: string) => {
    deleteAssistantChat(app, chatId);
    return {
      ok: true,
      message: "已删除对话。"
    };
  });
  ipcMain.handle("assistant.startRun", async (_event, request: AssistantStartRunRequest) =>
    assistantRuntime.startRun(request)
  );
  ipcMain.handle("assistant.stopRun", async (_event, runId: string) => assistantRuntime.stopRun(runId));
  ipcMain.handle("assistant.correctVoiceText", async (_event, request: AssistantVoiceCorrectionRequest) =>
    assistantRuntime.correctVoiceText(request)
  );
  ipcMain.handle("assistant.transcribeVoiceAudio", async (_event, request: AssistantVoiceTranscriptionRequest) =>
    assistantRuntime.transcribeVoiceAudio(request)
  );
  ipcMain.handle("assistant.submitAwaiting", async (_event, request: AssistantSubmitAwaitingRequest) =>
    assistantRuntime.submitAwaiting(request)
  );
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

  ipcMain.handle("quickAssistant.setExpanded", async (_event, expanded: boolean) => {
    if (isQuickAssistantSupportedPlatform(process.platform)) {
      quickAssistantState.setExpanded(Boolean(expanded));
      applyQuickAssistantBounds();
    }
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.setDisplayMode", async (_event, mode: QuickAssistantDisplayMode) => {
    if (isQuickAssistantSupportedPlatform(process.platform)) {
      quickAssistantState.setDisplayMode(mode);
      applyQuickAssistantBounds();
    }
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.pickAttachments", async (_event, chatId?: string | null) =>
    pickAssistantAttachments(chatId, null)
  );
  ipcMain.handle("quickAssistant.setInteractionState", async (_event, state: { busy?: boolean; mouseInside?: boolean }) => {
    quickAssistantState.setInteractionState(state);
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.hide", async () => {
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.openMainAssistant", async (_event, chatId?: string | null) => {
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    openAssistantWorker({
      chatId: chatId ?? undefined,
      displayName: "Zman",
      role: "快速助手",
      focusComposerOnComplete: true
    });
    return { ok: true };
  });
  ipcMain.handle("quickAssistant.openSettings", async () => {
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    showMainWindow("/settings");
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
  ipcMain.handle(
    "services.readLog",
    async (_event, serviceId: ServiceId, target: ServiceLogTarget, options?: ServiceLogReadOptions) => {
      return readServiceLog(app, serviceId, target, options);
    }
  );
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
  ipcMain.handle("customSidebar.add", async (_event, input: { label?: string; url: string }) => {
    return addCustomSidebarItem(app, input);
  });
  ipcMain.handle("customSidebar.remove", async (_event, id: string) => {
    return removeCustomSidebarItem(app, id);
  });
  ipcMain.handle("customSidebar.import", async () => {
    const result = await showFileDialog({
      title: "导入侧边栏配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导入侧边栏配置。"
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
      title: "导出侧边栏配置",
      defaultPath: path.join(getDataRoot(app), "custom-sidebar-items.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导出侧边栏配置。"
      };
    }

    const filePath = saveResult.filePath;
    await fs.promises.writeFile(filePath, `${exportCustomSidebarItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listCustomSidebarItems(app).items,
      path: filePath,
      message: "已导出侧边栏配置。"
    };
  });
  ipcMain.handle("settings.getDataRoot", async () => getDataRoot(app));
  ipcMain.handle("settings.getPlatform", async () => process.platform);
  ipcMain.handle("settings.setSidebarTranslucency", async (_event, enabled: boolean) =>
    setSidebarTranslucency(enabled)
  );
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    ensureDataRoot(app);
    loadBuiltinServices(app);
    loadInstalledPlugins(app);
    registerIpcHandlers();
    configureMediaPermissions();
    createWindow();
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
  const processCleanupSnapshot = captureManagedProcessCleanupSnapshot(app);
  stopRunningServices(app)
    .catch((error) => {
      console.error("failed while shutting down desktop services", error);
    })
    .then(() => forceCleanupManagedProcesses(app, processCleanupSnapshot))
    .catch((error) => {
      console.error("failed while force-cleaning desktop service processes", error);
    })
    .finally(() => {
      try {
        cleanupAgentPlatformRelayForApp(app);
      } catch (error) {
        console.error("failed while cleaning up local code-assistant relay", error);
      }
      app.quit();
    });
});

app.on("will-quit", () => {
  if (isQuickAssistantSupportedPlatform(process.platform)) {
    globalShortcut.unregister(QUICK_ASSISTANT_SHORTCUT);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isHandlingQuit) {
    app.quit();
  }
});
