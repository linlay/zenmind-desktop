import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchBrowserUseUpstream } from '../scripts/browser-use-patch.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
patchBrowserUseUpstream(root);
const source = fs.readFileSync(path.join(root, 'node_modules/playwright-core/lib/coreBundle.js'), 'utf8');
const start = source.indexOf('async function createExtensionBrowser(');
const end = source.indexOf('\nvar import_path60,', start);
assert.ok(start >= 0 && end > start);

function connection(profile) {
  const calls = [];
  const browser = { on: () => undefined };
  const context = vm.createContext({ process: { env: {} }, import_path60: { default: path },
    defaultUserDataDirForChannel(channel) { calls.push(['root', channel]); return '/owned-fixture-root'; },
    async findPlaywrightExtensionProfile(directory) { calls.push(['discover', directory]); return profile; },
    async isExtensionInstalledInProfile() { throw new Error('Disk preflight must not authorize or veto a connection'); },
    CDPRelayServer: class {
      constructor(...args) { calls.push(['relay', ...args]); }
      async start() { calls.push(['start']); }
      async establishExtensionConnection(client) { calls.push(['official-handshake', client]); }
      cdpEndpoint() { return 'http://127.0.0.1/owned-fixture'; }
      extensionEndpoint() { return 'http://127.0.0.1/owned-fixture-extension'; }
      stop() { calls.push(['stop']); }
    },
    playwright: { chromium: { async connectOverCDP() { calls.push(['connected']); return browser; } } },
    debugLogger3() {},
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.connect = createExtensionBrowser;', context);
  return { calls, connect: context.connect };
}

test('production default parameters treat a discovery miss as no profile hint and still require the official handshake', async () => {
  const f = connection(undefined);
  await f.connect('chrome', undefined, undefined, undefined, 'Desktop');
  assert.deepEqual(f.calls, [
    ['root', 'chrome'], ['discover', '/owned-fixture-root'], ['relay', 'chrome', undefined, undefined, undefined],
    ['start'], ['official-handshake', 'Desktop'], ['connected'],
  ]);
});

test('successful auto discovery remains a profile hint and does not replace official approval', async () => {
  const f = connection('Profile 2');
  await f.connect('chrome', undefined, undefined, undefined, 'Desktop');
  assert.deepEqual(f.calls.find(call => call[0] === 'relay'), ['relay', 'chrome', undefined, undefined, 'Profile 2']);
  assert.equal(f.calls.filter(call => call[0] === 'official-handshake').length, 1);
});

test('upstream patch rejects a changed original source checksum before modifying it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-integrity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['playwright-core', 'playwright', '@playwright/mcp']) {
    const target = path.join(directory, 'node_modules', name);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(root, 'node_modules', name, 'package.json'), path.join(target, 'package.json'));
  }
  const filename = path.join(directory, 'node_modules/playwright-core/lib/coreBundle.js');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tampered = fs.readFileSync(path.join(root, 'node_modules/playwright-core/lib/coreBundle.js.desktop-original'), 'utf8') + '\n// modified source\n';
  fs.writeFileSync(filename, tampered);
  assert.throws(() => patchBrowserUseUpstream(directory), /source checksum differs/);
  assert.equal(fs.readFileSync(filename, 'utf8'), tampered);
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
