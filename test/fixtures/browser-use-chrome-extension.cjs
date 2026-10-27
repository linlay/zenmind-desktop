const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { app } = require("electron");

const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
app.setPath("userData", path.join(app.getAppPath(), "user-data"));
const headless = argument('headless') === 'true';
if (headless && process.platform === 'darwin') app.setActivationPolicy('prohibited');

async function evaluateTarget(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Extension UI command timed out")), 5000);
      socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error || message.result?.exceptionDetails) reject(new Error("Extension UI command failed"));
        else resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}

app.whenReady().then(async () => {
  const root = app.getAppPath();
  const reportFile = argument("report");
  const { ChromeBackend } = require(path.join(argument("source"), "dist-electron/main/modules/browser-use/chrome-backend.js"));
  const mainDir = path.join(root, "dist-electron/main");
  const coreDir = path.join(mainDir, "browser-use-runtime/playwright-core");
  const productionDiscovery = argument("production-discovery") === "true";
  const { chromium } = require(coreDir);
  const checks = {};
  let server;
  let chrome;
  let owner;
  let backend;
  try {
    server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Set-Cookie", "fixture_session=present; Path=/; SameSite=Lax");
      const title = request.url.startsWith("/allowed") ? "Official relay fixture" : "Unshared neighbour";
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>Local fixture session</p><button id="go" onclick="document.title='Official relay clicked'">Go</button><button disabled id="disabled">Disabled</button><input id="name" aria-label="Name"><input type="password" value="OFFICIAL-RELAY-PASSWORD">`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const profile = path.join(root, "owned-chrome-profile");
    fs.mkdirSync(profile);
    const chromePath = argument("chrome");
    const extensionPath = argument("extension");
    const flags = ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "about:blank"];
    if (headless) flags.unshift('--headless=new');
    chrome = spawn(chromePath, flags, { stdio: "ignore" });
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let count = 0; !fs.existsSync(portFile) && count < 200; count++) await delay(25);
    const endpoint = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
    owner = await chromium.connectOverCDP(endpoint);
    const first = owner.contexts()[0].pages()[0]; await first.goto(`${url}/allowed`);
    const second = await owner.contexts()[0].newPage(); await second.goto(`${url}/unshared`);
    await owner.close(); owner = undefined;
    // Every CfT launch on macOS gets the mock keychain, including the relay's short-lived open-URL launch.
    let launcher = chromePath;
    if (process.platform === "darwin") {
      launcher = path.join(root, "chrome-fixture-launcher.sh");
      fs.writeFileSync(launcher, `#!/bin/sh\nexec '${chromePath.replace(/'/g, "'\\''")}' --use-mock-keychain ${headless ? '--headless=new ' : ''}"$@"\n`, { mode: 0o755 });
    } else if (process.platform === "win32") {
      launcher = chromePath;
    }
    const evidenceFile = path.join(root, 'production-discovery-evidence.json');
    if (productionDiscovery) {
      fs.writeFileSync(path.join(mainDir, 'fixture-production-discovery.json'), JSON.stringify({
        home: path.join(root, 'empty-discovery-home'), executable: chromePath, profile, evidenceFile,
      }));
    } else fs.writeFileSync(path.join(mainDir, "fixture-extension-browser.json"), JSON.stringify({ executablePath: launcher, userDataDir: profile, ...(headless ? { headlessEndpoint: endpoint } : {}) }));
    backend = new ChromeBackend({ workerPath: path.join(mainDir, productionDiscovery ? 'chrome-discovery-worker.cjs' : "chrome-extension-worker.cjs") });
    let connectionError, connectionResult;
    const connectionPromise = backend.request("connect", { clientName: "Desktop relay fixture" }).then(result => { connectionResult = result; }, error => { connectionError = error; });
    // Observe only the chooser tab; leave all website debugger targets free for chrome.debugger.attach.
    let chooser;
    for (let count = 0; count < 200; count++) {
      if (connectionError) throw connectionError;
      const targets = await (await fetch(`${endpoint}/json/list`)).json();
      chooser = targets.find(target => target.type === "page" && target.url.startsWith("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html"));
      if (chooser) break;
      await delay(25);
    }
    if (!chooser) {
      checks.targets = (await (await fetch(`${endpoint}/json/list`)).json()).map(target => ({ type: target.type, title: target.title, url: target.url.split("?")[0] }));
      throw new Error("Official extension did not open its user approval page");
    }
    let approved = false;
    for (let count = 0; count < 200; count++) {
      approved = await evaluateTarget(chooser, `(() => { const row = [...document.querySelectorAll('.tab-item')].find(item => item.querySelector('.tab-title')?.textContent === 'Official relay fixture'); if (!row) return false; const button = row.querySelector('button'); if (button?.textContent !== 'Allow & select') return false; button.click(); return true; })()`);
      if (approved) break;
      await delay(25);
    }
    if (!approved) throw new Error("Official extension approval UI did not expose the isolated fixture tab");
    checks.approvedInOfficialUI = approved;
    await connectionPromise;
    if (connectionError) throw connectionError;
    if (productionDiscovery) checks.productionDiscovery = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const connection = connectionResult;
    checks.visiblePages = connection.pages;
    const pageId = connection.pages[0]?.pageId;
    if (!pageId) throw new Error("The extension did not return the user-selected fixture tab");
    const observation = await backend.request("observe", {}, pageId);
    checks.passwordMasked = !JSON.stringify(observation).includes("OFFICIAL-RELAY-PASSWORD");
    checks.localSessionObserved = observation.text.includes("Local fixture session");
    const viewport = await backend.request('observe', { viewportOnly: true }, pageId);
    checks.viewportObserved = viewport.viewportOnly === true && viewport.elements.some(element => element.name === 'Go');
    const scrolled = await backend.request('interact', { action: 'scroll', deltaY: 400 }, pageId);
    checks.scrollViewportObserved = scrolled.action.outcome === 'complete' && scrolled.observation?.viewportOnly === true;
    await backend.request("interact", { action: "fill", selector: "#name", value: "Official extension relay" }, pageId);
    await backend.request("click", { selector: "#go" }, pageId);
    checks.title = (await backend.request("state")).pages[0]?.title;
    const screenshot = await backend.request("screenshot", {}, pageId);
    checks.png = Buffer.from(screenshot.data, "base64").subarray(1, 4).toString() === "PNG";
    const pending = backend.request("click", { selector: "#disabled" }, pageId).then(() => "unexpected_success", error => error.code);
    await delay(100);
    const stoppedAt = Date.now();
    await backend.disconnect();
    checks.pendingCancelled = await pending;
    checks.stopMs = Date.now() - stoppedAt;
    checks.chromePreserved = chrome.exitCode === null;
    owner = await chromium.connectOverCDP(endpoint);
    const pages = owner.contexts()[0].pages();
    checks.unsharedPreserved = await pages.find(page => page.url().endsWith("/unshared"))?.title();
    checks.value = await pages.find(page => page.url().endsWith("/allowed"))?.locator("#name").inputValue();
    checks.pagesPreserved = pages.length;
    fs.writeFileSync(reportFile, JSON.stringify({ ok: true, ...checks }));
  } catch (error) {
    const workerError = path.join(mainDir, 'fixture-worker-error.json');
    if (fs.existsSync(workerError)) checks.workerDiagnostic = JSON.parse(fs.readFileSync(workerError, 'utf8'));
    fs.writeFileSync(reportFile, JSON.stringify({ ok: false, error: error.message, code: error.code, checks }));
    process.exitCode = 1;
  } finally {
    await backend?.disconnect();
    await owner?.close().catch(() => {});
    if (chrome && chrome.exitCode === null) { chrome.kill(); await Promise.race([once(chrome, "exit"), delay(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
