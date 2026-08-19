import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
const { readEnterpriseImSettings } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "enterprise-im-settings.js",
));
const { desktopDataRootExists } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "user-paths.js",
));

function createTestApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      throw new Error(`Unexpected app path: ${name}`);
    },
  };
}

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

test("first-install navigation snapshot survives later Desktop data-root creation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-first-install-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const platform of ["darwin", "win32"]) {
    const app = createTestApp(path.join(root, platform, "home"));

    assert.equal(desktopDataRootExists(app, platform), false);
    const navigation = createFirstInstallBootstrapNavigation(
      !desktopDataRootExists(app, platform),
    );

    readEnterpriseImSettings(app, platform);
    assert.equal(desktopDataRootExists(app, platform), true);
    assert.deepEqual(navigation.consume(), { shouldOpen: true });
    assert.deepEqual(navigation.consume(), { shouldOpen: false });
  }
});

test("main runtime freezes first-install navigation before any startup initialization", () => {
  const runtimeSource = fs.readFileSync(path.join(
    __dirname,
    "..",
    "src",
    "main",
    "app",
    "runtime.ts",
  ), "utf8");

  assert.match(
    runtimeSource,
    /export function createMainProcessRuntime\(\) \{\s*const startupPlatform = process\.platform;\s*const isFirstDesktopInstall = !desktopDataRootExists\(app, startupPlatform\);\s*const runtimeRootAtProcessStart = resolveRuntimeRoot\(app, startupPlatform\);\s*const runtimeRootExistedAtStartup = runtimeRootExists\(app, startupPlatform\);\s*const runtimeEnvExistedAtStartup = runtimeEnvExists\(app, startupPlatform\);\s*const firstInstallBootstrapNavigation = createFirstInstallBootstrapNavigation\(isFirstDesktopInstall\);/,
  );
});

test("main runtime freezes the runtime-root snapshot before startup runtimes can create Desktop directories", () => {
  const runtimeSource = fs.readFileSync(path.join(
    __dirname,
    "..",
    "src",
    "main",
    "app",
    "runtime.ts",
  ), "utf8");

  const runtimeRootSnapshotIndex = runtimeSource.indexOf(
    "const runtimeRootExistedAtStartup = runtimeRootExists(app, startupPlatform);",
  );
  const firstRuntimeInitializationIndex = runtimeSource.indexOf(
    "configureAgentMarketPlatformCaller(",
  );

  assert.notEqual(runtimeRootSnapshotIndex, -1);
  assert.notEqual(firstRuntimeInitializationIndex, -1);
  assert.ok(runtimeRootSnapshotIndex < firstRuntimeInitializationIndex);
  assert.equal(
    runtimeSource.indexOf("const runtimeRootExistedAtStartup =", runtimeRootSnapshotIndex + 1),
    -1,
  );
});

test("assistant IPC exposes the process-local first-install navigation consumer", async () => {
  const navigation = createFirstInstallBootstrapNavigation(true);
  const consume = registerFirstInstallNavigationHandler(navigation);

  assert.equal(typeof consume, "function");
  assert.deepEqual(await consume(), { shouldOpen: true });
  assert.deepEqual(await consume(), { shouldOpen: false });
});
