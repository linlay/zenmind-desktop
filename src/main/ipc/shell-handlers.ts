import fs from "node:fs";
import {
  shell as electronShell,
  clipboard as electronClipboard,
  BrowserWindow as ElectronBrowserWindow,
  screen as electronScreen
} from "electron";
import type { App, BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { AgentAuthRefreshReason, DesktopLogTarget, ServiceRevealPathOptions } from "../../shared/contracts";
import {
  getAvailableFilePath,
  getDesktopDownloadDefaultPath,
  getPlatformPath
} from "../download-paths";
import { t } from "../i18n/main-i18n";
import { getDesktopLogRoot, readDesktopLog, watchDesktopLog } from "../logs/desktop";
import {
  createLogStreamSubscriptionRegistry,
  type LogStreamSubscriptionRegistry
} from "../logs/subscriptions";
import {
  getTunnelDebugSnapshot,
  inspectIdentityAccessToken,
  probeDesktopWs
} from "../desktop-diagnostics";

type ShellIpcResult = {
  ok: boolean;
  path?: string;
  message?: string;
};

type DesktopScreenshotCaptureResult = {
  ok: boolean;
  message?: string;
  dataBase64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  cancelled?: boolean;
};

const WINDOW_FULLSCREEN_TRANSITION_TIMEOUT_MS = 3000;

type FullScreenTransitionWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isFullScreen" | "off" | "once" | "setFullScreen"
>;

export type WindowFullScreenTransitionResult = {
  ok: boolean;
  isFullScreen: boolean;
  reason?: "transition_timeout" | "window_unavailable";
  message?: string;
};

export function transitionWindowFullScreen(
  targetWindow: FullScreenTransitionWindow,
  enabled: boolean,
  options: {
    platform?: NodeJS.Platform | string;
    timeoutMs?: number;
  } = {}
): Promise<WindowFullScreenTransitionResult> {
  if (targetWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, isFullScreen: false, reason: "window_unavailable" });
  }
  if (targetWindow.isFullScreen() === enabled) {
    return Promise.resolve({ ok: true, isFullScreen: enabled });
  }

  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? WINDOW_FULLSCREEN_TRANSITION_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        if (enabled) {
          targetWindow.off("enter-full-screen", handleTransition);
        } else {
          targetWindow.off("leave-full-screen", handleTransition);
        }
        targetWindow.off("closed", handleClosed);
      } catch {
        // A destroyed BrowserWindow may no longer accept listener changes.
      }
    };
    const finish = (result: WindowFullScreenTransitionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const readActualState = () => {
      if (targetWindow.isDestroyed()) return false;
      try {
        return targetWindow.isFullScreen();
      } catch {
        return false;
      }
    };
    function handleTransition() {
      const isFullScreen = readActualState();
      finish({
        ok: isFullScreen === enabled,
        isFullScreen,
        ...(isFullScreen === enabled ? {} : { reason: "transition_timeout" as const })
      });
    }
    function handleClosed() {
      finish({ ok: false, isFullScreen: false, reason: "window_unavailable" });
    }

    if (enabled) {
      targetWindow.once("enter-full-screen", handleTransition);
    } else {
      targetWindow.once("leave-full-screen", handleTransition);
    }
    targetWindow.once("closed", handleClosed);
    timeout = setTimeout(() => {
      const isFullScreen = readActualState();
      finish({
        ok: isFullScreen === enabled,
        isFullScreen,
        ...(isFullScreen === enabled ? {} : { reason: "transition_timeout" as const })
      });
    }, timeoutMs);

    try {
      targetWindow.setFullScreen(enabled);
      if (platform !== "darwin") {
        const isFullScreen = readActualState();
        if (isFullScreen === enabled) {
          finish({ ok: true, isFullScreen });
        }
      }
    } catch (error) {
      finish({
        ok: false,
        isFullScreen: readActualState(),
        reason: targetWindow.isDestroyed() ? "window_unavailable" : "transition_timeout",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

type ShellIpcOptions = {
  shell?: typeof electronShell;
  clipboard?: typeof electronClipboard;
  BrowserWindow?: Pick<typeof ElectronBrowserWindow, "fromWebContents">;
  screen?: {
    getCursorScreenPoint: () => { x: number; y: number };
  };
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  windowDragForceEndMs?: number;
  app?: {
    getPath: (name: string) => string;
  };
  platform?: NodeJS.Platform | string;
  mainWindow?: BrowserWindow | null;
  getMainWindow?: () => BrowserWindow | null;
  showFileDialog?: (
    options: { title: string; properties: Array<"openDirectory" | "createDirectory"> },
    ownerWindow?: BrowserWindow | null
  ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  revealPathInFileManager?: (
    targetPath: string,
    options: ServiceRevealPathOptions,
    fsOptions: {
      showItemInFolder: (pathToReveal: string) => void;
      openPath: (pathToOpen: string) => Promise<string>;
      platform?: NodeJS.Platform | string;
    }
  ) => Promise<ShellIpcResult>;
  fsAccess?: (filePath: string, mode?: number) => Promise<unknown>;
  fsMkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>;
  fsWriteFile?: (filePath: string, data: Buffer) => Promise<unknown>;
  captureDesktopScreenshot?: () => Promise<DesktopScreenshotCaptureResult> | DesktopScreenshotCaptureResult;
  reportRendererDiagnostic?: (source: string, data: Record<string, unknown>) => void;
  openLogViewerWindow?: (request: {
    source: "desktop";
    serviceId: string;
    target: DesktopLogTarget;
    title: string;
  }) => Promise<{ ok: boolean }> | { ok: boolean };
  issueAgentPlatformAccessToken?: (app: App, reason: AgentAuthRefreshReason) => Promise<{
    ok: boolean;
    token: string;
    message: string;
  }>;
  desktopLogStreamSubscriptions?: LogStreamSubscriptionRegistry;
  setGlobalSearchOverlayVisible?: (visible: boolean) => void;
  setWebviewModalOverlayVisible?: (sourceId: string, visible: boolean) => void;
  setWorkPanelFullscreenActive?: (active: boolean) => void;
};

type DesktopDownloadPayload = {
  filename?: string;
  dataBase64: string;
};

export function registerShellIpcHandlers(ipcMain: Pick<IpcMain, "handle" | "on">, options: ShellIpcOptions) {
  const shell = options.shell || electronShell;
  const clipboard = options.clipboard || electronClipboard;
  const BrowserWindow = options.BrowserWindow || ElectronBrowserWindow;
  const screen = options.screen || electronScreen;
  const runSetInterval = options.setInterval || setInterval;
  const runClearInterval = options.clearInterval || clearInterval;
  const windowDragForceEndMs = typeof options.windowDragForceEndMs === "number"
    ? options.windowDragForceEndMs
    : 8000;
  let windowDragTimer: ReturnType<typeof setInterval> | null = null;
  let windowDragState: {
    ownerWindow: BrowserWindow;
    lastPoint: { x: number; y: number };
    startedAt: number;
  } | null = null;
  const desktopLogStreamSubscriptions = options.desktopLogStreamSubscriptions ?? createLogStreamSubscriptionRegistry();

  function normalizeDesktopLogTarget(value: unknown): DesktopLogTarget {
    if (value === "error" || value === "kanban-ws") {
      return value;
    }
    return "main";
  }

  function getApp() {
    return options.app as App | undefined;
  }

  function getDesktopLogTitle(target: DesktopLogTarget) {
    if (target === "error") return "Desktop Error Log";
    if (target === "kanban-ws") return "Kanban WS Log";
    return "Desktop Main Log";
  }

  function isDesktopDownloadPayload(input: unknown): input is DesktopDownloadPayload {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const payload = input as Record<string, unknown>;
    return typeof payload.dataBase64 === "string";
  }

  function clearWindowDragTimer() {
    if (!windowDragTimer) {
      return;
    }
    runClearInterval(windowDragTimer);
    windowDragTimer = null;
  }

  function endWindowDrag() {
    windowDragState = null;
    clearWindowDragTimer();
    return { ok: true as const };
  }

  function moveOwnerWindowBy(ownerWindow: BrowserWindow, delta: { x: number; y: number }) {
    if (ownerWindow.isDestroyed() || ownerWindow.isFullScreen()) {
      endWindowDrag();
      return false;
    }
    const deltaX = Math.round(delta.x);
    const deltaY = Math.round(delta.y);
    if (deltaX === 0 && deltaY === 0) {
      return true;
    }
    const [currentX, currentY] = ownerWindow.getPosition();
    ownerWindow.setPosition(currentX + deltaX, currentY + deltaY);
    ownerWindow.moveTop();
    return true;
  }

  function tickWindowDrag() {
    if (!windowDragState) {
      clearWindowDragTimer();
      return;
    }
    if (Date.now() - windowDragState.startedAt > windowDragForceEndMs) {
      endWindowDrag();
      return;
    }

    const currentPoint = screen.getCursorScreenPoint();
    const deltaX = currentPoint.x - windowDragState.lastPoint.x;
    const deltaY = currentPoint.y - windowDragState.lastPoint.y;
    windowDragState.lastPoint = currentPoint;
    moveOwnerWindowBy(windowDragState.ownerWindow, { x: deltaX, y: deltaY });
  }

  ipcMain.handle("shell.openExternal", async (_event: IpcMainInvokeEvent, url: string) => {
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

  ipcMain.handle("desktopDialog.selectDirectory", async (event: IpcMainInvokeEvent) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? options.mainWindow;
      const result = await options.showFileDialog?.({
        title: t("shell.chooseProjectDirectory"),
        properties: ["openDirectory", "createDirectory"]
      }, ownerWindow);
      if (!result || result.canceled || result.filePaths.length === 0) {
        return {
          ok: false as const,
          path: "",
          message: t("shell.chooseDirectoryCancelled")
        };
      }
      return {
        ok: true as const,
        path: result.filePaths[0],
        message: t("shell.directorySelected")
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.openPath", async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      return await options.revealPathInFileManager?.(targetPath, { targetType: "directory" }, {
        showItemInFolder: (pathToReveal: string) => shell.showItemInFolder(pathToReveal),
        openPath: (pathToOpen: string) => shell.openPath(pathToOpen),
        platform: options.platform
      });
    } catch (error) {
      return {
        ok: false as const,
        path: typeof targetPath === "string" ? targetPath : "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.revealPath", async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      return await options.revealPathInFileManager?.(targetPath, {
        targetType: "directory",
        directoryAction: "reveal"
      }, {
        showItemInFolder: (pathToReveal: string) => shell.showItemInFolder(pathToReveal),
        openPath: (pathToOpen: string) => shell.openPath(pathToOpen),
        platform: options.platform
      });
    } catch (error) {
      return {
        ok: false as const,
        path: typeof targetPath === "string" ? targetPath : "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  function getAuthorizedMainWindow(event: IpcMainInvokeEvent) {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = options.getMainWindow?.() ?? options.mainWindow ?? null;
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      !mainWindow ||
      ownerWindow !== mainWindow
    ) {
      return null;
    }
    return ownerWindow;
  }

  ipcMain.handle("desktopShell.minimizeWindow", async (event: IpcMainInvokeEvent) => {
    const ownerWindow = getAuthorizedMainWindow(event);
    if (!ownerWindow) {
      return { ok: false as const, message: t("shell.windowUnavailable") };
    }
    ownerWindow.minimize();
    return { ok: true as const };
  });

  ipcMain.handle("desktopShell.toggleWindowMaximize", async (event: IpcMainInvokeEvent) => {
    const ownerWindow = getAuthorizedMainWindow(event);
    if (!ownerWindow) {
      return {
        ok: false as const,
        isMaximized: false,
        message: t("shell.windowUnavailable")
      };
    }
    if (ownerWindow.isMaximized()) {
      ownerWindow.unmaximize();
    } else {
      ownerWindow.maximize();
    }
    return { ok: true as const, isMaximized: ownerWindow.isMaximized() };
  });

  ipcMain.handle("desktopShell.getWindowState", async (event: IpcMainInvokeEvent) => {
    try {
      const ownerWindow = getAuthorizedMainWindow(event);
      if (!ownerWindow) {
        return {
          ok: false as const,
          isFullScreen: false,
          isMaximized: false,
          windowControlsMasked: false,
          message: t("shell.windowUnavailable")
        };
      }
      return {
        ok: true as const,
        isFullScreen: ownerWindow.isFullScreen(),
        isMaximized: ownerWindow.isMaximized(),
        windowControlsMasked: false
      };
    } catch (error) {
      return {
        ok: false as const,
        isFullScreen: false,
        isMaximized: false,
        windowControlsMasked: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.setWindowFullScreen", async (
    event: IpcMainInvokeEvent,
    enabled: unknown
  ) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = options.getMainWindow?.() ?? options.mainWindow ?? null;
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      !mainWindow ||
      ownerWindow !== mainWindow
    ) {
      return {
        ok: false as const,
        isFullScreen: false,
        message: t("shell.windowUnavailable")
      };
    }
    if (typeof enabled !== "boolean") {
      return {
        ok: false as const,
        isFullScreen: ownerWindow.isFullScreen(),
        message: t("shell.invalidFullscreenRequest")
      };
    }

    const result = await transitionWindowFullScreen(ownerWindow, enabled, {
      platform: options.platform
    });
    return result.ok
      ? { ok: true as const, isFullScreen: result.isFullScreen }
      : {
          ok: false as const,
          isFullScreen: result.isFullScreen,
          message: result.message ?? t(result.reason === "transition_timeout"
            ? "shell.windowFullscreenTimeout"
            : "shell.windowUnavailable")
        };
  });

  ipcMain.handle("desktopShell.moveWindowBy", async (event: IpcMainInvokeEvent, delta: unknown) => {
    try {
      const input = delta && typeof delta === "object" ? delta as Record<string, unknown> : {};
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false as const, message: t("shell.invalidDelta") };
      }
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed() || ownerWindow.isFullScreen()) {
        return { ok: false as const, message: t("shell.windowUnavailable") };
      }
      moveOwnerWindowBy(ownerWindow, { x, y });
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.beginWindowDrag", async (event: IpcMainInvokeEvent) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? options.mainWindow;
      if (!ownerWindow || ownerWindow.isDestroyed() || ownerWindow.isFullScreen()) {
        return { ok: false as const, message: t("shell.windowUnavailable") };
      }
      clearWindowDragTimer();
      // Keep the whole drag in Electron's DIP coordinate space. Renderer screenX/screenY
      // can use a different scale on Windows when displays have mixed DPI settings.
      const startPoint = screen.getCursorScreenPoint();
      windowDragState = {
        ownerWindow,
        lastPoint: startPoint,
        startedAt: Date.now()
      };
      windowDragTimer = runSetInterval(tickWindowDrag, 16);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.endWindowDrag", async () => endWindowDrag());

  ipcMain.on("desktopShell.setGlobalSearchOverlayVisible", (_event: IpcMainEvent, visible: unknown) => {
    options.setGlobalSearchOverlayVisible?.(visible === true);
  });

  ipcMain.on("desktopShell.setWebviewModalOverlayVisible", (
    event: IpcMainEvent,
    sourceId: unknown,
    visible: unknown
  ) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = options.getMainWindow?.() ?? options.mainWindow ?? null;
    const normalizedSourceId = typeof sourceId === "string" ? sourceId.trim() : "";
    if (!ownerWindow || ownerWindow !== mainWindow || !normalizedSourceId || normalizedSourceId.length > 200) {
      return;
    }
    options.setWebviewModalOverlayVisible?.(normalizedSourceId, visible === true);
  });

  ipcMain.on("desktopShell.setWorkPanelFullscreenActive", (event: IpcMainEvent, active: unknown) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = options.getMainWindow?.() ?? options.mainWindow ?? null;
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      !mainWindow ||
      ownerWindow !== mainWindow
    ) {
      return;
    }
    options.setWorkPanelFullscreenActive?.(active === true);
  });

  ipcMain.on("desktopShell.requestWindowClose", (event: IpcMainEvent) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = options.getMainWindow?.() ?? options.mainWindow ?? null;
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      !mainWindow ||
      ownerWindow !== mainWindow
    ) {
      return;
    }
    ownerWindow.close();
  });

  ipcMain.handle("clipboard.writeText", async (_event: IpcMainInvokeEvent, text: string) => {
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

  ipcMain.handle("desktopDownloads.saveFile", async (_event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!isDesktopDownloadPayload(input)) {
        return {
          ok: false as const,
          path: "",
          message: t("shell.downloadInvalid")
        };
      }
      const filename = typeof input.filename === "string" ? input.filename : "";
      const dataBase64 = input.dataBase64;
      
      const defaultPath = getDesktopDownloadDefaultPath(options.app, filename, options.platform);
      const downloadPath = await getAvailableFilePath(defaultPath, {
        platform: options.platform,
        fsAccess: options.fsAccess
      });
      const platformPath = getPlatformPath(options.platform);
      
      const fsMkdir = options.fsMkdir || fs.promises.mkdir;
      const fsWriteFile = options.fsWriteFile || fs.promises.writeFile;
      
      await fsMkdir(platformPath.dirname(downloadPath), { recursive: true });
      await fsWriteFile(downloadPath, Buffer.from(dataBase64, "base64"));
      
      return {
        ok: true as const,
        path: downloadPath,
        message: t("shell.downloaded")
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopScreenshot.capture", async () => {
    try {
      if (!options.captureDesktopScreenshot) {
        return {
          ok: false as const,
          message: t("shell.screenshotUnavailable")
        };
      }
      return await options.captureDesktopScreenshot();
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.on("diagnostics.rendererError", (event: IpcMainEvent, report: unknown) => {
    const rendererReport = report && typeof report === "object" ? report as Record<string, unknown> : {};
    const diagnosticLevel =
      rendererReport.level === "debug" ||
      rendererReport.level === "warn" ||
      rendererReport.level === "error"
        ? rendererReport.level
        : "error";
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    options.reportRendererDiagnostic?.("renderer-error", {
      diagnosticLevel,
      windowId: ownerWindow?.id ?? null,
      route: event.sender.getURL(),
      source: typeof rendererReport.source === "string" ? rendererReport.source : "unknown",
      message: typeof rendererReport.message === "string" ? rendererReport.message : String(report),
      details: rendererReport.details && typeof rendererReport.details === "object" ? rendererReport.details : undefined,
      stack: typeof rendererReport.stack === "string" ? rendererReport.stack : undefined,
      componentStack: typeof rendererReport.componentStack === "string" ? rendererReport.componentStack : undefined,
      filename: typeof rendererReport.filename === "string" ? rendererReport.filename : undefined,
      lineno: typeof rendererReport.lineno === "number" ? rendererReport.lineno : undefined,
      colno: typeof rendererReport.colno === "number" ? rendererReport.colno : undefined
    });
  });

  ipcMain.handle("diagnostics.openDesktopLogViewer", async (_event: IpcMainInvokeEvent, targetValue: unknown) => {
    const target = normalizeDesktopLogTarget(targetValue);
    if (!options.openLogViewerWindow) {
      return { ok: false as const };
    }
    return options.openLogViewerWindow({
      source: "desktop",
      serviceId: "desktop",
      target,
      title: getDesktopLogTitle(target)
    });
  });

  ipcMain.handle("diagnostics.revealDesktopLogFolder", async () => {
    const app = getApp();
    if (!app) {
      return {
        ok: false as const,
        path: "",
        message: "Desktop app context is unavailable."
      };
    }
    const logRoot = getDesktopLogRoot(app);
    return options.revealPathInFileManager?.(logRoot, { targetType: "directory" }, {
      showItemInFolder: (pathToReveal: string) => shell.showItemInFolder(pathToReveal),
      openPath: (pathToOpen: string) => shell.openPath(pathToOpen),
      platform: options.platform
    });
  });

  ipcMain.handle("diagnostics.readDesktopLog", async (_event: IpcMainInvokeEvent, targetValue: unknown, opts?: any) => {
    const app = getApp();
    if (!app) {
      throw new Error("Desktop app context is unavailable.");
    }
    return readDesktopLog(app, normalizeDesktopLogTarget(targetValue), opts);
  });

  ipcMain.handle(
    "diagnostics.watchDesktopLog.start",
    async (event: IpcMainInvokeEvent, subscriptionId: string, targetValue: unknown, opts?: any) => {
      const app = getApp();
      if (!app) {
        throw new Error("Desktop app context is unavailable.");
      }
      desktopLogStreamSubscriptions.get(subscriptionId)?.cleanup();
      const ownerContents = event.sender;
      const cleanup = watchDesktopLog(app, subscriptionId, normalizeDesktopLogTarget(targetValue), opts, (payload) => {
        if (ownerContents.isDestroyed()) {
          desktopLogStreamSubscriptions.get(subscriptionId)?.cleanup();
          desktopLogStreamSubscriptions.delete(subscriptionId);
          return;
        }
        ownerContents.send("diagnostics.desktopLogStream", payload);
      });
      desktopLogStreamSubscriptions.set(subscriptionId, { webContentsId: ownerContents.id, cleanup });
      ownerContents.once("destroyed", () => {
        const current = desktopLogStreamSubscriptions.get(subscriptionId);
        if (current != null && current.webContentsId === ownerContents.id) {
          current.cleanup();
          desktopLogStreamSubscriptions.delete(subscriptionId);
        }
      });
      return { ok: true };
    }
  );

  ipcMain.handle("diagnostics.watchDesktopLog.stop", async (event: IpcMainInvokeEvent, subscriptionId: string) => {
    const current = desktopLogStreamSubscriptions.get(subscriptionId);
    if (current && current.webContentsId === event.sender.id) {
      current.cleanup();
      desktopLogStreamSubscriptions.delete(subscriptionId);
    }
    return { ok: true };
  });

  ipcMain.handle("diagnostics.inspectIdentityAccessToken", async (_event: IpcMainInvokeEvent, input?: unknown) => {
    const app = getApp();
    if (!app || !options.issueAgentPlatformAccessToken) {
      return {
        ok: false as const,
        message: "Identity Center access token issuer is unavailable.",
        token: "",
        header: null,
        payload: null,
        claims: {
          subject: "",
          issuer: "",
          audience: "",
          scope: "",
          deviceId: "",
          issuedAt: "",
          expiresAt: "",
          expired: false
        }
      };
    }
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return inspectIdentityAccessToken(app, options.issueAgentPlatformAccessToken, {
      reason: record.reason === "unauthorized" ? "unauthorized" : "missing"
    });
  });

  ipcMain.handle("diagnostics.getTunnelDebugSnapshot", async () => getTunnelDebugSnapshot());

  ipcMain.handle("diagnostics.probeDesktopWs", async (_event: IpcMainInvokeEvent, input?: unknown) => {
    const app = getApp();
    if (!app || !options.issueAgentPlatformAccessToken) {
      return {
        ok: false as const,
        target: "localDebug" as const,
        url: "",
        message: "Identity Center access token issuer is unavailable.",
        frames: []
      };
    }
    return probeDesktopWs(app, options.issueAgentPlatformAccessToken, {
      target: "localDebug"
    });
  });
}
