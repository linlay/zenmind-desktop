import test from "node:test";
import { releaseBrowserTask } from "./helpers/browser-use-task.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url), Module = require("node:module");
const root = path.resolve(import.meta.dirname, ".."), runtimeFile = path.join(root, "src/main/modules/browser-use/runtime.ts");
const bundled = require("esbuild").buildSync({ stdin: { contents: `export {BrowserUseRuntime} from ${JSON.stringify(runtimeFile)};`, resolveDir: root },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" }).outputFiles[0].text;
const runtimeModule = new Module(runtimeFile);
runtimeModule.filename = runtimeFile; runtimeModule.paths = Module._nodeModulePaths(root); runtimeModule._compile(bundled, runtimeFile);
const { BrowserUseRuntime } = runtimeModule.exports;
const source = (chatId = "chat-a", runId = "run-a", agentKey = "cutej") => ({ chatId, runId, agentKey });
const token = "SYNTHETIC_ROUTING_AUTHORIZATION";

function harness(defaultBackend = "workpanel") {
  const clients = [], fallbacks = [], changes = [];
  const runtime = new BrowserUseRuntime({
    preferences: { read: () => ({ defaultBackend, rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true }), authorization: () => token },
    onChanged: state => changes.push(state),
    createClient() {
      const client = { calls: [], pages: [{ pageId: `private-${clients.length}`, url: "https://fixture.test/", title: "Authorized page", active: true }],
        async request(method, params = {}) {
          this.calls.push({ method, params });
          if (method === "connect" || method === "state" || method === "health") return { connected: true, pages: this.pages };
          if (method === "list") return this.pages;
          if (method === "open") { const page = { pageId: `opened-${clients.length}`, url: params.url, title: "Opened" }; this.pages.push(page); return page; }
          return { action: { outcome: "unknown" } };
        }, kill() {}, async disconnect() {} };
      clients.push(client); return client;
    },
  });
  const cdp = (method, params = {}, identity = source(), surfaceId) => runtime.cdp({ method, params, source: identity, surfaceId }, undefined,
    async () => { fallbacks.push({ method, params, surfaceId }); return { ok: true, result: { surfaces: [], ...(method === "Surface.click" ? { action: { outcome: "unknown" } } : {}) } }; });
  const select = (browser, identity = source()) => cdp("Browser.select", { browser }, identity);
  return { runtime, clients, fallbacks, changes, cdp, select };
}

test("explicit WorkPanel overrides a Chrome default without any Chrome connection or approval", async t => {
  const h = harness("chrome"); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source());
  const chosen = await h.select("workpanel");
  assert.equal(chosen.result.provider, "workpanel"); assert.equal(chosen.result.locked, false);
  assert.equal((await h.cdp("Surface.list")).result.provider, "workpanel");
  await h.runtime.action({ action: "desktop.workpanel.openWeb", args: { url: "https://fixture.test" }, source: source() }, undefined, async () => ({ ok: true }));
  assert.equal(h.clients.length, 0); assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
  assert.equal(h.runtime.state("chat-a").backend, "workpanel");
});

test("explicit Chrome overrides WorkPanel and lazily reuses saved authorization", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source());
  await h.select("chrome"); assert.equal(h.clients.length, 0);
  const opened = await h.cdp("Surface.openChrome", { url: "https://fixture.test/new" });
  assert.equal(opened.result.provider, "chrome"); assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].calls.find(call => call.method === "connect").params.extensionToken, token);
  assert.equal(h.fallbacks.length, 0); assert.equal(JSON.stringify([opened, h.changes]).includes(token), false);
});

test("viewport emulation obeys the task gate and never connects or falls back from Chrome", async t => {
  const chrome = harness("chrome"); t.after(() => chrome.runtime.dispose()); chrome.runtime.registerRun(source());
  const viewport = { width: 390, height: 844, mobile: true };
  await chrome.select("chrome");
  await assert.rejects(chrome.cdp("Surface.setViewport", viewport), error => error.code === "capability_unavailable" && /WorkPanel pages only/.test(error.message));
  assert.equal(chrome.clients.length, 0);
  assert.equal(chrome.fallbacks.length, 0);
  assert.equal(chrome.runtime.state("chat-a").connectionRequest, undefined);

  const panel = harness("chrome"); t.after(() => panel.runtime.dispose()); panel.runtime.registerRun(source());
  await panel.select("workpanel");
  await panel.cdp("Surface.setViewport", viewport, source(), "web:owned");
  assert.deepEqual(panel.fallbacks, [{ method: "Surface.setViewport", params: viewport, surfaceId: "web:owned" }]);
  assert.equal(panel.clients.length, 0);
  await assert.rejects(panel.select("chrome"), { code: "browser_target_locked" });
});

test("new Runs and Chats choose their own intent while remembered Chrome pages keep one exclusive workspace", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source()); await h.select("chrome");
  const pages = (await h.cdp("Surface.list")).result.surfaces;
  h.runtime.registerRun(source("chat-b", "run-b")); await h.select("chrome", source("chat-b", "run-b"));
  await assert.rejects(h.cdp("Surface.list", {}, source("chat-b", "run-b")), { code: "browser_busy" });
  await releaseBrowserTask(h.runtime, "run-a");
  assert.equal((await h.cdp("Surface.list", {}, source("chat-b", "run-b"))).result.surfaces[0].surfaceId, pages[0].surfaceId);
  assert.equal(h.clients.length, 1);
  h.runtime.registerRun(source("chat-a", "followup")); await h.select("workpanel", source("chat-a", "followup"));
  assert.equal((await h.cdp("Surface.list", {}, source("chat-a", "followup"))).result.provider, "workpanel");
});

test("legacy UI selection is a candidate and explicit task intent wins before page work", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.select("chat-a", "chrome"); h.runtime.registerRun(source());
  await h.select("workpanel"); assert.equal(h.runtime.state("chat-a").backend, "workpanel");
  assert.equal(h.clients.length, 0);
});

test("a dispatched WorkPanel write or unknown result cannot migrate to Chrome", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source()); await h.select("workpanel");
  assert.equal((await h.cdp("Surface.click", { selector: "button" }, source(), "web:owned")).result.action.outcome, "unknown");
  await assert.rejects(h.select("chrome"), error => error.code === "browser_target_locked" && /write result/.test(error.message));
  assert.equal((await h.select("workpanel")).result.locked, true); assert.equal(h.clients.length, 0);
});

test("a Chrome page request locks the environment and same-browser selection remains idempotent", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source()); await h.select("chrome");
  await h.cdp("Surface.list"); await assert.rejects(h.select("workpanel"), { code: "browser_target_locked" });
  assert.equal((await h.select("chrome")).result.locked, true); assert.equal(h.clients.length, 1);
});

test("a Chrome request entering its handshake cannot be redirected by a concurrent selection", async t => {
  let finish;
  const handshake = new Promise(resolve => { finish = resolve; });
  const runtime = new BrowserUseRuntime({ preferences: { read: () => ({ defaultBackend: "chrome", rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true }), authorization: async () => token },
    createClient: () => ({ async request(method) { if (method === "connect") { await handshake; return { connected: true, pages: [] }; } if (method === "list") return []; }, kill() {}, async disconnect() {} }) });
  t.after(() => runtime.dispose()); runtime.registerRun(source());
  const call = (method, params = {}) => runtime.cdp({ method, params, source: source() }, undefined, async () => { throw new Error("unexpected WorkPanel dispatch"); });
  await call("Browser.select", { browser: "chrome" });
  const pending = call("Surface.list");
  await assert.rejects(call("Browser.select", { browser: "workpanel" }), { code: "browser_target_locked" });
  finish(); assert.equal((await pending).result.provider, "chrome");
});

test("AWCP and legacy WorkPanel open freeze task routing too", async t => {
  for (const route of ["awcp", "action"]) {
    const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source());
    await h.select("workpanel");
    if (route === "awcp") await h.runtime.awcp("manual-1", "AWCP.getManual", {}, source(), new AbortController().signal, "web:owned");
    else await h.runtime.action({ action: "desktop.workpanel.openWeb", args: {}, source: source() }, undefined, async () => ({ ok: true }));
    await assert.rejects(h.select("chrome"), { code: "browser_target_locked" });
  }
});

test("an ordinary Run without a browser choice uses the WorkPanel and never connects Chrome", async t => {
  const h = harness("chrome"); t.after(() => h.runtime.dispose());
  h.runtime.select("chat-a", "chrome"); h.runtime.registerRun(source());
  // A Chrome default and an earlier Chat selection are not a task choice.
  assert.equal((await h.cdp("Surface.list")).result.provider, "workpanel");
  assert.equal(h.runtime.state("chat-a").backend, "workpanel");
  await assert.rejects(h.cdp("Surface.openChrome", { url: "https://fixture.test" }), { code: "browser_backend_mismatch" });
  await assert.rejects(h.runtime.awcp("manual-1", "AWCP.getManual", {}, source(), new AbortController().signal, "chrome:copied"), { code: "browser_run_unavailable" });
  let actionCalls = 0;
  await h.runtime.action({ action: "desktop.workpanel.openWeb", args: { url: "https://fixture.test" }, source: source() }, undefined, async () => { actionCalls++; return { ok: true }; });
  assert.equal(actionCalls, 1); assert.equal(h.clients.length, 0);
  assert.equal(h.runtime.state("chat-a").connectionRequest, undefined);
  await assert.rejects(h.select("chrome"), { code: "browser_target_locked" }, "the implicit WorkPanel binding freezes after page work");
});

test("an explicit Chrome choice before page work still routes a new Run to Chrome", async t => {
  const h = harness("workpanel"); t.after(() => h.runtime.dispose());
  h.runtime.registerRun(source()); assert.equal((await h.cdp("Surface.list")).result.provider, "workpanel");
  h.runtime.releaseRun("run-a"); h.runtime.registerRun(source("chat-a", "followup"));
  await h.select("chrome", source("chat-a", "followup"));
  assert.equal((await h.cdp("Surface.list", {}, source("chat-a", "followup"))).result.provider, "chrome");
  assert.equal(h.clients.length, 1);
});

test("selection cannot forge source, resurrect a released Run, or provide browser connection fields", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source());
  await assert.rejects(h.select("chrome", source("other-chat")), { code: "browser_run_unavailable" });
  await assert.rejects(h.cdp("Browser.select", { browser: "chrome", extensionToken: "untrusted" }), { code: "invalid_args" });
  await assert.rejects(h.select("auto"), { code: "invalid_args" });
  h.runtime.releaseRun("run-a"); await assert.rejects(h.select("chrome"), { code: "browser_run_unavailable" });
  assert.equal(h.clients.length, 0);
});

test("Website and WebApp captured grants reject Browser.select before runtime or page fallback", async () => {
  const file = path.join(root, "src/main/modules/assistant/runtime.ts");
  const parsed = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let property;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "cdp" && ts.isArrowFunction(node.initializer)) property = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed); assert.ok(property);
  let runtimeCalls = 0, fallbackCalls = 0;
  const context = { options: { browserUse: { cdp: async () => { runtimeCalls++; return { ok: true }; } } },
    integration: { handleDesktopCdpRequest: async () => { fallbackCalls++; return { ok: true }; } }, desktopActionOptions: {}, browserUseError: error => error };
  vm.createContext(context);
  const js = ts.transpileModule(`globalThis.invoke = ${property.initializer.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(js, context);
  for (const kind of ["website", "webapp"]) {
    const result = await context.invoke({ method: "Browser.select", params: { browser: "chrome" } }, { kind });
    assert.equal(result.error.code, "browser_scope_locked");
  }
  assert.equal(runtimeCalls, 0); assert.equal(fallbackCalls, 0);
  await context.invoke({ method: "Surface.list" }, { kind: "website" }); assert.equal(fallbackCalls, 1);
  await context.invoke({ method: "Browser.select", params: { browser: "workpanel" } }); assert.equal(runtimeCalls, 1);
});

test("a WorkPanel Run reads only downloads it has seen on that page", async t => {
  const h = harness(); t.after(() => h.runtime.dispose()); h.runtime.registerRun(source());
  const calls = [];
  const call = (method, params, identity = source()) => h.runtime.cdp({ method, params, source: identity, surfaceId: "web:owned" }, undefined, async () => {
    calls.push(method);
    if (method === "Surface.getDownloads") return { ok: true, result: { downloads: [{ downloadId: "d-1", fileName: "a.txt", status: "complete" }] } };
    return { ok: true, result: { downloadId: params.downloadId, released: true } };
  });
  await assert.rejects(call("Surface.readDownload", { downloadId: "d-1" }), { code: "stale_observation" });
  assert.deepEqual(calls, [], "an unseen download is never read");
  await call("Surface.getDownloads", {});
  assert.equal((await call("Surface.readDownload", { downloadId: "d-1" })).result.downloadId, "d-1");
  h.runtime.releaseRun("run-a"); h.runtime.registerRun(source("chat-a", "next"));
  await assert.rejects(call("Surface.releaseDownload", { downloadId: "d-1", sha256: "0".repeat(64) }, source("chat-a", "next")), { code: "stale_observation" });
});

test("passive Chat state and refresh queries allocate no sessions or Chrome workspaces", async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  for (let index = 0; index < 260; index++) {
    assert.equal(h.runtime.state(`viewed-${index}`).backend, "workpanel");
    await h.runtime.refreshState(`viewed-${index}`);
  }
  assert.equal(h.runtime.sessions.size, 0);
  assert.equal(h.runtime.workspaces.size, 0);
  assert.equal(h.clients.length, 0);
});

test("idle session eviction preserves a live shared connection, exact pages and the active owner", async t => {
  const h = harness("chrome"); t.after(() => h.runtime.dispose());
  h.runtime.registerRun(source("busy-chat", "busy-run"));
  await h.select("chrome", source("busy-chat", "busy-run"));
  const surfaces = (await h.cdp("Surface.list", {}, source("busy-chat", "busy-run"))).result.surfaces;
  const workspaceId = h.runtime.state("busy-chat").workspaceId;
  for (let index = 0; index < 260; index++) h.runtime.select(`viewed-${index}`, "chrome");
  assert.equal(h.runtime.sessions.size <= 200, true, `sessions=${h.runtime.sessions.size}`);
  assert.equal(h.runtime.sessions.has("busy-chat"), true, "a Chat with a Run is never pruned");
  assert.equal(h.runtime.sessions.has("viewed-259"), true);
  assert.equal(h.runtime.workspaces.size, 1, "discard superseded empty WorkPanel workspaces");
  assert.equal(h.runtime.state("busy-chat").workspaceOwner.runId, "busy-run");
  assert.deepEqual(h.runtime.state("busy-chat").pages, surfaces);
  assert.equal(h.runtime.state("viewed-0").backend, "workpanel", "an evicted entry has a passive default projection");
  assert.ok(h.changes.some(state => state.chatId === "viewed-0" && state.backend === "workpanel" && !state.workspaceId),
    "a mounted toolbar cannot keep stale controls for an evicted session");
  h.runtime.select("viewed-0", "chrome");
  assert.equal(h.runtime.state("viewed-0").workspaceId, workspaceId);
  assert.deepEqual(h.runtime.state("viewed-0").pages, surfaces);
  assert.equal(h.clients.length, 1);
});

test("finishing a burst of Runs reclaims idle metadata without requiring another Chat to be opened", t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  for (let index = 0; index < 260; index++) h.runtime.registerRun(source(`burst-${index}`, `run-${index}`));
  assert.equal(h.runtime.sessions.size, 260, "active Runs remain protected");
  for (let index = 0; index < 260; index++) h.runtime.releaseRun(`run-${index}`);
  assert.equal(h.runtime.runs.size, 0);
  assert.ok(h.runtime.sessions.size <= 200);
  assert.ok(h.runtime.workspaces.size <= 200);
});
