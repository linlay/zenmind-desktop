import { registerBrowserTask } from "./helpers/browser-use-task.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { BrowserUseRuntime } = require("../dist-electron/main/modules/browser-use/runtime.js");
const source = (chatId = "chat-a", runId = "run-a") => ({ chatId, runId, agentKey: "cutej" });
const call = (method, surfaceId, params = {}, identity = source()) => ({ method, surfaceId, params, source: identity });
const noFallback = async () => { throw new Error("Chrome must not call the WorkPanel gateway"); };

function fixture() {
  const clients = [];
  const runtime = new BrowserUseRuntime({
    clientName: "CuteJ",
    createClient() {
      const client = {
        pages: [{ pageId: "one", title: "Same", url: "https://example.test/one", active: true }],
        calls: [], serial: 0,
        async request(method, params, pageId) {
          this.calls.push({ method, params, pageId });
          if (method === "list") return this.pages;
          if (method === "connect" || method === "state") return { connected: true, pages: this.pages };
          if (method === "open") {
            this.pages.push({ pageId: "new", title: "New", url: params.url, active: true });
            pageId = "new";
          }
          const page = this.pages.find(item => item.pageId === pageId);
          const observation = { observationId: `fresh-${pageId}-${++this.serial}`, text: "Visible",
            elements: [{ ref: "e1", role: "textbox", name: "Name", tag: "input" }], truncated: false,
            url: page?.url, title: page?.title };
          if (method === "observe") return observation;
          return { ...page, status: "done", observation };
        },
        async disconnect() {},
        kill() {},
      };
      clients.push(client);
      return client;
    },
  });
  return { runtime, clients };
}

test("action-returned observations authorize the next typed action only in their own Run and Surface", async () => {
  const { runtime } = fixture();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  const opened = await runtime.cdp(call("Surface.openChrome", undefined, { url: "https://example.test/new" }), undefined, noFallback);
  const { surfaceId, observation } = opened.result;
  assert.equal(observation.surfaceId, surfaceId);
  assert.equal(observation.provider, "chrome");
  const filled = await runtime.cdp(call("Surface.interact", surfaceId, {
    action: "fill", ref: "e1", observationId: observation.observationId, value: "a",
  }), undefined, noFallback);
  assert.equal("pageId" in filled.result, false);
  assert.notEqual(filled.result.observation.observationId, observation.observationId);
  await assert.rejects(runtime.cdp(call("Surface.click", surfaceId, {
    ref: "e1", observationId: observation.observationId,
  }), undefined, noFallback), { code: "stale_observation" });
  const neighbour = runtime.state("chat-a").pages.find(page => page.surfaceId !== surfaceId);
  await assert.rejects(runtime.cdp(call("Surface.click", neighbour.surfaceId, {
    ref: "e1", observationId: filled.result.observation.observationId,
  }), undefined, noFallback), { code: "stale_observation" });
  runtime.releaseRun("run-a");
  await registerBrowserTask(runtime, source("chat-a", "run-b"));
  await assert.rejects(runtime.cdp(call("Surface.handleDialog", surfaceId, {
    dialogId: "dialog-a", observationId: filled.result.observation.observationId, action: "dismiss",
  }, source("chat-a", "run-b")), undefined, noFallback), { code: "stale_observation" });
});

test("multiple visible Chrome windows do not select an arbitrary first page", async () => {
  const { runtime, clients } = fixture();
  await runtime.connect("chat-a");
  await registerBrowserTask(runtime, source());
  clients[0].pages = [
    { pageId: "window-a", title: "Same", url: "https://example.test/", active: true },
    { pageId: "window-b", title: "Same", url: "https://example.test/", active: true },
  ];
  const ambiguous = await runtime.cdp(call("Surface.getCurrent"), undefined, noFallback);
  assert.equal(ambiguous.result.currentSurfaceId, null);
  assert.equal(ambiguous.result.selectionRequired, true);
  const chosen = ambiguous.result.surfaces[1].surfaceId;
  await runtime.cdp(call("Page.bringToFront", chosen), undefined, noFallback);
  assert.equal((await runtime.cdp(call("Surface.getCurrent"), undefined, noFallback)).result.currentSurfaceId, chosen);
  clients[0].pages.reverse();
  assert.equal((await runtime.cdp(call("Surface.getCurrent"), undefined, noFallback)).result.currentSurfaceId, chosen);
});

test("connection labels distinguish Chats without using their raw canonical identity", async () => {
  const { runtime, clients } = fixture();
  await runtime.connect("chat-a");
  await runtime.connect("chat-b");
  const first = clients[0].calls.find(item => item.method === "connect").params.clientName;
  const second = clients[1].calls.find(item => item.method === "connect").params.clientName;
  assert.notEqual(first, second);
  assert.equal(first.includes("chat-a"), false);
  assert.equal(runtime.state("chat-a").connectionName, first);
});

test("WorkPanel runs the same typed interactions as Chrome, while scripts and raw CDP stay unavailable to both", async () => {
  const { runtime } = fixture();
  await registerBrowserTask(runtime, source());
  const forwarded = [];
  const fallback = async () => { forwarded.push(true); return { ok: true, result: { status: "done" } }; };
  await runtime.cdp(call("Surface.scroll", "page:existing", { deltaY: 400 }), undefined, fallback);
  for (const action of ["hover", "type", "press", "check", "uncheck"]) {
    await runtime.cdp(call("Surface.interact", "page:existing", { selector: "#known", action }), undefined, fallback);
  }
  await runtime.cdp(call("Surface.interact", "page:existing", { selector: "#tags", action: "select", values: ["a", "b"] }), undefined, fallback);
  await runtime.cdp(call("Surface.observe", "page:existing", { viewportOnly: true }), undefined, fallback);
  await runtime.cdp(call("Surface.getDownloads", "page:existing"), undefined, fallback);
  assert.equal(forwarded.length, 9);
  for (const method of ["Runtime.evaluate", "DOM.getDocument", "Input.dispatchKeyEvent", "Network.enable"]) {
    await assert.rejects(runtime.cdp(call(method, "page:existing", {}), undefined, fallback), { code: "capability_unavailable" });
  }
  assert.equal(forwarded.length, 9);
});

test("late health results from a released worker cannot disconnect a replacement connection", async () => {
  for (const rejectOld of [false, true]) {
    const { runtime, clients } = fixture();
    await runtime.connect("chat-a");
    const previous = clients[0];
    const original = previous.request.bind(previous);
    let resolve, reject;
    previous.request = (method, ...args) => method === "state"
      ? new Promise((ok, fail) => { resolve = ok; reject = fail; })
      : original(method, ...args);
    const pending = runtime.refreshState("chat-a");
    await runtime.disconnect("chat-a");
    await runtime.connect("chat-a");
    const selected = runtime.state("chat-a").selectedSurfaceId;
    if (rejectOld) reject(new Error("released worker"));
    else resolve({ connected: false });
    await pending;
    assert.equal(runtime.state("chat-a").connection, "connected");
    assert.equal(runtime.state("chat-a").selectedSurfaceId, selected);
  }
});

test("late activation cannot install a retired Surface selection in a new connection", async () => {
  const { runtime, clients } = fixture();
  await runtime.connect("chat-a");
  const previous = clients[0];
  const oldSurface = runtime.state("chat-a").pages[0].surfaceId;
  let finish;
  const original = previous.request.bind(previous);
  previous.request = (method, ...args) => method === "activate"
    ? new Promise(resolve => { finish = resolve; }) : original(method, ...args);
  const pending = runtime.activate("chat-a", oldSurface);
  await runtime.disconnect("chat-a");
  await runtime.connect("chat-a");
  const currentSurface = runtime.state("chat-a").selectedSurfaceId;
  finish({});
  await assert.rejects(pending, { code: "browser_disconnected" });
  assert.equal(runtime.state("chat-a").selectedSurfaceId, currentSurface);
  assert.notEqual(currentSurface, oldSurface);
});
