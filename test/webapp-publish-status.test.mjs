import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.join(process.cwd(), "src/renderer/pages/settings/useWebappPublishStatus.ts");
const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath
}).outputText;
function load(react = require("react")) {
  const mod = { exports: {} };
  new Function("exports", "require", "module", source)(mod.exports, name => name === "react" ? react : require(name), mod);
  return mod.exports;
}
const { getWebappPublishPresentation } = load();

test("publication labels distinguish configuration, app runtime, and Tunnel connectivity", () => {
  const published = { id: "app", active: true, status: "published" };
  const running = { status: "running" };
  const cases = [
    [undefined, undefined, undefined, "publishStatusChecking"],
    [null, undefined, undefined, "publishStatusNotPublished"],
    [published, { tunnelConnected: true }, undefined, "publishStatusChecking"],
    [published, { tunnelConnected: true }, { status: "stopped" }, "publishAppStopped"],
    [published, undefined, running, "publishStatusChecking"],
    [published, { tunnelConnected: false }, running, "publishTunnelOffline"],
    [published, { tunnelConnected: true }, running, "publishStatusTunnelConnected"]
  ];
  for (const [state, info, runtime, label] of cases) {
    assert.equal(getWebappPublishPresentation(state, info, runtime).label, `settings.webapps.${label}`);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function mount(t, active = true) {
  let state;
  let cleanup;
  let listener;
  let unsubscribed = 0;
  const pending = [];
  const changes = [];
  const errors = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { electronAPI: { webs: {
    webapps: { getPublishStatus: () => { const request = deferred(); pending.push(request); return request.promise; } },
    onChanged: callback => { listener = callback; return () => { unsubscribed++; }; }
  } } } });
  const hooks = {
    useState: initial => { state = initial; return [initial, update => { state = update(state); }]; },
    useRef: current => ({ current }),
    useCallback: callback => callback,
    useEffect: effect => { cleanup = effect(); }
  };
  const { useWebappPublishStatus } = load(hooks);
  const api = useWebappPublishStatus(active, [{ id: "app" }], (id, next) => changes.push([id, next]), message => errors.push(message));
  const unmount = () => { cleanup?.(); cleanup = undefined; };
  t.after(() => { unmount(); if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else delete globalThis.window; });
  return { api, pending, changes, errors, state: () => state, event: event => listener?.(event), unmount, unsubscribed: () => unsubscribed };
}
const response = connected => ({ info: { tunnelConnected: connected }, state: { id: "app", active: true } });

test("Tunnel changes refresh publication status and a delayed read cannot restore stale connectivity", async t => {
  const h = mount(t);
  h.event({ reason: "tunnel-status-changed" });
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(response(false));
  await flush();
  h.pending[0].resolve(response(true));
  await flush();
  assert.equal(h.state().app.tunnelConnected, false);
  assert.equal(h.changes.length, 1);
  h.event({ webappId: "unrelated", reason: "route-synced" });
  assert.equal(h.pending.length, 2);
});

test("an explicit publish result invalidates an older status read", async t => {
  const h = mount(t);
  h.api.accept("app", response(true));
  h.pending[0].resolve(response(false));
  await flush();
  assert.equal(h.state().app.tunnelConnected, true);
  assert.equal(h.changes.length, 1);
});

test("a current read failure cannot keep displaying a previous connected status", async t => {
  const h = mount(t);
  h.pending[0].resolve(response(true));
  await flush();
  h.event({ reason: "tunnel-status-changed" });
  h.pending[1].reject(new Error("status unavailable"));
  await flush();
  assert.equal(h.state().app, null);
  assert.deepEqual(h.errors, ["status unavailable"]);
});

test("unmount unsubscribes and ignores delayed success and failure", async t => {
  const h = mount(t);
  h.event({ reason: "tunnel-status-changed" });
  h.unmount();
  h.pending[0].resolve(response(true));
  h.pending[1].reject(new Error("late read failure"));
  await flush();
  assert.equal(h.unsubscribed(), 1);
  assert.equal(h.changes.length, 0);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.state(), {});
});

test("inactive settings do not subscribe or read publication state", t => {
  const h = mount(t, false);
  assert.equal(h.pending.length, 0);
  assert.equal(h.unsubscribed(), 0);
});
