import { ipcRenderer, webFrame } from "electron";
import {
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES,
  SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE,
  SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  type ServiceWebviewBridgeMessage
} from "../shared/service-webview-bridge";
import {
  PAGE_TO_PRELOAD_EVENT,
  PRELOAD_TO_PAGE_EVENT,
  PRELOAD_TO_PAGE_ACTION_EVENT,
  buildServiceWebviewMainWorldScript
} from "./service-webview-main-world";

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
  if (value.type && (SERVICE_WEBVIEW_BRIDGE_REQUEST_TYPES as readonly string[]).includes(value.type)) {
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
    value.type === DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE ||
    value.type === DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE ||
    value.type === DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE ||
    value.type === DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE ||
    value.type === DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE ||
    Boolean(value.type && /:auth:response$/u.test(value.type));
}

webFrame.executeJavaScriptInIsolatedWorld(0, [{
  code: buildServiceWebviewMainWorldScript()
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

ipcRenderer.on(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, (_event, payload: ServiceWebviewBridgeMessage) => {
  if (!isBridgeMessage(payload) || payload.type !== DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE) {
    return;
  }
  window.dispatchEvent(new CustomEvent(PRELOAD_TO_PAGE_EVENT, { detail: payload }));
  sendBridgeDebug("route-changed", String(payload.reason || ""));
});

ipcRenderer.on(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, (_event, payload: Record<string, unknown>) => {
  if (!payload || typeof payload !== "object") {
    return;
  }
  window.dispatchEvent(new CustomEvent(PRELOAD_TO_PAGE_ACTION_EVENT, { detail: payload }));
  sendBridgeDebug("action-dispatched", String(payload.action || ""));
});
