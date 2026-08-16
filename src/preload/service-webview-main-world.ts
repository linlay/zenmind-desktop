import {
  SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES,
  SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES,
  SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_SURFACE_LIFECYCLE_CHANNEL,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE
} from "../shared/service-webview-bridge";
import {
  AGENT_AUTH_REQUEST_TYPE,
  AGENT_AUTH_RESPONSE_TYPE
} from "../shared/auth-bridge";
import { resolveServiceWebviewWsMonitorUrl } from "../shared/service-webview-ws-monitor";
import {
  AGENT_WEBCLIENT_PLATFORM_WS_GLOBAL,
  AGENT_WEBCLIENT_PLATFORM_WS_TRANSPORT_VERSION,
  AGENT_WEBCLIENT_WORKPANEL_BRIDGE_GLOBAL,
} from "../shared/contracts/agent-webclient-bridge";

export const PAGE_TO_PRELOAD_EVENT = "__desktopServiceWebviewBridgeMessage";
export const PRELOAD_TO_PAGE_EVENT = "__desktopServiceWebviewBridgeDeliver";
export const PRELOAD_TO_PAGE_ACTION_EVENT = "__desktopServiceWebviewBridgeAction";
export const AGENT_WEBCLIENT_BRIDGE_INVOKE_EVENT = "__agentWebclientBridgeInvoke";
export const AGENT_WEBCLIENT_BRIDGE_RESULT_EVENT = "__agentWebclientBridgeResult";
export const AGENT_WEBCLIENT_PLATFORM_WS_OPEN_EVENT = "__agentWebclientPlatformWsOpen";
export const AGENT_WEBCLIENT_PLATFORM_WS_SEND_EVENT = "__agentWebclientPlatformWsSend";
export const AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_EVENT = "__agentWebclientPlatformWsClose";
export const AGENT_WEBCLIENT_PLATFORM_WS_EVENT = "__agentWebclientPlatformWsEvent";
export const DESKTOP_WEBVIEW_BRIDGE_FLAG = "__DESKTOP_WEBVIEW_BRIDGE__";
const DESKTOP_WS_MONITOR_WRAPPED_FLAG = "__DESKTOP_WS_MONITOR_WRAPPED__";
export const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = "agent-webclient.appAccessToken";
export const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = "agent-webclient.appAuthContext";

export function buildServiceWebviewMainWorldScript() {
  return `
(() => {
  const PAGE_TO_PRELOAD_EVENT = ${JSON.stringify(PAGE_TO_PRELOAD_EVENT)};
  const PRELOAD_TO_PAGE_EVENT = ${JSON.stringify(PRELOAD_TO_PAGE_EVENT)};
  const PRELOAD_TO_PAGE_ACTION_EVENT = ${JSON.stringify(PRELOAD_TO_PAGE_ACTION_EVENT)};
  const AGENT_WEBCLIENT_BRIDGE_INVOKE_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_BRIDGE_INVOKE_EVENT)};
  const AGENT_WEBCLIENT_BRIDGE_RESULT_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_BRIDGE_RESULT_EVENT)};
  const AGENT_WEBCLIENT_PLATFORM_WS_OPEN_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_EVENT)};
  const AGENT_WEBCLIENT_PLATFORM_WS_SEND_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_SEND_EVENT)};
  const AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_EVENT)};
  const AGENT_WEBCLIENT_PLATFORM_WS_EVENT = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_EVENT)};
  const AGENT_WEBCLIENT_PLATFORM_WS_GLOBAL = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_GLOBAL)};
  const AGENT_WEBCLIENT_PLATFORM_WS_TRANSPORT_VERSION = ${JSON.stringify(AGENT_WEBCLIENT_PLATFORM_WS_TRANSPORT_VERSION)};
  const AGENT_WEBCLIENT_WORKPANEL_BRIDGE_GLOBAL = ${JSON.stringify(AGENT_WEBCLIENT_WORKPANEL_BRIDGE_GLOBAL)};
  const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL)};
  const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL)};
  const SERVICE_WEBVIEW_BRIDGE_SURFACE_LIFECYCLE_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_SURFACE_LIFECYCLE_CHANNEL)};
  const DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE = ${JSON.stringify(DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE)};
  const DESKTOP_WEBVIEW_BRIDGE_FLAG = ${JSON.stringify(DESKTOP_WEBVIEW_BRIDGE_FLAG)};
  const DESKTOP_WS_MONITOR_WRAPPED_FLAG = ${JSON.stringify(DESKTOP_WS_MONITOR_WRAPPED_FLAG)};
  const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = ${JSON.stringify(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY)};
  const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = ${JSON.stringify(AGENT_APP_AUTH_CONTEXT_STORAGE_KEY)};
  const AGENT_AUTH_REQUEST_TYPE = ${JSON.stringify(AGENT_AUTH_REQUEST_TYPE)};
  const AGENT_AUTH_RESPONSE_TYPE = ${JSON.stringify(AGENT_AUTH_RESPONSE_TYPE)};
  const BRIDGE_REQUEST_TYPES = new Set([
    ...${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES)}
  ]);
  const BRIDGE_RESPONSE_TYPES = new Set([
    AGENT_AUTH_RESPONSE_TYPE,
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

  function installAgentWebclientBridges() {
    let requestSequence = 0;
    const pending = new Map();
    const sockets = new Map();
    const invoke = (bridge, method, input) => new Promise((resolve) => {
      requestSequence += 1;
      const requestId = "agent-webclient-bridge-" + Date.now() + "-" + requestSequence;
      pending.set(requestId, resolve);
      window.dispatchEvent(new CustomEvent(AGENT_WEBCLIENT_BRIDGE_INVOKE_EVENT, {
        detail: {
          requestId,
          bridge,
          method,
          ...(input === undefined ? {} : { input })
        }
      }));
    });
    window.addEventListener(AGENT_WEBCLIENT_BRIDGE_RESULT_EVENT, (event) => {
      const detail = event.detail;
      const resolve = detail && pending.get(detail.requestId);
      if (!resolve) return;
      pending.delete(detail.requestId);
      resolve(detail.result);
    });
    class DesktopPlatformSocket {
      constructor() {
        requestSequence += 1;
        this.socketId = "agent-webclient-platform-ws-" + Date.now() + "-" + requestSequence;
        this.state = 0;
        this.listeners = new Map();
        sockets.set(this.socketId, this);
        window.dispatchEvent(new CustomEvent(AGENT_WEBCLIENT_PLATFORM_WS_OPEN_EVENT, {
          detail: { socketId: this.socketId }
        }));
      }
      get readyState() {
        return this.state;
      }
      send(data) {
        if (this.state !== 1) throw new Error("Desktop Platform socket is not open");
        if (typeof data !== "string") throw new TypeError("Desktop Platform socket only accepts serialized frames");
        window.dispatchEvent(new CustomEvent(AGENT_WEBCLIENT_PLATFORM_WS_SEND_EVENT, {
          detail: { socketId: this.socketId, data }
        }));
      }
      close(code, reason) {
        if (this.state >= 2) return;
        this.state = 2;
        window.dispatchEvent(new CustomEvent(AGENT_WEBCLIENT_PLATFORM_WS_CLOSE_EVENT, {
          detail: {
            socketId: this.socketId,
            ...(Number.isInteger(code) ? { code } : {}),
            ...(typeof reason === "string" ? { reason } : {})
          }
        }));
      }
      addEventListener(type, listener) {
        if (typeof listener !== "function") return;
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(type);
      }
      deliver(detail) {
        if (!detail || detail.socketId !== this.socketId || this.state === 3) return;
        if (detail.type === "open") this.state = 1;
        if (detail.type === "close") {
          this.state = 3;
          sockets.delete(this.socketId);
        }
        const event = detail.type === "message"
          ? new MessageEvent("message", { data: detail.data })
          : Object.assign(new Event(detail.type), detail.type === "error"
            ? { message: detail.message || "Desktop Platform socket error" }
            : detail.type === "close"
              ? { code: detail.code || 1000, reason: detail.reason || "" }
              : {});
        for (const listener of Array.from(this.listeners.get(detail.type) || [])) {
          try {
            listener.call(this, event);
          } catch {
            // Isolate socket listeners.
          }
        }
      }
    }
    window.addEventListener(AGENT_WEBCLIENT_PLATFORM_WS_EVENT, (event) => {
      const detail = event.detail;
      sockets.get(detail?.socketId)?.deliver(detail);
    });
    const platformWs = Object.freeze({
      transportVersion: AGENT_WEBCLIENT_PLATFORM_WS_TRANSPORT_VERSION,
      createSocket: () => new DesktopPlatformSocket()
    });
    const workpanel = Object.freeze({
      getCapabilities: () => invoke("workpanel", "getCapabilities"),
      openItem: (input) => invoke("workpanel", "openItem", input),
      activateItem: (input) => invoke("workpanel", "activateItem", input),
      closeItem: (input) => invoke("workpanel", "closeItem", input)
    });
    for (const [name, value] of [
      [AGENT_WEBCLIENT_PLATFORM_WS_GLOBAL, platformWs],
      [AGENT_WEBCLIENT_WORKPANEL_BRIDGE_GLOBAL, workpanel]
    ]) {
      try {
        Object.defineProperty(window, name, {
          configurable: false,
          enumerable: false,
          writable: false,
          value
        });
      } catch {
        // A previously installed preload owns the fixed bridge global.
      }
    }
  }

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

  function defineWindowFlag(flag) {
    try {
      Object.defineProperty(window, flag, {
        configurable: true,
        enumerable: false,
        value: true,
        writable: false
      });
    } catch {
      window[flag] = true;
    }
  }

  defineWindowFlag(DESKTOP_WEBVIEW_BRIDGE_FLAG);

  function isDesktopBridgeRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    if (value.type === AGENT_AUTH_REQUEST_TYPE) {
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
    if (
      typeof OriginalWebSocket !== "function" ||
      OriginalWebSocket[DESKTOP_WS_MONITOR_WRAPPED_FLAG]
    ) {
      return;
    }
    function DesktopServiceWebviewWebSocket(url, protocols) {
      const nextUrl = resolveServiceWebviewWsMonitorUrl(url, readWsMonitorPageHref());
      if (arguments.length > 1) {
        return new OriginalWebSocket(nextUrl, protocols);
      }
      return new OriginalWebSocket(nextUrl);
    }
    try {
      Object.setPrototypeOf(DesktopServiceWebviewWebSocket, OriginalWebSocket);
    } catch {
      // Ignore prototype wiring failures in restricted renderer contexts.
    }
    DesktopServiceWebviewWebSocket.prototype = OriginalWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try {
        Object.defineProperty(DesktopServiceWebviewWebSocket, key, {
          configurable: true,
          enumerable: true,
          value: OriginalWebSocket[key]
        });
      } catch {
        // Static WebSocket constants are best-effort metadata.
      }
    }
    try {
      Object.defineProperty(DesktopServiceWebviewWebSocket, DESKTOP_WS_MONITOR_WRAPPED_FLAG, {
        configurable: true,
        enumerable: false,
        value: true
      });
    } catch {
      DesktopServiceWebviewWebSocket[DESKTOP_WS_MONITOR_WRAPPED_FLAG] = true;
    }
    try {
      window.WebSocket = DesktopServiceWebviewWebSocket;
    } catch {
      // Ignore non-writable WebSocket globals.
    }
  }

  function syncStoredAuthContext(payload) {
    const currentContext = typeof payload?.desktopAuthContext === "string"
      ? payload.desktopAuthContext.trim()
      : "";
    if (!currentContext) {
      return;
    }
    window.__AGENT_APP_AUTH_CONTEXT = currentContext;
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

  function clearAgentAppAccessToken(payload) {
    if (
      !payload ||
      payload.type !== AGENT_AUTH_RESPONSE_TYPE
    ) {
      return;
    }
    try {
      syncStoredAuthContext(payload);
      window.sessionStorage.removeItem(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY);
    } catch {
      // Ignore storage failures in restricted guest contexts.
    }
    window.__AGENT_APP_ACCESS_TOKEN = undefined;
  }

  installWebSocketMonitorMetadata();
  installElectronAPICompat();
  installAgentWebclientBridges();

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
    clearAgentAppAccessToken(payload);
    if (payload.type === ${JSON.stringify(DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE)}) {
      emitFromMain(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, payload);
    }
    if (payload.type === DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE) {
      emitFromMain(SERVICE_WEBVIEW_BRIDGE_SURFACE_LIFECYCLE_CHANNEL, payload);
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
  });

})();
`;
}
