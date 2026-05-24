import type { PluginAuthBridgeProtocol } from "../../shared/auth-bridge";
import {
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE,
  type ServiceWebviewBridgeMessage
} from "../../shared/service-webview-bridge";

export type ServiceWebviewBridgeHostContext = {
  serviceId?: string | null;
  bridgeProtocol?: PluginAuthBridgeProtocol | null;
  sendBridgeMessageToWebview: (payload: ServiceWebviewBridgeMessage) => void;
  setBridgeError: (message: string) => void;
  logDebug?: (stage: string, message: string) => void;
};

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function hasRequestId(payload: ServiceWebviewBridgeMessage) {
  return Boolean(payload.requestId);
}

function sendFailure(
  context: ServiceWebviewBridgeHostContext,
  type: string,
  requestId: string | undefined,
  message: string
) {
  context.sendBridgeMessageToWebview({
    type,
    requestId,
    ok: false,
    message
  });
}

export function handleServiceWebviewBridgeMessage(
  payload: ServiceWebviewBridgeMessage,
  context: ServiceWebviewBridgeHostContext
) {
  if (!payload.type || !hasRequestId(payload)) {
    return false;
  }

  if (payload.type === SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE) {
    context.logDebug?.(String(payload.stage || ""), String(payload.message || ""));
    return true;
  }

  const bridgeProtocol = context.bridgeProtocol;
  if (
    bridgeProtocol &&
    payload.type === bridgeProtocol.requestType &&
    (payload.action === "getAccessToken" || payload.action === "refreshAccessToken")
  ) {
    void window.electronAPI.agentAuth
      .issueAccessToken(payload.reason === "unauthorized" ? "unauthorized" : "missing")
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: bridgeProtocol.responseType,
          requestId: payload.requestId,
          token: result.ok ? result.token : null
        });
        if (!result.ok) {
          context.setBridgeError(result.message);
        }
      })
      .catch((reason) => {
        context.setBridgeError(errorMessage(reason));
      });
    return true;
  }

  if (payload.type === AGENT_APP_CLIPBOARD_REQUEST_TYPE) {
    void window.electronAPI.clipboard
      .writeText(typeof payload.text === "string" ? payload.text : "")
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          message: result.message ?? ""
        });
      })
      .catch((reason) => {
        sendFailure(context, AGENT_APP_CLIPBOARD_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  if (payload.type === DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE) {
    void window.electronAPI.desktopDialog
      .selectDirectory()
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          path: result.path ?? "",
          message: result.message ?? ""
        });
      })
      .catch((reason) => {
        sendFailure(context, DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  if (payload.type === DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE) {
    void window.electronAPI.desktopShell
      .openPath(typeof payload.path === "string" ? payload.path : "")
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          message: result.message ?? "",
          path: result.path ?? ""
        });
      })
      .catch((reason) => {
        sendFailure(context, DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  return false;
}
