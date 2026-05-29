import type {
  DebugConsoleEvent,
  DebugEvent,
  DebugEventListener,
  DebugHeaderMap,
  DebugLoadEvent,
  DebugRequestEvent,
  DebugSanitizedHeaders,
  DebugWebviewSurface,
  DebugWebviewSurfaceRegistration
} from "../../shared/contracts/debug";

const DEFAULT_MAX_EVENTS = 1000;
const REDACTED_VALUE = "<redacted>";
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key"
]);

type DebugEventStoreOptions = {
  maxEvents?: number;
  now?: () => number;
};

type RequestLifecycleDetails = {
  id: number | string;
  webContentsId?: number;
  url: string;
  method?: string;
  resourceType?: string;
  timestamp?: number;
};

type RequestHeadersDetails = RequestLifecycleDetails & {
  requestHeaders?: DebugHeaderMap;
};

type ResponseDetails = RequestLifecycleDetails & {
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: DebugHeaderMap;
  fromCache?: boolean;
};

type ErrorDetails = RequestLifecycleDetails & {
  error: string;
};

type ConsoleMessageDetails = {
  webContentsId: number;
  level: DebugConsoleEvent["level"] | number;
  message: string;
  line?: number;
  sourceId?: string;
};

type LoadDetails = {
  webContentsId: number;
  stage: DebugLoadEvent["stage"];
  url?: string;
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
  details?: string;
};

type PendingRequest = {
  requestId: string;
  webContentsId: number;
  url: string;
  method: string;
  resourceType: string;
  startedAt: number;
  requestHeaders: DebugSanitizedHeaders;
  statusCode?: number;
  statusLine?: string;
  responseHeaders: DebugSanitizedHeaders;
  fromCache?: boolean;
};

export type DebugEventStore = ReturnType<typeof createDebugEventStore>;

function normalizeHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value ?? "";
}

function isSensitiveHeaderName(name: string) {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) ||
    normalized.includes("token") ||
    normalized.includes("secret");
}

export function sanitizeDebugHeaders(headers: DebugHeaderMap | undefined): DebugSanitizedHeaders {
  if (!headers) {
    return {};
  }
  const sanitized: DebugSanitizedHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      continue;
    }
    sanitized[normalizedName] = isSensitiveHeaderName(normalizedName)
      ? REDACTED_VALUE
      : normalizeHeaderValue(value);
  }
  return sanitized;
}

function normalizeSurface(input: DebugWebviewSurfaceRegistration): DebugWebviewSurface {
  return {
    webContentsId: input.webContentsId,
    kind: input.kind ?? "webview",
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.surfaceLabel ? { surfaceLabel: input.surfaceLabel } : {}),
    ...(input.tabId ? { tabId: input.tabId } : {}),
    ...(input.url ? { url: input.url } : {})
  };
}

function requestKey(webContentsId: number, requestId: number | string) {
  return `${webContentsId}:${String(requestId)}`;
}

function toRequestId(requestId: number | string) {
  return String(requestId);
}

function toTimestamp(value: number | undefined, now: () => number) {
  return typeof value === "number" && Number.isFinite(value) ? value : now();
}

function normalizeConsoleLevel(level: ConsoleMessageDetails["level"]): DebugConsoleEvent["level"] {
  if (level === "debug" || level === "info" || level === "warning" || level === "error") {
    return level;
  }
  if (level >= 3) {
    return "error";
  }
  if (level === 2) {
    return "warning";
  }
  if (level === 0) {
    return "debug";
  }
  return "info";
}

export function createDebugEventStore(options: DebugEventStoreOptions = {}) {
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  const now = options.now ?? Date.now;
  const events: DebugEvent[] = [];
  const listeners = new Set<DebugEventListener>();
  const surfaces = new Map<number, DebugWebviewSurface>();
  const pendingRequests = new Map<string, PendingRequest>();
  let sequence = 0;

  function nextId(prefix: DebugEvent["kind"]) {
    sequence += 1;
    return `${prefix}_${sequence}`;
  }

  function addEvent(event: DebugEvent) {
    events.push(event);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  function findSurface(webContentsId: number | undefined) {
    return typeof webContentsId === "number" ? surfaces.get(webContentsId) ?? null : null;
  }

  function buildPendingRequest(details: RequestLifecycleDetails): PendingRequest | null {
    const source = findSurface(details.webContentsId);
    if (!source || typeof details.webContentsId !== "number") {
      return null;
    }
    return {
      requestId: toRequestId(details.id),
      webContentsId: details.webContentsId,
      url: details.url,
      method: details.method ?? "GET",
      resourceType: details.resourceType ?? "other",
      startedAt: toTimestamp(details.timestamp, now),
      requestHeaders: {},
      responseHeaders: {}
    };
  }

  function upsertPendingRequest(details: RequestLifecycleDetails) {
    if (typeof details.webContentsId !== "number") {
      return null;
    }
    const key = requestKey(details.webContentsId, details.id);
    const existing = pendingRequests.get(key);
    if (existing) {
      return existing;
    }
    const pending = buildPendingRequest(details);
    if (pending) {
      pendingRequests.set(key, pending);
    }
    return pending;
  }

  function finalizeRequest(details: ResponseDetails | ErrorDetails) {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const key = requestKey(details.webContentsId, details.id);
    const pending = upsertPendingRequest(details);
    const source = findSurface(details.webContentsId);
    if (!pending || !source) {
      return;
    }
    pendingRequests.delete(key);
    const completedAt = toTimestamp(details.timestamp, now);
    const event: DebugRequestEvent = {
      id: nextId("request"),
      kind: "request",
      requestId: pending.requestId,
      webContentsId: pending.webContentsId,
      source,
      createdAt: now(),
      url: pending.url || details.url,
      method: pending.method,
      resourceType: pending.resourceType,
      ...(pending.statusCode === undefined ? {} : { statusCode: pending.statusCode }),
      ...(pending.statusLine === undefined ? {} : { statusLine: pending.statusLine }),
      ...(pending.fromCache === undefined ? {} : { fromCache: pending.fromCache }),
      durationMs: Math.max(0, Math.round(completedAt - pending.startedAt)),
      ...("error" in details ? { error: details.error } : {}),
      startedAt: pending.startedAt,
      completedAt,
      requestHeaders: pending.requestHeaders,
      responseHeaders: pending.responseHeaders
    };
    addEvent(event);
  }

  return {
    registerSurface(input: DebugWebviewSurfaceRegistration) {
      if (!Number.isFinite(input.webContentsId) || input.webContentsId <= 0) {
        return null;
      }
      const current = surfaces.get(input.webContentsId);
      const next = normalizeSurface({
        ...current,
        ...input,
        kind: input.kind ?? current?.kind ?? "webview"
      });
      surfaces.set(input.webContentsId, next);
      return next;
    },

    unregisterSurface(webContentsId: number) {
      surfaces.delete(webContentsId);
      for (const key of [...pendingRequests.keys()]) {
        if (key.startsWith(`${webContentsId}:`)) {
          pendingRequests.delete(key);
        }
      }
    },

    getSurface(webContentsId: number) {
      return surfaces.get(webContentsId) ?? null;
    },

    listEvents() {
      return [...events];
    },

    clearEvents() {
      events.length = 0;
      pendingRequests.clear();
    },

    subscribe(listener: DebugEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    recordRequestHeaders(details: RequestHeadersDetails) {
      const pending = upsertPendingRequest(details);
      if (!pending) {
        return;
      }
      pending.requestHeaders = sanitizeDebugHeaders(details.requestHeaders);
    },

    recordResponseStarted(details: ResponseDetails) {
      const pending = upsertPendingRequest(details);
      if (!pending) {
        return;
      }
      pending.statusCode = details.statusCode;
      pending.statusLine = details.statusLine;
      pending.responseHeaders = sanitizeDebugHeaders(details.responseHeaders);
      pending.fromCache = details.fromCache;
    },

    recordRequestCompleted(details: ResponseDetails) {
      const pending = upsertPendingRequest(details);
      if (pending) {
        pending.statusCode = details.statusCode ?? pending.statusCode;
        pending.statusLine = details.statusLine ?? pending.statusLine;
        pending.responseHeaders = Object.keys(pending.responseHeaders).length > 0
          ? pending.responseHeaders
          : sanitizeDebugHeaders(details.responseHeaders);
        pending.fromCache = details.fromCache ?? pending.fromCache;
      }
      finalizeRequest(details);
    },

    recordRequestError(details: ErrorDetails) {
      finalizeRequest(details);
    },

    recordConsoleMessage(details: ConsoleMessageDetails) {
      const source = findSurface(details.webContentsId);
      if (!source) {
        return;
      }
      addEvent({
        id: nextId("console"),
        kind: "console",
        webContentsId: details.webContentsId,
        source,
        createdAt: now(),
        level: normalizeConsoleLevel(details.level),
        message: details.message,
        ...(details.line === undefined ? {} : { line: details.line }),
        ...(details.sourceId ? { sourceId: details.sourceId } : {})
      });
    },

    recordLoadEvent(details: LoadDetails) {
      const source = findSurface(details.webContentsId);
      if (!source) {
        return;
      }
      addEvent({
        id: nextId("load"),
        kind: "load",
        webContentsId: details.webContentsId,
        source,
        createdAt: now(),
        stage: details.stage,
        ...(details.url ? { url: details.url } : {}),
        ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
        ...(details.errorDescription ? { errorDescription: details.errorDescription } : {}),
        ...(details.isMainFrame === undefined ? {} : { isMainFrame: details.isMainFrame }),
        ...(details.details ? { details: details.details } : {})
      });
    }
  };
}
