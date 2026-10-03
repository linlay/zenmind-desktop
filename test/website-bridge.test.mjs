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
const { builtinForumBridge } = require('../dist-electron/main/modules/web-surfaces/website-bridges/builtin.js');
const { AwcpAddonInjection } = require('../dist-electron/main/modules/web-surfaces/awcp/addons/injection.js');
const manifest = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0', origin: 'https://site.test', pages: [
  { path: '/posts/:id', script: 'pages/post.js' }, { path: '/posts/new', script: 'pages/new.js' },
] };
const source = 'globalThis.awcp = { protocolVersion: 1, page: context.params.id ?? "new" }; return () => { globalThis.cleaned = (globalThis.cleaned || 0) + 1; };';
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'website-bridge-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function zipAt(root, value = manifest, files = { 'pages/post.js': source, 'pages/new.js': source }) {
  const zip = new JSZip(); zip.file('bridge.json', JSON.stringify(value));
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const file = path.join(root, 'bridge.zip'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); return file;
}
function page(url = 'https://site.test/posts/1') {
  const events = new EventTarget(); const requests = [];
  const context = vm.createContext({ URL, AbortController, Event, location: new URL(url), setTimeout, clearTimeout,
    fetch: async (...args) => { requests.push(args); return new Response('{"post":{"id":19},"items":[]}', { headers: { 'content-type': 'application/json' } }); },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  context.window = context; context.top = context;
  return { context, requests, run: packages => vm.runInContext(buildWebsiteBridgeScript(context.location.href, packages), context) };
}

test('page rules use pathname and exact origin, with literal routes before parameters', () => {
  const value = parseWebsiteBridgeManifest(manifest);
  assert.equal(matchWebsiteBridgePage(value, 'https://site.test/posts/new?draft=1').page.script, 'pages/new.js');
  assert.equal(matchWebsiteBridgePage(value, 'https://site.test/posts/19#comments').params.id, '19');
  for (const url of ['https://site.test/api/posts/19', 'https://site.test/posts/19/edit', 'https://site.test.evil/posts/19', 'http://site.test/posts/19']) assert.equal(matchWebsiteBridgePage(value, url), null);
  for (const pages of [[{ path: '/x/*', script: 'x.js' }], [{ path: '/x', script: '../x.js' }], [{ path: '/:id', script: 'a.js' }, { path: '/:name', script: 'b.js' }]]) assert.throws(() => parseWebsiteBridgeManifest({ ...manifest, pages }));
});

test('ZIP import validates scripts without executing code in Main', async t => {
  const root = temporary(t); const file = await zipAt(root, manifest, { 'pages/post.js': source, 'pages/new.js': 'globalThis.__websiteBridgeMainExecuted = true;' });
  const pkg = await readWebsiteBridgeArchive(file); assert.equal(pkg.scripts.size, 2); assert.equal(globalThis.__websiteBridgeMainExecuted, undefined);
  await zipAt(root, manifest, { 'pages/post.js': 'syntax (', 'pages/new.js': source });
  await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidScript' });
  await zipAt(root, manifest, { 'pages/post.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  await zipAt(root, manifest, { 'pages/post.js': source, 'pages/new.js': source, '../escape.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  await zipAt(root, manifest, { 'pages/post.js': ' '.repeat(600 * 1024), 'pages/new.js': source }); await assert.rejects(readWebsiteBridgeArchive(file), { code: 'packageTooLarge' });
});

test('ZIP rejects symlinks and case-colliding paths on both platforms', async t => {
  const root = temporary(t); const zip = new JSZip(); zip.file('bridge.json', JSON.stringify(manifest));
  zip.file('pages/post.js', source, { unixPermissions: 0o120777 }); zip.file('pages/new.js', source);
  const file = path.join(root, 'link.zip'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  await assert.rejects(readWebsiteBridgeArchive(file), { code: 'invalidPackage' });
  await zipAt(root, manifest, { 'pages/post.js': source, 'pages/new.js': source, 'pages/POST.js': source });
  await assert.rejects(readWebsiteBridgeArchive(path.join(root, 'bridge.zip')), { code: 'invalidPackage' });
});

test('packages persist, update atomically, retain disabled state and do not resurrect after removal', async t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data/webs/website-bridges'), configRoot: path.join(root, 'config/webs') };
  let manager = createWebsiteBridgeManager(storage); assert.equal(manager.list().items[0].id, 'qiuer-forum');
  const zip = await zipAt(root); assert.equal((await manager.importFile(zip)).ok, true);
  await manager.setEnabled('sample', false);
  await zipAt(root, { ...manifest, version: '1.1.0' }); assert.equal((await manager.importFile(zip)).ok, true);
  manager = createWebsiteBridgeManager(storage); const item = manager.list().items.find(item => item.id === 'sample');
  assert.equal(item.version, '1.1.0'); assert.equal(item.enabled, false);
  await zipAt(root, { ...manifest, version: '2.0.0' }, { 'pages/post.js': '(', 'pages/new.js': source });
  assert.equal((await manager.importFile(zip)).ok, false); assert.equal(manager.list().items.find(item => item.id === 'sample').version, '1.1.0');
  const exported = await manager.exportBytes('sample'); fs.writeFileSync(zip, exported); assert.equal((await readWebsiteBridgeArchive(zip)).manifest.version, '1.1.0');
  await manager.remove('qiuer-forum'); await manager.remove('sample'); manager = createWebsiteBridgeManager(storage); assert.deepEqual(manager.list().items, []);
});

test('conflicting site packages, wrong update identity and lost owner do not change installation', async t => {
  const root = temporary(t); const manager = createWebsiteBridgeManager(); const file = await zipAt(root);
  await manager.importFile(file);
  await zipAt(root, { ...manifest, id: 'other' }); assert.equal((await manager.importFile(file)).error, 'conflict');
  assert.equal((await manager.importFile(file, () => {}, 'sample')).error, 'invalidPackage');
  assert.equal((await manager.setEnabled('sample', false, () => { throw new Error('Owner closed'); })).ok, false);
  assert.equal(manager.list().items.find(item => item.id === 'sample').enabled, true);
});

test('corrupt persisted state fails closed without replacing files or enabling builtins', t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  fs.mkdirSync(storage.configRoot); fs.writeFileSync(path.join(storage.configRoot, 'website-bridges.json'), '{broken');
  const manager = createWebsiteBridgeManager(storage); assert.equal(manager.list().error, 'storageFailed'); assert.equal(manager.runtimePackages().length, 0);
  assert.equal(fs.readFileSync(path.join(storage.configRoot, 'website-bridges.json'), 'utf8'), '{broken');
});

test('same page installs once; route parameters, disable and native AWCP preserve lifecycle boundaries', () => {
  const pkg = { manifest, scripts: new Map([['pages/post.js', source], ['pages/new.js', source]]) };
  const p = page(); p.run([pkg]); const first = p.context.awcp; assert.equal(first.page, '1'); p.run([pkg]); assert.equal(p.context.awcp, first);
  p.context.location = new URL('https://site.test/posts/2'); p.run([pkg]); assert.equal(p.context.awcp.page, '2'); assert.equal(p.context.cleaned, 1);
  p.run([]); assert.equal(p.context.awcp, undefined); assert.equal(p.context.cleaned, 2);
  p.context.awcp = { protocolVersion: 99 }; const native = p.context.awcp; p.run([pkg]); assert.equal(p.context.awcp, native);
});

test('forum pages expose only relevant actions and bind post IDs from the page', async () => {
  const pkg = builtinForumBridge(); const p = page('https://1024.qiuer.net/forum/new'); p.run([pkg]);
  let index = p.context.awcp.manual(); assert.deepEqual(Array.from(index.sections, item => item.section), ['forum.compose.fill', 'forum.compose.publish']); assert.ok(!index.sections.some(item => item.section === 'forum.comments.create'));
  p.context.location = new URL('https://1024.qiuer.net/forum/posts/19'); p.run([pkg]); index = p.context.awcp.manual();
  assert.ok(!index.sections.some(item => item.section === 'forum.compose.fill'));
  const manual = p.context.awcp.manual({ section: 'forum.posts.get', revision: index.revision }); assert.equal(manual.inputSchema.properties.postId, undefined);
  const result = await p.context.awcp.invoke({ requestId: 'read', revision: index.revision, action: 'forum.posts.get', args: {} }); assert.equal(result.ok, true);
  assert.equal(p.requests[0][0], 'https://1024.qiuer.net/forum/api/v1/posts/19');
  p.context.location = new URL('https://1024.qiuer.net/forum/posts/20'); p.run([pkg]); assert.notEqual(p.context.awcp.manual().revision, index.revision);
  p.context.location = new URL('https://1024.qiuer.net/forum/api/v1/posts'); p.run([pkg]); assert.equal(p.context.awcp, undefined);
});

test('manager enable and uninstall refresh already open guests', async t => {
  const root = temporary(t); const manager = createWebsiteBridgeManager(); await manager.importFile(await zipAt(root));
  const p = page(); const guest = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false, getURL: () => p.context.location.href, executeJavaScript: async script => vm.runInContext(script, p.context) });
  const injection = new AwcpAddonInjection(manager.runtimePackages); manager.subscribe(() => injection.refresh()); injection.attach(guest); assert.equal(p.context.awcp.page, '1');
  await manager.setEnabled('sample', false); assert.equal(p.context.awcp, undefined);
  await manager.setEnabled('sample', true); assert.equal(p.context.awcp.page, '1');
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

test('minified production package remains self-contained in the page world', async t => {
  const { build } = await import('esbuild');
  const output = await build({ entryPoints: ['src/main/modules/web-surfaces/website-bridges/builtin.ts'], bundle: true, platform: 'node', format: 'cjs', minify: true, write: false });
  const mod = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module: mod, exports: mod.exports, require });
  const pkg = mod.exports.builtinForumBridge();
  const p = page('https://1024.qiuer.net/forum/new'); p.run([pkg]);
  assert.ok(p.context.awcp.manual().sections.some(item => item.section === 'forum.compose.fill'));
  p.context.location = new URL('https://1024.qiuer.net/forum/posts/19'); p.run([pkg]);
  const result = await p.context.awcp.invoke({ requestId: 'minified', revision: p.context.awcp.manual().revision, action: 'forum.posts.get', args: {} });
  assert.equal(result.ok, true); assert.equal(p.requests[0][0], 'https://1024.qiuer.net/forum/api/v1/posts/19');
});

test('invalid guest URL and throwing user cleanup do not block subsequent bridges', () => {
  assert.equal(buildWebsiteBridgeScript('', []), 'void 0');
  const pkg = { manifest, scripts: new Map([['pages/post.js', source.replace('globalThis.cleaned = (globalThis.cleaned || 0) + 1;', 'throw Error("bad cleanup");')], ['pages/new.js', source]]) };
  const p = page(); p.run([pkg]);
  p.context.location = new URL('https://site.test/posts/2'); p.run([pkg]);
  assert.equal(p.context.awcp.page, '2');
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
  fs.appendFileSync(path.join(storage.packagesRoot, 'sample/pages/post.js'), '\n// changed');
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

test('legacy hash directory is rejected without migration', t => {
  const root = temporary(t); const storage = { packagesRoot: path.join(root, 'data'), configRoot: path.join(root, 'config') };
  createWebsiteBridgeManager(storage);
  const entry = JSON.parse(fs.readFileSync(path.join(storage.configRoot, 'website-bridges.json'))).items[0];
  const target = path.join(storage.packagesRoot, entry.id); const staged = path.join(root, 'legacy');
  fs.renameSync(target, staged); fs.mkdirSync(target); fs.renameSync(staged, path.join(target, entry.digest));
  assert.equal(createWebsiteBridgeManager(storage).list().error, 'storageFailed');
  assert.equal(fs.existsSync(path.join(target, entry.digest, 'bridge.json')), true);
  assert.equal(fs.existsSync(path.join(target, 'bridge.json')), false);
});
