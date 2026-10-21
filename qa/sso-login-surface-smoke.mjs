// Real Electron guest smoke. Uses only a temporary profile and loopback fixture;
// never imports the Desktop entry point, starts services or opens its profile.
// Run: node qa/sso-login-surface-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sso-login-surface-smoke-"));
const brand = {
  id: "sso-smoke", packageName: "sso-smoke", productName: "SSO Smoke", storageNamespace: "sso-smoke", appId: "sso-smoke", description: "SSO Smoke",
  protocols: { open: { scheme: "sso-smoke" } },
  paths: { runtimeRootDirName: ".sso-smoke", desktopDataSubdir: ".desktop", programDataDirName: "SSO Smoke" },
  installer: { shutdownArg: "--shutdown" },
  desktopPet: { id: "test", displayName: "Test", description: "Test", preview: "", states: {} },
  i18n: { "zh-CN": {}, "en-US": {} }
};

await build({
  stdin: {
    resolveDir: repo,
    loader: "tsx",
    contents: `
      import React, { useEffect, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { DesktopSsoLoginSurface } from "./src/renderer/identity/DesktopSsoLoginSurface";
      import "./src/renderer/styles/app-shell.css";
      window.ssoFixture = { listeners: [], cancellations: 0 };
      const addListener = HTMLElement.prototype.addEventListener;
      HTMLElement.prototype.addEventListener = function(name, listener, ...args) {
        if (this.tagName === "WEBVIEW") window.ssoFixture.listeners.push({ guest: this, name, listener });
        return addListener.call(this, name, listener, ...args);
      };
      function Probe() {
        const [request, setRequest] = useState(null);
        const cancel = () => { window.ssoFixture.cancellations++; setRequest(null); };
        useEffect(() => {
          window.ssoFixture.open = url => setRequest({ url, label: "SSO fixture", partition: "", userAgent: navigator.userAgent });
          window.ssoFixture.cancel = cancel;
        }, []);
        return request ? <div className="desktop-sso-login-modal-layer"><section className="desktop-sso-login-modal">
          <header className="desktop-sso-login-modal-head"><strong>SSO fixture</strong><button onClick={cancel}>Cancel</button></header>
          <div className="desktop-sso-login-modal-frame"><DesktopSsoLoginSurface key={request.url} request={request} onCancel={cancel} /></div>
        </section></div> : <p id="closed">Closed</p>;
      }
      createRoot(document.getElementById("root")).render(<React.StrictMode><Probe /></React.StrictMode>);
    `
  },
  outfile: path.join(root, "fixture.js"),
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', __DESKTOP_APP_BRAND__: JSON.stringify(brand) }
});
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta charset="utf-8"><title>SSO surface smoke</title>
  <link rel="stylesheet" href="./fixture.css"><style>
  :root { --ink:#1d2129; --ink-muted:#59616f; --embedded-surface-frame-bg:#fff; --embedded-surface-shell-bg:#f5f6f8; }
  body { margin:0; font:14px system-ui; background:#eef0f3; } #root { height:100vh; }
  </style><div id="root"></div><script src="./fixture.js"></script>`);
fs.writeFileSync(path.join(root, "main.cjs"), `
  const { app, BrowserWindow, session } = require("electron");
  const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), net = require("node:net"), assert = require("node:assert/strict");
  const { once } = require("node:events");
  app.setName("SSO surface smoke");
  app.setPath("userData", path.join(__dirname, "profile"));
  app.setPath("sessionData", path.join(__dirname, "session"));
  let win, server;
  const guests = [], finishedGuests = new Set(), readyForms = new Set();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(check, label) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await check()) return; await pause(30); }
    throw Error("Timed out: " + label);
  }
  async function run() {
    await app.whenReady();
    // Only this disposable profile is set direct, so the loopback fixture does
    // not depend on the machine's PAC/VPN or the production proxy policy.
    await session.defaultSession.setProxy({ mode: "direct" });
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = "http://127.0.0.1:" + port;
    const target = origin + "/login?state=fixture-sensitive-state&code=fixture-sensitive-code";
    await session.defaultSession.cookies.set({ url: origin, name: "sso-smoke", value: "retained-on-retry" });
    win = new BrowserWindow({ show: false, width: 860, height: 640,
      webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("will-attach-webview", (_event, preferences) => {
      preferences.contextIsolation = true; preferences.nodeIntegration = false;
      assert.equal(preferences.preload, undefined);
    });
    win.webContents.on("did-attach-webview", (_event, guest) => {
      guests.push(guest); guest.on("did-finish-load", () => finishedGuests.add(guest.id));
      guest.on("console-message", (_event, ...args) => {
        const message = typeof args[0] === "object" ? args[0]?.message : args[1];
        if (message === "SSO_FIXTURE_FORM_READY") readyForms.add(guest.id);
      });
    });
    await win.loadFile(path.join(__dirname, "index.html"));
    await until(() => js("typeof ssoFixture.open === 'function'"), "React StrictMode fixture ready");
    const failed = () => js("document.querySelector('.desktop-sso-login-surface')?.dataset.loadState === 'failed' && !!document.querySelector('[role=alert]')");
    await js("ssoFixture.open(" + JSON.stringify(target) + ")");
    await until(failed, "real guest connection failure shown");
    const errorText = await js("document.querySelector('[role=alert]').textContent");
    assert.match(errorText, /-102/);
    assert.ok(!errorText.includes("127.0.0.1") && !errorText.includes("fixture-sensitive"));
    assert.equal(await js("document.querySelector('.desktop-sso-login-surface-loading') === null"), true);
    fs.writeFileSync(path.join(__dirname, "load-failed.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('[role=alert] button').click()");
    await until(() => js("ssoFixture.cancellations === 1 && !document.querySelector('webview')"), "failure can be cancelled");
    await js("ssoFixture.open(" + JSON.stringify(target) + ")");
    await until(failed, "second login surface failure");
    const retired = guests.at(-1);
    await js("ssoFixture.oldGuest = document.querySelector('webview'); ssoFixture.oldListeners = ssoFixture.listeners.filter(item => item.guest === ssoFixture.oldGuest); true");
    let retainedCookie = false, pendingImages = 0, pendingFrames = 0, pendingImageResponse;
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, origin).pathname;
      if (pathname === "/slow-image") { pendingImages++; pendingImageResponse = response; response.writeHead(200, { "Content-Type": "image/png" }); response.flushHeaders(); return; }
      if (pathname === "/slow-frame") { pendingFrames++; response.writeHead(200, { "Content-Type": "text/html" }); response.flushHeaders(); return; }
      retainedCookie ||= (request.headers.cookie || "").includes("sso-smoke=retained-on-retry");
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><meta charset="utf-8"><h1 id="fixture-ready">Login form ready</h1><label>Username <input name="username"></label><script>addEventListener("DOMContentLoaded",()=>{if(document.querySelector("#fixture-ready")&&document.querySelector("input[name=username]"))console.log("SSO_FIXTURE_FORM_READY")})</script><img src="/slow-image">');
    });
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    await js("Array.from(document.querySelectorAll('[role=alert] button')).at(-1).click()");
    await until(() => js("document.querySelector('.desktop-sso-login-surface')?.dataset.loadState === 'ready'"), "retry page ready at DOM readiness");
    const recovered = guests.at(-1);
    assert.notEqual(recovered.id, retired.id);
    assert.equal(recovered.getURL(), target, "Retry must keep the same login attempt URL");
    // executeJavaScript waits for full page loading in Electron; use a fixture
    // DOMContentLoaded signal so the deliberately pending image cannot stall it.
    await until(() => Promise.resolve(readyForms.has(recovered.id)), "real login form present");
    await until(() => Promise.resolve(pendingImages > 0), "image intentionally remains pending");
    assert.equal(finishedGuests.has(recovered.id), false, "Pending subresources must not cover the usable login form");
    assert.equal(await js("!document.querySelector('[role=alert]') && !document.querySelector('.desktop-sso-login-surface-loading')"), true);
    assert.equal(retainedCookie, true, "Retry must keep the isolated browser session Cookie");
    pendingImageResponse.end();
    await until(() => Promise.resolve(finishedGuests.has(recovered.id)), "initial page fully finished");
    await recovered.executeJavaScript("(() => { const frame = document.createElement('iframe'); frame.src = '/slow-frame'; document.body.appendChild(frame); return true; })()");
    await until(() => Promise.resolve(pendingFrames > 0), "dynamic MFA-style frame remains pending");
    await pause(100);
    assert.equal(await js("document.querySelector('.desktop-sso-login-surface').dataset.loadState === 'ready' && !document.querySelector('.desktop-sso-login-surface-loading')"), true, "A pending subframe must not cover the main login form");
    await until(() => Promise.resolve(retired.isDestroyed()), "old guest destroyed");
    await js("for (const item of ssoFixture.oldListeners) { if (['did-start-navigation','did-fail-load','did-stop-loading','did-finish-load','dom-ready','render-process-gone'].includes(item.name)) item.listener.call(item.guest, Object.assign(new Event(item.name), {isMainFrame:true,isInPlace:false,errorCode:-105})); }");
    assert.equal(await js("document.querySelector('.desktop-sso-login-surface').dataset.loadState"), "ready");
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    assert.equal(await js("document.querySelector('.desktop-sso-login-surface').dataset.loadState === 'ready' && !document.querySelector('.desktop-sso-login-surface-loading')"), true);
    fs.writeFileSync(path.join(__dirname, "recovered.png"), (await win.webContents.capturePage()).toPNG());
    await js("ssoFixture.cancel()");
    await until(() => js("ssoFixture.cancellations === 2 && !document.querySelector('webview')"), "surface released after cancel");
    await until(() => Promise.resolve(recovered.isDestroyed()), "recovered guest destroyed");
    fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, electron: process.versions.electron,
      realGuestFailure: true, retrySameAttempt: true, retainedCookie: true,
      formVisibleBeforeSubresourceCompletion: true, subframeNavigationKeepsFormVisible: true, lateGuestEventsIgnored: true,
      cancelUnmounts: 2, strictMode: true,
      screenshots: ["load-failed.png", "recovered.png"]
    }, null, 2));
  }
  run().then(() => finish(0), async error => {
    fs.writeFileSync(path.join(__dirname, "failure.txt"), String(error.stack || error));
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(__dirname, "failure.png"), (await win.webContents.capturePage()).toPNG());
    console.error(error.message); finish(1);
  });
  function finish(code) { if (win && !win.isDestroyed()) win.destroy(); if (server) { server.closeAllConnections(); server.close(); } app.exit(code); }
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
const log = fs.createWriteStream(path.join(root, "electron.log"));
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(timeout);
log.end();
console.log(JSON.stringify({ artifacts: root, exitCode: code }, null, 2));
if (code !== 0) throw new Error(`SSO surface smoke failed; inspect ${path.join(root, "electron.log")}`);
console.log(fs.readFileSync(path.join(root, "result.json"), "utf8"));
