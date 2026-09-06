import { BrowserWindow } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

type DesktopActionWorkbenchWindowControllerOptions = {
  preloadPath: string;
  routePath: string;
  platform: NodeJS.Platform;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
};

export class DesktopActionWorkbenchWindowController {
  private readonly options: DesktopActionWorkbenchWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: DesktopActionWorkbenchWindowControllerOptions) {
    this.options = options;
  }

  async open() {
    const existingWindow = this.getWindow();
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
      existingWindow.moveTop();
      return { ok: true };
    }

    const targetWindow = this.createWindow();
    try {
      await this.options.loadRendererRoute(targetWindow, this.options.routePath);
    } catch (error) {
      this.options.onRendererError("desktop action workbench failed to load", {
        error: error instanceof Error ? error.message : String(error)
      });
      if (!targetWindow.isDestroyed()) {
        targetWindow.close();
      }
      throw error;
    }
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
    const targetWindow = this.getWindow();
    if (targetWindow) {
      targetWindow.close();
    }
    return { ok: true };
  }

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private createWindow() {
    const commonWindowOptions: Electron.BrowserWindowConstructorOptions = {
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      show: false,
      frame: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      modal: false,
      title: `${PRODUCT_NAME} Desktop Action Workbench`,
      backgroundColor: "#F6F8FC",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false,
        webSecurity: true
      }
    };

    if (this.options.platform === "darwin") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false,
        titleBarStyle: "default"
      });
    } else if (this.options.platform === "win32") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false,
        autoHideMenuBar: true
      });
    } else {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false
      });
    }

    this.window.setMenuBarVisibility(false);
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    this.window.once("ready-to-show", () => {
      const targetWindow = this.getWindow();
      if (!targetWindow) {
        return;
      }
      targetWindow.show();
      targetWindow.focus();
    });

    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("desktop action workbench renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("desktop action workbench render process exited unexpectedly", details);
    });

    this.window.webContents.on("preload-error", (_event, preloadPath, error) => {
      this.options.onRendererError("desktop action workbench preload failed", {
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
