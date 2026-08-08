import { ipcRenderer, webFrame } from "electron";
import {
  AGENT_AUTH_REQUEST_TYPE,
  AGENT_AUTH_RESPONSE_TYPE
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
  WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION,
  WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION,
  WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL
} from "../shared/webview-context-menu";
import {
  WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL,
  WEBVIEW_SELECTION_TOOLBAR_VERSION,
  type WebviewSelectionToolbarChange,
  type WebviewSelectionToolbarRect
} from "../shared/webview-selection-toolbar";
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

let selectionGestureActive = false;
let selectionToolbarFrame = 0;
let selectionToolbarSignature = "";

function selectionElement(node: Node | null) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
}

function selectionTouchesEditableContent(selection: Selection, range: Range) {
  const candidates = [
    selectionElement(selection.anchorNode),
    selectionElement(selection.focusNode),
    selectionElement(range.commonAncestorContainer)
  ];
  return candidates.some((element) => Boolean(
    element && (
      (element as HTMLElement).isContentEditable ||
      element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
    )
  ));
}

function clipRectToViewport(rect: DOMRect): WebviewSelectionToolbarRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function readSelectionToolbarChange(): WebviewSelectionToolbarChange | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;
  const range = selection.getRangeAt(0);
  if (selectionTouchesEditableContent(selection, range)) return null;
  const visibleRects = Array.from(range.getClientRects())
    .map(clipRectToViewport)
    .filter((rect): rect is WebviewSelectionToolbarRect => Boolean(rect));
  if (visibleRects.length === 0) return null;
  const left = Math.min(...visibleRects.map((rect) => rect.x));
  const top = Math.min(...visibleRects.map((rect) => rect.y));
  const right = Math.max(...visibleRects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...visibleRects.map((rect) => rect.y + rect.height));
  const probeRect = visibleRects[0];
  return {
    version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
    visible: true,
    rect: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    },
    probe: {
      x: probeRect.x + probeRect.width / 2,
      y: probeRect.y + probeRect.height / 2
    }
  };
}

function selectionSignature(change: WebviewSelectionToolbarChange) {
  if (!change.visible) return "";
  const selection = window.getSelection();
  return [
    selection?.anchorOffset ?? 0,
    selection?.focusOffset ?? 0,
    selection?.toString().length ?? 0,
    change.rect.x,
    change.rect.y,
    change.rect.width,
    change.rect.height
  ].join(":");
}

function publishSelectionToolbarChange(change: WebviewSelectionToolbarChange | null) {
  if (!change) {
    if (!selectionToolbarSignature) return;
    selectionToolbarSignature = "";
    ipcRenderer.send(WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL, {
      version: WEBVIEW_SELECTION_TOOLBAR_VERSION,
      visible: false
    } satisfies WebviewSelectionToolbarChange);
    return;
  }
  const signature = selectionSignature(change);
  if (signature === selectionToolbarSignature) return;
  selectionToolbarSignature = signature;
  ipcRenderer.send(WEBVIEW_SELECTION_TOOLBAR_CHANGE_CHANNEL, change);
}

function scheduleSelectionToolbarPublish() {
  if (selectionGestureActive || selectionToolbarFrame) return;
  selectionToolbarFrame = window.requestAnimationFrame(() => {
    selectionToolbarFrame = 0;
    publishSelectionToolbarChange(readSelectionToolbarChange());
  });
}

function clearSelectionToolbar() {
  if (selectionToolbarFrame) {
    window.cancelAnimationFrame(selectionToolbarFrame);
    selectionToolbarFrame = 0;
  }
  publishSelectionToolbarChange(null);
}

function installSelectionToolbarTracking() {
  window.addEventListener("pointerdown", () => {
    selectionGestureActive = true;
    clearSelectionToolbar();
  }, true);
  window.addEventListener("pointerup", () => {
    selectionGestureActive = false;
    scheduleSelectionToolbarPublish();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      selectionGestureActive = false;
      clearSelectionToolbar();
      return;
    }
    if (event.shiftKey) {
      selectionGestureActive = true;
      clearSelectionToolbar();
    }
  }, true);
  window.addEventListener("keyup", () => {
    selectionGestureActive = false;
    scheduleSelectionToolbarPublish();
  }, true);
  document.addEventListener("selectionchange", scheduleSelectionToolbarPublish);
  window.addEventListener("scroll", clearSelectionToolbar, true);
  window.addEventListener("resize", clearSelectionToolbar);
  window.addEventListener("pagehide", clearSelectionToolbar);
}

installSelectionToolbarTracking();

function isAgentAuthRequestType(type: string | undefined | null) {
  return type === AGENT_AUTH_REQUEST_TYPE;
}

function isAgentAuthResponseType(type: string | undefined | null) {
  return type === AGENT_AUTH_RESPONSE_TYPE;
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
  if (isServiceWebviewBridgeRequestType(value.type)) {
    return Boolean(value.requestId);
  }
  return Boolean(
    value.requestId &&
      isAgentAuthRequestType(value.type) &&
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
    isAgentAuthResponseType(value.type);
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
  if (
    isBridgeMessage(event.data) &&
    event.data.type === WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL &&
    event.source === window &&
    event.origin === window.location.origin
  ) {
    const { type: _type, ...payload } = event.data;
    ipcRenderer.send(WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL, payload);
    return;
  }
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
  if (isAgentAuthResponseType(payload.type)) {
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
  if (
    !payload ||
    typeof payload !== "object" ||
    ![
      "openChatHistory",
      WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION,
      WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION
    ].includes(String(payload.action || ""))
  ) {
    return;
  }
  window.dispatchEvent(new CustomEvent(PRELOAD_TO_PAGE_ACTION_EVENT, { detail: payload }));
  sendBridgeDebug("action-dispatched", String(payload.action || ""));
});
