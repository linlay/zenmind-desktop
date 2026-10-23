import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, "..");
const Module = require("node:module");
const bundled = require("esbuild").buildSync({ stdin: { contents: [
  ["BrowserUseRuntime", "runtime"], ["ChromeBackend", "chrome-backend"], ["ChromeWorkerEngine", "chrome-worker-engine"],
].map(([name, file]) => `export {${name}} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use", `${file}.ts`))};`).join("\n"), resolveDir: root },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" }).outputFiles[0].text;
const fakeChildren = [];
const electron = { app: { getAppPath: () => root }, utilityProcess: { fork() {
  const child = new EventEmitter(); child.messages = []; child.kills = 0;
  child.postMessage = message => child.messages.push(message);
  child.reply = (message, result) => child.emit("message", { id: message.id, result });
  child.kill = () => { child.kills++; child.emit("exit", 0); };
  fakeChildren.push(child); return child;
} } };
const sourceModule = new Module(path.join(root, "test/workspace-source.cjs"));
sourceModule.filename = path.join(root, "test/workspace-source.cjs"); sourceModule.paths = Module._nodeModulePaths(root);
sourceModule.require = id => id === "electron" ? electron : require(id); sourceModule._compile(bundled, sourceModule.filename);
const { BrowserUseRuntime, ChromeBackend, ChromeWorkerEngine } = sourceModule.exports;
const source = (chatId = "chat-a", runId = "run-a", agentKey = "cutej") => ({ chatId, runId, agentKey });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const fallback = async () => { throw new Error("Chrome workspace cannot use WorkPanel as a fallback"); };
const token = "SYNTHETIC_WORKSPACE_AUTHORIZATION";

function harness(options = {}) {
  const clients = [], events = [], stopped = [];
  const preferences = { defaultBackend: "chrome", rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true, ...options.preferences };
  const runtime = new BrowserUseRuntime({ clientName: "CuteJ", preferences: { read: () => ({ ...preferences }), authorization: () => token },
    onChanged: state => events.push(state), getWebsiteBridgeScript: () => "void 0",
    stopRun: async (runId, agentKey) => { stopped.push({ runId, agentKey }); return { ok: true }; },
    createClient(onExit) {
      const index = clients.length, physical = new Set(), manuals = new Map();
      const client = { calls: [], pages: [{ pageId: `private-${index}`, title: "Original authorized page", url: "https://fixture.test/original", active: true }], serial: 0, killed: false, disconnected: false, onExit,
        request(method, params = {}, pageId, signal) {
          if (signal?.aborted) return Promise.reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
          this.calls.push({ method, params, pageId });
          const raw = Promise.resolve().then(async () => {
            if (options.operation) { const value = await options.operation({ method, params, pageId, client, index }); if (value !== undefined) return value; }
            if (method === "connect") return { connected: true, pages: this.pages };
            if (method === "list") return this.pages;
            if (method === "state") return { connected: true, pages: this.pages };
            if (method === "open") { const page = { pageId: `opened-${index}-${++this.serial}`, url: params.url, title: "New page" }; this.pages.push(page); return page; }
            if (method === "observe") return { observationId: `fresh-${++this.serial}`, text: "Page", elements: [{ ref: "e1", role: "button", name: "Go", tag: "button" }],
              dialogs: [{ dialogId: "modal-a", type: "confirm", message: "Confirm" }], fileChoosers: [{ chooserId: "chooser-a", multiple: false }], downloads: [{ downloadId: "download-a", fileName: "owned.txt", status: "complete" }] };
            if (method === "downloads") return params.action === "list" ? { downloads: [{ downloadId: "download-a", fileName: "owned.txt", status: "complete" }] } : { downloadId: params.downloadId, sizeBytes: 5 };
            if (method === "awcp-release-run") { manuals.delete(params.runId); return { released: true }; }
            if (method === "awcp-refresh") { manuals.clear(); return { refreshed: true }; }
            if (method === "awcp-manual") {
              if (!params.payload.section) { manuals.set(params.runId, false); return { ok: true, method: "AWCP.getManual", revision: "rev-1", site: { name: "Fixture", description: "Fixture" }, sections: [{ section: "fixture.read", title: "Read" }] }; }
              if (!manuals.has(params.runId)) throw Object.assign(new Error("Read current directory"), { code: "awcp_preflight_rejected", statusCode: 400, details: { reason: "manual_required" } });
              manuals.set(params.runId, true); return { ok: true, method: "AWCP.getManual", revision: "rev-1", section: "fixture.read", description: "Read", inputSchema: { type: "object" } };
            }
            if (method === "awcp-invoke") {
              if (!manuals.get(params.runId)) throw Object.assign(new Error("Read current section"), { code: "awcp_preflight_rejected", statusCode: 400, details: { reason: "manual_required" } });
              return { ok: true, requestId: params.requestId, action: params.payload.action, result: { read: true } };
            }
            return { status: "done" };
          });
          physical.add(raw); void raw.then(() => physical.delete(raw), () => physical.delete(raw));
          if (!signal) return raw;
          let abort = () => undefined;
          const interrupted = new Promise((_, reject) => { abort = () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); signal.addEventListener("abort", abort, { once: true }); });
          return Promise.race([raw, interrupted]).finally(() => signal.removeEventListener("abort", abort));
        },
        async drain() { await Promise.allSettled([...physical]); },
        async disconnect() { this.disconnected = true; }, kill() { this.killed = true; },
      };
      clients.push(client); return client;
    },
  });
  const cdp = (identity, method, surfaceId, params = {}) => runtime.cdp({ source: identity, method, surfaceId, params }, undefined, fallback);
  return { runtime, clients, events, preferences, stopped, cdp };
}

test("a new Chat and re-question keep the exact authorized Surface without another connect or open", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a);
  const listed = await f.cdp(a, "Surface.list"), page = listed.result.surfaces[0]; const observed = await f.cdp(a, "Surface.observe", page.surfaceId);
  f.runtime.releaseRun(a.runId); const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  assert.equal(f.runtime.state(b.chatId).workspaceId, f.runtime.state(a.chatId).workspaceId);
  assert.equal(f.runtime.state(b.chatId).pages[0].surfaceId, page.surfaceId);
  const current = await f.cdp(b, "Surface.getCurrent"); assert.equal(current.result.currentSurfaceId, page.surfaceId);
  await assert.rejects(f.cdp(b, "Surface.click", page.surfaceId, { ref: "e1", observationId: observed.result.observationId }), { code: "stale_observation" });
  const fresh = await f.cdp(b, "Surface.observe", page.surfaceId);
  await f.cdp(b, "Surface.click", page.surfaceId, { ref: "e1", observationId: fresh.result.observationId });
  assert.equal(f.clients.length, 1); assert.equal(f.clients[0].calls.filter(call => call.method === "connect").length, 1);
  assert.equal(f.clients[0].calls.filter(call => call.method === "open").length, 0, "inheritance cannot be faked by reopening the URL");
});

test("pure-text Runs do not own the workspace; real browser ownership blocks another Chat", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(), b = source("chat-b", "run-b");
  f.runtime.registerRun(a); f.runtime.registerRun(b); assert.equal(f.runtime.state(a.chatId).workspaceOwner, undefined);
  const page = (await f.cdp(a, "Surface.list")).result.surfaces[0];
  assert.deepEqual(f.runtime.state(b.chatId).workspaceOwner, { chatId: a.chatId, runId: a.runId, draining: false });
  await assert.rejects(f.cdp(b, "Surface.observe", page.surfaceId), { code: "browser_busy" });
  f.runtime.releaseRun(a.runId); assert.equal((await f.cdp(b, "Surface.observe", page.surfaceId)).ok, true);
  await assert.rejects(f.cdp({ ...b, agentKey: "forged" }, "Surface.list"), { code: "browser_run_unavailable" });
});

test("normal cancellation drains old work before handoff and never kills or redelivers a shared reply", async t => {
  const gate = deferred(); const f = harness({ operation: ({ method }) => method === "interact" ? gate.promise : undefined }); t.after(() => f.runtime.dispose());
  const a = source(); f.runtime.registerRun(a); const page = (await f.cdp(a, "Surface.list")).result.surfaces[0];
  const pending = f.cdp(a, "Surface.interact", page.surfaceId, { action: "focus", selector: "#field" });
  const cancelled = assert.rejects(pending, { code: "browser_run_unavailable" }); await flush(); f.runtime.releaseRun(a.runId); await cancelled;
  assert.deepEqual(f.runtime.state(a.chatId).activeRunIds, []);
  assert.equal(f.runtime.hasActiveRuns(), true, "a released Run remains a real browser owner while draining");
  assert.equal(f.runtime.settingsState().activeRuns, 1);
  await assert.rejects(f.runtime.disconnectIdleConnections(), { code: "browser_busy" });
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  assert.equal(f.clients[0].killed, false); assert.equal(f.runtime.state(b.chatId).workspaceOwner.draining, true);
  await assert.rejects(f.cdp(b, "Surface.list"), { code: "browser_workspace_draining" });
  await assert.rejects(f.runtime.disconnectIdleConnections(), { code: "browser_busy" });
  gate.resolve({ status: "done", privateLateResult: "OLD_RUN_ONLY" }); await flush(); await flush();
  const current = await f.cdp(b, "Surface.list"); assert.equal(current.result.surfaces[0].surfaceId, page.surfaceId);
  assert.equal(f.clients.length, 1); assert.equal(f.clients[0].killed, false);
  assert.equal(JSON.stringify(current).includes("OLD_RUN_ONLY"), false);
});

test("deleting the previous Chat detaches it without releasing the shared page", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a);
  const page = (await f.cdp(a, "Surface.list")).result.surfaces[0]; f.runtime.releaseRun(a.runId);
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b); await f.runtime.releaseChat(a.chatId);
  assert.equal(f.clients[0].killed, false); assert.equal(f.clients[0].disconnected, false);
  assert.equal((await f.cdp(b, "Surface.getCurrent")).result.currentSurfaceId, page.surfaceId);
});

test("a draining private workspace survives promotion and a new Chat attaching during old Chat deletion", async t => {
  const gate = deferred();
  const f = harness({ preferences: { rememberChromeConnection: false, hasSavedAuthorization: false }, operation: ({ method }) => method === "interact" ? gate.promise : undefined });
  t.after(() => f.runtime.dispose()); await f.runtime.connect("chat-a"); const a = source(); f.runtime.registerRun(a);
  const page = (await f.cdp(a, "Surface.list")).result.surfaces[0], workspaceId = f.runtime.state(a.chatId).workspaceId;
  const pending = f.cdp(a, "Surface.interact", page.surfaceId, { action: "focus", selector: "#field" });
  const cancelled = assert.rejects(pending, { code: "browser_run_unavailable" }); await flush();
  const deleting = f.runtime.releaseChat(a.chatId); await cancelled;
  f.preferences.rememberChromeConnection = true; f.preferences.hasSavedAuthorization = true;
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  assert.equal(f.runtime.state(b.chatId).workspaceId, workspaceId);
  assert.equal(f.runtime.state(b.chatId).workspaceShared, true);
  gate.resolve({ status: "done" }); await deleting;
  assert.equal(f.runtime.workspaces.has(workspaceId), true);
  assert.equal(f.runtime.state(b.chatId).connection, "connected");
  assert.equal(f.clients[0].killed, false); assert.equal(f.clients[0].disconnected, false);
  assert.equal((await f.cdp(b, "Surface.getCurrent")).result.currentSurfaceId, page.surfaceId);
});

test("state changes reach all attached Chats and settings refresh runs once per physical workspace", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a); await f.cdp(a, "Surface.list"); f.runtime.releaseRun(a.runId);
  f.runtime.state("chat-b"); const start = f.events.length; f.runtime.registerRun(a);
  await f.cdp(a, "Surface.openChrome", undefined, { url: "https://fixture.test/new" });
  const changes = f.events.slice(start); assert.equal(changes.some(state => state.chatId === "chat-b" && state.pages.some(page => page.url.endsWith("/new"))), true);
  f.runtime.refreshWebsiteBridges(); await flush(); assert.equal(f.clients[0].calls.filter(call => call.method === "awcp-refresh").length, 1);
});

test("workspace takeover targets the actual owner even when invoked from a different Chat", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source("chat-a", "owner", "root-team"); f.runtime.registerRun(a); await f.cdp(a, "Surface.list");
  f.runtime.state("chat-b"); await f.runtime.takeover("chat-b");
  assert.deepEqual(f.stopped, [{ runId: "owner", agentKey: "root-team" }]); assert.equal(f.clients[0].killed, true);
  assert.equal(f.runtime.state("chat-a").connection, "disconnected"); assert.equal(f.runtime.state("chat-b").connection, "disconnected");
});

test("a late old exit after explicit disconnect cannot clear the replacement workspace", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); await f.runtime.connect("chat-a"); const old = f.clients[0];
  await f.runtime.disconnect("chat-a"); await f.runtime.connect("chat-a"); const b = f.runtime.state("chat-b"); const pages = b.pages;
  old.onExit(); assert.equal(f.runtime.state("chat-b").connection, "connected"); assert.deepEqual(f.runtime.state("chat-b").pages, pages); assert.equal(f.clients[1].killed, false);
});

test("a delayed UI health result cannot disconnect a Run that started while the UI was waiting", async t => {
  const gate = deferred(); let hold = false;
  const f = harness({ operation: ({ method }) => { if (method === "state" && hold) { hold = false; return gate.promise; } } });
  t.after(() => f.runtime.dispose()); await f.runtime.connect("chat-a"); hold = true;
  const refreshing = f.runtime.refreshState("chat-a"); await flush();
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b); await f.cdp(b, "Surface.list"); f.runtime.releaseRun(b.runId);
  gate.resolve({ connected: false }); await refreshing;
  assert.equal(f.runtime.state(b.chatId).connection, "connected");
  assert.equal(f.clients[0].killed, false); assert.equal(f.clients[0].disconnected, false);
});

test("a delayed UI page list cannot erase a page created by an intervening Run", async t => {
  const gate = deferred(); let hold = false;
  const f = harness({ operation: ({ method }) => { if (method === "list" && hold) { hold = false; return gate.promise; } } });
  t.after(() => f.runtime.dispose()); await f.runtime.connect("chat-a"); const previous = [...f.clients[0].pages]; hold = true;
  const refreshing = f.runtime.refreshState("chat-a"); await flush();
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  const created = await f.cdp(b, "Surface.openChrome", undefined, { url: "https://fixture.test/new-during-refresh" }); f.runtime.releaseRun(b.runId);
  gate.resolve(previous); await refreshing;
  assert.equal(f.runtime.state(b.chatId).pages.some(page => page.surfaceId === created.result.surface.surfaceId), true);
  assert.equal(f.clients[0].killed, false);
});

test("unremembered manual connections remain private and missing surfaces reveal no other Chat owner", async t => {
  const f = harness({ preferences: { rememberChromeConnection: false, hasSavedAuthorization: false } }); t.after(() => f.runtime.dispose());
  await f.runtime.connect("chat-a"); await f.runtime.connect("chat-b"); const a = source(), b = source("chat-b", "run-b"); f.runtime.registerRun(a); f.runtime.registerRun(b);
  const page = (await f.cdp(a, "Surface.list")).result.surfaces[0];
  assert.equal(f.clients.length, 2); assert.notEqual(f.runtime.state(a.chatId).workspaceId, f.runtime.state(b.chatId).workspaceId);
  await assert.rejects(f.cdp(b, "Surface.observe", page.surfaceId), error => error.code === "target_not_found" && !error.message.includes("chat-a") && !error.message.includes("authorized"));
});

test("new Chat modal and download identifiers need a fresh current-Run observation", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a);
  const page = (await f.cdp(a, "Surface.list")).result.surfaces[0], observed = await f.cdp(a, "Surface.observe", page.surfaceId); f.runtime.releaseRun(a.runId);
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  await assert.rejects(f.cdp(b, "Surface.handleDialog", page.surfaceId, { observationId: observed.result.observationId, dialogId: "modal-a", action: "dismiss" }), { code: "stale_observation" });
  await assert.rejects(f.cdp(b, "Surface.readDownload", page.surfaceId, { downloadId: "download-a" }), { code: "stale_observation" });
  const fresh = await f.cdp(b, "Surface.observe", page.surfaceId);
  assert.equal((await f.cdp(b, "Surface.handleDialog", page.surfaceId, { observationId: fresh.result.observationId, dialogId: "modal-a", action: "dismiss" })).ok, true);
  assert.equal((await f.cdp(b, "Surface.readDownload", page.surfaceId, { downloadId: "download-a" })).result.downloadId, "download-a");
});

test("shared Chrome does not inherit the previous Run's AWCP manual and chapter read", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a); const page = (await f.cdp(a, "Surface.list")).result.surfaces[0];
  const manual = (identity, payload, id) => f.runtime.awcp(id, "AWCP.getManual", payload, identity, new AbortController().signal, page.surfaceId);
  const invoke = identity => f.runtime.awcp("invoke", "AWCP.invoke", { action: "fixture.read", revision: "rev-1", args: {} }, identity, new AbortController().signal, page.surfaceId);
  await manual(a, {}, "index-a"); await manual(a, { revision: "rev-1", section: "fixture.read" }, "section-a"); assert.equal((await invoke(a)).result.ok, true); f.runtime.releaseRun(a.runId); await flush();
  const b = source("chat-b", "run-b"); f.runtime.registerRun(b);
  await assert.rejects(invoke(b), error => error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
  await manual(b, {}, "index-b"); await manual(b, { revision: "rev-1", section: "fixture.read" }, "section-b"); assert.equal((await invoke(b)).result.ok, true);
});

test("real Main transport cancellation keeps the Worker and drains a sent reply before reuse", async t => {
  const backend = new ChromeBackend({ workerPath: path.join(root, "package.json") }); t.after(() => backend.kill());
  const abort = new AbortController(), pending = backend.request("click", {}, "owned-page", abort.signal);
  const child = fakeChildren.at(-1); child.emit("spawn"); const wire = child.messages[0];
  abort.abort(); await assert.rejects(pending, { code: "cancelled" }); assert.equal(child.kills, 0);
  const cancel = child.messages.find(message => message.method === "cancel-request");
  assert.deepEqual(cancel.params, { requestId: wire.id }); child.reply(cancel, { cancelled: true, running: false });
  let drained = false; const drain = backend.drain().then(() => { drained = true; }); await flush(); assert.equal(drained, false);
  child.reply(wire, { status: "late old result" }); await drain; assert.equal(child.kills, 0);
  const next = backend.request("state"); child.reply(child.messages.at(-1), { connected: true }); assert.deepEqual(await next, { connected: true });
});

test("cancelling a request before Worker spawn drops it without dispatching or killing Chrome", async t => {
  const backend = new ChromeBackend({ workerPath: path.join(root, "package.json") }); t.after(() => backend.kill());
  const abort = new AbortController(), pending = backend.request("state", {}, undefined, abort.signal); const child = fakeChildren.at(-1);
  abort.abort(); await assert.rejects(pending, { code: "cancelled" }); child.emit("spawn"); await backend.drain();
  assert.equal(child.messages.length, 0); assert.equal(child.kills, 0);
});

test("Worker queue cancellation skips only an unstarted write, drains running work and forgets the cancellation", async t => {
  const held = deferred(); let hold = false, opens = 0;
  const controller = { browserContext: { once() {} }, list: async () => hold ? held.promise : [], disconnect: async () => {},
    open: async url => { opens++; return { pageId: `opened-${opens}`, url, title: "Created once" }; },
    run: async () => { throw Object.assign(new Error("fixture has no snapshot"), { code: "surface_not_found" }); } };
  const engine = new ChromeWorkerEngine(async () => controller); t.after(() => engine.disconnect());
  await engine.request({ id: "connect", method: "connect" }); hold = true;
  const running = engine.request({ id: "running", method: "list" }); await flush();
  const queued = engine.request({ id: "queued-write", method: "open", params: { url: "https://fixture.test/submit" } });
  const cancelled = assert.rejects(queued, { code: "cancelled" });
  assert.deepEqual(await engine.request({ id: "cancel-queued", method: "cancel-request", params: { requestId: "queued-write" } }), { cancelled: true, running: false });
  assert.deepEqual(await engine.request({ id: "cancel-running", method: "cancel-request", params: { requestId: "running" } }), { cancelled: false, running: true });
  assert.equal(opens, 0); held.resolve([]); await running; await cancelled;
  const fresh = await engine.request({ id: "fresh-write", method: "open", params: { url: "https://fixture.test/next" } });
  assert.equal(opens, 1); assert.equal(fresh.url, "https://fixture.test/next");
  assert.equal(engine.requests.size, 0, "completed cancellation identities have no persistent Set or map entry");
  assert.deepEqual(await engine.request({ id: "late-cancel", method: "cancel-request", params: { requestId: "queued-write" } }), { cancelled: false, running: false });
});

test("an already-used Run cannot dispatch another action after its workspace connection generation changes", async t => {
  const f = harness(); t.after(() => f.runtime.dispose()); const a = source(); f.runtime.registerRun(a); await f.cdp(a, "Surface.list");
  const workspace = f.runtime.workspaces.get(f.runtime.state(a.chatId).workspaceId); workspace.generation++;
  await assert.rejects(f.cdp(a, "Surface.openChrome", undefined, { url: "https://fixture.test/must-not-replay" }), { code: "browser_run_unavailable" });
  assert.equal(f.clients[0].calls.some(call => call.method === "open"), false);
});
