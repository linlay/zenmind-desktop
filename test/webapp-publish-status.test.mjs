import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourcePath = path.resolve("src/renderer/pages/settings/webappPublishPresentation.ts");
const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath
}).outputText;
const mod = { exports: {} };
new Function("exports", "require", "module", source)(mod.exports, require, mod);
const { getWebappPublishPresentation } = mod.exports;

test("publication labels distinguish configuration, app runtime, and Tunnel connectivity", () => {
  const published = { id: "app", active: true, status: "published" };
  const running = { status: "running" };
  for (const [state, info, runtime, label] of [
    [undefined, undefined, undefined, "publishStatusChecking"],
    [null, undefined, undefined, "publishStatusNotPublished"],
    [published, { tunnelConnected: true }, undefined, "publishStatusChecking"],
    [published, { tunnelConnected: true }, { status: "stopped" }, "publishAppStopped"],
    [published, undefined, running, "publishStatusChecking"],
    [published, { tunnelConnected: false }, running, "publishTunnelOffline"],
    [published, { tunnelConnected: true }, running, "publishStatusTunnelConnected"]
  ]) assert.equal(getWebappPublishPresentation(state, info, runtime).label, `settings.webapps.${label}`);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual AppShell owner functions without mounting unrelated desktop services.
const shellSource = fs.readFileSync(path.resolve("src/renderer/app-shell/AppShell.tsx"), "utf8");
const shell = ts.createSourceFile("AppShell.tsx", shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["refreshWebItems", "refreshWebappPublishState", "handleWebappPublishStatusChange",
  "refreshWebappRuntimeState", "handleWebappRuntimeStateChange"];
const functions = [];
function collect(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(shell));
  else ts.forEachChild(node, collect);
}
collect(shell);
assert.equal(functions.length, names.length);
const ownerSource = ts.transpileModule(functions.join("\n"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function fixture() {
  let state = {}, info = null, runtime = {};
  const publishReads = [], runtimeReads = [], listReads = [], disposed = [];
  const items = { current: ["app", "other"].map(id => ({ id, kind: "webapp" })) };
  const context = {
    window: { electronAPI: { webs: {
      list: () => { const r = deferred(); listReads.push(r); return r.promise; },
      webapps: {
        getPublishStatus: id => { const r = deferred(); publishReads.push({ id, ...r }); return r.promise; },
        getStatus: id => { const r = deferred(); runtimeReads.push({ id, ...r }); return r.promise; }
      }
    } } },
    webItemsRef: items,
    webItemsRefreshIdRef: { current: 0 },
    webappPublishRefreshIdRef: { current: {} },
    webappPublishInfoRefreshIdRef: { current: 0 },
    webappRuntimeRefreshIdRef: { current: {} },
    webappStartInFlightRef: { current: new Set() }, webappStopInFlightRef: { current: new Set() },
    setWebappPublishStateById: update => { state = update(state); },
    setWebappPublishInfo: value => { info = value; },
    setWebappRuntimeById: update => { runtime = update(runtime); },
    disposeWebappPresentation: item => disposed.push(item.id),
    updateWebItems: next => { items.current = next; }
  };
  const owner = new Function(...Object.keys(context), `${ownerSource}\nreturn { ${names.join(",")} };`)(...Object.values(context));
  return { ...owner, items, publishReads, runtimeReads, listReads, disposed, info: () => info, state: () => state, runtime: () => runtime };
}
const response = connected => ({ info: { tunnelConnected: connected }, state: { id: "app", active: true } });

test("one Tunnel status read updates shared connectivity and a delayed response cannot restore it", async () => {
  const h = fixture();
  const old = h.refreshWebappPublishState("app");
  const latest = h.refreshWebappPublishState("other");
  h.publishReads[1].resolve(response(false));
  await latest;
  h.publishReads[0].resolve(response(true));
  await old;
  assert.equal(h.info().tunnelConnected, false);
  assert.deepEqual(Object.keys(h.state()).sort(), ["app", "other"]);
});

test("an explicit publish result invalidates an older read and catalog snapshot", async () => {
  const h = fixture();
  const read = h.refreshWebappPublishState("app");
  const catalog = h.refreshWebItems();
  h.handleWebappPublishStatusChange("app", response(true));
  h.publishReads[0].resolve(response(false));
  await read;
  assert.equal(h.info().tunnelConnected, true);
  h.listReads[0].resolve({ ok: true, items: [{ id: "app", kind: "webapp" }], webappPublishStates: { app: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state().app.active, true);
  h.publishReads[1].resolve(response(true));
  h.runtimeReads[0].resolve({ ok: true, state: { status: "running" } });
  await catalog;
});

test("a current failure clears shared connectivity; removed applications ignore late reads", async () => {
  const h = fixture();
  h.handleWebappPublishStatusChange("app", response(true));
  const read = h.refreshWebappPublishState("app");
  h.publishReads[0].reject(new Error("unavailable"));
  await assert.rejects(read, /unavailable/);
  assert.equal(h.info(), null);
  const removed = h.refreshWebappPublishState("app");
  h.items.current = [];
  h.publishReads[1].resolve(response(true));
  await removed;
  assert.equal(h.info(), null);
});

test("stop and uninstall commit once, dispose presentation and invalidate older runtime reads", async () => {
  const h = fixture();
  for (const state of [{ status: "stopped", webUrl: "", message: "stopped" }, null]) {
    const read = h.refreshWebappRuntimeState("app");
    h.handleWebappRuntimeStateChange("app", state);
    h.runtimeReads.at(-1).resolve({ ok: true, state: { status: "running", webUrl: "http://stale" } });
    await read;
    assert.equal(h.runtime().app?.state ?? null, state);
  }
  assert.deepEqual(h.disposed, ["app", "app"]);
});

test("Settings consumes owner state and has no catalog status reads or duplicate subscriptions", () => {
  const settings = fs.readFileSync(path.resolve("src/renderer/pages/settings/SettingsPage.tsx"), "utf8");
  assert.doesNotMatch(settings, /setWebappRuntimeById|infoById|useWebappPublishStatus|webapps\.getStatus|webapps\.getPublishStatus/);
  assert.match(shellSource, /event\.reason === "tunnel-status-changed"[\s\S]*?refreshWebappPublishState\(\)/);
  assert.match(shellSource, /webappRuntimeById=\{webappRuntimeStates\}/);
});


test("a failed start with no runtime stays in error instead of triggering an automatic start loop", async () => {
  const h = fixture();
  const read = h.refreshWebappRuntimeState("app");
  h.handleWebappRuntimeStateChange("app", null, "failed to start", "error");
  h.runtimeReads[0].resolve({ ok: true, state: { status: "running" } });
  await read;
  assert.equal(h.runtime().app.status, "error");
  assert.equal(h.runtime().app.message, "failed to start");
});


test("shared status retains the exact installed application identity, including spaces", async () => {
  const h = fixture();
  const id = " 中文 app ";
  h.items.current = [{ id, kind: "webapp" }];
  const read = h.refreshWebappRuntimeState(id);
  h.runtimeReads[0].resolve({ ok: true, state: { status: "running" } });
  await read;
  assert.deepEqual(Object.keys(h.runtime()), [id]);
  h.handleWebappPublishStatusChange(id, response(true));
  assert.deepEqual(Object.keys(h.state()), [id]);
});
