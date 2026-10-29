import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { artifactRelativePath, registerArtifactActionIpc } = require('../dist-electron/main/modules/artifacts/actions.js');
const localFiles = require('../dist-electron/main/modules/artifacts/local-file.js');

test('artifact paths accept encoded names and reject URLs, traversal and foreign chat references', () => {
  assert.equal(artifactRelativePath('artifacts/run/%E4%B8%AD%20%231%25.txt', 'chat'), 'artifacts/run/中 #1%.txt');
  for (const value of ['https://evil/artifacts/a', '/api/resource?file=chat/artifacts/a', 'other/artifacts/a', 'artifacts/../a', 'artifacts/%2e%2e/a', 'artifacts/%2Fetc/a', 'artifacts/a%5cb', 'artifacts//a', 'artifacts/%00a']) {
    assert.equal(artifactRelativePath(value, 'chat'), null, value);
  }
});
test('artifact paths accept the literal @chat root and keep it inside artifacts/', () => {
  assert.equal(artifactRelativePath('@chat/artifacts/run/中 #1%.txt', 'chat'), 'artifacts/run/中 #1%.txt');
  assert.equal(artifactRelativePath('@CHAT/artifacts/run/a.md', 'chat'), 'artifacts/run/a.md');
  for (const value of ['@chat/notes.md', '@chat/artifacts/../a', '@chat/artifacts//a', '@chat/artifacts/a\\b', '@chat//artifacts/a', '@workspace/artifacts/a']) {
    assert.equal(artifactRelativePath(value, 'chat'), null, value);
  }
});
function fixture(overrides = {}) {
  let handler;
  const frame = {};
  const sender = { mainFrame: frame };
  const mainWindow = { isDestroyed: () => false, webContents: sender };
  const artifact = { artifactId: 'art', url: 'artifacts/run/file.txt' };
  const ports = {
    getMainWindow: () => mainWindow,
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [artifact] }, events: [{ type: 'unsupported-history-event' }] }) }),
    fetchResource: async () => ({ bytes: Buffer.from('hello') }),
    getRuntimeRoot: () => { throw new Error('Local storage unavailable'); },
    showSaveDialog: async () => ({ canceled: true }),
    ...overrides,
  };
  ports.library ??= {
    actionContext: () => ({ record: { sourceState: 'active', contentState: 'ready' }, isCurrent: () => true }),
    read: async (identity) => { assert.equal(identity.runId, 'run'); return (await ports.fetchResource(identity)).bytes; },
    reportFailure() {},
  };
  registerArtifactActionIpc({ handle: (_channel, fn) => { handler = fn; } }, ports);
  return { call: (input = {}, event = { sender, senderFrame: frame }) => handler(event, { chatId: 'chat', runId: 'run', artifactId: 'art', action: 'view', ...input }) };
}
test('view resolves authoritative source identity; unknown artifacts and unauthorized senders fail', async () => {
  const { call } = fixture();
  assert.deepEqual(await call(), { ok: true, agentKey: 'agent', relativePath: 'artifacts/run/file.txt' });
  assert.deepEqual(await call({ artifactId: 'missing' }), { ok: false, error: 'missing' });
  assert.deepEqual(await call({}, { sender: {}, senderFrame: {} }), { ok: false });
  assert.deepEqual(await fixture({ getChatInfo: async () => ({ chatId: 'other', agentKey: 'agent' }) }).call(), { ok: false });
});
test('cancelled download never reads content; saved download writes original bytes including empty files', async (t) => {
  const { call } = fixture({ fetchResource: async () => { throw new Error('must not fetch'); } });
  assert.equal((await call({ action: 'download' })).cancelled, true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-action-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'output.txt');
  for (const bytes of [Buffer.from('hello'), Buffer.alloc(0)]) {
    const save = fixture({ showSaveDialog: async () => ({ canceled: false, filePath }), fetchResource: async () => ({ bytes }) });
    assert.equal((await save.call({ action: 'download' })).ok, true);
    assert.deepEqual(await fs.readFile(filePath), bytes);
  }
});
test('unavailable resources and service failures report failure', async () => {
  assert.deepEqual(await fixture({ getChatInfo: async () => { throw new Error('offline'); } }).call(), { ok: false, error: 'failed' });
  assert.deepEqual(await fixture({ getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'other', artifact: { items: [{ artifactId: 'art', url: 'artifacts/a' }] } }) }) }).call(), { ok: false });
});

test('file manager reveal and default app opening use the original without a save dialog or download', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-reveal-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'chats/chat/artifacts/run/中 #1%.png');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'local edits');
  for (const platform of ['darwin', 'win32']) {
    // Exercise the Windows shell branch on this host; native Windows paths
    // and containment are independently covered below with a virtual filesystem.
    const originalResolver = localFiles.resolveArtifactLocalFile;
    const mock = platform === 'win32' ? t.mock.method(localFiles, 'resolveArtifactLocalFile',
      (root, chatId, relative) => originalResolver(root, chatId, relative, 'darwin')) : null;
    const calls = [];
    const { call } = fixture({
      platform, getRuntimeRoot: () => dir,
      getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({
        chatId: 'chat', artifact: { items: [{ artifactId: 'art', url: '@chat/artifacts/run/中 #1%.png' }] },
      }) }),
      fileShell: { showItemInFolder: (target) => calls.push(['reveal', target]), openPath: async (target) => { calls.push(['default', target]); return ''; } },
      showSaveDialog: async () => { throw new Error('must not save'); },
      fetchResource: async () => { throw new Error('must not download'); },
    });
    assert.equal((await call({ action: 'reveal' })).ok, true);
    assert.equal((await call({ action: 'open-default' })).ok, true);
    assert.deepEqual(calls, [['reveal', filePath], ['default', filePath]]);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'local edits');
    mock?.mock.restore();
  }
});

test('external browser opens the original HTML with the HTTPS handler on macOS and Windows', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-external-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'chats/chat/artifacts/run/page #1%.html');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '<img src="image.png">');
  const calls = [];
  const ports = {
    getRuntimeRoot: () => dir,
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({
      chatId: 'chat', artifact: { items: [{ artifactId: 'art', url: '@chat/artifacts/run/page #1%.html' }] },
    }) }),
    showSaveDialog: async () => { throw new Error('must not save'); },
    fetchResource: async () => { throw new Error('must not download'); },
    fileShell: { showItemInFolder: () => {}, openPath: async (target) => { calls.push(['default', target]); return ''; } },
    app: { getApplicationInfoForProtocol: async (url) => { assert.equal(url, 'https://example.com'); return { path: '/browser' }; } },
    launchBrowser: async (command, args) => { calls.push(['browser', command, args]); },
  };
  const mac = fixture({ ...ports, platform: 'darwin' });
  assert.equal((await mac.call({ action: 'open-default' })).ok, true);
  assert.equal((await mac.call({ action: 'open-browser' })).ok, true);
  assert.deepEqual(calls, [['default', filePath], ['browser', '/usr/bin/open', ['-a', '/browser', filePath]]]);
  calls.length = 0;
  const originalResolver = localFiles.resolveArtifactLocalFile;
  const mock = t.mock.method(localFiles, 'resolveArtifactLocalFile', (root, chatId, relative) => originalResolver(root, chatId, relative, 'darwin'));
  const win = fixture({ ...ports, platform: 'win32' });
  assert.equal((await win.call({ action: 'open-browser' })).ok, true);
  assert.deepEqual(calls, [['browser', '/browser', [pathToFileURL(filePath).href]]]);
  mock.mock.restore();
  assert.equal((await fixture({ ...ports, platform: 'darwin' }).call({ action: 'open-browser', artifactId: 'missing' })).ok, false);
  assert.equal((await fixture({ ...ports, platform: 'darwin', getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [{ artifactId: 'art', url: 'artifacts/run/tool.exe' }] } }) }) }).call({ action: 'open-default' })).ok, false);
  await fs.writeFile(path.join(path.dirname(filePath), 'page.bin'), 'untrusted extension');
  const mimeOnly = fixture({ ...ports, platform: 'darwin', getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [{ artifactId: 'art', url: 'artifacts/run/page.bin', mimeType: 'text/html' }] } }) }) });
  assert.equal((await mimeOnly.call({ action: 'open-default' })).ok, false);
  const unavailableBrowser = fixture({ ...ports, platform: 'darwin', app: { getApplicationInfoForProtocol: async () => ({ path: '' }) } });
  assert.deepEqual(await unavailableBrowser.call({ action: 'open-browser' }), { ok: false });
  const failedApp = fixture({ ...ports, platform: 'darwin', fileShell: { openPath: async () => 'No handler' } });
  assert.deepEqual(await failedApp.call({ action: 'open-default' }), { ok: false });
  calls.length = 0;
  const removedDuringLookup = fixture({ ...ports, platform: 'darwin', app: { getApplicationInfoForProtocol: async () => { await fs.unlink(filePath); return { path: '/browser' }; } } });
  assert.deepEqual(await removedDuringLookup.call({ action: 'open-browser' }), { ok: false });
  assert.deepEqual(calls, []);
});

test('missing originals fail all direct actions without saving or fetching a replacement', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-missing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let saved = 0, fetched = 0, opened = 0;
  const { call } = fixture({
    platform: 'darwin', getRuntimeRoot: () => dir,
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [{ artifactId: 'art', url: 'artifacts/run/page.html' }] } }) }),
    showSaveDialog: async () => { saved++; return { canceled: true }; },
    fetchResource: async () => { fetched++; return null; },
    fileShell: { showItemInFolder: () => { opened++; }, openPath: async () => { opened++; return ''; } },
    launchBrowser: async () => { opened++; },
  });
  for (const action of ['reveal', 'open-default', 'open-browser']) assert.deepEqual(await call({ action }), { ok: false });
  assert.deepEqual([saved, fetched, opened], [0, 0, 0]);
});

test('local artifact resolution rejects escaping symlinks, aliased Chats and non-files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatRoot = path.join(root, 'chats/chat');
  const artifacts = path.join(chatRoot, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.mkdir(path.join(root, 'chats/other/artifacts'), { recursive: true });
  const outside = path.join(root, 'chats/other/artifacts/file.html');
  await fs.writeFile(outside, 'other Chat');
  await fs.symlink(outside, path.join(artifacts, 'escape.html'));
  await fs.symlink(path.join(root, 'chats/other'), path.join(root, 'chats/alias'));
  const resolve = (chatId, relative) => localFiles.resolveArtifactLocalFile(root, chatId, relative, 'darwin');
  assert.equal(resolve('chat', 'artifacts/escape.html'), null);
  assert.equal(resolve('alias', 'artifacts/file.html'), null);
  assert.equal(resolve('chat', 'artifacts/missing.html'), null);
  assert.equal(resolve('chat', 'artifacts/../file.html'), null);
  assert.equal(resolve('..', 'artifacts/file.html'), null);
  assert.equal(resolve('chat', 'artifacts'), null);
  await fs.mkdir(path.join(artifacts, 'directory.html'));
  assert.equal(resolve('chat', 'artifacts/directory.html'), null);
});

test('Windows artifact resolution uses native drive and UNC paths and rejects ADS and aliases', () => {
  for (const root of ['C:\\Users\\Test\\.zenmind', '\\\\server\\share\\.zenmind']) {
    const target = path.win32.join(root, 'chats/chat/artifacts/run/中 #1%.html');
    const fileSystem = { realpathSync: (value) => value, statSync: () => ({ isFile: () => true }) };
    const resolve = (relative, io = fileSystem) => localFiles.resolveArtifactLocalFile(root, 'chat', relative, 'win32', io);
    assert.equal(resolve('artifacts/run/中 #1%.html'), target);
    for (const relative of ['artifacts/a.html:payload', 'artifacts/a.html.', 'artifacts/a.html ', 'artifacts/a?b.html', 'artifacts/../other.html']) {
      assert.equal(resolve(relative), null, relative);
    }
    assert.equal(resolve('artifacts/file.html', { ...fileSystem, realpathSync: (value) => value.includes('file.html') ? path.win32.join(root, 'chats/other/file.html') : value }), null);
    assert.equal(resolve('artifacts/file.html', { ...fileSystem, realpathSync: (value) => value.endsWith('chats\\chat') ? path.win32.join(root, 'chats/other') : value }), null);
  }
});

test('same artifact ID is resolved only inside the requested Run and duplicate matches fail closed', async () => {
  const getChatInfo = async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [
    { artifactId: 'art', url: '@chat/artifacts/run/first.txt' },
    { artifactId: 'art', url: '@chat/artifacts/run-2/second.txt' },
  ] } }) });
  assert.deepEqual(await fixture({ getChatInfo }).call({ runId: 'run-2' }), { ok: true, agentKey: 'agent', relativePath: 'artifacts/run-2/second.txt' });
  const failures = [];
  const duplicate = fixture({
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [
      { artifactId: 'art', url: '@chat/artifacts/run/a.txt' }, { artifactId: 'art', url: '@chat/artifacts/run/b.txt' },
    ] } }) }),
    library: { actionContext: () => ({ record: { sourceState: 'active', contentState: 'ready' }, isCurrent: () => true }), reportFailure: (...args) => failures.push(args) },
  });
  assert.deepEqual(await duplicate.call(), { ok: false, error: 'ambiguous' });
  assert.equal(failures[0][1], 'artifact_ambiguous');
});

test('download preserves artifact error codes and does not write changed content', async t => {
  const { ArtifactPlatformError } = require('../dist-electron/main/modules/artifacts/platform-client.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-integrity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'saved.txt');
  for (const [code, expected] of [['artifact_changed', 'changed'], ['artifact_ambiguous', 'ambiguous'], ['chat_access_denied', 'denied']]) {
    const failures = [];
    const { call } = fixture({ showSaveDialog: async () => ({ canceled: false, filePath }), library: {
      actionContext: () => ({ record: { sourceState: 'active', contentState: 'ready' }, isCurrent: () => true }),
      read: async input => { assert.deepEqual(input, { chatId: 'chat', runId: 'run', artifactId: 'art' }); throw new ArtifactPlatformError(code, 409); },
      reportFailure: (_identity, error) => failures.push(error),
    } });
    assert.deepEqual(await call({ action: 'download' }), { ok: false, error: expected });
    assert.deepEqual(failures, [code]);
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
  }
});

test('closing or archiving during file selection revokes the pending download', async () => {
  let current = true, reads = 0;
  const { call } = fixture({
    showSaveDialog: async () => { current = false; return { canceled: false, filePath: '/must-not-write' }; },
    library: { actionContext: () => ({ record: { sourceState: 'active', contentState: 'ready' }, isCurrent: () => current }), read: async () => { reads++; throw new Error('must not read'); }, reportFailure() {} },
  });
  assert.deepEqual(await call({ action: 'download' }), { ok: false });
  assert.equal(reads, 0);
  for (const [record, error] of [[{ sourceState: 'archived', contentState: 'ready' }, 'archived'], [{ sourceState: 'active', contentState: 'unresolved' }, 'unresolved']]) {
    const blocked = fixture({ getChatInfo: async () => { throw new Error('must not resolve'); }, library: { actionContext: () => ({ record, isCurrent: () => true }) } });
    assert.deepEqual(await blocked.call(), { ok: false, error });
  }
});
