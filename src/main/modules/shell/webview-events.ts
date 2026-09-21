import type { MainRendererDevToolsContentsLike, AttachedWebviewLike, AttachedWebviewOptions } from "./window-model";
import { isAllowedHelpNavigationUrl, isSafeHelpExternalUrl } from "../../../shared/help";
import { resolveWorkPanelBrowserShortcut, WORK_PANEL_BROWSER_SHORTCUT_CHANNEL } from "../../../shared/work-panel-browser";
import { resolveWebviewEditShortcut, runWebviewEditCommand, isWorkPanelFullscreenExitShortcut } from "./webview-shortcuts";
import { toggleMainRendererDevTools } from "./main-window-options";
import { isBlobSchemeUrl, normalizeWebviewBlobPopupForSource } from "../../../shared/webview-popup";
import { normalizeChatWorkPanelUrl } from "../../../shared/chat-work-panel";

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

    const browserCommand = options.isWorkPanelWebview?.(contents) === true
      && /^https?:\/\//i.test(contents.getURL())
      ? resolveWorkPanelBrowserShortcut(options.platform, input) : null;
    if (browserCommand) {
      const mainWindow = options.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        event.preventDefault();
        mainWindow.webContents.send(WORK_PANEL_BROWSER_SHORTCUT_CHANNEL, { guestId: contents.id, command: browserCommand });
      }
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

    const isCurrentWorkPanelGuest = options.isWorkPanelWebview?.(contents) === true;
    const isCurrentMainChatGuest = options.isMainChatWebview?.(contents) === true;
    const website = options.resolveWebsiteCloseTarget?.(contents);
    if (
      (isCurrentWorkPanelGuest || isCurrentMainChatGuest || website) &&
      options.isDesktopCloseShortcut?.(options.platform, input)
    ) {
      event.preventDefault();
      const mainWindow = options.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("app.closeShortcut", website
        ? { guestId: contents.id, website }
        : isCurrentWorkPanelGuest
          ? { guestId: contents.id }
          : { guestId: null, fallbackToWindowClose: true });
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

  // The document registry already installed its deny-by-default navigation and
  // popup policy. Do not attach the generic SSO/download/external-open handlers.
  if (options.restrictedDocumentPreview) return;

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

    if (options.shouldOpenPopupExternally?.(contents)) {
      // Ordinary WebClient popup links use the OS browser even in WorkPanel.
      // Configured embedded connector authorization uses its dedicated bridge.
      // Only ordinary Web guests own popup tabs within a WorkPanel workspace.
      if (isSafeHelpExternalUrl(url)) {
        if (options.resolveOpenDisposition(url) === "download") {
          downloadFromWebview(url);
        } else {
          void options.openExternal(url).catch(() => {
            // Authorization URLs and OS errors may contain login state or tokens.
            options.report("failed to open service popup externally", { guestId: contents.id });
          });
        }
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
