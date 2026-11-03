import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const Module = require("node:module");
const bundled = require("esbuild").buildSync({
  stdin: {
    contents: ["chrome-backend", "chrome-worker-engine"].map(file =>
      `export * from ${JSON.stringify(path.join(root, "src/main/modules/browser-use", `${file}.ts`))};`).join("\n"),
    resolveDir: root,
  },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent",
}).outputFiles[0].text;
let fork;
const electron = { app: { getAppPath: () => root }, utilityProcess: { fork: () => fork() } };
const source = new Module(path.join(root, "test/request-lifetime-source.cjs"));
source.filename = path.join(root, "test/request-lifetime-source.cjs");
source.paths = Module._nodeModulePaths(root);
source.require = id => id === "electron" ? electron : require(id);
source._compile(bundled, source.filename);
const { ChromeBackend, ChromeWorkerEngine } = source.exports;

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const page = { pageId: "original-page", url: "https://fixture.test/original", title: "Preserved page" };

function controller(overrides = {}) {
  return {
    browserContext: { once() {}, browser: () => ({ isConnected: () => true }) },
    list: async () => [page],
    open: async url => ({ pageId: "new-page", url, title: "New page" }),
    run: async () => { throw Object.assign(new Error("No snapshot in this transport fixture"), { code: "surface_not_found" }); },
    disconnect: async () => {},
    ...overrides,
  };
}

function pair(t, factory) {
  const engine = new ChromeWorkerEngine(factory);
  const child = new EventEmitter();
  const messages = [], replies = [], exits = [];
  let ignore = () => false, killed = false, kills = 0;
  const reply = value => {
    if (killed) return;
    replies.push(value);
    child.emit("message", value);
  };
  child.postMessage = request => {
    messages.push(request);
    if (ignore(request)) return;
    void engine.request(request, () => reply({ id: request.id, started: true })).then(
      result => reply({ id: request.id, result }),
      error => reply({ id: request.id, error: { code: error.code ?? "fixture_error", message: error.message } }),
    );
  };
  child.kill = () => { killed = true; kills++; child.emit("exit", 0); };
  fork = () => { queueMicrotask(() => child.emit("spawn")); return child; };
  const backend = new ChromeBackend({ workerPath: path.join(root, "package.json"), onExit: code => exits.push(code) });
  t.after(async () => { backend.kill(); await engine.disconnect(); });
  return {
    backend, engine, child, messages, replies, exits,
    get kills() { return kills; },
    setIgnore(value) { ignore = value; },
    async advance(ms) { t.mock.timers.tick(ms); await flush(); },
  };
}

test("queued 44 seconds then executing 2 seconds keeps its own execution budget and the same connection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const first = deferred(), second = deferred();
  let lists = 0, armed = false, connects = 0;
  const f = pair(t, async () => {
    connects++;
    return controller({ list: async () => !armed ? [page] : ++lists === 1 ? first.promise : second.promise });
  });
  await f.backend.request("connect");
  armed = true;
  const a = f.backend.request("list"), b = f.backend.request("list");
  await flush();
  const requests = f.messages.filter(message => message.method === "list");
  assert.equal(f.replies.some(reply => reply.id === requests[1].id && reply.started), false);
  await f.advance(44_000);
  first.resolve([page]);
  await a; await flush();
  assert.equal(f.replies.some(reply => reply.id === requests[1].id && reply.started), true);
  await f.advance(2_000);
  second.resolve([page]);
  assert.deepEqual(await b, [page]);
  await f.backend.drain();
  assert.equal(connects, 1);
  assert.equal(f.kills, 0);
});

test("queue expiry cancels an unstarted write and acknowledges it before preceding work finishes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const connecting = deferred();
  let opens = 0;
  const f = pair(t, () => connecting.promise);
  const connect = f.backend.request("connect");
  const queued = f.backend.request("open", { url: "https://fixture.test/submit" });
  const rejected = assert.rejects(queued, error => error.code === "browser_action_timeout" && error.details.phase === "queue");
  await flush();
  const wire = f.messages.find(message => message.method === "open");
  await f.advance(45_000);
  await rejected;
  assert.equal(f.replies.some(reply => reply.id === wire.id && reply.started), false);
  assert.equal(f.replies.some(reply => reply.id === wire.id && reply.error?.code === "cancelled"), true);
  assert.equal(opens, 0);
  assert.equal(f.kills, 0);
  connecting.resolve(controller({ open: async url => { opens++; return { ...page, url }; } }));
  await connect; await f.backend.drain();
  assert.equal(opens, 0, "the queued request cannot run after its cancellation was acknowledged");
  assert.deepEqual(await f.backend.request("list"), [page]);
});

test("an executing timeout keeps real drain, ignores its late result and never replays the write", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const opening = deferred();
  let opens = 0, connects = 0;
  const f = pair(t, async () => { connects++; return controller({ open: () => { opens++; return opening.promise; } }); });
  await f.backend.request("connect");
  const write = f.backend.request("open", { url: "https://fixture.test/submit" });
  let delivered = false;
  void write.then(() => { delivered = true; }, () => {});
  const rejected = assert.rejects(write, error => error.code === "browser_action_timeout" && error.details.outcome === "unknown");
  await flush(); await f.advance(45_000); await rejected;
  let drained = false;
  const drain = f.backend.drain().then(() => { drained = true; });
  for (let index = 0; index < 12; index++) await f.advance(5_000);
  assert.equal(drained, false);
  assert.equal(f.kills, 0);
  assert.ok(f.messages.some(message => message.method === "health"));
  opening.resolve({ ...page, pageId: "created-once", url: "https://fixture.test/submit" });
  await drain;
  assert.equal(delivered, false);
  assert.equal(opens, 1);
  assert.equal(connects, 1);
  assert.deepEqual(await f.backend.request("list"), [page]);
  assert.equal(f.kills, 0);
});

test("a responsive Worker may finish a long transfer copy without detaching at an RPC or drain deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const copying = deferred();
  let disconnects = 0;
  const f = pair(t, async () => controller({ disconnect: async () => { disconnects++; } }));
  await f.backend.request("connect");
  // The capture layer separately tests real response copying. Here its still-active
  // cleanup promise crosses the actual Engine/transport lifecycle without a browser.
  const finishTransfers = f.engine.transfers.endRun.bind(f.engine.transfers);
  f.engine.transfers.endRun = () => copying.promise.then(finishTransfers);
  const cleanup = f.backend.request("release-transfers");
  const rejected = assert.rejects(cleanup, { code: "browser_action_timeout" });
  await flush(); await f.advance(45_000); await rejected;
  let drained = false;
  const drain = f.backend.drain().then(() => { drained = true; });
  for (let index = 0; index < 40; index++) await f.advance(5_000);
  assert.equal(drained, false);
  assert.equal(disconnects, 0);
  assert.equal(f.kills, 0);
  copying.resolve(); await drain;
  assert.deepEqual(await f.backend.request("list"), [page]);
  assert.equal(f.kills, 0);
});

test("a Worker that stops answering priority controls is finally released within the health deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const listing = deferred();
  let armed = false;
  const f = pair(t, async () => controller({ list: () => armed ? listing.promise : Promise.resolve([page]) }));
  await f.backend.request("connect"); armed = true;
  const pending = f.backend.request("list");
  const rejected = assert.rejects(pending, { code: "browser_action_timeout" });
  await flush();
  f.setIgnore(request => ["health", "cancel-request", "disconnect"].includes(request.method));
  await f.advance(45_000); await rejected;
  assert.equal(f.kills, 0);
  await f.advance(5_000);
  await f.advance(1_500);
  await f.backend.drain();
  assert.equal(f.kills, 1);
  assert.deepEqual(f.exits, [-1]);
  await assert.rejects(f.backend.request("list"), { code: "browser_disconnected" });
  listing.resolve([page]);
});

test("cancelling a sent health request keeps its original control deadline and releases an unresponsive Worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = pair(t, async () => controller());
  await f.backend.request("connect");
  f.setIgnore(request => ["health", "disconnect"].includes(request.method));
  const abort = new AbortController();
  const health = f.backend.request("health", undefined, undefined, abort.signal);
  const rejected = assert.rejects(health, { code: "cancelled" });
  assert.ok(f.messages.some(message => message.method === "health"));
  await f.advance(1_000);
  abort.abort(); await rejected;
  let drained = false;
  const drain = f.backend.drain().then(() => { drained = true; });
  await f.advance(3_999);
  assert.equal(drained, false);
  assert.equal(f.kills, 0);
  assert.equal(f.messages.some(message => message.method === "disconnect"), false);
  await f.advance(1);
  assert.equal(drained, false, "the original request drains only after a real response or process release");
  assert.ok(f.messages.some(message => message.method === "disconnect"), "the original 5s deadline survives caller cancellation");
  await f.advance(1_500);
  await drain;
  assert.equal(f.kills, 1);
  assert.deepEqual(f.exits, [-1]);
});

test("a cancelled health request's late acknowledgement drains it without disconnecting a healthy Worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = pair(t, async () => controller());
  await f.backend.request("connect");
  f.setIgnore(request => request.method === "health");
  const abort = new AbortController();
  const health = f.backend.request("health", undefined, undefined, abort.signal);
  let delivered = false;
  void health.then(() => { delivered = true; }, () => {});
  const rejected = assert.rejects(health, { code: "cancelled" });
  const wire = f.messages.find(message => message.method === "health");
  await f.advance(1_000);
  abort.abort(); await rejected;
  let drained = false;
  const drain = f.backend.drain().then(() => { drained = true; });
  await f.advance(3_000);
  assert.equal(drained, false);
  f.child.emit("message", { id: wire.id, result: { healthy: true, connected: true } });
  await drain;
  await f.advance(10_000);
  assert.equal(delivered, false, "a cancelled caller never receives a late result");
  assert.equal(f.kills, 0);
  assert.equal(f.messages.some(message => message.method === "disconnect"), false);
  assert.deepEqual(await f.backend.request("list"), [page]);
});

test("cancelling an unsent health request removes it immediately without a later control timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = pair(t, async () => controller());
  const abort = new AbortController();
  const health = f.backend.request("health", undefined, undefined, abort.signal);
  const rejected = assert.rejects(health, { code: "cancelled" });
  abort.abort(); await rejected;
  await f.backend.drain();
  await f.advance(6_000);
  assert.equal(f.messages.length, 0, "the cancelled request was never posted when the Worker spawned");
  assert.equal(f.kills, 0);
});

test("late callbacks from a released Worker cannot report a second exit or affect its replacement", async t => {
  const old = pair(t, async () => controller());
  await old.backend.request("connect");
  old.backend.kill();
  const fresh = pair(t, async () => controller());
  await fresh.backend.request("connect");
  old.child.emit("exit", 15);
  old.child.emit("spawn");
  old.child.emit("message", { id: old.messages[0].id, result: { pages: ["old result"] } });
  assert.deepEqual(old.exits, [-1]);
  assert.deepEqual(fresh.exits, []);
  assert.deepEqual(await fresh.backend.request("list"), [page]);
  assert.equal(fresh.kills, 0);
});

test("health returns connected transport state immediately while a slow page list occupies the queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const listing = deferred();
  let armed = false, lists = 0;
  const f = pair(t, async () => controller({ list: () => {
    lists++;
    return armed ? listing.promise : Promise.resolve([page]);
  } }));
  await f.backend.request("connect"); armed = true;
  const pending = f.backend.request("list");
  let completed = false;
  void pending.then(() => { completed = true; });
  await flush();
  await f.advance(6_000);
  const startedAt = Date.now();
  assert.deepEqual(await f.backend.request("health"), { healthy: true, connected: true });
  assert.equal(Date.now(), startedAt, "health does not wait for queued page metadata or a deadline");
  assert.equal(completed, false);
  assert.equal(lists, 2, "connect and the explicit list are the only page metadata reads");
  assert.equal(f.kills, 0);
  listing.resolve([page]);
  assert.deepEqual(await pending, [page]);
});

test("health distinguishes a responsive Worker from disconnected or closed Chrome without reading pages", async t => {
  let connected = true, lists = 0;
  const context = new EventEmitter();
  context.browser = () => ({ isConnected: () => connected });
  const f = pair(t, async () => controller({ browserContext: context, list: async () => { lists++; return [page]; } }));
  assert.deepEqual(await f.engine.request({ id: "unconnected-health", method: "health" }), { healthy: true, connected: false });
  await f.backend.request("connect");
  await assert.rejects(f.engine.request({ id: "page-health", method: "health", pageId: "original-page" }), { code: "invalid_params" });
  assert.deepEqual(await f.backend.request("health"), { healthy: true, connected: true });
  connected = false;
  assert.deepEqual(await f.backend.request("health"), { healthy: true, connected: false });
  connected = true;
  context.emit("close");
  assert.deepEqual(await f.backend.request("health"), { healthy: true, connected: false });
  assert.equal(lists, 1, "only connect reads pages; all health checks use cached transport state");
});
