import type { App, BrowserWindow, NativeTheme } from "electron";
import { PRODUCT_NAME } from "../shared/brand";
import {
  DESKTOP_HELP_WEBVIEW_PARTITION,
  isAllowedHelpNavigationUrl,
  isSafeHelpExternalUrl
} from "../shared/help";
import { createInitialLocaleArguments } from "../shared/i18n/initial-locale-args";
import type { LocaleSettings } from "../shared/i18n/types";
import type { DesktopGlobalSearchShortcut } from "../shared/contracts/desktop-api";
import {
  CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL,
  normalizeChatWorkPanelUrl,
} from "../shared/chat-work-panel";
import {
  isBlobSchemeUrl,
  normalizeWebviewBlobPopupForSource,
} from "../shared/webview-popup";
import type { DesktopPlatform } from "./platform-adapter";

const MAC_FULLSCREEN_CLOSE_DELAY_MS = 500;
const MAC_FULLSCREEN_CLOSE_FALLBACK_MS = 2200;
const MAC_TRAFFIC_LIGHT_POSITION = { x: 10, y: 16 };
const WINDOWS_BACKGROUND_LIGHT = "#FFFFFF";
const WINDOWS_BACKGROUND_DARK = "#181818";

type MainWindowLike = Pick<
  BrowserWindow,
  | "destroy"
  | "hide"
  | "isDestroyed"
  | "isFullScreen"
  | "isMaximized"
  | "off"
  | "once"
  | "setBackgroundColor"
  | "setFullScreen"
  | "setVibrancy"
> & Partial<Pick<BrowserWindow, "webContents">>;

type MainWindowActivationLike = Pick<
  BrowserWindow,
  "focus" | "isDestroyed" | "isFullScreen" | "isMinimized" | "restore" | "show"
> & {
  webContents: Pick<BrowserWindow["webContents"], "isLoadingMainFrame" | "once" | "send">;
};

type MainWindowRendererLoadLike = Pick<BrowserWindow, "loadFile" | "loadURL">;

type MainRendererDevToolsContentsLike = Pick<
  BrowserWindow["webContents"],
  "closeDevTools" | "isDevToolsOpened" | "openDevTools"
>;

type MainWindowLifecycleEventsLike = Pick<
  BrowserWindow,
  "focus" | "isDestroyed" | "isFullScreen" | "isMaximized" | "on" | "once" | "show"
> & {
  webContents: MainRendererDevToolsContentsLike &
    Pick<BrowserWindow["webContents"], "on" | "send">;
};

type MainWindowWebContentsLike = {
  isDestroyed(): boolean;
  webContents: MainRendererDevToolsContentsLike & {
    on(eventName: string, listener: (...args: any[]) => void): unknown;
    send(channel: string, payload: unknown): void;
  };
};

type MediaPermissionWindowLike = {
  isDestroyed(): boolean;
  webContents: {
    id: number;
  };
};

type RendererDiagnosticReporter = (source: string, details: Record<string, unknown>) => void;

type MainWindowOptions = ConstructorParameters<typeof BrowserWindow>[0];

type WebviewAttachInput = {
  webPreferences: {
    preload?: unknown;
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
  };
  params: {
    preload?: unknown;
    src?: unknown;
    partition?: unknown;
  };
  servicePreloadPath: string;
  servicePreloadUrl: string;
  isSafeServiceUrl(value: string): unknown;
};

type WebviewAttachResult =
  | { ok: true }
  | { ok: false; reason: "unexpected-preload" | "unsafe-service-url"; preload?: string; src?: string };

type AttachedWebviewLike = {
  id: number;
  session?: unknown;
  getURL(): string;
  isFocused?(): boolean;
  on(eventName: string, listener: (...args: any[]) => void): unknown;
  copy(): void;
  cut(): void;
  downloadURL(url: string): void;
  paste(): void;
  selectAll(): void;
  loadURL(url: string): Promise<unknown>;
  setWindowOpenHandler(handler: (details: {
    url: string;
    referrer?: { url?: string };
  }) => { action: "deny" }): void;
};

type BlobPopupTarget = "desktop-browser" | "work-panel";

type WebviewEditCommand = "copy" | "cut" | "paste" | "selectAll";

function isWorkPanelFullscreenExitShortcut(input: any) {
  return input?.type === "keyDown" &&
    String(input?.key || "").toLowerCase() === "escape" &&
    input?.isAutoRepeat !== true &&
    input?.meta !== true &&
    input?.control !== true &&
    input?.alt !== true &&
    input?.shift !== true;
}

type AttachedWebviewOptions<
  TMainWindow,
  TGuestContents extends AttachedWebviewLike = AttachedWebviewLike
> = {
  platform: DesktopPlatform;
  getMainWindow(): TMainWindow | null;
  isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
  isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
  isWorkPanelCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
  isWorkPanelWebview?(contents: TGuestContents): boolean;
  isWorkPanelFullscreenActive?(): boolean;
  resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
  isGlobalSearchOverlayVisible?(): boolean;
  shouldDownloadUrl(url: string): boolean;
  resolveOpenDisposition(url: string): "download" | "tab" | "blob" | "external";
  collectLoadDiagnostics(contents: TGuestContents, validatedUrl: string): Promise<Record<string, unknown>>;
  report(source: string, details: Record<string, unknown>): void;
  onWebviewNavigation?(url: string, details: { guestId: number; isInPage: boolean; isMainFrame: boolean }): void;
  shouldOpenPopupInWorkPanelTab?(contents: TGuestContents): boolean;
  resolveBlobPopupTarget?(contents: TGuestContents): BlobPopupTarget | null;
  getHelpUrl?(): string;
  isHelpWebview?(contents: TGuestContents): boolean;
  openExternal(url: string): Promise<unknown>;
  schedule(callback: () => void): void;
};

export function buildMainWindowOptions(input: {
  platform: DesktopPlatform;
  preloadPath: string;
  initialLocaleSettings?: LocaleSettings;
  shouldUseDarkColors?: boolean;
  iconPath?: string;
}): MainWindowOptions {
  const initialLocaleArguments = input.initialLocaleSettings
    ? createInitialLocaleArguments(input.initialLocaleSettings)
    : [];
  return {
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: PRODUCT_NAME,
    show: false,
    backgroundColor: input.platform === "darwin"
      ? "#00000000"
      : input.platform === "win32"
        ? resolveWindowsBackgroundColor(input.shouldUseDarkColors ?? false)
        : "#F6F8FC",
    ...(input.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
          // Allow an inactive macOS window to begin a header drag on the first press.
          acceptFirstMouse: true,
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const
        }
      : input.platform === "win32"
        ? {
            // The renderer owns the thin Windows system bar and window controls.
            titleBarStyle: "hidden" as const,
            ...(input.iconPath ? { icon: input.iconPath } : {})
          }
        : {}),
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      ...(initialLocaleArguments.length > 0 ? { additionalArguments: initialLocaleArguments } : {})
    }
  };
}

function resolveWindowsBackgroundColor(shouldUseDarkColors: boolean) {
  return shouldUseDarkColors ? WINDOWS_BACKGROUND_DARK : WINDOWS_BACKGROUND_LIGHT;
}

function toggleMainRendererDevTools(
  contents: MainRendererDevToolsContentsLike
) {
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
    return;
  }

  // Keep the renderer-owned system bar spanning the whole Windows window.
  // Right-docked DevTools would split the inspected renderer horizontally and
  // move its custom window controls away from the window's right edge.
  contents.openDevTools({ mode: "bottom" });
}

export async function loadMainWindowRenderer(
  targetWindow: MainWindowRendererLoadLike,
  options: {
    mode: "dev" | "file";
    rendererEntry: string;
    quit(): void;
    report(message: string, error: unknown): void;
  }
) {
  try {
    if (options.mode === "dev") {
      await targetWindow.loadURL(options.rendererEntry);
      return;
    }

    await targetWindow.loadFile(options.rendererEntry);
  } catch (error) {
    options.report(options.mode === "dev" ? "failed to load dev renderer" : "failed to load renderer file", error);
    options.quit();
  }
}

export function configureMainWindowLifecycleEvents<TWindow extends MainWindowLifecycleEventsLike>(
  targetWindow: TWindow,
  options: {
    platform: DesktopPlatform;
    lifecycle: {
      applyAppearance(targetWindow: TWindow): void;
      hideForClose(targetWindow: TWindow): void;
      cancelPendingClose(): void;
      isGlobalSearchOverlayVisible?(): boolean;
      isWindowControlsMasked?(): boolean;
    };
    isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
    isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
    isWorkPanelCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
    isWorkPanelKeyboardFocusActive?(): boolean;
    resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
    isHandlingQuit(): boolean;
    clearWindow(targetWindow: TWindow): void;
    restoreFloatingWindowsForFullscreen?: () => void;
  }
) {
  function sendWindowState() {
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send("desktopShell.windowStateChanged", {
      isFullScreen: targetWindow.isFullScreen(),
      isMaximized: targetWindow.isMaximized(),
      windowControlsMasked: options.lifecycle.isWindowControlsMasked?.() ?? false
    });
  }

  targetWindow.once("ready-to-show", () => {
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.show();
    targetWindow.focus();
    sendWindowState();
  });

  targetWindow.on("enter-full-screen", () => {
    options.lifecycle.applyAppearance(targetWindow);
    options.restoreFloatingWindowsForFullscreen?.();
    sendWindowState();
  });

  targetWindow.on("leave-full-screen", () => {
    options.lifecycle.applyAppearance(targetWindow);
    options.restoreFloatingWindowsForFullscreen?.();
    sendWindowState();
  });

  targetWindow.on("maximize", sendWindowState);
  targetWindow.on("unmaximize", sendWindowState);

  targetWindow.webContents.on("before-input-event", (event, input) => {
    const globalSearchCommandShortcut = options.lifecycle.isGlobalSearchOverlayVisible?.()
      ? options.resolveGlobalSearchCommandShortcut?.(options.platform, input) ?? null
      : null;
    if (globalSearchCommandShortcut) {
      event.preventDefault();
      targetWindow.webContents.send("app.globalSearchShortcut", globalSearchCommandShortcut);
      return;
    }

    if (options.isGlobalSearchShortcut?.(options.platform, input)) {
      event.preventDefault();
      targetWindow.webContents.send("app.openGlobalSearch", { source: "main" });
      return;
    }

    if (
      options.isWorkPanelKeyboardFocusActive?.() === true &&
      options.isWorkPanelCloseShortcut?.(options.platform, input)
    ) {
      event.preventDefault();
      targetWindow.webContents.send("app.workPanelCloseShortcut", {
        guestId: null,
        workPanelFocused: true
      });
      return;
    }

    if (!options.isDevToolsShortcut(options.platform, input)) {
      return;
    }

    event.preventDefault();
    toggleMainRendererDevTools(targetWindow.webContents);
  });

  targetWindow.on("close", (event) => {
    if (options.isHandlingQuit()) {
      return;
    }
    event.preventDefault();
    if (targetWindow.isDestroyed()) {
      return;
    }
    options.lifecycle.hideForClose(targetWindow);
  });

  targetWindow.on("closed", () => {
    options.lifecycle.cancelPendingClose();
    options.clearWindow(targetWindow);
  });
}

export function configureMainWindowWebContents<
  TMainWindow extends MainWindowWebContentsLike,
  TGuestContents extends AttachedWebviewLike
>(
  targetWindow: TMainWindow,
  options: {
    platform: DesktopPlatform;
    getMainWindow(): TMainWindow | null;
    servicePreloadPath: string;
    servicePreloadUrl: string;
    isSafeServiceUrl(value: string): unknown;
    isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
    isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
    isWorkPanelCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
    isWorkPanelWebview?(contents: TGuestContents): boolean;
    isWorkPanelFullscreenActive?(): boolean;
    resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
    isGlobalSearchOverlayVisible?(): boolean;
    shouldDownloadUrl(url: string): boolean;
    resolveOpenDisposition(url: string): "download" | "tab" | "blob" | "external";
    collectLoadDiagnostics(contents: TGuestContents, validatedUrl: string): Promise<Record<string, unknown>>;
    report(source: string, details: Record<string, unknown>): void;
    onWebviewNavigation?(url: string, details: { guestId: number; isInPage: boolean; isMainFrame: boolean }): void;
    shouldOpenPopupInWorkPanelTab?(contents: TGuestContents): boolean;
    resolveBlobPopupTarget?(contents: TGuestContents): BlobPopupTarget | null;
    attachWebviewContextMenu?(contents: TGuestContents): void;
    onWebviewFocusChanged?(webContentsId: number, focused: boolean): void;
    onMainRendererFocused?(): void;
    getHelpUrl?(): string;
    isHelpWebview?(contents: TGuestContents): boolean;
    openExternal(url: string): Promise<unknown>;
    schedule(callback: () => void): void;
  }
) {
  targetWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    options.report("renderer failed to load", {
      errorCode,
      errorDescription,
      validatedUrl
    });
  });

  targetWindow.webContents.on("render-process-gone", (_event, details) => {
    options.report("renderer process exited unexpectedly", details);
  });

  targetWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    options.report("preload failed", {
      preloadPath,
      error: error?.stack || String(error)
    });
  });

  targetWindow.webContents.on("focus", () => {
    options.onMainRendererFocused?.();
  });

  targetWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const result = prepareWebviewAttachPreferences({
      webPreferences,
      params,
      servicePreloadPath: options.servicePreloadPath,
      servicePreloadUrl: options.servicePreloadUrl,
      isSafeServiceUrl: options.isSafeServiceUrl
    });

    if (!result.ok && result.reason === "unexpected-preload") {
      event.preventDefault();
      options.report("blocked unexpected webview preload", {
        preload: result.preload,
        src: result.src
      });
      return;
    }

    if (!result.ok && result.reason === "unsafe-service-url") {
      event.preventDefault();
      options.report("blocked service webview with unsafe url", {
        src: result.src
      });
      return;
    }

    if (
      params.partition === DESKTOP_HELP_WEBVIEW_PARTITION &&
      options.getHelpUrl &&
      !isAllowedHelpNavigationUrl(
        options.getHelpUrl(),
        typeof params.src === "string" ? params.src : ""
      )
    ) {
      event.preventDefault();
      options.report("blocked Help webview with unexpected url", {
        src: typeof params.src === "string" ? params.src : ""
      });
    }
  });

  targetWindow.webContents.on("did-attach-webview", (_event, contents: TGuestContents) => {
    const publishFocused = () => options.onWebviewFocusChanged?.(contents.id, true);
    const publishBlurred = () => options.onWebviewFocusChanged?.(contents.id, false);
    contents.on("focus", publishFocused);
    contents.on("blur", publishBlurred);
    contents.on("destroyed", publishBlurred);
    if (contents.isFocused?.()) publishFocused();
    options.attachWebviewContextMenu?.(contents);
    configureAttachedWebview(contents, {
      platform: options.platform,
      getMainWindow: options.getMainWindow,
      isDevToolsShortcut: options.isDevToolsShortcut,
      isGlobalSearchShortcut: options.isGlobalSearchShortcut,
      isWorkPanelCloseShortcut: options.isWorkPanelCloseShortcut,
      isWorkPanelWebview: options.isWorkPanelWebview,
      isWorkPanelFullscreenActive: options.isWorkPanelFullscreenActive,
      resolveGlobalSearchCommandShortcut: options.resolveGlobalSearchCommandShortcut,
      isGlobalSearchOverlayVisible: options.isGlobalSearchOverlayVisible,
      shouldDownloadUrl: options.shouldDownloadUrl,
      resolveOpenDisposition: options.resolveOpenDisposition,
      collectLoadDiagnostics: options.collectLoadDiagnostics,
      report: options.report,
      onWebviewNavigation: options.onWebviewNavigation,
      shouldOpenPopupInWorkPanelTab: options.shouldOpenPopupInWorkPanelTab,
      resolveBlobPopupTarget: options.resolveBlobPopupTarget,
      getHelpUrl: options.getHelpUrl,
      isHelpWebview: options.isHelpWebview,
      openExternal: options.openExternal,
      schedule: options.schedule
    });
  });
}

export function configureMediaPermissions<TWindow extends MediaPermissionWindowLike>(options: {
  platform: DesktopPlatform;
  permissionSession: {
    setPermissionRequestHandler(
      handler: (
        contents: { id: number },
        permission: string,
        callback: (granted: boolean) => void,
        details: unknown
      ) => void
    ): void;
  };
  getMainWindow(): TWindow | null;
  askForMicrophoneAccess(): Promise<boolean>;
  isAllowedWebappMicrophoneRequest?: (
    contents: { id: number },
    details: unknown
  ) => boolean;
}) {
  options.permissionSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mainWindow = options.getMainWindow();
    const mainContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
    const mediaTypes = details && typeof details === "object" && "mediaTypes" in details &&
      Array.isArray((details as { mediaTypes?: unknown }).mediaTypes)
      ? (details as { mediaTypes: string[] }).mediaTypes
      : undefined;

    const isMainWindowRequest = contents.id === mainContentsId;
    const isMainWindowAudioRequest = !mediaTypes || mediaTypes.includes("audio");
    const isWebappAudioOnlyRequest = mediaTypes !== undefined &&
      mediaTypes.includes("audio") &&
      !mediaTypes.includes("video");
    const allowed = permission === "media" &&
      (
        (isMainWindowRequest && isMainWindowAudioRequest) ||
        (
          !isMainWindowRequest &&
          isWebappAudioOnlyRequest &&
          options.isAllowedWebappMicrophoneRequest?.(contents, details) === true
        )
      );
    if (!allowed) {
      callback(false);
      return;
    }

    if (options.platform === "darwin") {
      void options.askForMicrophoneAccess()
        .then((granted) => {
          callback(granted);
        })
        .catch(() => {
          callback(false);
        });
      return;
    }

    callback(true);
  });
}

export function prepareWebviewAttachPreferences(input: WebviewAttachInput): WebviewAttachResult {
  const requestedPreload = String(input.webPreferences.preload || input.params.preload || "");
  const src = String(input.params.src || "");
  const usesServicePreload =
    requestedPreload === input.servicePreloadPath || requestedPreload === input.servicePreloadUrl;

  if (requestedPreload && !usesServicePreload) {
    return {
      ok: false,
      reason: "unexpected-preload",
      preload: requestedPreload,
      src
    };
  }

  if (usesServicePreload && !input.isSafeServiceUrl(src)) {
    return {
      ok: false,
      reason: "unsafe-service-url",
      src
    };
  }

  input.webPreferences.nodeIntegration = false;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = (() => {
    try {
      return new URL(src).protocol === `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:`;
    } catch {
      return false;
    }
  })();
  if (usesServicePreload) {
    input.webPreferences.preload = input.servicePreloadPath;
  }
  return { ok: true };
}

function resolveWebviewEditShortcut(
  platform: DesktopPlatform,
  input: any
): WebviewEditCommand | null {
  if (input?.type && input.type !== "keyDown") {
    return null;
  }
  if (input?.alt || input?.shift) {
    return null;
  }

  const hasPlatformModifier = platform === "darwin"
    ? input?.meta === true && input?.control !== true
    : input?.control === true && input?.meta !== true;
  if (!hasPlatformModifier) {
    return null;
  }

  switch (String(input?.key || "").toLowerCase()) {
    case "a":
      return "selectAll";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "x":
      return "cut";
    default:
      return null;
  }
}

function runWebviewEditCommand(
  contents: AttachedWebviewLike,
  command: WebviewEditCommand
) {
  switch (command) {
    case "copy":
      contents.copy();
      return;
    case "cut":
      contents.cut();
      return;
    case "paste":
      contents.paste();
      return;
    case "selectAll":
      contents.selectAll();
      return;
  }
}

export function configureAttachedWebview<
  TMainWindow extends {
  isDestroyed(): boolean;
  webContents: MainRendererDevToolsContentsLike & {
    send(channel: string, payload: unknown): void;
  };
  },
  TGuestContents extends AttachedWebviewLike = AttachedWebviewLike
>(
  contents: TGuestContents,
  options: AttachedWebviewOptions<TMainWindow, TGuestContents>
) {
  const isHelpWebview = options.isHelpWebview?.(contents) === true;
  const downloadFromWebview = (url: string) => {
    try {
      contents.downloadURL(url);
    } catch (error) {
      options.report("failed to start webview download", { url, error });
    }
  };
  const blockUnexpectedHelpNavigation = (event: { preventDefault(): void }, url: string) => {
    if (
      !isHelpWebview ||
      !options.getHelpUrl ||
      isAllowedHelpNavigationUrl(options.getHelpUrl(), url)
    ) {
      return false;
    }
    event.preventDefault();
    if (isSafeHelpExternalUrl(url)) {
      void options.openExternal(url).catch((error) => {
        options.report("failed to open blocked Help navigation externally", { url, error });
      });
    }
    options.report("blocked cross-origin Help navigation", {
      guestId: contents.id,
      url
    });
    return true;
  };

  contents.on("before-input-event", (event, input) => {
    const globalSearchCommandShortcut = options.isGlobalSearchOverlayVisible?.()
      ? options.resolveGlobalSearchCommandShortcut?.(options.platform, input) ?? null
      : null;
    if (globalSearchCommandShortcut) {
      event.preventDefault();
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("app.globalSearchShortcut", globalSearchCommandShortcut);
      return;
    }

    const editCommand = resolveWebviewEditShortcut(options.platform, input);
    if (editCommand) {
      event.preventDefault();
      runWebviewEditCommand(contents, editCommand);
      return;
    }

    if (options.isGlobalSearchShortcut?.(options.platform, input)) {
      event.preventDefault();
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("app.openGlobalSearch", { source: "webview", guestId: contents.id });
      return;
    }

    if (
      options.isWorkPanelWebview?.(contents) === true &&
      options.isWorkPanelFullscreenActive?.() === true &&
      isWorkPanelFullscreenExitShortcut(input)
    ) {
      event.preventDefault();
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("app.workPanelFullscreenExitShortcut", { guestId: contents.id });
      return;
    }

    if (
      options.isWorkPanelWebview?.(contents) === true &&
      options.isWorkPanelCloseShortcut?.(options.platform, input)
    ) {
      event.preventDefault();
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("app.workPanelCloseShortcut", { guestId: contents.id });
      return;
    }

    if (!options.isDevToolsShortcut(options.platform, input)) {
      return;
    }

    event.preventDefault();
    const mainWindow = options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    toggleMainRendererDevTools(mainWindow.webContents);
  });

  contents.on("did-fail-load", (_guestEvent, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (errorCode === -3) {
      return;
    }
    void options.collectLoadDiagnostics(contents, validatedUrl)
      .then((diagnostics) => {
        options.report("webview failed to load", {
          errorCode,
          errorDescription,
          isMainFrame,
          ...diagnostics
        });
      })
      .catch((error) => {
        options.report("webview failed to load", {
          guestId: contents.id,
          errorCode,
          errorDescription,
          validatedUrl,
          isMainFrame,
          diagnosticsError: error instanceof Error ? error.message : String(error)
        });
      });
  });

  contents.on("will-navigate", (event, url) => {
    if (blockUnexpectedHelpNavigation(event, url)) {
      return;
    }

    if (!options.shouldDownloadUrl(url)) {
      return;
    }

    event.preventDefault();
    downloadFromWebview(url);
  });

  contents.on("will-redirect", (event, url) => {
    blockUnexpectedHelpNavigation(event, url);
  });

  contents.on("did-navigate", (_guestEvent, url) => {
    options.onWebviewNavigation?.(url, {
      guestId: contents.id,
      isInPage: false,
      isMainFrame: true
    });
  });

  contents.on("did-navigate-in-page", (_guestEvent, url, isMainFrame) => {
    if (isMainFrame === false) {
      return;
    }
    options.onWebviewNavigation?.(url, {
      guestId: contents.id,
      isInPage: true,
      isMainFrame: true
    });
  });

  contents.on("render-process-gone", (_guestEvent, details) => {
    options.report("webview render process exited unexpectedly", {
      guestId: contents.id,
      details
    });
  });

  contents.setWindowOpenHandler(({ url, referrer }) => {
    if (isBlobSchemeUrl(url)) {
      const normalizedBlobUrl = normalizeWebviewBlobPopupForSource(
        url,
        contents.getURL(),
        referrer?.url,
      );
      const blobTarget = normalizedBlobUrl
        ? options.resolveBlobPopupTarget?.(contents) ?? null
        : null;
      if (normalizedBlobUrl && blobTarget) {
        options.schedule(() => {
          const mainWindow = options.getMainWindow();
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send("webview.openTab", {
            target: blobTarget,
            navigationKind: "blob",
            sourceGuestId: contents.id,
            url: normalizedBlobUrl
          });
        });
      }
      return { action: "deny" };
    }

    if (options.shouldOpenPopupInWorkPanelTab?.(contents)) {
      const nextUrl = normalizeChatWorkPanelUrl(url);
      if (nextUrl) {
        options.schedule(() => {
          const mainWindow = options.getMainWindow();
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send("webview.openTab", {
            target: "work-panel",
            navigationKind: "network",
            sourceGuestId: contents.id,
            url: nextUrl
          });
        });
      }
      return { action: "deny" };
    }

    const disposition = options.resolveOpenDisposition(url);
    if (disposition === "download") {
      downloadFromWebview(url);
      return { action: "deny" };
    }

    if (isHelpWebview) {
      if (isSafeHelpExternalUrl(url)) {
        void options.openExternal(url).catch((error) => {
          options.report("failed to open Help popup externally", { url, error });
        });
      }
      return { action: "deny" };
    }

    if (disposition === "tab") {
      options.schedule(() => {
        const mainWindow = options.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          void options.openExternal(url).catch((error) => {
            options.report("failed to recover webview tab request externally", { url, error });
          });
          return;
        }

        mainWindow.webContents.send("webview.openTab", {
          target: "desktop-browser",
          navigationKind: "network",
          sourceGuestId: contents.id,
          url
        });
      });
      return { action: "deny" };
    }

    void options.openExternal(url).catch((error) => {
      options.report("failed to open external popup url", { url, error });
    });
    return { action: "deny" };
  });
}

export type MainWindowLifecycleControllerOptions<TWindow extends MainWindowLike> = {
  platform: DesktopPlatform;
  getWindow(): TWindow | null;
  createWindow(): TWindow;
  clearWindow(targetWindow: TWindow): void;
  nativeTheme?: Pick<NativeTheme, "shouldUseDarkColors">;
  isSidebarTranslucencyEnabled?: () => boolean;
  reportRendererDiagnostic?: RendererDiagnosticReporter;
};

export function createMainWindowLifecycleController<TWindow extends MainWindowLike>(
  options: MainWindowLifecycleControllerOptions<TWindow>
) {
  let pendingCloseCancel: (() => void) | null = null;
  let globalSearchOverlayVisible = false;
  const webviewModalOverlaySources = new Set<string>();

  function isWindowControlsMasked() {
    return globalSearchOverlayVisible || webviewModalOverlaySources.size > 0;
  }

  function publishWindowState(targetWindow: TWindow | null) {
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.webContents) {
      return;
    }
    targetWindow.webContents.send("desktopShell.windowStateChanged", {
      isFullScreen: targetWindow.isFullScreen(),
      isMaximized: targetWindow.isMaximized(),
      windowControlsMasked: isWindowControlsMasked()
    });
  }

  function cancelPendingClose() {
    pendingCloseCancel?.();
    pendingCloseCancel = null;
  }

  function hideImmediately(targetWindow: TWindow) {
    pendingCloseCancel = null;
    if (targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.hide();
  }

  function hideDarwinForClose(targetWindow: TWindow) {
    if (!targetWindow.isFullScreen()) {
      hideImmediately(targetWindow);
      return;
    }

    cancelPendingClose();

    let completed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let scheduleDestroy: () => void;
    const clearPendingClose = () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      if (!targetWindow.isDestroyed()) {
        targetWindow.off("leave-full-screen", scheduleDestroy);
      }
      pendingCloseCancel = null;
    };
    const scheduleTimer = (callback: () => void, timeoutMs: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, timeoutMs);
      timers.add(timer);
    };
    const destroyWindow = () => {
      if (completed) {
        return;
      }
      completed = true;
      clearPendingClose();
      targetWindow.destroy();
    };
    scheduleDestroy = () => {
      scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_DELAY_MS);
    };

    pendingCloseCancel = () => {
      if (completed) {
        return;
      }
      completed = true;
      clearPendingClose();
    };

    targetWindow.once("leave-full-screen", scheduleDestroy);
    scheduleTimer(destroyWindow, MAC_FULLSCREEN_CLOSE_FALLBACK_MS);
    targetWindow.setFullScreen(false);
  }

  function hideWindowsForClose(targetWindow: TWindow) {
    if (targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }
    hideImmediately(targetWindow);
  }

  function hideForClose(targetWindow: TWindow) {
    if (options.platform === "darwin") {
      hideDarwinForClose(targetWindow);
      return;
    }
    if (options.platform === "win32") {
      hideWindowsForClose(targetWindow);
      return;
    }
    hideImmediately(targetWindow);
  }

  function shouldRecreateDarwinWindowForActivation(targetWindow: TWindow) {
    if (options.platform !== "darwin") {
      return false;
    }
    return Boolean(pendingCloseCancel);
  }

  function discardDarwinWindowForActivation(targetWindow: TWindow) {
    cancelPendingClose();
    if (!targetWindow.isDestroyed()) {
      targetWindow.destroy();
    }
    options.clearWindow(targetWindow);
  }

  function getWindowForActivation() {
    const existingWindow = options.getWindow();
    const activeWindow = existingWindow && !existingWindow.isDestroyed() ? existingWindow : null;
    if (!activeWindow) {
      return options.createWindow();
    }
    if (shouldRecreateDarwinWindowForActivation(activeWindow)) {
      discardDarwinWindowForActivation(activeWindow);
      return options.createWindow();
    }
    return activeWindow;
  }

  function normalizeBeforeShow(targetWindow: TWindow) {
    cancelPendingClose();
    if (options.platform === "darwin") {
      return;
    }
    if (options.platform === "win32" && targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }
  }

  function applyAppearance(targetWindow: TWindow | null) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    if (options.platform === "darwin") {
      const useSidebarTranslucency =
        (options.isSidebarTranslucencyEnabled?.() ?? true) && !targetWindow.isFullScreen();
      targetWindow.setVibrancy(useSidebarTranslucency ? "under-window" : null);
      targetWindow.setBackgroundColor(useSidebarTranslucency ? "#00000000" : "#FFFFFF");
      return;
    }
    if (options.platform === "win32") {
      const shouldUseDarkColors = options.nativeTheme?.shouldUseDarkColors ?? false;
      targetWindow.setBackgroundColor(resolveWindowsBackgroundColor(shouldUseDarkColors));
      return;
    }
    targetWindow.setBackgroundColor("#FFFFFF");
  }

  function setGlobalSearchOverlayVisible(visible: boolean) {
    globalSearchOverlayVisible = visible;
    const targetWindow = options.getWindow();
    applyAppearance(targetWindow);
    publishWindowState(targetWindow);
  }

  function isGlobalSearchOverlayVisible() {
    return globalSearchOverlayVisible;
  }

  function setWebviewModalOverlayVisible(sourceId: string, visible: boolean) {
    const normalizedSourceId = sourceId.trim();
    if (!normalizedSourceId) {
      return;
    }
    if (visible) {
      if (webviewModalOverlaySources.has(normalizedSourceId)) {
        return;
      }
      webviewModalOverlaySources.add(normalizedSourceId);
    } else if (!webviewModalOverlaySources.delete(normalizedSourceId)) {
      return;
    }
    const targetWindow = options.getWindow();
    applyAppearance(targetWindow);
    publishWindowState(targetWindow);
  }

  function attachRendererDiagnostics(targetWindow: TWindow) {
    const reporter = options.reportRendererDiagnostic;
    const contents = targetWindow.webContents;
    if (!reporter || !contents) {
      return;
    }
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level < 2) {
        return;
      }
      reporter("console-message", {
        platform: options.platform,
        level,
        message,
        line,
        sourceId
      });
    });
  }

  return {
    applyAppearance,
    attachRendererDiagnostics,
    cancelPendingClose,
    getWindowForActivation,
    hideForClose,
    isGlobalSearchOverlayVisible,
    isWindowControlsMasked,
    normalizeBeforeShow,
    setGlobalSearchOverlayVisible,
    setWebviewModalOverlayVisible
  };
}

export type MainWindowLifecycleController = ReturnType<typeof createMainWindowLifecycleController>;

export type MainWindowActivationControllerOptions<TWindow extends MainWindowActivationLike> = {
  platform: DesktopPlatform;
  lifecycle: {
    getWindowForActivation(): TWindow | null;
    normalizeBeforeShow(targetWindow: TWindow): void;
  };
  ensureDockIdentity(): void;
  focusApp?: Pick<App, "focus">["focus"];
};

export function createMainWindowActivationController<TWindow extends MainWindowActivationLike>(
  options: MainWindowActivationControllerOptions<TWindow>
) {
  function activateMainWindow() {
    const targetWindow = options.lifecycle.getWindowForActivation();
    if (!targetWindow || targetWindow.isDestroyed()) {
      return null;
    }

    options.lifecycle.normalizeBeforeShow(targetWindow);

    if (options.platform === "darwin" && targetWindow.isFullScreen()) {
      options.focusApp?.({ steal: true });
      targetWindow.focus();
      return targetWindow;
    }

    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.show();
    targetWindow.focus();
    return targetWindow;
  }

  function sendNavigationAfterLoad(targetWindow: TWindow, targetPath: string) {
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

  function navigateMainWindow(targetPath: string) {
    const targetWindow = activateMainWindow();
    if (!targetWindow) {
      return;
    }

    sendNavigationAfterLoad(targetWindow, targetPath);
  }

  function showMainWindow(targetPath?: string) {
    options.ensureDockIdentity();
    const targetWindow = activateMainWindow();
    if (!targetWindow || !targetPath) {
      return;
    }

    sendNavigationAfterLoad(targetWindow, targetPath);
  }

  return {
    navigateMainWindow,
    showMainWindow
  };
}
