export const WEBAPP_BRIDGE_MODULE_PATH = "/__desktop/bridge.js";

export const WEBAPP_BRIDGE_MODULE_SOURCE = String.raw`const ACTION_PATH = "/__desktop/actions/call";
const APP_CONFIG_PATH = "/__desktop/app-config.json";

export class DesktopBridgeError extends Error {
  constructor(action, code, message, details) {
    super(message || code || "Desktop Bridge request failed");
    this.name = "DesktopBridgeError";
    this.action = action || "unknown";
    this.code = code || "action_failed";
    if (details !== undefined) this.details = details;
  }
}

async function call(action, args = {}) {
  let body;
  try {
    body = JSON.stringify({ action, args });
  } catch {
    throw new DesktopBridgeError(action, "invalid_args", "Desktop Bridge arguments must be JSON serializable.");
  }
  let response;
  try {
    response = await fetch(ACTION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
  } catch (error) {
    throw new DesktopBridgeError(
      action,
      "bridge_unavailable",
      "Desktop Bridge is unavailable.",
      { cause: error?.name || "Error" }
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DesktopBridgeError(action, "invalid_response", "Desktop Bridge returned an invalid response.");
  }
  if (!response.ok || !payload?.ok) {
    throw new DesktopBridgeError(
      payload?.action || action,
      payload?.error?.code || "action_failed",
      payload?.error?.message || "Desktop Bridge request failed with HTTP " + response.status + ".",
      payload?.error?.details
    );
  }
  return payload.result;
}

function reserved(action) {
  return async function reservedDesktopCapability() {
    throw new DesktopBridgeError(
      action,
      "not_implemented",
      "This capability is reserved but not implemented in the current Desktop version."
    );
  };
}

async function listCapabilities() {
  return call("desktop.capabilities.list");
}

async function getAppConfig() {
  let response;
  try {
    response = await fetch(APP_CONFIG_PATH, { headers: { "Accept": "application/json" } });
  } catch (error) {
    throw new DesktopBridgeError(
      "desktop.app.getConfig",
      "bridge_unavailable",
      "WebApp configuration is unavailable.",
      { cause: error?.name || "Error" }
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DesktopBridgeError(
      "desktop.app.getConfig",
      "invalid_response",
      "Desktop returned an invalid WebApp configuration."
    );
  }
  if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DesktopBridgeError(
      "desktop.app.getConfig",
      "invalid_response",
      "Desktop returned an invalid WebApp configuration."
    );
  }
  const appConfig = payload.appConfig;
  if (!appConfig || typeof appConfig !== "object" || Array.isArray(appConfig)) {
    throw new DesktopBridgeError(
      "desktop.app.getConfig",
      "invalid_response",
      "Desktop returned an invalid appConfig."
    );
  }
  return appConfig;
}

export const desktop = Object.freeze({
  app: Object.freeze({
    getConfig: getAppConfig
  }),
  capabilities: Object.freeze({
    list: listCapabilities,
    async has(id) {
      const result = await listCapabilities();
      return result.capabilities.some((capability) =>
        capability.id === id && capability.status === "available" && capability.declared === true
      );
    }
  }),
  assistant: Object.freeze({
    chat: (message) => call("desktop.assistant.chat", { message })
  }),
  native: Object.freeze({
    browser: Object.freeze({
      openExternal: (input) => call("desktop.native.browser.openExternal", input)
    }),
    dialog: Object.freeze({
      selectFiles: (input = {}) => call("desktop.native.dialog.selectFiles", input),
      selectDirectory: () => call("desktop.native.dialog.selectDirectory"),
      selectSavePath: (input = {}) => call("desktop.native.dialog.selectSavePath", input)
    }),
    microphone: Object.freeze({
      getPermission: () => call("desktop.native.microphone.getPermission"),
      requestAccess: () => call("desktop.native.microphone.requestAccess"),
      async open(constraints = {}) {
        await call("desktop.native.microphone.requestAccess");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DesktopBridgeError(
            "desktop.native.microphone.open",
            "unavailable",
            "Microphone capture is unavailable in this WebApp."
          );
        }
        if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
          throw new DesktopBridgeError(
            "desktop.native.microphone.open",
            "invalid_args",
            "Microphone constraints must be an object."
          );
        }
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, ...constraints },
            video: false
          });
        } catch (error) {
          const permissionDenied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
          throw new DesktopBridgeError(
            "desktop.native.microphone.open",
            permissionDenied ? "permission_denied" : "media_unavailable",
            permissionDenied ? "Microphone permission was denied." : "Microphone capture failed.",
            { cause: error?.name || "Error" }
          );
        }
      }
    }),
    clipboard: Object.freeze({
      writeText: (input) => call("desktop.native.clipboard.writeText", input),
      readText: reserved("desktop.native.clipboard.readText")
    }),
    notification: Object.freeze({
      show: (input) => call("desktop.native.notification.show", input)
    }),
    screen: Object.freeze({
      capture: reserved("desktop.native.screen.capture")
    }),
    file: Object.freeze({
      reveal: reserved("desktop.native.file.reveal")
    }),
    window: Object.freeze({
      getState: reserved("desktop.native.window.getState"),
      minimize: reserved("desktop.native.window.minimize"),
      maximize: reserved("desktop.native.window.maximize"),
      restore: reserved("desktop.native.window.restore"),
      close: reserved("desktop.native.window.close")
    }),
    camera: Object.freeze({
      getPermission: reserved("desktop.native.camera.getPermission"),
      requestAccess: reserved("desktop.native.camera.requestAccess"),
      open: reserved("desktop.native.camera.open")
    }),
    share: Object.freeze({
      open: reserved("desktop.native.share.open")
    })
  })
});
`;
