export const WEBAPP_BRIDGE_MODULE_PATH = "/__desktop/bridge.js";

export const WEBAPP_BRIDGE_MODULE_SOURCE = String.raw`const ACTION_PATH = "/__desktop/actions/call";

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
  const response = await fetch(ACTION_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args })
  });
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

let capabilitiesPromise;
async function listCapabilities() {
  capabilitiesPromise ||= call("desktop.capabilities.list");
  try {
    return await capabilitiesPromise;
  } catch (error) {
    capabilitiesPromise = undefined;
    throw error;
  }
}

export const desktop = Object.freeze({
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
    chat: (input) => call("desktop.assistant.chat", input)
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
        return navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, ...constraints },
          video: false
        });
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
