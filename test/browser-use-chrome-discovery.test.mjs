import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchBrowserUseUpstream, supportedPlaywrightCore, browserUseUpstream } from '../scripts/playwright/browser-use-patch.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
patchBrowserUseUpstream(root);
const adapterSource = fs.readFileSync(path.join(root, 'scripts/playwright/browser-use-upstream-adapter.cjs'), 'utf8');
const coreDir = path.dirname(require.resolve('playwright-core/package.json'));
const originalCore = fs.readFileSync(path.join(coreDir, 'lib/coreBundle.js.desktop-original'), 'utf8');

function connection(profile, options = {}) {
  const calls = [];
  const browser = { on: () => undefined };
  const module = { exports: {} };
  const context = vm.createContext({ module, process: { env: {} }, require,
    defaultUserDataDirForChannel(channel) { calls.push(['root', channel]); return '/owned-fixture-root'; },
    async findPlaywrightExtensionProfile(directory) { calls.push(['discover', directory]); return profile; },
    async isExtensionInstalledInProfile() { throw new Error('Disk preflight must not authorize or veto a connection'); },
    CDPRelayServer: class {
      constructor(...args) { calls.push(['relay', ...args]); }
      async start() { calls.push(['start']); }
      async establishExtensionConnection(client) { calls.push(['official-handshake', client]); await options.handshake?.(); }
      cdpEndpoint() { return 'http://127.0.0.1/owned-fixture'; }
      extensionEndpoint() { return 'http://127.0.0.1/owned-fixture-extension'; }
      stop() { calls.push(['stop']); }
    },
    playwright: { chromium: { async connectOverCDP() { calls.push(['connected']); return browser; } } },
  });
  vm.runInContext(adapterSource, context);
  const api = module.exports.__desktopBrowserUse;
  return { calls, connect: (...args) => api.connectExtension(...args) };
}

test('production default parameters treat a discovery miss as no profile hint and still require the official handshake', async () => {
  const f = connection(undefined);
  await f.connect(undefined, undefined, undefined, 'Desktop');
  assert.deepEqual(f.calls, [
    ['root', 'chrome'], ['discover', '/owned-fixture-root'], ['relay', 'chrome', undefined, undefined, undefined],
    ['start'], ['official-handshake', 'Desktop'], ['connected'],
  ]);
});

test('successful auto discovery remains a profile hint and does not replace official approval', async () => {
  const f = connection('Profile 2');
  await f.connect(undefined, undefined, undefined, 'Desktop');
  assert.deepEqual(f.calls.find(call => call[0] === 'relay'), ['relay', 'chrome', undefined, undefined, 'Profile 2']);
  assert.equal(f.calls.filter(call => call[0] === 'official-handshake').length, 1);
});

test('cancelling while the user approves the connection stops the relay', async () => {
  const controller = new AbortController();
  const f = connection(undefined, { handshake: async () => controller.abort() });
  await assert.rejects(f.connect(undefined, undefined, undefined, 'Desktop', controller.signal), { code: 'cancelled' });
  assert.equal(f.calls.some(call => call[0] === 'stop'), true);
  assert.equal(f.calls.some(call => call[0] === 'connected'), false);
});

function fixturePackage(t, version = browserUseUpstream.core, source = originalCore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-integrity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture"}');
  const target = path.join(directory, 'node_modules/playwright-core');
  fs.cpSync(coreDir, target, { recursive: true });
  const manifestFile = path.join(target, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version }));
  fs.writeFileSync(path.join(target, 'lib/coreBundle.js'), source);
  fs.rmSync(path.join(target, 'lib/coreBundle.js.desktop-original'));
  return { directory, target, filename: path.join(target, 'lib/coreBundle.js') };
}

test('the adapter accepts the reviewed stable release only, including rejecting unreviewed patch releases', () => {
  assert.equal(supportedPlaywrightCore('1.64.1'), true);
  for (const version of ['1.64.0', '1.64.2', '1.65.0', '1.99.10', '1.63.9', '2.0.0', '1.65.0-alpha-2026-11-03', '1.64.1-beta-1793483565000', '1.64.0-alpha-1790635538000'])
    assert.equal(supportedPlaywrightCore(version), false, version);
});

test('a prerelease is rejected before its bundle is modified', t => {
  const { directory, filename } = fixturePackage(t, '1.65.0-alpha-2026-11-03', '"use strict";\n');
  assert.throws(() => patchBrowserUseUpstream(directory), /stable playwright-core/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '"use strict";\n');
});

test('an unreviewed stable release is rejected before its bundle is modified', t => {
  const { directory, filename } = fixturePackage(t, '1.70.0', '"use strict";\n');
  assert.throws(() => patchBrowserUseUpstream(directory), /reviewed stable playwright-core/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '"use strict";\n');
});

test('a changed original bundle is rejected before it can execute or create an accepted backup', t => {
  const changed = originalCore + '\nthrow new Error("unreviewed source executed");\n';
  const { directory, filename } = fixturePackage(t, undefined, changed);
  assert.throws(() => patchBrowserUseUpstream(directory), /upstream source checksum differs/);
  assert.equal(fs.readFileSync(filename, 'utf8'), changed);
  assert.equal(fs.existsSync(filename + '.desktop-original'), false);
});

test('the project dependency context resolves a hoisted package without a local node_modules directory', t => {
  const { directory, target } = fixturePackage(t);
  const project = path.join(directory, 'packages', 'desktop');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture-desktop"}');
  assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
  assert.equal(patchBrowserUseUpstream(project), fs.realpathSync(target));
  const api = require(path.join(target, 'lib/coreBundle.js')).__desktopBrowserUse;
  assert.deepEqual(api.missing(), []);
});

test('the project-owned reviewed package is selected ahead of an unrelated ancestor version', t => {
  const { directory, target } = fixturePackage(t);
  const project = path.join(directory, 'packages', 'desktop');
  const nested = path.join(project, 'node_modules', 'playwright-core');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.renameSync(target, nested);
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture-desktop"}');
  fs.mkdirSync(target, { recursive: true });
  const unrelated = JSON.stringify({ name: 'playwright-core', version: '1.63.0' });
  fs.writeFileSync(path.join(target, 'package.json'), unrelated);
  assert.equal(patchBrowserUseUpstream(project), fs.realpathSync(nested));
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), unrelated);
});

test('reapplying the adapter is deterministic and never trusts an unchanged marker with a modified suffix', t => {
  const { directory, filename } = fixturePackage(t);
  patchBrowserUseUpstream(directory);
  const patched = fs.readFileSync(filename, 'utf8');
  patchBrowserUseUpstream(directory);
  assert.equal(fs.readFileSync(filename, 'utf8'), patched);
  fs.appendFileSync(filename, '\nthrow new Error("modified adapter executed");\n');
  patchBrowserUseUpstream(directory);
  assert.equal(fs.readFileSync(filename, 'utf8'), patched);
  fs.appendFileSync(filename + '.desktop-original', '\n// corrupted backup\n');
  assert.throws(() => patchBrowserUseUpstream(directory), /upstream source checksum differs/);
  assert.equal(fs.readFileSync(filename, 'utf8'), patched);
});

test('connection failure categories redact upstream URLs and credentials without assuming an extension is missing', () => {
  const { chromeWorkerResponseError } = require('../dist-electron/main/modules/browser-use/chrome-worker.js');
  const secret = 'SYNTHETIC_FIXTURE_CREDENTIAL';
  const cases = [
    ['Playwright Extension not found in fixture', 'chrome_connection_failed'],
    ['Playwright extension did not connect within 30s', 'chrome_connection_timeout'],
    ['"chrome" executable not found', 'chrome_unavailable'],
    [`relay failure chrome-extension://fixture/connect.html?token=${secret}`, 'chrome_connection_failed'],
  ];
  for (const [message, code] of cases) {
    const result = chromeWorkerResponseError(new Error(message), 'connect');
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.message.includes('chrome-extension://'), false);
    assert.equal(result.message.includes('Install the official'), false);
  }
  assert.deepEqual(chromeWorkerResponseError(Object.assign(new Error('Browser operation cancelled'), { code: 'cancelled' }), 'connect'),
    { code: 'cancelled', message: 'Browser operation cancelled' });
  assert.equal(chromeWorkerResponseError(new Error(secret), 'click').code, 'browser_action_failed');
  assert.equal(chromeWorkerResponseError(undefined, 'connect').code, 'chrome_connection_failed');
});
