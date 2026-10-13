import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import JSZip from 'jszip';
const require = createRequire(import.meta.url);
const { parseWebsiteBridgeManifest, matchWebsiteBridgePage } = require('../dist-electron/shared/website-bridge.js');
const { createWebsiteBridgeManager } = require('../dist-electron/main/modules/web-surfaces/website-bridges/manager.js');
const { readWebsiteBridgeArchive } = require('../dist-electron/main/modules/web-surfaces/website-bridges/archive.js');
const { buildWebsiteBridgeScript } = require('../dist-electron/main/modules/web-surfaces/website-bridges/injection-script.js');
const { AwcpAddonInjection } = require('../dist-electron/main/modules/web-surfaces/awcp/addons/injection.js');
const manifest = { schemaVersion: 2, id: 'sample', name: 'Sample', version: '1.0.0', origins: { main: 'https://site.test' }, pages: [
  { path: '/posts/:id', features: ['post-read'] }, { path: '/posts/new', features: ['post-compose'] },
] };
// A feature is a function body: it receives `context` and returns its business actions.
const feature = (action, cleanup = 'globalThis.cleaned = (globalThis.cleaned || 0) + 1;') => `return { actions: { ${JSON.stringify(action)}: {
  title: 'Page ' + (context.params.id ?? 'new'), description: 'Sample action.',
  inputSchema: { type: 'object', properties: { note: { type: 'string', maxLength: 8 } } },
  async run(args) { return { ok: true, result: { id: context.params.id ?? null, args, shared: context.shared ?? null } }; },
} }, dispose() { ${cleanup} } };`;
const source = feature('post.read');
const sources = { 'features/post-read.js': source, 'features/post-compose.js': feature('post.compose') };
const packageOf = (value = manifest, files = sources) => ({ manifest: parseWebsiteBridgeManifest(value), scripts: new Map(Object.entries(files)) });
const pageId = p => p.context.awcp.manual().sections[0].title;
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'website-bridge-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function zipAt(root, value = manifest, files = sources) {
  const zip = new JSZip(); zip.file('bridge.json', JSON.stringify(value));
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const file = path.join(root, 'bridge.zip'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); return file;
}
function page(url = 'https://site.test/posts/1') {
  const events = new EventTarget(); const requests = [];
  const context = vm.createContext({ URL, AbortController, Event, location: new URL(url), setTimeout, clearTimeout, crypto,
    fetch: async (...args) => { requests.push(args); return new Response('{"post":{"id":19},"items":[]}', { headers: { 'content-type': 'application/json' } }); },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  context.window = context; context.top = context;
  return { context, requests, run: packages => vm.runInContext(buildWebsiteBridgeScript(context.location.href, packages), context) };
}

test('page rules use pathname and exact origin, with literal routes before parameters', () => {
  const value = parseWebsiteBridgeManifest(manifest);
  assert.deepEqual(matchWebsiteBridgePage(value, 'https://site.test/posts/new?draft=1').page.features, ['post-compose']);
  assert.equal(matchWebsiteBridgePage(value, 'https://site.test/posts/19#comments').params.id, '19');
  assert.equal(value.pages[0].origin, 'main');
  for (const url of ['https://site.test/api/posts/19', 'https://site.test/posts/19/edit', 'https://site.test.evil/posts/19', 'http://site.test/posts/19']) assert.equal(matchWebsiteBridgePage(value, url), null);
  for (const pages of [[{ path: '/x/*', features: ['x'] }], [{ path: '/x', features: ['../x'] }], [{ path: '/x', features: [] }], [{ path: '/x', features: ['x', 'x'] }],
    [{ path: '/x', script: 'features/x.js' }], [{ path: '/x', origin: 'other', features: ['x'] }],
    [{ path: '/:id', features: ['a'] }, { path: '/:name', features: ['b'] }]]) assert.throws(() => parseWebsiteBridgeManifest({ ...manifest, pages }));
});

test('hosts are declared once as keyed origins; one bridge spans several and pages stay root-relative', () => {
  const shop = { ...manifest, id: 'shop', origins: { store: 'https://store.example.test', mall: 'https://mall.example.test:8443/' }, pages: [
    { origin: 'store', path: '/item.htm', features: ['product-read'] },
    { origin: 'mall', path: '/item.htm', description: 'Mall detail.', features: ['product-read', 'cart-add'] },
  ] };
  const value = parseWebsiteBridgeManifest(shop);
  assert.equal(value.origins.mall, 'https://mall.example.test:8443');
  const mallPage = matchWebsiteBridgePage(value, 'https://mall.example.test:8443/item.htm?id=1');
  assert.deepEqual([mallPage.originKey, mallPage.origin, mallPage.page.features], ['mall', 'https://mall.example.test:8443', ['product-read', 'cart-add']]);
  assert.deepEqual(matchWebsiteBridgePage(value, 'https://store.example.test/item.htm').page.features, ['product-read']);
  assert.equal(matchWebsiteBridgePage(value, 'https://www.example.test/item.htm'), null);
  // Switching environment is one edit at the top; page rules are untouched.
  const moved = parseWebsiteBridgeManifest({ ...manifest, origins: { main: 'http://localhost:5173' } });
  assert.deepEqual(matchWebsiteBridgePage(moved, 'http://localhost:5173/posts/new').page, parseWebsiteBridgeManifest(manifest).pages[1]);
  for (const invalid of [{ ...shop, pages: [{ path: '/item.htm', features: ['x'] }] }, { ...shop, origins: { a: 'https://same.test', b: 'https://same.test/' } },
    { ...shop, origins: { Taobao: 'https://store.example.test' } }, { ...shop, origins: { store: 'https://store.example.test/path' } }, { ...shop, origins: {} },
    { ...manifest, schemaVersion: 1, origin: 'https://site.test' }, { ...manifest, origin: 'https://site.test', origins: undefined }]) assert.throws(() => parseWebsiteBridgeManifest(invalid));
});

test('ZIP import validates scripts without executing code in Main', async t => {
  const root = temporary(t); const file = await zipAt(root, manifest, { 'features/post-read.js': source, 'features/post-compose.js': 'globalThis.__websiteBridgeMainExecuted = true;', 'shared.js': 'return {};' });
  const pkg = await readWebsiteBridgeArchive(file); assert.equal(pkg.scripts.size, 3); assert.equal(globalThis.__websiteBridgeMainExecuted, undefined);
  await zipAt(root, manifest, { 'features/post-read.js': 'syntax (', 'features/post-compose.js': source });
  await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidScript' });
  await zipAt(root, manifest, { 'features/post-read.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  await zipAt(root, manifest, { 'features/post-read.js': source, 'features/post-compose.js': source, '../escape.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  for (const extra of ['features/unused.js', 'pages/post.js', 'README.md']) { await zipAt(root, manifest, { ...sources, [extra]: source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' }); }
  await zipAt(root, manifest, { 'features/post-read.js': ' '.repeat(600 * 1024), 'features/post-compose.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'packageTooLarge' });
});

test('ZIP rejects symlinks and case-colliding paths on both platforms', async t => {
  const root = temporary(t); const zip = new JSZip(); zip.file('bridge.json', JSON.stringify(manifest));
  zip.file('features/post-read.js', source, { unixPermissions: 0o120777 }); zip.file('features/post-compose.js', source);
  const file = path.join(root, 'link.zip'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  await zipAt(root, manifest, { 'features/post-read.js': source, 'features/post-compose.js': source, 'features/POST-READ.js': source });
  await assert.rejects(readWebsiteBridgeArchive(path.join(root, 'bridge.zip')), { code: 'invalidPackage' });
});

test('packages persist, update atomically, retain disabled state and do not resurrect after removal', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data/webs/website-bridges'), configRoot: path.join(root, 'config/webs') };
  let manager = createWebsiteBridgeManager(storage); assert.deepEqual(manager.list().items, []);
  const zip = await zipAt(root); assert.equal((await manager.importFile(zip)).ok, true);
  await manager.setEnabled('sample', false);
  await zipAt(root, { ...manifest, version: '1.1.0' }); assert.equal((await manager.importFile(zip)).ok, true);
  manager = createWebsiteBridgeManager(storage); const item = manager.list().items.find(item => item.id === 'sample');
  assert.equal(item.version, '1.1.0'); assert.equal(item.enabled, false);
  await zipAt(root, { ...manifest, version: '2.0.0' }, { 'features/post-read.js': '(', 'features/post-compose.js': source });
  assert.equal((await manager.importFile(zip)).ok, false); assert.equal(manager.list().items.find(item => item.id === 'sample').version, '1.1.0');
  const exported = await manager.exportBytes('sample'); fs.writeFileSync(zip, exported); assert.equal((await readWebsiteBridgeArchive(zip)).manifest.version, '1.1.0');
  await manager.remove('sample'); manager = createWebsiteBridgeManager(storage); assert.deepEqual(manager.list().items, []);
});

test('conflicting site packages, wrong update identity and lost owner do not change installation', async t => {
  const root = temporary(t); const manager = createWebsiteBridgeManager(); const file = await zipAt(root);
  await manager.importFile(file);
  await zipAt(root, { ...manifest, id: 'other' }); assert.equal((await manager.importFile(file)).error, 'conflict');
  // Any shared origin conflicts, even when the other package also claims new ones.
  await zipAt(root, { ...manifest, id: 'other', origins: { extra: 'https://extra.test', main: 'https://site.test' }, pages: manifest.pages.map(page => ({ ...page, origin: 'extra' })) });
  assert.equal((await manager.importFile(file)).error, 'conflict');
  assert.equal((await manager.importFile(file, () => {}, 'sample')).error, 'invalidPackage');
  assert.equal((await manager.setEnabled('sample', false, () => { throw new Error('Owner closed'); })).ok, false);
  assert.equal(manager.list().items.find(item => item.id === 'sample').enabled, true);
  await zipAt(root, { ...manifest, id: 'other', origins: { main: 'https://other.test' } }); assert.equal((await manager.importFile(file)).ok, true);
});

test('corrupt persisted state fails closed without replacing files or enabling builtins', t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  fs.mkdirSync(storage.configRoot); fs.writeFileSync(path.join(storage.configRoot, 'website-bridges.json'), '{broken');
  const manager = createWebsiteBridgeManager(storage); assert.equal(manager.list().error, 'storageFailed'); assert.equal(manager.runtimePackages().length, 0);
  assert.equal(fs.readFileSync(path.join(storage.configRoot, 'website-bridges.json'), 'utf8'), '{broken');
});

test('same page installs once; route parameters, disable and native AWCP preserve lifecycle boundaries', () => {
  const pkg = packageOf();
  const p = page(); p.run([pkg]); const first = p.context.awcp; assert.equal(pageId(p), 'Page 1'); p.run([pkg]); assert.equal(p.context.awcp, first);
  p.context.location = new URL('https://site.test/posts/1?tab=comments'); p.run([pkg]); assert.equal(p.context.awcp, first);
  p.context.location = new URL('https://site.test/posts/2'); p.run([pkg]); assert.equal(pageId(p), 'Page 2'); assert.equal(p.context.cleaned, 1);
  p.run([]); assert.equal(p.context.awcp, undefined); assert.equal(p.context.cleaned, 2);
  p.context.awcp = { protocolVersion: 99 }; const native = p.context.awcp; p.run([pkg]); assert.equal(p.context.awcp, native);
});

test('a page composes its features into one AWCP; shared helper, relative paths and origin keys come from the host', async () => {
  const shop = { ...manifest, id: 'shop', name: 'Shop', description: 'Site guide.', origins: { store: 'https://store.example.test', mall: 'https://mall.example.test' }, pages: [
    { origin: 'store', path: '/item.htm', features: ['product-read'] },
    { origin: 'mall', path: '/item.htm', description: 'Mall detail.', features: ['product-read', 'cart-add'] },
  ] };
  const read = `return { actions: { 'product.read': { title: 'Read', description: 'Read product.', inputSchema: { type: 'object', properties: {} },
    run: () => ({ ok: true, result: { key: context.originKey, origin: context.origin, bridge: context.bridge, tool: context.shared.tool(),
      same: context.resolve('/cart?id=1'), other: context.resolve('/item.htm?id=2', 'store') } }) } } };`;
  const cart = `return { actions: { 'cart.add': { title: 'Add', description: 'Add to cart.', inputSchema: { type: 'object', required: ['sku'], properties: { sku: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    run: args => ({ ok: true, result: args }) } } };`;
  const files = { 'features/product-read.js': read, 'features/cart-add.js': cart, 'shared.js': 'return { tool: () => context.origin + context.pathname, dispose() { globalThis.sharedCleaned = true; } };' };
  const pkg = packageOf(shop, files);
  const p = page('https://mall.example.test/item.htm?id=9'); p.run([pkg]);
  const index = p.context.awcp.manual();
  assert.deepEqual(Array.from(index.sections, item => item.section), ['cart.add', 'product.read']);
  assert.equal(index.site.name, 'Shop'); assert.equal(index.site.description, 'Site guide.\n\nMall detail.\n\nOrigins by key: store=https://store.example.test, mall=https://mall.example.test. This page: mall.');
  const call = (action, args = {}, requestId = action) => p.context.awcp.invoke({ requestId, revision: index.revision, action, args });
  assert.deepEqual(JSON.parse(JSON.stringify((await call('product.read')).result)), { key: 'mall', origin: 'https://mall.example.test', bridge: { id: 'shop', version: '1.0.0' },
    tool: 'https://mall.example.test/item.htm', same: 'https://mall.example.test/cart?id=1', other: 'https://store.example.test/item.htm?id=2' });
  assert.deepEqual(JSON.parse(JSON.stringify((await call('cart.add', { sku: { id: 0 } })).error.details.fieldErrors)), [{ path: ['sku', 'id'], messages: ['Expected a number in the declared range.'] }]);
  assert.equal((await call('cart.add', { sku: { id: 3 }, url: 'https://evil.test' }, 'extra')).error.code, 'invalid_arguments');
  assert.equal((await call('cart.add', { sku: { id: 3 } }, 'ok')).ok, true);
  // The same feature file serves the other origin, where the cart feature is not loaded.
  p.context.location = new URL('https://store.example.test/item.htm'); p.run([pkg]); assert.equal(p.context.sharedCleaned, true);
  assert.deepEqual(Array.from(p.context.awcp.manual().sections, item => item.section), ['product.read']);
  // A feature cannot turn a relative path into another host.
  const q = page('https://store.example.test/item.htm'); q.run([packageOf(shop, { ...files, 'features/product-read.js': read.replace("'/cart?id=1'", "'//evil.test/'") })]);
  assert.equal((await q.context.awcp.invoke({ requestId: 'evil', revision: q.context.awcp.manual().revision, action: 'product.read', args: {} })).error.code, 'execution_failed');
});

test('duplicate action names, non-feature results and async setup fail the whole page without leaving partial state', () => {
  const both = { ...manifest, pages: [{ path: '/posts/:id', features: ['post-read', 'post-compose'] }] };
  for (const second of [feature('post.read'), 'return 1;', 'return Promise.resolve({ actions: {} });', "return { actions: { 'x': { title: 'X' } } };", 'throw Error("setup");']) {
    const p = page(); assert.throws(() => p.run([packageOf(both, { 'features/post-read.js': source, 'features/post-compose.js': second })]));
    assert.equal(p.context.awcp, undefined); assert.equal(p.context.__zenmindWebsiteBridge, undefined); assert.ok(p.context.cleaned >= 1);
  }
});

test('runtime owns the protocol: progressive manual, request replay, cancellation and leaving the page rule', async () => {
  const slow = `return { actions: { 'post.read': { title: 'Read', description: 'Slow.', inputSchema: { type: 'object', properties: {} },
    run: (args, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) } } };`;
  const p = page(); p.run([packageOf(manifest, { ...sources, 'features/post-read.js': slow })]);
  const api = p.context.awcp; const index = api.manual();
  assert.deepEqual(Object.keys(index.sections[0]).sort(), ['section', 'title']);
  const section = api.manual({ section: 'post.read', revision: index.revision }); section.inputSchema.type = 'changed';
  assert.equal(api.manual({ section: 'post.read', revision: index.revision }).inputSchema.type, 'object');
  assert.equal(api.manual({ section: 'post.read', revision: 'old' }).error.code, 'stale_revision');
  assert.equal(api.manual({ section: 'missing', revision: index.revision }).error.code, 'section_not_found');
  await assert.rejects(api.invoke({ requestId: 'x', revision: index.revision, action: 'post.read' }), { name: 'TypeError' });
  const pending = api.invoke({ requestId: 'cancel-me', revision: index.revision, action: 'post.read', args: {} });
  assert.equal(api.cancel('cancel-me'), true); assert.equal((await pending).error.code, 'cancelled'); assert.equal(api.cancel('cancel-me'), false);
  assert.equal((await api.invoke({ requestId: 'cancel-me', revision: index.revision, action: 'post.read', args: {} })).error.code, 'duplicate_request');
  assert.equal((await api.invoke({ requestId: 'missing', revision: index.revision, action: 'post.none', args: {} })).error.code, 'action_not_found');
  p.context.location = new URL('https://site.test/other');
  assert.equal((await api.invoke({ requestId: 'outside', revision: index.revision, action: 'post.read', args: {} })).error.code, 'stale_revision');
  assert.throws(() => api.manual());
});

test('features may derive actions from the visible page; the revision follows what they declare', async () => {
  const dynamic = `return { actions: () => Object.fromEntries((globalThis.buttons || []).map(name => ['ui.' + name, { title: name, description: 'Click ' + name, inputSchema: { type: 'object', properties: {} }, run: () => ({ ok: true, result: name }) }])) };`;
  const p = page(); p.run([packageOf(manifest, { ...sources, 'features/post-read.js': dynamic })]);
  const empty = p.context.awcp.manual(); assert.deepEqual(Array.from(empty.sections), []);
  p.context.buttons = ['save']; const index = p.context.awcp.manual(); assert.notEqual(index.revision, empty.revision); assert.ok(index.revision.length <= 128);
  assert.equal(p.context.awcp.manual().revision, index.revision);
  assert.equal((await p.context.awcp.invoke({ requestId: 'old', revision: empty.revision, action: 'ui.save', args: {} })).error.code, 'stale_revision');
  assert.equal((await p.context.awcp.invoke({ requestId: 'new', revision: index.revision, action: 'ui.save', args: {} })).result, 'save');
});

test('manager enable and uninstall refresh already open guests', async t => {
  const root = temporary(t); const manager = createWebsiteBridgeManager(); await manager.importFile(await zipAt(root));
  const p = page(); const guest = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false, getURL: () => p.context.location.href, executeJavaScript: async script => vm.runInContext(script, p.context) });
  const injection = new AwcpAddonInjection(manager.runtimePackages); manager.subscribe(() => injection.refresh()); injection.attach(guest); assert.equal(pageId(p), 'Page 1');
  await manager.setEnabled('sample', false); assert.equal(p.context.awcp, undefined);
  await manager.setEnabled('sample', true); assert.equal(pageId(p), 'Page 1');
  await manager.remove('sample'); assert.equal(p.context.awcp, undefined); injection.detach(8); assert.equal(guest.listenerCount('dom-ready'), 0);
});

test('management IPC rejects foreign windows and child frames, and uses explicit picker platform policy', async () => {
  const filename = path.resolve('dist-electron/main/modules/web-surfaces/website-bridges/ipc.js'); const localRequire = createRequire(filename);
  const module = { exports: {} }; const fakeElectron = { dialog: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`)(id => id === 'electron' ? fakeElectron : localRequire(id), module, module.exports);
  const { registerWebsiteBridgeIpc, websiteBridgeDialogOptions } = module.exports;
  assert.deepEqual(websiteBridgeDialogOptions('win32').properties, ['openFile', 'dontAddToRecent']); assert.deepEqual(websiteBridgeDialogOptions('darwin').properties, ['openFile']);
  const handlers = new Map(); const frame = {}; const contents = { mainFrame: frame, isDestroyed: () => false };
  registerWebsiteBridgeIpc({ handle: (name, handler) => handlers.set(name, handler) }, { getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }), browserSurfaces: { websiteBridges: createWebsiteBridgeManager() } });
  const list = handlers.get('settings.listWebsiteBridges');
  await assert.rejects(list({ sender: {}, senderFrame: frame })); await assert.rejects(list({ sender: contents, senderFrame: {} }));
  assert.equal((await list({ sender: contents, senderFrame: frame })).ok, true);
});

test('minified production runtime remains self-contained in the page world', async () => {
  const { build } = await import('esbuild');
  const output = await build({ entryPoints: ['src/main/modules/web-surfaces/website-bridges/injection-script.ts'], bundle: true, platform: 'node', format: 'cjs', minify: true, write: false });
  const mod = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module: mod, exports: mod.exports, require, URL });
  const p = page('https://site.test/posts/19'); vm.runInContext(mod.exports.buildWebsiteBridgeScript(p.context.location.href, [packageOf()]), p.context);
  const result = await p.context.awcp.invoke({ requestId: 'minified', revision: p.context.awcp.manual().revision, action: 'post.read', args: { note: 'hi' } });
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { id: '19', args: { note: 'hi' }, shared: null });
});

test('invalid guest URL, child frames, late injection and throwing cleanup do not block subsequent bridges', () => {
  assert.equal(buildWebsiteBridgeScript('', []), 'void 0');
  const pkg = packageOf(manifest, { ...sources, 'features/post-read.js': feature('post.read', 'throw Error("bad cleanup");') });
  const p = page(); p.run([pkg]);
  p.context.location = new URL('https://site.test/posts/2'); p.run([pkg]);
  assert.equal(pageId(p), 'Page 2');
  const late = page(); const script = buildWebsiteBridgeScript(late.context.location.href, [pkg]);
  late.context.location = new URL('https://site.test/posts/3'); vm.runInContext(script, late.context); assert.equal(late.context.awcp, undefined);
  const framed = page(); framed.context.top = {}; framed.run([pkg]); assert.equal(framed.context.awcp, undefined);
});

test('stable ID directory retains identity and disabled state across updates', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  let manager = createWebsiteBridgeManager(storage);
  await manager.importFile(await zipAt(root)); await manager.setEnabled('sample', false);
  const catalogPath = path.join(storage.configRoot, 'website-bridges.json');
  const before = fs.readFileSync(catalogPath, 'utf8');
  const entry = JSON.parse(before).items.find(item => item.id === 'sample');
  const target = path.join(storage.packagesRoot, 'sample');
  manager = createWebsiteBridgeManager(storage);
  assert.equal(manager.list().ok, true);
  assert.equal(manager.list().items.find(item => item.id === 'sample').enabled, false);
  assert.equal(fs.existsSync(path.join(target, 'bridge.json')), true);
  assert.equal(fs.existsSync(path.join(target, entry.digest)), false);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), before);
  await manager.importFile(await zipAt(root, { ...manifest, version: '2.0.0' }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'bridge.json'))).version, '2.0.0');
  assert.equal(fs.existsSync(path.join(storage.packagesRoot, '.backup-sample')), false);
});

for (const failure of ['promote', 'catalog']) test(`failed ${failure} restores the previous package and catalogue`, async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const manager = createWebsiteBridgeManager(storage); await manager.importFile(await zipAt(root));
  const catalog = path.join(storage.configRoot, 'website-bridges.json'); const before = fs.readFileSync(catalog, 'utf8');
  const zip = await zipAt(root, { ...manifest, version: '2.0.0' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if ((failure === 'catalog' && to === catalog) || (failure === 'promote' && path.basename(from).startsWith('.staging-'))) throw new Error('injected failure');
    return rename(from, to);
  });
  assert.equal((await manager.importFile(zip)).ok, false);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(catalog, 'utf8'), before);
  assert.equal(createWebsiteBridgeManager(storage).list().items.find(item => item.id === 'sample').version, '1.0.0');
});

for (const phase of ['backed-up', 'promoted', 'committed']) test(`interrupted ${phase} update recovers using the catalogue digest`, async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const manager = createWebsiteBridgeManager(storage); await manager.importFile(await zipAt(root));
  const catalog = path.join(storage.configRoot, 'website-bridges.json'); const before = fs.readFileSync(catalog, 'utf8');
  const target = path.join(storage.packagesRoot, 'sample'); const old = path.join(root, 'old');
  fs.cpSync(target, old, { recursive: true });
  await manager.importFile(await zipAt(root, { ...manifest, version: '2.0.0' }));
  fs.renameSync(old, path.join(storage.packagesRoot, '.backup-sample'));
  if (phase !== 'committed') fs.writeFileSync(catalog, before);
  if (phase === 'backed-up') fs.rmSync(target, { recursive: true });
  const recovered = createWebsiteBridgeManager(storage);
  assert.equal(recovered.list().items.find(item => item.id === 'sample').version, phase === 'committed' ? '2.0.0' : '1.0.0');
  assert.equal(fs.existsSync(path.join(storage.packagesRoot, '.backup-sample')), false);
});

test('tampered stable package fails closed', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const manager = createWebsiteBridgeManager(storage); await manager.importFile(await zipAt(root));
  fs.appendFileSync(path.join(storage.packagesRoot, 'sample/features/post-read.js'), '\n// changed');
  assert.equal(createWebsiteBridgeManager(storage).list().error, 'storageFailed');
});

for (const platform of ['win32', 'darwin']) test(`${platform} replacement never renames over an existing package directory`, async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (fs.statSync(from).isDirectory()) assert.equal(fs.existsSync(to), false, `${platform} requires an absent directory destination`);
    return rename(from, to);
  });
  const manager = createWebsiteBridgeManager(storage);
  assert.equal((await manager.importFile(await zipAt(root))).ok, true);
  assert.equal((await manager.importFile(await zipAt(root, { ...manifest, version: '2.0.0' }))).ok, true);
  assert.equal(createWebsiteBridgeManager(storage).list().items.find(item => item.id === 'sample').version, '2.0.0');
});

test('rollback failure preserves backup and blocks mutations until startup recovery', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const manager = createWebsiteBridgeManager(storage); await manager.importFile(await zipAt(root));
  const zip = await zipAt(root, { ...manifest, version: '2.0.0' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(storage.configRoot, 'website-bridges.json') || path.basename(from) === '.backup-sample') throw new Error('locked');
    return rename(from, to);
  });
  assert.equal((await manager.importFile(zip)).error, 'storageFailed');
  assert.equal((await manager.remove('sample')).error, 'storageFailed');
  assert.equal(fs.existsSync(path.join(storage.packagesRoot, '.backup-sample/bridge.json')), true);
  t.mock.restoreAll();
  assert.equal(createWebsiteBridgeManager(storage).list().items.find(item => item.id === 'sample').version, '1.0.0');
});

test('legacy hash directory is rejected without migration', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  await createWebsiteBridgeManager(storage).importFile(await zipAt(root));
  const entry = JSON.parse(fs.readFileSync(path.join(storage.configRoot, 'website-bridges.json'))).items[0];
  const target = path.join(storage.packagesRoot, entry.id); const staged = path.join(root, 'legacy');
  fs.renameSync(target, staged); fs.mkdirSync(target); fs.renameSync(staged, path.join(target, entry.digest));
  assert.equal(createWebsiteBridgeManager(storage).list().error, 'storageFailed');
  assert.equal(fs.existsSync(path.join(target, entry.digest, 'bridge.json')), true);
  assert.equal(fs.existsSync(path.join(target, 'bridge.json')), false);
});

test('a package installed under the removed schema is listed as outdated, never injected, and replaced by importing its update', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const other = { ...manifest, id: 'other', origins: { main: 'https://other.test' } };
  let manager = createWebsiteBridgeManager(storage);
  await manager.importFile(await zipAt(root)); await manager.importFile(await zipAt(root, other)); await manager.setEnabled('sample', false);
  const target = path.join(storage.packagesRoot, 'sample');
  fs.rmSync(target, { recursive: true }); fs.mkdirSync(path.join(target, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(target, 'bridge.json'), JSON.stringify({ schemaVersion: 1, id: 'sample', name: 'Old Sample', version: '0.9.0', origin: 'https://site.test', pages: [{ path: '/posts/:id', script: 'pages/post.js' }] }));
  fs.writeFileSync(path.join(target, 'pages/post.js'), 'globalThis.awcp = {};');
  manager = createWebsiteBridgeManager(storage);
  const items = manager.list().items; const old = items.find(item => item.id === 'sample');
  assert.deepEqual([old.outdated, old.name, old.version, old.enabled, old.pages.length], [true, 'Old Sample', '0.9.0', false, 0]);
  assert.equal(items.find(item => item.id === 'other').outdated, undefined);
  assert.deepEqual(manager.runtimePackages().map(item => item.manifest.id), ['other']);
  await manager.setEnabled('sample', true); assert.deepEqual(manager.runtimePackages().map(item => item.manifest.id), ['other']);
  await assert.rejects(manager.exportBytes('sample'), { code: 'notFound' });
  assert.equal((await manager.importFile(await zipAt(root), () => {}, 'sample')).ok, true);
  manager = createWebsiteBridgeManager(storage); const updated = manager.list().items.find(item => item.id === 'sample');
  assert.deepEqual([updated.outdated, updated.version, updated.enabled], [undefined, '1.0.0', true]);
  assert.equal(fs.existsSync(path.join(target, 'pages')), false);
});

test('seed validation rejects all packages before writing and never executes scripts', t => {
  const { initializeWebsiteBridgeSeeds } = require('../dist-electron/main/modules/web-surfaces/website-bridges/seed.js');
  const root = temporary(t);
  const seeds = path.join(root, 'desktop-init/website-bridges');
  const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  const write = (id, script) => {
    const dir = path.join(seeds, id);
    fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ ...manifest, id, origins: { main: `https://${id}.test` } }));
    for (const name of ['post-read', 'post-compose']) fs.writeFileSync(path.join(dir, `features/${name}.js`), script);
  };
  write('sample', 'globalThis.__seedExecuted = true;');
  write('broken', 'syntax (');
  assert.throws(() => initializeWebsiteBridgeSeeds(storage, seeds, ['sample', 'broken']));
  assert.equal(fs.existsSync(storage.packagesRoot), false);
  assert.throws(() => initializeWebsiteBridgeSeeds(storage, seeds, ['../sample']));
  assert.throws(() => initializeWebsiteBridgeSeeds(storage, seeds, ['sample', 'sample']));
  const scriptPath = path.join(seeds, 'sample/features/post-read.js');
  fs.unlinkSync(scriptPath); fs.symlinkSync(path.join(seeds, 'sample/features/post-compose.js'), scriptPath);
  assert.throws(() => initializeWebsiteBridgeSeeds(storage, seeds, ['sample']));
  fs.unlinkSync(scriptPath); fs.writeFileSync(scriptPath, 'globalThis.__seedExecuted = true;');
  assert.equal(initializeWebsiteBridgeSeeds(storage, seeds, ['sample']), 'applied');
  assert.equal(globalThis.__seedExecuted, undefined);
  assert.equal(createWebsiteBridgeManager(storage).list().items[0].id, 'sample');
  assert.equal(initializeWebsiteBridgeSeeds(storage, seeds, ['broken']), 'preserved');
});

test('seed catalogue commit failure rolls back every newly installed package', t => {
  const { initializeWebsiteBridgeSeeds } = require('../dist-electron/main/modules/web-surfaces/website-bridges/seed.js');
  const root = temporary(t); const seeds = path.join(root, 'desktop-init/website-bridges');
  const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  for (const id of ['first', 'second']) {
    const dir = path.join(seeds, id); fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ ...manifest, id, origins: { main: `https://${id}.test` } }));
    for (const [name, content] of Object.entries(sources)) fs.writeFileSync(path.join(dir, name), content);
  }
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(storage.configRoot, 'website-bridges.json')) throw new Error('catalogue locked');
    return rename(from, to);
  });
  assert.throws(() => initializeWebsiteBridgeSeeds(storage, seeds, ['first', 'second']), /catalogue locked/);
  assert.deepEqual(fs.readdirSync(storage.packagesRoot), []);
  assert.equal(fs.existsSync(path.join(storage.configRoot, 'website-bridges.json')), false);
});
