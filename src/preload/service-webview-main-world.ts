import {
  AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE,
  SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES,
  SERVICE_WEBVIEW_BRIDGE_RESPONSE_TYPES,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE
} from "../shared/service-webview-bridge";
import {
  AGENT_AUTH_REQUEST_TYPE,
  AGENT_AUTH_RESPONSE_TYPE
} from "../shared/auth-bridge";
import { resolveServiceWebviewWsMonitorUrl } from "../shared/service-webview-ws-monitor";

export const PAGE_TO_PRELOAD_EVENT = "__desktopServiceWebviewBridgeMessage";
export const PRELOAD_TO_PAGE_EVENT = "__desktopServiceWebviewBridgeDeliver";
export const PRELOAD_TO_PAGE_ACTION_EVENT = "__desktopServiceWebviewBridgeAction";
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
  const SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL)};
  const SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL = ${JSON.stringify(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL)};
  const AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE = ${JSON.stringify(AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE)};
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
  const AGENT_NEW_CONVERSATION_ROUTE_HINT_TTL_MS = 45000;
  const initialWsSource = (() => {
    try {
      return new URLSearchParams(window.location.search || "").get("wsSource")?.trim() || "";
    } catch {
      return "";
    }
  })();
  const fromMainListeners = new Map();
  let pendingAgentNewConversationRoute = null;

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

  function readCurrentAgentKey() {
    try {
      const pathname =
        window.location?.pathname ||
        new URL(
          window.location?.href || "",
          window.location?.origin || "http://localhost",
        ).pathname;
      const match = /^\\/agent\\/([^/?#]+)/u.exec(pathname);
      return match && match[1] ? decodeURIComponent(match[1]).trim() : "";
    } catch {
      return "";
    }
  }

  function readEventDetailRecord(event) {
    return event && event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
      ? event.detail
      : {};
  }

  function readString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function dispatchAgentChatRouteHint(chatId, agentKey) {
    const normalizedChatId = readString(chatId);
    if (!normalizedChatId) {
      return false;
    }
    const normalizedAgentKey = readString(agentKey) || readCurrentAgentKey();
    dispatchToPreload({
      type: AGENT_WEBCLIENT_CHAT_ROUTE_REQUEST_TYPE,
      requestId: \`agent_webclient_chat_route_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\`,
      chatId: normalizedChatId,
      agentKey: normalizedAgentKey
    });
    return true;
  }

  function rememberPendingAgentNewConversationRoute(event) {
    const detail = readEventDetailRecord(event);
    pendingAgentNewConversationRoute = {
      agentKey: readString(detail.agentKey) || readCurrentAgentKey(),
      expiresAt: Date.now() + AGENT_NEW_CONVERSATION_ROUTE_HINT_TTL_MS
    };
  }

  function clearPendingAgentNewConversationRoute() {
    pendingAgentNewConversationRoute = null;
  }

  function hasPendingAgentNewConversationRoute(agentKey) {
    const pending = pendingAgentNewConversationRoute;
    if (!pending || pending.expiresAt <= Date.now()) {
      clearPendingAgentNewConversationRoute();
      return false;
    }
    const normalizedAgentKey = readString(agentKey);
    return !pending.agentKey || !normalizedAgentKey || pending.agentKey === normalizedAgentKey;
  }

  function readAgentRunStartRouteHint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const frame = value;
    const event =
      frame.frame === "stream" && frame.event && typeof frame.event === "object"
        ? frame.event
        : frame.frame === "push" && frame.payload && typeof frame.payload === "object"
          ? frame.payload
          : frame.frame === "push" && frame.data && typeof frame.data === "object"
            ? frame.data
            : frame;
    const rawType = readString(event.type || frame.type);
    const type = rawType === "run.started" ? "run.start" : rawType;
    if (type !== "run.start") {
      return null;
    }
    const chatId = readString(event.chatId || frame.chatId);
    if (!chatId) {
      return null;
    }
    return {
      chatId,
      agentKey: readString(event.agentKey || frame.agentKey)
    };
  }

  function readAgentRunStartRouteHintFromWebSocketMessage(event) {
    const data = event ? event.data : null;
    const text = typeof data === "string" ? data : "";
    if (!text) {
      return null;
    }
    try {
      return readAgentRunStartRouteHint(JSON.parse(text));
    } catch {
      return null;
    }
  }

  function forwardPendingAgentRunStartRoute(event) {
    const routeHint = readAgentRunStartRouteHintFromWebSocketMessage(event);
    if (!routeHint || !hasPendingAgentNewConversationRoute(routeHint.agentKey)) {
      return;
    }
    if (dispatchAgentChatRouteHint(routeHint.chatId, routeHint.agentKey)) {
      clearPendingAgentNewConversationRoute();
    }
  }

  function observeAgentWebclientWebSocket(socket) {
    if (!socket || typeof socket.addEventListener !== "function") {
      return socket;
    }
    try {
      socket.addEventListener("message", forwardPendingAgentRunStartRoute);
    } catch {
      // Keep service webview WebSocket behavior unchanged if observation fails.
    }
    return socket;
  }

  function forwardAgentChatRouteEvent(event) {
    const detail = readEventDetailRecord(event);
    const chatId = readString(detail.chatId);
    const agentKey = readString(detail.agentKey) || readCurrentAgentKey();
    if (dispatchAgentChatRouteHint(chatId, agentKey)) {
      clearPendingAgentNewConversationRoute();
    }
  }

  function forwardAgentLoadChatRoute(event) {
    forwardAgentChatRouteEvent(event);
  }

  function forwardAgentAttachRunRoute(event) {
    forwardAgentChatRouteEvent(event);
  }

  function forwardAgentRunStartedPushRoute(event) {
    const detail = readEventDetailRecord(event);
    const chatId = readString(detail.chatId);
    const agentKey = readString(detail.agentKey) || readCurrentAgentKey();
    if (!hasPendingAgentNewConversationRoute(agentKey)) {
      return;
    }
    if (dispatchAgentChatRouteHint(chatId, agentKey)) {
      clearPendingAgentNewConversationRoute();
    }
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
        return observeAgentWebclientWebSocket(new OriginalWebSocket(nextUrl, protocols));
      }
      return observeAgentWebclientWebSocket(new OriginalWebSocket(nextUrl));
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
    if (
      !payload ||
      payload.type !== AGENT_AUTH_RESPONSE_TYPE
    ) {
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

  window.addEventListener("agent:load-chat", forwardAgentLoadChatRoute);
  window.addEventListener("agent:start-new-conversation", rememberPendingAgentNewConversationRoute);
  window.addEventListener("agent:attach-run", forwardAgentAttachRunRoute);
  window.addEventListener("agent:run-started-push", forwardAgentRunStartedPushRoute);

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
