import type { App, BrowserWindow as BrowserWindowType } from "electron";
import { BrowserWindow, screen } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";
import { readAssistantSettings } from "../core/settings-store";
import {
  getQuickAssistantWebCopilotBounds,
  isQuickAssistantSupportedPlatform,
  QUICK_ASSISTANT_ROUTE
} from "./quick-copilot";
import {
  getQuickCopilotDismissHtml,
  QUICK_COPILOT_DISMISS_URL
} from "./dismiss-layer";

type QuickCopilotOpenRequest = {
  chatId: string;
  agentKey: string;
  focusComposerOnComplete: boolean;
};

type QuickCopilotWindowControllerOptions = {
  app: App;
  platform: () => NodeJS.Platform | string;
  preloadPath: string;
  loadRendererRoute: (targetWindow: BrowserWindowType, routePath: string) => Promise<void>;
  prepareServices: () => Promise<string[]>;
  showControlCenter: () => void;
  openAgent: (targetWindow: BrowserWindowType, request: QuickCopilotOpenRequest) => void;
};

export class QuickCopilotWindowController {
  private quickWindow: BrowserWindowType | null = null;
  private dismissWindow: BrowserWindowType | null = null;
  private visibleBeforeNativeDialog = false;

  constructor(private readonly options: QuickCopilotWindowControllerOptions) {}

  isSupported() {
    return isQuickAssistantSupportedPlatform(this.options.platform());
  }

  getWindow() {
    return this.quickWindow;
  }

  private getWorkArea() {
    const cursorPoint = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(cursorPoint).workArea;
  }

  private createDismissWindow() {
    if (!this.isSupported()) {
      return null;
    }
    if (this.dismissWindow && !this.dismissWindow.isDestroyed()) {
      return this.dismissWindow;
    }

    this.dismissWindow = new BrowserWindow({
      ...this.getWorkArea(),
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
      title: `${PRODUCT_NAME} Quick Assistant Dismiss Layer`,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false
      }
    });

    this.dismissWindow.setAlwaysOnTop(true, "floating");
    this.dismissWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.dismissWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(QUICK_COPILOT_DISMISS_URL)) {
        return;
      }
      event.preventDefault();
      this.hideAfterOutsideFocus();
    });
    this.dismissWindow.on("closed", () => {
      this.dismissWindow = null;
    });
    void this.dismissWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getQuickCopilotDismissHtml())}`);

    return this.dismissWindow;
  }

  showDismissWindow() {
    const dismissWindow = this.createDismissWindow();
    if (!dismissWindow || dismissWindow.isDestroyed()) {
      return;
    }
    dismissWindow.setBounds(this.getWorkArea(), true);
    dismissWindow.showInactive();
  }

  hideDismissWindow() {
    if (!this.dismissWindow || this.dismissWindow.isDestroyed() || !this.dismissWindow.isVisible()) {
      return;
    }
    this.dismissWindow.hide();
  }

  private createWindow() {
    if (!this.isSupported()) {
      return null;
    }
    if (this.quickWindow && !this.quickWindow.isDestroyed()) {
      return this.quickWindow;
    }

    this.quickWindow = new BrowserWindow({
      ...getQuickAssistantWebCopilotBounds({
        workArea: this.getWorkArea()
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
      title: `${PRODUCT_NAME} Quick Assistant`,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false,
        webviewTag: true
      }
    });

    this.quickWindow.setAlwaysOnTop(true, "floating");
    this.quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.quickWindow.on("hide", () => {
      this.hideDismissWindow();
    });

    this.quickWindow.on("blur", () => {
      setTimeout(() => {
        if (
          !this.quickWindow ||
          this.quickWindow.isDestroyed() ||
          this.quickWindow.isFocused()
        ) {
          return;
        }
        this.quickWindow.hide();
      }, 120);
    });

    this.quickWindow.on("closed", () => {
      this.quickWindow = null;
      this.hideDismissWindow();
    });

    this.options.loadRendererRoute(this.quickWindow, QUICK_ASSISTANT_ROUTE).catch((error) => {
      console.error("failed to load quick assistant renderer", error);
    });

    return this.quickWindow;
  }

  hideForNativeDialog() {
    this.visibleBeforeNativeDialog = Boolean(
      this.quickWindow &&
        !this.quickWindow.isDestroyed() &&
        this.quickWindow.isVisible()
    );
    if (!this.visibleBeforeNativeDialog || !this.quickWindow || this.quickWindow.isDestroyed()) {
      return;
    }
    this.quickWindow.hide();
  }

  restoreAfterNativeDialog() {
    if (!this.visibleBeforeNativeDialog) {
      return;
    }
    this.visibleBeforeNativeDialog = false;
    if (!this.quickWindow || this.quickWindow.isDestroyed()) {
      return;
    }
    this.showDismissWindow();
    this.quickWindow.show();
    this.quickWindow.focus();
  }

  hideAfterOutsideFocus() {
    if (!this.quickWindow || this.quickWindow.isDestroyed() || !this.quickWindow.isVisible()) {
      return;
    }
    this.quickWindow.hide();
  }

  showWindow() {
    if (!this.isSupported()) {
      return;
    }
    const quickSettings = readAssistantSettings(this.options.app);
    if (!quickSettings.quickAssistantEnabled) {
      return;
    }
    const targetWindow = this.createWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.setBounds(getQuickAssistantWebCopilotBounds({
      workArea: this.getWorkArea()
    }), true);
    this.showDismissWindow();
    targetWindow.show();
    targetWindow.moveTop();
    targetWindow.focus();
    void this.options.prepareServices()
      .then((failures) => {
        if (failures.length > 0) {
          this.options.showControlCenter();
          return;
        }
        this.options.openAgent(targetWindow, {
          chatId: "",
          agentKey: quickSettings.quickAssistantAgentKey,
          focusComposerOnComplete: true
        });
      })
      .catch((error) => {
        console.warn("[quick-assistant] failed to prepare web copilot services", error);
        this.options.showControlCenter();
      });
  }

  toggleWindow() {
    if (!this.isSupported()) {
      return;
    }
    if (this.quickWindow && !this.quickWindow.isDestroyed() && this.quickWindow.isVisible()) {
      this.quickWindow.hide();
      return;
    }
    this.showWindow();
  }

  hide() {
    if (this.quickWindow && !this.quickWindow.isDestroyed()) {
      this.quickWindow.hide();
    }
    return { ok: true };
  }

  openControlCenter() {
    this.hide();
    this.options.showControlCenter();
    return { ok: true };
  }
}
