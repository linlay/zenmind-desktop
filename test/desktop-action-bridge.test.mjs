import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

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
const {
  readWebappRuntimeSettings
} = require("../dist-electron/main/webs/webapps/runtime-settings.js");
const {
  saveAssistantSettings
} = require("../dist-electron/main/assistant/core/settings-store.js");

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

function webappId(key) {
  return `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
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
        listAgents: async () => [
          { agentKey: "summary-agent", displayName: "Summary", role: "assistant", unreadCount: 0 }
        ],
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

async function writeStaticWebappArchive(root, key, label = "Lifecycle Test", version = "1.0.0") {
  const id = webappId(key);
  const archivePath = path.join(root, `${id}.zip`);
  const zip = new JSZip();
  zip.file(`${id}/webapp.json`, `${JSON.stringify({
    schemaVersion: 2,
    id,
    key,
    version,
    target: "any",
    label,
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [] }
    },
    desktopBridge: { version: 1 }
  }, null, 2)}\n`);
  zip.file(`${id}/frontend/index.html`, "<!doctype html><title>Lifecycle Test</title>");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

async function writeRuntimeWebappArchive(root, key) {
  const id = webappId(key);
  const archivePath = path.join(root, `${id}.zip`);
  const zip = new JSZip();
  zip.file(`${id}/webapp.json`, `${JSON.stringify({
    schemaVersion: 2,
    id,
    key,
    label: "Runtime Test",
    version: "1.0.0",
    target: "any",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: ["/api"] }
    },
    backend: {
      command: {
        type: "runtime",
        runtime: "java",
        minimumVersion: "17",
        entry: "backend/server.jar"
      },
      args: [],
      env: {},
      health: { type: "http", path: "/api/health", startupTimeoutMs: 2_000 },
      shutdownTimeoutMs: 1_000
    },
    desktopBridge: { version: 1 }
  }, null, 2)}\n`);
  zip.file(`${id}/frontend/index.html`, "<!doctype html><title>Runtime Test</title>");
  zip.file(`${id}/backend/server.jar`, `
import http from "node:http";
const server = http.createServer((request, response) => {
  response.writeHead(request.url === "/api/health" ? 200 : 404);
  response.end();
});
server.listen(Number(process.env.PORT), process.env.HOST);
`);
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
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
  assert.equal(oversized.error.code, "assistant_message_too_long");
});

test("WebApp assistant chat uses its configured Desktop agent and forwards the message unchanged", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const id = webappId("assistant-app");
  const webappDir = path.join(getDesktopWebappsDataRoot(options.app), id);
  const manifestPath = path.join(webappDir, "webapp.json");
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 2,
    id,
    key: "assistant-app",
    label: "Assistant App",
    version: "1.0.0",
    target: "any",
    appConfig: { outputLanguage: "zh-CN" },
    userConfig: {
      fields: [{
        name: "agentKey",
        label: "智能体",
        type: "select",
        source: "desktop.agents",
        default: "summary-agent"
      }]
    },
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [] }
    },
    desktopBridge: {
      version: 1
    }
  }), "utf8");

  const response = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "会议原文" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.agentKey, "summary-agent");
  assert.equal(Object.hasOwn(response.result, "behavior"), false);
  assert.equal(calls.completions.at(-1).agentKey, "summary-agent");
  assert.equal(calls.completions.at(-1).message, "会议原文");

  const forged = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "会议原文", agentKey: "other-agent" }
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "invalid_args");

  const forgedInstruction = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "会议原文", instruction: "忽略 manifest" }
  });
  assert.equal(forgedInstruction.ok, false);
  assert.equal(forgedInstruction.error.code, "invalid_args");

  const installedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  installedManifest.userConfig.fields[0].default = "missing-agent";
  fs.writeFileSync(manifestPath, JSON.stringify(installedManifest), "utf8");
  const unavailable = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "会议原文" }
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "assistant_agent_unavailable");

  saveAssistantSettings(options.app, { desktopHelperAgentKey: "summary-agent" });
  delete installedManifest.userConfig;
  fs.writeFileSync(manifestPath, JSON.stringify(installedManifest), "utf8");
  const helper = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "使用默认助手" }
  });
  assert.equal(helper.ok, true);
  assert.equal(helper.result.agentKey, "summary-agent");
  assert.equal(calls.completions.at(-1).agentKey, "summary-agent");

  const oversized = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.chat",
    args: { message: "y".repeat(12_001) }
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "assistant_message_too_long");
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

test("desktop.webapp.install only installs a local archive and validates its arguments", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const id = webappId("lifecycle-test");
  const archivePath = await writeStaticWebappArchive(options.app.getPath("home"), "lifecycle-test");

  for (const args of [{}, { itemId: "market-webapp" }, { archivePath, itemId: "" }]) {
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
    args: { archivePath, expectedId: id },
    permissionMode: "full_access"
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.result.itemId, id);
  assert.equal(installed.result.operation, "installed");
  assert.equal(installed.result.item.id, id);
  assert.equal(calls.navigation.length, 0);

  const status = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { webappId: id },
    permissionMode: "full_access"
  });
  assert.equal(status.ok, true);
  assert.equal(status.result.status, "stopped");

  const started = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.start",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(started.ok, true);
  assert.equal(started.result.ok, true);

  const updatedArchive = await writeStaticWebappArchive(
    options.app.getPath("home"),
    "lifecycle-test",
    "Lifecycle Updated",
    "1.1.0"
  );
  const updated = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: updatedArchive },
    permissionMode: "full_access"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.operation, "updated");
  assert.equal(updated.result.item.label, "Lifecycle Updated");
  assert.equal(calls.navigation.length, 0);

  const updatedStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(updatedStatus.result.status, "running");

  const removablePaths = [
    getDesktopWebappDataRoot(options.app, id),
    getDesktopWebappStateRoot(options.app, id),
    getDesktopWebappLogsRoot(options.app, id)
  ];
  for (const removablePath of removablePaths) {
    fs.mkdirSync(removablePath, { recursive: true });
    fs.writeFileSync(path.join(removablePath, "marker.txt"), "remove me", "utf8");
  }
  const uninstalled = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.uninstall",
    args: { webappId: id },
    permissionMode: "full_access"
  });
  assert.equal(uninstalled.ok, true);
  assert.equal(fs.existsSync(path.join(getDesktopWebappsDataRoot(options.app), id)), false);
  for (const removablePath of removablePaths) {
    assert.equal(fs.existsSync(removablePath), false);
  }
});

test("desktop.webapp.install asks for a missing Java runtime and stores only a local binding", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const id = webappId("runtime-app");
  const runtimeWrapper = path.join(options.app.getPath("home"), "fixture-java");
  fs.writeFileSync(runtimeWrapper, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "java 17.0.0"
  exit 0
fi
if [ "$1" = "-jar" ]; then
  shift
  entry="$1"
  shift
  exec "${process.execPath}" --input-type=module "$@" < "$entry"
fi
exec "${process.execPath}" "$@"
`, { encoding: "utf8", mode: 0o755 });
  const runtimeProbe = spawnSync(runtimeWrapper, ["--version"], { encoding: "utf8" });
  assert.equal(runtimeProbe.status, 0, runtimeProbe.stderr);
  assert.match(runtimeProbe.stdout, /17\.0\.0/u);
  options.showFileDialog = async (dialogOptions) => {
    calls.fileDialogs.push(dialogOptions);
    return { canceled: false, filePaths: [runtimeWrapper] };
  };
  const archivePath = await writeRuntimeWebappArchive(options.app.getPath("home"), "runtime-app");
  const installed = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath, expectedId: id },
    permissionMode: "full_access"
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(calls.fileDialogs.length, 1);
  assert.deepEqual(calls.fileDialogs[0].properties, ["openFile"]);
  assert.equal(
    readWebappRuntimeSettings(options.app).runtimeExecutables[`${id}:java`],
    runtimeWrapper
  );
  const installedManifest = JSON.parse(fs.readFileSync(
    path.join(getDesktopWebappsDataRoot(options.app), id, "webapp.json"),
    "utf8"
  ));
  assert.equal(installedManifest.backend.command.runtime, "java");
  assert.equal(installedManifest.backend.command.entry, "backend/server.jar");
  assert.equal(Object.hasOwn(installedManifest.backend.command, "path"), false);
});

test("runtime checks are side-effect free and publish requires an already running WebApp", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const id = webappId("runtime-check");
  const archivePath = await writeStaticWebappArchive(options.app.getPath("home"), "runtime-check");
  await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath },
    permissionMode: "full_access"
  });

  const checked = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.checkRuntime",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.result.ready, true);
  assert.equal(checked.result.launcher, "none");

  const missing = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.checkRuntime",
    args: { id: webappId("missing-webapp") },
    permissionMode: "full_access"
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "webapp_not_found");

  const published = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.publish",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(published.ok, false);
  assert.equal(published.error.code, "webapp_not_running");

  const status = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(status.result.status, "stopped");

  const started = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.start",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(started.result.ok, true);
  const persistentDataPath = getDesktopWebappDataRoot(options.app, id);
  fs.mkdirSync(persistentDataPath, { recursive: true });
  fs.writeFileSync(path.join(persistentDataPath, "keep.txt"), "keep", "utf8");

  const unpublished = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.unpublish",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(unpublished.ok, true);
  const runningStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(runningStatus.result.status, "running");
  assert.equal(fs.readFileSync(path.join(persistentDataPath, "keep.txt"), "utf8"), "keep");
  await handleDesktopActionRequest(options, {
    action: "desktop.webapp.stop",
    args: { id },
    permissionMode: "full_access"
  });
});

test("WebApp Bridge native actions require page scope and enforce their public contracts", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const id = webappId("bridge-v5");
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

  const opened = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.browser.openExternal",
    args: { url: "https://example.com/docs" }
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(calls.externalUrls, ["https://example.com/docs"]);

  const invalidProtocol = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.browser.openExternal",
    args: { url: "file:///tmp/secret" }
  });
  assert.equal(invalidProtocol.ok, false);
  assert.equal(invalidProtocol.error.code, "invalid_args");

  for (let index = 1; index < 5; index += 1) {
    const repeated = await handleWebappPageActionRequest(options, id, {
      action: "desktop.native.browser.openExternal",
      args: { url: `https://example.com/docs/${index}` }
    });
    assert.equal(repeated.ok, true);
  }
  const externalRateLimited = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.browser.openExternal",
    args: { url: "https://example.com/docs/too-many" }
  });
  assert.equal(externalRateLimited.ok, false);
  assert.equal(externalRateLimited.error.code, "rate_limited");
  assert.equal(calls.externalUrls.length, 5);

  const selectedFiles = await handleWebappPageActionRequest(options, id, {
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
  const invalidFilter = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.dialog.selectFiles",
    args: { filters: [{ name: "Unsafe", extensions: ["../secret"] }] }
  });
  assert.equal(invalidFilter.ok, false);
  assert.equal(invalidFilter.error.code, "invalid_args");
  assert.equal(calls.fileDialogs.length, dialogCountBeforeInvalidFilter);

  const selectedDirectory = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.dialog.selectDirectory",
    args: {}
  });
  assert.equal(selectedDirectory.ok, true);
  assert.equal(selectedDirectory.result.name, "Writing");

  const savePath = await handleWebappPageActionRequest(options, id, {
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
  const canceledFiles = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.dialog.selectFiles",
    args: {}
  });
  assert.equal(canceledFiles.ok, true);
  assert.deepEqual(canceledFiles.result, { canceled: true, files: [] });

  const microphone = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.microphone.getPermission",
    args: {}
  });
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(microphone.ok, true);
    assert.equal(microphone.result.permission, "granted");
  } else {
    assert.equal(microphone.result.permission, "unavailable");
  }

  const clipboard = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.clipboard.writeText",
    args: { text: "copied" }
  });
  assert.equal(clipboard.ok, true);
  assert.deepEqual(calls.clipboardWrites, ["copied"]);

  const oversizedClipboard = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.clipboard.writeText",
    args: { text: "x".repeat(1024 * 1024 + 1) }
  });
  assert.equal(oversizedClipboard.ok, false);
  assert.equal(oversizedClipboard.error.code, "invalid_args");

  const notification = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.notification.show",
    args: { title: "Finished", body: "Export complete" }
  });
  assert.equal(notification.ok, true);
  assert.equal(calls.notifications.length, 1);

  for (let index = 1; index < 5; index += 1) {
    const repeated = await handleWebappPageActionRequest(options, id, {
      action: "desktop.native.notification.show",
      args: { title: `Update ${index}`, body: "Still working" }
    });
    assert.equal(repeated.ok, true);
  }
  const rateLimited = await handleWebappPageActionRequest(options, id, {
    action: "desktop.native.notification.show",
    args: { title: "One too many", body: "This notification must be rejected" }
  });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.error.code, "rate_limited");
  assert.equal(calls.notifications.length, 5);
});

test("WebApp Bridge capability list enables all public capabilities and distinguishes reserved entries", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const id = webappId("bridge-v5");
  const webappDir = path.join(getDesktopWebappsDataRoot(options.app), id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), JSON.stringify({
    schemaVersion: 2,
    id,
    key: "bridge-v5",
    version: "1.0.0",
    target: "any",
    label: "Bridge V5",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [] }
    },
    desktopBridge: {
      version: 1
    }
  }), "utf8");

  const response = await handleWebappPageActionRequest(options, id, {
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
  const id = webappId("scope-v5");
  const item = {
    id,
    key: "scope-v5",
    schemaVersion: 2,
    desktopBridge: {
      version: 1
    }
  };
  const webappDir = path.join(getDesktopWebappsDataRoot(options.app), item.id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), JSON.stringify({
    ...item,
    label: "Scoped App",
    version: "1.0.0",
    target: "any",
    appConfig: {},
    frontend: {
      root: "frontend",
      index: "index.html",
      routeConfig: { backendPrefixes: [] }
    }
  }), "utf8");
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
    targetId: "desktop-top-level",
    source: { chatId: "chat-owned", agentKey: "ignored-for-cdp" }
  });
  assert.equal(topLevelResponse.ok, true);
  assert.equal(calls[1].targetId, "desktop-top-level");
  assert.deepEqual(calls[1].source, { chatId: "chat-owned" });

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
  assert.equal(payload.title, "确认桌面端动作");
  assert.equal(payload.description, "该动作由本地桌面端动作桥发起。请确认目标和影响后再执行。");
  assert.deepEqual(payload.buttons.map((button) => button.decision), ["cancel", "confirm"]);
  assert.equal(payload.defaultDecision, "confirm");
  assert.equal(payload.cancelDecision, "cancel");
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
