import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { documentWindowOptions, fitDocumentBounds, readDocumentWindows, writeDocumentWindows } = require('../dist-electron/main/modules/webs/webapps/document-window-state');
const { documentWindowRequestSchema } = require('../dist-electron/shared/webapp-document-windows');
const { parseWebappManifest } = require('../dist-electron/shared/webapp-manifest');
const { createPluginTestRuntime } = require('./helpers/plugin-lifecycle.cjs');
const { startWebappGateway } = require('../dist-electron/main/modules/webs/webapps/gateway');
const { validateWebappPackageDirectory } = require('../src/shared/webapp-package-validation.js');

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: note windows are resizable paper windows with explicit platform options`, () => {
    const options = documentWindowOptions(platform, { x: 40, y: 60, width: 310, height: 330 }, '#fff1ad');
    assert.equal(options.frame, false); assert.equal(options.resizable, true); assert.equal(options.fullscreenable, false);
    assert.equal(options.width, 310); assert.equal(options.minWidth, 240);
    if (platform === 'darwin') { assert.equal(options.roundedCorners, true); assert.equal(options.type, 'normal'); }
    else { assert.equal(options.thickFrame, true); assert.equal(options.autoHideMenuBar, true); assert.equal(options.skipTaskbar, false); }
  });
}
test('window positions remain reachable after unplugging or rearranging monitors, including negative coordinates', () => {
  const monitors = [{ x: 0, y: 25, width: 1200, height: 780 }, { x: -1600, y: 0, width: 1600, height: 900 }];
  const left = { x: -1500, y: 70, width: 310, height: 330 };
  assert.deepEqual(fitDocumentBounds(left, monitors), left);
  assert.deepEqual(fitDocumentBounds(left, [monitors[0]]), { x: 0, y: 70, width: 310, height: 330 });
  assert.deepEqual(fitDocumentBounds({ x: 1150, y: 795, width: 4000, height: 3000 }, [monitors[0]]), monitors[0]);
});
test('document preferences persist separately from notes across app instances and retain hidden windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-notes-preferences-'));
  try {
    const app = createPluginTestRuntime(root).app;
    const state = { 'note-1': { bounds: { x: 42, y: 52, width: 310, height: 330 }, color: '#fff1ad', alwaysOnTop: true, open: false } };
    writeDocumentWindows(app, 'webapp-4abf37ad067b5336', state);
    assert.deepEqual(readDocumentWindows(createPluginTestRuntime(root).app, 'webapp-4abf37ad067b5336'), state);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('document requests accept note operations but reject paths, native options and arbitrary URLs', () => {
  for (const operation of ['open', 'close', 'minimize']) assert.equal(documentWindowRequestSchema.parse({ operation, id: 'note-1' }).id, 'note-1');
  for (const id of ['../notes', 'file:///tmp/a', 'note#one', 'note/one']) assert.equal(documentWindowRequestSchema.safeParse({ operation: 'open', id }).success, false);
  assert.equal(documentWindowRequestSchema.safeParse({ operation: 'open', id: 'note-1', url: 'https://example.com' }).success, false);
  assert.equal(documentWindowRequestSchema.safeParse({ operation: 'update', id: 'note-1', color: 'url(evil)' }).success, false);
  assert.equal(documentWindowRequestSchema.safeParse({ operation: 'update', id: 'note-1', webPreferences: { nodeIntegration: true } }).success, false);
});
test('document windows use an optional app declaration and keep ordinary WebApps unchanged', () => {
  const input = { schemaVersion: 2, id: 'webapp-4abf37ad067b5336', key: 'notes-test', label: 'Notes', version: '0.3.0', target: 'any', frontend: { root: 'frontend', index: 'index.html' } };
  assert.equal(parseWebappManifest(input).desktopBridge.documentWindows, undefined);
  assert.equal(parseWebappManifest({ ...input, desktopBridge: { version: 1, documentWindows: { entry: 'note.html' } } }).desktopBridge.documentWindows.entry, 'note.html');
  for (const entry of ['../note.html', 'https://example.com/note.html', '/note.html']) {
    assert.throws(() => parseWebappManifest({ ...input, desktopBridge: { version: 1, documentWindows: { entry } } }));
  }
});

test('gateway document operations require a declared local entry and same-origin POST', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-window-gateway-'));
  const { app } = createPluginTestRuntime(root);
  const base = { schemaVersion: 2, id: 'webapp-4abf37ad067b5336', key: 'notes-test', label: 'Notes', version: '0.3.0', target: 'any', frontend: { root: 'frontend', index: 'index.html' } };
  fs.mkdirSync(path.join(root, 'frontend')); fs.writeFileSync(path.join(root, 'frontend/index.html'), '<!doctype html>');
  const gateways = [];
  t.after(async () => { for (const gateway of gateways) await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const declared of [false, true]) {
    const manifest = parseWebappManifest({ ...base, ...(declared ? { desktopBridge: { version: 1, documentWindows: { entry: 'note.html' } } } : {}) });
    fs.writeFileSync(path.join(root, 'webapp.json'), JSON.stringify(manifest));
    let calls = 0;
    const gateway = await startWebappGateway({ app, item: { ...manifest, kind: 'webapp' }, webappDir: root, backendUrl: '', pageActionToken: '',
      documentWindows: async input => { documentWindowRequestSchema.parse(input); calls++; return { windows: [] }; } });
    gateways.push(gateway);
    const url = new URL('/__desktop/document-windows', gateway.webUrl);
    const post = (origin, body = { operation: 'list' }) => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('https://foreign.example')).status, 403);
    assert.equal((await fetch(url)).status, 403);
    assert.equal(calls, 0);
    assert.equal((await post(url.origin)).status, declared ? 200 : 403);
    assert.equal(calls, declared ? 1 : 0);
    if (declared) {
      assert.equal((await post(url.origin, { operation: 'open', id: '../other' })).status, 400);
      assert.throws(() => validateWebappPackageDirectory(root, manifest));
      fs.writeFileSync(path.join(root, 'frontend/note.html'), '<!doctype html>');
      assert.doesNotThrow(() => validateWebappPackageDirectory(root, manifest));
    }
  }
});
