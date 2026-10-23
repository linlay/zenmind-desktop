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

test("official extension relay imports original authenticated HTTP attachments with bounded Fetch/IO", {
  skip: !chrome || !fs.existsSync(path.join(extension, "manifest.json")), timeout: 90_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-extension-download-"));
  let browserProcess, owner, controller, server, store;
  const originalSpawn = childProcess.spawn;
  try {
    // A private fixture copy replays the existing verified source patch. This
    // does not bundle/stage the application or change its shared node_modules.
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
    for (const name of ["chrome-download-response", "chrome-file-transfer"]) {
      fs.writeFileSync(path.join(modules, `${name}.js`), ts.transpileModule(fs.readFileSync(path.join(root, "src/main/modules/browser-use", `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    const { ChromeTransferStore } = require(path.join(modules, "chrome-file-transfer.js")); store = new ChromeTransferStore();
    const csv = Buffer.from("item,quantity\nfixture,6\n"), txt = Buffer.from("Authenticated POST attachment.\n"), compressed = Buffer.from("Compressed HTTP entity.\n");
    const requests = new Map();
    server = http.createServer((request, response) => {
      requests.set(request.url, (requests.get(request.url) ?? 0) + 1);
      if (request.url === "/allowed") {
        response.setHeader("Set-Cookie", "fixture_download=authorized; Path=/; SameSite=Lax");
        response.setHeader("Content-Type", "text/html");
        response.end(`<title>Download fixture</title><h1>Download fixture</h1><a id="csv" href="/csv">CSV</a><form method="post" action="/txt"><button id="txt">TXT</button></form><a id="gzip" href="/gzip">Gzip</a><a id="large" href="/large">Too large</a>`); return;
      }
      if (request.url === "/unshared") { response.end("<title>Unshared fixture</title>"); return; }
      assert.match(request.headers.cookie ?? "", /fixture_download=authorized/u);
      response.setHeader("Content-Disposition", `attachment; filename="fixture${request.url === "/csv" ? ".csv" : ".txt"}"`);
      response.setHeader("Content-Type", request.url === "/csv" ? "text/csv" : "text/plain");
      if (request.url === "/csv") response.end(csv);
      else if (request.url === "/txt") { assert.equal(request.method, "POST"); request.resume(); request.on("end", () => response.end(txt)); }
      else if (request.url === "/gzip") { response.setHeader("Content-Encoding", "gzip"); response.end(zlib.gzipSync(compressed)); }
      else if (request.url === "/large") response.end(Buffer.alloc(4 * 1024 * 1024 + 1, 97));
      else { response.statusCode = 404; response.end(); }
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
    // Headless's open-URL launch boundary is redirected to this owned browser.
    // Approval still goes through the actual official extension's Allow/select UI.
    childProcess.spawn = (executable, args, options) => {
      const connect = args.find(value => String(value).startsWith("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?"));
      if (!connect) return originalSpawn(executable, args, options);
      void fetch(`${endpoint}/json/new?${encodeURIComponent(connect)}`, { method: "PUT" });
      return { unref() {} };
    };
    let connected, connectError;
    const connection = api.create({ outputDir: path.join(directory, "output"), clientName: "HTTP download fixture",
      extensionBrowser: { executablePath: chrome, userDataDir: profile },
      onTab: tab => store.watch(tab), onDownload: (tab, download) => store.captureDownload(tab, download),
      onBeforeOperation: tab => store.prepare(tab),
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
    for (const [selector, expected] of [["#csv", csv], ["#txt", txt], ["#gzip", compressed]]) {
      const before = store.list(pageId).length;
      await controller.run(pageId, tab => tab.page.locator(selector).click({ timeout: 5000, noWaitAfter: true }));
      let entry;
      for (let i=0;i<300;i++) { entry=store.list(pageId)[before]; if(entry&&entry.status!=="pending")break; await delay(20); }
      assert.equal(entry?.status, "complete", selector);
      const result = await store.read(pageId, entry.downloadId);
      assert.deepEqual(Buffer.from(result.data, "base64"), expected, selector);
      assert.equal(result.sha256, crypto.createHash("sha256").update(expected).digest("hex"));
      assert.deepEqual(await store.read(pageId, entry.downloadId), result);
      await assert.rejects(store.read("unshared-page", entry.downloadId), { code: "download_not_found" });
    }
    await controller.run(pageId, tab => tab.page.locator("#large").click({ timeout: 5000, noWaitAfter: true }));
    let failure;
    for (let i=0;i<300;i++) { failure=store.list(pageId)[3]; if(failure&&failure.status!=="pending")break; await delay(20); }
    assert.equal(failure?.error, "file_transfer_limit");
    for (const route of ["/csv", "/txt", "/gzip", "/large"]) assert.equal(requests.get(route), 1, "must not reissue an authenticated attachment request");
    assert.equal(store.list(pageId).length, 4, "no duplicate native imports");
    const nativeHashes = [];
    for (let i=0;i<100;i++) {
      const files = fs.readdirSync(nativeDownloads).filter(name => !name.endsWith(".crdownload"));
      if (files.length === 3) { nativeHashes.push(...files.map(name => crypto.createHash("sha256").update(fs.readFileSync(path.join(nativeDownloads,name))).digest("hex"))); break; }
      await delay(20);
    }
    assert.deepEqual(nativeHashes.sort(), [csv, txt, compressed].map(bytes => crypto.createHash("sha256").update(bytes).digest("hex")).sort(), "fulfilled native responses keep the original entity bytes in the fixture-owned download directory");
    await store.shutdown(); await controller.disconnect(); controller = undefined;
    assert.equal(browserProcess.exitCode, null, "releasing automation must preserve owned Chrome until fixture cleanup");
    t.diagnostic("Official Extension 0.4.0 relay: CSV, POST TXT, gzip, overflow, repeatable bytes and single original requests passed.");
  } finally {
    childProcess.spawn = originalSpawn;
    await store?.shutdown(); await controller?.disconnect().catch(() => {}); await owner?.close().catch(() => {});
    if (browserProcess && browserProcess.exitCode === null) { browserProcess.kill(); await Promise.race([once(browserProcess, "exit"), delay(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
