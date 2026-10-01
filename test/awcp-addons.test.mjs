import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { buildAwcpAddonScript, matchAwcpAddon, AwcpAddonInjection } = require('../dist-electron/main/modules/web-surfaces/awcp/addons/injection.js');
const { AwcpGuestBridge } = require('../dist-electron/main/modules/web-surfaces/awcp/guest-bridge.js');
const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
const url = 'https://1024.qiuer.net/forum';
const plain = (value) => JSON.parse(JSON.stringify(value));
function page(fetcher = async () => new Response(JSON.stringify({ items: [], count: 9 }), { headers: { 'content-type': 'application/json' } })) {
  const events = new EventTarget();
  const calls = [];
  const context = vm.createContext({ location: new URL(url), URL, URLSearchParams, AbortController, Event,
    setTimeout, clearTimeout, fetch: (...args) => { calls.push(args); return fetcher(...args); },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  context.window = context; context.top = context;
  const install = (enabled = true) => vm.runInContext(buildAwcpAddonScript(context.location.href, enabled), context);
  install();
  let sequence = 0;
  const invoke = (action, args = {}, extra = {}) => context.awcp.invoke({ requestId: `test-${++sequence}`, revision: context.awcp.manual().revision, action, args, ...extra });
  return { context, calls, install, invoke };
}

test('URL rules match the exact HTTPS origin and forum path segment', () => {
  for (const suffix of ['', '/', '/posts/19', '?keyword=a', '#x']) assert.equal(matchAwcpAddon(url + suffix)?.id, 'qiuer-forum');
  for (const other of ['https://1024.qiuer.net/forum-other', 'https://1024.qiuer.net/', 'http://1024.qiuer.net/forum',
    'https://1024.qiuer.net.evil.test/forum', 'https://evil.test/forum?next=' + url, 'https://user@1024.qiuer.net/forum',
    'https://1024.qiuer.net:444/forum', 'file:///forum', 'not a URL']) assert.equal(matchAwcpAddon(other), null);
});

test('manual is progressive, immutable to callers, revision-bound and preserves native AWCP', () => {
  const p = page(); const api = p.context.awcp; const directory = plain(api.manual());
  assert.equal(directory.sections.length, 12);
  assert.deepEqual(directory.sections.map(x => x.section), directory.sections.map(x => x.section).sort());
  assert.deepEqual(Object.keys(directory.sections[0]).sort(), ['section', 'title']);
  const section = api.manual({ section: 'forum.posts.list', revision: directory.revision });
  section.inputSchema.properties.keyword.type = 'boolean';
  assert.equal(api.manual({ section: 'forum.posts.list', revision: directory.revision }).inputSchema.properties.keyword.type, 'string');
  assert.equal(api.manual({ section: 'forum.posts.list', revision: 'old' }).error.code, 'stale_revision');
  assert.equal(api.manual({ section: 'missing', revision: directory.revision }).error.code, 'section_not_found');
  p.install(); assert.equal(p.context.awcp, api);
  const native = { protocolVersion: 99 }; p.context.awcp = native; p.install(); assert.equal(p.context.awcp, native);
});

test('reads use same-origin cookies and encoded query parameters, with no credential or arbitrary endpoint arguments', async () => {
  const p = page();
  assert.equal((await p.invoke('forum.posts.list', { keyword: 'a&b 中文', bookmarked: true })).ok, true);
  const [target, options] = p.calls[0];
  assert.equal(new URL(target).searchParams.get('keyword'), 'a&b 中文');
  assert.equal(new URL(target).searchParams.get('bookmarked'), 'true');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Cookie, undefined); assert.equal(options.body, undefined);
  for (const args of [{ postId: '19' }, { postId: '../secret' }, { postId: 19, url: 'https://evil.test' }]) {
    const result = await p.invoke('forum.posts.get', args);
    assert.equal(result.error.code, 'invalid_arguments'); assert.ok(result.error.details.fieldErrors.length);
  }
  assert.equal(p.calls.length, 1);
});

test('writes validate declared fields, map path/body, and reject completed request replay', async () => {
  const p = page();
  const result = await p.invoke('forum.comments.create', { postId: 19, bodyMarkdown: 'A comment' }, { requestId: 'write' });
  assert.equal(result.ok, true);
  assert.equal(p.calls[0][0], url + '/api/v1/posts/19/comments');
  assert.deepEqual(JSON.parse(p.calls[0][1].body), { parentId: null, bodyMarkdown: 'A comment' });
  assert.equal((await p.invoke('forum.comments.create', { postId: 19, bodyMarkdown: 'A comment' }, { requestId: 'write' })).error.code, 'duplicate_request');
  assert.equal((await p.invoke('forum.notifications.mark-read', { ids: [] })).error.code, 'invalid_arguments');
  assert.equal((await p.invoke('forum.posts.create', { title: 'No implicit publish' })).error.code, 'invalid_arguments');
  assert.equal(p.calls.length, 1);
});

test('401, non-JSON, cancellation and leaving the URL rule fail without replay', async () => {
  const unauthorized = page(async () => new Response('{}', { status: 401 }));
  assert.equal((await unauthorized.invoke('forum.posts.list')).error.code, 'action.login_required');
  const html = page(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await html.invoke('forum.posts.list')).error.code, 'execution_failed');
  const p = page((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const pending = p.invoke('forum.posts.list', {}, { requestId: 'cancel-me' });
  assert.equal(p.context.awcp.cancel('cancel-me'), true);
  assert.equal((await pending).error.code, 'cancelled');
  const old = p.context.awcp;
  p.context.location = new URL('https://1024.qiuer.net/other');
  assert.equal((await old.invoke({ requestId: 'outside', revision: 'qiuer-forum:1', action: 'forum.posts.list', args: {} })).error.code, 'stale_revision');
  p.install(); assert.equal(p.context.awcp, undefined); assert.equal(p.calls.length, 1);
  p.context.location = new URL(url); p.install(); assert.ok(p.context.awcp);
});

test('late injection checks actual URL and skips child frames', () => {
  const p = page(); p.install(false);
  p.context.location = new URL('https://other.test/forum');
  vm.runInContext(buildAwcpAddonScript(url), p.context); assert.equal(p.context.awcp, undefined);
  p.context.location = new URL(url); p.context.top = {}; p.install(); assert.equal(p.context.awcp, undefined);
});

test('guest lifecycle installs once, handles SPA entry/exit and removes listeners on detach', async () => {
  const p = page(); p.install(false); p.context.location = new URL('https://1024.qiuer.net/');
  const guest = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false, getURL: () => p.context.location.href,
    executeJavaScript: async script => vm.runInContext(script, p.context) });
  const injection = new AwcpAddonInjection(); injection.attach(guest); injection.attach(guest);
  assert.equal(guest.listenerCount('dom-ready'), 1); assert.equal(p.context.awcp, undefined);
  p.context.location = new URL(url); guest.emit('did-navigate-in-page', {}, url, true); assert.ok(p.context.awcp);
  p.context.location = new URL('https://1024.qiuer.net/'); guest.emit('did-navigate-in-page', {}, p.context.location.href, true); assert.equal(p.context.awcp, undefined);
  p.context.location = new URL(url); guest.emit('dom-ready'); assert.ok(p.context.awcp);
  injection.detach(10); assert.equal(p.context.awcp, undefined); assert.equal(guest.listenerCount('dom-ready'), 0);
});

test('Desktop bridge reads injected manuals and invokes through an authorized Run', async t => {
  const h = createSiteHarness(); const site = h.site('addon'); const guest = h.contents.get(site.tabs[0].webContentsId);
  const p = page(); p.install(false);
  guest.url = url; guest.executeJavaScript = async script => {
    const value = await vm.runInContext(script, p.context);
    return value === undefined ? undefined : plain(value);
  };
  const scope = h.capture(site); scope.activate(); const bridge = new AwcpGuestBridge(h.registry);
  t.after(() => { bridge.dispose(); scope.release(); h.closeTab(site, site.tabs[0].tabId); });
  const index = await bridge.manual('index', {}, scope);
  assert.equal(index.site.name, '1024 论坛 · Desktop AWCP');
  await assert.rejects(bridge.invoke('early', { revision: index.revision, action: 'forum.posts.list', args: {} }, scope), e => e.details.reason === 'manual_required');
  await bridge.manual('section', { section: 'forum.posts.list', revision: index.revision }, scope);
  assert.equal((await bridge.invoke('read', { revision: index.revision, action: 'forum.posts.list', args: {} }, scope)).ok, true);
  assert.equal(p.calls.length, 1);
});

test('minified production bundle serializes a self-contained page runtime', async () => {
  const built = await build({ entryPoints: ['src/main/modules/web-surfaces/awcp/addons/injection.ts'], bundle: true, minify: true, platform: 'node', format: 'cjs', target: 'node20', write: false });
  const exports = { exports: {} }; vm.runInNewContext(built.outputFiles[0].text, { module: exports, exports: exports.exports, URL, require });
  const p = page(); p.install(false);
  vm.runInContext(exports.exports.buildAwcpAddonScript(url), p.context);
  assert.equal((await p.invoke('forum.notifications.unread-count')).result.count, 9);
});
