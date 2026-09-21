import type { MainWindowWebContentsLike, AttachedWebviewLike, BlobPopupTarget } from "./window-model";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { DesktopCloseShortcutRequest, DesktopGlobalSearchShortcut } from "../../../shared/contracts/desktop-api";
import { prepareIsolatedAuthGuest, configureIsolatedAuthGuest } from "../../infrastructure/electron/isolated-auth-guest";
import { prepareWebviewAttachPreferences } from "./webview-attach-policy";
import { DESKTOP_HELP_WEBVIEW_PARTITION, isAllowedHelpNavigationUrl } from "../../../shared/help";
import { configureAttachedWebview } from "./webview-events";

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
    isReviewableLocalFileUrl?(value: string): boolean;
    isDocumentHtmlPreview?(url: string, partition: string): boolean;
    configureDocumentHtmlGuest?(contents: TGuestContents): boolean;
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
    const authGuest = prepareIsolatedAuthGuest((targetWindow.webContents as { id?: number }).id, webPreferences, params);
    if (authGuest !== undefined) {
      if (!authGuest) event.preventDefault();
      return;
    }
    const result = prepareWebviewAttachPreferences({
      webPreferences,
      params,
      servicePreloadPath: options.servicePreloadPath,
      servicePreloadUrl: options.servicePreloadUrl,
      isSafeServiceUrl: options.isSafeServiceUrl,
      isReviewableLocalFileUrl: options.isReviewableLocalFileUrl,
      isDocumentHtmlPreview: options.isDocumentHtmlPreview,
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

    if (!result.ok && result.reason === "unsafe-review-url") {
      event.preventDefault();
      options.report("blocked WorkPanel review preload with unsafe url", {
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
    if (configureIsolatedAuthGuest(contents)) return;
    const publishFocused = () => options.onWebviewFocusChanged?.(contents.id, true);
    const publishBlurred = () => options.onWebviewFocusChanged?.(contents.id, false);
    contents.on("focus", publishFocused);
    contents.on("blur", publishBlurred);
    contents.on("destroyed", publishBlurred);
    if (contents.isFocused?.()) publishFocused();
    const restrictedDocumentPreview = options.configureDocumentHtmlGuest?.(contents) === true;
    if (!restrictedDocumentPreview) options.attachWebviewContextMenu?.(contents);
    configureAttachedWebview(contents, {
      restrictedDocumentPreview,
      platform: options.platform,
      getMainWindow: options.getMainWindow,
      isDevToolsShortcut: options.isDevToolsShortcut,
      isGlobalSearchShortcut: options.isGlobalSearchShortcut,
      isDesktopCloseShortcut: options.isDesktopCloseShortcut,
      isWorkPanelWebview: options.isWorkPanelWebview,
      isMainChatWebview: options.isMainChatWebview,
      resolveWebsiteCloseTarget: options.resolveWebsiteCloseTarget,
      isWorkPanelFullscreenActive: options.isWorkPanelFullscreenActive,
      resolveGlobalSearchCommandShortcut: options.resolveGlobalSearchCommandShortcut,
      isGlobalSearchOverlayVisible: options.isGlobalSearchOverlayVisible,
      shouldDownloadUrl: options.shouldDownloadUrl,
      resolveOpenDisposition: options.resolveOpenDisposition,
      collectLoadDiagnostics: options.collectLoadDiagnostics,
      report: options.report,
      onWebviewNavigation: options.onWebviewNavigation,
      shouldOpenPopupInWorkPanelTab: options.shouldOpenPopupInWorkPanelTab,
      shouldOpenPopupExternally: options.shouldOpenPopupExternally,
      resolveBlobPopupTarget: options.resolveBlobPopupTarget,
      getHelpUrl: options.getHelpUrl,
      isHelpWebview: options.isHelpWebview,
      openExternal: options.openExternal,
      schedule: options.schedule
    });
  });
}
