import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const FIXTURE_INTERNAL_AGENT_KEY = "fixture-internal-agent";

const {
  handleDesktopActionRequest,
  handleWebappPageActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge,
  __testInternals
} = require("../dist-electron/main/desktop-action-bridge.js");
const {
  DesktopCdpTimeoutError
} = require("../dist-electron/main/desktop-cdp-debugger.js");
const {
  writeDesktopActionBridgeSettingsConfig
} = require("../dist-electron/main/desktop-action-bridge-settings.js");
const {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_DEFINITIONS
} = require("../dist-electron/shared/desktop-actions.js");
const {
  normalizeActionBridgeTimePayload
} = require("../dist-electron/main/action-bridge-time-normalizer.js");
const {
  getWebsitePath
} = require("../dist-electron/main/webs/websites/store.js");
const {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebappStateRoot
} = require("../dist-electron/main/user-paths.js");
const {
  issueWebappActionToken,
  revokeWebappActionToken
} = require("../dist-electron/main/webs/webapps/action-tokens.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      if (name === "temp") {
        return path.join(homePath, "tmp");
      }
      if (name === "documents") {
        return path.join(homePath, "Documents");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getAppPath() {
      return process.cwd();
    },
    getVersion() {
      return "0.0.0-test";
    }
  };
}

function createDesktopActionOptions(t) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-action-bridge-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));

  const appearances = [
    { id: "classic", displayName: "Classic", description: "Builtin pet." },
    { id: "user:dario", displayName: "Dario", description: "Local pet." }
  ];
  const state = {
    supported: true,
    enabled: true,
    appearanceId: "classic",
    appearanceOptions: appearances,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const calls = {
    refreshState: 0,
    saveSettings: [],
    completions: [],
    fileDialogs: [],
    saveDialogs: [],
    externalUrls: [],
    clipboardWrites: [],
    notifications: [],
    navigation: []
  };

  return {
    calls,
    state,
    options: {
      app: createApp(homePath),
      assistantBridge: {
        completeText: async (request) => {
          calls.completions.push(request);
          return {
            ok: true,
            runId: "run-assistant",
            chatId: "chat-assistant",
            text: "Hello world",
            message: "Hello world"
          };
        }
      },
      getMainWindow: () => null,
      getCurrentPageSnapshot: () => null,
      navigate: (route) => calls.navigation.push(route),
      openLogViewer: async () => ({ ok: true }),
      showFileDialog: async (dialogOptions) => {
        calls.fileDialogs.push(dialogOptions);
        return {
          canceled: false,
          filePaths: [path.join(homePath, "Documents", "Writing")]
        };
      },
      showSaveDialog: async (dialogOptions) => {
        calls.saveDialogs.push(dialogOptions);
        return {
          canceled: false,
          filePath: path.join(homePath, "Documents", dialogOptions.defaultPath ? path.basename(dialogOptions.defaultPath) : "result.txt")
        };
      },
      openExternal: async (url) => {
        calls.externalUrls.push(url);
      },
      writeClipboardText: (text) => {
        calls.clipboardWrites.push(text);
      },
      getMicrophonePermission: () => "granted",
      requestMicrophoneAccess: async () => true,
      showNotification: (input) => {
        calls.notifications.push(input);
        return true;
      },
      callRendererAction: async () => ({ ok: false }),
      executeCdpCommand: async () => {
        throw new Error("unexpected cdp call");
      },
      desktopPet: {
        refreshState: async () => {
          calls.refreshState += 1;
          return state;
        },
        saveSettings: async (input) => {
          calls.saveSettings.push(input);
          return { ...state, appearanceId: input.appearanceId };
        },
        show: async () => ({ ...state, enabled: true }),
        hide: async () => ({ ...state, enabled: false })
      }
    }
  };
}

async function writeStaticWebappArchive(root, id, label = "Lifecycle Test") {
  const archivePath = path.join(root, `${id}.zip`);
  const zip = new JSZip();
  zip.file(`${id}/webapp.json`, `${JSON.stringify({
    schemaVersion: 5,
    id,
    kind: "webapp",
    version: "1.0.0",
    target: "universal",
    label,
    frontend: {
      mode: "static",
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    desktopBridge: {
      version: 1,
      capabilities: []
    },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  }, null, 2)}\n`);
  zip.file(`${id}/frontend/index.html`, "<!doctype html><title>Lifecycle Test</title>");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

async function writeFailingNodeWebappArchive(root, id, label = "Failing Node") {
  const archivePath = path.join(root, `${id}-failing.zip`);
  const zip = new JSZip();
  zip.file(`${id}/webapp.json`, `${JSON.stringify({
    schemaVersion: 5,
    id,
    kind: "webapp",
    version: "1.0.0",
    target: "universal",
    label,
    frontend: {
      mode: "static",
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    desktopBridge: {
      version: 1,
      capabilities: []
    },
    backend: {
      launcher: "node",
      entry: "backend/server.mjs",
      args: [],
      env: {},
      port: 0,
      health: { type: "http", path: "/api/health", timeoutMs: 1000 }
    },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  }, null, 2)}\n`);
  zip.file(`${id}/frontend/index.html`, "<!doctype html><title>Failing Node</title>");
  zip.file(`${id}/backend/server.mjs`, "process.exitCode = 1;\n");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

function writeInstalledChatWebapp(app, id, agentKeys = {}) {
  const webappDir = path.join(getDesktopWebappsDataRoot(app), id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), JSON.stringify({
    schemaVersion: 5,
    id,
    kind: "webapp",
    version: "1.0.0",
    target: "universal",
    label: id,
    ...(agentKeys.internalAgentKey ? { internalAgentKey: agentKeys.internalAgentKey } : {}),
    ...(agentKeys.copilotAgentKey ? { copilotAgentKey: agentKeys.copilotAgentKey } : {}),
    frontend: {
      mode: "static",
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    desktopBridge: {
      version: 1,
      capabilities: ["assistant.chat"]
    }
  }), "utf8");
}

test("desktop assistant chat forwards a general message without business prompts", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const response = await handleDesktopActionRequest(options, {
    action: "desktop.assistant.chat",
    args: { message: "分析这段内容并给出建议" },
    permissionMode: "full_access"
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.text, "Hello world");
  assert.equal(response.result.runId, "run-assistant");
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.completions[0].message, "分析这段内容并给出建议");
  assert.equal(calls.completions[0].agentKey, "desktopAssistant");
  assert.equal(DESKTOP_ACTION_DEFINITIONS.some((definition) => definition.name === "desktop.assistant.chat"), true);
  assert.equal(DESKTOP_ACTION_DEFINITIONS.some((definition) => definition.name === "desktop.assistant.translate"), false);
  assert.equal(DESKTOP_ACTION_DEFINITIONS.some((definition) => definition.name.startsWith("desktop.page.")), false);

  const invalid = await handleDesktopActionRequest(options, {
    action: "desktop.assistant.chat",
    args: { message: "" },
    permissionMode: "full_access"
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_args");

  const oversized = await handleDesktopActionRequest(options, {
    action: "desktop.assistant.chat",
    args: { message: "x".repeat(12_001) },
    permissionMode: "full_access"
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "invalid_args");
});

test("WebApp assistant chat prefers internalAgentKey with Copilot and helper fallbacks", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  writeInstalledChatWebapp(options.app, "internal-chat", {
    internalAgentKey: FIXTURE_INTERNAL_AGENT_KEY,
    copilotAgentKey: "webOperator"
  });
  writeInstalledChatWebapp(options.app, "copilot-chat", {
    copilotAgentKey: "webOperator"
  });
  writeInstalledChatWebapp(options.app, "fallback-chat");

  const internal = await handleWebappPageActionRequest(options, "internal-chat", {
    action: "desktop.assistant.chat",
    args: { message: "任务：翻译\n要求：只返回译文\n内容：hello" }
  });
  assert.equal(internal.ok, true);
  assert.equal(calls.completions.at(-1).agentKey, FIXTURE_INTERNAL_AGENT_KEY);

  const copilot = await handleWebappPageActionRequest(options, "copilot-chat", {
    action: "desktop.assistant.chat",
    args: { message: "任务：润色\n要求：只返回结果\n内容：hello" }
  });
  assert.equal(copilot.ok, true);
  assert.equal(calls.completions.at(-1).agentKey, "webOperator");

  const fallback = await handleWebappPageActionRequest(options, "fallback-chat", {
    action: "desktop.assistant.chat",
    args: { message: "任务：摘要\n要求：只返回摘要\n内容：hello" }
  });
  assert.equal(fallback.ok, true);
  assert.equal(calls.completions.at(-1).agentKey, "desktopAssistant");
});

test("removed desktop assistant complete action returns unknown_action", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const response = await handleDesktopActionRequest(options, {
    action: "desktop.assistant.complete",
    args: { prompt: "总结这段文字", instruction: "只返回一句中文" },
    permissionMode: "full_access"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unknown_action");
  assert.equal(DESKTOP_ACTION_DEFINITIONS.some((definition) => definition.name === "desktop.assistant.complete"), false);
});

test("removed WebApp actions return unknown_action without legacy aliases", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  for (const action of [
    "desktop.webapp.installAndOpen",
    "desktop.webapp.selectDirectory",
    "desktop.webapp.checkPrerequisites",
    "desktop.webapp.getPublishInfo"
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: {},
      permissionMode: "full_access"
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown_action");
  }
  assert.equal(calls.fileDialogs.length, 0);
});

test("desktop.webapp.install only accepts an archive and validates its arguments", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const archivePath = await writeStaticWebappArchive(options.app.getPath("home"), "lifecycle-test");

  for (const args of [
    {},
    { sourcePath: options.app.getPath("home") },
    { sourcePath: options.app.getPath("home"), archivePath },
    { itemId: "market-webapp" },
    { archivePath, itemId: "" }
  ]) {
    const invalid = await handleDesktopActionRequest(options, {
      action: "desktop.webapp.install",
      args,
      permissionMode: "full_access"
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "invalid_args");
  }

  const installed = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath, expectedId: "lifecycle-test" },
    permissionMode: "full_access"
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.result.itemId, "lifecycle-test");
  assert.equal(installed.result.operation, "installed");
  assert.equal(installed.result.item.id, "lifecycle-test");
  assert.equal(installed.result.runtimeState.status, "stopped");
  assert.equal(calls.navigation.length, 0);

  const status = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { webappId: "lifecycle-test" },
    permissionMode: "full_access"
  });
  assert.equal(status.ok, true);
  assert.equal(status.result.status, "stopped");

  const opened = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.open",
    args: { id: "lifecycle-test" },
    permissionMode: "full_access"
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.result.state.status, "running");

  const updatedArchive = await writeStaticWebappArchive(options.app.getPath("home"), "lifecycle-test", "Lifecycle Updated");
  const updated = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: updatedArchive },
    permissionMode: "full_access"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.operation, "updated");
  assert.equal(updated.result.item.label, "Lifecycle Updated");
  assert.equal(updated.result.runtimeState.status, "running");
  assert.deepEqual(calls.navigation, ["/webs/webapp:lifecycle-test"]);

  const updatedStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id: "lifecycle-test" },
    permissionMode: "full_access"
  });
  assert.equal(updatedStatus.result.status, "running");

  const removablePaths = [
    getDesktopWebappDataRoot(options.app, "lifecycle-test"),
    getDesktopWebappStateRoot(options.app, "lifecycle-test"),
    getDesktopWebappLogsRoot(options.app, "lifecycle-test")
  ];
  for (const removablePath of removablePaths) {
    fs.mkdirSync(removablePath, { recursive: true });
    fs.writeFileSync(path.join(removablePath, "marker.txt"), "remove me", "utf8");
  }
  const uninstalled = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.uninstall",
    args: { webappId: "lifecycle-test" },
    permissionMode: "full_access"
  });
  assert.equal(uninstalled.ok, true);
  assert.equal(fs.existsSync(path.join(getDesktopWebappsDataRoot(options.app), "lifecycle-test")), false);
  for (const removablePath of removablePaths) {
    assert.equal(fs.existsSync(removablePath), false);
  }
});

test("archive runtime validation removes failed new installs and rolls back failed updates", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const originalArchive = await writeStaticWebappArchive(
    options.app.getPath("home"),
    "archive-rollback",
    "Original Archive"
  );
  const originalInstall = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: originalArchive, expectedId: "archive-rollback" },
    permissionMode: "full_access"
  });
  assert.equal(originalInstall.ok, true);
  const started = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.start",
    args: { id: "archive-rollback" },
    permissionMode: "full_access"
  });
  assert.equal(started.result.ok, true);

  const updateArchive = await writeFailingNodeWebappArchive(
    options.app.getPath("home"),
    "archive-rollback",
    "Broken Update"
  );
  const update = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: updateArchive, expectedId: "archive-rollback" },
    permissionMode: "full_access"
  });
  assert.equal(update.ok, false);
  assert.equal(update.error.code, "webapp_install_failed");
  const restoredManifest = JSON.parse(fs.readFileSync(
    path.join(getDesktopWebappsDataRoot(options.app), "archive-rollback", "webapp.json"),
    "utf8"
  ));
  assert.equal(restoredManifest.label, "Original Archive");
  const restoredStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id: "archive-rollback" },
    permissionMode: "full_access"
  });
  assert.equal(restoredStatus.result.status, "running");

  const failedNewArchive = await writeFailingNodeWebappArchive(
    options.app.getPath("home"),
    "archive-new-failure"
  );
  const failedNew = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: failedNewArchive, expectedId: "archive-new-failure" },
    permissionMode: "full_access"
  });
  assert.equal(failedNew.ok, false);
  assert.equal(failedNew.error.code, "webapp_install_failed");
  assert.equal(fs.existsSync(
    path.join(getDesktopWebappsDataRoot(options.app), "archive-new-failure")
  ), false);

  await handleDesktopActionRequest(options, {
    action: "desktop.webapp.stop",
    args: { id: "archive-rollback" },
    permissionMode: "full_access"
  });
});

test("runtime checks are side-effect free and publish requires an already running WebApp", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const archivePath = await writeStaticWebappArchive(options.app.getPath("home"), "runtime-check");
  await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath },
    permissionMode: "full_access"
  });

  const checked = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.checkRuntime",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.result.ready, true);
  assert.equal(checked.result.launcher, "none");

  const missing = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.checkRuntime",
    args: { id: "missing-webapp" },
    permissionMode: "full_access"
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "webapp_not_found");

  const published = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.publish",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(published.ok, false);
  assert.equal(published.error.code, "webapp_not_running");

  const status = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(status.result.status, "stopped");

  const started = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.start",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(started.result.ok, true);
  const persistentDataPath = getDesktopWebappDataRoot(options.app, "runtime-check");
  fs.mkdirSync(persistentDataPath, { recursive: true });
  fs.writeFileSync(path.join(persistentDataPath, "keep.txt"), "keep", "utf8");

  const unpublished = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.unpublish",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(unpublished.ok, true);
  const runningStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
  assert.equal(runningStatus.result.status, "running");
  assert.equal(fs.readFileSync(path.join(persistentDataPath, "keep.txt"), "utf8"), "keep");
  await handleDesktopActionRequest(options, {
    action: "desktop.webapp.stop",
    args: { id: "runtime-check" },
    permissionMode: "full_access"
  });
});

test("WebApp Bridge native actions require page scope and enforce their public contracts", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  __testInternals.clearWebappActionRateLimits();
  assert.equal(
    DESKTOP_ACTION_DEFINITIONS.some((definition) =>
      definition.name === "desktop.native.screen.capture" ||
      definition.name === "desktop.native.clipboard.readText" ||
      definition.name === "desktop.native.file.reveal" ||
      definition.name.startsWith("desktop.native.window.") ||
      definition.name.startsWith("desktop.native.camera.") ||
      definition.name === "desktop.native.share.open"
    ),
    false
  );

  const forbidden = await handleDesktopActionRequest(options, {
    action: "desktop.native.browser.openExternal",
    args: { url: "https://example.com/docs" },
    permissionMode: "full_access"
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, "forbidden");

  const opened = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.browser.openExternal",
    args: { url: "https://example.com/docs" }
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(calls.externalUrls, ["https://example.com/docs"]);

  const invalidProtocol = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.browser.openExternal",
    args: { url: "file:///tmp/secret" }
  });
  assert.equal(invalidProtocol.ok, false);
  assert.equal(invalidProtocol.error.code, "invalid_args");

  for (let index = 1; index < 5; index += 1) {
    const repeated = await handleWebappPageActionRequest(options, "bridge-v5", {
      action: "desktop.native.browser.openExternal",
      args: { url: `https://example.com/docs/${index}` }
    });
    assert.equal(repeated.ok, true);
  }
  const externalRateLimited = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.browser.openExternal",
    args: { url: "https://example.com/docs/too-many" }
  });
  assert.equal(externalRateLimited.ok, false);
  assert.equal(externalRateLimited.error.code, "rate_limited");
  assert.equal(calls.externalUrls.length, 5);

  const selectedFiles = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.dialog.selectFiles",
    args: {
      multiple: true,
      filters: [{ name: "Text", extensions: ["txt", "md"] }]
    }
  });
  assert.equal(selectedFiles.ok, true);
  assert.equal(selectedFiles.result.canceled, false);
  assert.equal(selectedFiles.result.files[0].name, "Writing");
  assert.deepEqual(calls.fileDialogs.at(-1).properties, ["openFile", "multiSelections"]);

  const dialogCountBeforeInvalidFilter = calls.fileDialogs.length;
  const invalidFilter = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.dialog.selectFiles",
    args: { filters: [{ name: "Unsafe", extensions: ["../secret"] }] }
  });
  assert.equal(invalidFilter.ok, false);
  assert.equal(invalidFilter.error.code, "invalid_args");
  assert.equal(calls.fileDialogs.length, dialogCountBeforeInvalidFilter);

  const selectedDirectory = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.dialog.selectDirectory",
    args: {}
  });
  assert.equal(selectedDirectory.ok, true);
  assert.equal(selectedDirectory.result.name, "Writing");

  const savePath = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.dialog.selectSavePath",
    args: { suggestedName: "report.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] }
  });
  assert.equal(savePath.ok, true);
  assert.equal(savePath.result.name, "report.xlsx");
  assert.equal(calls.saveDialogs.length, 1);

  options.showFileDialog = async (dialogOptions) => {
    calls.fileDialogs.push(dialogOptions);
    return { canceled: true, filePaths: [] };
  };
  const canceledFiles = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.dialog.selectFiles",
    args: {}
  });
  assert.equal(canceledFiles.ok, true);
  assert.deepEqual(canceledFiles.result, { canceled: true, files: [] });

  const microphone = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.microphone.getPermission",
    args: {}
  });
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(microphone.ok, true);
    assert.equal(microphone.result.permission, "granted");
  } else {
    assert.equal(microphone.result.permission, "unavailable");
  }

  const clipboard = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.clipboard.writeText",
    args: { text: "copied" }
  });
  assert.equal(clipboard.ok, true);
  assert.deepEqual(calls.clipboardWrites, ["copied"]);

  const oversizedClipboard = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.clipboard.writeText",
    args: { text: "x".repeat(1024 * 1024 + 1) }
  });
  assert.equal(oversizedClipboard.ok, false);
  assert.equal(oversizedClipboard.error.code, "invalid_args");

  const notification = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.notification.show",
    args: { title: "Finished", body: "Export complete" }
  });
  assert.equal(notification.ok, true);
  assert.equal(calls.notifications.length, 1);

  for (let index = 1; index < 5; index += 1) {
    const repeated = await handleWebappPageActionRequest(options, "bridge-v5", {
      action: "desktop.native.notification.show",
      args: { title: `Update ${index}`, body: "Still working" }
    });
    assert.equal(repeated.ok, true);
  }
  const rateLimited = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.native.notification.show",
    args: { title: "One too many", body: "This notification must be rejected" }
  });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.error.code, "rate_limited");
  assert.equal(calls.notifications.length, 5);
});

test("WebApp Bridge capability list distinguishes declared, reserved, and unavailable entries", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const webappDir = path.join(getDesktopWebappsDataRoot(options.app), "bridge-v5");
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), JSON.stringify({
    schemaVersion: 5,
    id: "bridge-v5",
    kind: "webapp",
    version: "1.0.0",
    target: "universal",
    label: "Bridge V5",
    frontend: {
      mode: "static",
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    desktopBridge: {
      version: 1,
      capabilities: ["assistant.chat", "native.clipboard.write"]
    }
  }), "utf8");

  const response = await handleWebappPageActionRequest(options, "bridge-v5", {
    action: "desktop.capabilities.list",
    args: {}
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.bridgeVersion, 1);
  const chat = response.result.capabilities.find((entry) => entry.id === "assistant.chat");
  const clipboard = response.result.capabilities.find((entry) => entry.id === "native.clipboard.write");
  const screen = response.result.capabilities.find((entry) => entry.id === "native.screen.capture");
  assert.deepEqual({ status: chat.status, declared: chat.declared }, { status: "available", declared: true });
  assert.deepEqual({ status: clipboard.status, declared: clipboard.declared }, { status: "available", declared: true });
  assert.deepEqual({ status: screen.status, declared: screen.declared }, { status: "reserved", declared: false });
});

function waitForListening(server) {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.on("listening", onListening);
    server.on("error", onError);
  });
}

async function getFreeLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve) => {
    server.listen(0, DESKTOP_ACTION_BRIDGE_HOST, resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function readJsonUrl(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

async function postJsonUrl(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.ok, true);
  return response.json();
}

test("desktop action bridge listens on configured port and refreshes when config changes", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const firstPort = await getFreeLoopbackPort();
  let secondPort = await getFreeLoopbackPort();
  while (secondPort === firstPort) {
    secondPort = await getFreeLoopbackPort();
  }
  t.after(() => stopDesktopActionBridge());

  writeDesktopActionBridgeSettingsConfig(options.app, {
    schemaVersion: 1,
    port: firstPort
  });
  const firstServer = startDesktopActionBridge(options);
  await waitForListening(firstServer);
  assert.deepEqual(await readJsonUrl(`http://${DESKTOP_ACTION_BRIDGE_HOST}:${firstPort}/health`), {
    ok: true,
    host: DESKTOP_ACTION_BRIDGE_HOST,
    port: firstPort
  });

  writeDesktopActionBridgeSettingsConfig(options.app, {
    schemaVersion: 1,
    port: secondPort
  });
  const secondServer = startDesktopActionBridge(options);
  await waitForListening(secondServer);
  assert.deepEqual(await readJsonUrl(`http://${DESKTOP_ACTION_BRIDGE_HOST}:${secondPort}/health`), {
    ok: true,
    host: DESKTOP_ACTION_BRIDGE_HOST,
    port: secondPort
  });
});

test("Desktop Action Bridge keeps WebApp page and backend token scopes separate", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const port = await getFreeLoopbackPort();
  writeInstalledChatWebapp(options.app, "scope-v5", {
    internalAgentKey: FIXTURE_INTERNAL_AGENT_KEY
  });
  const item = {
    id: "scope-v5",
    schemaVersion: 5,
    desktopBridge: {
      version: 1,
      capabilities: ["assistant.chat", "native.clipboard.write"]
    }
  };
  const pageToken = issueWebappActionToken(item, "localPageGateway");
  const backendToken = issueWebappActionToken(item, "backendActionToken");
  t.after(() => {
    revokeWebappActionToken(pageToken);
    revokeWebappActionToken(backendToken);
    stopDesktopActionBridge();
  });
  writeDesktopActionBridgeSettingsConfig(options.app, { schemaVersion: 1, port });
  const server = startDesktopActionBridge(options);
  await waitForListening(server);

  const call = async (route, token, action, args = {}) => {
    const response = await fetch(`http://${DESKTOP_ACTION_BRIDGE_HOST}:${port}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ action, args, permissionMode: "full_access" })
    });
    return { status: response.status, body: await response.json() };
  };

  const pageClipboard = await call(
    "/webapps/pages/actions/call",
    pageToken,
    "desktop.native.clipboard.writeText",
    { text: "page-only" }
  );
  assert.equal(pageClipboard.status, 200);
  assert.equal(pageClipboard.body.ok, true);
  assert.deepEqual(calls.clipboardWrites, ["page-only"]);

  const forgedDesktop = await call(
    "/actions/call",
    "",
    "desktop.native.clipboard.writeText",
    { text: "forged" }
  );
  assert.equal(forgedDesktop.status, 400);
  assert.equal(forgedDesktop.body.error.code, "forbidden");

  const wrongScope = await call(
    "/webapps/actions/call",
    pageToken,
    "desktop.native.clipboard.writeText",
    { text: "wrong-scope" }
  );
  assert.equal(wrongScope.status, 403);

  const backendChat = await call(
    "/webapps/actions/call",
    backendToken,
    "desktop.assistant.chat",
    { message: "hello" }
  );
  assert.equal(backendChat.status, 200);
  assert.equal(backendChat.body.ok, true);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.completions[0].agentKey, FIXTURE_INTERNAL_AGENT_KEY);

  const removedComplete = await call(
    "/webapps/actions/call",
    backendToken,
    "desktop.assistant.complete",
    { prompt: "hello" }
  );
  assert.equal(removedComplete.status, 403);
});

test("desktop pet actions expose the simplified local pet API", async (t) => {
  const { calls, options, state } = createDesktopActionOptions(t);

  const stateResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.state"
  });
  assert.equal(stateResponse.ok, true);
  assert.notEqual(stateResponse.result, state);
  assert.deepEqual(stateResponse.result, {
    ...state,
    updatedAt: Date.parse(state.updatedAt)
  });
  assert.equal(state.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal("visible" in stateResponse.result, false);
  assert.equal(calls.refreshState, 1);

  const listResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.list"
  });
  assert.equal(listResponse.ok, true);
  assert.deepEqual(listResponse.result, {
    appearanceId: "classic",
    appearances: state.appearanceOptions
  });

  const setResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.set",
    args: { id: "user:dario" },
    permissionMode: "full_access"
  });
  assert.equal(setResponse.ok, true);
  assert.deepEqual(calls.saveSettings, [{ appearanceId: "user:dario" }]);
  assert.equal(setResponse.result.appearanceId, "user:dario");

  const showResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.show",
    permissionMode: "full_access"
  });
  assert.equal(showResponse.ok, true);
  assert.equal(showResponse.result.enabled, true);

  const hideResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.hide",
    permissionMode: "full_access"
  });
  assert.equal(hideResponse.ok, true);
  assert.equal(hideResponse.result.enabled, false);
});

test("desktop pet show reports a failure unless the window is actually enabled", async (t) => {
  const { options, state } = createDesktopActionOptions(t);
  options.desktopPet.show = async () => ({ ...state, enabled: false });

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.pet.show",
    permissionMode: "full_access"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "pet_enable_failed");
  assert.equal(response.error.details.enabled, false);
});

test("dedicated Desktop setting actions replace the removed generic Setting family", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererActions = [];
  options.callRendererAction = async (request) => {
    rendererActions.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: { handled: request.action }
    };
  };

  for (const action of [
    "desktop.theme.get",
    "desktop.theme.set",
    "desktop.locale.get",
    "desktop.locale.set",
    "desktop.copilot.getPagePreferences",
    "desktop.copilot.setPagePreference"
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: {},
      permissionMode: "full_access"
    });
    assert.equal(response.ok, true, action);
    assert.equal(response.result.handled, action);
  }
  assert.deepEqual(rendererActions.map((request) => request.action), [
    "desktop.theme.get",
    "desktop.theme.set",
    "desktop.locale.get",
    "desktop.locale.set",
    "desktop.copilot.getPagePreferences",
    "desktop.copilot.setPagePreference"
  ]);

  for (const action of [
    "desktop.setting.getState",
    "desktop.setting.validatePatch",
    "desktop.setting.previewPatch",
    "desktop.setting.applyPatch"
  ]) {
    const response = await handleDesktopActionRequest(options, { action });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, "unknown_action", action);
  }
});

test("Desktop web actions retain page interaction while page reads use CDP", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererActions = [];
  options.callRendererAction = async (request) => {
    rendererActions.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: { handled: request.action }
    };
  };

  for (const action of [
    "desktop.web.listSurfaces",
    "desktop.web.getSurfaceState",
    "desktop.web.interactElement",
    "desktop.web.executeScript"
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: {},
      permissionMode: "full_access"
    });
    assert.equal(response.ok, true, action);
    assert.equal(response.result.handled, action);
  }

  assert.deepEqual(rendererActions.map((request) => request.action), [
    "desktop.web.listSurfaces",
    "desktop.web.getSurfaceState",
    "desktop.web.interactElement",
    "desktop.web.executeScript"
  ]);

  for (const action of [
    "desktop.web.getActiveSurface",
    "desktop.web.getPageContext",
    "desktop.web.readPageData",
    "desktop.web.extractStructured",
    "desktop.page.getContext",
    "desktop.page.readCurrent",
    "desktop.page.extractStructured",
    "desktop.page.interact",
    "desktop.page.fillForm",
    "desktop.page.submitForm"
  ]) {
    const response = await handleDesktopActionRequest(options, { action });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, "unknown_action", action);
  }
});

test("desktop general deviceName is read-only and exposes only the two name fields", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const response = await handleDesktopActionRequest(options, {
    action: "desktop.general.deviceName"
  });

  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.result).sort(), ["configuredDeviceName", "deviceName"]);
  assert.equal(typeof response.result.deviceName, "string");
  assert.equal(response.result.configuredDeviceName, "");
});

test("desktop action time normalization follows an explicit output schema", () => {
  const payload = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: 1_700_000_000_000,
    readAt: "1700000000000",
    completedAt: 1_700_000_000,
    invalidAt: "not-a-time",
    invalidCalendarAt: "2026-02-30T00:00:00.000Z",
    invalidOffsetAt: "2026-01-01T00:00:00.000+24:00",
    outOfRangeAt: "0001-01-01T00:00:00.000Z",
    triggeredAt: "2026-01-01T00:00:00.000Z",
    iso: "2026-01-01T00:00:00.000Z",
    nested: [{
      timestamp: "2026-01-02T00:00:00+08:00",
      mtimeMs: "2026-01-03T00:00:00.000Z",
      displayTime: "2026-01-04T00:00:00.000Z"
    }]
  };

  const schema = {
    type: "object",
    properties: {
      createdAt: { "x-platform-time": "epoch-ms" },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: {
            timestamp: { "x-platform-time": "epoch-ms" },
            mtimeMs: { "x-platform-time": "epoch-ms" }
          }
        }
      }
    }
  };
  assert.deepEqual(normalizeActionBridgeTimePayload(payload, schema), {
    ...payload,
    createdAt: Date.parse(payload.createdAt),
    nested: [{
      ...payload.nested[0],
      timestamp: Date.parse(payload.nested[0].timestamp),
      mtimeMs: Date.parse(payload.nested[0].mtimeMs)
    }]
  });
  assert.equal(payload.createdAt, "2026-01-01T00:00:00.000Z");
});

test("desktop action response leaves fields opaque when no action schema exists", () => {
  const iso = "2026-01-01T00:00:00.000Z";
  const response = __testInternals.normalizeActionResponseTimePayload({
    ok: false,
    action: "desktop.test",
    result: { createdAt: iso },
    preview: { expiresAt: iso },
    error: {
      code: "test_error",
      message: "test",
      details: { nested: [{ updatedAt: iso }] }
    }
  });

  assert.equal(response.result.createdAt, iso);
  assert.equal(response.preview.expiresAt, iso);
  assert.equal(response.error.details.nested[0].updatedAt, iso);
});

test("desktop action time schemas reject lossy epoch conversion but keep readable RFC3339 values", () => {
  assert.throws(
    () => normalizeActionBridgeTimePayload(
      { startedAt: "2026-01-01T00:00:00.000000001Z" },
      { type: "object", properties: { startedAt: { "x-platform-time": "epoch-ms" } } }
    ),
    { name: "ActionBridgeTimeContractError" }
  );
  assert.deepEqual(
    normalizeActionBridgeTimePayload(
      { iso: "0001-01-01T00:00:00.000000001Z" },
      { type: "object", properties: { iso: { format: "date-time" } } }
    ),
    { iso: "0001-01-01T00:00:00.000000001Z" }
  );
});

test("desktop action HTTP responses normalize semantic timestamps", async (t) => {
  const { options, state } = createDesktopActionOptions(t);
  const port = await getFreeLoopbackPort();
  t.after(() => stopDesktopActionBridge());

  writeDesktopActionBridgeSettingsConfig(options.app, {
    schemaVersion: 1,
    port
  });
  const server = startDesktopActionBridge(options);
  await waitForListening(server);

  const response = await postJsonUrl(
    `http://${DESKTOP_ACTION_BRIDGE_HOST}:${port}/actions/call`,
    { action: "desktop.pet.state" }
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.updatedAt, Date.parse(state.updatedAt));
});

test("desktop pet actions reject unknown local appearances and removed legacy names", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);

  const missingResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.set",
    args: { id: "user:missing" },
    permissionMode: "full_access"
  });
  assert.equal(missingResponse.ok, false);
  assert.equal(missingResponse.error.code, "pet_appearance_not_found");
  assert.deepEqual(calls.saveSettings, []);

  for (const action of [
    "desktop.pet.getState",
    "desktop.pet.getSettings",
    "desktop.pet.setEnabled",
    "desktop.pet.listAppearances",
    "desktop.pet.setAppearance"
  ]) {
    const legacyResponse = await handleDesktopActionRequest(options, { action });
    assert.equal(legacyResponse.ok, false, action);
    assert.equal(legacyResponse.error.code, "unknown_action", action);
  }
});

test("desktop website add accepts item payloads and name alias", async (t) => {
  const { options } = createDesktopActionOptions(t);

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.website.add",
    permissionMode: "full_access",
    args: {
      items: [{
        description: "全球天气资讯与预报",
        icon: "https://weather.com/favicon.ico",
        name: "Weather.com",
        url: "https://weather.com"
      }]
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.ok, true, response.result.message);
  assert.equal(response.result.item.label, "Weather.com");
  assert.equal(response.result.item.url, "https://weather.com/");
  assert.equal(response.result.items.length, 1);
});

test("desktop website add can be listed and reports an existing website as a business result", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const request = {
    action: "desktop.website.add",
    permissionMode: "full_access",
    args: {
      input: {
        label: "天气",
        url: "https://www.weather.com.cn/",
        agentKey: "webOperator"
      }
    }
  };

  const added = await handleDesktopActionRequest(options, request);
  assert.equal(added.ok, true);
  assert.equal(added.result.ok, true, added.result.message);
  assert.equal(typeof added.result.item.createdAt, "number");
  assert.equal(typeof added.result.item.updatedAt, "number");
  assert.equal(added.result.item.copilotAgentKey, "webOperator");
  assert.equal("agentKey" in added.result.item, false);

  const storedManifest = JSON.parse(fs.readFileSync(
    getWebsitePath(options.app, added.result.item.id),
    "utf8"
  ));
  assert.match(storedManifest.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(storedManifest.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(storedManifest.schemaVersion, 2);
  assert.equal(storedManifest.copilotAgentKey, "webOperator");
  assert.equal("agentKey" in storedManifest, false);

  const listed = await handleDesktopActionRequest(options, {
    action: "desktop.website.list"
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.ok, true);
  assert.equal(listed.result.items.length, 1);
  assert.equal(listed.result.items[0].url, "https://www.weather.com.cn/");
  assert.equal(typeof listed.result.items[0].createdAt, "number");
  assert.equal(typeof listed.result.items[0].updatedAt, "number");

  const duplicate = await handleDesktopActionRequest(options, request);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.result.ok, false);
  assert.equal(duplicate.result.item.url, "https://www.weather.com.cn/");
  assert.match(duplicate.result.message, /already exists|已经|已存在/u);
});

test("desktop website add returns detailed input issues", async (t) => {
  const { options } = createDesktopActionOptions(t);

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.website.add",
    permissionMode: "full_access",
    args: {
      items: [{
        name: "Weather.com"
      }]
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.ok, false);
  assert.match(response.result.message, /url|网站地址/u);
  assert.equal(response.result.issues.length, 1);
  assert.equal(response.result.issues[0].field, "url");
  assert.match(response.result.issues[0].message, /Website address is required|网站地址不能为空/u);
  assert.equal(response.result.issues[0].expected, "non-empty string");
  assert.equal(response.result.issues[0].received, "missing");
});

test("desktop cdp bridge surfaces target timeout distinctly", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.executeCdpCommand = async () => {
    throw new DesktopCdpTimeoutError({
      method: "Runtime.evaluate",
      targetId: "desktop-timeout",
      surfaceId: "website:timeout",
      webContentsId: 42,
      url: "https://example.test/page",
      title: "Example",
      paramKeys: ["expression", "returnByValue"],
      timeoutMs: 12_000,
      elapsedMs: 12_001
    });
  };

  const response = await handleDesktopCdpRequest(options, {
    method: "Runtime.evaluate",
    params: {
      expression: "1+1",
      returnByValue: true
    },
    targetId: "desktop-timeout"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "target_timeout");
  assert.match(response.error.message, /Runtime\.evaluate/u);
  assert.equal(response.error.details.targetId, "desktop-timeout");
  assert.equal(response.error.details.surfaceId, "website:timeout");
  assert.deepEqual(response.error.details.paramKeys, ["expression", "returnByValue"]);
});

test("desktop cdp bridge preserves current-surface target errors", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.executeCdpCommand = async () => {
    const error = new Error("The target does not belong to the current Desktop surface.");
    error.code = "target_not_in_current_surface";
    throw error;
  };

  const response = await handleDesktopCdpRequest(options, {
    method: "Runtime.evaluate",
    params: { expression: "1+1" },
    targetId: "desktop-background-target"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "target_not_in_current_surface");
  assert.match(response.error.message, /current Desktop surface/u);
});

test("desktop cdp bridge normalizes Target.closeTarget ids and rejects conflicts", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const calls = [];
  options.executeCdpCommand = async (request) => {
    calls.push(request);
    return {
      targetId: request.targetId,
      surfaceId: "website:current",
      result: { success: true }
    };
  };

  const paramsResponse = await handleDesktopCdpRequest(options, {
    method: "Target.closeTarget",
    params: { targetId: "desktop-from-params" }
  });
  assert.equal(paramsResponse.ok, true);
  assert.deepEqual(paramsResponse.result, { success: true });
  assert.equal(calls[0].targetId, "desktop-from-params");
  assert.deepEqual(calls[0].params, {});

  const topLevelResponse = await handleDesktopCdpRequest(options, {
    method: "Target.closeTarget",
    targetId: "desktop-top-level"
  });
  assert.equal(topLevelResponse.ok, true);
  assert.equal(calls[1].targetId, "desktop-top-level");

  const conflictResponse = await handleDesktopCdpRequest(options, {
    method: "Target.closeTarget",
    targetId: "desktop-one",
    params: { targetId: "desktop-two" }
  });
  assert.equal(conflictResponse.ok, false);
  assert.equal(conflictResponse.error.code, "invalid_args");
  assert.equal(calls.length, 2);
});

test("desktop cdp bridge exposes only the documented public method set", async (t) => {
  const { options } = createDesktopActionOptions(t);
  let commandCalls = 0;
  options.executeCdpCommand = async () => {
    commandCalls += 1;
    return { result: {} };
  };

  const response = await handleDesktopCdpRequest(options, {
    method: "Browser.getVersion"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "method_not_allowed");
  assert.equal(commandCalls, 0);
});

test("desktop action confirmation detail exposes debug context with redacted args", () => {
  const detail = __testInternals.buildDesktopActionConfirmationDetail({
    requestId: "request-123",
    action: "desktop.web.navigate",
    source: {
      runId: "run-abc",
      chatId: "chat-def",
      agentKey: "zenmi"
    }
  }, {
    url: "https://example.test/path/to/page?desktopAuthContext=secret#hash",
    accessToken: "secret-token",
    nested: {
      password: "hidden-password",
      href: "https://nested.test/safe/path?cookie=bad#fragment",
      callback: "zenmind://auth/callback?token=secret#hash"
    },
    longText: "x".repeat(240),
    confirmationSummary: "提醒主人喝水",
    alpha: "a",
    beta: "b",
    gamma: "c",
    delta: "d",
    epsilon: "e",
    zeta: "z"
  }, {
    permissionMode: "page_control",
    target: "Agent Webclient | https://example.test/path/to/page?token=secret#fragment"
  });

  assert.match(detail, /desktop\.web\.navigate/u);
  assert.match(detail, /request-123/u);
  assert.match(detail, /page_control/u);
  assert.match(detail, /run-abc/u);
  assert.match(detail, /chat-def/u);
  assert.match(detail, /zenmi/u);
  assert.match(detail, /Agent Webclient/u);
  assert.match(detail, /https:\/\/example\.test\/path\/to\/page/u);
  assert.match(detail, /zenmind:\/\/auth\/callback/u);
  assert.match(detail, /\[已隐藏\]/u);
  assert.match(detail, /另有 2 项未显示/u);
  assert.doesNotMatch(detail, /secret-token/u);
  assert.doesNotMatch(detail, /hidden-password/u);
  assert.doesNotMatch(detail, /desktopAuthContext/u);
  assert.doesNotMatch(detail, /cookie=bad/u);
  assert.doesNotMatch(detail, /token=secret/u);
  assert.doesNotMatch(detail, /#fragment/u);
  assert.doesNotMatch(detail, /提醒主人喝水/u);
  assert.doesNotMatch(detail, new RegExp("x".repeat(200), "u"));
});

test("desktop action confirmation request keeps compact fields free of debug context", () => {
  const payload = __testInternals.buildMutatingActionConfirmationRequest({
    requestId: "request-123",
    action: "desktop.website.add",
    source: {
      runId: "run-abc",
      chatId: "chat-def",
      agentKey: "zenmi"
    }
  }, {
    input: {
      label: "腾讯视频",
      url: "https://v.qq.com/?token=secret#hash"
    },
    accessToken: "secret-token"
  }, {
    pageKind: "webview",
    surfaceLabel: "Agent Webclient",
    pageContext: {
      title: "Agent",
      url: "http://127.0.0.1:7080/agent/zenmi?token=secret#fragment"
    }
  });

  const compactText = JSON.stringify({
    summary: payload.summary,
    description: payload.description,
    fields: payload.fields
  });

  assert.equal(payload.kind, "action");
  assert.deepEqual(payload.buttons.map((button) => button.decision), ["cancel", "confirm"]);
  assert.match(compactText, /desktop\.website\.add/u);
  assert.match(compactText, /Agent Webclient/u);
  assert.match(compactText, /https:\/\/v\.qq\.com\//u);
  assert.doesNotMatch(compactText, /request-123/u);
  assert.doesNotMatch(compactText, /run-abc/u);
  assert.doesNotMatch(compactText, /chat-def/u);
  assert.doesNotMatch(compactText, /secret-token/u);
  assert.doesNotMatch(compactText, /token=secret/u);
  assert.match(payload.details, /request-123/u);
  assert.match(payload.details, /run-abc/u);
  assert.match(payload.details, /chat-def/u);
  assert.doesNotMatch(payload.details, /secret-token/u);
  assert.doesNotMatch(payload.details, /token=secret/u);
});

test("webapp install confirmation uses installation-specific copy and manifest summary", () => {
  const payload = __testInternals.buildMutatingActionConfirmationRequest({
    requestId: "request-install",
    action: "desktop.webapp.install",
    source: {
      runId: "run-install",
      chatId: "chat-install",
      agentKey: "cutej"
    }
  }, {
    archivePath: "/tmp/futures-daily-position-1.0.0.zip",
    expectedId: "futures-daily-position",
    confirmationSummary: "安装并打开 WebApp「期货每日持仓」；ID=futures-daily-position；版本=1.0.0；前端=static；后端=node"
  }, null);

  assert.equal(payload.title, "安装 WebApp");
  assert.equal(payload.summary, "安装并打开 WebApp「期货每日持仓」；ID=futures-daily-position；版本=1.0.0；前端=static；后端=node");
  assert.deepEqual(payload.buttons.map((button) => button.label), ["取消", "安装"]);
  assert.deepEqual(payload.buttons.map((button) => button.decision), ["cancel", "confirm"]);
  assert.equal(payload.defaultDecision, "cancel");
  assert.match(payload.details, /desktop\.webapp\.install/u);
  assert.match(payload.details, /futures-daily-position/u);
});

test("cancelling the WebApp install confirmation prevents installation and navigation", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const archivePath = await writeStaticWebappArchive(
    options.app.getPath("home"),
    "cancelled-install",
    "Cancelled Install"
  );
  let confirmation;
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => {
    confirmation = request;
    return { requestId: request.requestId, decision: "cancel" };
  };

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: {
      archivePath,
      expectedId: "cancelled-install",
      confirmationSummary: "安装 WebApp「Cancelled Install」；ID=cancelled-install；版本=1.0.0；前端=static；后端=none"
    }
  });

  assert.equal(confirmation.title, "安装 WebApp");
  assert.equal(response.ok, false);
  assert.equal(response.requiresConfirmation, true);
  assert.equal(response.error.code, "user_cancelled");
  assert.equal(
    fs.existsSync(path.join(getDesktopWebappsDataRoot(options.app), "cancelled-install")),
    false
  );
  assert.deepEqual(calls.navigation, []);
});

test("page control confirmation request exposes grant once cancel decisions", () => {
  const payload = __testInternals.buildPageControlActionConfirmationRequest({
    chatId: "chat-def",
    agentKey: "zenmi",
    webContentsId: 12,
    origin: "https://example.test",
    surfaceLabel: "Agent Webclient",
    pageTitle: "Example"
  }, {
    requestId: "request-page",
    action: "desktop.web.interactElement",
    permissionMode: "page_control",
    source: {
      runId: "run-page",
      chatId: "chat-def",
      agentKey: "zenmi"
    }
  }, {
    action: "click",
    selector: "#name",
    password: "hidden-password"
  });

  assert.equal(payload.kind, "page_control");
  assert.deepEqual(payload.buttons.map((button) => button.decision), ["cancel", "once", "grant"]);
  assert.equal(payload.defaultDecision, "once");
  assert.equal(payload.cancelDecision, "cancel");
  assert.match(JSON.stringify(payload.fields), /page_control/u);
  assert.match(payload.details, /request-page/u);
  assert.match(payload.details, /run-page/u);
  assert.match(payload.details, /Agent Webclient/u);
  assert.match(payload.details, /\[已隐藏\]/u);
  assert.doesNotMatch(payload.details, /hidden-password/u);
});
