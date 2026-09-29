import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWorkPanelDocumentReader } = require('../dist-electron/main/modules/work-panel/document-local-reader.js');
const { LOCAL_DOCUMENT_MAX_BYTES } = require('../dist-electron/main/modules/work-panel/document-local-open-format.js');

const source = (kind, relativePath, overrides = {}) => kind === 'workspace-file'
  ? { kind, agentKey: 'agent-a', path: relativePath, ...overrides }
  : { kind, agentKey: 'agent-a', chatId: 'chat-a', resourceId: 'document', relativePath, ...overrides };

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'document-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  const chatRoot = path.join(runtimeRoot, 'chats', 'chat-a');
  await fs.mkdir(chatRoot, { recursive: true });
  await fs.mkdir(workspace);
  const calls = { workspaces: [], owners: [], remote: [] };
  const ports = {
    app: {}, platform: process.platform,
    resolveRuntimeRoot: () => runtimeRoot,
    getWorkspace: async (agentKey) => { calls.workspaces.push(agentKey); return agentKey === 'agent-a' ? workspace : null; },
    verifyChatOwner: async (chatId, agentKey) => { calls.owners.push({ chatId, agentKey }); return chatId === 'chat-a' && agentKey === 'agent-a'; },
    fetchResource: async (chatId, relativePath) => { calls.remote.push({ chatId, relativePath }); return Buffer.from('remote document'); },
    ...overrides,
  };
  const write = async (relativePath, bytes = Buffer.from('local document'), base = chatRoot) => {
    const destination = path.join(base, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
    return destination;
  };
  return { root, runtimeRoot, workspace, chatRoot, calls, ports, read: createWorkPanelDocumentReader(ports), write };
}

test('Workspace, Artifact, nested Reference and root Reference resolve within their authorized boundaries', async (t) => {
  const f = await fixture(t);
  for (const [kind, relativePath, base] of [
    ['workspace-file', '项目/季度报告.pptx', f.workspace],
    ['artifact', 'artifacts/run/analysis.xlsx', f.chatRoot],
    ['reference', 'references/reference/报告.docx', f.chatRoot],
    ['reference', '根目录上传.doc', f.chatRoot],
  ]) {
    const bytes = Buffer.from(`${kind}:original bytes`);
    const original = await f.write(relativePath, bytes, base);
    const result = await f.read(source(kind, relativePath));
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.fileName, path.basename(relativePath));
    assert.equal(result.originalPath, await fs.realpath(original));
    assert.deepEqual(result.protectedRoots, [await fs.realpath(f.runtimeRoot)]);
  }
  assert.deepEqual(f.calls.workspaces, ['agent-a']);
  assert.equal(f.calls.owners.length, 3);
  assert.deepEqual(f.calls.remote, []);
});

test('unknown Workspace and mismatched Chat owners fail before local reads or remote fetch', async (t) => {
  const f = await fixture(t);
  await f.write('artifacts/run/report.pptx');
  for (const invalid of [
    source('artifact', 'artifacts/run/report.pptx', { agentKey: 'other-agent' }),
    source('reference', 'report.docx', { chatId: 'other-chat' }),
    source('workspace-file', 'report.xlsx', { agentKey: 'other-agent' }),
  ]) await assert.rejects(f.read(invalid));
  assert.deepEqual(f.calls.remote, []);
  const chatWorkspace = createWorkPanelDocumentReader({ ...f.ports, getWorkspace: async () => '@chat' });
  await assert.rejects(chatWorkspace(source('workspace-file', 'report.xlsx')));
});

test('only genuinely missing resources use the authenticated remote reader', async (t) => {
  const f = await fixture(t);
  for (const [kind, relativePath] of [
    ['artifact', 'artifacts/run/missing.pptx'],
    ['reference', 'references/missing.docx'],
    ['reference', '根目录上传.xlsx'],
  ]) {
    const result = await f.read(source(kind, relativePath));
    assert.equal(result.fileName, path.basename(relativePath));
    assert.deepEqual(result.bytes, Buffer.from('remote document'));
    assert.equal(result.originalPath, undefined);
    assert.deepEqual(result.protectedRoots, [await fs.realpath(f.runtimeRoot)]);
  }
  assert.deepEqual(f.calls.remote, [
    { chatId: 'chat-a', relativePath: 'artifacts/run/missing.pptx' },
    { chatId: 'chat-a', relativePath: 'references/missing.docx' },
    { chatId: 'chat-a', relativePath: '根目录上传.xlsx' },
  ]);
  const before = f.calls.remote.length;
  await assert.rejects(f.read(source('workspace-file', 'missing.pptx')));
  await fs.mkdir(path.join(f.chatRoot, 'directory.docx'));
  await assert.rejects(f.read(source('reference', 'directory.docx')));
  assert.equal(f.calls.remote.length, before);
});

test('traversal, invalid source fields and cross-profile resource paths never use remote fallback', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    source('workspace-file', '../private.pptx'),
    source('workspace-file', 'file:///private.pptx'),
    source('artifact', '../other-chat/artifacts/file.pptx'),
    source('artifact', 'artifacts/%2e%2e/private.pptx'),
    source('artifact', 'references/private.pptx'),
    source('reference', 'artifacts/private.pptx'),
    source('reference', 'report.pptx', { extra: 'untrusted' }),
  ]) await assert.rejects(f.read(invalid), JSON.stringify(invalid));
  assert.deepEqual(f.calls.remote, []);
});

test('existing file or parent symlink escapes fail closed without remote fallback', async (t) => {
  const f = await fixture(t);
  const outside = await f.write('outside.pptx', Buffer.from('outside Chat'), f.root);
  await fs.mkdir(path.join(f.chatRoot, 'artifacts'), { recursive: true });
  await fs.symlink(outside, path.join(f.chatRoot, 'artifacts', 'escape.pptx'));
  await fs.symlink(f.root, path.join(f.chatRoot, 'artifacts', 'escape-parent'), 'dir');
  await fs.symlink(outside, path.join(f.workspace, 'escape.pptx'));
  for (const invalid of [
    source('artifact', 'artifacts/escape.pptx'),
    source('artifact', 'artifacts/escape-parent/outside.pptx'),
    source('workspace-file', 'escape.pptx'),
  ]) await assert.rejects(f.read(invalid));
  assert.deepEqual(f.calls.remote, []);
});

test('dangling file or parent symlinks are not genuine local absence', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.chatRoot, 'artifacts'), { recursive: true });
  await fs.symlink(path.join(f.root, 'missing-outside.pptx'), path.join(f.chatRoot, 'artifacts', 'dangling.pptx'));
  await fs.symlink(path.join(f.root, 'missing-directory'), path.join(f.chatRoot, 'artifacts', 'dangling-parent'), 'dir');
  for (const invalid of [
    source('artifact', 'artifacts/dangling.pptx'),
    source('artifact', 'artifacts/dangling-parent/report.pptx'),
  ]) await assert.rejects(f.read(invalid));
  assert.deepEqual(f.calls.remote, []);
});

test('the owner Chat directory cannot be rebound to a different Chat through a symlink', async (t) => {
  const f = await fixture(t);
  const otherChat = path.join(f.runtimeRoot, 'chats', 'chat-b');
  await f.write('artifacts/run/private.pptx', Buffer.from('other Chat secret'), otherChat);
  await fs.rmdir(f.chatRoot);
  await fs.symlink(otherChat, f.chatRoot, 'dir');
  await assert.rejects(f.read(source('artifact', 'artifacts/run/private.pptx')));
  assert.deepEqual(f.calls.remote, []);
});

test('Workspace symlinks within the same workspace preserve the semantic file name', async (t) => {
  const f = await fixture(t);
  const target = await f.write('storage/opaque-bytes', Buffer.from('Office container'), f.workspace);
  await fs.symlink(target, path.join(f.workspace, 'readable-report.pptx'));
  const result = await f.read(source('workspace-file', 'readable-report.pptx'));
  assert.equal(result.fileName, 'readable-report.pptx');
  assert.equal(result.originalPath, await fs.realpath(target));
});

test('empty or oversized local/remote documents are rejected before any launch service receives bytes', async (t) => {
  const f = await fixture(t);
  const local = await f.write('artifacts/run/empty.pptx', Buffer.alloc(0));
  await assert.rejects(f.read(source('artifact', 'artifacts/run/empty.pptx')));
  await fs.truncate(local, LOCAL_DOCUMENT_MAX_BYTES + 1);
  await assert.rejects(f.read(source('artifact', 'artifacts/run/empty.pptx')));
  assert.deepEqual(f.calls.remote, []);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(LOCAL_DOCUMENT_MAX_BYTES + 1)]) {
    const reader = createWorkPanelDocumentReader({ ...f.ports, fetchResource: async () => bytes });
    await assert.rejects(reader(source('reference', 'missing.docx')));
  }
});

test('a file replaced during the asynchronous read fails without falling back to remote data', async (t) => {
  const f = await fixture(t);
  const local = await f.write('artifacts/run/replaced.pptx');
  const canonical = await fs.realpath(local);
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === canonical) {
      await fs.rename(local, `${local}.previous`);
      await fs.writeFile(local, 'new file at same path');
    }
    return handle;
  };
  try { await assert.rejects(f.read(source('artifact', 'artifacts/run/replaced.pptx'))); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(f.calls.remote, []);
});
