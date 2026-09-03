import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import {
  SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL,
  SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL,
  SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL,
  SELECTION_EXPLAIN_WINDOW_STATE_CHANNEL,
  SELECTION_EXPLAIN_WINDOW_VERSION,
  type SelectionExplainWindowState,
} from "../../shared/selection-explain-window";

type SelectionExplainWindowControllerOptions = {
  platform: NodeJS.Platform;
  preloadPath: string;
  routePath: string;
  title: string;
  loadRendererRoute: (
    targetWindow: BrowserWindow,
    routePath: string,
  ) => Promise<unknown>;
  configureWindow: (targetWindow: BrowserWindow) => void;
  getAnchorWindow: () => BrowserWindow | null;
  onRendererError: (message: string, details: unknown) => void;
};

const SELECTION_EXPLAIN_WINDOW_WIDTH = 760;
const SELECTION_EXPLAIN_WINDOW_HEIGHT = 720;

export function resolveSelectionExplainBottomRightPosition(
  anchorBounds: Rectangle,
  workArea: Rectangle,
  windowBounds: Pick<Rectangle, "width" | "height">,
  platform: NodeJS.Platform,
) {
  const margin = platform === "darwin"
    ? 20
    : platform === "win32"
      ? 16
      : 16;
  const preferredX = anchorBounds.x + anchorBounds.width - windowBounds.width - margin;
  const preferredY = anchorBounds.y + anchorBounds.height - windowBounds.height - margin;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - windowBounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - windowBounds.height);
  return {
    x: Math.min(Math.max(preferredX, workArea.x), maxX),
    y: Math.min(Math.max(preferredY, workArea.y), maxY),
  };
}

export class SelectionExplainWindowController {
  private window: BrowserWindow | null = null;
  private state: SelectionExplainWindowState | null = null;

  constructor(private readonly options: SelectionExplainWindowControllerOptions) {
    ipcMain.removeHandler(SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL);
    ipcMain.removeHandler(SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL);
    ipcMain.removeHandler(SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL);
    ipcMain.handle(SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL, (event) =>
      this.isRenderer(event.sender.id) ? this.state : null
    );
    ipcMain.handle(SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL, (event) => {
      const target = this.getWindow();
      if (!target || target.webContents.id !== event.sender.id) return { ok: false };
      target.minimize();
      return { ok: true };
    });
    ipcMain.handle(SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL, (event) => {
      const target = this.getWindow();
      if (!target || target.webContents.id !== event.sender.id) return { ok: false };
      target.close();
      return { ok: true };
    });
  }

  async update(input:
    | { requestId: string; status: "pending" }
    | { requestId: string; status: "ready"; chatId: string; runId: string }
    | { requestId: string; status: "error"; code: string }
  ) {
    const requestId = String(input.requestId || "").trim();
    if (!requestId) return;
    if (input.status !== "pending" && this.state?.requestId !== requestId) return;
    this.state = input.status === "pending"
      ? { version: SELECTION_EXPLAIN_WINDOW_VERSION, requestId, status: "pending" }
      : input.status === "ready"
        ? {
            version: SELECTION_EXPLAIN_WINDOW_VERSION,
            requestId,
            status: "ready",
            chatId: input.chatId,
            runId: input.runId,
          }
        : {
            version: SELECTION_EXPLAIN_WINDOW_VERSION,
            requestId,
            status: "error",
            code: input.code,
          };
    try {
      const target = await this.ensureWindow();
      this.publishState(target);
      if (target.isMinimized()) target.restore();
      this.positionAtBottomRight(target);
      target.show();
      target.focus();
      target.moveTop();
    } catch (error) {
      this.options.onRendererError("selection explain window failed to open", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  close() {
    this.getWindow()?.close();
  }

  private isRenderer(webContentsId: number) {
    return this.getWindow()?.webContents.id === webContentsId;
  }

  private async ensureWindow() {
    const existing = this.getWindow();
    if (existing) return existing;
    const initialPosition = this.resolveBottomRightPosition({
      width: SELECTION_EXPLAIN_WINDOW_WIDTH,
      height: SELECTION_EXPLAIN_WINDOW_HEIGHT,
    });
    const target = new BrowserWindow({
      width: SELECTION_EXPLAIN_WINDOW_WIDTH,
      height: SELECTION_EXPLAIN_WINDOW_HEIGHT,
      ...initialPosition,
      minWidth: 520,
      minHeight: 420,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: false,
      modal: false,
      skipTaskbar: false,
      title: this.options.title,
      backgroundColor: "#ffffff",
      ...(this.options.platform === "win32" ? { autoHideMenuBar: true } : {}),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        webviewTag: true,
      },
    });
    this.window = target;
    this.options.configureWindow(target);
    target.setMenuBarVisibility(false);
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.once("ready-to-show", () => {
      if (target.isDestroyed()) return;
      this.positionAtBottomRight(target);
      target.show();
      target.focus();
      this.publishState(target);
    });
    target.webContents.on("did-finish-load", () => this.publishState(target));
    target.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("selection explain renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl,
      });
    });
    target.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("selection explain renderer exited unexpectedly", details);
    });
    target.on("closed", () => {
      if (this.window === target) this.window = null;
      this.state = null;
    });
    try {
      await this.options.loadRendererRoute(target, this.options.routePath);
    } catch (error) {
      if (!target.isDestroyed()) target.close();
      throw error;
    }
    return target;
  }

  private resolveBottomRightPosition(windowBounds: Pick<Rectangle, "width" | "height">) {
    const anchor = this.options.getAnchorWindow();
    const anchorBounds = anchor && !anchor.isDestroyed()
      ? anchor.getBounds()
      : null;
    const display = anchorBounds
      ? screen.getDisplayMatching(anchorBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return resolveSelectionExplainBottomRightPosition(
      anchorBounds || display.workArea,
      display.workArea,
      windowBounds,
      this.options.platform,
    );
  }

  private positionAtBottomRight(target: BrowserWindow) {
    if (target.isDestroyed()) return;
    const position = this.resolveBottomRightPosition(target.getBounds());
    target.setPosition(position.x, position.y, false);
  }

  private publishState(target: BrowserWindow) {
    if (!this.state || target.isDestroyed() || target.webContents.isLoadingMainFrame()) return;
    target.webContents.send(SELECTION_EXPLAIN_WINDOW_STATE_CHANNEL, this.state);
  }
}
