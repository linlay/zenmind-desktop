import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { patchBrowserUseUpstream } from "../scripts/browser-use-patch.mjs";

const root = path.resolve(import.meta.dirname, ".."), require = createRequire(import.meta.url);
const chrome = process.env.BROWSER_USE_TEST_CHROME_FOR_TESTING;
const archivePath = process.env.BROWSER_USE_TEST_AWCP_ZIP;
const extension = process.env.BROWSER_USE_TEST_EXTENSION ?? path.join(root, "build/browser-use-fixture/extension");
const extensionOrigin = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm";

async function ownedEvaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned extension status timed out")), 5000);
      socket.addEventListener("message", event => {
        const result = JSON.parse(String(event.data)); if (result.id !== 1) return;
        clearTimeout(timer);
        if (result.error || result.result?.exceptionDetails) reject(new Error("Owned extension status failed"));
        else resolve(result.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  } finally { socket.close(); }
}

test("official Chrome Worker supports mixed typed and AWCP tools with the unchanged forum ZIP and offline same-origin reads", {
  skip: !chrome || !archivePath || !fs.existsSync(archivePath) || !fs.existsSync(path.join(extension, "manifest.json")), timeout: 90_000,
}, async t => {
  fs.mkdirSync(path.join(root, "build/qa"), { recursive: true });
  const working = fs.mkdtempSync(path.join(root, "build/qa/chrome-awcp-official-"));
  const originalSpawn = childProcess.spawn, checks = {}, network = [];
  let browserProcess, engine, controller, resumeSlow;
  try {
    const archiveSha = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    const exports = [
      ["ChromeWorkerEngine", "browser-use/chrome-worker-engine"], ["chromeWorkerResponseError", "browser-use/chrome-worker"],
      ["readWebsiteBridgeArchive", "web-surfaces/website-bridges/archive"], ["buildWebsiteBridgeScript", "web-surfaces/website-bridges/injection-script"],
    ].map(([name, file]) => `export {${name}} from ${JSON.stringify(path.join(root, "src/main/modules", `${file}.ts`))};`).join("\n");
    require("esbuild").buildSync({ stdin: { contents: exports, resolveDir: root }, bundle: true, platform: "node", format: "cjs", packages: "external", outfile: path.join(working, "host.cjs"), logLevel: "silent" });
    const { ChromeWorkerEngine, readWebsiteBridgeArchive, buildWebsiteBridgeScript } = require(path.join(working, "host.cjs"));
    const pkg = await readWebsiteBridgeArchive(archivePath); assert.equal(pkg.manifest.id, "1024forum"); assert.equal(pkg.scripts.size, 12);
    checks.unchangedProductionValidatedZip = true;
    for (const name of ["playwright-core", "playwright", "@playwright/mcp"]) {
      const target = path.join(working, "node_modules", name); fs.mkdirSync(path.dirname(target), { recursive: true });
      if (name === "playwright-core") fs.cpSync(path.join(root, "node_modules", name), target, { recursive: true });
      else { fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(path.join(root, "node_modules", name, "package.json"), path.join(target, "package.json")); }
    }
    const packageDir = patchBrowserUseUpstream(working), api = require(path.join(packageDir, "lib/coreBundle.js")).__desktopBrowserUse;
    const profile = path.join(working, "owned-profile"); fs.mkdirSync(profile);
    browserProcess = originalSpawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(25);
    const endpoint = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
    const status = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(extensionOrigin + "/status.html")}`, { method: "PUT" })).json();
    let token;
    for (let i = 0; i < 200 && !token; i++) { token = await ownedEvaluate(status, "(() => { try { return localStorage.getItem('auth-token'); } catch { return null; } })()"); if (!token) await delay(25); }
    assert.equal(typeof token === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(token), true);
    childProcess.spawn = (executable, args, options) => {
      const connect = args.find(arg => String(arg).startsWith(`${extensionOrigin}/connect.html?`));
      if (!connect) return originalSpawn(executable, args, options);
      void fetch(`${endpoint}/json/new?${encodeURIComponent(connect)}`, { method: "PUT" }); return { unref() {} };
    };
    engine = new ChromeWorkerEngine(async options => {
      // The offline fixture's Playwright route owns Fetch. Download capture is
      // outside this test; production AWCP already opts out of that hook.
      controller = await api.create({ ...options, onBeforeOperation: undefined, extensionBrowser: { executablePath: chrome, userDataDir: profile } });
      return controller;
    });
    await engine.request({ id: "connect", method: "connect", params: { extensionToken: token, clientName: "Owned production AWCP fixture" } });
    token = undefined; childProcess.spawn = originalSpawn;
    const origin = "https://1024.qiuer.net";
    let slowSeen; const sawSlow = new Promise(resolve => { slowSeen = resolve; });
    await controller.browserContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()); network.push({ method: request.method(), origin: url.origin, path: url.pathname });
      if (request.method() !== "GET") { await route.abort("blockedbyclient"); return; }
      if (url.origin === origin && url.pathname === "/forum") {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Owned AWCP fixture</title><button onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);this.textContent='Typed clicked '+this.dataset.count">Typed step</button>` }); return;
      }
      if (url.origin === origin && url.pathname === "/forum/api/v1/posts") {
        if (url.searchParams.get("keyword") === "SLOW_OFFLINE") { slowSeen(); await new Promise(resolve => { resumeSlow = resolve; }); }
        try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ id: 900001, title: "Owned offline post" }], nextCursor: null }) }); } catch { /* An AWCP cancel aborts the intercepted read. */ }
        return;
      }
      await route.abort("blockedbyclient");
    });
    const opened = await engine.request({ id: "open", method: "open", params: { url: `${origin}/forum` } }), pageId = opened.pageId;
    let serial = 0;
    const awcp = (method, payload, runId = "run-a", script = buildWebsiteBridgeScript(`${origin}/forum`, [pkg])) => engine.request({ id: `wire-${++serial}`, method, pageId,
      params: { requestId: `owned-request-${serial}`, runId, payload, expectedUrl: `${origin}/forum`, bridgeScript: script } });
    const observe = () => engine.request({ id: `observe-${++serial}`, method: "observe", pageId });
    const click = observation => {
      const button = observation.elements.find(element => element.role === "button");
      return engine.request({ id: `click-${++serial}`, method: "click", pageId, params: { observationId: observation.observationId, ref: button.ref } });
    };
    const before = await observe(); const first = await click(before); assert.equal(first.action.outcome, "complete");
    const index = await awcp("awcp-manual", {}); assert.equal(index.method, "AWCP.getManual");
    await assert.rejects(awcp("awcp-invoke", { revision: index.revision, action: "forum.posts.list", args: {} }), error => error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
    const section = await awcp("awcp-manual", { revision: index.revision, section: "forum.posts.list" }); assert.equal(section.section, "forum.posts.list");
    const response = await awcp("awcp-invoke", { revision: index.revision, action: "forum.posts.list", args: { keyword: "POC_OFFLINE" } });
    assert.equal(response.ok, true); assert.equal(response.result.items[0].title, "Owned offline post");
    await assert.rejects(click(first.observation), { code: "stale_observation" });
    const fresh = await observe(); const second = await click(fresh); assert.equal(second.action.outcome, "complete");
    assert.equal(second.observation.text.includes("Typed clicked 2"), true);
    checks.samePageMixedTypedManualSectionInvokeObserveClick = true;
    const slow = awcp("awcp-invoke", { revision: index.revision, action: "forum.posts.list", args: { keyword: "SLOW_OFFLINE" } });
    const cancelled = assert.rejects(slow, { code: "site_control_unavailable" }); await sawSlow;
    await engine.request({ id: "release-run", method: "awcp-release-run", params: { runId: "run-a" } }); await cancelled; resumeSlow(); resumeSlow = undefined;
    assert.equal((await engine.request({ id: "state-after-release", method: "state" })).connected, true);
    checks.realRunReleaseCancelsReadWithoutDisconnect = true;
    const next = await awcp("awcp-manual", {}, "run-b"); await awcp("awcp-manual", { revision: next.revision, section: "forum.posts.list" }, "run-b");
    assert.equal((await awcp("awcp-invoke", { revision: next.revision, action: "forum.posts.list", args: {} }, "run-b")).ok, true);
    await engine.request({ id: "bridge-refresh", method: "awcp-refresh" });
    assert.equal(await controller.run(pageId, tab => tab.page.evaluate("globalThis.awcp === undefined"), { downloadCapture: false }), true);
    await assert.rejects(awcp("awcp-invoke", { revision: next.revision, action: "forum.posts.list", args: {} }, "run-b"), error => error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
    await assert.rejects(awcp("awcp-manual", {}, "run-b", buildWebsiteBridgeScript(`${origin}/forum`, [])), { code: "awcp_protocol_unavailable" });
    checks.disabledBridgeAndRefreshInvalidateManual = true;
    const reenabled = await awcp("awcp-manual", {}, "run-b"); await awcp("awcp-manual", { revision: reenabled.revision, section: "forum.posts.list" }, "run-b");
    await engine.request({ id: "same-url-reload", method: "reload", pageId });
    await assert.rejects(awcp("awcp-invoke", { revision: reenabled.revision, action: "forum.posts.list", args: {} }, "run-b"), error => error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
    checks.sameUrlReloadRejectsOldBinding = true;
    await controller.run(pageId, tab => tab.page.evaluate(`globalThis.__zenmindWebsiteBridge?.dispose(); globalThis.nativeDisposals=0;
      globalThis.nativeApi={protocolVersion:1,manual:request=>request?.section?{revision:'native-1',section:'native.read',description:'Native fixture',inputSchema:{type:'object',properties:{}}}:{revision:'native-1',site:{name:'Native',description:'Native fixture'},sections:[{section:'native.read',title:'Read native'}]},
      invoke:async request=>({ok:true,requestId:request.requestId,action:request.action,result:{native:true}}),dispose:()=>globalThis.nativeDisposals++};globalThis.awcp=globalThis.nativeApi;void 0;`), { downloadCapture: false });
    const native = await awcp("awcp-manual", {}, "run-b"); assert.equal(native.site.name, "Native");
    await awcp("awcp-manual", { revision: native.revision, section: "native.read" }, "run-b");
    assert.equal((await awcp("awcp-invoke", { revision: native.revision, action: "native.read", args: {} }, "run-b")).result.native, true);
    await engine.request({ id: "native-refresh", method: "awcp-refresh" });
    const nativeState = await controller.run(pageId, tab => tab.page.evaluate("({same:globalThis.awcp===globalThis.nativeApi,disposals:globalThis.nativeDisposals})"), { downloadCapture: false });
    assert.deepEqual(nativeState, { same: true, disposals: 0 }); checks.nativeAwcpNotOverriddenOrDisposed = true;
    assert.equal(network.every(request => request.method === "GET" && request.origin === origin), true);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"), archiveSha); checks.originalArchiveUnchanged = true;
    await engine.disconnect(); assert.equal(browserProcess.exitCode, null); checks.chromePreservedUntilFixtureCleanup = true;
    fs.writeFileSync(path.join(root, "build/qa/browser-use/chrome-awcp-official-evidence.json"), JSON.stringify({ status: "PASS", checkedAt: new Date().toISOString(), archiveSha256: archiveSha,
      transport: "Production ChromeWorkerEngine AWCP methods and official Extension 0.4.0; owned CfT profile; offline route owns Fetch so fixture download hook is disabled", checks, requests: network }, null, 2) + "\n");
    t.diagnostic(`Production AWCP Worker with official extension: ${Object.keys(checks).length} checks passed; forum requests were offline GET mocks only.`);
  } finally {
    childProcess.spawn = originalSpawn; resumeSlow?.(); await engine?.disconnect().catch(() => {});
    if (browserProcess?.exitCode === null) { browserProcess.kill(); await Promise.race([once(browserProcess, "exit"), delay(3000)]); }
    fs.rmSync(working, { recursive: true, force: true });
  }
});
