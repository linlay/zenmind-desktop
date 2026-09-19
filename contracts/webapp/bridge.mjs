const ACTION_PATH = "/__desktop/actions/call";
const ASSISTANT_IMAGE_UPLOAD_PATH = "/__desktop/assistant/image/uploads";
const APP_CONFIG_PATH = "/__desktop/app-config.json";
const USER_CONFIG_PATH = "/__desktop/user-config.json";

export class DesktopBridgeError extends Error {
  constructor(action, code, message, details) {
    super(message || code || "Desktop Bridge request failed");
    this.name = "DesktopBridgeError";
    this.action = action || "unknown";
    this.code = code || "action_failed";
    if (details !== undefined) this.details = details;
  }
}

async function call(action, args = {}, transport, signal) {
  let body;
  try {
    body = JSON.stringify({ action, args });
  } catch {
    throw new DesktopBridgeError(action, "invalid_args", "Desktop Bridge arguments must be JSON serializable.");
  }
  let response;
  try {
    response = await fetch(transport?.url || ACTION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(transport ? { Authorization: "Bearer " + transport.token } : {}) },
      credentials: "omit", redirect: "error", signal,
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

async function uploadAssistantImageInputs(source, mask) {
  if (!(source instanceof Blob)) {
    throw new DesktopBridgeError(
      "assistant.image",
      "invalid_args",
      "source must be an image Blob."
    );
  }
  if (mask !== undefined && mask !== null && !(mask instanceof Blob)) {
    throw new DesktopBridgeError(
      "assistant.image",
      "invalid_args",
      "mask must be a PNG Blob."
    );
  }
  const form = new FormData();
  form.set("source", source, source.name || "image-studio-source.png");
  if (mask instanceof Blob) {
    form.set("mask", mask, mask.name || "image-studio-mask.png");
  }
  let response;
  try {
    response = await fetch(ASSISTANT_IMAGE_UPLOAD_PATH, { method: "POST", body: form });
  } catch (error) {
    throw new DesktopBridgeError(
      "assistant.image",
      "bridge_unavailable",
      "Desktop image upload bridge is unavailable.",
      { cause: error?.name || "Error" }
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DesktopBridgeError(
      "assistant.image",
      "invalid_response",
      "Desktop image upload bridge returned an invalid response."
    );
  }
  if (!response.ok || !payload?.ok || typeof payload.uploadId !== "string") {
    throw new DesktopBridgeError(
      "assistant.image",
      payload?.error?.code || "image_upload_failed",
      payload?.error?.message || "Desktop image upload failed."
    );
  }
  return payload.uploadId;
}

async function generateAssistantImage(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DesktopBridgeError("assistant.image", "invalid_args", "Image request must be an object.");
  }
  const { source, mask, ...request } = input;
  const uploadId = source instanceof Blob
    ? await uploadAssistantImageInputs(source, mask)
    : "";
  if (mask instanceof Blob && !uploadId) {
    throw new DesktopBridgeError("assistant.image", "invalid_args", "mask requires a source image.");
  }
  return call("assistant.image", {
    ...request,
    ...(uploadId ? { uploadId } : {})
  });
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

async function getUserConfig() {
  let response;
  try {
    response = await fetch(USER_CONFIG_PATH, { headers: { "Accept": "application/json" } });
  } catch (error) {
    throw new DesktopBridgeError(
      "desktop.app.getUserConfig",
      "bridge_unavailable",
      "WebApp user configuration is unavailable.",
      { cause: error?.name || "Error" }
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DesktopBridgeError(
      "desktop.app.getUserConfig",
      "invalid_response",
      "Desktop returned an invalid WebApp user configuration."
    );
  }
  const values = payload?.values;
  if (!response.ok || !values || typeof values !== "object" || Array.isArray(values)) {
    throw new DesktopBridgeError(
      "desktop.app.getUserConfig",
      "invalid_response",
      "Desktop returned an invalid WebApp user configuration."
    );
  }
  return values;
}

export const desktop = Object.freeze({
  requestAccess: (input) => {
    if (!navigator.userActivation?.isActive) throw new DesktopBridgeError("desktop.requestAccess", "user_gesture_required", "Click to grant application access.");
    return call("desktop.requestAccess", input);
  },
  authenticateConnector: (input) => {
    if (!navigator.userActivation?.isActive) throw new DesktopBridgeError("desktop.authenticateConnector", "user_gesture_required", "Click to sign in to the connector.");
    return call("desktop.authenticateConnector", input);
  },
  app: Object.freeze({
    getConfig: getAppConfig,
    getUserConfig
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
    browser: Object.freeze({
      openExternal: (input) => call("desktop.browser.openExternal", input)
    }),
    dialog: Object.freeze({
      selectFiles: (input = {}) => call("desktop.dialog.selectFiles", input),
      selectDirectory: () => call("desktop.dialog.selectDirectory"),
      selectSavePath: (input = {}) => call("desktop.dialog.selectSavePath", input)
    }),
    microphone: Object.freeze({
      getPermission: () => call("desktop.microphone.getPermission"),
      requestAccess: () => call("desktop.microphone.requestAccess"),
      async open(constraints = {}) {
        await call("desktop.microphone.requestAccess");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DesktopBridgeError(
            "desktop.microphone.open",
            "unavailable",
            "Microphone capture is unavailable in this WebApp."
          );
        }
        if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
          throw new DesktopBridgeError(
            "desktop.microphone.open",
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
            "desktop.microphone.open",
            permissionDenied ? "permission_denied" : "media_unavailable",
            permissionDenied ? "Microphone permission was denied." : "Microphone capture failed.",
            { cause: error?.name || "Error" }
          );
        }
      }
    }),
    clipboard: Object.freeze({
      writeText: (input) => call("desktop.clipboard.writeText", input),
      readText: reserved("desktop.clipboard.readText")
    }),
    notification: Object.freeze({
      show: (input) => call("desktop.notification.show", input)
    }),
    screen: Object.freeze({
      capture: reserved("desktop.screen.capture")
    }),
    file: Object.freeze({
      reveal: reserved("desktop.file.reveal")
    }),
    window: Object.freeze({
      getState: reserved("desktop.window.getState"),
      minimize: reserved("desktop.window.minimize"),
      maximize: reserved("desktop.window.maximize"),
      restore: reserved("desktop.window.restore"),
      close: reserved("desktop.window.close")
    }),
    camera: Object.freeze({
      getPermission: reserved("desktop.camera.getPermission"),
      requestAccess: reserved("desktop.camera.requestAccess"),
      open: reserved("desktop.camera.open")
    }),
    share: Object.freeze({
      open: reserved("desktop.share.open")
    })
});

const image = Object.assign(generateAssistantImage, {
  cancel: (requestId) => call("assistant.image.cancel", { requestId })
});
function createDataClient(call, image) {
const connector = Object.freeze({
  list: () => call("connector.list"),
  describe: (input) => call("connector.describe", input),
  invoke: (input) => call("connector.invoke", input)
});
const skill = Object.freeze({ list: () => call("skill.list"), describe: (input) => call("skill.describe", input) });
const automation = Object.freeze({
  list: reserved("automation.list"), get: reserved("automation.get"),
  create: reserved("automation.create"), update: reserved("automation.update"),
  pause: reserved("automation.pause"), resume: reserved("automation.resume"), remove: reserved("automation.remove"),
  runs: Object.freeze({ list: reserved("automation.runs.list"), get: reserved("automation.runs.get") })
});
const kanban = Object.freeze({
  boards: Object.freeze({ list: () => call("kanban.boards.list") }),
  issues: Object.freeze({ list: (input = {}) => call("kanban.issues.list", input), get: (input) => call("kanban.issues.get", input) })
});
const artifact = Object.freeze({
  open: (input) => call("artifact.open", input),
  saveAs: (input) => call("artifact.saveAs", input),
  list: (input) => call("artifact.list", input),
  get: (input) => call("artifact.get", input),
  read: async (input) => {
    const result = await call("artifact.read", input);
    if (typeof result?.dataBase64 !== "string") throw new DesktopBridgeError("artifact.read", "invalid_response", "Invalid artifact response.");
    const bytes = Uint8Array.from(atob(result.dataBase64), value => value.charCodeAt(0));
    return new Blob([bytes]).stream();
  }
});
const assistant = Object.freeze({
  stop: (input) => call("assistant.stop", input),
  async *subscribe(input, { signal } = {}) {
    let cursor = input.cursor || 0;
    while (!signal?.aborted) {
      const result = await call("assistant.events", { runId: input.runId, cursor }, signal);
      for (const event of result.events) { if (signal?.aborted) return; yield event; }
      cursor = result.cursor;
      if (result.terminal) return;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 500);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  },
  chat: (input) => call("assistant.chat", typeof input === "string" ? { message: input } : input),
  image
});
return Object.freeze({ connector, skill, automation, kanban, artifact, assistant });
}
export const { connector, skill, automation, kanban, artifact, assistant } = createDataClient((action, args, signal) => call(action, args, undefined, signal), Object.freeze(image));

// Copy the generated bridge.mjs into a managed Node backend. Credentials stay
// in that process and must never be forwarded to frontend code or logs.
export function createBackendClient({ url, token }) {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.pathname !== "/webapps" || target.username || target.password || target.search || target.hash ||
      typeof token !== "string" || !token) {
    throw new DesktopBridgeError("backend.init", "invalid_args", "Use Desktop's injected backend bridge configuration.");
  }
  const transport = { url: target.href.replace(/\/$/u, "") + "/actions/call", token };
  const client = createDataClient((action, args, signal) => call(action, args, transport, signal), reserved("assistant.image"));
  return Object.freeze({ ...client, artifact: Object.freeze({
    list: client.artifact.list, get: client.artifact.get, read: client.artifact.read,
    open: reserved("artifact.open"), saveAs: reserved("artifact.saveAs")
  }) });
}
