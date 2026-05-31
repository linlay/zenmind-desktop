import { BrowserWindow } from "electron";

export const AGENT_PLATFORM_MONITOR_ROUTE = "/agent-platform-monitor";

type AgentPlatformMonitorWindowControllerOptions = {
  preloadPath: string;
  platform: NodeJS.Platform;
  getOwnerWindow: () => BrowserWindow | null;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
};

export class AgentPlatformMonitorWindowController {
  private readonly options: AgentPlatformMonitorWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: AgentPlatformMonitorWindowControllerOptions) {
    this.options = options;
  }

  async open() {
    const targetWindow = this.createWindow();
    await this.options.loadRendererRoute(targetWindow, AGENT_PLATFORM_MONITOR_ROUTE);
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

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private createWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const ownerWindow = this.options.getOwnerWindow();
    const commonWindowOptions = {
      width: 1180,
      height: 820,
      minWidth: 860,
      minHeight: 560,
      show: false,
      frame: false,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      ...(ownerWindow ? { parent: ownerWindow, modal: false } : {}),
      title: "ZenMind Agent Platform Monitor",
      backgroundColor: "#F7F8FA",
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
        this.window.webContents.send("agent-platform-monitor.maximized", true);
      }
    });

    this.window.on("unmaximize", () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("agent-platform-monitor.maximized", false);
      }
    });

    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("agent platform monitor renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("agent platform monitor render process exited unexpectedly", details);
    });

    this.window.webContents.on("preload-error", (_event, preloadPath, error) => {
      this.options.onRendererError("agent platform monitor preload failed", {
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
