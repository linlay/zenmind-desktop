import { ipcRenderer, webFrame, contextBridge } from "electron";
import {
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  type ServiceWebviewBridgeMessage
} from "../shared/service-webview-bridge";

const PAGE_TO_PRELOAD_EVENT = "__zenmindServiceWebviewBridgeMessage";
const PRELOAD_TO_PAGE_EVENT = "__zenmindServiceWebviewBridgeDeliver";
const DESKTOP_WEBVIEW_BRIDGE_FLAG = "__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__";
const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = "agent-webclient.appAccessToken";
const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = "agent-webclient.appAuthContext";
const MAIN_WORLD_SCRIPT = `
(() => {
  const PAGE_TO_PRELOAD_EVENT = ${JSON.stringify(PAGE_TO_PRELOAD_EVENT)};
  const PRELOAD_TO_PAGE_EVENT = ${JSON.stringify(PRELOAD_TO_PAGE_EVENT)};
  const DESKTOP_WEBVIEW_BRIDGE_FLAG = ${JSON.stringify(DESKTOP_WEBVIEW_BRIDGE_FLAG)};
  const AGENT_APP_ACCESS_TOKEN_STORAGE_KEY = ${JSON.stringify(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY)};
  const AGENT_APP_AUTH_CONTEXT_STORAGE_KEY = ${JSON.stringify(AGENT_APP_AUTH_CONTEXT_STORAGE_KEY)};
  const AUTH_REQUEST_TYPES = new Set([
    "zenmind:agent-app-auth:request",
    "zenmind:pan-app-auth:request"
  ]);
  const BRIDGE_REQUEST_TYPES = new Set([
    "zenmind:agent-app-clipboard:request"
  ]);
  const BRIDGE_RESPONSE_TYPES = new Set([
    "zenmind:agent-app-auth:response",
    "zenmind:pan-app-auth:response",
    "zenmind:agent-app-clipboard:response",
    "desktopContextChanged"
  ]);
  const originalWindowPostMessage = window.postMessage.bind(window);
  const originalParentPostMessage = window.parent && window.parent !== window && typeof window.parent.postMessage === "function"
    ? window.parent.postMessage.bind(window.parent)
    : originalWindowPostMessage;

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

  function postMessageCompat(original, value, targetOrigin, transfer) {
    if (isDesktopBridgeRequest(value)) {
      dispatchToPreload(value);
      return;
    }
    if (transfer === undefined) {
      original(value, targetOrigin);
      return;
    }
    original(value, targetOrigin, transfer);
  }

  try {
    window.postMessage = function zenmindWindowPostMessage(value, targetOrigin, transfer) {
      postMessageCompat(originalWindowPostMessage, value, targetOrigin, transfer);
    };
  } catch {
    // Ignore non-writable postMessage environments.
  }

  try {
    if (window.parent && typeof window.parent.postMessage === "function") {
      window.parent.postMessage = function zenmindParentPostMessage(value, targetOrigin, transfer) {
        postMessageCompat(originalParentPostMessage, value, targetOrigin, transfer);
      };
    }
  } catch {
    // Ignore non-writable parent environments.
  }

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
    window.dispatchEvent(new MessageEvent("message", {
      data: payload,
      origin: location.origin,
      source: window
    }));
  });
})();
`;

function isBridgeMessage(value: unknown): value is ServiceWebviewBridgeMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendBridgeDebug(stage: string, message = "") {
  try {
    ipcRenderer.sendToHost(SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL, {
      type: SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE,
      requestId: `service_webview_debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      stage,
      message,
      origin: window.location.origin
    });
  } catch {
    // Ignore diagnostics if the host webContents is not ready yet.
  }
}

function isDesktopBridgeRequest(value: ServiceWebviewBridgeMessage) {
  if (value.type === AGENT_APP_CLIPBOARD_REQUEST_TYPE) {
    return Boolean(value.requestId);
  }
  return Boolean(
    value.requestId &&
      value.type &&
      /:auth:request$/u.test(value.type) &&
      (value.action === "getAccessToken" || value.action === "refreshAccessToken")
  );
}

function isDesktopBridgeDeliver(value: ServiceWebviewBridgeMessage) {
  return value.type === AGENT_APP_CLIPBOARD_RESPONSE_TYPE ||
    value.type === DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE ||
    Boolean(value.type && /:auth:response$/u.test(value.type));
}

webFrame.executeJavaScriptInIsolatedWorld(0, [{
  code: MAIN_WORLD_SCRIPT
}])
  .then(() => {
    sendBridgeDebug("preload-installed");
  })
  .catch((error) => {
    sendBridgeDebug("preload-install-failed", error instanceof Error ? error.message : String(error));
  });

window.addEventListener(PAGE_TO_PRELOAD_EVENT, (event) => {
  const payload = (event as CustomEvent<ServiceWebviewBridgeMessage>).detail;
  if (!isBridgeMessage(payload) || !isDesktopBridgeRequest(payload)) {
    return;
  }

  ipcRenderer.sendToHost(SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL, {
    ...payload,
    origin: window.location.origin
  });
  sendBridgeDebug("bridge-request", String(payload.type || ""));
});

window.addEventListener("message", (event) => {
  if (!isBridgeMessage(event.data) || !isDesktopBridgeRequest(event.data)) {
    return;
  }

  ipcRenderer.sendToHost(SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL, {
    ...event.data,
    origin: event.origin
  });
  sendBridgeDebug("bridge-window-message", String(event.data.type || ""));
});

ipcRenderer.on(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, (_event, payload: ServiceWebviewBridgeMessage) => {
  if (!isBridgeMessage(payload) || !isDesktopBridgeDeliver(payload)) {
    return;
  }
  window.dispatchEvent(new CustomEvent(PRELOAD_TO_PAGE_EVENT, { detail: payload }));
  if (payload.type && /:auth:response$/u.test(payload.type)) {
    sendBridgeDebug("auth-response-seeded");
  }
});

// 暴露 API 给 浏览器JS（渲染进程）
contextBridge.exposeInMainWorld('electronAPI', {
  // 渲染进程 → 主进程
  sendToMain: (channel: string, data: any) => ipcRenderer.send(channel, data),
  // 渲染进程 监听 主进程消息
  onFromMain: (channel: string, callback: any) => ipcRenderer.on(channel, callback)
})