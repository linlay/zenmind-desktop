import {
  SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES,
  SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE
} from "../shared/service-webview-bridge";
import { resolveServiceWebviewWsMonitorUrl } from "../shared/service-webview-ws-monitor";

export const PAGE_TO_PRELOAD_EVENT = "__zenmindServiceWebviewBridgeMessage";
export const PRELOAD_TO_PAGE_EVENT = "__zenmindServiceWebviewBridgeDeliver";
export const PRELOAD_TO_PAGE_ACTION_EVENT = "__zenmindServiceWebviewBridgeAction";
export const DESKTOP_WEBVIEW_BRIDGE_FLAG = "__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__";
export const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = "agent-webclient.appAccessToken";
export const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = "agent-webclient.appAuthContext";

export function buildServiceWebviewMainWorldScript() {
  return `
(() => {
  const PAGE_TO_PRELOAD_EVENT = ${JSON.stringify(PAGE_TO_PRELOAD_EVENT)};
  const PRELOAD_TO_PAGE_EVENT = ${JSON.stringify(PRELOAD_TO_PAGE_EVENT)};
  const PRELOAD_TO_PAGE_ACTION_EVENT = ${JSON.stringify(PRELOAD_TO_PAGE_ACTION_EVENT)};
  const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL)};
  const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL)};
  const DESKTOP_WEBVIEW_BRIDGE_FLAG = ${JSON.stringify(DESKTOP_WEBVIEW_BRIDGE_FLAG)};
  const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = ${JSON.stringify(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY)};
  const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = ${JSON.stringify(AGENT_APP_AUTH_CONTEXT_STORAGE_KEY)};
  const AUTH_REQUEST_TYPES = new Set([
    "zenmind:agent-app-auth:request",
    "zenmind:pan-app-auth:request"
  ]);
  const BRIDGE_REQUEST_TYPES = new Set(${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES)});
  const BRIDGE_RESPONSE_TYPES = new Set([
    "zenmind:agent-app-auth:response",
    "zenmind:pan-app-auth:response",
    ...${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES)}
  ]);
  const resolveServiceWebviewWsMonitorUrl = ${resolveServiceWebviewWsMonitorUrl.toString()};
  const initialWsSource = (() => {
    try {
      return new URLSearchParams(window.location.search || "").get("wsSource")?.trim() || "";
    } catch {
      return "";
    }
  })();
  const fromMainListeners = new Map();

  function emitFromMain(channel, payload) {
    const listeners = fromMainListeners.get(channel);
    if (!listeners) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener({ channel }, payload);
      } catch {
        // Keep desktop bridge listeners isolated from each other.
      }
    }
  }

  function installElectronAPICompat() {
    const existingElectronAPI = window.electronAPI;
    if (existingElectronAPI && typeof existingElectronAPI.onFromMain === "function") {
      return;
    }
    const electronAPI = {
      ...(existingElectronAPI && typeof existingElectronAPI === "object" ? existingElectronAPI : {}),
      onFromMain(channel, listener) {
        const normalizedChannel = String(channel || "");
        if (!normalizedChannel || typeof listener !== "function") {
          return () => {};
        }
        const listeners = fromMainListeners.get(normalizedChannel) || new Set();
        listeners.add(listener);
        fromMainListeners.set(normalizedChannel, listeners);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            fromMainListeners.delete(normalizedChannel);
          }
        };
      }
    };
    try {
      Object.defineProperty(window, "electronAPI", {
        configurable: true,
        enumerable: false,
        value: electronAPI,
        writable: false
      });
    } catch {
      window.electronAPI = electronAPI;
    }
  }

  try {
    Object.defineProperty(window, DESKTOP_WEBVIEW_BRIDGE_FLAG, {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false
    });
  } catch {
    window[DESKTOP_WEBVIEW_BRIDGE_FLAG] = true;
  }

  function isDesktopBridgeRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    if (AUTH_REQUEST_TYPES.has(value.type)) {
      return value.action === "getAccessToken" || value.action === "refreshAccessToken";
    }
    return BRIDGE_REQUEST_TYPES.has(value.type);
  }

  function dispatchToPreload(value) {
    window.dispatchEvent(new CustomEvent(PAGE_TO_PRELOAD_EVENT, { detail: value }));
  }

  function readWsMonitorPageHref() {
    if (!initialWsSource) {
      return window.location.href;
    }
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.get("wsSource")) {
        url.searchParams.set("wsSource", initialWsSource);
      }
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  function installWebSocketMonitorMetadata() {
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket !== "function" || OriginalWebSocket.__ZENMIND_WS_MONITOR_WRAPPED__) {
      return;
    }
    function ZenmindServiceWebviewWebSocket(url, protocols) {
      const nextUrl = resolveServiceWebviewWsMonitorUrl(url, readWsMonitorPageHref());
      if (arguments.length > 1) {
        return new OriginalWebSocket(nextUrl, protocols);
      }
      return new OriginalWebSocket(nextUrl);
    }
    try {
      Object.setPrototypeOf(ZenmindServiceWebviewWebSocket, OriginalWebSocket);
    } catch {
      // Ignore prototype wiring failures in restricted renderer contexts.
    }
    ZenmindServiceWebviewWebSocket.prototype = OriginalWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try {
        Object.defineProperty(ZenmindServiceWebviewWebSocket, key, {
          configurable: true,
          enumerable: true,
          value: OriginalWebSocket[key]
        });
      } catch {
        // Static WebSocket constants are best-effort metadata.
      }
    }
    try {
      Object.defineProperty(ZenmindServiceWebviewWebSocket, "__ZENMIND_WS_MONITOR_WRAPPED__", {
        configurable: true,
        enumerable: false,
        value: true
      });
    } catch {
      ZenmindServiceWebviewWebSocket.__ZENMIND_WS_MONITOR_WRAPPED__ = true;
    }
    try {
      window.WebSocket = ZenmindServiceWebviewWebSocket;
    } catch {
      // Ignore non-writable WebSocket globals.
    }
  }

  function readDesktopAuthContext() {
    try {
      return new URLSearchParams(window.location.search || "").get("desktopAuthContext")?.trim() || "";
    } catch {
      return "";
    }
  }

  function syncStoredAuthContext() {
    const currentContext = readDesktopAuthContext();
    if (!currentContext) {
      return;
    }
    try {
      const storedContext = window.sessionStorage.getItem(AGENT_APP_AUTH_CONTEXT_STORAGE_KEY) || "";
      if (storedContext === currentContext) {
        return;
      }
      window.sessionStorage.removeItem(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY);
      window.sessionStorage.setItem(AGENT_APP_AUTH_CONTEXT_STORAGE_KEY, currentContext);
      window.__AGENT_APP_ACCESS_TOKEN = undefined;
    } catch {
      // Ignore storage failures in restricted guest contexts.
    }
  }

  function seedAgentAppAccessToken(payload) {
    if (!payload || payload.type !== "zenmind:agent-app-auth:response") {
      return;
    }
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    try {
      syncStoredAuthContext();
      if (token) {
        window.sessionStorage.setItem(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY, token);
      } else {
        window.sessionStorage.removeItem(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures in restricted guest contexts.
    }
    window.__AGENT_APP_ACCESS_TOKEN = token || undefined;
  }

  installWebSocketMonitorMetadata();
  installElectronAPICompat();

  // Keep postMessage native: awaiting form iframes rely on browser-provided
  // child-to-parent event.source semantics.
  window.addEventListener("message", (event) => {
    if (isDesktopBridgeRequest(event.data)) {
      dispatchToPreload(event.data);
    }
  });

  window.addEventListener(PRELOAD_TO_PAGE_EVENT, (event) => {
    const payload = event.detail;
    if (!payload || typeof payload !== "object" || !BRIDGE_RESPONSE_TYPES.has(payload.type)) {
      return;
    }
    seedAgentAppAccessToken(payload);
    if (payload.type === ${JSON.stringify(DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE)}) {
      emitFromMain(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, payload);
    }
    window.dispatchEvent(new MessageEvent("message", {
      data: payload,
      origin: location.origin,
      source: window
    }));
  });

  window.addEventListener(PRELOAD_TO_PAGE_ACTION_EVENT, (event) => {
    const payload = event.detail;
    if (!payload || typeof payload !== "object") {
      return;
    }
    emitFromMain(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, payload);
    window.dispatchEvent(new MessageEvent("message", {
      data: payload,
      origin: location.origin,
      source: window
    }));
  });
})();
`;
}
