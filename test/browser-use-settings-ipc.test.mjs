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
  let broken = false, probeFails = false, probeCalls = 0, lastKnownAvailability = false, probeGate, updateGate, activeChatId;
  const store = {
    readSnapshot() {
      if (broken) throw Object.assign(new Error("Browser settings could not be read or saved."), { code: "browser_settings_unavailable" });
      return { ...preferences, secureStorageAvailable: lastKnownAvailability };
    },
    async read() {
      this.readSnapshot();
      probeCalls++;
      await probeGate?.promise;
      if (probeFails) { lastKnownAvailability = false; throw new Error("System storage probe failed."); }
      lastKnownAvailability = preferences.secureStorageAvailable;
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
    openExternal: async url => calls.push({ method: "external", url }), onSettingsChanged: value => events.push(value) });
  return { runtime, store, calls, events, valid, contents, frame, breakStore: () => { broken = true; },
    probes: () => probeCalls, availability: value => { preferences.secureStorageAvailable = value; },
    failProbe: value => { probeFails = value; },
    holdProbe: gate => { probeGate = gate; }, holdUpdate: gate => { updateGate = gate; }, activeChat: value => { activeChatId = value; },
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

test("an asynchronous storage probe keeps metadata controls responsive and returns current Run counts", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  let resolve; const gate = { promise: new Promise(yes => { resolve = yes; }) };
  f.holdProbe(gate); f.activeChat("chat-a");
  const pending = f.settings({ action: "get" });
  await new Promise(done => setImmediate(done));
  assert.equal((await f.control({ action: "state", chatId: "chat-a" })).ok, true);
  assert.equal(f.probes(), 1);
  f.runtime.prepareRun({ chatId: "chat-a", runId: "new-run", agentKey: "cutej" });
  resolve();
  assert.equal((await pending).state.activeRuns, 1);
  assert.equal(f.calls.some(call => call.method === "authorization"), false);
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

test("trusted settings queries return freshly probed availability while Run status broadcasts remain metadata-only", async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  assert.equal(f.runtime.state("chat-a").backend, "workpanel");
  f.runtime.prepareRun({ chatId: "chat-a", runId: "run-a", agentKey: "cutej" });
  f.runtime.registerRun({ chatId: "chat-a", runId: "run-a", agentKey: "cutej" });
  assert.equal(f.runtime.settingsState().secureStorageAvailable, false);
  assert.equal(f.probes(), 0);

  const opened = await f.settings({ action: "get" });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.secureStorageAvailable, true, "IPC must not return the unprobed runtime snapshot");
  assert.equal(opened.state.activeRuns, 1);
  assert.equal(f.probes(), 1);
  f.runtime.releaseRun("run-a");
  assert.equal(f.events.at(-1).secureStorageAvailable, true);
  assert.equal(f.probes(), 1);

  f.availability(false);
  const refreshed = await f.settings({ action: "get" });
  assert.equal(refreshed.state.secureStorageAvailable, false);
  assert.equal(refreshed.state.activeRuns, 0);
  assert.equal(f.probes(), 2);
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

test("forget after a corrupt initial query refreshes current-page storage status without turning a probe failure into a recovery failure", async t => {
  for (const probeFails of [false, true]) {
    const f = fixture(); t.after(() => f.runtime.dispose());
    f.breakStore();
    assert.equal((await f.settings({ action: "get" })).error.code, "browser_settings_unavailable");
    assert.equal(f.probes(), 0, "a corrupt initial query fails before probing system storage");
    f.failProbe(probeFails);
    const recovered = await f.settings({ action: "forget" });
    assert.equal(recovered.ok, true, "forget remains successful even if its follow-up status refresh fails");
    assert.equal(recovered.state.rememberChromeConnection, false);
    assert.equal(recovered.state.hasSavedAuthorization, false);
    assert.equal(recovered.state.secureStorageAvailable, !probeFails, "the page can immediately save replacement authorization when storage is available");
    assert.equal(f.events.at(-1).secureStorageAvailable, !probeFails);
    assert.equal(f.probes(), 1);
    assert.equal(f.calls.filter(call => call.method === "forget").length, 1);
    assert.equal(f.calls.some(call => call.method === "authorization"), false);
  }
});
