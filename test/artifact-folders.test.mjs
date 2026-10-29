import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ArtifactStore, getArtifactDatabasePath } = require('../dist-electron/main/modules/artifacts/store.js');
const { parseArtifactMetadata } = require('../dist-electron/main/modules/artifacts/metadata.js');
const { createArtifactRuntime } = require('../dist-electron/main/modules/artifacts/index.js');
const { createArtifactPlatformClient } = require('../dist-electron/main/modules/artifacts/platform-client.js');
const { artifactThumbnailDataUrl, ARTIFACT_THUMBNAIL_LIMIT } = require('../dist-electron/main/modules/artifacts/thumbnail.js');
const now = Date.now();
const identity = (patch = {}) => ({ chatId: 'chat', runId: 'run', artifactId: 'file', ...patch });
const metadata = (patch = {}) => ({ ...identity(), name: 'original.md', mimeType: 'text/markdown', sizeBytes: 3, sha256: 'a'.repeat(64), publishedAt: now, ...patch });
const push = (patch = {}) => ({ frame: 'push', type: 'artifact.published', data: metadata(patch) });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-folders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'artifacts.db');
  return { dir, filename, store: new ArtifactStore(() => filename) };
}
function folder(store, name, parentId = null) {
  assert.deepEqual(store.folder({ action: 'create', name, parentId }), { ok: true });
  return store.list().folders.find(item => item.name === name && item.parentId === parentId).id;
}

test('v1 migration preserves annotations, starts with no folders and puts every existing item in Unfiled', t => {
  const { filename, store } = setup(t);
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE artifacts(chat_id TEXT,run_id TEXT,artifact_id TEXT,name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,pushed_at INTEGER,category TEXT,favorite INTEGER,tags TEXT,content_state TEXT,PRIMARY KEY(chat_id,run_id,artifact_id));`);
  db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('chat', 'run', 'file', 'original.md', 'text/markdown', 3, 'a'.repeat(64), now, 'document', 1, '["important"]', 'ready');
  db.close();
  const result = store.list();
  assert.deepEqual(result.folders, []);
  assert.deepEqual(result.counts, { all: 1, starred: 1, unfiled: 1, recent: 1 });
  assert.equal(result.records[0].folderId, null);
  assert.equal(result.records[0].displayName, '');
  assert.deepEqual(result.records[0].tags, ['important']);
  assert.equal(store.list({ folderId: null }).total, 1);
  assert.equal(new ArtifactStore(() => filename).list().records[0].favorite, true);
});

test('nested folders aggregate descendants, scope direct files, and survive publication, archive and restart', t => {
  const { filename, store } = setup(t);
  const root = folder(store, 'Projects'), child = folder(store, 'Design', root), leaf = folder(store, 'References', child);
  store.ingest(push());
  store.ingest(push({ runId: 'run-2', name: 'photo.png', mimeType: 'image/png' }));
  store.ingest(push({ artifactId: 'unfiled' }));
  store.organize({ ...identity(), displayName: 'Approved draft', favorite: true, tags: ['important'] });
  assert.deepEqual(store.organizeMany({ items: [identity()], folderId: leaf }), { ok: true });
  store.organizeMany({ items: [identity({ runId: 'run-2' })], folderId: root });
  const folders = store.list().folders;
  assert.equal(folders.find(item => item.id === root).totalCount, 2);
  assert.equal(folders.find(item => item.id === root).directCount, 1);
  assert.equal(folders.find(item => item.id === root).childCount, 1);
  assert.equal(folders.find(item => item.id === child).totalCount, 1);
  assert.equal(store.list({ folderId: root }).total, 1);
  assert.equal(store.list({ folderId: leaf }).records[0].displayName, 'Approved draft');
  assert.equal(store.list({ folderId: null }).total, 1);
  store.ingest(push({ publishedAt: now + 1 }));
  store.replaceChatManifest('chat', [parseArtifactMetadata(metadata()), parseArtifactMetadata(metadata({ runId: 'run-2', name: 'photo.png', mimeType: 'image/png' }))]);
  store.setChat('chat', 'archived');
  store.setChat('chat', 'active');
  const record = new ArtifactStore(() => filename).get(identity());
  assert.equal(record.folderId, leaf);
  assert.equal(record.displayName, 'Approved draft');
  assert.equal(record.name, 'original.md');
  assert.equal(record.favorite, true);
  assert.deepEqual(record.tags, ['important']);
  assert.equal(store.get(identity({ runId: 'run-2' })).displayName, '');
});

test('folder names and depth are validated, duplicate siblings are rejected, only empty leaves may be deleted', t => {
  const { store } = setup(t);
  const root = folder(store, 'Projects'), child = folder(store, 'Design', root);
  assert.deepEqual(store.folder({ action: 'create', parentId: null, name: ' projects ' }), { ok: false, error: 'duplicate_name' });
  assert.deepEqual(store.folder({ action: 'create', parentId: 'missing', name: 'x' }), { ok: false, error: 'folder_missing' });
  for (const name of ['', ' ', 'bad\0name', 'x'.repeat(65)]) assert.deepEqual(store.folder({ action: 'rename', id: child, name }), { ok: false, error: 'invalid_name' });
  assert.deepEqual(store.folder({ action: 'rename', id: child, name: 'Assets' }), { ok: true });
  folder(store, 'Design'); // Same name at another level is allowed.
  assert.deepEqual(store.folder({ action: 'delete', id: root }), { ok: false, error: 'folder_not_empty' });
  store.ingest(push()); store.organizeMany({ items: [identity()], folderId: child });
  assert.deepEqual(store.folder({ action: 'delete', id: child }), { ok: false, error: 'folder_not_empty' });
  store.organizeMany({ items: [identity()], folderId: null });
  assert.deepEqual(store.folder({ action: 'delete', id: child }), { ok: true });
  let parent = root;
  for (let depth = 2; depth <= 20; depth++) parent = folder(store, 'level-' + depth, parent);
  assert.deepEqual(store.folder({ action: 'create', parentId: parent, name: 'too deep' }), { ok: false, error: 'folder_depth' });
});

test('batch moves and favorites validate the entire selection before writing, including stale dialogs', t => {
  const { store } = setup(t), target = folder(store, 'Target');
  store.ingest(push()); store.ingest(push({ runId: 'run-2' }));
  assert.deepEqual(store.organizeMany({ items: [identity(), identity({ artifactId: 'gone' })], folderId: target, favorite: true }), { ok: false, error: 'items_missing' });
  assert.equal(store.get(identity()).folderId, null);
  assert.equal(store.get(identity()).favorite, false);
  for (const input of [{ items: [], folderId: target }, { items: Array(101).fill(identity()), favorite: true }, { items: [identity()], favorite: 'yes' }, { items: [identity()] }]) {
    assert.deepEqual(store.organizeMany(input), { ok: false, error: 'invalid_request' });
  }
  assert.deepEqual(store.organizeMany({ items: [identity()], folderId: 'missing' }), { ok: false, error: 'folder_missing' });
  assert.deepEqual(store.organizeMany({ items: [identity(), identity({ runId: 'run-2' })], folderId: target, favorite: true }), { ok: true });
  assert.equal(store.list({ folderId: target, favoritesOnly: true }).total, 2);
  store.setChat('chat', 'deleted');
  assert.throws(() => store.organize({ ...identity(), displayName: 'late rename' }), /missing/);
  assert.equal(store.list().folders.find(item => item.id === target).totalCount, 0);
  assert.deepEqual(store.folder({ action: 'delete', id: target }), { ok: true });
});

test('legacy identity resolution transfers folder and alias without overriding an already organized canonical record', t => {
  const { store } = setup(t), target = folder(store, 'Migrated');
  const legacy = { ...identity(), runId: '' };
  store.ingest({ frame: 'push', type: 'resource.pushed', data: { ...metadata(), runId: '', pushedAt: now } });
  store.organize({ ...legacy, displayName: 'Legacy alias', tags: ['old'] });
  store.organizeMany({ items: [legacy], folderId: target });
  store.replaceChatManifest('chat', [parseArtifactMetadata(metadata())]);
  assert.equal(store.get(legacy), null);
  assert.equal(store.get(identity()).folderId, target);
  assert.equal(store.get(identity()).displayName, 'Legacy alias');
  assert.deepEqual(store.get(identity()).tags, ['old']);
  const preferred = folder(store, 'Preferred');
  const other = identity({ chatId: 'other' });
  store.ingest({ frame: 'push', type: 'resource.pushed', data: { ...metadata(), chatId: 'other', runId: '', pushedAt: now } });
  store.organize({ ...other, runId: '', displayName: 'Old name' });
  store.organizeMany({ items: [{ ...other, runId: '' }], folderId: target });
  store.ingest(push({ chatId: 'other' }));
  store.organize({ ...other, displayName: 'Current name' });
  store.organizeMany({ items: [other], folderId: preferred });
  store.replaceChatManifest('other', [parseArtifactMetadata(metadata({ chatId: 'other' }))]);
  assert.equal(store.get(other).folderId, preferred);
  assert.equal(store.get(other).displayName, 'Current name');
});

test('search, sorting, recent views and category facets honor logical scope while global counts stay stable', t => {
  const { store } = setup(t), target = folder(store, 'Research');
  store.ingest(push({ name: 'z.md' }));
  store.ingest(push({ artifactId: 'image', name: 'a.png', mimeType: 'image/png' }));
  store.ingest(push({ artifactId: 'older', name: 'old.txt', mimeType: 'text/plain', publishedAt: now - 4 * 86400000 }));
  store.organize({ ...identity(), displayName: 'a%_alias', tags: ['review'] });
  store.organizeMany({ items: [identity(), identity({ artifactId: 'image' })], folderId: target });
  assert.equal(store.list({ search: '%_' }).records[0].displayName, 'a%_alias');
  assert.equal(store.list({ search: "' OR 1=1 --" }).total, 0);
  assert.equal(store.list({ sort: 'name' }).records[0].artifactId, 'file');
  assert.equal(store.list({ recent: true }).total, 2);
  const result = store.list({ folderId: target, category: 'image' });
  assert.equal(result.total, 1);
  assert.deepEqual(result.categories, { document: 1, image: 1 });
  assert.equal(result.counts.all, 3);
  assert.equal(result.counts.unfiled, 1);
  assert.equal(store.list({ folderId: target, tag: 'review' }).total, 1);
});

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const image = patch => parseArtifactMetadata(metadata({ name: 'picture.png', mimeType: 'image/png', sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), ...patch }));
test('thumbnail transport accepts only bounded verified raster bytes and limits the upstream response', async () => {
  assert.match(artifactThumbnailDataUrl(png, image()), /^data:image\/png;base64,/);
  for (const patch of [{ mimeType: 'image/svg+xml' }, { sourceState: 'archived' }, { contentState: 'changed' }, { sizeBytes: png.length + 1 }, { sha256: 'b'.repeat(64) }]) {
    assert.equal(artifactThumbnailDataUrl(png, { ...image(), ...patch }), null);
  }
  assert.equal(artifactThumbnailDataUrl(Buffer.alloc(ARTIFACT_THUMBNAIL_LIMIT + 1), image()), null);
  const client = createArtifactPlatformClient({ resolve: async () => ({ baseUrl: 'http://localhost', token: 'token' }), fetchImpl: async () => new Response('oversized', { headers: { 'content-length': String(ARTIFACT_THUMBNAIL_LIMIT + 1) } }) });
  await assert.rejects(client.read(identity(), new AbortController().signal, ARTIFACT_THUMBNAIL_LIMIT), /response_too_large/);
});

test('folder, move and thumbnail IPC are restricted; lifecycle changes revoke a pending thumbnail', async t => {
  const { dir } = setup(t), app = { getPath: () => dir }, handlers = new Map();
  let consumer, release, calls = 0;
  const frame = {}, sender = { mainFrame: frame, send() {} }, window = { isDestroyed: () => false, webContents: sender }, trusted = { sender, senderFrame: frame };
  const runtime = createArtifactRuntime({ app, platform: 'darwin', platformApi: { read: (_id, _signal, max) => { calls++; assert.equal(max, ARTIFACT_THUMBNAIL_LIMIT); return new Promise(resolve => release = resolve); } },
    broker: { subscribePush: input => { consumer = input; return () => {}; } }, ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) }, getMainWindow: () => window, onError: error => { throw error; } });
  t.after(() => runtime.dispose());
  const store = new ArtifactStore(() => getArtifactDatabasePath(app, 'darwin'));
  store.replaceChatManifest('chat', [image()]);
  for (const channel of ['artifacts.folder', 'artifacts.organizeMany']) assert.throws(() => handlers.get(channel)({ sender, senderFrame: {} }, {}), /denied/);
  await assert.rejects(handlers.get('artifacts.thumbnail')({ sender: {}, senderFrame: frame }, identity()), /denied/);
  const pending = handlers.get('artifacts.thumbnail')(trusted, identity());
  assert.equal(calls, 1);
  consumer.onPush({ type: 'chat.archived', data: { chatId: 'chat' } }); release(png);
  assert.equal(await pending, null);
  assert.equal(await handlers.get('artifacts.thumbnail')(trusted, identity()), null);
  assert.equal(calls, 1);
  runtime.dispose(); assert.equal(handlers.size, 0);
});
