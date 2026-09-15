const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const plugin = path.resolve(process.argv[2]);
const output = process.argv[3] || '/private/tmp/zenmind-system-window-qa';
fs.mkdirSync(output, { recursive: true });
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'system-window-qa-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await delay(100); } throw new Error('timed out'); }
let child, host, bridge, runtime;
const handles = [];
async function invokeSystem(id, directory, method, input) {
  const result = await host.handle(id, directory, method, input);
  if (method === "system.window.create") handles.push(result.windowId);
  return result;
}
app.whenReady().then(async () => {
  const appPort = new Proxy(app, { get(target, key) { if (key === 'getAppPath') return () => root; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', (_event, level, message) => console.log('PAGE', level, message));
    window.webContents.on('preload-error', (_event, preload, error) => console.log('PRELOAD', preload, error));
  });
  bridge = require('../dist-electron/main/modules/plugins/bridge.js');
  const { createPluginSystemWindows } = require('../dist-electron/main/modules/plugins/system-windows.js');
  const { normalizeManifest } = require('../dist-electron/main/support/manifest/manifest-utils.js');
  let data;
  if (plugin.endsWith('.zip')) {
    const { createPluginTestRuntime } = require('../test/helpers/plugin-lifecycle.cjs');
    const servicesModule = require('../dist-electron/main/modules/services');
    const { getServiceDataRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths');
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-install-'));
    runtime = createPluginTestRuntime(stateRoot, { getPluginBridgeEnv: bridge.getPluginBridgeEnv, emitPluginBridgeHook: bridge.emitPluginBridgeHook });
    runtime.app.getAppPath = () => root;
    runtime.app.isReady = () => app.isReady();
    fs.mkdirSync(runtime.app.getPath('temp'), { recursive: true });
    host = createPluginSystemWindows(runtime.app, bridge.emitPluginSystemEvent);
    bridge.configurePluginBridge({ systemRequest: (id, method, input) => invokeSystem(id, servicesModule.getInstallDir(runtime.app, servicesModule.getService(id)), method, input), cleanupPluginBridgePlugin: id => host.cleanup(id) });
    const installed = await runtime.plugins.installFromArchive(runtime.app, plugin);
    assert.equal(installed.ok, true, installed.message);
    assert.equal(runtime.webs.webappManager.listInstalled(runtime.app).length, 0);
    const initialized = await runtime.services.initializeService(runtime.app, 'sticky-notes');
    assert.equal(initialized.ok, true, initialized.message);
    const started = await runtime.services.startService(runtime.app, 'sticky-notes');
    assert.equal(started.ok, true, started.message);
    data = getServiceDataRoot(runtime.app, 'sticky-notes', 'plugin');
  } else {
    const service = normalizeManifest(JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'))), { defaultKind: 'plugin' });
    host = createPluginSystemWindows(appPort, bridge.emitPluginSystemEvent);
    bridge.configurePluginBridge({ systemRequest: (id, method, input) => invokeSystem(id, plugin, method, input), cleanupPluginBridgePlugin: id => host.cleanup(id) });
    const env = bridge.getPluginBridgeEnv(appPort, service);
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-data-'));
    child = spawn(process.execPath, [path.join(plugin, 'main.mjs')], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', SERVICE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  }
  const note = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/note.html')));
  note.webContents.on('console-message', (_event, level, message) => console.log('PAGE', level, message));
  await until(() => note.webContents.executeJavaScript('!document.getElementById("body").disabled').catch(() => false)).catch(async error => { console.log(await note.webContents.executeJavaScript('document.body.innerText')); throw error; });
  assert.equal(note.isAlwaysOnTop(), false);
  await assert.rejects(host.handle('another-plugin', plugin, 'system.window.destroy', { windowId: handles[0] }), /not owned/);
  if (process.platform === 'darwin') {
    const koffi = require('koffi'), objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const sel = objc.func('void *sel_registerName(const char *name)');
    const object = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const integer = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
    const nswindow = object(note.getNativeWindowHandle().readBigUInt64LE(), sel('window'));
    note.focus();
    assert.ok(Number(integer(nswindow, sel('level'))) < 0, 'desktop window must remain below normal applications after focus');
    assert.equal(Number(integer(nswindow, sel('collectionBehavior'))) & 16, 16, 'Show Desktop stationary behavior');
  }
  await note.webContents.executeJavaScript(`document.getElementById('title').value = '系统桌面便签'; document.getElementById('title').dispatchEvent(new Event('input')); document.getElementById('body').value = '应用窗口可以覆盖我。\\n回到桌面继续记录。'; document.getElementById('body').dispatchEvent(new Event('input'));`);
  await until(() => note.webContents.executeJavaScript('document.getElementById("status").textContent === "已保存"'));
  assert.match(fs.readFileSync(path.join(data, 'notes.json'), 'utf8'), /应用窗口可以覆盖我/);
  await note.webContents.executeJavaScript('document.getElementById("body").value = "x".repeat(20001); document.getElementById("body").dispatchEvent(new Event("input"))');
  await until(() => note.webContents.executeJavaScript('document.getElementById("status").className === "error"'));
  note.close(); await delay(350); assert.equal(note.isDestroyed(), false, 'failed save must keep editor open');
  await note.webContents.executeJavaScript('document.getElementById("body").value = "应用窗口可以覆盖我。"; document.getElementById("body").dispatchEvent(new Event("input"))');
  await until(() => note.webContents.executeJavaScript('document.getElementById("status").textContent === "已保存"'));
  await note.webContents.executeJavaScript('document.getElementById("new").click()');
  const second = await until(() => BrowserWindow.getAllWindows().find(w => w !== note && w.webContents.getURL().includes('/note.html')));
  await until(() => second.webContents.executeJavaScript('!document.getElementById("body").disabled').catch(() => false));
  second.close(); await until(() => second.isDestroyed());
  console.log('PASS window ownership and close-request routing');
  const image = await note.webContents.capturePage(); fs.writeFileSync(path.join(output, 'desktop-note.png'), image.toPNG());
  console.log('PASS editable desktop window, plugin bridge, saved content; native handle', note.getNativeWindowHandle().readBigUInt64LE().toString());
  await delay(1500);
  if (runtime) { const stopped = await runtime.services.stopService(runtime.app, 'sticky-notes'); assert.equal(stopped.ok, true, stopped.message); } else child.kill();
  await until(() => BrowserWindow.getAllWindows().length === 0);
  console.log('PASS process-disconnect cleanup');
  if (runtime) {
    assert.equal((await runtime.services.startService(runtime.app, 'sticky-notes')).ok, true);
    const restored = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/note.html')));
    await until(() => restored.webContents.executeJavaScript('document.getElementById("body")?.value.includes("应用窗口可以覆盖我")').catch(() => false));
    assert.equal(BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('/note.html')).length, 1, 'hidden note stays hidden');
    const result = await runtime.plugins.uninstall(runtime.app, 'sticky-notes');
    assert.equal(result.ok, true, result.message);
    await until(() => BrowserWindow.getAllWindows().length === 0);
    console.log('PASS actual ZIP import, start, restart restore, uninstall with zero WebApps');
  }
}).then(() => { bridge?.stopPluginBridgeServers(); host?.dispose(); app.exit(0); }).catch(async error => { console.error(error); child?.kill(); if (runtime) await runtime.services.stopService(runtime.app, 'sticky-notes'); host?.dispose(); app.exit(1); });
