import type { App, BrowserWindow, NativeTheme } from "electron";

import { PRODUCT_NAME } from "../../../shared/brand";

import {
  DESKTOP_HELP_WEBVIEW_PARTITION,
  isAllowedHelpNavigationUrl,
  isSafeHelpExternalUrl
} from "../../../shared/help";

import { createInitialLocaleArguments } from "../../../shared/i18n/initial-locale-args";

import type { LocaleSettings } from "../../../shared/i18n/types";

import type { DesktopGlobalSearchShortcut } from "../../../shared/contracts/desktop-api";

import {
  CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL,
  normalizeChatWorkPanelUrl,
} from "../../../shared/chat-work-panel";

import {
  isBlobSchemeUrl,
  normalizeWebviewBlobPopupForSource,
} from "../../../shared/webview-popup";

import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";

import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";

export const MAC_FULLSCREEN_CLOSE_DELAY_MS = 500;

export const MAC_FULLSCREEN_CLOSE_FALLBACK_MS = 2200;

export const MAC_TRAFFIC_LIGHT_POSITION = { x: 10, y: 13 };

export const WINDOWS_BACKGROUND_LIGHT = "#FFFFFF";

export const WINDOWS_BACKGROUND_DARK = "#181818";

export type MainWindowLike = Pick<
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

export type MainWindowActivationLike = Pick<
  BrowserWindow,
  "focus" | "isDestroyed" | "isFullScreen" | "isMinimized" | "restore" | "show"
> & {
  webContents: Pick<BrowserWindow["webContents"], "isLoadingMainFrame" | "once" | "send">;
};

export type MainWindowRendererLoadLike = Pick<BrowserWindow, "loadFile" | "loadURL">;

export type MainRendererDevToolsContentsLike = Pick<
  BrowserWindow["webContents"],
  "closeDevTools" | "isDevToolsOpened" | "openDevTools"
>;

export type MainWindowLifecycleEventsLike = Pick<
  BrowserWindow,
  "focus" | "isDestroyed" | "isFullScreen" | "isMaximized" | "on" | "once" | "show"
> & {
  webContents: MainRendererDevToolsContentsLike &
    Pick<BrowserWindow["webContents"], "on" | "send">;
};

export type MainWindowWebContentsLike = {
  isDestroyed(): boolean;
  webContents: MainRendererDevToolsContentsLike & {
    on(eventName: string, listener: (...args: any[]) => void): unknown;
    send(channel: string, payload: unknown): void;
  };
};

export type MediaPermissionWindowLike = {
  isDestroyed(): boolean;
  webContents: {
    id: number;
  };
};

export type RendererDiagnosticReporter = (source: string, details: Record<string, unknown>) => void;

export type MainWindowOptions = ConstructorParameters<typeof BrowserWindow>[0];

export type WebviewAttachInput = {
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
  isReviewableLocalFileUrl?(value: string): boolean;
};

export type WebviewAttachResult =
  | { ok: true }
  | {
      ok: false;
      reason: "unexpected-preload" | "unsafe-service-url" | "unsafe-review-url";
      preload?: string;
      src?: string;
    };

export type AttachedWebviewLike = {
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

export type BlobPopupTarget = "desktop-browser" | "work-panel";

export type WebviewEditCommand = "copy" | "cut" | "paste" | "selectAll";

export function isWorkPanelFullscreenExitShortcut(input: any) {
  return input?.type === "keyDown" &&
    String(input?.key || "").toLowerCase() === "escape" &&
    input?.isAutoRepeat !== true &&
    input?.meta !== true &&
    input?.control !== true &&
    input?.alt !== true &&
    input?.shift !== true;
}

export type AttachedWebviewOptions<
  TMainWindow,
  TGuestContents extends AttachedWebviewLike = AttachedWebviewLike
> = {
  platform: DesktopPlatform;
  getMainWindow(): TMainWindow | null;
  isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
  isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
  isWorkPanelCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
  isWorkPanelWebview?(contents: TGuestContents): boolean;
  isMainChatWebview?(contents: TGuestContents): boolean;
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

export function applyWindowsDevelopmentAppDetails(
  targetWindow: Pick<BrowserWindow, "setAppDetails">,
  input: {
    platform: DesktopPlatform;
    appId: string;
    iconPath?: string;
  }
) {
  if (input.platform !== "win32" || !input.iconPath) {
    return;
  }
  targetWindow.setAppDetails({
    appId: input.appId,
    appIconPath: input.iconPath,
    appIconIndex: 0
  });
}

export function resolveWindowsBackgroundColor(shouldUseDarkColors: boolean) {
  return shouldUseDarkColors ? WINDOWS_BACKGROUND_DARK : WINDOWS_BACKGROUND_LIGHT;
}

export function toggleMainRendererDevTools(
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
    resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
    isHandlingQuit(): boolean;
    requestAppQuit(): void;
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

    if (options.isWorkPanelCloseShortcut?.(options.platform, input)) {
      event.preventDefault();
      targetWindow.webContents.send("app.workPanelCloseShortcut", {
        guestId: null,
        fallbackToWindowClose: true
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
    if (options.platform === "win32") {
      options.requestAppQuit();
      return;
    }
    options.lifecycle.hideForClose(targetWindow);
  });

  targetWindow.on("closed", () => {
    options.lifecycle.cancelPendingClose();
    options.clearWindow(targetWindow);
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
  const reviewPreloadPath = input.servicePreloadPath.replace(
    /service-webview\.js$/u,
    "work-panel-preview.js",
  );
  const reviewPreloadUrl = input.servicePreloadUrl.replace(
    /service-webview\.js$/u,
    "work-panel-preview.js",
  );
  const usesServicePreload =
    requestedPreload === input.servicePreloadPath || requestedPreload === input.servicePreloadUrl;
  const usesReviewPreload =
    requestedPreload === reviewPreloadPath || requestedPreload === reviewPreloadUrl;

  if (requestedPreload && !usesServicePreload && !usesReviewPreload) {
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

  if (usesReviewPreload) {
    try {
      const parsed = new URL(src);
      const partition = String(input.params.partition || "");
      const isTrustedLocalPreview =
        parsed.protocol === `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:` &&
        input.isReviewableLocalFileUrl?.(src) === true;
      const isApplicationCookieWorkPanelWeb =
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        partition === DESKTOP_SSO_WEBVIEW_PARTITION;
      if (parsed.username || parsed.password || (!isTrustedLocalPreview && !isApplicationCookieWorkPanelWeb)) {
        return { ok: false, reason: "unsafe-review-url", src };
      }
    } catch {
      return { ok: false, reason: "unsafe-review-url", src };
    }
  }

  input.webPreferences.nodeIntegration = false;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = usesReviewPreload || (() => {
    try {
      return new URL(src).protocol === `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:`;
    } catch {
      return false;
    }
  })();
  if (usesServicePreload) {
    input.webPreferences.preload = input.servicePreloadPath;
  } else if (usesReviewPreload) {
    input.webPreferences.preload = reviewPreloadPath;
  }
  return { ok: true };
}

export function resolveWebviewEditShortcut(
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

export function runWebviewEditCommand(
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
