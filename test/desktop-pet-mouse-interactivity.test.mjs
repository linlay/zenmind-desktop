import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

function loadPetModule(name, overrides = {}) {
  const file = new URL(`../dist-electron/main/modules/pet/${name}.js`, import.meta.url);
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const require = (id) => Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id);
  const evaluate = vm.runInNewContext(
    `(function(require, module, exports) { ${fs.readFileSync(file, "utf8")}\n})`,
    { console, process, setTimeout, clearTimeout, setInterval, clearInterval }
  );
  evaluate(require, module, module.exports);
  return module.exports;
}

function createIpcHarness() {
  const handlers = new Map();
  const calls = [];
  const pet = { webContents: {}, destroyed: false, isDestroyed() { return this.destroyed; } };
  const panel = { webContents: {}, destroyed: false, isDestroyed() { return this.destroyed; } };
  const { registerDesktopPetIpcHandlers } = loadPetModule("ipc", {
    "./import-ipc": { registerPetImportIpcHandlers() {} }
  });
  registerDesktopPetIpcHandlers({ handle: (name, handler) => handlers.set(name, handler) }, {
    getWindow: () => pet,
    getPanelWindow: () => panel,
    setMouseInteractive: (...args) => { calls.push(args); return { ok: true }; }
  });
  return { pet, panel, calls, setMouseInteractive: handlers.get("desktopPet.setMouseInteractive") };
}

test("mouse interactivity IPC routes only to the requesting pet or panel window", async () => {
  const harness = createIpcHarness();
  for (const [window, target] of [[harness.pet, "pet"], [harness.panel, "panel"]]) {
    for (const interactive of [false, true]) {
      assert.equal((await harness.setMouseInteractive({ sender: window.webContents }, interactive)).ok, true);
      assert.deepEqual(harness.calls.at(-1), [interactive, target]);
    }
  }
  assert.equal(harness.calls.length, 4);
});

test("mouse interactivity IPC rejects unrelated senders, destroyed windows and non-booleans", async () => {
  const harness = createIpcHarness();
  for (const interactive of [false, true]) {
    assert.equal((await harness.setMouseInteractive({ sender: {} }, interactive)).ok, false);
  }
  for (const window of [harness.pet, harness.panel]) {
    for (const interactive of [undefined, null, 0, 1, "false", "true", {}, []]) {
      assert.equal((await harness.setMouseInteractive({ sender: window.webContents }, interactive)).ok, false);
    }
    window.destroyed = true;
    assert.equal((await harness.setMouseInteractive({ sender: window.webContents }, true)).ok, false);
    assert.equal((await harness.setMouseInteractive({ sender: window.webContents }, false)).ok, false);
  }
  assert.deepEqual(harness.calls, []);
});

test("application IPC assembly preserves the pet interactivity target", () => {
  let petOptions;
  const calls = [];
  const { registerConnectedRuntimeIpc } = loadPetModule("../../app/ipc-connected-runtimes", {
    "../modules/identity": { registerSsoIpcHandlers() {} },
    "../modules/desktop-actions": {},
    "../infrastructure/filesystem/user-paths": {},
    "../support/i18n/main-i18n": {},
    "../../shared/i18n": {},
    "../modules/tunnel": { registerTunnelHubIpcHandlers() {} },
    "../modules/pet": { registerDesktopPetIpcHandlers: (_ipc, options) => { petOptions = options; } },
    "../modules/settings": { registerAppearanceIpcHandlers() {}, registerSettingsIpcHandlers() {} },
    "../modules/kanban": { registerKanbanIpcHandlers() {} },
    "../modules/webs": { registerWebIpcHandlers() {} },
    "../modules/enterprise-chat": { registerEnterpriseChatIpcHandlers() {} }
  });
  registerConnectedRuntimeIpc({
    assistantBridgeRuntime: {},
    petRuntime: { setMouseInteractive: (...args) => { calls.push(args); return { ok: true }; } }
  });
  assert.ok(petOptions);
  assert.equal(petOptions.setMouseInteractive(false, "panel").ok, true);
  assert.equal(petOptions.setMouseInteractive(true, "pet").ok, true);
  assert.deepEqual(calls, [[false, "panel"], [true, "pet"]]);
});

function createRuntimeHarness(platform, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-mouse-interactivity-"));
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false;
      this.visible = false;
      this.mouseCalls = [];
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setAlwaysOnTop() {}
    moveTop() {}
    setIgnoreMouseEvents(ignore, options) { this.mouseCalls.push([ignore, { ...options }]); }
    showInactive() { this.visible = true; this.emit("show"); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
  }
  const windowModule = loadPetModule("window", { electron: { BrowserWindow: FakeWindow } });
  const { createDesktopPetRuntime } = loadPetModule("runtime", { "./window": windowModule });
  const display = {
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 900 }
  };
  const runtime = createDesktopPetRuntime({
    app: { getPath: (name) => path.join(root, name), getAppPath: () => root },
    platform,
    getMainWindow: () => null,
    isHandlingQuit: () => false,
    getNavigationSnapshot: () => ({ ok: true, items: [], chatItems: [] }),
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getPrimaryDisplay: () => display,
      getDisplayMatching: () => display
    },
    preloadPath: "",
    loadRendererRoute: async () => {},
    showMainWindow: () => {},
    openAssistantWorker: async () => {},
    publishPluginAssistantActiveTasks: () => {},
    refreshTrayContextMenu: () => {}
  });
  t.after(() => {
    runtime.hideWindow();
    runtime.clearIdleResetTimer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  runtime.initializeState(false);
  runtime.showWindow();
  runtime.setWindowMode("bubble");
  return runtime;
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} pet and panel switch click-through independently and new panels start transparent`, (t) => {
    const runtime = createRuntimeHarness(platform, t);
    const pet = runtime.getWindow();
    const panel = runtime.getPanelWindow();
    assert.ok(pet && panel);
    assert.equal(panel.options.focusable, true, "reply input must keep keyboard and IME support");
    assert.deepEqual(pet.mouseCalls, [[true, { forward: true }]]);
    assert.deepEqual(panel.mouseCalls, [[true, { forward: true }]], "the initial transparent host must pass clicks through");

    assert.equal(runtime.setMouseInteractive(true, "panel").ok, true);
    assert.deepEqual(panel.mouseCalls.at(-1), [false, { forward: true }]);
    assert.equal(pet.mouseCalls.length, 1, "panel hover must not activate the character host");
    assert.equal(runtime.setMouseInteractive(true).ok, true);
    assert.deepEqual(pet.mouseCalls.at(-1), [false, { forward: true }]);
    assert.equal(panel.mouseCalls.length, 2);

    runtime.setMouseInteractive(false, "pet");
    runtime.setMouseInteractive(false, "pet");
    assert.equal(pet.mouseCalls.length, 3, "repeat requests for the same state are harmless");
    assert.deepEqual(pet.mouseCalls.at(-1), [true, { forward: true }]);
    assert.deepEqual(panel.mouseCalls.at(-1), [false, { forward: true }], "leaving the character must not disable the panel");
    runtime.setMouseInteractive(false, "panel");
    assert.deepEqual(panel.mouseCalls.at(-1), [true, { forward: true }]);
    assert.equal(pet.mouseCalls.length, 3);

    runtime.setMouseInteractive(true, "panel");
    const retiredPanelCallCount = panel.mouseCalls.length;
    runtime.setWindowMode("base");
    assert.equal(panel.isDestroyed(), true);
    assert.equal(runtime.getPanelWindow(), null);
    assert.equal(runtime.setMouseInteractive(false, "panel").ok, false);
    assert.equal(pet.mouseCalls.length, 3, "a missing panel must not redirect to the character");

    runtime.setWindowMode("bubble");
    const reopenedPanel = runtime.getPanelWindow();
    assert.ok(reopenedPanel && reopenedPanel !== panel);
    assert.deepEqual(reopenedPanel.mouseCalls, [[true, { forward: true }]], "reopening must not inherit the retired panel's interactive state");
    runtime.setMouseInteractive(true, "panel");
    assert.deepEqual(reopenedPanel.mouseCalls.at(-1), [false, { forward: true }]);
    assert.equal(panel.mouseCalls.length, retiredPanelCallCount, "retired windows must not receive further mouse changes");
    assert.equal(pet.mouseCalls.length, 3);
  });
}
