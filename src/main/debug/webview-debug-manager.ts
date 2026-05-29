import type { Session, WebContents } from "electron";
import type { DebugEvent, DebugWebviewSurfaceRegistration } from "../../shared/contracts/debug";
import type { DebugEventStore } from "./debug-events";

type WebviewDebugManagerOptions = {
  store: DebugEventStore;
  emitEvent: (event: DebugEvent) => void;
  onError: (message: string, details: unknown) => void;
};

const WEB_REQUEST_FILTER = { urls: ["<all_urls>"] };

function readConsoleMessage(
  levelOrDetails: unknown,
  message: unknown,
  line: unknown,
  sourceId: unknown
): {
  level: "debug" | "info" | "warning" | "error" | number;
  message: string;
  line?: number;
  sourceId?: string;
} {
  if (levelOrDetails && typeof levelOrDetails === "object" && !Array.isArray(levelOrDetails)) {
    const details = levelOrDetails as {
      level?: string;
      message?: string;
      lineNumber?: number;
      sourceId?: string;
    };
    const normalizedLevel = details.level === "debug" ||
      details.level === "info" ||
      details.level === "warning" ||
      details.level === "error"
      ? details.level
      : "info";
    return {
      level: normalizedLevel,
      message: details.message ?? "",
      line: details.lineNumber,
      sourceId: details.sourceId
    };
  }
  return {
    level: typeof levelOrDetails === "number" ? levelOrDetails : "info",
    message: typeof message === "string" ? message : String(message ?? ""),
    line: typeof line === "number" ? line : undefined,
    sourceId: typeof sourceId === "string" ? sourceId : undefined
  };
}

export class WebviewDebugManager {
  private readonly store: DebugEventStore;
  private readonly emitEvent: (event: DebugEvent) => void;
  private readonly onError: (message: string, details: unknown) => void;
  private readonly attachedSessions = new WeakSet<Session>();
  private readonly attachedWebContentsIds = new Set<number>();
  private unsubscribeStore: (() => void) | null = null;

  constructor(options: WebviewDebugManagerOptions) {
    this.store = options.store;
    this.emitEvent = options.emitEvent;
    this.onError = options.onError;
  }

  start() {
    if (this.unsubscribeStore) {
      return;
    }
    this.unsubscribeStore = this.store.subscribe((event) => {
      this.emitEvent(event);
    });
  }

  stop() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  attachSession(targetSession: Session) {
    if (this.attachedSessions.has(targetSession)) {
      return;
    }
    this.attachedSessions.add(targetSession);
    targetSession.webRequest.onSendHeaders(WEB_REQUEST_FILTER, (details) => {
      this.store.recordRequestHeaders({
        id: details.id,
        webContentsId: details.webContentsId,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        requestHeaders: details.requestHeaders,
        timestamp: details.timestamp
      });
    });
    targetSession.webRequest.onResponseStarted(WEB_REQUEST_FILTER, (details) => {
      this.store.recordResponseStarted({
        id: details.id,
        webContentsId: details.webContentsId,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        responseHeaders: details.responseHeaders,
        fromCache: details.fromCache,
        timestamp: details.timestamp
      });
    });
    targetSession.webRequest.onCompleted(WEB_REQUEST_FILTER, (details) => {
      this.store.recordRequestCompleted({
        id: details.id,
        webContentsId: details.webContentsId,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        responseHeaders: details.responseHeaders,
        fromCache: details.fromCache,
        timestamp: details.timestamp
      });
    });
    targetSession.webRequest.onErrorOccurred(WEB_REQUEST_FILTER, (details) => {
      this.store.recordRequestError({
        id: details.id,
        webContentsId: details.webContentsId,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        error: details.error,
        timestamp: details.timestamp
      });
    });
  }

  registerSurface(input: DebugWebviewSurfaceRegistration) {
    return this.store.registerSurface(input);
  }

  unregisterSurface(webContentsId: number) {
    this.store.unregisterSurface(webContentsId);
  }

  attachWebContents(contents: WebContents, metadata: Partial<DebugWebviewSurfaceRegistration> = {}) {
    if (contents.isDestroyed()) {
      return;
    }
    this.attachSession(contents.session);
    this.registerSurface({
      webContentsId: contents.id,
      kind: "webview",
      ...metadata
    });
    if (this.attachedWebContentsIds.has(contents.id)) {
      return;
    }
    this.attachedWebContentsIds.add(contents.id);
    contents.on("console-message", (_event, levelOrDetails, message, line, sourceId) => {
      const parsed = readConsoleMessage(levelOrDetails, message, line, sourceId);
      this.store.recordConsoleMessage({
        webContentsId: contents.id,
        level: parsed.level,
        message: parsed.message,
        line: parsed.line,
        sourceId: parsed.sourceId
      });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (errorCode === -3) {
        return;
      }
      this.store.recordLoadEvent({
        webContentsId: contents.id,
        stage: "did-fail-load",
        url: validatedUrl,
        errorCode,
        errorDescription,
        isMainFrame
      });
    });
    contents.on("did-navigate", (_event, url) => {
      this.store.recordLoadEvent({
        webContentsId: contents.id,
        stage: "did-navigate",
        url,
        isMainFrame: true
      });
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      this.store.recordLoadEvent({
        webContentsId: contents.id,
        stage: "did-navigate-in-page",
        url,
        isMainFrame
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.store.recordLoadEvent({
        webContentsId: contents.id,
        stage: "render-process-gone",
        url: contents.getURL(),
        details: `${details.reason}:${details.exitCode}`
      });
      this.onError("webview render process exited unexpectedly", {
        webContentsId: contents.id,
        details
      });
    });
    contents.once("destroyed", () => {
      this.attachedWebContentsIds.delete(contents.id);
      this.unregisterSurface(contents.id);
    });
  }
}
