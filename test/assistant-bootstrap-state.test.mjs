import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createFirstInstallBootstrapNavigation } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "assistant",
  "core",
  "first-install-bootstrap-navigation.js",
));
const { registerAssistantIpcHandlers } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "ipc",
  "assistant-handlers.js",
));

function registerFirstInstallNavigationHandler(navigation) {
  const handlers = new Map();
  registerAssistantIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    assistantBridge: {},
    assistantNavigationStatusClient: {},
    desktopActionRendererRequests: new Map(),
    desktopActionConfirmationRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    consumeFirstInstallBootstrapNavigation: () => navigation.consume(),
    platform: "darwin",
  });
  return handlers.get("assistant.consumeFirstInstallBootstrapNavigation");
}

test("first Desktop install bootstrap navigation is consumed exactly once", () => {
  const navigation = createFirstInstallBootstrapNavigation(true);

  assert.deepEqual(navigation.consume(), { shouldOpen: true });
  assert.deepEqual(navigation.consume(), { shouldOpen: false });
  assert.deepEqual(navigation.consume(), { shouldOpen: false });
});

test("ordinary starts, updates, and data-preserving reinstalls do not open bootstrap", () => {
  const navigation = createFirstInstallBootstrapNavigation(false);

  assert.deepEqual(navigation.consume(), { shouldOpen: false });
  assert.deepEqual(navigation.consume(), { shouldOpen: false });
});

test("assistant IPC exposes the process-local first-install navigation consumer", async () => {
  const navigation = createFirstInstallBootstrapNavigation(true);
  const consume = registerFirstInstallNavigationHandler(navigation);

  assert.equal(typeof consume, "function");
  assert.deepEqual(await consume(), { shouldOpen: true });
  assert.deepEqual(await consume(), { shouldOpen: false });
});
