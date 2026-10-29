import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { createShareReceiverRouter } = require("../dist-electron/main/modules/shares/receiver.js");
const { registerMarketShareReceiver, marketShareRoute } = require("../dist-electron/main/modules/marketplace/share-receiver.js");
const { saveMarketSettings } = require("../dist-electron/main/modules/marketplace/market-settings.js");
const shared = require("../dist-electron/shared/market-share.js");
const context = (id = "connector-one", version = "1.2.3") => ({ itemId: id, resourceType: "connector", resourceVersion: version, display: { name: "Frozen " + id, description: "Frozen details", author: "Publisher", tags: ["mcp"] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-share-receiver-"));
  const app = { getPath: name => name === "appData" ? path.join(root, "app-data") : root };
  saveMarketSettings(app, { enabled: true, apiBaseUrl: "https://market.example.test/api/v1", ...settings });
  const handlers = new Map(), subscriptions = new Set(), sent = [], navigation = [];
  const frame = { url: "http://localhost:5173/#/" }, contents = { mainFrame: frame, isDestroyed: () => false,
    send(channel, value) { sent.push({ channel, value }); for (const listener of subscriptions) listener(value); } };
  const window = { webContents: contents, isDestroyed: () => false }; const event = { sender: contents, senderFrame: frame };
  const descriptions = new Map();
  const router = createShareReceiverRouter({ timeoutMs: 300, resolve: async id => ({ protocolVersion: 1, id, kind: "market-resource", title: "Frozen", actions: ["desktop"], desktop: { receiverId: "builtin.market", contextVersion: 1, context: descriptions.get(id) || context(id) } }) });
  let publications = 0;
  const ipc = { handle(name, listener) { if (handlers.has(name)) throw new Error("duplicate"); handlers.set(name, listener); }, removeHandler: name => handlers.delete(name) };
  const dispose = registerMarketShareReceiver({ app, ipc, shares: { registerReceiver: router.register, publish: async () => { publications++; return { ok: false, message: "fixture" }; } }, getMainWindow: () => window,
    navigate: route => { navigation.push(route); frame.url = "http://localhost:5173/#" + route; } });
  const api = {
    shareReady: async input => handlers.get("market.shareReady")?.(event, input),
    shareAck: async input => handlers.get("market.shareAck")?.(event, input),
    shareRelease: async input => handlers.get("market.shareRelease")?.(event, input),
    onShareReceive: listener => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
  };
  t.after(() => { dispose(); router.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, router, handlers, subscriptions, sent, navigation, frame, contents, event, descriptions, api, publications: () => publications };
}
function activation(f) { return new URL(f.navigation.at(-1), "https://desktop.invalid").searchParams.get("shareActivation"); }
function pageHook(api, onReceive) {
  const previous = globalThis.window; globalThis.window = { electronAPI: { market: api } };
  const hooks = []; let cursor = 0, effect;
  const react = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [hooks[i].value, () => {}]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(fn) { cursor++; effect = fn; },
  };
  const source = fs.readFileSync(new URL("../src/renderer/pages/functional-market/useMarketShareReceiver.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => name === "react" ? react : name.endsWith("shared/market-share") ? shared : assert.fail(name), module, module.exports);
  let close;
  return { mount(id, strict = false) { close?.(); cursor = 0; module.exports.useMarketShareReceiver(id, onReceive); if (strict) effect()?.(); close = effect(); }, close() { close?.(); globalThis.window = previous; } };
}

test("real market page handshake accepts context before the ready response, survives StrictMode and handles same-page opens", async t => {
  const f = fixture(t); const accepted = [], delayedReady = deferred(); let readyCalls = 0;
  const api = { ...f.api, shareReady: async input => { readyCalls++; const result = await f.api.shareReady(input); await delayedReady.promise; return result; } };
  const page = pageHook(api, value => accepted.push(value));
  t.after(() => page.close());
  const first = f.router.receive("one"); await tick(); page.mount(activation(f), true); await tick();
  assert.equal((await first).status, "received"); assert.equal(readyCalls, 1);
  assert.equal(accepted[0].context.itemId, "one"); assert.equal(f.subscriptions.size, 1);
  delayedReady.resolve(); await tick();
  const second = f.router.receive("two"); await tick(); page.mount(activation(f)); await tick();
  assert.equal((await second).status, "received"); assert.deepEqual(accepted.map(value => value.context.itemId), ["one", "two"]);
  assert.notEqual(accepted[0].intentId, accepted[1].intentId); assert.equal(f.publications(), 0);
});

test("guest frames and forged acknowledgements cannot complete a handoff", async t => {
  const f = fixture(t); const operation = f.router.receive("one"); await tick(); const activationId = activation(f);
  const foreign = { sender: {}, senderFrame: f.frame };
  assert.throws(() => f.handlers.get("market.shareReady")(foreign, { activationId, instanceId: randomUUID() }), /rejected/);
  await assert.rejects(f.handlers.get("market.shareItem")(foreign, { itemId: "one", resourceVersion: "1.2.3" }), /rejected/); assert.equal(f.publications(), 0);
  const ready = await f.api.shareReady({ activationId, instanceId: randomUUID() }); await tick();
  const delivery = f.sent[0].value;
  for (const changed of [{ generation: "wrong" }, { intentId: "wrong" }, { activationId: "wrong" }, { status: {} }]) {
    assert.equal(await f.api.shareAck({ activationId, generation: ready.generation, intentId: delivery.target.intentId, status: "received", ...changed }), false);
  }
  assert.equal(await f.api.shareAck({ activationId, generation: ready.generation, intentId: delivery.target.intentId, status: "received" }), true);
  assert.equal((await operation).status, "received");
});

test("replacement page instances and releases terminate only their own activation", async t => {
  const f = fixture(t); const first = f.router.receive("one"); await tick(); const oldActivation = activation(f);
  const oldReady = await f.api.shareReady({ activationId: oldActivation, instanceId: randomUUID() });
  assert.equal(await f.api.shareReady({ activationId: oldActivation, instanceId: randomUUID() }), null);
  assert.equal((await first).status, "unavailable");
  const second = f.router.receive("two"); await tick(); const currentActivation = activation(f);
  await f.api.shareRelease({ activationId: oldActivation, generation: oldReady.generation });
  assert.equal(await f.api.shareReady({ activationId: oldActivation, instanceId: randomUUID() }), null);
  const ready = await f.api.shareReady({ activationId: currentActivation, instanceId: randomUUID() }); await tick();
  const delivery = f.sent.at(-1).value;
  await f.api.shareAck({ activationId: currentActivation, generation: ready.generation, intentId: delivery.target.intentId, status: "received" });
  assert.equal((await second).status, "received");
});

test("invalid market contexts do not reach the page, and disabled Market ends without activation", async t => {
  const f = fixture(t); f.descriptions.set("bad", { ...context(), resourceType: "mcp" });
  const operation = f.router.receive("bad"); await tick();
  await f.api.shareReady({ activationId: activation(f), instanceId: randomUUID() });
  assert.equal((await operation).status, "invalid_context"); assert.equal(f.sent.length, 0);
  saveMarketSettings(f.app, { enabled: false, apiBaseUrl: "https://market.example.test/api/v1" });
  const count = f.navigation.length; assert.equal((await f.router.receive("one")).status, "unavailable"); assert.equal(f.navigation.length, count);
});

test("market route binding accepts Desktop hash routes and rejects wrong or duplicate activation identities", () => {
  const id = randomUUID();
  for (const base of ["file:///app/index.html#/market", "http://localhost:5173/#/market", "https://desktop.invalid/market"]) assert.equal(marketShareRoute(base + "?shareActivation=" + id, id), true);
  for (const value of ["http://localhost/#/skills?shareActivation=" + id, "http://localhost/#/market?shareActivation=other", "http://localhost/#/market?shareActivation=" + id + "&shareActivation=" + id]) assert.equal(marketShareRoute(value, id), false);
});

test("partial IPC registration failure releases the receiver and preserves an existing handler", async () => {
  const router = createShareReceiverRouter({ resolve: async () => ({ protocolVersion: 1, id: "one", actions: ["desktop"], desktop: { receiverId: "builtin.market", contextVersion: 1, context: context() } }) });
  const existing = () => {}; const handlers = new Map([["market.shareReady", existing]]);
  assert.throws(() => registerMarketShareReceiver({ app: {}, shares: { registerReceiver: router.register, publish() {} }, ipc: {
    handle(name, handler) { if (handlers.has(name)) throw new Error("duplicate"); handlers.set(name, handler); }, removeHandler: name => handlers.delete(name),
  }, getMainWindow: () => null, navigate() {} }), /duplicate/);
  assert.deepEqual([...handlers], [["market.shareReady", existing]]); assert.equal((await router.receive("one")).status, "unsupported"); router.dispose();
});
