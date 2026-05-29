export type DebugSurfaceKind = "webview" | "plugin" | "external";

export type DebugHeaderMap = Record<string, string | string[] | undefined>;
export type DebugSanitizedHeaders = Record<string, string>;

export interface DebugWebviewSurface {
  webContentsId: number;
  kind: DebugSurfaceKind;
  surfaceId?: string;
  surfaceLabel?: string;
  tabId?: string;
  url?: string;
}

export type DebugWebviewSurfaceRegistration = DebugWebviewSurface;

interface DebugEventBase {
  id: string;
  webContentsId: number;
  source: DebugWebviewSurface;
  createdAt: number;
}

export interface DebugRequestEvent extends DebugEventBase {
  kind: "request";
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  statusCode?: number;
  statusLine?: string;
  fromCache?: boolean;
  durationMs?: number;
  error?: string;
  startedAt: number;
  completedAt?: number;
  requestHeaders: DebugSanitizedHeaders;
  responseHeaders: DebugSanitizedHeaders;
}

export interface DebugConsoleEvent extends DebugEventBase {
  kind: "console";
  level: "debug" | "info" | "warning" | "error";
  message: string;
  line?: number;
  sourceId?: string;
}

export interface DebugLoadEvent extends DebugEventBase {
  kind: "load";
  stage: "did-fail-load" | "did-navigate" | "did-navigate-in-page" | "render-process-gone";
  url?: string;
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
  details?: string;
}

export type DebugEvent = DebugRequestEvent | DebugConsoleEvent | DebugLoadEvent;

export type DebugEventListener = (event: DebugEvent) => void;
