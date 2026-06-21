import { ipcRenderer, webFrame } from "electron";
import {
  AGENT_APP_AUTH_REQUEST_TYPE,
  AGENT_APP_AUTH_RESPONSE_TYPE,
} from "../shared/auth-bridge";
import {
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  isServiceWebviewBridgeRequestType,
  isServiceWebviewBridgeResponseType,
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

const BRIDGE_REQUEST_DEDUPE_WINDOW_MS = 5_000;
const recentForwardedBridgeRequestKeys = new Map<string, number>();

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
  if (isServiceWebviewBridgeRequestType(value.type)) {
    return Boolean(value.requestId);
  }
  return Boolean(
    value.requestId &&
      value.type === AGENT_APP_AUTH_REQUEST_TYPE &&
      (value.action === "getAccessToken" || value.action === "refreshAccessToken")
  );
}

function forwardDesktopBridgeRequest(
  value: ServiceWebviewBridgeMessage,
  origin: string,
  debugStage: "bridge-request" | "bridge-window-message"
) {
  if (!isDesktopBridgeRequest(value) || !value.type || !value.requestId) {
    return;
  }

  const now = Date.now();
  for (const [key, expiresAt] of recentForwardedBridgeRequestKeys) {
    if (expiresAt <= now) {
      recentForwardedBridgeRequestKeys.delete(key);
    }
  }

  const requestKey = `${value.type}:${value.requestId}`;
  if (recentForwardedBridgeRequestKeys.has(requestKey)) {
    sendBridgeDebug("bridge-request-duplicate", String(value.type || ""));
    return;
  }
  recentForwardedBridgeRequestKeys.set(requestKey, now + BRIDGE_REQUEST_DEDUPE_WINDOW_MS);

  ipcRenderer.sendToHost(SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL, {
    ...value,
    origin
  });
  sendBridgeDebug(debugStage, String(value.type || ""));
}

function isDesktopBridgeDeliver(value: ServiceWebviewBridgeMessage) {
  return isServiceWebviewBridgeResponseType(value.type) ||
    value.type === DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE ||
    value.type === DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE ||
    value.type === AGENT_APP_AUTH_RESPONSE_TYPE;
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

  forwardDesktopBridgeRequest(payload, window.location.origin, "bridge-request");
});

window.addEventListener("message", (event) => {
  if (!isBridgeMessage(event.data) || !isDesktopBridgeRequest(event.data)) {
    return;
  }

  forwardDesktopBridgeRequest(event.data, event.origin, "bridge-window-message");
});

ipcRenderer.on(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, (_event, payload: ServiceWebviewBridgeMessage) => {
  if (!isBridgeMessage(payload) || !isDesktopBridgeDeliver(payload)) {
    return;
  }
  window.dispatchEvent(new CustomEvent(PRELOAD_TO_PAGE_EVENT, { detail: payload }));
  if (payload.type === AGENT_APP_AUTH_RESPONSE_TYPE) {
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
