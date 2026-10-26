import { registerBrowserTask } from "./helpers/browser-use-task.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Module = require("node:module");
const runtimeSourcePath = path.resolve(import.meta.dirname, "../src/main/modules/browser-use/runtime.ts");
const runtimeModule = new Module(runtimeSourcePath);
runtimeModule.filename = runtimeSourcePath; runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimeSourcePath));
const runtimeBundle = require("esbuild").buildSync({ stdin: { contents:
  `export {BrowserUseRuntime} from ${JSON.stringify(runtimeSourcePath)}; export {ChromeWorkerEngine} from ${JSON.stringify(path.join(path.dirname(runtimeSourcePath), "chrome-worker-engine.ts"))};`,
  resolveDir: path.dirname(runtimeSourcePath) }, bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" });
runtimeModule._compile(runtimeBundle.outputFiles[0].text, runtimeSourcePath);
const { BrowserUseRuntime, ChromeWorkerEngine } = runtimeModule.exports;
const token = "DUMMY_authorization_for_unit_tests";
const source = (chatId = "chat-a", runId = "run-a") => ({ chatId, runId, agentKey: "cutej" });
const flush = () => new Promise(resolve => setImmediate(resolve));
const neverFallback = async () => { throw new Error("A Chrome task cannot fall back to WorkPanel"); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(options = {}) {
  const clients = [], changes = [], settings = [];
  const preferences = { defaultBackend: "chrome", rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true, ...options.preferences };
  const runtime = new BrowserUseRuntime({
    preferences: { read: options.read ?? (() => ({ ...preferences })), authorization: options.authorization ?? (() => token) },
    onChanged: state => changes.push(state), onSettingsChanged: options.onSettingsChanged ?? (state => settings.push(state)),
    createClient(onExit) {
      const index = clients.length;
      const client = {
        calls: [], killed: false, disconnected: false, onExit,
        pages: [{ pageId: `private-${index}`, url: `https://fixture.test/${index}`, title: `Chat ${index}`, active: true }],
        async request(method, params, pageId, signal) {
          this.calls.push({ method, params, pageId, signal });
          if (method === "connect") { await options.connect?.(client, index); return { connected: true, pages: this.pages }; }
          if (method === "list") return this.pages;
          if (method === "state") return options.health ? options.health(client, index) : { connected: !client.engineClosed, pages: this.pages };
          if (method === "open") { const page = { pageId: `opened-${index}`, url: params.url, title: "Opened" }; this.pages.push(page); return page; }
          if (method === "observe") return { observationId: `obs-${index}`, text: "Fixture", elements: [] };
          return { status: "done" };
        },
        async disconnect() { this.disconnected = true; }, kill() { this.killed = true; },
      };
      clients.push(client); return client;
    },
  });
  const cdp = (method, params = {}, identity = source(), surfaceId, signal) => runtime.cdp({ method, params, source: identity, surfaceId }, signal, neverFallback);
  return { runtime, clients, preferences, changes, settings, cdp };
}

test("new Chats inherit defaults, and copied Chrome IDs do not request connection for a WorkPanel task", async t => {
  const h = harness({ preferences: { defaultBackend: "workpanel" } }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source());
  h.preferences.defaultBackend = "chrome";
  assert.equal(h.runtime.state("chat-a").backend, "workpanel");
  assert.equal(h.runtime.state("chat-b").backend, "chrome");
  await assert.rejects(h.cdp("Surface.openChrome", { url: "https://fixture.test" }), { code: "browser_backend_mismatch" });
  await assert.rejects(h.cdp("Surface.observe", {}, source(), "chrome:copied"), { code: "browser_backend_mismatch" });
  assert.equal(h.clients.length, 0);
  assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
});

test("only a validated live Run may select Chrome; WorkPanel mismatch never raises Chrome authorization", async t => {
  const h = harness({ preferences: { defaultBackend: "workpanel" } }); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); h.runtime.select("chat-a", "workpanel"); await registerBrowserTask(h.runtime, source());
  await assert.rejects(h.cdp("Browser.select", { browser: "chrome" }, source("wrong-chat")), { code: "browser_run_unavailable" });
  await assert.rejects(h.cdp("Surface.observe", {}, source(), "chrome:copied"), { code: "browser_backend_mismatch" });
  assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
  await h.cdp("Browser.select", { browser: "chrome" });
  assert.equal(h.runtime.state("chat-a").backend, "chrome");
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].calls.some(call => call.method === "open"), false);
});

test("remembered authorization connects lazily on the first Chrome action, never at Chat creation", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  h.runtime.state("chat-a"); await registerBrowserTask(h.runtime, source()); assert.equal(h.clients.length, 0);
  const result = await h.cdp("Surface.openChrome", { url: "https://fixture.test/new" });
  assert.equal(h.clients.length, 1); assert.equal(result.result.provider, "chrome");
  assert.equal(h.clients[0].calls.find(call => call.method === "connect").params.extensionToken, token);
  assert.equal(JSON.stringify([result, h.changes, h.settings]).includes(token), false);
  assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
});

test("disabled remembering or missing authorization prompts once without constructing a Worker", async t => {
  for (const options of [{ preferences: { rememberChromeConnection: false } }, { authorization: () => undefined }]) {
    const h = harness(options); t.after(() => h.runtime.dispose()); await registerBrowserTask(h.runtime, source());
    await assert.rejects(h.cdp("Surface.list"), { code: "browser_connection_required" });
    await assert.rejects(h.cdp("Surface.list"), { code: "browser_connection_required" });
    assert.equal(h.clients.length, 0); assert.equal(h.changes.filter(state => state.connectionRequest).length, 1);
  }
  const oldRuntime = new BrowserUseRuntime({ createClient: () => { throw new Error("must not create"); } });
  t.after(() => oldRuntime.dispose());
  assert.equal(oldRuntime.state("chat-a").backend, "workpanel");
});

test("concurrent first calls from the same Run reuse one in-flight private connection", async t => {
  const gate = deferred(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source());
  const first = h.cdp("Surface.list"), second = h.cdp("Surface.getCurrent"); await flush();
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0].calls.filter(call => call.method === "connect").length, 1);
  gate.resolve(); await Promise.all([first, second]);
  await registerBrowserTask(h.runtime, source("chat-a", "other-run"));
  await assert.rejects(h.cdp("Surface.list", {}, source("chat-a", "other-run")), { code: "browser_busy" });
});

test("remembered authorization shares the live workspace and exact Page across Chats after lease handoff", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); await registerBrowserTask(h.runtime, source("chat-b", "run-b"));
  const a = await h.cdp("Surface.list");
  await assert.rejects(h.cdp("Surface.list", {}, source("chat-b", "run-b")), { code: "browser_busy" });
  h.runtime.releaseRun("run-a");
  const b = await h.cdp("Surface.list", {}, source("chat-b", "run-b"));
  assert.equal(h.clients.length, 1); assert.equal(a.result.surfaces[0].surfaceId, b.result.surfaces[0].surfaceId);
  assert.equal(h.runtime.state("chat-a").workspaceId, h.runtime.state("chat-b").workspaceId);
  assert.equal(h.runtime.state("chat-b").workspaceShared, true);
  assert.equal((await h.cdp("Surface.observe", {}, source("chat-b", "run-b"), a.result.surfaces[0].surfaceId)).ok, true);
});

test("a new Run detects a closed engine in a live Worker and reconnects before dispatching its first action", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); const original = (await h.cdp("Surface.list")).result.surfaces[0];
  h.runtime.releaseRun("run-a"); h.clients[0].engineClosed = true;
  await registerBrowserTask(h.runtime, source("chat-a", "next-run"));
  const opened = await h.cdp("Surface.openChrome", { url: "https://fixture.test/recovered" }, source("chat-a", "next-run"));
  assert.equal(h.clients[0].killed, true); assert.equal(h.clients.length, 2);
  assert.equal(h.clients[0].calls.some(call => call.method === "open"), false);
  assert.equal(h.clients[1].calls.filter(call => call.method === "open").length, 1);
  assert.equal(opened.result.surface.url, "https://fixture.test/recovered");
  await assert.rejects(h.cdp("Surface.observe", {}, source("chat-a", "next-run"), original.surfaceId), { code: "target_not_found" });
});

test("concurrent first calls share pending health and the replacement handshake without dispatching early", async t => {
  const health = deferred(), connect = deferred();
  const h = harness({ health: (_client, index) => index === 0 ? health.promise : { connected: true },
    connect: (_client, index) => index === 1 ? connect.promise : undefined }); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); await registerBrowserTask(h.runtime, source());
  const first = h.cdp("Surface.openChrome", { url: "https://fixture.test/one" }), second = h.cdp("Surface.list"); await flush();
  assert.equal(h.clients[0].calls.filter(call => call.method === "state").length, 1);
  assert.equal(h.clients[0].calls.some(call => call.method === "open"), false);
  health.resolve({ connected: false }); await flush();
  assert.equal(h.clients.length, 2); assert.equal(h.clients[1].calls.filter(call => call.method === "connect").length, 1);
  assert.equal(h.clients[1].calls.some(call => call.method === "open"), false);
  connect.resolve(); await Promise.all([first, second]);
  assert.equal(h.clients[1].calls.filter(call => call.method === "open").length, 1);
  await h.cdp("Surface.list"); assert.equal(h.clients[1].calls.some(call => call.method === "state"), false, "later actions in this Run do not repeat the health check");
});

test("cancelled health drains before the next owner without killing the shared connection", async t => {
  const health = deferred(); const h = harness({ health: (_client, index) => index === 0 ? health.promise : { connected: true } }); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); await registerBrowserTask(h.runtime, source());
  const pending = h.cdp("Surface.list"); const rejected = assert.rejects(pending, { code: "browser_run_unavailable" });
  await flush(); h.runtime.releaseRun("run-a"); assert.equal(h.clients[0].killed, false);
  await registerBrowserTask(h.runtime, source("chat-a", "next-run"));
  await assert.rejects(h.cdp("Surface.list", {}, source("chat-a", "next-run")), { code: "browser_workspace_draining" });
  health.resolve({ connected: false }); await rejected; await flush(); await flush();
  await h.cdp("Surface.list", {}, source("chat-a", "next-run"));
  assert.equal(h.clients[1].killed, false); assert.equal(h.runtime.state("chat-a").connection, "connected");
  assert.equal(h.runtime.state("chat-a").pages[0].url, h.clients[1].pages[0].url);
});

test("a bounded preflight timeout retires only the old generation before a saved-authorization recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const health = deferred(); const h = harness({ health: (_client, index) => index === 0 ? health.promise : { connected: true } }); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); await registerBrowserTask(h.runtime, source());
  const pending = h.cdp("Surface.openChrome", { url: "https://fixture.test/recovered" }); await flush();
  t.mock.timers.tick(5000); const result = await pending;
  assert.equal(h.clients[0].killed, true); assert.equal(h.clients.length, 2); assert.equal(result.result.surface.url, "https://fixture.test/recovered");
  health.resolve({ connected: false }); await flush();
  assert.equal(h.clients[1].killed, false); assert.equal(h.runtime.state("chat-a").connection, "connected");
});

test("a closed engine prompts rather than reconnecting when remembering has since been disabled", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); h.preferences.rememberChromeConnection = false; h.clients[0].engineClosed = true; await registerBrowserTask(h.runtime, source());
  await assert.rejects(h.cdp("Surface.openChrome", { url: "https://fixture.test" }), { code: "browser_connection_required" });
  assert.equal(h.clients[0].killed, true); assert.equal(h.clients.length, 1); assert.equal(h.runtime.state("chat-a").connectionRequest.reason, "connect");
});

test("an action dispatched before mid-Run engine closure is never retried automatically", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); await registerBrowserTask(h.runtime, source());
  await h.cdp("Surface.list");
  const request = h.clients[0].request.bind(h.clients[0]); let opens = 0;
  h.clients[0].request = async (method, ...args) => { if (method === "open") { opens++; throw Object.assign(new Error("This Chrome connection has been released"), { code: "cancelled" }); } return request(method, ...args); };
  await assert.rejects(h.cdp("Surface.openChrome", { url: "https://fixture.test/write" }), { code: "cancelled" });
  assert.equal(opens, 1); assert.equal(h.clients.length, 1); assert.equal(h.runtime.state("chat-a").connection, "disconnected");
});

test("Run release cancels only its wait while another Chat reuses the workspace handshake", async t => {
  const gate = deferred(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); const old = h.cdp("Surface.list"); const rejected = assert.rejects(old, { code: "browser_run_unavailable" });
  await flush(); h.runtime.releaseRun("run-a"); assert.equal(h.clients[0].killed, false);
  const next = source("chat-b", "next-run"); await registerBrowserTask(h.runtime, next); const current = h.cdp("Surface.list", {}, next);
  gate.resolve(); await rejected; const listed = await current;
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0].calls.filter(call => call.method === "connect").length, 1);
  assert.deepEqual(h.runtime.state("chat-b").pages, listed.result.surfaces);
});

test("Run release preserves an explicitly requested manual workspace connection", async t => {
  const gate = deferred(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  const manual = h.runtime.connect("chat-a");
  await flush(); await registerBrowserTask(h.runtime, source());
  const pending = h.cdp("Surface.list"); const runRejected = assert.rejects(pending, { code: "browser_run_unavailable" });
  await flush(); h.runtime.releaseRun("run-a"); await runRejected;
  assert.equal(h.clients[0].killed, false); gate.resolve(); await manual;
  assert.equal(h.runtime.state("chat-a").connection, "connected");
});

test("Worker exit during automatic handshake requests visible recovery and ignores a late factory result", async t => {
  const gate = deferred(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); const pending = h.cdp("Surface.list"); const rejected = assert.rejects(pending, { code: "chrome_connection_failed" });
  await flush(); h.clients[0].onExit(); await rejected;
  assert.equal(h.runtime.state("chat-a").connectionRequest.reason, "connect");
  assert.deepEqual(h.runtime.state("chat-a").activeRunIds, ["run-a"]);
  gate.resolve(); await flush(); assert.equal(h.runtime.state("chat-a").pages.length, 0);
});

test("tool cancellation stops its wait without cancelling the shared workspace connection", async t => {
  const gate = deferred(), abort = new AbortController(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); const pending = h.cdp("Surface.list", {}, source(), undefined, abort.signal);
  const rejected = assert.rejects(pending, { code: "browser_run_unavailable" });
  await flush(); abort.abort(); await rejected;
  assert.equal(h.clients[0].killed, false); assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
  gate.resolve(); await flush(); await flush(); assert.equal(h.runtime.state("chat-a").connection, "connected");
});

test("automatic handshake stops at 15 seconds and requests manual recovery without replay or fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred(); const h = harness({ connect: () => gate.promise }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source()); const pending = h.cdp("Surface.openChrome", { url: "https://fixture.test" });
  const rejected = assert.rejects(pending, { code: "chrome_connection_failed" });
  await flush(); t.mock.timers.tick(15_000); await rejected;
  assert.equal(h.clients[0].killed, true); assert.equal(h.runtime.state("chat-a").connectionRequest.reason, "connect");
  assert.equal(h.clients[0].calls.some(call => call.method === "open"), false);
  gate.resolve(); await flush(); assert.equal(h.runtime.state("chat-a").pages.length, 0);
});

test("saved authorization never appears in reported connection errors, including malicious transport echoes", async t => {
  const h = harness({ connect: () => { throw new Error(`transport echoed ${token}`); } }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source());
  let received; try { await h.cdp("Surface.list"); } catch (error) { received = error; }
  assert.equal(received.code, "chrome_connection_failed");
  assert.equal(JSON.stringify([received.message, h.changes, h.settings]).includes(token), false);
});

test("unreadable saved credentials request manual recovery without exposing private storage errors", async t => {
  const h = harness({ authorization: () => { throw new Error(`private storage ${token}`); } }); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source());
  await assert.rejects(h.cdp("Surface.list"), error => error.code === "browser_connection_required" && !error.message.includes(token));
  assert.equal(h.runtime.state("chat-a").connectionRequest.reason, "connect"); assert.equal(h.clients.length, 0);
});

test("a Worker creation failure reports a safe error and requests connection recovery", async t => {
  const changes = [];
  const runtime = new BrowserUseRuntime({ preferences: { read: () => ({ defaultBackend: "chrome", rememberChromeConnection: true }), authorization: () => token },
    onChanged: state => changes.push(state), createClient() { throw new Error(`private factory ${token}`); } });
  t.after(() => runtime.dispose()); await registerBrowserTask(runtime, source());
  await assert.rejects(runtime.cdp({ source: source(), method: "Surface.list" }, undefined, neverFallback), error => error.code === "browser_runtime_unavailable" && !error.message.includes(token));
  assert.equal(runtime.state("chat-a").connectionRequest.reason, "connect"); assert.equal(JSON.stringify(changes).includes(token), false);
});

test("interactive connect deliberately ignores saved authorization and allows choosing an existing page", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a");
  assert.equal(h.clients[0].calls[0].params.extensionToken, token);
  await h.runtime.connect("chat-a", { interactive: true });
  assert.equal(h.clients[0].disconnected, true); assert.equal(h.clients[0].killed, true);
  assert.equal(h.clients[1].calls[0].params.extensionToken, undefined);
  h.preferences.rememberChromeConnection = false;
  await h.runtime.connect("chat-b"); assert.equal(h.clients[2].calls[0].params.extensionToken, undefined);
});

test("model-authored Surface calls can never supply credentials, profile, relay or launch settings", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); await registerBrowserTask(h.runtime, source());
  for (const key of ["extensionToken", "profileDirName", "port", "cdpEndpoint", "userDataDir", "executablePath"]) {
    await assert.rejects(h.cdp("Surface.openChrome", { url: "https://fixture.test", [key]: token }), { code: "invalid_args" });
  }
  assert.equal(h.clients.length, 0); assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
});

test("settings metadata counts active leases and forgetting refuses to disconnect an active task", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.runtime.connect("chat-a"); await registerBrowserTask(h.runtime, source());
  assert.deepEqual(h.runtime.settingsState(), { ...h.preferences, connectedChats: 1, activeRuns: 1 });
  await assert.rejects(h.runtime.disconnectIdleConnections(), { code: "browser_busy" }); assert.equal(h.clients[0].killed, false);
  h.runtime.releaseRun("run-a"); await h.runtime.disconnectIdleConnections();
  assert.equal(h.clients[0].killed, true); assert.equal(h.runtime.settingsState().connectedChats, 0);
});

test("settings notification and metadata failures cannot fail an otherwise valid page action", async t => {
  let broken = false;
  const h = harness({ onSettingsChanged: () => { throw new Error("UI closed"); },
    read: () => { if (broken) throw new Error("private storage unavailable"); return { defaultBackend: "chrome", rememberChromeConnection: true }; } });
  t.after(() => h.runtime.dispose()); await h.runtime.connect("chat-a"); broken = true;
  await registerBrowserTask(h.runtime, source()); const result = await h.cdp("Surface.list"); assert.equal(result.ok, true);
  assert.throws(() => h.runtime.settingsState(), /private storage unavailable/);
  assert.equal(h.runtime.hasActiveRuns(), true);
  h.runtime.releaseRun("run-a"); await h.runtime.disconnectIdleConnections(); assert.equal(h.clients[0].killed, true);
});

test("Worker validates explicit Main authorization, forwards it privately and never returns it", async t => {
  const captured = [];
  const controller = { browserContext: { once() {} }, list: async () => [], disconnect: async () => {} };
  const engine = new ChromeWorkerEngine(async options => { captured.push(options); return controller; }); t.after(() => engine.disconnect());
  for (const invalid of ["short", " ".repeat(32), "x".repeat(257), 42])
    await assert.rejects(engine.request({ id: "invalid", method: "connect", params: { extensionToken: invalid } }), { code: "invalid_params" });
  assert.equal(captured.length, 0);
  const result = await engine.request({ id: "connect", method: "connect", params: { extensionToken: token } });
  assert.equal(captured[0].extensionToken, token); assert.equal(JSON.stringify(result).includes(token), false);
  const failing = new ChromeWorkerEngine(async () => { throw Object.assign(new Error(token), { code: "invalid_params" }); }); t.after(() => failing.disconnect());
  await assert.rejects(failing.request({ id: "failed", method: "connect", params: { extensionToken: token } }),
    error => error.code === "chrome_connection_failed" && !error.message.includes(token));
});

test("adapter rejects inherited authorization and removes explicit credentials after successful and failed handshakes", async () => {
  const adapter = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/browser-use-upstream-adapter.cjs"), "utf8");
  for (const explicit of [undefined, token]) for (const reject of [false, true]) {
    const environment = { PLAYWRIGHT_MCP_EXTENSION_TOKEN: "INHERITED_CREDENTIAL_MUST_BE_IGNORED", PWTEST_EXTENSION_USER_DATA_DIR: "/untrusted" };
    const captured = [], context = { tabs: () => [], ensureBrowserContext: async () => {} };
    const browser = { contexts: () => [{}] };
    const sandbox = { module: { exports: {} }, process: { env: environment }, init_mcp() {},
      resolveConfig: async () => { assert.equal(environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined); return {}; },
      filteredTools: () => [], createExtensionBrowser: async () => { captured.push(environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN); if (reject) throw new Error("fixture handshake failed"); return browser; },
      BrowserBackend: class { constructor() { this._context = context; } async initialize() {} },
    };
    vm.runInNewContext(adapter, sandbox);
    const connect = sandbox.module.exports.__desktopBrowserUse.create({ outputDir: "/fixture", extensionToken: explicit });
    if (reject) await assert.rejects(connect, /fixture handshake failed/); else await connect;
    assert.deepEqual(captured, [explicit]); assert.equal(environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined);
    assert.equal(environment.PWTEST_EXTENSION_USER_DATA_DIR, undefined);
  }
});
