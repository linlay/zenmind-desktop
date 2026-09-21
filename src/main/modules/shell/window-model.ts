import type { BrowserWindow } from "electron";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { DesktopCloseShortcutRequest, DesktopGlobalSearchShortcut } from "../../../shared/contracts/desktop-api";

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
    webSecurity?: boolean;
    webviewTag?: boolean;
    nodeIntegrationInSubFrames?: boolean;
    nodeIntegrationInWorker?: boolean;
    allowRunningInsecureContent?: boolean;
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
  isDocumentHtmlPreview?(url: string, partition: string): boolean;
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

export type AttachedWebviewOptions<
  TMainWindow,
  TGuestContents extends AttachedWebviewLike = AttachedWebviewLike
> = {
  platform: DesktopPlatform;
  getMainWindow(): TMainWindow | null;
  isDevToolsShortcut(platform: DesktopPlatform, input: any): boolean;
  isGlobalSearchShortcut?(platform: DesktopPlatform, input: any): boolean;
  isDesktopCloseShortcut?(platform: DesktopPlatform, input: any): boolean;
  isWorkPanelWebview?(contents: TGuestContents): boolean;
  isMainChatWebview?(contents: TGuestContents): boolean;
  resolveWebsiteCloseTarget?(contents: TGuestContents): DesktopCloseShortcutRequest["website"] | null;
  isWorkPanelFullscreenActive?(): boolean;
  resolveGlobalSearchCommandShortcut?(platform: DesktopPlatform, input: any): DesktopGlobalSearchShortcut | null;
  isGlobalSearchOverlayVisible?(): boolean;
  shouldDownloadUrl(url: string): boolean;
  resolveOpenDisposition(url: string): "download" | "tab" | "blob" | "external";
  collectLoadDiagnostics(contents: TGuestContents, validatedUrl: string): Promise<Record<string, unknown>>;
  report(source: string, details: Record<string, unknown>): void;
  onWebviewNavigation?(url: string, details: { guestId: number; isInPage: boolean; isMainFrame: boolean }): void;
  shouldOpenPopupInWorkPanelTab?(contents: TGuestContents): boolean;
  shouldOpenPopupExternally?(contents: TGuestContents): boolean;
  resolveBlobPopupTarget?(contents: TGuestContents): BlobPopupTarget | null;
  getHelpUrl?(): string;
  isHelpWebview?(contents: TGuestContents): boolean;
  restrictedDocumentPreview?: boolean;
  openExternal(url: string): Promise<unknown>;
  schedule(callback: () => void): void;
};
