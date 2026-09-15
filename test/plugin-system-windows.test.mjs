import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { systemWindowCreateSchema, systemWindowUpdateSchema } = require('../dist-electron/shared/system-windows');
const { resolvePluginWindowAsset } = require('../dist-electron/main/modules/plugins/system-windows');

test('system window contract has system properties and rejects business/window injection', () => {
  const input = { entry: 'ui/index.html', title: 'Example', bounds: { x: -500, y: 30, width: 320, height: 300 }, backgroundColor: '#ffffff', frame: false, layer: 'desktop' };
  assert.equal(systemWindowCreateSchema.parse(input).layer, 'desktop');
  for (const extra of [{ noteId: 'one' }, { preload: '/tmp/escape.js' }, { alwaysOnTop: true }]) assert.throws(() => systemWindowCreateSchema.parse({ ...input, ...extra }));
  assert.throws(() => systemWindowUpdateSchema.parse({ windowId: 'unknown', title: 'new' }));
});

test('plugin asset resolution rejects traversal and symlink escape', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-window-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'plugin'); fs.mkdirSync(pkg); fs.writeFileSync(path.join(pkg, 'index.html'), 'ok'); fs.writeFileSync(path.join(root, 'outside.html'), 'private');
  assert.equal(resolvePluginWindowAsset(pkg, 'index.html'), path.join(fs.realpathSync(pkg), 'index.html'));
  for (const entry of ['../outside.html', '/outside.html', '..\\outside.html']) assert.throws(() => resolvePluginWindowAsset(pkg, entry));
  fs.symlinkSync(path.join(root, 'outside.html'), path.join(pkg, 'link.html'));
  assert.throws(() => resolvePluginWindowAsset(pkg, 'link.html'));
});

test('Windows desktop adapter uses child parenting, converts coordinates, and detects Explorer loss', () => {
  let parent = null, alive = true;
  const positions = [], styles = [];
  const functions = {
    FindWindowExW: (owner, after) => owner === 20n ? 21n : after ? null : 20n,
    GetParent: () => parent, SetParent: (_window, next) => { const old = parent; parent = next; return old; },
    GetWindowLongPtrW: () => 0x80000000n, SetWindowLongPtrW: (_w, _i, style) => styles.push(style),
    IsWindow: () => Number(alive), SetWindowPos: (...args) => { positions.push(args); return 1; },
    SetLastError: () => {}, GetLastError: () => 0,
    GetWindowRect: (_w, rect) => { Object.assign(rect, { left: -2000, top: 0, right: 2000, bottom: 1200 }); return 1; }
  };
  const koffi = { load: () => ({ func(signature) { const name = signature.includes('(') ? signature.match(/(\w+)\(/)[1] : signature; return functions[name]; } }), struct: () => 'rect', out: x => x, pointer: x => x };
  const electron = { screen: { dipToScreenRect: (_w, b) => ({ x: b.x * 2, y: b.y * 2, width: b.width * 2, height: b.height * 2 }), screenToDipRect: (_w, b) => b } };
  const context = { exports: {}, require: name => name === 'koffi' ? koffi : electron, process };
  vm.runInNewContext(fs.readFileSync(new URL('../dist-electron/main/infrastructure/electron/system-window-layer.js', import.meta.url), 'utf8'), context);
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(10n);
  const window = { getNativeWindowHandle: () => handle, getBounds: () => ({ x: -600, y: 40, width: 300, height: 250 }), isDestroyed: () => false, webContents: { focus() {} } };
  const attachment = context.exports.attachDesktopLayer(window, 'win32');
  assert.equal(parent, 20n); assert.equal(styles[0], 0x40000000n);
  assert.deepEqual(positions[0].slice(2, 6), [800, 80, 600, 500]);
  attachment.verify(); alive = false; assert.throws(() => attachment.verify(), /desktop host was lost/);
  attachment.dispose(); assert.equal(parent, null); assert.equal(styles.at(-1), 0x80000000n);
});

function readyFixture() {
  let ready = false;
  const calls = [];
  const screen = new Proxy({}, { get(_target, method) {
    assert.equal(ready, true, `screen.${String(method)} accessed before ready`);
    return (...args) => { calls.push([method, ...args]); return method === 'getAllDisplays' ? [] : undefined; };
  } });
  const electron = { screen, ipcMain: { on: (...args) => calls.push(['ipc.on', ...args]), removeListener: (...args) => calls.push(['ipc.remove', ...args]) } };
  const moduleRequire = createRequire(new URL('../dist-electron/main/modules/plugins/system-windows.js', import.meta.url));
  const context = { exports: {}, process, Buffer, require: name => name === 'electron' ? electron : moduleRequire(name) };
  vm.runInNewContext(fs.readFileSync(new URL('../dist-electron/main/modules/plugins/system-windows.js', import.meta.url), 'utf8'), context);
  return { calls, setReady: () => { ready = true; }, create: () => context.exports.createPluginSystemWindows({ isReady: () => ready }, () => {}) };
}

test('ready-before-assembly is not required, including cleanup and early disposal', async () => {
  const fixture = readyFixture(); const manager = fixture.create();
  assert.deepEqual(fixture.calls, []);
  await assert.rejects(manager.handle('plugin', '', 'system.displays.list', {}), /require Electron ready/);
  manager.cleanup('plugin'); manager.dispose(); manager.dispose();
  fixture.setReady();
  await assert.rejects(manager.handle('plugin', '', 'system.displays.list', {}), /disposed/);
  assert.deepEqual(fixture.calls, [], 'early disposal must not attach or remove unregistered listeners');
});

test('ready alone does no plugin work; first request attaches once and disposal removes listeners once', async () => {
  const fixture = readyFixture(); const manager = fixture.create(); fixture.setReady();
  assert.deepEqual(fixture.calls, []);
  await manager.handle('plugin', '', 'system.displays.list', {});
  await manager.handle('plugin', '', 'system.displays.list', {});
  assert.equal(fixture.calls.filter(([method]) => method === 'on').length, 3);
  assert.equal(fixture.calls.filter(([method]) => method === 'ipc.on').length, 1);
  manager.dispose(); manager.dispose();
  assert.equal(fixture.calls.filter(([method]) => method === 'removeListener').length, 3);
  assert.equal(fixture.calls.filter(([method]) => method === 'ipc.remove').length, 1);
});

test('plugin runtime assembly, configuration and unused shutdown never load the window module', () => {
  let configured;
  const context = { exports: {}, require(name) {
    assert.notEqual(name, './system-windows', 'unused runtime must not load window support');
    return new Proxy({}, { get: (_target, key) => key === 'configurePluginBridge' ? options => { configured = options; } : () => {} });
  } };
  vm.runInNewContext(fs.readFileSync(new URL('../dist-electron/main/modules/plugins/runtime.js', import.meta.url), 'utf8'), context);
  const runtime = context.exports.createPluginBridgeRuntime({ app: {}, clipboardBridge: {}, onError() {} });
  runtime.configure(); runtime.stop();
  assert.throws(() => configured.systemRequest('plugin', 'system.displays.list', {}), /has stopped/);
});

test('loading the native adapter does not load FFI', () => {
  const context = { exports: {}, require(name) { assert.notEqual(name, 'koffi'); }, process };
  vm.runInNewContext(fs.readFileSync(new URL('../dist-electron/main/infrastructure/electron/system-window-layer.js', import.meta.url), 'utf8'), context);
  assert.equal(typeof context.exports.attachDesktopLayer, 'function');
});
