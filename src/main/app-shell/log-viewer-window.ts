import { BrowserWindow } from "electron";
import type { ServiceOpenLogViewerRequest } from "../../shared/contracts";

type LogViewerWindowControllerOptions = {
  preloadPath: string;
  routePath: string;
  platform: NodeJS.Platform;
  getOwnerWindow: () => BrowserWindow | null;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
};

export class LogViewerWindowController {
  private readonly options: LogViewerWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: LogViewerWindowControllerOptions) {
    this.options = options;
  }

  async open(request: ServiceOpenLogViewerRequest) {
    const targetWindow = this.createWindow();
    const routePath = this.buildRoute(request);
    await this.options.loadRendererRoute(targetWindow, routePath);
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

  minimize() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.minimize();
    }
    return { ok: true };
  }

  maximize() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window.maximize();
      }
    }
    return { ok: true };
  }


  private buildRoute(request: ServiceOpenLogViewerRequest) {
    const params = new URLSearchParams({
      serviceId: request.serviceId,
      target: request.target,
      title: request.title
    });
    return `${this.options.routePath}?${params.toString()}`;
  }

  private createWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const ownerWindow = this.options.getOwnerWindow();
    const commonWindowOptions = {
      width: 1240,
      height: 860,
      minWidth: 760,
      minHeight: 520,
      show: false,
      frame: false,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      ...(ownerWindow ? { parent: ownerWindow, modal: false } : {}),
      title: "ZenMind Logs",
      backgroundColor: "#F6F8FC",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false
      }
    };

    if (this.options.platform === "darwin") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: true,
        transparent: false,
        titleBarStyle: "hidden" as const
      });
    } else if (this.options.platform === "win32") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false
      });
    } else {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false
      });
    }

    this.window.once("ready-to-show", () => {
      if (!this.window || this.window.isDestroyed()) {
        return;
      }
      this.window.show();
      this.window.focus();
    });

    this.window.on("maximize", () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("log-viewer.maximized", true);
      }
    });

    this.window.on("unmaximize", () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("log-viewer.maximized", false);
      }
    });

    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("log viewer renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("log viewer render process exited unexpectedly", details);
    });

    this.window.webContents.on("preload-error", (_event, preloadPath, error) => {
      this.options.onRendererError("log viewer preload failed", {
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
