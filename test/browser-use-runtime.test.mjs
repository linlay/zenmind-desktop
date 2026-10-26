import { registerBrowserTask } from "./helpers/browser-use-task.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { BrowserUseRuntime } = require("../dist-electron/main/modules/browser-use/runtime.js");
const { registerBrowserUseIpc } = require("../dist-electron/main/modules/browser-use/ipc.js");

const source = (chatId = "chat-a", runId = "run-a") => ({ chatId, runId, agentKey: "cutej" });
const request = (method, identity = source(), surfaceId, params = {}) => ({ method, source: identity, surfaceId, params });
function harness() {
  const clients = [];
  const stopped = [];
  const changes = [];
  const runtime = new BrowserUseRuntime({
    onChanged: value => changes.push(value),
    stopRun: async (id, agentKey) => { stopped.push({ runId: id, agentKey }); return { ok: true }; },
    createClient() {
      const client = {
        pages: [{ pageId: "p1", title: "Same title", url: "https://example.test/", active: true }],
        calls: [], disconnected: false, killed: false,
        async request(method, params, pageId, signal) {
          this.calls.push({ method, params, pageId, signal });
          if (signal?.aborted) throw new Error("aborted");
          if (method === "connect") return { connected: true, pages: this.pages };
          if (method === "state") return { connected: !this.disconnected, pages: this.pages };
          if (method === "list") return this.pages;
          if (method === "observe") return { observationId: `obs-${pageId}`, elements: [], text: "Page" };
          if (method === "open") {
            const page = { pageId: "p2", title: "New", url: params.url };
            this.pages.push(page);
            return page;
          }
          if (method === "close") this.pages = this.pages.filter(page => page.pageId !== pageId);
          return { status: "done" };
        },
        async disconnect() { this.disconnected = true; },
        kill() { this.killed = true; },
      };
      clients.push(client);
      return client;
    },
  });
  return { runtime, clients, stopped, changes };
}
const noFallback = async () => { throw new Error("Chrome must not fall back to WorkPanel"); };

test('Chrome registers only HTTP(S) business pages and never exposes internal connection metadata', async () => {
  const { runtime, clients, changes } = harness();
  await runtime.connect('chat-a');
  const original = runtime.state('chat-a').pages[0];
  const privateMarker = 'SYNTHETIC_INTERNAL_CONNECTION_METADATA';
  clients[0].pages.push(
    { pageId: 'welcome', title: privateMarker, url: `chrome-extension://fixture/connect.html?relay=${privateMarker}` },
    { pageId: 'settings', title: privateMarker, url: 'chrome://settings/' },
    { pageId: 'blank', title: privateMarker, url: 'about:blank' },
    { pageId: 'data', title: privateMarker, url: 'data:text/html,fixture' },
    { pageId: 'local', title: privateMarker, url: 'file:///fixture.html' },
    { pageId: 'credentials', title: privateMarker, url: 'https://fixture:private@example.test/' },
  );
  assert.deepEqual((await runtime.refreshState('chat-a')).pages, [original]);
  await registerBrowserTask(runtime, source());
  const listed = await runtime.cdp(request('Surface.list'), undefined, noFallback);
  assert.deepEqual(listed.result.surfaces, [original]);
  assert.equal(JSON.stringify(changes).includes(privateMarker), false);
  clients[0].pages[0].url = 'chrome-extension://fixture/status.html';
  await assert.rejects(runtime.cdp(request('Surface.observe', source(), original.surfaceId), undefined, noFallback), { code: 'target_not_found' });
  assert.equal(clients[0].calls.some(call => call.method === 'observe'), false);
  assert.deepEqual(runtime.state('chat-a').pages, []);
  clients[0].pages[0].url = original.url;
  const returned = await runtime.refreshState('chat-a');
  assert.notEqual(returned.pages[0].surfaceId, original.surfaceId, 'returning to HTTP cannot revive the retired public Surface');
  await assert.rejects(runtime.cdp(request('Surface.observe', source(), original.surfaceId), undefined, noFallback), { code: 'target_not_found' });
});

test("only canonical registered Run identities can operate; browser selection freezes for the Run", async () => {
  const { runtime } = harness();
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_run_unavailable" });
  await registerBrowserTask(runtime, source());
  assert.throws(() => runtime.select("chat-a", "chrome"), { code: "browser_busy" });
  await assert.rejects(runtime.cdp(request("Surface.list", source("chat-b")), undefined, noFallback), { code: "browser_run_unavailable" });
  runtime.releaseRun("run-a");
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_run_unavailable" });
});

test("Chrome connection is Chat scoped; no granted page can be used by another Chat", async () => {
  const { runtime, clients } = harness();
  await runtime.connect("chat-a");
  await runtime.connect("chat-b");
  await registerBrowserTask(runtime, source());
  await registerBrowserTask(runtime, source("chat-b", "run-b"));
  const list = await runtime.cdp(request("Surface.list"), undefined, noFallback);
  const page = list.result.surfaces[0];
  assert.equal(page.provider, "chrome");
  assert.equal("pageId" in page, false);
  await assert.rejects(runtime.cdp(request("Surface.observe", source("chat-b", "run-b"), page.surfaceId), undefined, noFallback), { code: "target_not_found" });
  assert.equal(clients[1].calls.some(call => call.method === "observe"), false);
  const observation = await runtime.cdp(request("Surface.observe", source(), page.surfaceId), undefined, noFallback);
  assert.equal(observation.result.surfaceId, page.surfaceId);
});

test("closing and reopening an identical URL never transfers an old Surface to its neighbour", async () => {
  const { runtime, clients } = harness();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  const original = (await runtime.cdp(request("Surface.list"), undefined, noFallback)).result.surfaces[0];
  clients[0].pages = [{ pageId: "replacement", title: original.title, url: original.url }];
  await assert.rejects(runtime.cdp(request("Input.click", source(), original.surfaceId, { x: 10, y: 20 }), undefined, noFallback), { code: "target_not_found" });
  assert.equal(clients[0].calls.some(call => call.method === "click"), false);
  const next = (await runtime.cdp(request("Surface.list"), undefined, noFallback)).result.surfaces[0];
  assert.notEqual(next.surfaceId, original.surfaceId);
  assert.equal(next.url, original.url);
});

test("WorkPanel refs are restricted to the observing Run, even when the Chat is the same", async () => {
  const { runtime } = harness();
  await registerBrowserTask(runtime, source());
  const fallback = async () => ({ ok: true, result: { observationId: "workpanel-observation" } });
  await runtime.cdp(request("Surface.observe", source(), "page:a"), undefined, fallback);
  await runtime.cdp(request("Surface.click", source(), "page:a", { ref: "e1", observationId: "workpanel-observation" }), undefined, fallback);
  runtime.releaseRun("run-a");
  await registerBrowserTask(runtime, source("chat-a", "run-next"));
  await assert.rejects(runtime.cdp(request("Surface.click", source("chat-a", "run-next"), "page:a", {
    ref: "e1", observationId: "workpanel-observation",
  }), undefined, fallback), { code: "stale_observation" });
});

test("takeover aborts queued browser operations, disconnects the worker, and interrupts the task", async () => {
  const { runtime, clients, stopped } = harness();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  const page = (await runtime.cdp(request("Surface.list"), undefined, noFallback)).result.surfaces[0];
  await runtime.cdp(request("Surface.observe", source(), page.surfaceId), undefined, noFallback);
  const leaseSignal = clients[0].calls.at(-1).signal;
  await runtime.takeover("chat-a");
  assert.equal(leaseSignal.aborted, true);
  assert.equal(clients[0].disconnected, true);
  assert.equal(clients[0].killed, true);
  assert.deepEqual(stopped, [{ runId: "run-a", agentKey: source().agentKey }]);
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_run_unavailable" });
});

test("a canceled WorkPanel operation cannot deliver a late successful result", async () => {
  const { runtime } = harness();
  await registerBrowserTask(runtime, source());
  let finish;
  const pending = runtime.cdp(request("Surface.observe"), undefined, () => new Promise(resolve => { finish = resolve; }));
  runtime.releaseRun("run-a");
  finish({ ok: true, result: { observationId: "late" } });
  await assert.rejects(pending, { code: "browser_run_unavailable" });
});

test("takeover forwards the frozen TEAM root owner through its private stop callback", async () => {
  const { runtime, stopped } = harness();
  await registerBrowserTask(runtime, { chatId: "team-chat", runId: "team-run", agentKey: "research-team" });
  await runtime.takeover("team-chat");
  assert.deepEqual(stopped, [{ runId: "team-run", agentKey: "research-team" }]);
});

test("Chrome raw scripts are unavailable and new pages reject embedded credentials", async () => {
  const { runtime } = harness();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  const page = (await runtime.cdp(request("Surface.list"), undefined, noFallback)).result.surfaces[0];
  await assert.rejects(runtime.cdp(request("Runtime.evaluate", source(), page.surfaceId, { expression: "document.cookie" }), undefined, noFallback), { code: "capability_unavailable" });
  await assert.rejects(runtime.cdp(request("Page.reload", source(), page.surfaceId, { ignoreCache: true }), undefined, noFallback), { code: "capability_unavailable" });
  await assert.rejects(runtime.cdp(request("Surface.openChrome", source(), undefined, { url: "https://user:password@example.test" }), undefined, noFallback), { code: "invalid_args" });
});

test("browser connection controls require the active Chat and the main window's top frame", async () => {
  const { runtime, clients } = harness();
  let handler;
  const frame = {};
  const webContents = { mainFrame: frame };
  registerBrowserUseIpc({
    ipcMain: { handle: (channel, callback) => { if (channel === "browserUse.control") handler = callback; } },
    runtime, getMainWindow: () => ({ webContents, isDestroyed: () => false }),
    getActiveChatId: () => "chat-a", openExternal: async () => {},
  });
  assert.equal((await handler({ sender: webContents, senderFrame: {} }, { action: "connect", chatId: "chat-a" })).error.code, "forbidden");
  assert.equal((await handler({ sender: webContents, senderFrame: frame }, { action: "connect", chatId: "chat-b" })).error.code, "chat_changed");
  assert.equal(clients.length, 0);
  assert.equal((await handler({ sender: webContents, senderFrame: frame }, { action: "state", chatId: "chat-a" })).ok, true);
});

test("a pending canonical grant freezes selection but cannot execute until ready", async () => {
  const { runtime } = harness();
  runtime.prepareRun(source());
  assert.throws(() => runtime.select("chat-a", "chrome"), { code: "browser_busy" });
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_run_unavailable" });
  await registerBrowserTask(runtime, source());
  const result = await runtime.cdp(request("Surface.list"), undefined, async () => ({ ok: true, result: { surfaces: [] } }));
  assert.equal(result.ok, true);
});

test("deleting or archiving a Chat releases Chrome and all of its Run leases", async () => {
  const { runtime, clients } = harness();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  await runtime.releaseChat("chat-a");
  await runtime.releaseChat("chat-a");
  assert.equal(clients[0].disconnected, true);
  assert.equal(clients[0].killed, true);
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_run_unavailable" });
  assert.equal(runtime.state("chat-a").backend, "workpanel");
});

test("reopening browser controls refreshes removed pages and detects a disconnected extension", async () => {
  const { runtime, clients } = harness();
  await runtime.connect("chat-a");
  clients[0].pages = [];
  assert.equal((await runtime.refreshState("chat-a")).pages.length, 0);
  clients[0].disconnected = true;
  assert.equal((await runtime.refreshState("chat-a")).connection, "disconnected");
  assert.equal(clients[0].killed, true);
});

test("a Chrome Run without a connection suspends until the user connects, then continues without a new task", async () => {
  const { runtime, clients } = harness();
  runtime.select("chat-a", "chrome");
  await registerBrowserTask(runtime, source());
  await assert.rejects(runtime.cdp(request("Surface.list"), undefined, noFallback), { code: "browser_connection_required" });
  assert.equal(runtime.state("chat-a").awaitingConnection, true);
  const waiting = runtime.cdp(request("Browser.awaitConnection", source(), undefined, { timeoutMs: 5000 }), undefined, noFallback);
  // The suspended Run must not lock the user out of the connection it waits for.
  await runtime.connect("chat-a");
  assert.deepEqual((await waiting).result, { status: "connected" });
  const listed = await runtime.cdp(request("Surface.list"), undefined, noFallback);
  assert.equal(listed.result.surfaces.length, 1);
  assert.equal(clients.length, 1);
  assert.equal(runtime.state("chat-a").awaitingConnection, undefined);
  // Once page work was dispatched the Run is no longer suspended; other connection changes stay locked.
  await assert.rejects(runtime.connect("chat-a", { interactive: true }), { code: "browser_busy" });
});

test("only a suspended Chrome Run may await a connection; the wait is bounded and ends with the Run", async () => {
  const { runtime } = harness();
  await registerBrowserTask(runtime, source());
  const workpanel = await runtime.cdp(request("Browser.awaitConnection"), undefined, noFallback);
  assert.deepEqual(workpanel.result, { status: "unavailable", reason: "backend_mismatch" });
  runtime.releaseRun("run-a");

  runtime.select("chat-a", "chrome");
  await registerBrowserTask(runtime, source("chat-a", "run-b"));
  const unrequested = await runtime.cdp(request("Browser.awaitConnection", source("chat-a", "run-b")), undefined, noFallback);
  assert.deepEqual(unrequested.result, { status: "unavailable", reason: "connection_not_requested" });
  await assert.rejects(runtime.cdp(request("Surface.list", source("chat-a", "run-b")), undefined, noFallback), { code: "browser_connection_required" });
  const pending = await runtime.cdp(request("Browser.awaitConnection", source("chat-a", "run-b"), undefined, { timeoutMs: 1000 }), undefined, noFallback);
  assert.deepEqual(pending.result, { status: "pending" });
  const stopped = runtime.cdp(request("Browser.awaitConnection", source("chat-a", "run-b"), undefined, { timeoutMs: 20000 }), undefined, noFallback);
  runtime.releaseRun("run-b");
  await assert.rejects(stopped, { code: "browser_run_unavailable" });
});
