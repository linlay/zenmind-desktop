import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadAttachment as download } from '../dist-electron/main/modules/enterprise-chat/attachment-service.js';

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: attachment download reports the chosen file only after writing its bytes`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-download-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'custom-folder-image.png');
    const bytes = Buffer.from('test attachment bytes');
    const result = await download({
      platform,
      app: { getPath: () => root },
      fetchAttachment: async () => ({ buffer: bytes }),
      showSaveDialog: async () => ({ canceled: false, filePath: target })
    }, { fileId: 'image-1', name: 'image.png' });
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    assert.deepEqual(await fs.readFile(result.path), bytes);
  });
}

test('cancelling attachment save returns explicit cancellation and writes no file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await download({
    platform: 'darwin', app: { getPath: () => root },
    fetchAttachment: async () => ({ buffer: Buffer.from('unused') }),
    showSaveDialog: async () => ({ canceled: true })
  }, { fileId: 'image-1', name: 'image.png' });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.path, '');
  assert.deepEqual(await fs.readdir(root), []);
});

test('a failed write rejects instead of returning a completed download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-write-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(download({
    platform: 'darwin', app: { getPath: () => root },
    fetchAttachment: async () => ({ buffer: Buffer.from('unused') }),
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'missing', 'image.png') })
  }, { fileId: 'image-1', name: 'image.png' }), { code: 'ENOENT' });
});
