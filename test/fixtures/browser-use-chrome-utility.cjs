const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { app } = require("electron");

const reportFile = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
const sourceRoot = process.argv.find(arg => arg.startsWith("--source="))?.slice(9);
const chromePath = process.argv.find(arg => arg.startsWith("--chrome="))?.slice(9);
app.setPath("userData", path.join(app.getAppPath(), "user-data"));

app.whenReady().then(async () => {
  const root = app.getAppPath();
  const { ChromeBackend } = require(path.join(sourceRoot, "dist-electron/main/modules/browser-use/chrome-backend.js"));
  const coreDir = path.join(root, "dist-electron/main/browser-use-runtime/playwright-core");
  const { chromium } = require(coreDir);
  const checks = {};
  let normal;
  let fixture;
  let chrome;
  let owner;
  let server;
  try {
    normal = new ChromeBackend();
    checks.productionWorkerState = await normal.request("state");
    try { await normal.request("connect", { profileDirName: "../Default" }); }
    catch (error) { checks.invalidProfileCode = error.code; }
    await normal.disconnect();
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(request.url === '/two' ? '<title>Neighbour</title><button>Unchanged</button>'
        : '<title>Utility fixture</title><button id="go" onclick="document.title=\'Clicked in UtilityProcess\'">Go</button><input id="name" aria-label="Name"><input type="password" value="UTILITY-PASSWORD-SECRET">');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = fs.mkdtempSync(path.join(root, "owned-chrome-"));
    chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    const endpointFile = path.join(profile, "DevToolsActivePort");
    for (let count = 0; !fs.existsSync(endpointFile) && count < 200; count++) await delay(25);
    const port = fs.readFileSync(endpointFile, "utf8").split("\n")[0];
    const endpoint = `http://127.0.0.1:${port}`;
    owner = await chromium.connectOverCDP(endpoint);
    const context = owner.contexts()[0];
    const first = context.pages()[0];
    await first.goto(`${origin}/one`);
    const second = await context.newPage();
    await second.goto(`${origin}/two`);
    fs.writeFileSync(path.join(root, "dist-electron/main/fixture-endpoint.json"), JSON.stringify({ endpoint }));
    fixture = new ChromeBackend({ workerPath: path.join(root, "dist-electron/main/chrome-fixture-worker.cjs") });
    const connection = await fixture.request("connect");
    checks.pages = connection.pages;
    const pageId = connection.pages.find(page => page.title === "Utility fixture").pageId;
    const observation = await fixture.request("observe", {}, pageId);
    checks.passwordMasked = !JSON.stringify(observation).includes("UTILITY-PASSWORD-SECRET");
    checks.observationElements = observation.elements.length;
    await fixture.request("interact", { action: "fill", selector: "#name", text: "小君 UtilityProcess" }, pageId);
    await fixture.request("click", { selector: "#go" }, pageId);
    checks.value = await first.locator("#name").inputValue();
    checks.title = await first.title();
    checks.neighbour = await second.title();
    const screenshot = await fixture.request("screenshot", {}, pageId);
    checks.png = Buffer.from(screenshot.data, "base64").subarray(1, 4).toString() === "PNG";
    await fixture.disconnect();
    checks.chromePreserved = chrome.exitCode === null;
    checks.pagesPreserved = context.pages().length === 2;
    fs.writeFileSync(reportFile, JSON.stringify({ ok: true, appPath: root, ...checks }));
  } catch (error) {
    fs.writeFileSync(reportFile, JSON.stringify({ ok: false, error: error.message, code: error.code, checks }));
    process.exitCode = 1;
  } finally {
    await normal?.disconnect();
    await fixture?.disconnect();
    await owner?.close().catch(() => {});
    if (chrome && chrome.exitCode === null) { chrome.kill(); await Promise.race([once(chrome, "exit"), delay(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
