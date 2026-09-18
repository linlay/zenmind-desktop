import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { artifactRelativePath, registerArtifactActionIpc } = require('../dist-electron/main/modules/artifacts/actions.js');

test('artifact paths accept encoded names and reject URLs, traversal and foreign chat references', () => {
  assert.equal(artifactRelativePath('artifacts/run/%E4%B8%AD%20%231%25.txt', 'chat'), 'artifacts/run/中 #1%.txt');
  for (const value of ['https://evil/artifacts/a', '/api/resource?file=chat/artifacts/a', 'other/artifacts/a', 'artifacts/../a', 'artifacts/%2e%2e/a', 'artifacts/%2Fetc/a', 'artifacts/a%5cb', 'artifacts//a', 'artifacts/%00a']) {
    assert.equal(artifactRelativePath(value, 'chat'), null, value);
  }
});
function fixture(overrides = {}) {
  let handler;
  const frame = {};
  const sender = { mainFrame: frame };
  const artifact = { artifactId: 'art', url: 'artifacts/run/file.txt' };
  const ports = {
    getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'chat', artifact: { items: [artifact] }, events: [{ type: 'unsupported-history-event' }] }) }),
    fetchResource: async () => ({ bytes: Buffer.from('hello') }),
    showSaveDialog: async () => ({ canceled: true }),
    ...overrides,
  };
  registerArtifactActionIpc({ handle: (_channel, fn) => { handler = fn; } }, ports);
  return { call: (input = {}, event = { sender, senderFrame: frame }) => handler(event, { chatId: 'chat', artifactId: 'art', action: 'view', ...input }) };
}
test('view resolves authoritative source identity; unknown artifacts and unauthorized senders fail', async () => {
  const { call } = fixture();
  assert.deepEqual(await call(), { ok: true, agentKey: 'agent', relativePath: 'artifacts/run/file.txt' });
  assert.deepEqual(await call({ artifactId: 'missing' }), { ok: false });
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
  assert.deepEqual(await fixture({ getChatInfo: async () => { throw new Error('offline'); } }).call(), { ok: false });
  assert.deepEqual(await fixture({ getChatInfo: async () => ({ chatId: 'chat', agentKey: 'agent', rawJson: JSON.stringify({ chatId: 'other', artifact: { items: [{ artifactId: 'art', url: 'artifacts/a' }] } }) }) }).call(), { ok: false });
});
