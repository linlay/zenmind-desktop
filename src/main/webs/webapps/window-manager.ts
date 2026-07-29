import {
  BrowserWindow,
  WebContentsView,
  shell,
  type App,
  type WebContents
} from "electron";
import type {
  WebappCommandResult,
  WebappEntry,
  WebappRuntimeState
} from "../../../shared/contracts";
import { t } from "../../i18n/main-i18n";
import { webappRuntime } from "./runtime";
import { readWebappItems } from "./store";

type WebappWindowRecord = {
  window: BrowserWindow;
  webappView: WebContentsView;
  ownerWindow: BrowserWindow | null;
  gatewayUrl: string;
  suppressRuntimeStop: boolean;
};

function findWebapp(app: App, id: string) {
  const normalizedId = id.trim();
  return readWebappItems(app).find((item) => item.id === normalizedId) ?? null;
}

function fail(item: WebappEntry | null, state: WebappRuntimeState | null, message: string): WebappCommandResult {
  return {
    ok: false,
    item,
    state,
    message
  };
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function isAllowedWebappWindowNavigation(targetUrl: string, gatewayUrl: string) {
  const target = parseHttpUrl(targetUrl);
  const gateway = parseHttpUrl(gatewayUrl);
  return Boolean(target && gateway && target.origin === gateway.origin);
}

export function isSafeWebappExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function resolveOwnerWindow(sender?: WebContents | null) {
  if (!sender || sender.isDestroyed()) {
    return null;
  }
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  return ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildWebappWindowShellHtml(title: string) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="color-scheme" content="light dark">
    <title>${safeTitle}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        background: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #111827; }
      }
    </style>
  </head>
  <body></body>
</html>`;
}

function buildWindowOptions(app: App, item: WebappEntry) {
  const commonOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    title: item.label,
    modal: false,
    backgroundColor: "#FFFFFF",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  };

  if (process.platform === "darwin") {
    return {
      ...commonOptions,
      titleBarStyle: "default" as const
    };
  }
  if (process.platform === "win32") {
    return {
      ...commonOptions,
      autoHideMenuBar: true
    };
  }
  return commonOptions;
}

class WebappWindowManager {
  private readonly windows = new Map<string, WebappWindowRecord>();
  private readonly disposingIds = new Map<string, number>();
  private disposalListener: ((id: string) => void) | null = null;

  setDisposalListener(listener: ((id: string) => void) | null) {
    this.disposalListener = listener;
  }

  has(id: string) {
    const record = this.windows.get(id.trim());
    return Boolean(record && !record.window.isDestroyed());
  }

  openIds() {
    return [...this.windows.entries()]
      .filter(([, record]) => !record.window.isDestroyed())
      .map(([id]) => id);
  }

  beginDisposal(id: string) {
    const normalizedId = id.trim();
    const previousCount = this.disposingIds.get(normalizedId) ?? 0;
    this.disposingIds.set(normalizedId, previousCount + 1);
    if (previousCount === 0) {
      try {
        this.disposalListener?.(normalizedId);
      } catch (error) {
        console.warn(`[webapp-window] failed to announce disposal for ${normalizedId}`, error);
      }
      this.close(normalizedId);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const nextCount = (this.disposingIds.get(normalizedId) ?? 1) - 1;
      if (nextCount <= 0) {
        this.disposingIds.delete(normalizedId);
      } else {
        this.disposingIds.set(normalizedId, nextCount);
      }
    };
  }

  async open(app: App, id: string, sender?: WebContents | null): Promise<WebappCommandResult> {
    const normalizedId = id.trim();
    const item = findWebapp(app, normalizedId);
    if (!item) {
      return fail(null, null, t("webapp.notFound"));
    }
    if (this.disposingIds.has(normalizedId)) {
      return fail(item, webappRuntime.getStatus(app, normalizedId), "WebApp is being removed.");
    }

    const existing = this.windows.get(normalizedId);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) {
        existing.window.restore();
      }
      existing.window.show();
      existing.window.focus();
      existing.window.moveTop();
      return {
        ok: true,
        item,
        state: webappRuntime.getStatus(app, normalizedId),
        message: t("webapp.started", { label: item.label })
      };
    }
    this.windows.delete(normalizedId);

    const command = await webappRuntime.start(app, normalizedId);
    const gatewayUrl = command.state?.webUrl ?? "";
    if (!command.ok || !command.state || !gatewayUrl) {
      return command;
    }

    const ownerWindow = resolveOwnerWindow(sender);
    const targetWindow = new BrowserWindow(buildWindowOptions(app, item));
    const webappView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !app.isPackaged
      }
    });
    const record: WebappWindowRecord = {
      window: targetWindow,
      webappView,
      ownerWindow,
      gatewayUrl,
      suppressRuntimeStop: false
    };
    this.windows.set(normalizedId, record);

    targetWindow.setMenuBarVisibility(false);
    targetWindow.contentView.addChildView(webappView);
    const layoutWebappView = () => {
      if (targetWindow.isDestroyed() || webappView.webContents.isDestroyed()) {
        return;
      }
      const bounds = targetWindow.getContentBounds();
      webappView.setBounds({
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height
      });
    };
    layoutWebappView();
    targetWindow.on("resize", layoutWebappView);
    targetWindow.webContents.on("did-finish-load", layoutWebappView);
    webappView.webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      targetWindow.setTitle(item.label);
    });
    webappView.webContents.on("will-navigate", (event, url) => {
      if (isAllowedWebappWindowNavigation(url, record.gatewayUrl)) {
        return;
      }
      event.preventDefault();
      if (isSafeWebappExternalUrl(url)) {
        void shell.openExternal(url).catch(() => undefined);
      }
    });
    webappView.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebappWindowNavigation(url, record.gatewayUrl)) {
        void webappView.webContents.loadURL(url);
      } else if (isSafeWebappExternalUrl(url)) {
        void shell.openExternal(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    targetWindow.once("ready-to-show", () => {
      if (!targetWindow.isDestroyed()) {
        targetWindow.show();
        targetWindow.focus();
        targetWindow.moveTop();
      }
    });
    targetWindow.on("closed", () => {
      if (!webappView.webContents.isDestroyed()) {
        webappView.webContents.close();
      }
      const current = this.windows.get(normalizedId);
      if (!current || current.window !== targetWindow) {
        return;
      }
      this.windows.delete(normalizedId);
      if (current.suppressRuntimeStop) {
        return;
      }
      void webappRuntime.stop(app, normalizedId).finally(() => {
        if (current.ownerWindow && !current.ownerWindow.isDestroyed()) {
          current.ownerWindow.webContents.send("webs.changed", {
            changedAt: new Date().toISOString()
          });
        }
      });
    });

    try {
      const shellUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(
        buildWebappWindowShellHtml(item.label)
      )}`;
      await Promise.all([
        targetWindow.loadURL(shellUrl),
        webappView.webContents.loadURL(gatewayUrl)
      ]);
      layoutWebappView();
      return command;
    } catch (error) {
      record.suppressRuntimeStop = true;
      this.windows.delete(normalizedId);
      if (!targetWindow.isDestroyed()) {
        targetWindow.destroy();
      }
      const stopped = await webappRuntime.stop(app, normalizedId).catch(() => null);
      return fail(
        item,
        stopped?.state ?? command.state,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  close(id: string) {
    const normalizedId = id.trim();
    const record = this.windows.get(normalizedId);
    if (!record) {
      return;
    }
    record.suppressRuntimeStop = true;
    this.windows.delete(normalizedId);
    if (!record.window.isDestroyed()) {
      record.window.destroy();
    }
  }

  closeAll() {
    const openIds = this.openIds();
    for (const id of openIds) {
      this.close(id);
    }
    return openIds;
  }

  async reload(id: string, state: WebappRuntimeState | null) {
    const record = this.windows.get(id.trim());
    const gatewayUrl = state?.webUrl ?? "";
    if (!record || record.window.isDestroyed() || !gatewayUrl) {
      return;
    }
    record.gatewayUrl = gatewayUrl;
    await record.webappView.webContents.loadURL(gatewayUrl);
  }
}

export const webappWindowManager = new WebappWindowManager();
