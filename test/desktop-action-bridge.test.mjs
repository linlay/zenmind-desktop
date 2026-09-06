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
  handleAgentPlatformDesktopActionRequest,
  handleAgentWebclientWorkPanelActionRequest,
  handleDesktopActionRequest,
  handleWebappPageActionRequest,
  handleDesktopCdpRequest,
  startDesktopActionBridge,
  stopDesktopActionBridge,
  __testInternals
} = require("../dist-electron/main/modules/desktop-actions/runtime.js");
const {
  DesktopCdpTimeoutError
} = require("../dist-electron/main/modules/web-surfaces/cdp/debugger.js");
const {
  writeDesktopActionBridgeSettingsConfig
} = require("../dist-electron/main/modules/desktop-actions/settings.js");
const {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_DEFINITIONS
} = require("../dist-electron/shared/desktop-actions.js");
const {
  normalizeActionBridgeTimePayload
} = require("../dist-electron/main/modules/desktop-actions/time-normalizer.js");
const {
  getWebsitePath
} = require("../dist-electron/main/modules/webs/websites/store.js");
const { createWebsFacade } = require("../dist-electron/main/modules/webs/index.js");
const {
  installWebsiteAppArchiveFromPath
} = require("../dist-electron/main/modules/marketplace/website-app-market.js");

const websFacade = createWebsFacade({
  getDesktopDeviceId: () => "desktop-action-test-device",
  getConfiguredDesktopActionBridgePort: () => 17070,
  readInstalledRecords: () => [],
  removeInstalledRecordByResourceKey: () => undefined,
  installWebsiteAppArchiveFromPath: (app, archivePath, options) =>
    installWebsiteAppArchiveFromPath(app, archivePath, { ...options, webs: websFacade }),
  deriveTunnelHubRegistrationApiOrigin: () => "",
  getTunnelHubRuntimeStatus: () => ({ connected: false }),
  startTunnelHubRuntime: async () => ({ ok: false }),
  readTunnelHubRegistrationBearerToken: () => "",
  readTunnelHubSettings: () => ({ enabled: false, relayUrl: "" }),
  saveTunnelHubSettings: (_app, input) => input
});

test("Agent Platform bridge forwards raw ZIP bodies without JSON encoding", async () => {
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  const result = await __testInternals.fetchAgentPlatformWithAuth(
    "http://127.0.0.1:17078",
    "/api/admin/skill-packages/import?key=office-pack&version=1.0.0",
    {
      method: "POST",
      rawBody: archive,
      contentType: "application/zip",
      issueToken: async () => ({ ok: true, token: "test-token" }),
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers["Content-Type"], "application/zip");
        assert.equal(init.headers.Authorization, "Bearer test-token");
        assert.deepEqual(Buffer.from(init.body), archive);
        return new Response(JSON.stringify({ code: 0, msg: "success", data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  );
  assert.deepEqual(result, { ok: true });
});
const {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebappStateRoot,
  getDesktopConfigRoot
} = require("../dist-electron/main/infrastructure/filesystem/user-paths.js");
const {
  updateDesktopProfileInRoot
} = require("../dist-electron/main/infrastructure/filesystem/profile-store.js");
const {
  issueWebappActionToken,
  revokeWebappActionToken
} = require("../dist-electron/main/modules/webs/webapps/action-tokens.js");
const {
  readWebappRuntimeSettings
} = require("../dist-electron/main/modules/webs/webapps/runtime-settings.js");
const {
  clearWebappImageUploadsForTest,
  normalizeWebappImageUploadFile,
  registerWebappImageUpload
} = require("../dist-electron/main/modules/webs/webapps/image-upload-registry.js");
const {
  saveAssistantSettings
} = require("../dist-electron/main/modules/assistant/settings-store.js");

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
      if (name === "downloads") {
        return path.join(homePath, "Downloads");
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

function createWorkPanelWorkspace() {
  return {
    workspaceId: "workpanel:chat-owner",
    ownerChatId: "chat-owner",
    items: [
      {
        itemId: "item-1",
        stableKey: "web:https://example.test/",
        descriptor: { kind: "web", url: "https://example.test/" },
        title: "Example",
        closable: true,
        pinned: false,
        createdAt: 1_800_000_000_000
      },
      {
        itemId: "item-2",
        stableKey: "web:https://second.test/",
        descriptor: { kind: "web", url: "https://second.test/" },
        title: "Second",
        closable: true,
        pinned: false,
        createdAt: 1_800_000_000_001
      }
    ],
    activeItemId: "item-1"
  };
}

function createWorkPanelRendererResult(action) {
  const workspace = createWorkPanelWorkspace();
  if (action === "desktop.workpanel.closeWorkpanel") {
    return { ok: true, workspaceId: workspace.workspaceId };
  }
  return {
    ok: true,
    workspaceId: workspace.workspaceId,
    item: workspace.items[0],
    state: { ...workspace, internalLayout: { width: 800 } },
    workspaces: [workspace, { workspaceId: "workpanel:other-chat", ownerChatId: "other-chat", items: [], activeItemId: null }]
  };
}

function createWebActionState() {
  const tabs = [
    {
      tabId: "tab-1",
      title: "Example",
      currentUrl: "https://example.test/",
      faviconUrl: "https://example.test/favicon.ico",
      active: true,
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      guestId: 991,
      webContentsId: 992
    },
    {
      tabId: "tab-2",
      title: "Second",
      currentUrl: "https://second.test/",
      active: false,
      isLoading: true,
      canGoBack: false,
      canGoForward: true,
      guestId: 993
    }
  ];
  return {
    surface: {
      id: "browser",
      surfaceId: "browser",
      surfaceRole: "browser",
      surfaceLevel: "root",
      interaction: "interactive",
      kind: "browser",
      label: "Browser",
      url: "https://example.test/",
      route: "/browser",
      open: true,
      active: true,
      webContentsId: 992
    },
    tabs,
    activeTab: { ...tabs[0] },
    activeTabId: "tab-1",
    unrelatedSurfaces: [{ surfaceId: "website:other" }]
  };
}

function createDesktopActionOptions(t) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-action-bridge-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));

  const appearances = [
    {
      id: "classic",
      displayName: "Classic",
      description: "Builtin pet.",
      assetRoot: "/pets/classic",
      manifestPath: "/pets/classic/pet.json",
      spritesheetPath: "/pets/classic/spritesheet.png",
      states: { idle: { row: 0, frames: 8 } },
      signature: "classic-signature"
    },
    {
      id: "user:dario",
      displayName: "Dario",
      description: "Local pet.",
      assetRoot: "/pets/dario",
      manifestPath: "/pets/dario/pet.json",
      spritesheetPath: "/pets/dario/spritesheet.png",
      states: { idle: { row: 0, frames: 8 }, celebrate: { row: 1, frames: 8 } },
      signature: "dario-signature"
    }
  ];
  const state = {
    supported: true,
    enabled: true,
    appearanceId: "classic",
    appearanceOptions: appearances,
    updatedAt: "2026-01-01T00:00:00.000Z",
    windowVisible: true,
    activeTasks: Array.from({ length: 20 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}` })),
    messages: Array.from({ length: 20 }, (_, index) => ({ id: `message-${index}`, text: `Message ${index}` })),
    agentStatus: { state: "working", agentKey: "helper" },
    animationState: { name: "working", frame: 7 }
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
    navigation: [],
    runtimeDiagnostics: 0
  };

  return {
    calls,
    state,
    options: {
      app: createApp(homePath),
      issueAgentAccessToken: async () => ({ ok: true, token: "desktop-action-test-token", message: "issued" }),
      getAssistantSettings: require("../dist-electron/main/modules/assistant/settings-store.js").getAssistantSettings,
      createContainerHubClient: () => {
        throw new Error("Container Hub is unavailable in this Desktop Action test.");
      },
      services: {
        listServices: async () => [],
        getResponsiveServiceState: async () => null,
        getServiceLogsMeta: async () => null,
        readServiceLog: async () => null,
        installBuiltinService: async () => null,
        getServiceState: async () => null,
        initializeService: async () => null,
        startService: async () => null,
        stopService: async () => null,
        restartService: async () => null
      },
      webs: websFacade,
      getDesktopAppInfo: () => ({
        productName: "ZenMind Test",
        version: "v9.8.7",
        buildTime: "2026-08-20T01:02:03.000Z"
      }),
      getDesktopRuntimeDiagnostics: async () => {
        calls.runtimeDiagnostics += 1;
        return {
          app: {
            productName: "ZenMind Test",
            version: "v9.8.7",
            buildTime: "2026-08-20T01:02:03.000Z"
          },
          device: {
            deviceId: "device-runtime",
            deviceName: "Runtime Device",
            hostname: "runtime-host",
            username: "runtime-user",
            platform: "darwin",
            arch: "arm64"
          },
          paths: {
            homeDir: homePath,
            dataRoot: path.join(homePath, "Library", "Application Support", "ZenMind"),
            appPath: process.cwd(),
            execPath: "/Applications/ZenMind.app/Contents/MacOS/ZenMind"
          },
          runtime: {
            electronVersion: "36.2.1",
            nodeVersion: "22.0.0",
            isPackaged: false
          },
          credentials: {
            desktopSso: {
              present: true,
              expiresAt: 1_800_000_000_000,
              expired: false,
              preview: "****oken"
            }
          },
          services: []
        };
      },
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
        minimumVersion: "9999",
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

test("trusted Agent WebClient WorkPanel calls bypass external confirmation while public actions keep it", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererCalls = [];
  const confirmationCalls = [];
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => {
    confirmationCalls.push(request);
    return { requestId: request.requestId, decision: "cancel" };
  };
  options.callRendererAction = async (request) => {
    rendererCalls.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: createWorkPanelRendererResult(request.action)
    };
  };

  for (const [action, args] of [
    ["openItem", { descriptor: { kind: "web", url: "https://example.test/" } }],
    ["activateItem", { itemId: "item-1" }],
    ["closeItem", { itemId: "item-1" }]
  ]) {
    const response = await handleAgentWebclientWorkPanelActionRequest(options, {
      requestId: `trusted-${action}`,
      action,
      ownerChatId: " chat-owner ",
      args
    });
    assert.equal(response.ok, true, action);
  }

  assert.equal(confirmationCalls.length, 0);
  assert.deepEqual(rendererCalls.map((request) => ({
    requestId: request.requestId,
    action: request.action,
    args: request.args,
    source: request.source
  })), [
    {
      requestId: "trusted-openItem",
      action: "desktop.workpanel.openTab",
      args: { descriptor: { kind: "web", url: "https://example.test/" } },
      source: { chatId: "chat-owner" }
    },
    {
      requestId: "trusted-activateItem",
      action: "desktop.workpanel.activateTab",
      args: { tabId: "item-1" },
      source: { chatId: "chat-owner" }
    },
    {
      requestId: "trusted-closeItem",
      action: "desktop.workpanel.closeTab",
      args: { tabId: "item-1" },
      source: { chatId: "chat-owner" }
    }
  ]);

  const unsupported = await handleAgentWebclientWorkPanelActionRequest(options, {
    action: "closeWorkspace",
    ownerChatId: "chat-owner",
    args: {}
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "forbidden");
  assert.equal(rendererCalls.length, 3);

  const external = await handleDesktopActionRequest(options, {
    requestId: "external-openItem",
    action: "desktop.workpanel.openTab",
    source: { chatId: "chat-owner" },
    args: { descriptor: { kind: "web", url: "https://example.test/" } }
  });
  assert.equal(external.ok, false);
  assert.equal(external.requiresConfirmation, true);
  assert.equal(external.error.code, "user_cancelled");
  assert.equal(confirmationCalls.length, 1);
  assert.equal(confirmationCalls[0].requestId, "external-openItem");
  assert.equal(rendererCalls.length, 3);
});

test("formal WorkPanel Web actions dispatch URL requests to the renderer", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererCalls = [];
  options.callRendererAction = async (request) => {
    rendererCalls.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: createWorkPanelRendererResult(request.action)
    };
  };

  for (const action of ["desktop.workpanel.openWeb", "desktop.workpanel.refreshWeb"]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      source: { chatId: "chat-owner" },
      args: { url: "https://example.test/page" },
      permissionMode: "full_access"
    });
    assert.equal(response.ok, true, action);
  }

  assert.deepEqual(rendererCalls.map(({ action, args, source }) => ({ action, args, source })), [
    {
      action: "desktop.workpanel.openWeb",
      args: { url: "https://example.test/page" },
      source: { chatId: "chat-owner" }
    },
    {
      action: "desktop.workpanel.refreshWeb",
      args: { url: "https://example.test/page" },
      source: { chatId: "chat-owner" }
    }
  ]);
  assert.deepEqual(
    DESKTOP_ACTION_DEFINITIONS
      .filter(({ category }) => category === "workpanel")
      .map(({ name }) => name),
    [
      "desktop.workpanel.getState",
      "desktop.workpanel.openTab",
      "desktop.workpanel.openWeb",
      "desktop.workpanel.openLocalFile",
      "desktop.workpanel.refreshWeb",
      "desktop.workpanel.activateTab",
      "desktop.workpanel.closeTab",
      "desktop.workpanel.closeWorkpanel"
    ]
  );
});

test("Platform-only WorkPanel openLocalFile resolves a trusted workspace path without exposing it to the renderer", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const workspaceDir = path.join(options.app.getPath("home"), "workspace");
  const artifactDir = path.join(workspaceDir, "artifacts");
  const filePath = path.join(artifactDir, "report.html");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(filePath, "<!doctype html><title>Report</title>");
  const rendererCalls = [];
  const preparedClaims = [];
  const discardedClaims = [];
  const confirmations = [];
  options.assistantBridge.listNavigationAgents = async () => ({
    ok: true,
    items: [{
      agentKey: "coder",
      workspaceDir,
      workspaceDirExists: true,
      recentChats: [],
    }],
  });
  options.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: {
      id: 77,
      isDestroyed: () => false,
    },
  });
  options.prepareWorkPanelLocalFileClaim = (input) => {
    preparedClaims.push(input);
    return { claimId: "claim-1" };
  };
  options.discardWorkPanelLocalFileClaim = (claimId) => {
    discardedClaims.push(claimId);
    return true;
  };
  options.confirmRendererAction = async (request) => {
    confirmations.push(request);
    return { requestId: request.requestId, decision: "cancel" };
  };
  options.callRendererAction = async (request) => {
    rendererCalls.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: createWorkPanelRendererResult(request.action),
    };
  };

  const response = await handleAgentPlatformDesktopActionRequest(options, {
    requestId: "platform-local-file",
    action: "desktop.workpanel.openLocalFile",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { path: "artifacts/report.html", title: "Generated report" },
  });
  assert.equal(response.ok, true);
  assert.equal(confirmations.length, 0);
  assert.deepEqual(preparedClaims, [{
    ownerChatId: "chat-owner",
    rendererWebContentsId: 77,
    filePath: fs.realpathSync.native(filePath),
    workspaceRelativePath: "artifacts/report.html",
  }]);
  assert.deepEqual(rendererCalls.map(({ action, args, source }) => ({ action, args, source })), [{
    action: "desktop.workpanel.openLocalFile",
    args: { claimId: "claim-1", title: "Generated report" },
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
  }]);
  assert.equal(JSON.stringify(rendererCalls).includes(filePath), false);
  assert.deepEqual(discardedClaims, ["claim-1"]);

  for (const invoke of [
    () => handleDesktopActionRequest(options, {
      action: "desktop.workpanel.openLocalFile",
      source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
      args: { path: "artifacts/report.html" },
      permissionMode: "full_access",
    }),
    () => handleWebappPageActionRequest(options, "webapp-test", {
      action: "desktop.workpanel.openLocalFile",
      source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
      args: { path: "artifacts/report.html" },
    }),
    () => handleAgentWebclientWorkPanelActionRequest(options, {
      action: "openLocalFile",
      ownerChatId: "chat-owner",
      args: { path: "artifacts/report.html" },
    }),
  ]) {
    const denied = await invoke();
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "forbidden");
  }
  assert.equal(confirmations.length, 0);
  assert.equal(rendererCalls.length, 1);
});

test("WorkPanel openLocalFile fails closed for invalid paths and unavailable Agent workspaces", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: { id: 77, isDestroyed: () => false },
  });
  options.prepareWorkPanelLocalFileClaim = () => assert.fail("invalid paths must not prepare claims");
  options.discardWorkPanelLocalFileClaim = () => true;
  options.assistantBridge.listNavigationAgents = async () => ({
    ok: true,
    items: [{ agentKey: "coder", workspaceDir: "@chat", workspaceDirExists: false, recentChats: [] }],
  });
  const workspaceUnavailable = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.workpanel.openLocalFile",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { path: "artifacts/report.html" },
  });
  assert.equal(workspaceUnavailable.ok, false);
  assert.equal(workspaceUnavailable.error.code, "workspace_unavailable");

  const workspaceDir = path.join(options.app.getPath("home"), "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  options.assistantBridge.listNavigationAgents = async () => ({
    ok: true,
    items: [{ agentKey: "coder", workspaceDir, workspaceDirExists: true, recentChats: [] }],
  });
  for (const invalidPath of ["../secret.txt", "/tmp/secret.txt", "file:///tmp/secret.txt"] ) {
    const invalid = await handleAgentPlatformDesktopActionRequest(options, {
      action: "desktop.workpanel.openLocalFile",
      source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
      args: { path: invalidPath },
    });
    assert.equal(invalid.ok, false, invalidPath);
    assert.equal(invalid.error.code, "invalid_path", invalidPath);
  }
  const missing = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.workpanel.openLocalFile",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { path: "missing.html" },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "file_unavailable");
});

test("Agent Platform WebApp Tooling actions use only the trusted Run workspace", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const workspaceRoot = path.join(options.app.getPath("home"), "agent-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  options.webappToolingWorkerPath = path.join(
    process.cwd(),
    "dist-electron/main/modules/webs/webapps/tooling/worker.js"
  );
  let confirmations = 0;
  options.confirmRendererAction = async () => {
    confirmations += 1;
    return { decision: "cancel" };
  };
  const source = {
    chatId: "chat-owner",
    runId: "run-owner",
    agentKey: "coder",
    workspaceRoot
  };

  const initialized = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.manifest.init",
    source,
    args: {
      projectPath: "apps/example",
      key: "action-example",
      label: "Action Example"
    }
  });
  assert.equal(initialized.ok, true);
  assert.equal(initialized.result.projectPath, "apps/example");
  assert.equal(initialized.result.manifestPath, "apps/example/webapp.json");
  assert.equal("ok" in initialized.result, false);
  assert.equal("message" in initialized.result, false);
  assert.equal(JSON.stringify(initialized).includes(workspaceRoot), false);

  const manifest = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.manifest.validate",
    source: { ...source, agentKey: undefined, teamId: "builders" },
    args: { projectPath: "apps/example" }
  });
  assert.equal(manifest.ok, true);
  assert.equal(manifest.result.id, initialized.result.id);

  const project = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.package.validate",
    source,
    args: { projectPath: "apps/example" }
  });
  assert.equal(project.ok, true);
  assert.ok(project.result.fileCount >= 2);

  const built = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.package.build",
    source,
    args: { projectPath: "apps/example", outputPath: "artifacts/example.zip" }
  });
  assert.equal(built.ok, true);
  assert.equal(built.result.outputPath, "artifacts/example.zip");
  assert.match(built.result.sha256, /^[a-f\d]{64}$/u);
  assert.equal(confirmations, 0);

  const archive = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.package.validate",
    source,
    args: { archivePath: "artifacts/example.zip" }
  });
  assert.equal(archive.ok, true);
  assert.equal(archive.result.id, initialized.result.id);
  assert.equal(JSON.stringify(archive).includes(workspaceRoot), false);

  options.getMainWindow = () => ({
    isDestroyed: () => false,
    webContents: { send() {}, isDestroyed: () => false }
  });
  options.confirmRendererAction = async (request) => ({ requestId: request.requestId, decision: "confirm" });
  const installed = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    source,
    args: { workspaceArchivePath: "artifacts/example.zip", expectedId: initialized.result.id }
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.result.webappId, initialized.result.id);

  const runtimeCheck = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.checkRuntime",
    source,
    args: { webappId: initialized.result.id }
  });
  assert.equal(runtimeCheck.ok, true);
  assert.equal(runtimeCheck.result.ready, true);

  const opened = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.open",
    source,
    args: { webappId: initialized.result.id }
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.result.status, "running");

  const sites = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.site.list",
    source,
    args: {}
  });
  assert.equal(sites.ok, true);
  assert.ok(sites.result.items.some((item) => item.kind === "webapp" && item.id === initialized.result.id));

  const stopped = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.stop",
    source,
    args: { webappId: initialized.result.id }
  });
  assert.equal(stopped.ok, true);

  const absolute = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.package.validate",
    source,
    args: { archivePath: path.join(workspaceRoot, "artifacts/example.zip") }
  });
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error.code, "invalid_path");
  assert.equal(absolute.error.details.stage, "archive");
  assert.equal(JSON.stringify(absolute).includes(workspaceRoot), false);

  const missingWorkspace = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.manifest.validate",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { projectPath: "apps/example" }
  });
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.error.code, "forbidden");

  const forgedSource = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.manifest.validate",
    source: {
      chatId: "chat-owner",
      runId: "run-owner",
      agentKey: "coder",
      teamId: "builders",
      workspaceRoot: 42
    },
    args: { projectPath: "apps/example" }
  });
  assert.equal(forgedSource.ok, false);
  assert.equal(forgedSource.error.code, "forbidden");

  const forgedDesktop = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.package.build",
    source,
    args: { projectPath: "apps/example", outputPath: "artifacts/forged.zip" },
    permissionMode: "full_access"
  });
  assert.equal(forgedDesktop.ok, false);
  assert.equal(forgedDesktop.error.code, "forbidden");
});

test("Agent Platform WebApp install accepts only a workspace-relative archive path", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => ({ requestId: request.requestId, decision: "confirm" });
  const workspaceRoot = path.join(options.app.getPath("home"), "agent-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const source = { chatId: "chat-owner", runId: "run-owner", agentKey: "coder", workspaceRoot };

  const direct = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    source,
    args: { archivePath: path.join(workspaceRoot, "example.zip") }
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, "invalid_args");

  const absoluteWorkspacePath = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    source,
    args: { workspaceArchivePath: path.join(workspaceRoot, "example.zip") }
  });
  assert.equal(absoluteWorkspacePath.ok, false);
  assert.equal(absoluteWorkspacePath.error.code, "invalid_path");
  assert.equal(JSON.stringify(absoluteWorkspacePath).includes(workspaceRoot), false);
});

test("Agent Platform context exempts approved WorkPanel Web actions without exempting openTab", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererCalls = [];
  const confirmationCalls = [];
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => {
    confirmationCalls.push(request);
    return { requestId: request.requestId, decision: "cancel" };
  };
  options.callRendererAction = async (request) => {
    rendererCalls.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: createWorkPanelRendererResult(request.action)
    };
  };

  for (const action of ["desktop.workpanel.openWeb", "desktop.workpanel.refreshWeb"]) {
    const response = await handleAgentPlatformDesktopActionRequest(options, {
      action,
      source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
      args: { url: "https://example.test/page" }
    });
    assert.equal(response.ok, true, action);
  }
  assert.equal(confirmationCalls.length, 0);
  assert.equal(rendererCalls.length, 2);

  const otherPlatformAction = await handleAgentPlatformDesktopActionRequest(options, {
    action: "desktop.workpanel.openTab",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { descriptor: { kind: "web", url: "https://example.test/page" } }
  });
  assert.equal(otherPlatformAction.ok, false);
  assert.equal(otherPlatformAction.requiresConfirmation, true);

  const ordinaryDesktopCall = await handleDesktopActionRequest(options, {
    action: "desktop.workpanel.openWeb",
    source: { chatId: "chat-owner", runId: "run-owner", agentKey: "coder" },
    args: { url: "https://example.test/page" }
  });
  assert.equal(ordinaryDesktopCall.ok, false);
  assert.equal(ordinaryDesktopCall.requiresConfirmation, true);
  assert.equal(confirmationCalls.length, 2);
  assert.equal(rendererCalls.length, 2);
});

test("P1 renderer mutations expose exact bounded post-action state", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const workspace = createWorkPanelWorkspace();
  const webState = createWebActionState();
  options.callRendererAction = async (request) => {
    let result;
    if (request.action === "desktop.web.activateSurface") {
      result = { surface: expectedWebState.surface };
    } else if (request.action.startsWith("desktop.web.")) {
      result = {
        ...webState,
        ...(request.action === "desktop.web.navigate"
          ? { targetTabId: "tab-1", navigatedUrl: "https://example.test/next", internalNavigationId: "nav-1" }
          : {}),
        ...(request.action === "desktop.web.reload" || request.action === "desktop.web.goBack"
          ? { targetTabId: "tab-1" }
          : {}),
        ...(request.action === "desktop.web.openTab"
          ? { openedTabId: "tab-1", openedTab: webState.activeTab }
          : {}),
        ...(request.action === "desktop.web.closeTab"
          ? {
              closedTabId: "tab-2",
              closedSurface: false,
              remainingTabIds: ["tab-1"],
              activeTabId: "tab-1"
            }
          : {})
      };
    } else if (request.action.startsWith("desktop.workpanel.")) {
      result = createWorkPanelRendererResult(request.action);
    } else {
      result = {
        pageKey: "help",
        preference: { enabled: true, agentKey: "helper" },
        desktopCopilotPages: { help: { enabled: true }, market: { enabled: false } }
      };
    }
    return { requestId: request.requestId, action: request.action, ok: true, result };
  };

  const expectedTabs = [
    {
      tabId: "tab-1",
      title: "Example",
      currentUrl: "https://example.test/",
      faviconUrl: "https://example.test/favicon.ico",
      active: true,
      isLoading: false,
      canGoBack: true,
      canGoForward: false
    },
    {
      tabId: "tab-2",
      title: "Second",
      currentUrl: "https://second.test/",
      active: false,
      isLoading: true,
      canGoBack: false,
      canGoForward: true
    }
  ];
  const expectedWebState = {
    surface: {
      surfaceId: "browser",
      surfaceRole: "browser",
      surfaceLevel: "root",
      interaction: "interactive",
      kind: "browser",
      label: "Browser",
      url: "https://example.test/",
      route: "/browser",
      open: true,
      active: true
    },
    tabs: expectedTabs,
    activeTab: expectedTabs[0]
  };
  const activated = await handleDesktopActionRequest(options, {
    action: "desktop.web.activateSurface",
    args: { surfaceId: "browser" },
    permissionMode: "full_access"
  });
  assert.deepEqual(activated, {
    ok: true,
    action: "desktop.web.activateSurface",
    result: { surface: expectedWebState.surface }
  });
  const webExpectations = new Map([
    ["desktop.web.navigate", { ...expectedWebState, targetTabId: "tab-1", navigatedUrl: "https://example.test/next" }],
    ["desktop.web.reload", { ...expectedWebState, targetTabId: "tab-1" }],
    ["desktop.web.goBack", { ...expectedWebState, targetTabId: "tab-1" }],
    ["desktop.web.openTab", { ...expectedWebState, openedTabId: "tab-1" }],
    ["desktop.web.closeTab", { ...expectedWebState, closedTabId: "tab-2", closedSurface: false }],
    ["desktop.web.switchTab", expectedWebState]
  ]);
  for (const [action, expectedResult] of webExpectations) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: { surfaceId: "browser", tabId: "tab-1", url: "https://example.test/next" },
      permissionMode: "full_access"
    });
    assert.deepEqual(response, { ok: true, action, result: expectedResult });
    assert.equal(JSON.stringify(response).includes("guestId"), false);
    assert.equal(JSON.stringify(response).includes("webContentsId"), false);
  }

  const workPanelExpectations = new Map([
    ["desktop.workpanel.openTab", { workspace }],
    ["desktop.workpanel.openWeb", { workspace }],
    ["desktop.workpanel.refreshWeb", { workspace }],
    ["desktop.workpanel.activateTab", { workspace }],
    ["desktop.workpanel.closeTab", { closedItemId: "item-1", workspace }],
    ["desktop.workpanel.closeWorkpanel", { workspaceId: workspace.workspaceId, closed: true }]
  ]);
  for (const [action, expectedResult] of workPanelExpectations) {
    const response = await handleDesktopActionRequest(options, {
      action,
      source: { chatId: "chat-owner", agentKey: "helper" },
      args: { tabId: "item-1", url: "https://example.test/", descriptor: { kind: "web", url: "https://example.test/" } },
      permissionMode: "full_access"
    });
    assert.deepEqual(response, { ok: true, action, result: expectedResult });
  }

  const copilot = await handleDesktopActionRequest(options, {
    action: "desktop.copilot.setPagePreference",
    args: { pageKey: "help", enabled: true, agentKey: "helper" },
    permissionMode: "full_access"
  });
  assert.deepEqual(copilot, {
    ok: true,
    action: "desktop.copilot.setPagePreference",
    result: { pageKey: "help", preference: { enabled: true, agentKey: "helper" } }
  });

  options.callRendererAction = async (request) => ({
    requestId: request.requestId,
    action: request.action,
    ok: false,
    error: {
      code: "invalid_agent",
      message: "The requested agent is unavailable.",
      details: {
        pageKey: "help",
        agentKey: "missing",
        agentOptions: [{ value: "helper", label: "Helper" }]
      }
    }
  });
  const invalidAgent = await handleDesktopActionRequest(options, {
    action: "desktop.copilot.setPagePreference",
    args: { pageKey: "help", agentKey: "missing" },
    permissionMode: "full_access"
  });
  assert.deepEqual(invalidAgent.error.details.agentOptions, [{ value: "helper", label: "Helper" }]);
});

test("desktop.web.closeTab returns an explicit empty post-state after the final tab", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.callRendererAction = async (request) => ({
    requestId: request.requestId,
    action: request.action,
    ok: true,
    result: {
      surface: null,
      tabs: [],
      activeTab: null,
      closedTabId: "tab-1",
      closedSurface: true,
      remainingTabIds: [],
      activeTabId: null
    }
  });
  const response = await handleDesktopActionRequest(options, {
    action: "desktop.web.closeTab",
    args: { surfaceId: "browser", tabId: "tab-1" },
    permissionMode: "full_access"
  });
  assert.deepEqual(response, {
    ok: true,
    action: "desktop.web.closeTab",
    result: {
      surface: null,
      tabs: [],
      activeTab: null,
      closedTabId: "tab-1",
      closedSurface: true
    }
  });
});

test("desktop.workpanel.closeTab returns a null workspace when the reducer destroys it", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.callRendererAction = async (request) => ({
    requestId: request.requestId,
    action: request.action,
    ok: true,
    result: {
      ok: true,
      workspaceId: "workpanel:chat-owner",
      item: createWorkPanelWorkspace().items[0]
    }
  });
  const response = await handleDesktopActionRequest(options, {
    action: "desktop.workpanel.closeTab",
    source: { chatId: "chat-owner" },
    args: { tabId: "item-1" },
    permissionMode: "full_access"
  });
  assert.deepEqual(response, {
    ok: true,
    action: "desktop.workpanel.closeTab",
    result: { closedItemId: "item-1", workspace: null }
  });
});

test("desktop.display routes to the Main renderer without confirmation", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendererCalls = [];
  let confirmationCalls = 0;
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async () => {
    confirmationCalls += 1;
    return { requestId: "unexpected", decision: "cancel" };
  };
  options.callRendererAction = async (request) => {
    rendererCalls.push(request);
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: { status: "accepted", kind: "effect", effect: "fireworks", durationMs: 8_000 }
    };
  };

  const response = await handleAgentPlatformDesktopActionRequest(options, {
    requestId: "display-1",
    action: "desktop.display",
    source: { runId: "run-1", chatId: "chat-1", agentKey: "coder" },
    args: { kind: "effect", effect: "fireworks" }
  });

  assert.equal(response.ok, true);
  assert.equal(confirmationCalls, 0);
  assert.equal(rendererCalls.length, 1);
  assert.deepEqual(rendererCalls[0].args, { kind: "effect", effect: "fireworks" });

  for (const mainWindow of [
    null,
    { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false },
    { isDestroyed: () => false, isVisible: () => true, isMinimized: () => true },
  ]) {
    options.getMainWindow = () => mainWindow;
    const unavailable = await handleAgentPlatformDesktopActionRequest(options, {
      action: "desktop.display",
      source: { runId: "run-1", chatId: "chat-1", agentKey: "coder" },
      args: { kind: "effect", effect: "snowfall" }
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, "display_target_unavailable");
  }
  assert.equal(rendererCalls.length, 1);
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

test("WebApp image action consumes a scoped upload and hardcodes Zenmi without exposing paths", async (t) => {
  clearWebappImageUploadsForTest();
  t.after(clearWebappImageUploadsForTest);
  const { options } = createDesktopActionOptions(t);
  const id = webappId("image-studio-zenmi");
  const webappDir = path.join(getDesktopWebappsDataRoot(options.app), id);
  fs.mkdirSync(path.join(webappDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(webappDir, "frontend", "index.html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(webappDir, "webapp.json"), JSON.stringify({
    schemaVersion: 2,
    id,
    key: "image-studio-zenmi",
    label: "Image Studio",
    version: "1.0.1",
    target: "any",
    appConfig: {},
    frontend: { root: "frontend", index: "index.html", routeConfig: { backendPrefixes: [] } },
    desktopBridge: { version: 1 }
  }), "utf8");

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upload = registerWebappImageUpload({
    webappId: id,
    source: normalizeWebappImageUploadFile({ name: "source.png", mimeType: "image/png", bytes: png }),
    mask: normalizeWebappImageUploadFile({ name: "mask.png", mimeType: "image/png", bytes: png }, { mask: true })
  });
  const imageCalls = [];
  options.assistantBridge.completeImage = async (request) => {
    imageCalls.push(request);
    return {
      ok: true,
      runId: request.runId,
      chatId: "chat-image",
      message: "done",
      images: [{ name: "result.png", mimeType: "image/png", sizeBytes: png.length, sha256: "abc", dataBase64: png.toString("base64") }]
    };
  };
  options.assistantBridge.stopRun = async () => ({ ok: true, message: "stopped" });
  const response = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.image",
    args: {
      requestId: "image_request_1",
      uploadId: upload.uploadId,
      operation: "inpaint",
      prompt: "把杯子换成花瓶",
      negativePrompt: "文字",
      width: 1024,
      height: 1024,
      count: 1,
      strength: .65,
      seed: 42,
      preserveComposition: true,
      edgeMode: "strict"
    }
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.agentKey, "zenmi");
  assert.equal(response.result.provider, "desktop-zenmi");
  assert.equal(Object.hasOwn(response.result.images[0], "path"), false);
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0].agentKey, "zenmi");
  assert.equal(imageCalls[0].action, "image_studio");
  assert.deepEqual(imageCalls[0].attachments.map((attachment) => attachment.id), ["image-studio-source", "image-studio-mask"]);
  assert.equal(imageCalls[0].attachments.every((attachment) => attachment.dataUrl.startsWith("data:image/")), true);

  const forged = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.image",
    args: {
      requestId: "image_request_2",
      operation: "generate",
      prompt: "风景",
      negativePrompt: "",
      width: 1024,
      height: 1024,
      count: 1,
      strength: .5,
      seed: 1,
      preserveComposition: true,
      edgeMode: "strict",
      agentKey: "other-agent"
    }
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "invalid_args");

  const unaligned = await handleWebappPageActionRequest(options, id, {
    action: "desktop.assistant.image",
    args: {
      requestId: "image_request_3",
      operation: "generate",
      prompt: "风景",
      negativePrompt: "",
      width: 1023,
      height: 1537,
      count: 1,
      strength: .5,
      seed: 1,
      preserveComposition: true,
      edgeMode: "strict"
    }
  });
  assert.equal(unaligned.ok, false);
  assert.equal(unaligned.error.code, "invalid_args");
  assert.match(unaligned.error.message, /divisible by 16/u);
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
  assert.deepEqual(installed, {
    ok: true,
    action: "desktop.webapp.install",
    result: { webappId: id, operation: "installed" }
  });
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
  assert.deepEqual(started, {
    ok: true,
    action: "desktop.webapp.start",
    result: { webappId: id, status: "running" }
  });

  const restarted = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.restart",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(restarted, {
    ok: true,
    action: "desktop.webapp.restart",
    result: { webappId: id, status: "running" }
  });

  const opened = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.open",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(opened, {
    ok: true,
    action: "desktop.webapp.open",
    result: { webappId: id, status: "running", route: `/webs/webapp:${id}` }
  });

  const preferences = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.updatePreferences",
    args: { id, patch: { label: "Lifecycle Preference", openMode: "dialog" } },
    permissionMode: "full_access"
  });
  assert.deepEqual(preferences, {
    ok: true,
    action: "desktop.webapp.updatePreferences",
    result: { webappId: id, label: "Lifecycle Preference", openMode: "dialog" }
  });

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
  assert.deepEqual(updated, {
    ok: true,
    action: "desktop.webapp.install",
    result: { webappId: id, operation: "updated" }
  });
  assert.deepEqual(calls.navigation, [`/webs/webapp:${id}`]);

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
  assert.deepEqual(uninstalled, {
    ok: true,
    action: "desktop.webapp.uninstall",
    result: { webappId: id }
  });
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
  echo "java 9999.0.0"
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
  assert.match(runtimeProbe.stdout, /9999\.0\.0/u);
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
  assert.deepEqual(installed, {
    ok: true,
    action: "desktop.webapp.install",
    result: { webappId: id, operation: "installed" }
  });
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
  assert.equal(published.error.code, "webapp_publish_failed");
  assert.equal(published.error.details.webappId, id);
  assert.equal(published.error.details.operation, "publish");
  assert.equal(published.error.details.state.status, "error");

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
  assert.deepEqual(started, {
    ok: true,
    action: "desktop.webapp.start",
    result: { webappId: id, status: "running" }
  });
  const persistentDataPath = getDesktopWebappDataRoot(options.app, id);
  fs.mkdirSync(persistentDataPath, { recursive: true });
  fs.writeFileSync(path.join(persistentDataPath, "keep.txt"), "keep", "utf8");

  const unpublished = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.unpublish",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(unpublished, {
    ok: true,
    action: "desktop.webapp.unpublish",
    result: { webappId: id, status: "unpublished" }
  });
  const runningStatus = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.getStatus",
    args: { id },
    permissionMode: "full_access"
  });
  assert.equal(runningStatus.result.status, "running");
  assert.equal(fs.readFileSync(path.join(persistentDataPath, "keep.txt"), "utf8"), "keep");
  const stopped = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.stop",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(stopped, {
    ok: true,
    action: "desktop.webapp.stop",
    result: { webappId: id, status: "stopped" }
  });
});

test("desktop.webapp.publish exposes only its single-instance success result", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const id = webappId("publish-success");
  options.publishWebapp = async () => ({
    ok: true,
    info: {
      provider: "tunnel",
      configured: true,
      signedIn: true,
      tunnelEnabled: true,
      tunnelConnected: true,
      deviceId: "device-1",
      relayUrl: "wss://relay.example.test/ws"
    },
    state: {
      id,
      provider: "tunnel",
      status: "published",
      name: "publish-success",
      routeId: "route-1",
      publicHost: "public.example.test",
      url: "https://public.example.test/app",
      targetUrl: "http://127.0.0.1:12000",
      active: true,
      message: "Published",
      updatedAt: "2026-08-24T00:00:00.000Z"
    },
    message: "Published",
    otherWebapps: [{ id: webappId("other") }]
  });

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.publish",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(response, {
    ok: true,
    action: "desktop.webapp.publish",
    result: { webappId: id, status: "published", publicUrl: "https://public.example.test/app" }
  });

  options.publishWebapp = async () => ({
    ok: true,
    info: {
      provider: "tunnel",
      configured: true,
      signedIn: true,
      tunnelEnabled: true,
      tunnelConnected: true,
      deviceId: "device-1",
      relayUrl: "wss://relay.example.test/ws"
    },
    state: {
      id,
      provider: "tunnel",
      status: "published",
      name: "publish-success",
      routeId: "route-1",
      publicHost: "",
      url: "",
      targetUrl: "http://127.0.0.1:12000",
      active: true,
      message: "Published without a URL",
      updatedAt: "2026-08-24T00:00:00.000Z"
    },
    message: "Published without a URL"
  });
  const invalid = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.publish",
    args: { id },
    permissionMode: "full_access"
  });
  assert.deepEqual(invalid, {
    ok: false,
    action: "desktop.webapp.publish",
    error: {
      code: "invalid_action_result",
      message: "desktop.webapp.publish succeeded without the required public result fields.",
      details: { webappId: id, operation: "publish", missingFields: ["state.url"] }
    }
  });
});

test("WebApp business failures use stable codes and retain only sanitized target diagnostics", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const id = webappId("missing-p1-webapp");

  for (const [action, code] of [
    ["desktop.webapp.start", "webapp_start_failed"],
    ["desktop.webapp.stop", "webapp_stop_failed"],
    ["desktop.webapp.restart", "webapp_restart_failed"],
    ["desktop.webapp.open", "webapp_open_failed"],
    ["desktop.webapp.updatePreferences", "webapp_update_failed"],
    ["desktop.webapp.uninstall", "webapp_uninstall_failed"]
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: { id, patch: { label: "Missing" } },
      permissionMode: "full_access"
    });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, code, action);
    assert.equal(response.error.details.webappId, id, action);
    assert.equal(JSON.stringify(response.error.details).includes('"items"'), false, action);
  }

  const invalidArchivePath = path.join(options.app.getPath("home"), "invalid-webapp.zip");
  fs.writeFileSync(invalidArchivePath, "not-a-zip", "utf8");
  const installFailure = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: invalidArchivePath, expectedId: id },
    permissionMode: "full_access"
  });
  assert.equal(installFailure.ok, false);
  assert.equal(installFailure.error.code, "webapp_install_failed");
  assert.equal(installFailure.error.details.webappId, id);
  assert.equal(installFailure.error.details.operation, "install");
  assert.equal(installFailure.error.details.path, invalidArchivePath);
  assert.equal(typeof installFailure.error.details.diagnostic.stage, "string");
  assert.equal(typeof installFailure.error.details.diagnostic.code, "string");
  assert.equal("items" in installFailure.error.details, false);

  const blockedId = webappId("blocked-runtime-p1");
  const blockedArchive = await writeStaticWebappArchive(
    options.app.getPath("home"),
    "blocked-runtime-p1",
    "Blocked Runtime"
  );
  const installed = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.install",
    args: { archivePath: blockedArchive, expectedId: blockedId },
    permissionMode: "full_access"
  });
  assert.equal(installed.ok, true);
  const blockedRoot = path.join(getDesktopWebappsDataRoot(options.app), blockedId);
  const blockedManifestPath = path.join(blockedRoot, "webapp.json");
  const blockedManifest = JSON.parse(fs.readFileSync(blockedManifestPath, "utf8"));
  blockedManifest.frontend.routeConfig.backendPrefixes = ["/api"];
  blockedManifest.backend = {
    command: { type: "runtime", runtime: "java", minimumVersion: "9999", entry: "backend/server.jar" },
    args: [],
    env: {},
    health: { type: "http", path: "/api/health", startupTimeoutMs: 2_000 },
    shutdownTimeoutMs: 1_000
  };
  fs.mkdirSync(path.join(blockedRoot, "backend"), { recursive: true });
  fs.writeFileSync(path.join(blockedRoot, "backend", "server.jar"), "blocked", "utf8");
  fs.writeFileSync(blockedManifestPath, JSON.stringify(blockedManifest), "utf8");
  const blocked = await handleDesktopActionRequest(options, {
    action: "desktop.webapp.start",
    args: { id: blockedId },
    permissionMode: "full_access"
  });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.error.code, "webapp_start_failed");
  assert.deepEqual(blocked.error.details.item, {
    id: blockedId,
    label: "Blocked Runtime",
    version: "1.0.0",
    target: "any",
    openMode: "workspace"
  });
  assert.equal(blocked.error.details.state.id, blockedId);
  assert.equal(blocked.error.details.state.status, "blocked");
  assert.equal(blocked.error.details.state.prerequisiteIssues.length > 0, true);
  assert.equal("backend" in blocked.error.details.item, false);
  assert.equal("items" in blocked.error.details, false);

  const publishFailure = {
    ok: false,
    info: {
      provider: "tunnel",
      configured: true,
      signedIn: false,
      tunnelEnabled: true,
      tunnelConnected: false,
      deviceId: "device-1",
      relayUrl: "wss://relay.example.test/ws?token=relay-secret",
      accessToken: "must-not-leak"
    },
    state: {
      id,
      provider: "tunnel",
      status: "error",
      name: "missing-p1-webapp",
      routeId: "route-1",
      publicHost: "",
      url: "",
      targetUrl: "http://127.0.0.1:12000?token=runtime-secret",
      active: false,
      message: "authorization token=publish-secret",
      updatedAt: "2026-08-24T00:00:00.000Z",
      cookies: [{ value: "must-not-leak" }]
    },
    message: "publish failed token=outer-secret",
    items: [{ id: webappId("other") }]
  };
  options.publishWebapp = async () => publishFailure;
  options.unpublishWebapp = async () => publishFailure;

  for (const [action, code, operation] of [
    ["desktop.webapp.publish", "webapp_publish_failed", "publish"],
    ["desktop.webapp.unpublish", "webapp_unpublish_failed", "unpublish"]
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      args: { id },
      permissionMode: "full_access"
    });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, code, action);
    assert.equal(response.error.details.webappId, id, action);
    assert.equal(response.error.details.operation, operation, action);
    assert.equal(JSON.stringify(response).includes("must-not-leak"), false, action);
    assert.equal(JSON.stringify(response).includes("outer-secret"), false, action);
    assert.equal(JSON.stringify(response).includes("publish-secret"), false, action);
    assert.equal(JSON.stringify(response).includes("runtime-secret"), false, action);
    assert.equal(JSON.stringify(response).includes("relay-secret"), false, action);
    assert.equal(JSON.stringify(response).includes('"items"'), false, action);
  }
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

  const backendDiagnostics = await call(
    "/webapps/actions/call",
    backendToken,
    "desktop.runtime.diagnostics"
  );
  assert.equal(backendDiagnostics.status, 403);
  assert.equal(backendDiagnostics.body.error.code, "forbidden");
  assert.equal(calls.runtimeDiagnostics, 0);

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
  assert.deepEqual(stateResponse, {
    ok: true,
    action: "desktop.pet.state",
    result: {
      supported: true,
      enabled: true,
      appearanceId: "classic"
    }
  });
  assert.equal(state.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(calls.refreshState, 1);

  const listResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.list"
  });
  assert.deepEqual(listResponse, {
    ok: true,
    action: "desktop.pet.list",
    result: {
      appearanceId: "classic",
      appearances: [
        { id: "classic", displayName: "Classic", description: "Builtin pet." },
        { id: "user:dario", displayName: "Dario", description: "Local pet." }
      ]
    }
  });

  const setResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.set",
    args: { id: "user:dario" },
    permissionMode: "full_access"
  });
  assert.deepEqual(setResponse, {
    ok: true,
    action: "desktop.pet.set",
    result: { appearanceId: "user:dario" }
  });
  assert.deepEqual(calls.saveSettings, [{ appearanceId: "user:dario" }]);

  const showResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.show",
    permissionMode: "full_access"
  });
  assert.deepEqual(showResponse, {
    ok: true,
    action: "desktop.pet.show",
    result: { enabled: true }
  });

  const hideResponse = await handleDesktopActionRequest(options, {
    action: "desktop.pet.hide",
    permissionMode: "full_access"
  });
  assert.deepEqual(hideResponse, {
    ok: true,
    action: "desktop.pet.hide",
    result: { enabled: false }
  });
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
  assert.equal("details" in response.error, false);
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
      result: request.action === "desktop.copilot.setPagePreference"
        ? {
            pageKey: "help",
            preference: { enabled: true, agentKey: "helper" },
            desktopCopilotPages: { help: { enabled: true, agentKey: "helper" }, market: { enabled: false } }
          }
        : { handled: request.action }
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
    if (action === "desktop.copilot.setPagePreference") {
      assert.deepEqual(response.result, {
        pageKey: "help",
        preference: { enabled: true, agentKey: "helper" }
      });
    } else {
      assert.equal(response.result.handled, action);
    }
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

test("desktop web exportArtifact writes provider bytes to Downloads without returning payload data", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rendered = [];
  const snapshot = {
    route: "/webs/webapp:webapp-0123456789abcdef",
    pageKey: "poster-page",
    pageKind: "webview",
    surfaceId: "app:poster",
    surfaceRoute: "/webs/webapp:webapp-0123456789abcdef",
    webContentsId: 701,
    pageContext: null
  };
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async (script) => {
      if (script.includes("provider.describe")) {
        return {
          status: "ok",
          description: {
            formats: ["png", "html", "project", "pdf"],
            suggestedFilenames: { pdf: "结构化海报.pdf" }
          }
        };
      }
      return {
        status: "ok",
        payload: {
          filename: "结构化海报.html",
          mimeType: "text/html",
          encoding: "utf8",
          data: "<!doctype html><title>结构化海报</title>"
        }
      };
    },
    printToPDF: async (printOptions) => {
      rendered.push(printOptions);
      return Buffer.from("pdf-result");
    }
  };
  options.getCurrentPageSnapshot = () => snapshot;
  options.getWebContentsById = (id) => id === 701 ? contents : null;
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => ({ requestId: request.requestId, decision: "confirm" });

  const first = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "html" },
    expectedPageKey: "poster-page"
  });
  const second = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "html" }
  });
  const pdf = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "pdf" }
  });

  assert.equal(first.ok, true);
  assert.equal(first.result.surfaceId, "app:poster");
  assert.equal(first.result.filename, "结构化海报.html");
  assert.equal(first.result.mimeType, "text/html");
  assert.equal("data" in first.result, false);
  assert.equal(fs.readFileSync(first.result.filePath, "utf8"), "<!doctype html><title>结构化海报</title>");
  assert.equal(second.result.filename, "结构化海报 (1).html");
  assert.equal(pdf.result.filename, "结构化海报.pdf");
  assert.deepEqual(rendered, [{ pageSize: "A4", printBackground: true, preferCSSPageSize: true }]);
  assert.deepEqual(
    fs.readdirSync(options.app.getPath("downloads")).filter((name) => name.startsWith(".")),
    [],
    "same-directory temporary files must be removed after the atomic rename"
  );
});

test("desktop web exportArtifact rejects child surfaces, invalid payloads, and oversized files", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const rootSnapshot = {
    route: "/webs/webapp:webapp-0123456789abcdef",
    pageKey: "poster-page",
    pageKind: "webview",
    surfaceId: "app:poster",
    surfaceRoute: "/webs/webapp:webapp-0123456789abcdef",
    webContentsId: 702,
    pageContext: null
  };
  let mode = "invalid";
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async (script) => {
      if (script.includes("provider.describe")) {
        return { status: "ok", description: { formats: ["png"] } };
      }
      return mode === "invalid"
        ? { status: "ok", payload: { filename: "poster.png", mimeType: "image/jpeg", encoding: "base64", data: "eA==" } }
        : { status: "ok", payload: { filename: "poster.png", mimeType: "image/png", encoding: "base64", data: Buffer.alloc(32 * 1024 * 1024 + 1).toString("base64") } };
    },
    printToPDF: async () => Buffer.from("pdf")
  };
  options.getCurrentPageSnapshot = () => ({ ...rootSnapshot, surfaceId: "copilot-dock" });
  options.getWebContentsById = () => contents;
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => ({ requestId: request.requestId, decision: "confirm" });
  const child = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "png" }
  });
  assert.equal(child.error.code, "current_webapp_required");

  options.getCurrentPageSnapshot = () => rootSnapshot;
  const invalid = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "png" }
  });
  assert.equal(invalid.error.code, "export_payload_invalid");

  mode = "oversized";
  const oversized = await handleDesktopActionRequest(options, {
    action: "desktop.web.exportArtifact",
    args: { format: "png" }
  });
  assert.equal(oversized.error.code, "export_too_large");
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

test("runtime actions publish stable read contracts and info uses startup-cached metadata", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const definitions = DESKTOP_ACTION_DEFINITIONS.filter(({ category }) => category === "runtime");

  assert.deepEqual(definitions.map(({ name, kind, confirmation }) => ({ name, kind, confirmation })), [
    { name: "desktop.runtime.info", kind: "read", confirmation: undefined },
    { name: "desktop.runtime.diagnostics", kind: "read", confirmation: "sensitive-read" }
  ]);

  const response = await handleDesktopActionRequest(options, {
    action: "desktop.runtime.info"
  });
  assert.deepEqual(response, {
    ok: true,
    action: "desktop.runtime.info",
    result: {
      productName: "ZenMind Test",
      version: "v9.8.7",
      buildTime: "2026-08-20T01:02:03.000Z"
    }
  });

  const invalid = await handleDesktopActionRequest(options, {
    action: "desktop.runtime.info",
    args: { verbose: true }
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_args");
});

test("runtime diagnostics confirms before reading and honors confirmation bypass settings", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const confirmationCalls = [];
  options.getMainWindow = () => ({ isDestroyed: () => false });
  options.confirmRendererAction = async (request) => {
    confirmationCalls.push(request);
    return { requestId: request.requestId, decision: "cancel" };
  };

  const invalid = await handleDesktopActionRequest(options, {
    action: "desktop.runtime.diagnostics",
    args: { includeToken: true }
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_args");
  assert.equal(confirmationCalls.length, 0);
  assert.equal(calls.runtimeDiagnostics, 0);

  const cancelled = await handleDesktopActionRequest(options, {
    requestId: "runtime-diagnostics-cancel",
    action: "desktop.runtime.diagnostics"
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.requiresConfirmation, true);
  assert.equal(cancelled.error.code, "user_cancelled");
  assert.equal(calls.runtimeDiagnostics, 0);
  assert.equal(confirmationCalls.length, 1);
  assert.equal(confirmationCalls[0].fields.length, 1);
  assert.match(confirmationCalls[0].fields[0].value, /SSO/u);
  assert.doesNotMatch(JSON.stringify(confirmationCalls[0]), /runtime-host|runtime-user|\/Applications/u);

  options.confirmRendererAction = async (request) => ({ requestId: request.requestId, decision: "confirm" });
  const confirmed = await handleDesktopActionRequest(options, {
    requestId: "runtime-diagnostics-confirm",
    action: "desktop.runtime.diagnostics"
  });
  assert.equal(confirmed.ok, true);
  assert.equal(calls.runtimeDiagnostics, 1);

  options.confirmRendererAction = async () => {
    assert.fail("full_access must not request confirmation");
  };
  const fullAccess = await handleDesktopActionRequest(options, {
    action: "desktop.runtime.diagnostics",
    permissionMode: "full_access"
  });
  assert.equal(fullAccess.ok, true);
  assert.equal(calls.runtimeDiagnostics, 2);

  updateDesktopProfileInRoot(getDesktopConfigRoot(options.app), {
    general: { desktopActionConfirmationEnabled: false }
  });
  const globallyDisabled = await handleDesktopActionRequest(options, {
    action: "desktop.runtime.diagnostics"
  });
  assert.equal(globallyDisabled.ok, true);
  assert.equal(calls.runtimeDiagnostics, 3);
});

test("runtime diagnostics is forbidden to WebApp pages without reading data", async (t) => {
  const { calls, options } = createDesktopActionOptions(t);
  const response = await handleWebappPageActionRequest(options, webappId("runtime-diagnostics"), {
    action: "desktop.runtime.diagnostics",
    permissionMode: "full_access"
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "forbidden");
  assert.equal(calls.runtimeDiagnostics, 0);
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

test("desktop action HTTP and Agent Platform responses share the minimal pet result", async (t) => {
  const { options } = createDesktopActionOptions(t);
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
  const expected = {
    ok: true,
    action: "desktop.pet.state",
    result: {
      supported: true,
      enabled: true,
      appearanceId: "classic"
    }
  };
  assert.deepEqual(response, expected);
  assert.deepEqual(
    await handleAgentPlatformDesktopActionRequest(options, { action: "desktop.pet.state" }),
    expected
  );
});

test("HTTP and Agent Platform receive the same projected P1 web result", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const port = await getFreeLoopbackPort();
  t.after(() => stopDesktopActionBridge());
  options.callRendererAction = async (request) => {
    const state = createWebActionState();
    return {
      requestId: request.requestId,
      action: request.action,
      ok: true,
      result: {
        ...state,
        targetTabId: "tab-1",
        navigatedUrl: "https://example.test/next"
      }
    };
  };
  writeDesktopActionBridgeSettingsConfig(options.app, { schemaVersion: 1, port });
  const server = startDesktopActionBridge(options);
  await waitForListening(server);

  const request = {
    action: "desktop.web.navigate",
    args: { surfaceId: "browser", tabId: "tab-1", url: "https://example.test/next" },
    permissionMode: "full_access"
  };
  const httpResponse = await postJsonUrl(
    `http://${DESKTOP_ACTION_BRIDGE_HOST}:${port}/actions/call`,
    request
  );
  const platformResponse = await handleAgentPlatformDesktopActionRequest(options, request);
  assert.deepEqual(httpResponse, platformResponse);
  assert.equal(JSON.stringify(httpResponse).includes("guestId"), false);
  assert.equal(JSON.stringify(httpResponse).includes("webContentsId"), false);
  assert.deepEqual(Object.keys(httpResponse.result), [
    "surface", "tabs", "activeTab", "targetTabId", "navigatedUrl"
  ]);
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
  assert.deepEqual(missingResponse.error.details, { appearanceId: "user:missing" });
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

  const item = response.result.item;
  assert.deepEqual(response, {
    ok: true,
    action: "desktop.website.add",
    result: { item }
  });
  assert.equal(item.label, "Weather.com");
  assert.equal(item.url, "https://weather.com/");
  assert.equal(typeof item.createdAt, "number");
  assert.equal(typeof item.updatedAt, "number");
});

test("desktop website mutations return only the committed item or identifier", async (t) => {
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
  const addedItem = added.result.item;
  assert.deepEqual(added, {
    ok: true,
    action: "desktop.website.add",
    result: { item: addedItem }
  });
  assert.equal(typeof addedItem.createdAt, "number");
  assert.equal(typeof addedItem.updatedAt, "number");
  assert.equal(addedItem.copilotAgentKey, "webOperator");
  assert.equal("agentKey" in addedItem, false);

  const storedManifest = JSON.parse(fs.readFileSync(
    getWebsitePath(options.app, addedItem.id),
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
  assert.deepEqual(duplicate, {
    ok: false,
    action: "desktop.website.add",
    error: {
      code: "website_add_failed",
      message: duplicate.error.message,
      details: { websiteId: addedItem.id }
    }
  });
  assert.match(duplicate.error.message, /already exists|已经|已存在/u);

  const updated = await handleDesktopActionRequest(options, {
    action: "desktop.website.update",
    permissionMode: "full_access",
    args: {
      websiteId: addedItem.id,
      patch: { label: "中国天气" }
    }
  });
  const updatedItem = updated.result.item;
  assert.deepEqual(updated, {
    ok: true,
    action: "desktop.website.update",
    result: { item: updatedItem }
  });
  assert.equal(updatedItem.label, "中国天气");
  assert.equal(typeof updatedItem.createdAt, "number");
  assert.equal(typeof updatedItem.updatedAt, "number");

  const removed = await handleDesktopActionRequest(options, {
    action: "desktop.website.remove",
    permissionMode: "full_access",
    args: { websiteId: addedItem.id }
  });
  assert.deepEqual(removed, {
    ok: true,
    action: "desktop.website.remove",
    result: { websiteId: addedItem.id }
  });

  for (const [action, args, code] of [
    ["desktop.website.update", { websiteId: addedItem.id, patch: { label: "Missing" } }, "website_update_failed"],
    ["desktop.website.remove", { websiteId: addedItem.id }, "website_remove_failed"]
  ]) {
    const failed = await handleDesktopActionRequest(options, {
      action,
      permissionMode: "full_access",
      args
    });
    assert.deepEqual(failed, {
      ok: false,
      action,
      error: {
        code,
        message: failed.error.message,
        details: { websiteId: addedItem.id }
      }
    });
  }
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

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "website_add_failed");
  assert.match(response.error.message, /url|网站地址/u);
  assert.deepEqual(response, {
    ok: false,
    action: "desktop.website.add",
    error: {
      code: "website_add_failed",
      message: response.error.message,
      details: {
        issues: [{
          field: "url",
          message: response.error.details.issues[0].message,
          expected: "non-empty string",
          received: "missing"
        }]
      }
    }
  });
  assert.match(response.error.details.issues[0].message, /Website address is required|网站地址不能为空/u);
});

test("desktop kanban item actions return exact minimal results", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const issue = { id: "issue-1", title: "Original", status: "todo" };
  const createdIssue = { id: "issue-2", title: "Created", status: "todo" };
  const updatedIssue = { ...issue, title: "Updated" };
  const movedIssue = { ...updatedIssue, status: "doing", position: 2 };
  const snapshot = [{ ...issue }, { id: "issue-secret", title: "Must not leak", status: "done" }];
  options.getKanbanRuntime = () => ({
    listIssues: () => ({ ok: true, message: "snapshot", issues: snapshot, revision: 9 }),
    createIssue: async () => ({ ok: true, message: "created", issue: createdIssue, issues: [...snapshot, createdIssue] }),
    updateIssue: async () => ({ ok: true, message: "updated", issue: updatedIssue, issues: [updatedIssue, snapshot[1]] }),
    deleteIssueWithAutomation: async () => ({ ok: true, message: "deleted", deletedIssueId: issue.id, issues: [snapshot[1]] }),
    moveIssue: async () => ({ ok: true, message: "moved", issue: movedIssue, issues: [movedIssue, snapshot[1]] })
  });

  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.getIssue",
      args: { id: issue.id }
    }),
    {
      ok: true,
      action: "desktop.kanban.getIssue",
      result: { issue }
    }
  );
  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.createIssue",
      permissionMode: "full_access",
      args: { input: { title: createdIssue.title } }
    }),
    {
      ok: true,
      action: "desktop.kanban.createIssue",
      result: { issue: createdIssue }
    }
  );
  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.updateIssue",
      permissionMode: "full_access",
      args: { id: issue.id, input: { title: updatedIssue.title } }
    }),
    {
      ok: true,
      action: "desktop.kanban.updateIssue",
      result: { issue: updatedIssue }
    }
  );
  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.deleteIssue",
      permissionMode: "full_access",
      args: { id: issue.id }
    }),
    {
      ok: true,
      action: "desktop.kanban.deleteIssue",
      result: { deletedIssueId: issue.id }
    }
  );
  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.moveIssue",
      permissionMode: "full_access",
      args: { id: issue.id, status: "doing", position: 2 }
    }),
    {
      ok: true,
      action: "desktop.kanban.moveIssue",
      result: { issue: movedIssue }
    }
  );
});

test("desktop kanban business failures do not expose issue snapshots", async (t) => {
  const { options } = createDesktopActionOptions(t);
  const leakedIssues = [{ id: "issue-secret", title: "Must not leak", status: "done" }];
  options.getKanbanRuntime = () => ({
    listIssues: () => ({ ok: true, message: "snapshot", issues: leakedIssues }),
    createIssue: async () => ({ ok: false, message: "create rejected", issues: leakedIssues }),
    updateIssue: async () => ({ ok: false, message: "update rejected", issues: leakedIssues }),
    deleteIssueWithAutomation: async () => ({ ok: false, message: "delete rejected", issues: leakedIssues }),
    moveIssue: async () => ({ ok: false, message: "move rejected", issues: leakedIssues })
  });

  assert.deepEqual(
    await handleDesktopActionRequest(options, {
      action: "desktop.kanban.getIssue",
      args: { id: "issue-missing" }
    }),
    {
      ok: false,
      action: "desktop.kanban.getIssue",
      error: {
        code: "not_found",
        message: "Kanban issue not found: issue-missing",
        details: { issueId: "issue-missing" }
      }
    }
  );

  for (const [action, args, code, message, details] of [
    ["desktop.kanban.createIssue", { input: { title: "Rejected" } }, "kanban_create_failed", "create rejected", undefined],
    ["desktop.kanban.updateIssue", { id: "issue-1", input: { title: "Rejected" } }, "kanban_update_failed", "update rejected", { issueId: "issue-1" }],
    ["desktop.kanban.deleteIssue", { id: "issue-1" }, "kanban_delete_failed", "delete rejected", { issueId: "issue-1" }],
    ["desktop.kanban.moveIssue", { id: "issue-1", status: "doing", position: 1 }, "kanban_move_failed", "move rejected", { issueId: "issue-1" }]
  ]) {
    const expectedError = { code, message, ...(details ? { details } : {}) };
    assert.deepEqual(
      await handleDesktopActionRequest(options, {
        action,
        permissionMode: "full_access",
        args
      }),
      { ok: false, action, error: expectedError }
    );
  }
});

test("desktop kanban rejects incomplete successful domain results", async (t) => {
  const { options } = createDesktopActionOptions(t);
  options.getKanbanRuntime = () => ({
    listIssues: () => ({ ok: true, message: "snapshot", issues: [] }),
    createIssue: async () => ({ ok: true, message: "created", issues: [] }),
    updateIssue: async () => ({ ok: true, message: "updated", issues: [] }),
    deleteIssueWithAutomation: async () => ({ ok: true, message: "deleted", issues: [] }),
    moveIssue: async () => ({ ok: true, message: "moved", issues: [] })
  });

  for (const [action, args] of [
    ["desktop.kanban.createIssue", { input: { title: "Incomplete" } }],
    ["desktop.kanban.updateIssue", { id: "issue-1", input: { title: "Incomplete" } }],
    ["desktop.kanban.deleteIssue", { id: "issue-1" }],
    ["desktop.kanban.moveIssue", { id: "issue-1", status: "doing", position: 1 }]
  ]) {
    const response = await handleDesktopActionRequest(options, {
      action,
      permissionMode: "full_access",
      args
    });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, "invalid_action_result", action);
    assert.equal("details" in response.error, false, action);
  }
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

test("desktop action confirmation detail preserves Team run identity", () => {
  const detail = __testInternals.buildDesktopActionConfirmationDetail({
    requestId: "request-team",
    action: "desktop.theme.set",
    source: {
      runId: "run-team",
      chatId: "chat-team",
      teamId: "research"
    }
  }, {
    themeMode: "dark"
  });

  assert.match(detail, /runId=run-team/u);
  assert.match(detail, /chatId=chat-team/u);
  assert.match(detail, /agentKey=-/u);
  assert.match(detail, /teamId=research/u);
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
