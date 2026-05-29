import { BrowserWindow } from "electron";

export const DEBUG_VIEWER_ROUTE = "/debug-viewer";

type DebugViewerWindowControllerOptions = {
  preloadPath: string;
  platform: NodeJS.Platform;
  getOwnerWindow: () => BrowserWindow | null;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
};

export class DebugViewerWindowController {
  private readonly options: DebugViewerWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: DebugViewerWindowControllerOptions) {
    this.options = options;
  }

  async open() {
    const targetWindow = this.createWindow();
    await this.options.loadRendererRoute(targetWindow, DEBUG_VIEWER_ROUTE);
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

  close() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    return { ok: true };
  }

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private createWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const ownerWindow = this.options.getOwnerWindow();
    const commonWindowOptions = {
      width: 1320,
      height: 840,
      minWidth: 940,
      minHeight: 620,
      show: false,
      frame: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      ...(ownerWindow ? { parent: ownerWindow, modal: false } : {}),
      title: "ZenMind Debug",
      backgroundColor: "#F7F8FA",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false
      }
    };

    this.window = new BrowserWindow({
      ...commonWindowOptions,
      skipTaskbar: this.options.platform === "darwin",
      transparent: false
    });

    this.window.once("ready-to-show", () => {
      if (!this.window || this.window.isDestroyed()) {
        return;
      }
      this.window.show();
      this.window.focus();
    });

    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("debug viewer renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("debug viewer render process exited unexpectedly", details);
    });

    this.window.webContents.on("preload-error", (_event, preloadPath, error) => {
      this.options.onRendererError("debug viewer preload failed", {
        preloadPath,
        error: error?.stack || String(error)
      });
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    return this.window;
  }
}
