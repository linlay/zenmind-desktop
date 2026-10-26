import { registerBrowserTask } from "./helpers/browser-use-task.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { patchBrowserUseUpstream } from "../scripts/browser-use-patch.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const chrome = process.env.BROWSER_USE_TEST_CHROME_FOR_TESTING;
const extension = process.env.BROWSER_USE_TEST_EXTENSION ?? path.join(root, "build/browser-use-fixture/extension");
const extensionOrigin = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm";

// This helper is exclusively for targets in the fresh fixture-owned profile. No
// user browser process, profile, installed credential or debugging endpoint is read.
async function evaluateOwnedTarget(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned extension fixture evaluation timed out")), 5000);
      socket.addEventListener("message", event => {
        const response = JSON.parse(String(event.data)); if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails) reject(new Error("Owned extension fixture evaluation failed"));
        else resolve(response.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}

test("official saved authorization connects independent Chat groups without Allow/select and rejects an invalid credential", {
  skip: !chrome || !fs.existsSync(path.join(extension, "manifest.json")), timeout: 60_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-extension-remembered-"));
  const originalSpawn = childProcess.spawn;
  const engines = [], controllers = [], openedConnections = [], publicResults = [];
  let browserProcess, server, endpoint, runtime;
  try {
    // Replay the production patch only in a private dependency copy. Never stage
    // or mutate the application's shared coreBundle while another build may run.
    for (const name of ["playwright-core", "playwright", "@playwright/mcp"]) {
      const target = path.join(directory, "node_modules", name); fs.mkdirSync(path.dirname(target), { recursive: true });
      if (name === "playwright-core") fs.cpSync(path.join(root, "node_modules", name), target, { recursive: true });
      else { fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(path.join(root, "node_modules", name, "package.json"), path.join(target, "package.json")); }
    }
    const packageDir = patchBrowserUseUpstream(directory);
    const api = require(path.join(packageDir, "lib/coreBundle.js")).__desktopBrowserUse;
    const modules = path.join(directory, "modules"); fs.mkdirSync(modules);
    require("esbuild").buildSync({ stdin: { contents: [
      ["ChromeWorkerEngine", "chrome-worker-engine"], ["chromeWorkerResponseError", "chrome-worker"], ["BrowserUseRuntime", "runtime"],
    ].map(([name, file]) => `export {${name}} from ${JSON.stringify(path.join(root, "src/main/modules/browser-use", `${file}.ts`))};`).join("\n"), resolveDir: root },
      bundle: true, platform: "node", format: "cjs", packages: "external", outfile: path.join(modules, "host.cjs"), logLevel: "silent" });
    const { ChromeWorkerEngine, chromeWorkerResponseError, BrowserUseRuntime } = require(path.join(modules, "host.cjs"));
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8")); assert.equal(manifest.version, "0.4.0");
    server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>${request.url === "/a" ? "Owned Chat A" : "Owned Chat B"}</title><h1>Owned saved-authorization fixture</h1><button onclick="this.textContent='Clicked exactly once';document.title='Clicked fixture'">Increment counter</button>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`, profile = path.join(directory, "owned-profile"); fs.mkdirSync(profile);
    browserProcess = originalSpawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-mock-keychain", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(25);
    assert.equal(fs.existsSync(portFile), true, "owned CfT must expose its fixture debugging endpoint");
    endpoint = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
    const statusTarget = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(`${extensionOrigin}/status.html`)}`, { method: "PUT" })).json();
    let authorization;
    for (let i = 0; i < 200 && !authorization; i++) {
      authorization = await evaluateOwnedTarget(statusTarget, "(() => { try { return localStorage.getItem('auth-token'); } catch { return null; } })()");
      if (!authorization) await delay(25);
    }
    assert.equal(typeof authorization === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(authorization), true, "the fresh owned extension generates a valid temporary credential");
    // Headless Chrome's open-URL launch is redirected only into this owned
    // instance. No chooser button is clicked: the official extension validates
    // the token and creates the connection's fresh group itself.
    childProcess.spawn = (executable, args, options) => {
      const connect = args.find(value => String(value).startsWith(`${extensionOrigin}/connect.html?`));
      if (!connect) return originalSpawn(executable, args, options);
      const url = new URL(connect), name = JSON.parse(url.searchParams.get("client")).name;
      const connection = { name, hasToken: url.searchParams.has("token"), target: undefined };
      openedConnections.push(connection);
      void fetch(`${endpoint}/json/new?${encodeURIComponent(connect)}`, { method: "PUT" }).then(response => response.json()).then(target => { connection.target = target; });
      return { unref() {} };
    };
    const engine = () => {
      const item = new ChromeWorkerEngine(async options => {
        const controller = await api.create({ ...options, extensionBrowser: { executablePath: chrome, userDataDir: profile } });
        controllers.push(controller); return controller;
      });
      engines.push(item); return item;
    };
    const a = engine(), b = engine();
    for (const [item, name] of [[a, "Owned saved Chat A"], [b, "Owned saved Chat B"]]) {
      const connected = await item.request({ id: `${name}-connect`, method: "connect", params: { clientName: name, extensionToken: authorization } });
      publicResults.push(connected);
      assert.deepEqual(connected.pages, [], "only the internal helper is initially present; no other Chat page is adopted");
      assert.equal(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined, "adapter removes its private environment credential after each handshake");
      const target = openedConnections.find(entry => entry.name === name)?.target;
      assert.equal(!!target, true);
      let status;
      for (let i = 0; i < 200; i++) {
        status = await evaluateOwnedTarget(target, "({ connected: document.body?.innerText.includes('connected.') === true, allowButtons: [...document.querySelectorAll('button')].filter(button => button.textContent === 'Allow & select').length })");
        if (status.connected) break;
        await delay(25);
      }
      assert.equal(status.connected, true); assert.equal(status.allowButtons, 0);
    }
    const aOpened = await a.request({ id: "a-open", method: "open", params: { url: `${origin}/a` } }); publicResults.push(aOpened);
    assert.deepEqual(await b.request({ id: "b-does-not-inherit-a", method: "list" }), []);
    const bOpened = await b.request({ id: "b-open", method: "open", params: { url: `${origin}/b` } }); publicResults.push(bOpened);
    assert.notEqual(aOpened.pageId, bOpened.pageId);
    for (const [item, opened, other] of [[a, aOpened, bOpened], [b, bOpened, aOpened]]) {
      await item.request({ id: "activate-own-page", method: "activate", pageId: opened.pageId });
      const observed = await item.request({ id: "observe", method: "observe", pageId: opened.pageId }); publicResults.push(observed);
      const button = observed.elements.find(element => element.role === "button" && element.name === "Increment counter"); assert.equal(!!button, true);
      const clicked = await item.request({ id: "click", method: "click", pageId: opened.pageId, params: { observationId: observed.observationId, ref: button.ref } }); publicResults.push(clicked);
      assert.equal(clicked.action?.outcome, "complete", JSON.stringify({ status: clicked.status, stage: clicked.stage, error: clicked.error }));
      assert.equal(clicked.observation.text.includes("Clicked exactly once"), true);
      const list = await item.request({ id: "list-own-page", method: "list" }); publicResults.push(list);
      assert.equal(list.length, 1); assert.equal(list[0].pageId, opened.pageId);
      await assert.rejects(item.request({ id: "cross-chat", method: "observe", pageId: other.pageId }), { code: "surface_not_found" });
    }
    // A saved connection can be healthy while a copied local-sandbox URL is no
    // longer served. Exercise this through the real official extension; it must
    // remain a website failure and must not replay/open a replacement page.
    const closedServer = http.createServer(); closedServer.listen(0, "127.0.0.1"); await once(closedServer, "listening");
    const closedPort = closedServer.address().port; await new Promise(resolve => closedServer.close(resolve));
    const existing = new Set(controllers[0].browserContext.pages());
    await assert.rejects(a.request({ id: "unavailable-local-page", method: "open", params: { url: `http://127.0.0.1:${closedPort}/fixture?private=SYNTHETIC_QUERY` } }), error => {
      const result = chromeWorkerResponseError(error, "open"); publicResults.push(result);
      return result.code === "page_connection_refused" && !JSON.stringify(result).includes("SYNTHETIC_QUERY");
    });
    const created = controllers[0].browserContext.pages().filter(page => !existing.has(page));
    assert.equal(created.length, 1, "a rejected navigation creates no automatic replacement tab");
    assert.equal(created[0].isClosed(), false, "navigation errors do not close a potentially executed page");
    assert.equal((await a.request({ id: "connection-survives-page-failure", method: "state" })).connected, true);
    const recovered = await a.request({ id: "healthy-address-after-service-error", method: "open", params: { url: `${origin}/recovered` } });
    publicResults.push(recovered);
    assert.equal(recovered.url, `${origin}/recovered`, "the same saved connection opens a healthy website after the target website fails");
    const runtimeClients = [];
    runtime = new BrowserUseRuntime({ clientName: "Owned Runtime lifecycle",
      preferences: { read: () => ({ defaultBackend: "chrome", rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true }), authorization: () => authorization },
      createClient() {
        const worker = engine();
        const client = { worker, calls: [],
          request(method, params, pageId, signal) {
            this.calls.push({ method, ...(method === "open" ? { url: params.url } : {}) });
            if (signal?.aborted) return Promise.reject(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }));
            return new Promise((resolve, reject) => {
              const abort = () => { reject(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" })); void worker.disconnect(); };
              signal?.addEventListener("abort", abort, { once: true });
              worker.request({ id: crypto.randomUUID(), method, params, pageId }).then(result => {
                signal?.removeEventListener("abort", abort); resolve(result);
              }, error => {
                signal?.removeEventListener("abort", abort); const safe = chromeWorkerResponseError(error, method); reject(Object.assign(new Error(safe.message), { code: safe.code }));
              });
            });
          },
          async disconnect() { await worker.disconnect(); }, kill() { void worker.disconnect(); },
        };
        runtimeClients.push(client); return client;
      },
    });
    const firstRun = { chatId: "owned-lifecycle-chat", runId: "dead-first-run", agentKey: "cutej" };
    const nextRun = { ...firstRun, runId: "healthy-next-run" };
    const fallback = async () => { throw new Error("Chrome lifecycle must not fall back to WorkPanel"); };
    await registerBrowserTask(runtime, firstRun);
    await assert.rejects(runtime.cdp({ source: firstRun, method: "Surface.openChrome", params: { url: `http://127.0.0.1:${closedPort}/dead-first` } }, undefined, fallback), { code: "page_connection_refused" });
    runtime.releaseRun(firstRun.runId);
    await delay(3500); // The official extension's final-tab detach/reattach window is 2.5 seconds.
    const workerStateAfterRunEnd = await runtimeClients[0].worker.request({ id: "post-run-worker-health", method: "state" });
    t.diagnostic(`Fresh dead-page first Run completed: workerConnected=${workerStateAfterRunEnd.connected}, mainConnected=${runtime.state(firstRun.chatId).connection === "connected"}.`);
    // Some native Chrome detach paths close the Engine without exiting its utility
    // process. Exercise that precise state through this profile's official
    // extension disconnect command, rather than inventing a fake health flag.
    const clientName = runtime.state(firstRun.chatId).connectionName;
    const officiallyDisconnected = await evaluateOwnedTarget(statusTarget, `(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
      const connection = status.connections.find(item => item.clientName === ${JSON.stringify(clientName)});
      if (!connection) return false;
      await chrome.runtime.sendMessage({ type: 'disconnect', connectionId: connection.id });
      return true;
    })()`);
    assert.equal(officiallyDisconnected, true);
    let staleWorkerState;
    for (let i = 0; i < 200; i++) {
      staleWorkerState = await runtimeClients[0].worker.request({ id: "closed-worker-health", method: "state" });
      if (!staleWorkerState.connected) break;
      await delay(25);
    }
    assert.equal(staleWorkerState.connected, false);
    assert.equal(runtime.state(firstRun.chatId).connection, "connected", "Main must verify the engine instead of assuming a live worker is connected");
    await registerBrowserTask(runtime, nextRun);
    const continued = await runtime.cdp({ source: nextRun, method: "Surface.openChrome", params: { url: `${origin}/runtime-recovered` } }, undefined, fallback);
    publicResults.push(continued);
    assert.equal(continued.result.surface.url, `${origin}/runtime-recovered`, "same Chat's new Run must open the healthy URL without a manual connection");
    assert.equal(runtimeClients.length, 2, "the stale engine is replaced once, before the healthy navigation is dispatched");
    assert.equal(runtimeClients.reduce((sum, client) => sum + client.calls.filter(call => call.method === "open" && call.url.endsWith("/dead-first")).length, 0), 1, "the failed navigation is never replayed during reconnection");
    runtime.releaseRun(nextRun.runId);
    const invalid = crypto.randomBytes(32).toString("base64url"), wrong = engine();
    let rejected;
    const pending = wrong.request({ id: "wrong-token", method: "connect", params: { clientName: "Owned invalid authorization", extensionToken: invalid } });
    const handled = pending.catch(error => { rejected = chromeWorkerResponseError(error, "connect"); });
    let invalidStatus;
    for (let i = 0; i < 200; i++) {
      const target = openedConnections.find(entry => entry.name === "Owned invalid authorization")?.target;
      if (target) {
        invalidStatus = await evaluateOwnedTarget(target, "({ invalid: document.body?.innerText.includes('Invalid token provided.') === true, allowButtons: [...document.querySelectorAll('button')].filter(button => button.textContent === 'Allow & select').length })");
        if (invalidStatus.invalid) break;
      }
      await delay(25);
    }
    assert.equal(invalidStatus?.invalid, true, "official extension must reject the credential before interactive fallback");
    assert.equal(invalidStatus.allowButtons, 0);
    const cancelStarted = Date.now(); await wrong.disconnect(); await handled;
    assert.equal(Date.now() - cancelStarted < 2000, true, "private cancellation bounds the rejected handshake");
    assert.equal(rejected?.code, "cancelled"); publicResults.push(rejected);
    for (const name of ["Owned saved Chat A", "Owned saved Chat B", "Owned invalid authorization"])
      assert.equal(openedConnections.filter(entry => entry.name === name).length, 1, "each explicit connection or rejected attempt uses exactly one handshake");
    assert.equal(openedConnections.every(entry => entry.hasToken), true);
    assert.equal(JSON.stringify(publicResults).includes(authorization), false); assert.equal(JSON.stringify(publicResults).includes(invalid), false);
    for (const item of [a, b]) await item.disconnect();
    assert.equal(browserProcess.exitCode, null, "releasing both Chat connections preserves Chrome until fixture cleanup");
    t.diagnostic("Official Extension 0.4.0: two fresh token-authorized groups, zero chooser clicks, filtered helper pages, isolated open/observe/click, closed-local-service failure classification without replay/close, invalid-token rejection, bounded cancellation, and no credential output passed.");
  } finally {
    childProcess.spawn = originalSpawn;
    runtime?.dispose();
    await Promise.allSettled(engines.map(item => item.disconnect()));
    if (browserProcess?.exitCode === null) { browserProcess.kill(); await Promise.race([once(browserProcess, "exit"), delay(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
