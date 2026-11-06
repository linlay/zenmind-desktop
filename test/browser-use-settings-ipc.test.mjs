import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { BrowserUseRuntime } = require("../dist-electron/main/modules/browser-use/runtime.js");
const Module = require("node:module");
const ipcPath = path.resolve(import.meta.dirname, "../src/main/modules/browser-use/ipc.ts");
const ipcModule = new Module(ipcPath);
ipcModule.filename = ipcPath;
ipcModule.paths = Module._nodeModulePaths(path.dirname(ipcPath));
ipcModule.require = name => name === "./runtime" ? { BrowserUseRuntime,
  browserUseError: require("../dist-electron/main/modules/browser-use/runtime.js").browserUseError }
  : name === "../../../shared/browser-use" ? require("../dist-electron/shared/browser-use.js") : require(name);
ipcModule._compile(ts.transpileModule(fs.readFileSync(ipcPath, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText, ipcPath);
const { registerBrowserUseIpc } = ipcModule.exports;

function fixture() {
  const handlers = new Map(), calls = [], events = [];
  let preferences = { defaultBackend: "workpanel", rememberChromeConnection: false, hasSavedAuthorization: false, secureStorageAvailable: true };
  let broken = false, lastKnownAvailability = false, updateGate, activeChatId;
  const store = {
    readSnapshot() {
      if (broken) throw Object.assign(new Error("Browser settings could not be read or saved."), { code: "browser_settings_unavailable" });
      return { ...preferences, secureStorageAvailable: lastKnownAvailability };
    },
    async read() {
      return this.readSnapshot();
    },
    async update(value) {
      assert.equal("action" in value, false);
      calls.push({ method: "update", keys: Object.keys(value) });
      await updateGate?.promise;
      preferences = { ...preferences, defaultBackend: value.defaultBackend, rememberChromeConnection: value.rememberChromeConnection,
        hasSavedAuthorization: value.rememberChromeConnection && Boolean(value.extensionToken || preferences.hasSavedAuthorization) };
      return this.readSnapshot();
    },
    async forget() { calls.push({ method: "forget" }); broken = false; preferences = { ...preferences, rememberChromeConnection: false, hasSavedAuthorization: false }; return this.readSnapshot(); },
    async authorization() { calls.push({ method: "authorization" }); return undefined; },
  };
  const runtime = new BrowserUseRuntime({ preferences: { read: () => store.readSnapshot(), authorization: () => store.authorization() },
    onSettingsChanged: value => events.push(value), createClient() { throw new Error("settings must not start Chrome"); } });
  const frame = {}, contents = { mainFrame: frame };
  const valid = { sender: contents, senderFrame: frame };
  registerBrowserUseIpc({ ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }, runtime, settingsStore: store,
    getMainWindow: () => ({ webContents: contents, isDestroyed: () => false }), getActiveChatId: () => activeChatId,
    openBundledExtension: async () => calls.push({ method: "bundled-extension" }), onSettingsChanged: value => events.push(value) });
  return { runtime, store, calls, events, valid, contents, frame, breakStore: () => { broken = true; },
    holdUpdate: gate => { updateGate = gate; }, activeChat: value => { activeChatId = value; },
    settings: (request, event = valid) => handlers.get("browserUse.settings")(event, request),
    control: request => handlers.get("browserUse.control")(valid, request) };
}

test("browser settings are available without a Chat only to the trusted Main top frame", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  assert.equal((await f.settings({ action: "get" }, { sender: {}, senderFrame: f.frame })).error.code, "forbidden");
  assert.equal((await f.settings({ action: "get" }, { sender: f.contents, senderFrame: {} })).error.code, "forbidden");
  assert.equal((await f.settings({ action: "get" })).ok, true);
  assert.equal((await f.control({ action: "state", chatId: "unowned-chat" })).error.code, "chat_changed");
  assert.equal(f.calls.length, 0);
});

test("opening settings reads metadata without initializing crypto or a browser", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  for (let i = 0; i < 3; i++) assert.equal((await f.settings({ action: "get" })).ok, true);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
  assert.equal(f.calls.length, 0);
});

test("settings save waits for native asynchronous persistence before reporting success", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  let resolve; const gate = { promise: new Promise(yes => { resolve = yes; }) };
  f.holdUpdate(gate);
  const pending = f.settings({ action: "save", defaultBackend: "chrome", rememberChromeConnection: true, extensionToken: "SYNTHETIC_async_authorization_123" });
  await new Promise(done => setImmediate(done));
  assert.equal(f.runtime.settingsState().hasSavedAuthorization, false);
  resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.state.hasSavedAuthorization, true);
});

test("settings queries return current Run counts without probing system storage", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  f.runtime.prepareRun({ chatId: "chat-a", runId: "run-a", agentKey: "cutej" });
  const opened = await f.settings({ action: "get" });
  assert.equal(opened.state.activeRuns, 1);
  assert.equal(opened.state.secureStorageAvailable, false);
  f.runtime.releaseRun("run-a");
  assert.equal((await f.settings({ action: "get" })).state.activeRuns, 0);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
});

test("settings write credentials once, never return them, and reject unrecognized fields", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const token = "SYNTHETIC_ipc_authorization_only_123";
  const saved = await f.settings({ action: "save", defaultBackend: "chrome", rememberChromeConnection: true, extensionToken: token });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.hasSavedAuthorization, true);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(f.events).includes(token), false);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
  assert.equal(f.calls.filter(call => call.method === "update").length, 1);
  assert.equal((await f.settings({ action: "get", extensionToken: token })).error.code, "invalid_browser_settings");
  assert.equal((await f.settings({ action: "save", defaultBackend: "chrome", rememberChromeConnection: true, endpoint: "http://untrusted.test" })).error.code, "invalid_browser_settings");
});

test("forget rejects an active Run before changing stored authorization", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  f.runtime.registerRun({ chatId: "chat-a", runId: "run-a", agentKey: "cutej" });
  const refused = await f.settings({ action: "forget" });
  assert.equal(refused.ok, false); assert.equal(refused.error.code, "browser_busy");
  assert.equal(f.calls.some(call => call.method === "forget"), false);
});

test("forget can recover corrupt settings without decrypting them or starting a browser", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  f.breakStore();
  assert.equal((await f.settings({ action: "get" })).error.code, "browser_settings_unavailable");
  const result = await f.settings({ action: "forget" });
  assert.equal(result.ok, true); assert.equal(result.state.hasSavedAuthorization, false);
  assert.equal(f.calls.filter(call => call.method === "forget").length, 1);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
});

test("forget recovers corrupt settings without probing system storage", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  f.breakStore();
  assert.equal((await f.settings({ action: "get" })).error.code, "browser_settings_unavailable");
  const recovered = await f.settings({ action: "forget" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.rememberChromeConnection, false);
  assert.equal(recovered.state.hasSavedAuthorization, false);
  assert.equal(f.calls.filter(call => call.method === "forget").length, 1);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
});

test("offline extension setup works without a Chat and rejects caller-supplied paths", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  assert.equal((await f.settings({ action: "install-extension" })).ok, true);
  assert.deepEqual(f.calls, [{ method: "bundled-extension" }]);
  assert.equal((await f.settings({ action: "install-extension", path: "/tmp/arbitrary" })).ok, false);
  assert.equal(f.calls.length, 1);
});
