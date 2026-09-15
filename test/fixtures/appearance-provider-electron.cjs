const { app, BrowserWindow, ipcMain, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = process.env.APPEARANCE_PROVIDER_TEST_ROOT;
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
app.disableHardwareAcceleration();
if (process.platform === "darwin") app.setActivationPolicy("prohibited");

const appearanceCalls = [];
let mainWindowId = null;
let canonicalTheme = "light";
let canonicalSkin = "default";
ipcMain.handle("fixture.appearance", (event, method, value) => {
  appearanceCalls.push({ method, senderId: event.sender.id });
  if (event.sender.id !== mainWindowId) throw new Error("main window appearance access denied");
  if (method === "getThemePreference") return canonicalTheme;
  if (method === "setNativeThemeSource") {
    canonicalTheme = value;
    return { ok: true, themeSource: value };
  }
  if (method === "setDesktopSkin") canonicalSkin = value;
  if (method === "getDesktopSkin" || method === "setDesktopSkin") {
    return { ok: true, settings: { skinId: canonicalSkin, background: null, backgroundDataUrl: null } };
  }
  throw new Error(`Unexpected appearance operation: ${method}`);
});
ipcMain.handle("fixture.preload", () => pathToFileURL(path.join(root, "guest-preload.cjs")).href);

(async () => {
  await app.whenReady();
  // This URL is handled entirely in the isolated Electron session. No HTTP
  // listener, Desktop service, user profile, or account is accessed by the test.
  const guestSession = session.fromPartition("persist:appearance-provider-test-service-agent-webclient");
  await guestSession.protocol.handle("http", () => new Response("<!doctype html><title>Appearance fixture guest</title>"));
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { preload: path.join(root, "host-preload.cjs"), contextIsolation: true,
      nodeIntegration: false, webviewTag: true, backgroundThrottling: false }
  });
  const diagnostics = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) diagnostics.push(message);
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  async function until(code, label) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await js(`(async () => { try { return Boolean(await (${code})); } catch { return false; } })()`)) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`${label}\n${await js("document.body.innerText")}\n${diagnostics.join("\n")}`);
  }
  const readGuest = () => js("document.querySelector('webview').executeJavaScript('window.appearanceFixture.read()')");
  await win.loadFile(path.join(root, "index.html"));
  await until("!!window.fixture", "renderer fixture failed to load");
  await js("localStorage.setItem('appearance-provider-test.desktop-skin', 'mist')");

  for (const theme of ["dark", "light"]) {
    await js(`fixture.render('auxiliary', ${JSON.stringify(theme)})`);
    await until("document.querySelector('#read-snapshot')?.dataset.theme === 'none'", "read hook did not return null outside provider");
    await until(`document.querySelector('webview')?.getURL?.().startsWith('http://127.0.0.1:19789/selection-explain/')`, "auxiliary ServiceWebviewSurface failed to mount");
    await until("document.querySelector('webview').executeJavaScript('!!window.appearanceFixture?.read()')", "auxiliary guest received no appearance snapshot");
    const snapshot = await readGuest();
    assert.equal(snapshot.resolvedTheme, theme);
    assert.equal(snapshot.skinId, "default", "auxiliary windows must not restore the main-window cached skin");
    assert.equal(snapshot.background.mode, "opaque");
    assert.equal(await js("document.documentElement.dataset.desktopSkin"), undefined);
    assert.equal(appearanceCalls.length, 0, "auxiliary mounting must not read or write owner-restricted appearance settings");
  }

  mainWindowId = win.webContents.id;
  await js("fixture.render('main')");
  await until("fixture.api?.skinLoadState === 'ready' && document.querySelector('#read-snapshot')?.dataset.skin === 'default'", "main provider failed to load canonical settings");
  const identity = await js("document.querySelector('#read-snapshot').dataset.instance");
  const mounts = await js("fixture.readMounts");
  assert.ok(appearanceCalls.some(({ method }) => method === "getDesktopSkin"));
  await js("fixture.api.setThemeMode('dark')");
  await until("document.querySelector('#read-snapshot').dataset.theme === 'dark'", "read-only consumer missed the provider's theme update");
  await js("fixture.api.setSkinId('mist')");
  await until("document.querySelector('#read-snapshot').dataset.skin === 'mist'", "read-only consumer missed the provider's skin update");
  assert.equal(await js("document.querySelector('#read-snapshot').dataset.instance"), identity);
  assert.equal(await js("fixture.readMounts"), mounts, "theme updates must preserve mounted consumers");
  assert.deepEqual(await js("fixture.errors"), [], "appearance consumers must not raise render or effect errors");

  const callsBeforeGuard = appearanceCalls.length;
  mainWindowId = null;
  await js("fixture.render('settings-without-provider')");
  await until("document.querySelector('#guard-error')?.textContent.includes('requires AppearanceProvider')", "writable hook no longer rejects missing provider");
  assert.equal(appearanceCalls.length, callsBeforeGuard, "guarded access must not create a standalone appearance controller");

  await js("location.hash = '#/selection-explain-window'; fixture.render('auxiliary-error')");
  await until("document.querySelector('.app-error-detail')?.textContent === 'fixture auxiliary view failure'", "auxiliary error recovery did not render");
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.app-error-actions button'), button => button.textContent)"), ["重新加载", "关闭"]);
  assert.equal(await js("document.querySelectorAll('.app-error-actions a').length"), 0);
  const auxiliaryHash = await js("location.hash");
  await js("document.querySelector('.app-error-actions .text-button').click()");
  assert.equal(await js("fixture.exits"), 1, "Close must invoke the auxiliary window callback exactly once");
  assert.equal(await js("location.hash"), auxiliaryHash, "auxiliary recovery must never navigate into the main AppShell");
  assert.equal(appearanceCalls.length, callsBeforeGuard);
  await js("fixture.unmount()");
  fs.writeFileSync(path.join(root, "passed.json"), JSON.stringify({
    ok: true, cases: ["auxiliary-dark", "auxiliary-light", "provider-subscription", "writable-hook-guard", "auxiliary-error-close"]
  }));
  win.destroy();
  app.exit(0);
})().catch((error) => { console.error(error.stack || error); app.exit(1); });
