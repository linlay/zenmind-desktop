import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AwcpAddonInjection } = require('../dist-electron/main/modules/web-surfaces/awcp/addons/injection.js');
const { AwcpGuestBridge } = require('../dist-electron/main/modules/web-surfaces/awcp/guest-bridge.js');
const { parseWebsiteBridgeManifest } = require('../dist-electron/shared/website-bridge.js');
const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
const url = 'https://site.test/forum';
const plain = (value) => JSON.parse(JSON.stringify(value));
const manifest = { schemaVersion: 2, id: 'sample', name: 'Sample Forum', version: '1.0.0', description: 'Sample site guide.',
  origins: { main: 'https://site.test' }, pages: [{ path: '/forum', features: ['post-search'] }] };
const search = `return { actions: { 'forum.posts.list': { title: 'Search posts', description: 'Reads the visible list.',
  inputSchema: { type: 'object', properties: { keyword: { type: 'string', maxLength: 64 } } },
  async run(args) { globalThis.calls = (globalThis.calls || 0) + 1; return { ok: true, result: { items: [], keyword: args.keyword ?? null } }; } } } };`;
function page() {
  const events = new EventTarget();
  const context = vm.createContext({ location: new URL(url), URL, AbortController, Event, setTimeout, clearTimeout,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  context.window = context; context.top = context;
  return { context };
}
const packages = () => [{ manifest: parseWebsiteBridgeManifest(manifest), scripts: new Map([['features/post-search.js', search]]) }];

test('guest lifecycle installs once, handles SPA entry/exit and removes listeners on detach', async () => {
  const p = page(); p.context.location = new URL('https://site.test/');
  const guest = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, getURL: () => p.context.location.href,
    executeJavaScript: async script => vm.runInContext(script, p.context) });
  const injection = new AwcpAddonInjection(packages); injection.attach(guest); injection.attach(guest);
  assert.equal(guest.listenerCount('dom-ready'), 1); assert.equal(p.context.awcp, undefined);
  p.context.location = new URL(url); guest.emit('did-navigate-in-page', {}, url, true); assert.ok(p.context.awcp);
  p.context.location = new URL('https://site.test/'); guest.emit('did-navigate-in-page', {}, p.context.location.href, true); assert.equal(p.context.awcp, undefined);
  p.context.location = new URL(url); guest.emit('dom-ready'); assert.ok(p.context.awcp);
  injection.detach(10); assert.equal(p.context.awcp, undefined); assert.equal(guest.listenerCount('dom-ready'), 0);
});

test('Desktop bridge reads injected manuals and invokes through an authorized Run', async t => {
  const h = createSiteHarness();
  const zip = new JSZip();
  zip.file('bridge.json', JSON.stringify(manifest)); zip.file('features/post-search.js', search);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awcp-addon-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'bridge.zip');
  fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal((await h.registry.websiteBridges.importFile(archive)).ok, true);
  const site = h.site('addon'); const guest = h.contents.get(site.tabs[0].webContentsId);
  const p = page();
  guest.url = url; guest.executeJavaScript = async script => {
    const value = await vm.runInContext(script, p.context);
    return value === undefined ? undefined : plain(value);
  };
  const scope = h.capture(site); scope.activate(); const bridge = new AwcpGuestBridge(h.registry);
  t.after(() => { bridge.dispose(); scope.release(); h.closeTab(site, site.tabs[0].tabId); });
  const index = await bridge.manual('index', {}, scope);
  assert.deepEqual(index.site, { name: 'Sample Forum', description: 'Sample site guide.' });
  await assert.rejects(bridge.invoke('early', { revision: index.revision, action: 'forum.posts.list', args: {} }, scope), e => e.details.reason === 'manual_required');
  await bridge.manual('section', { section: 'forum.posts.list', revision: index.revision }, scope);
  const result = await bridge.invoke('read', { revision: index.revision, action: 'forum.posts.list', args: { keyword: 'a' } }, scope);
  assert.equal(result.ok, true); assert.equal(result.result.keyword, 'a');
  assert.equal(p.context.calls, 1);
});
