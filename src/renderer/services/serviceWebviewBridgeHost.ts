import type { PluginAuthBridgeProtocol } from "../../shared/auth-bridge";
import type { PluginSettingsValues } from "../../shared/contracts";
import {
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_REQUEST_TYPE,
  DESKTOP_DIALOG_SELECT_DIRECTORY_RESPONSE_TYPE,
  DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE,
  DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE,
  DESKTOP_SHELL_OPEN_PATH_REQUEST_TYPE,
  DESKTOP_SHELL_OPEN_PATH_RESPONSE_TYPE,
  PLUGIN_SETTINGS_READ_REQUEST_TYPE,
  PLUGIN_SETTINGS_READ_RESPONSE_TYPE,
  PLUGIN_SETTINGS_WRITE_REQUEST_TYPE,
  PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE,
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

  if (payload.type === DESKTOP_DOWNLOAD_FILE_REQUEST_TYPE) {
    void window.electronAPI.desktopDownloads
      .saveFile({
        filename: typeof payload.filename === "string" ? payload.filename : "",
        mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "",
        dataBase64: typeof payload.dataBase64 === "string" ? payload.dataBase64 : ""
      })
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          message: result.message ?? "",
          path: result.path ?? ""
        });
      })
      .catch((reason) => {
        sendFailure(context, DESKTOP_DOWNLOAD_FILE_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  if (payload.type === DESKTOP_SCREENSHOT_CAPTURE_REQUEST_TYPE) {
    void window.electronAPI.desktopScreenshot
      .capture()
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          message: result.message ?? "",
          dataBase64: result.dataBase64,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
          sizeBytes: result.sizeBytes,
          cancelled: result.cancelled
        });
      })
      .catch((reason) => {
        sendFailure(context, DESKTOP_SCREENSHOT_CAPTURE_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  if (payload.type === PLUGIN_SETTINGS_READ_REQUEST_TYPE) {
    const serviceId = context.serviceId?.trim() ?? "";
    if (!serviceId) {
      sendFailure(context, PLUGIN_SETTINGS_READ_RESPONSE_TYPE, payload.requestId, "plugin settings service id is unavailable");
      return true;
    }
    void window.electronAPI.services
      .readPluginSettings(serviceId)
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: PLUGIN_SETTINGS_READ_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          values: result.values,
          defaults: result.defaults,
          schema: result.schema,
          shortcutStatuses: result.shortcutStatuses
        });
      })
      .catch((reason) => {
        sendFailure(context, PLUGIN_SETTINGS_READ_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  if (payload.type === PLUGIN_SETTINGS_WRITE_REQUEST_TYPE) {
    const serviceId = context.serviceId?.trim() ?? "";
    if (!serviceId) {
      sendFailure(context, PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE, payload.requestId, "plugin settings service id is unavailable");
      return true;
    }
    void window.electronAPI.services
      .writePluginSettings(serviceId, (payload.values ?? {}) as PluginSettingsValues)
      .then((result) => {
        context.sendBridgeMessageToWebview({
          type: PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE,
          requestId: payload.requestId,
          ok: result.ok,
          message: result.message,
          values: result.values,
          defaults: result.defaults,
          schema: result.schema,
          shortcutStatuses: result.shortcutStatuses,
          restartRequired: result.restartRequired,
          changedKeys: result.changedKeys
        });
      })
      .catch((reason) => {
        sendFailure(context, PLUGIN_SETTINGS_WRITE_RESPONSE_TYPE, payload.requestId, errorMessage(reason));
      });
    return true;
  }

  return false;
}
