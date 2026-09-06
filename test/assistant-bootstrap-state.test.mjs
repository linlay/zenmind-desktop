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
  "modules",
  "assistant",
  "first-install-bootstrap-navigation.js",
));
const { registerAssistantIpcHandlers } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "modules",
  "assistant",
  "ipc.js",
));
const { readEnterpriseImSettings } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "modules",
  "enterprise-chat",
  "settings.js",
));
const { desktopDataRootExists } = require(path.join(
  __dirname,
  "..",
  "dist-electron",
  "main",
  "infrastructure",
  "filesystem",
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
    conversationShare: {
      exportChatHtml() {}, create() {}, list() {}, revoke() {},
    },
    assistantNavigationStatusClient: {},
    desktopActionRendererRequests: new Map(),
    desktopActionConfirmationRequests: new Map(),
    desktopActionOptions: {},
    app: { once() {} },
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

  const startupSnapshot = [
    "const startupPlatform = process.platform;",
    "const isFirstDesktopInstall = !desktopDataRootExists(app, startupPlatform);",
    "const runtimeRootAtProcessStart = resolveRuntimeRoot(app, startupPlatform);",
    "const runtimeRootExistedAtStartup = runtimeRootExists(app, startupPlatform);",
    "const runtimeEnvExistedAtStartup = runtimeEnvExists(app, startupPlatform);",
    "const firstInstallBootstrapNavigation = createFirstInstallBootstrapNavigation(isFirstDesktopInstall);",
  ];
  let previousIndex = runtimeSource.indexOf("export function createMainProcessRuntime()");
  assert.notEqual(previousIndex, -1);
  for (const statement of startupSnapshot) {
    const statementIndex = runtimeSource.indexOf(statement, previousIndex);
    assert.notEqual(statementIndex, -1, `missing startup snapshot statement: ${statement}`);
    assert.ok(statementIndex > previousIndex);
    previousIndex = statementIndex;
  }
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
