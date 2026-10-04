const { app, BrowserWindow, webContents } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { configureAttachedWebview } = require("../dist-electron/main/modules/shell/window-manager.js");
app.setPath("userData", process.env.FULLSCREEN_SMOKE_PROFILE);
const output = process.env.FULLSCREEN_SMOKE_OUTPUT;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50); }
  throw new Error("Fullscreen smoke timed out");
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true } });
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  win.webContents.on("console-message", event => { if (event.level >= 3) console.log("renderer:", event.message); });
  await win.loadFile(path.join(output, "index.html"));
  await until(async () => await js('window.guest && window.guest.getWebContentsId() > 0 && !window.guest.isLoading()'));
  win.setFullScreen(true);
  await until(() => win.isFullScreen());
  const guest = webContents.fromId(await js("window.guest.getWebContentsId()"));
  const instance = await guest.executeJavaScript("window.instance");
  let active = true;
  let exits = 0;
  configureAttachedWebview(guest, {
    platform: process.platform, isWorkPanelFullscreenActive: () => active,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: () => { exits++; } } }),
    isWorkPanelWebview: c => c === guest, isDevToolsShortcut: () => false,
    shouldDownloadUrl: () => false, resolveOpenDisposition: () => "external",
    collectLoadDiagnostics: async () => ({}), report: () => {}, openExternal: async () => {},
    schedule: callback => callback(),
  });
  await js("window.setFullscreen(true)");
  await until(async () => await js('!!document.querySelector(".work-panel-fullscreen-controls:popover-open")'));
  const geometry = () => js(`({
    tabs: getComputedStyle(document.querySelector('.chat-work-panel-tabs')).display,
    toolbar: getComputedStyle(document.querySelector('.external-webview-browser-chrome')).display,
    top: window.guest.getBoundingClientRect().top,
    height: window.guest.getBoundingClientRect().height,
    viewport: innerHeight,
  })`);
  for (const platform of ["mac", "windows"]) {
    await js(`document.querySelector('.app-shell').className='app-shell has-chat-work-panel is-window-fullscreen is-work-panel-fullscreen is-${platform}-platform'`);
    const layout = await geometry();
    assert.equal(layout.tabs, "none");
    assert.equal(layout.toolbar, "none");
    assert.equal(layout.top, 0);
    assert.equal(layout.height, layout.viewport);
  }
  await until(async () => await js('!document.querySelector(".work-panel-fullscreen-hint")'));
  await until(async () => await js('getComputedStyle(document.querySelector(".work-panel-fullscreen-exit")).opacity === "0"'));
  win.webContents.sendInputEvent({ type: "mouseMove", x: await js("Math.round(innerWidth / 2)"), y: 2 });
  await until(async () => await js('getComputedStyle(document.querySelector(".work-panel-fullscreen-exit")).opacity === "1"'));
  assert.equal((await geometry()).top, 0, "hover must not shift content");
  fs.writeFileSync(path.join(output, "hover.png"), (await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({ type: "mouseMove", x: 50, y: 300 });
  await until(async () => await js('getComputedStyle(document.querySelector(".work-panel-fullscreen-exit")).opacity === "0"'));
  await js('document.querySelector(".work-panel-fullscreen-exit").focus()');
  await until(async () => await js('getComputedStyle(document.querySelector(".work-panel-fullscreen-exit")).opacity === "1"'));
  await js('document.querySelector(".work-panel-fullscreen-exit").blur()');

  // Exercise the real Chromium guest fullscreen top layer, not just a CSS mock.
  await guest.executeJavaScript("document.documentElement.requestFullscreen()", true);
  await until(async () => await guest.executeJavaScript("!!document.fullscreenElement"));
  await delay(700);
  // Chromium guest fullscreen covers host UI. The Main shortcut is the exit path.
  guest.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control", "shift"] });
  await until(() => exits === 1);
  guest.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control", "shift"] });
  guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  guest.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await delay(150);
  assert.equal(exits, 1, "Escape never exits WorkPanel");
  assert.equal(win.isFullScreen(), true, "Escape preserves the pre-existing native fullscreen");
  guest.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control", "shift"] });
  await until(() => exits === 2);
  active = false;
  await js('document.querySelector(".work-panel-fullscreen-exit").click()');
  await until(async () => await js('!document.querySelector(".work-panel-fullscreen-controls")'));
  assert.equal(await js("window.guest.getWebContentsId()"), guest.id);
  assert.equal(await guest.executeJavaScript("window.instance"), instance);
  assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), "Preserved draft");
  if (await guest.executeJavaScript("!!document.fullscreenElement")) await guest.executeJavaScript("document.exitFullscreen()");
  assert.notEqual((await geometry()).tabs, "none");
  assert.notEqual((await geometry()).toolbar, "none");
  win.destroy();
  console.log("PASS: chrome hidden, macOS/Windows geometry, hover/focus, guest HTML fullscreen, Escape, exit shortcut, stable guest and draft");
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
