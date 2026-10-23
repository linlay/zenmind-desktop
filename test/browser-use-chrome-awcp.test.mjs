import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, "build/qa"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "build/qa/chrome-awcp-source-"));
require("esbuild").buildSync({ stdin: { contents: [
  `export {ChromeWorkerEngine} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use/chrome-worker-engine.ts"))};`,
  `export {chromeWorkerResponseError} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use/chrome-worker.ts"))};`,
  `export {buildWebsiteBridgeScript} from ${JSON.stringify(path.join(root, "src/main/modules/web-surfaces/website-bridges/injection-script.ts"))};`,
  `export {parseWebsiteBridgeManifest} from ${JSON.stringify(path.join(root, "src/shared/website-bridge.ts"))};`,
].join("\n"), resolveDir: root }, bundle: true, platform: "node", format: "cjs", packages: "external", outfile: path.join(directory, "fixture.cjs"), logLevel: "silent" });
const { ChromeWorkerEngine, chromeWorkerResponseError, buildWebsiteBridgeScript, parseWebsiteBridgeManifest } = require(path.join(directory, "fixture.cjs"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const flush = () => new Promise(resolve => setImmediate(resolve));
const action = "fixture.read";
const pkg = { manifest: parseWebsiteBridgeManifest({ schemaVersion: 2, id: "fixture", name: "Fixture", version: "1.0.0", origins: { main: "https://fixture.test" }, pages: { page: { path: "/page" } } }),
  scripts: new Map([["pages/page.js", `globalThis.installs = (globalThis.installs || 0) + 1;
return { actions: { 'fixture.read': { title: 'Read fixture', description: 'Read only fixture data.',
 inputSchema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 100 }, wait: { type: 'boolean' }, fail: { type: 'boolean' } } },
 async run(args) { globalThis.calls = (globalThis.calls || 0) + 1; if (args.wait) return new Promise(resolve => { globalThis.slowResolve = resolve; });
 if(args.fail) return {ok:false,error:{code:'action.synthetic_rejection',message:'Fixture rejected this call.'}};
 return {ok:true,result:{count:globalThis.calls,args}}; }
 } }, dispose() { globalThis.disposed = (globalThis.disposed || 0) + 1; } };`]]) };

class Handle {
  constructor(page, value) { this.page = page; this.value = value; }
  async evaluate(fn, arg) { return this.page.functionValue(fn, [this.value, arg instanceof Handle ? arg.value : arg]); }
  async dispose() { this.page.releasedHandles = (this.page.releasedHandles ?? 0) + 1; }
}
class OwnedPage extends EventEmitter {
  constructor(url) {
    super(); this.address = url; this.closed = false; this.evaluations = 0; this.focused = 0; this.clicked = 0;
    const events = new EventTarget();
    this.context = vm.createContext({ URL, URLSearchParams, AbortController, Event, setTimeout, clearTimeout, crypto: webcrypto,
      location: new URL(url), document: { title: "Fixture", body: null },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    this.context.window = this.context; this.context.top = this.context;
    this.frame = { evaluate: fn => this.evaluate(fn) };
  }
  url() { return this.address; }
  isClosed() { return this.closed; }
  mainFrame() { return this.frame; }
  async title() { return "Fixture"; }
  async evaluate(expression, arg) {
    this.evaluations++;
    return structuredClone(await (typeof expression === "string" ? vm.runInContext(expression, this.context) : this.functionValue(expression, [arg])));
  }
  async evaluateHandle(expression) { return new Handle(this, vm.runInContext(expression, this.context)); }
  async functionValue(fn, args) {
    this.context.__fixtureArgs = args;
    const value = vm.runInContext(`(${fn.toString()})(...__fixtureArgs)`, this.context);
    delete this.context.__fixtureArgs; return value;
  }
  navigate(url) { this.address = url; this.context.location = new URL(url); this.emit("framenavigated", this.frame); }
}

async function fixture(t) {
  const pages = [new OwnedPage("https://fixture.test/page"), new OwnedPage("https://fixture.test/page?other=1")];
  const tabs = pages.map((page, index) => ({ desktopPageId: `owned-page-${index}`, page, modalStates: () => [],
    captureSnapshot: async () => ({ ariaSnapshot: "", ariaSnapshotJSON: [{ role: "button", name: "Typed target", ref: "e1" }] }),
    targetLocator: async () => ({ locator: { focus: async () => { page.focused++; }, click: async options => { if (!options?.trial) page.clicked++; } } }),
  }));
  const runOptions = [];
  const controller = { browserContext: { once() {} }, disconnects: 0,
    list: async () => tabs.map(tab => ({ pageId: tab.desktopPageId, title: "Fixture", url: tab.page.url() })),
    describe: async tab => ({ pageId: tab.desktopPageId, title: "Fixture", url: tab.page.url(), active: true }),
    run: async (id, operation, options) => { runOptions.push(options); const tab = tabs.find(tab => tab.desktopPageId === id); if (!tab) throw Object.assign(new Error("gone"), { code: "surface_not_found" }); return operation(tab); },
    async disconnect() { this.disconnects++; },
  };
  const engine = new ChromeWorkerEngine(async () => controller); t.after(() => engine.disconnect());
  await engine.request({ id: "connect", method: "connect" });
  let serial = 0;
  const call = (method, payload = {}, options = {}) => {
    const index = options.page ?? 0, page = pages[index];
    return engine.request({ id: `wire-${++serial}`, method, pageId: tabs[index].desktopPageId, params: {
      requestId: options.requestId ?? `awcp-${serial}`, runId: options.runId ?? "run-a", payload,
      expectedUrl: options.expectedUrl ?? page.url(), bridgeScript: options.script ?? buildWebsiteBridgeScript(page.url(), [pkg]),
    } });
  };
  const directory = options => call("awcp-manual", {}, options);
  const section = (revision, options) => call("awcp-manual", { revision, section: action }, options);
  const invoke = (revision, args = {}, options) => call("awcp-invoke", { revision, action, args }, options);
  return { pages, tabs, engine, controller, runOptions, call, directory, section, invoke };
}

test("Chrome AWCP uses the shared v1 directory, section and invocation contracts with a section-read gate", async t => {
  const f = await fixture(t); const index = await f.directory();
  assert.equal(index.ok, true); assert.equal(index.method, "AWCP.getManual"); assert.deepEqual(index.sections, [{ section: action, title: "Read fixture" }]);
  await assert.rejects(f.invoke(index.revision), error => error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
  const section = await f.section(index.revision); assert.equal(section.section, action); assert.equal(section.inputSchema.type, "object");
  const result = await f.invoke(index.revision, { note: "read" }); assert.equal(result.ok, true); assert.equal(result.result.count, 1);
  const denied = await f.invoke(index.revision, { fail: true }); assert.equal(denied.ok, false); assert.equal(denied.error.code, "action.synthetic_rejection");
  assert.equal(f.pages[0].context.installs, 1, "identical bridge installation is idempotent");
  assert.equal(f.runOptions.every(options => options?.downloadCapture === false), true, "AWCP does not install a download interceptor");
});

test("manual authorization cannot transfer across Run, Page, revision or main-frame navigation", async t => {
  const f = await fixture(t); const index = await f.directory(); await f.section(index.revision);
  for (const options of [{ runId: "run-b" }, { page: 1 }]) await assert.rejects(f.invoke(index.revision, {}, options), error => error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
  await assert.rejects(f.invoke("different-revision"), error => error.code === "awcp_preflight_rejected" && error.details.reason === "stale_revision");
  f.pages[0].navigate("https://fixture.test/page#new-state");
  await assert.rejects(f.invoke(index.revision), error => error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
  const fresh = await f.directory(); await f.section(fresh.revision); assert.equal((await f.invoke(fresh.revision)).ok, true);
  f.pages[0].navigate(f.pages[0].url());
  await assert.rejects(f.invoke(fresh.revision), error => error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
});

test("exact expected URL and bounded private script are checked before any page code runs", async t => {
  const f = await fixture(t);
  await assert.rejects(f.directory({ expectedUrl: "https://fixture.test/elsewhere" }), error => error.code === "awcp_preflight_rejected" && error.details.executionStarted === false);
  await assert.rejects(f.directory({ script: "x".repeat(12 * 1024 * 1024 + 1) }), { code: "awcp_invalid_request" });
  assert.equal(f.pages[0].evaluations, 0);
});

test("disabling and reenabling a bridge cannot resurrect the old section authorization", async t => {
  const f = await fixture(t); const index = await f.directory(); await f.section(index.revision);
  await assert.rejects(f.invoke(index.revision, {}, { script: buildWebsiteBridgeScript(f.pages[0].url(), []) }), { code: "awcp_protocol_unavailable" });
  assert.equal(f.pages[0].context.awcp, undefined);
  await assert.rejects(f.invoke(index.revision), error => error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
  assert.equal(f.pages[0].context.calls, undefined);
  const fresh = await f.directory(); await f.section(fresh.revision); assert.equal((await f.invoke(fresh.revision)).ok, true);
});

test("native AWCP has precedence and refresh/disconnect never invokes a native disposer", async t => {
  const f = await fixture(t);
  await f.pages[0].evaluate(`globalThis.nativeDisposed=0; globalThis.nativeApi={protocolVersion:1,
 manual: request => request?.section ? {revision:'native-1',section:'fixture.read',description:'Native read',inputSchema:{type:'object',properties:{}}}
 : {revision:'native-1',site:{name:'Native',description:'Native fixture'},sections:[{section:'fixture.read',title:'Native read'}]},
 invoke: async request => ({ok:true,requestId:request.requestId,action:request.action,result:{native:true}}),
 dispose:()=>{globalThis.nativeDisposed++}}; globalThis.awcp=globalThis.nativeApi; void 0;`);
  const index = await f.directory(); await f.section(index.revision); assert.equal((await f.invoke(index.revision)).result.native, true);
  await f.engine.request({ id: "refresh", method: "awcp-refresh" });
  assert.equal(await f.pages[0].evaluate("globalThis.awcp===globalThis.nativeApi"), true); assert.equal(f.pages[0].context.nativeDisposed, 0);
  await f.engine.disconnect(); assert.equal(f.pages[0].context.nativeDisposed, 0);
});

test("Run release bypasses the Worker queue, cancels a pending page invocation and leaves Chrome usable", async t => {
  const f = await fixture(t); const index = await f.directory(); await f.section(index.revision);
  const pending = f.invoke(index.revision, { wait: true }, { requestId: "pending-release" });
  const rejected = assert.rejects(pending, { code: "site_control_unavailable" });
  for (let i = 0; i < 30 && !f.pages[0].context.slowResolve; i++) await flush();
  assert.equal(typeof f.pages[0].context.slowResolve, "function");
  await f.engine.request({ id: "release", method: "awcp-release-run", params: { runId: "run-a" } }); await rejected;
  assert.equal((await f.engine.request({ id: "state", method: "state" })).connected, true);
  await assert.rejects(f.directory(), { code: "site_control_unavailable" });
  const next = await f.directory({ runId: "run-b" }); await f.section(next.revision, { runId: "run-b" });
  assert.equal((await f.invoke(next.revision, {}, { runId: "run-b" })).ok, true);
});

test("refresh cancels in-flight AWCP and rejects pre-refresh queued requests without reinstalling an old bridge", async t => {
  const f = await fixture(t); const index = await f.directory(); await f.section(index.revision);
  const pending = f.invoke(index.revision, { wait: true }, { requestId: "pending-refresh" }); const rejected = assert.rejects(pending, { code: "awcp_cancelled" });
  for (let i = 0; i < 30 && !f.pages[0].context.slowResolve; i++) await flush();
  const queued = f.directory({ requestId: "queued-old-configuration" });
  const queuedRejected = assert.rejects(queued, error => error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
  await f.engine.request({ id: "refresh", method: "awcp-refresh" }); await Promise.all([rejected, queuedRejected]);
  assert.equal(f.pages[0].context.awcp, undefined); assert.equal(f.pages[0].context.installs, 1);
  assert.equal((await f.engine.request({ id: "state", method: "state" })).connected, true);
  const fresh = await f.directory(); await f.section(fresh.revision); assert.equal((await f.invoke(fresh.revision)).ok, true);
});

test("an injection reply arriving after refresh cleans only its own installed state", async t => {
  const f = await fixture(t); const evaluateHandle = f.pages[0].evaluateHandle.bind(f.pages[0]);
  let release, delayed = false;
  f.pages[0].evaluateHandle = async expression => {
    const handle = await evaluateHandle(expression);
    if (!delayed && expression.includes("__desktopAwcpBefore")) { delayed = true; await new Promise(resolve => { release = resolve; }); }
    return handle;
  };
  const pending = f.directory(); const rejected = assert.rejects(pending, { code: "awcp_cancelled" });
  for (let i = 0; i < 30 && !release; i++) await flush();
  assert.equal(f.pages[0].context.awcp?.protocolVersion, 1);
  await f.engine.request({ id: "refresh-installing", method: "awcp-refresh" }); await rejected;
  release(); await flush(); await flush();
  assert.equal(f.pages[0].context.awcp, undefined, "a cancelled late injection cannot remain installed after refresh");
});

test("a cancelled old injection cannot dispose a new bridge installed after refresh", async t => {
  const f = await fixture(t); const evaluateHandle = f.pages[0].evaluateHandle.bind(f.pages[0]);
  let release, delayed = false;
  f.pages[0].evaluateHandle = async expression => {
    const handle = await evaluateHandle(expression);
    if (!delayed && expression.includes("__desktopAwcpBefore")) { delayed = true; await new Promise(resolve => { release = resolve; }); }
    return handle;
  };
  const pending = f.directory(); const rejected = assert.rejects(pending, { code: "awcp_cancelled" });
  for (let i = 0; i < 30 && !release; i++) await flush();
  await f.engine.request({ id: "refresh-new-install", method: "awcp-refresh" }); await rejected;
  const changed = { ...pkg, manifest: { ...pkg.manifest, version: "1.0.1" } };
  const script = buildWebsiteBridgeScript(f.pages[0].url(), [changed]);
  const index = await f.directory({ script }); await f.section(index.revision, { script });
  release(); await flush(); await flush();
  assert.equal(f.pages[0].context.awcp?.protocolVersion, 1);
  assert.equal((await f.invoke(index.revision, {}, { script })).ok, true);
});

test("connection disposal cancels pending AWCP and removes only the host-injected bridge", async t => {
  const f = await fixture(t); const index = await f.directory(); await f.section(index.revision);
  const pending = f.invoke(index.revision, { wait: true }); const rejected = assert.rejects(pending, { code: "awcp_cancelled" });
  for (let i = 0; i < 30 && !f.pages[0].context.slowResolve; i++) await flush();
  await f.engine.disconnect(); await rejected;
  assert.equal(f.pages[0].isClosed(), false); assert.equal(f.pages[0].context.awcp, undefined); assert.equal(f.controller.disconnects, 1);
});

test("closed or crashed pages release AWCP bindings, navigation listeners and owned remote handles", async t => {
  for (const event of ["close", "crash"]) {
    const f = await fixture(t); await f.directory(); const released = f.pages[0].releasedHandles ?? 0;
    if (event === "close") f.pages[0].closed = true;
    f.pages[0].emit(event); await flush();
    assert.equal(f.engine.awcp.pages.has(f.tabs[0].desktopPageId), false);
    assert.equal(f.engine.awcp.bindings.get("run-a")?.has(f.tabs[0].desktopPageId), false);
    assert.equal(f.pages[0].listenerCount("request"), 0);
    assert.equal(f.pages[0].releasedHandles, released + 1);
  }
});

test("AWCP invocation invalidates typed references, while reading manuals preserves them", async t => {
  const f = await fixture(t);
  const first = await f.engine.request({ id: "typed-observe", method: "observe", pageId: f.tabs[0].desktopPageId });
  const index = await f.directory(); await f.section(index.revision);
  const focused = await f.engine.request({ id: "typed-focus", method: "interact", pageId: f.tabs[0].desktopPageId,
    params: { action: "focus", observationId: first.observationId, ref: "e1" } });
  assert.equal(f.pages[0].focused, 1);
  await f.invoke(index.revision);
  await assert.rejects(f.engine.request({ id: "stale-after-awcp", method: "interact", pageId: f.tabs[0].desktopPageId,
    params: { action: "focus", observationId: focused.observation.observationId, ref: "e1" } }), { code: "stale_observation" });
  const fresh = await f.engine.request({ id: "typed-reobserve", method: "observe", pageId: f.tabs[0].desktopPageId });
  await f.engine.request({ id: "typed-new-focus", method: "interact", pageId: f.tabs[0].desktopPageId,
    params: { action: "focus", observationId: fresh.observationId, ref: "e1" } }); assert.equal(f.pages[0].focused, 2);
});

test("the same page supports typed click, AWCP section and invoke, then fresh typed observation and click", async t => {
  const f = await fixture(t), pageId = f.tabs[0].desktopPageId;
  const first = await f.engine.request({ id: "first-observe", method: "observe", pageId });
  const clicked = await f.engine.request({ id: "first-click", method: "click", pageId, params: { ref: "e1", observationId: first.observationId } });
  assert.equal(clicked.action.outcome, "complete"); assert.equal(f.pages[0].clicked, 1);
  const index = await f.directory(); await f.section(index.revision); assert.equal((await f.invoke(index.revision)).ok, true);
  await assert.rejects(f.engine.request({ id: "stale-click", method: "click", pageId, params: { ref: "e1", observationId: clicked.observation.observationId } }), { code: "stale_observation" });
  const fresh = await f.engine.request({ id: "fresh-observe", method: "observe", pageId });
  const next = await f.engine.request({ id: "fresh-click", method: "click", pageId, params: { ref: "e1", observationId: fresh.observationId } });
  assert.equal(next.action.outcome, "complete"); assert.equal(f.pages[0].clicked, 2);
  assert.equal((await f.engine.request({ id: "still-same", method: "list" }))[0].pageId, pageId);
});

test("public Host errors preserve safe status/details and never expose upstream URL or credential text", async t => {
  const f = await fixture(t), marker = "SYNTHETIC_PRIVATE_UPSTREAM_VALUE";
  await f.pages[0].evaluate(`globalThis.awcp={protocolVersion:'https://${marker}.invalid/?token=${marker}',manual(){},invoke(){}}; void 0;`);
  let failure; try { await f.directory(); } catch (error) { failure = chromeWorkerResponseError(error, "awcp-manual"); }
  assert.equal(failure.code, "awcp_unsupported_protocol"); assert.equal(failure.statusCode, 502);
  assert.deepEqual(failure.details, { supportedVersions: [1], actualVersion: "string" }); assert.equal(JSON.stringify(failure).includes(marker), false);
  await f.pages[0].evaluate(`globalThis.awcp={protocolVersion:1,manual(){throw Error('https://${marker}.invalid/?token=${marker}')},invoke(){}}; void 0;`);
  try { await f.directory(); } catch (error) { failure = chromeWorkerResponseError(error, "awcp-manual"); }
  assert.equal(failure.code, "awcp_transport_failed"); assert.equal(failure.statusCode, 502); assert.equal(JSON.stringify(failure).includes(marker), false);
});
