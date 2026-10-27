import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
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
async function evaluateChooser(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  try { return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture chooser timed out")), 5000);
    socket.addEventListener("message", event => {
      const data = JSON.parse(String(event.data)); if (data.id !== 1) return;
      clearTimeout(timer);
      if (data.error || data.result?.exceptionDetails) reject(new Error("Fixture chooser command failed"));
      else resolve(data.result?.result?.value);
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  }); } finally { socket.close(); }
}

test("official extension copies explicit downloads and preserves ordinary browser downloads across a shared connection", {
  skip: !chrome || !fs.existsSync(path.join(extension, "manifest.json")), timeout: 90_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-extension-download-"));
  let browserProcess, owner, controller, server, store;
  const originalSpawn = childProcess.spawn;
  try {
    // Test the production adapter using private copies, never the user's Chrome profile or shared build output.
    for (const packageName of ["playwright-core", "playwright", "@playwright/mcp"]) {
      const target = path.join(directory, "node_modules", packageName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (packageName === "playwright-core") fs.cpSync(path.join(root, "node_modules", packageName), target, { recursive: true });
      else { fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(path.join(root, "node_modules", packageName, "package.json"), path.join(target, "package.json")); }
    }
    const packageDir = patchBrowserUseUpstream(directory);
    const { chromium } = require(packageDir);
    const api = require(path.join(packageDir, "lib/coreBundle.js")).__desktopBrowserUse;
    const ts = require("typescript"), modules = path.join(directory, "modules"); fs.mkdirSync(modules);
    for (const [name, file] of [
      ["chrome-download-response", "src/main/modules/browser-use/chrome-download-response.ts"],
      ["chrome-file-transfer", "src/main/modules/browser-use/chrome-file-transfer.ts"],
      ["browser-file-transfer", "src/main/support/browser-files/transfer.ts"],
    ]) {
      const source = fs.readFileSync(path.join(root, file), "utf8")
        .replaceAll('"../../support/browser-files/transfer"', '"./browser-file-transfer"');
      fs.writeFileSync(path.join(modules, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    const { ChromeTransferStore } = require(path.join(modules, "chrome-file-transfer.js")); store = new ChromeTransferStore();
    const payloads = new Map([
      ["/csv", Buffer.from("item,quantity\nfixture,6\n")],
      ["/txt", Buffer.from("Authenticated POST attachment.\n")],
      ["/gzip", Buffer.from("Compressed HTTP entity.\n")],
      ["/unknown", Buffer.from("Chunked HTTP attachment.\n")],
      ["/large", Buffer.alloc(5 * 1024 * 1024, 97)],
    ]);
    const requests = new Map(), deliberateClicks = new Map();
    const fileName = (route, count) => `${route.slice(1)}-${count}${route === "/csv" ? ".csv" : ".bin"}`;
    server = http.createServer((request, response) => {
      const count = (requests.get(request.url) ?? 0) + 1; requests.set(request.url, count);
      if (request.url === "/allowed") {
        response.setHeader("Set-Cookie", "fixture_download=authorized; Path=/; SameSite=Lax");
        response.setHeader("Content-Type", "text/html");
        response.end(`<title>Download fixture</title><h1>Download fixture</h1><a id="csv" href="/csv">CSV</a><form method="post" action="/txt"><button id="txt">TXT</button></form><a id="gzip" href="/gzip">Gzip</a><a id="unknown" href="/unknown">Unknown length</a><a id="large" href="/large">Large attachment</a>`); return;
      }
      if (request.url === "/unshared") { response.end("<title>Unshared fixture</title>"); return; }
      const bytes = payloads.get(request.url);
      if (!bytes) { response.statusCode = 404; response.end(); return; }
      assert.match(request.headers.cookie ?? "", /fixture_download=authorized/u);
      response.setHeader("Content-Disposition", `attachment; filename="${fileName(request.url, count)}"`);
      response.setHeader("Content-Type", request.url === "/csv" ? "text/csv" : "application/octet-stream");
      if (request.url === "/txt") { assert.equal(request.method, "POST"); request.resume(); request.on("end", () => response.end(bytes)); }
      else if (request.url === "/gzip") { response.setHeader("Content-Encoding", "gzip"); response.end(zlib.gzipSync(bytes)); }
      else if (request.url === "/unknown") { response.write(bytes.subarray(0, 4)); response.end(bytes.subarray(4)); }
      else response.end(bytes);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`, profile = path.join(directory, "owned-profile"); fs.mkdirSync(profile);
    const nativeDownloads = path.join(directory, "owned-downloads"); fs.mkdirSync(nativeDownloads);
    fs.mkdirSync(path.join(profile, "Default"));
    fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: {
      default_directory: nativeDownloads, prompt_for_download: false,
    } }));
    browserProcess = originalSpawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i=0;i<200&&!fs.existsSync(portFile);i++) await delay(25);
    const endpoint = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
    owner = await chromium.connectOverCDP(endpoint);
    await owner.contexts()[0].pages()[0].goto(`${origin}/allowed`);
    await (await owner.contexts()[0].newPage()).goto(`${origin}/unshared`);
    await owner.close(); owner = undefined;
    // Redirect only the launch URL to the isolated browser; approval still uses the official extension UI.
    childProcess.spawn = (executable, args, options) => {
      const connect = args.find(value => String(value).startsWith("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?"));
      if (!connect) return originalSpawn(executable, args, options);
      void fetch(`${endpoint}/json/new?${encodeURIComponent(connect)}`, { method: "PUT" });
      return { unref() {} };
    };
    let connected, connectError, prepared = 0;
    const protocolCalls = [], instrumented = new WeakSet();
    const prepare = async tab => {
      prepared++;
      if (!instrumented.has(tab)) {
        const create = tab.createDownloadSession.bind(tab);
        tab.createDownloadSession = async () => {
          const port = await create();
          return { ...port, send: (method, params) => { protocolCalls.push(method); return port.send(method, params); } };
        };
        instrumented.add(tab);
      }
      await store.prepare(tab);
    };
    const connection = api.create({ outputDir: path.join(directory, "output"), clientName: "HTTP download fixture",
      extensionBrowser: { executablePath: chrome, userDataDir: profile },
      onTab: tab => store.watch(tab), onDownload: (tab, download) => store.captureDownload(tab, download),
    }).then(value => { connected = value; }, error => { connectError = error; });
    let approved = false;
    for (let i=0;i<300&&!approved;i++) {
      if (connectError) throw connectError;
      const targets = await (await fetch(`${endpoint}/json/list`)).json();
      const chooser = targets.find(target => target.url.startsWith("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html"));
      if (chooser) approved = await evaluateChooser(chooser, `(() => { const row=[...document.querySelectorAll('.tab-item')].find(row=>row.querySelector('.tab-title')?.textContent==='Download fixture'); const button=row?.querySelector('button'); if(button?.textContent!=='Allow & select')return false;button.click();return true;})()`);
      if (!approved) await delay(25);
    }
    assert.equal(approved, true); await connection; if (connectError) throw connectError; controller = connected;
    childProcess.spawn = originalSpawn;
    const pages = await controller.list(); assert.equal(pages.length, 1); const pageId = pages[0].pageId;
    const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    const click = async (route, capture) => {
      const before = new Set(store.list(pageId).map(entry => entry.downloadId));
      const count = (deliberateClicks.get(route) ?? 0) + 1; deliberateClicks.set(route, count);
      const callsBefore = prepared;
      await controller.run(pageId, async tab => {
        if (capture) await prepare(tab);
        return tab.page.locator(`#${route.slice(1)}`).click({ timeout: 5000, noWaitAfter: true });
      });
      assert.equal(prepared, callsBefore + (capture ? 1 : 0));
      const target = path.join(nativeDownloads, fileName(route, count));
      let entry, native;
      for (let i=0;i<300;i++) {
        entry = store.list(pageId).find(item => !before.has(item.downloadId));
        if (fs.existsSync(target)) {
          native = fs.readFileSync(target);
          if (native.length === payloads.get(route).length && (!capture || entry?.status !== "pending" && entry)) break;
        }
        await delay(20);
      }
      assert.ok(native, `original native download missing: ${route}`);
      assert.equal(hash(native), hash(payloads.get(route)), `native bytes changed: ${route}`);
      assert.equal(requests.get(route), count, "one original authenticated request per deliberate click; no replay");
      return entry;
    };

    assert.equal(await controller.run(pageId, tab => tab.page.title()), "Download fixture");
    await controller.run(pageId, tab => tab.captureSnapshot(undefined, 5, false, undefined, "json", false));
    assert.equal(prepared, 0, "ordinary state and observation do not prepare a download interceptor");
    await click("/large", false);
    assert.deepEqual(store.list(pageId), []); assert.equal(protocolCalls.length, 0);

    for (const route of ["/csv", "/txt", ...Array(10).fill("/csv")]) {
      const entry = await click(route, true); assert.equal(entry?.status, "complete", route);
      const result = await store.read(pageId, entry.downloadId);
      assert.equal(hash(Buffer.from(result.data, "base64")), hash(payloads.get(route)));
      assert.equal(result.sha256, hash(payloads.get(route)));
      assert.deepEqual(await store.read(pageId, entry.downloadId), result);
      await assert.rejects(store.read("unshared-page", entry.downloadId), { code: "download_not_found" });
      assert.equal(store.releaseDownload(pageId, entry.downloadId, result.sha256).released, true);
      assert.deepEqual(store.list(pageId), [], "persisted copies must release the shared connection's capacity");
    }
    assert.equal(prepared, 12, "the same actual connection survives more than eight saved downloads");
    assert.equal(protocolCalls.filter(method => method === "Fetch.getResponseBody").length, 12);

    for (const route of ["/large", "/unknown", "/gzip"]) {
      const bodyReads = protocolCalls.filter(method => method === "Fetch.getResponseBody").length;
      const entry = await click(route, true); assert.equal(entry?.status, "failed", route);
      assert.equal(protocolCalls.filter(method => method === "Fetch.getResponseBody").length, bodyReads,
        "unbounded/encoded or oversized attachments continue without copying a body");
      await store.endRun(); assert.deepEqual(store.list(pageId), []);
    }
    const manualPrepared = prepared;
    await click("/large", false); assert.equal(prepared, manualPrepared); assert.deepEqual(store.list(pageId), []);

    await controller.run(pageId, async tab => { await prepare(tab); return tab.page.title(); });
    assert.equal(prepared, manualPrepared + 1);
    await store.endRun(); // A task may finish/cancel before its expected attachment appears.
    const protocolBeforeManual = protocolCalls.length;
    await click("/csv", false);
    assert.deepEqual(store.list(pageId), []); assert.equal(protocolCalls.length, protocolBeforeManual);
    assert.equal(protocolCalls.some(method => /failRequest|fulfillRequest|takeResponseBody|^IO\./u.test(method)), false);
    for (const [route, count] of deliberateClicks) assert.equal(requests.get(route), count);
    assert.equal(fs.readdirSync(nativeDownloads).filter(name => !name.endsWith(".crdownload")).length,
      [...deliberateClicks.values()].reduce((sum, count) => sum + count, 0));
    await store.shutdown(); await controller.disconnect(); controller = undefined;
    assert.equal(browserProcess.exitCode, null, "releasing automation preserves the isolated browser until fixture cleanup");
    t.diagnostic(`Official Extension 0.4.0 relay: ${[...deliberateClicks.values()].reduce((sum, count) => sum + count, 0)} original downloads, 12 acknowledged copies, no replay, no interceptor on ordinary observations or after Run release.`);
  } finally {
    childProcess.spawn = originalSpawn;
    await store?.shutdown(); await controller?.disconnect().catch(() => {}); await owner?.close().catch(() => {});
    if (browserProcess && browserProcess.exitCode === null) { browserProcess.kill(); await Promise.race([once(browserProcess, "exit"), delay(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
