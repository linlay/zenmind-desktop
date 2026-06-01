import { BrowserWindow } from "electron";

type AgentPlatformMonitorWindowControllerOptions = {
  platform: NodeJS.Platform;
  onRendererError: (message: string, details: unknown) => void;
};

export class AgentPlatformMonitorWindowController {
  private readonly options: AgentPlatformMonitorWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: AgentPlatformMonitorWindowControllerOptions) {
    this.options = options;
  }

  async open(url: string) {
    const targetWindow = this.createWindow();
    try {
      await targetWindow.loadURL(url);
    } catch (error) {
      this.options.onRendererError("agent platform monitor failed to load", {
        url: sanitizeMonitorUrl(url),
        error: error instanceof Error ? error.message : String(error)
      });
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

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private createWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const commonWindowOptions = {
      width: 1180,
      height: 820,
      minWidth: 860,
      minHeight: 560,
      show: false,
      frame: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      title: "ZenMind Agent Platform Monitor",
      backgroundColor: "#F7F8FA",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: true
      }
    };

    if (this.options.platform === "darwin") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: true,
        transparent: false
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

    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("agent platform monitor renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl: sanitizeMonitorUrl(validatedUrl)
      });
    });

    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("agent platform monitor render process exited unexpectedly", details);
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    return this.window;
  }
}

function sanitizeMonitorUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", "<HIDDEN_TOKEN>");
    }
    return url.toString();
  } catch {
    return String(value).replace(/([?&]access_token=)[^&\s]+/iu, "$1<HIDDEN_TOKEN>");
  }
}
