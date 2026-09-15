// Exercise the actual composition root before Electron ready, without starting
// services or touching the user's profile. Run after build:main:prepared.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-startup-'));
for (const name of ['home', 'appData', 'userData', 'sessionData', 'desktop', 'temp']) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
}
assert.equal(app.isReady(), false);
const { createMainProcessRuntime } = require('../dist-electron/main/app/runtime');
const startedAt = performance.now();
const runtime = createMainProcessRuntime();
assert.equal(typeof runtime.start, 'function');
assert.equal(app.isReady(), false);
assert.equal(Object.keys(require.cache).some(file => /[/\\]koffi[/\\]/u.test(file)), false);
const windowsPath = require.resolve('../dist-electron/main/modules/plugins/system-windows');
assert.equal(require.cache[windowsPath], undefined, 'composition must not load system windows');
const { createPluginSystemWindows } = require(windowsPath);
const early = createPluginSystemWindows(app, () => {});
early.cleanup('unused'); early.dispose(); early.dispose();
const manager = createPluginSystemWindows(app, () => {});
assert.equal(ipcMain.listenerCount('plugin-system-window:message'), 0);
console.log(`PASS actual pre-ready composition (${Math.round(performance.now() - startedAt)} ms), no window module or FFI loaded`);
app.whenReady().then(async () => {
  const { screen } = require('electron');
  const events = ['display-added', 'display-removed', 'display-metrics-changed'];
  const before = events.map(name => screen.listenerCount(name));
  await assert.rejects(early.handle('unused', '', 'system.displays.list', {}), /disposed/);
  assert.deepEqual(events.map(name => screen.listenerCount(name)), before);
  await manager.handle('example', '', 'system.displays.list', {});
  await manager.handle('example', '', 'system.displays.list', {});
  assert.deepEqual(events.map(name => screen.listenerCount(name)), before.map(count => count + 1));
  manager.dispose(); manager.dispose();
  assert.deepEqual(events.map(name => screen.listenerCount(name)), before);
  assert.equal(ipcMain.listenerCount('plugin-system-window:message'), 0);
  assert.equal(Object.keys(require.cache).some(file => /[/\\]koffi[/\\]/u.test(file)), false);
  console.log('PASS lazy ready initialization, early shutdown, idempotent disposal; display query does not load FFI');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
