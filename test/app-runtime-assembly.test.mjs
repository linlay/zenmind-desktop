import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Execute emitted production units with explicit host/module ports, without booting Electron.
function loadUnit(unit, mocks = {}) {
  const filename = path.resolve(`dist-electron/main/app/${unit}.js`);
  const module = { exports: {} };
  const require = (id) => mocks[id] ?? {};
  new Function("require", "module", "exports", fs.readFileSync(filename, "utf8"))(require, module, module.exports);
  return module.exports;
}

test("service assembly defers cyclic wiring reads and uses the current token refresher", async () => {
  const calls = [];
  const { assembleServicesIntegration } = loadUnit("assembly/services", {
    "../../modules/agent-platform": {
      getProviderRegisterMode: () => "grant",
      ensureProviderRegisterApiKey: async (_app, options) => options.refreshAccessToken()
    },
    "../../modules/identity": { isDesktopSsoCredentialRuntimeReady: () => true, getDesktopSsoAccessToken: () => "token" },
    "../../modules/plugins": { stopPluginResources: (_app, _service, manager) => calls.push(manager) }
  });
  // These getters deliberately reference declarations still in their temporal dead zone.
  const ports = assembleServicesIntegration({
    issueAgentAccessToken: () => "local-token",
    get servicesFacade() { return services; },
    get websFacade() { return webs; },
    get refreshDesktopSsoIdentityToken() { return refresh; },
    get startupRestoreController() { return restore; }
  });
  const services = {};
  let webs = { webappManager: "first" };
  const restore = {};
  let refresh = async () => "first-token";
  assert.equal(await ports.ensureProviderRegisterApiKey({}), "first-token");
  await ports.stopPluginResources({}, {});
  webs = { webappManager: "replacement" };
  refresh = async () => "renewed-token";
  assert.equal(await ports.ensureProviderRegisterApiKey({}), "renewed-token");
  await ports.stopPluginResources({}, {});
  assert.deepEqual(calls, ["first", "replacement"]);
});

test("navigation notifications retain taskbar, tray, renderer and visible pet ordering", () => {
  const { emitAssistantNavigationAgentsChanged } = loadUnit("runtime-notifications");
  const events = [];
  const snapshot = { chatItems: [] };
  let visible = true;
  const dependencies = {
    appShellRuntime: {
      refreshTaskbarUnread: (value) => { assert.equal(value, snapshot); events.push("taskbar"); },
      refreshTrayContextMenu: () => events.push("tray")
    },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: {
      send: (channel, value) => { assert.equal(channel, "assistant.navigationAgentsChanged"); assert.equal(value, snapshot); events.push("renderer"); }
    } }),
    petRuntime: { isVisible: () => visible },
    refreshDesktopPetState: () => events.push("pet")
  };
  emitAssistantNavigationAgentsChanged(dependencies, snapshot);
  assert.deepEqual(events, ["taskbar", "tray", "renderer", "pet"]);
  events.length = 0;
  visible = false;
  emitAssistantNavigationAgentsChanged(dependencies, snapshot);
  assert.deepEqual(events, ["taskbar", "tray", "renderer"]);
});

for (const platform of ["darwin", "win32"]) for (const updateFailure of ["none", "registration", "check", "pending"]) {
  test(`${platform}: startup continues independently of updates (${updateFailure})`, async () => {
    const events = [];
    const listeners = new Map();
    const state = { startupPhase: "booting" };
    let finishEnvironment;
    const environment = new Promise(resolve => { finishEnvironment = resolve; });
    let finishPipeline;
    const pipeline = new Promise(resolve => { finishPipeline = resolve; });
    let updatesLookup;
    let updateOptions;
    const updates = { mainReady: () => {
      events.push("updates-ready");
      if (updateFailure === "check") return Promise.reject(new Error("update failed"));
      if (updateFailure === "pending") return new Promise(() => {});
    } };
    const share = { start: () => events.push("share"), dispose: () => events.push("share-dispose") };
    const protocol = name => (_app, _protocol, _net, ...args) => { assert.equal(args.at(-1), platform); events.push(name); };
    const { handleAppReady } = loadUnit("lifecycle/app-ready", {
      electron: { app: { once: (name, callback) => listeners.set(name, callback), exit: () => assert.fail("unexpected exit") } },
      "../../modules/pet": { registerDesktopPetAssetProtocol: protocol("pet-protocol") },
      "../../modules/webs": { registerWebsiteFaviconProtocol: protocol("website-protocol") },
      "../../modules/identity": { registerDesktopSsoAvatarProtocol: protocol("avatar-protocol") },
      "../../modules/plugins": { configurePluginResources: () => events.push("plugin-resources") },
      "../../modules/conversation-share": { createConversationShareFacade: () => share },
      "../../modules/updates": { registerDesktopUpdates: options => {
        events.push("updates-register"); updateOptions = options;
        if (updateFailure === "registration") throw new Error("updates unavailable");
        return updates;
      } },
      "../performance-diagnostics": { startPerformanceDiagnostics: () => events.push("diagnostics") }
    });
    const ready = handleAppReady({
      startupPlatform: platform,
      appState: state,
      setStartupPhase: phase => { state.startupPhase = phase; events.push(phase); },
      systemIdentityRuntime: { ensureDockIdentity: () => events.push("identity") },
      startupEnvironmentRuntime: {
        handleStartupEnvRootConflict: async () => true,
        prepareStartupRuntimeEnvironment: () => environment
      },
      initializeUserDataRootsAndSettings: () => { events.push("roots"); return { failedPaths: [] }; },
      logsRuntime: { installConsoleTee: () => events.push("logs") },
      webSurfaceRuntime: { browserSurfaceRegistry: {} },
      desktopSsoController: { restoreDesktopSsoSession: async () => { events.push("sso"); return { state: "signed_out" }; } },
      applyDesktopSsoRestoreResult: result => { assert.equal(result.state, "signed_out"); events.push("sso-applied"); },
      pluginBridgeRuntime: { configure: () => events.push("plugin-bridge") },
      assistantBridgeRuntime: { start: () => events.push("assistant"), assistantBridge: {} },
      registerIpc: (facade, getUpdatesRuntime) => {
        assert.equal(facade, share);
        assert.equal(getUpdatesRuntime(), undefined);
        updatesLookup = getUpdatesRuntime;
        events.push("ipc");
      },
      configureAppMediaPermissions: () => events.push("permissions"),
      registerFocusedWebviewDevToolsShortcut: () => events.push("shortcut"),
      createWindow: () => events.push("window"),
      desktopAppInfo: { version: "1.0.0" },
      getMainWindow: () => null,
      startResourceDirectoryWatcher: () => events.push("watcher"),
      startupPipeline: { run: () => { events.push("pipeline"); return pipeline; } }
    });
    await Promise.resolve();
    assert.deepEqual(events, ["platform-preflight", "identity", "runtime-env"]);
    finishEnvironment({ ok: true });
    await ready;
    assert.deepEqual(events, ["platform-preflight", "identity", "runtime-env", "runtime-env-ready", "roots", "pet-protocol", "website-protocol", "avatar-protocol", "desktop-state-ready", "logs", "diagnostics", "sso", "sso-applied", "plugin-bridge", "plugin-resources", "assistant", "share", "ipc", "permissions", "shortcut", "window", "updates-register", "shell-ready", "watcher", "pipeline"]);
    assert.equal(updatesLookup(), updateFailure === "registration" ? undefined : updates);
    assert.equal(updateOptions.currentVersion, "1.0.0");
    state.startupPhase = "non-core-ready";
    finishPipeline();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.at(-1), updateFailure === "registration" ? "pipeline" : "updates-ready");
    listeners.get("will-quit")();
    assert.equal(events.at(-1), "share-dispose");
  });
}

test("ready IPC recovery signals the current update runtime before non-core startup", () => {
  let handlers;
  let updates;
  const events = [];
  const { registerReadyIpc } = loadUnit("assembly/ready-ipc", {
    "../module-registry": { registerMainIpcHandlers: options => { handlers = options; } }
  });
  registerReadyIpc({
    webSurfaceRuntime: {}, appShellRuntime: {}, servicesRuntime: {}, settingsRuntime: {},
    setStartupPhase: phase => events.push(phase),
    startNonCoreDesktopRuntime: () => events.push("non-core")
  }, {}, () => updates);
  updates = { mainReady: () => events.push("ready") };
  handlers.onStartupPreparationSucceeded();
  assert.deepEqual(events, ["core-ready", "ready", "non-core"]);
});

for (const failure of ['throw', 'reject']) test(`ready IPC continues non-core startup when updates ${failure}`, async () => {
  let handlers;
  const events = [];
  const { registerReadyIpc } = loadUnit('assembly/ready-ipc', {
    '../module-registry': { registerMainIpcHandlers: options => { handlers = options; } }
  });
  registerReadyIpc({
    webSurfaceRuntime: {}, appShellRuntime: {}, servicesRuntime: {}, settingsRuntime: {},
    setStartupPhase: phase => events.push(phase),
    startNonCoreDesktopRuntime: () => events.push('non-core')
  }, {}, () => ({ mainReady() {
    if (failure === 'throw') throw new Error('update notification failed');
    return Promise.reject(new Error('update request failed'));
  } }));
  assert.doesNotThrow(() => handlers.onStartupPreparationSucceeded());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['core-ready', 'non-core']);
});
