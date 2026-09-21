import type { WebviewAttachInput, WebviewAttachResult } from "./window-model";
import { WORK_PANEL_DOCUMENT_HTML_PROTOCOL } from "../../../shared/work-panel-document-html";
import { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from "../../../shared/chat-work-panel";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";

export function prepareWebviewAttachPreferences(input: WebviewAttachInput): WebviewAttachResult {
  const requestedPreload = String(input.webPreferences.preload || input.params.preload || "");
  const src = String(input.params.src || "");
  const documentPreloadPath = input.servicePreloadPath.replace(/service-webview\.js$/u, "document-html-review.js");
  const documentPreloadUrl = input.servicePreloadUrl.replace(/service-webview\.js$/u, "document-html-review.js");
  const usesDocumentPreload = requestedPreload === documentPreloadPath || requestedPreload === documentPreloadUrl;
  const partition = String(input.params.partition || "");
  if (usesDocumentPreload || src.startsWith(`${WORK_PANEL_DOCUMENT_HTML_PROTOCOL}:`) || partition.startsWith("work-panel-document-html:")) {
    if (!usesDocumentPreload || input.isDocumentHtmlPreview?.(src, partition) !== true) {
      return { ok: false, reason: "unsafe-review-url", src };
    }
    Object.assign(input.webPreferences, {
      preload: documentPreloadPath, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false,
    });
    return { ok: true };
  }
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
