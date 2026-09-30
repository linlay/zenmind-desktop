import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadAttachment as download } from '../dist-electron/main/modules/enterprise-chat/attachment-service.js';
import { setMainLocaleForCurrentProcess } from '../dist-electron/main/support/i18n/main-i18n.js';

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: choose the save location before downloading and return the file actually written`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-download-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'custom-folder-image.png');
    const bytes = Buffer.from('test attachment bytes');
    const steps = [];
    const downloadsDirectory = platform === 'win32' ? 'C:\\Users\\Test User\\Downloads' : root;
    const result = await download({
      platform,
      app: { getPath: (name) => {
        assert.equal(name, 'downloads');
        return downloadsDirectory;
      } },
      fetchAttachment: async () => {
        steps.push('download');
        return { buffer: bytes };
      },
      showSaveDialog: async (options) => {
        assert.deepEqual(steps, []);
        assert.equal(options.defaultPath, (platform === 'win32' ? path.win32 : path.posix).join(downloadsDirectory, 'image.png'));
        steps.push('choose');
        return { canceled: false, filePath: target };
      }
    }, { fileId: 'image-1', name: 'image.png' });
    assert.deepEqual(steps, ['choose', 'download']);
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    assert.deepEqual(await fs.readFile(result.path), bytes);
  });
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: cancelling the save dialog neither downloads nor writes a file`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-cancel-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await download({
      platform, app: { getPath: () => root },
      fetchAttachment: async () => assert.fail('A cancelled save must not fetch the attachment.'),
      showSaveDialog: async () => ({ canceled: true })
    }, { fileId: 'image-1', name: 'image.png' });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.path, '');
    assert.deepEqual(await fs.readdir(root), []);
  });

  test(`${platform}: a missing save dialog fails without silently downloading to the default folder`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-no-save-dialog-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(download({
      platform, app: { getPath: () => root },
      fetchAttachment: async () => assert.fail('A missing save dialog must not fetch the attachment.')
    }, { fileId: 'image-1', name: 'image.png' }), /save location dialog|保存位置选择窗口/i);
    assert.deepEqual(await fs.readdir(root), []);
  });
}

test('no download starts while the user is choosing a save location', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-pending-save-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let finishSelection;
  let fetchCount = 0;
  const target = path.join(root, 'chosen-image.png');
  const pending = download({
    platform: 'darwin', app: { getPath: () => root },
    showSaveDialog: () => new Promise((resolve) => { finishSelection = resolve; }),
    fetchAttachment: async () => {
      fetchCount += 1;
      return { buffer: Buffer.from('selected attachment') };
    }
  }, { fileId: 'image-1', name: 'image.png' });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(fetchCount, 0);
  finishSelection({ canceled: false, filePath: target });
  assert.equal((await pending).path, target);
  assert.equal(fetchCount, 1);
});

test('a failure to open the save dialog does not start a download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-save-dialog-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(download({
    platform: 'darwin', app: { getPath: () => root },
    showSaveDialog: async () => { throw new Error('Save dialog could not open.'); },
    fetchAttachment: async () => assert.fail('No attachment should be fetched.')
  }, { fileId: 'image-1', name: 'image.png' }), /Save dialog could not open/);
  assert.deepEqual(await fs.readdir(root), []);
});

for (const [locale, title] of [['zh-CN', '保存附件'], ['en-US', 'Save attachment']]) {
  test(`${locale}: the save attachment dialog uses the selected language`, async (t) => {
    setMainLocaleForCurrentProcess(locale);
    t.after(() => setMainLocaleForCurrentProcess('zh-CN'));
    const result = await download({
      platform: 'darwin', app: { getPath: () => os.tmpdir() },
      showSaveDialog: async (options) => {
        assert.equal(options.title, title);
        return { canceled: true };
      },
      fetchAttachment: async () => assert.fail('Cancellation must not fetch the attachment.')
    }, { fileId: 'image-1', name: 'image.png' });
    assert.equal(result.cancelled, true);
  });
}

test('a failed write rejects instead of returning a completed download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-write-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(download({
    platform: 'darwin', app: { getPath: () => root },
    fetchAttachment: async () => ({ buffer: Buffer.from('unused') }),
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'missing', 'image.png') })
  }, { fileId: 'image-1', name: 'image.png' }), { code: 'ENOENT' });
});
