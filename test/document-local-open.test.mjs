import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { createDocumentLocalOpenService, isLocalDocumentPathWithinRoot } = require('../dist-electron/main/modules/work-panel/document-local-open.js');
const { isLocalDocumentBytes, LOCAL_DOCUMENT_MAX_BYTES } = require('../dist-electron/main/modules/work-panel/document-local-open-format.js');
const { LocalDocumentApplicationError } = require('../dist-electron/main/infrastructure/electron/local-document-apps.js');

const parts = {
  '.docx': ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  '.xlsx': ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  '.pptx': ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
};
const app = { id: 'office', name: 'Microsoft Office', path: '/Applications/Office.app', isDefault: true, iconDataUrl: 'data:image/png;base64,AA==' };
const secondApp = { id: 'wps', name: 'WPS', path: '/Applications/WPS.app', isDefault: false };
const sourceFor = (kind, extension = '.pptx') => kind === 'workspace-file'
  ? { kind, agentKey: 'agent', path: `docs/季度 #1${extension}` }
  : { kind, agentKey: 'agent', chatId: 'chat', resourceId: 'resource', relativePath: `${kind === 'artifact' ? 'artifacts' : 'references'}/季度 #1${extension}` };

async function officeBytes(extension, options = {}) {
  if (extension === '.pdf') return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  if (parts[extension]) {
    const [part, contentType] = parts[extension];
    const zip = new JSZip();
    zip.file('[Content_Types].xml', options.manifest ?? `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="${contentType}"/></Types>`);
    if (!options.omitMain) zip.file(part, '<document/>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  // A bounded CFB directory fixture: header, directory, FAT and stream sectors.
  const bytes = Buffer.alloc(2048);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44);
  bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(4096, 56);
  bytes.writeUInt32LE(0xfffffffe, 60);
  bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(0xff, 76, 512);
  bytes.writeUInt32LE(1, 76);
  const directory = (offset, name, type, size) => {
    bytes.write(`${name}\0`, offset, 'utf16le');
    bytes.writeUInt16LE((name.length + 1) * 2, offset + 64);
    bytes[offset + 66] = type;
    bytes.writeUInt32LE(2, offset + 116);
    bytes.writeBigUInt64LE(BigInt(size), offset + 120);
  };
  directory(512, 'Root Entry', 5, 512);
  directory(640, extension === '.doc' ? 'WordDocument' : extension === '.xls' ? 'Workbook' : 'PowerPoint Document', 2, 512);
  bytes.fill(0xff, 1024, 1536);
  bytes.writeUInt32LE(0xfffffffe, 1024);
  bytes.writeUInt32LE(0xfffffffd, 1028);
  bytes.writeUInt32LE(0xfffffffe, 1032);
  return bytes;
}

async function fixture(t, overrides = {}, extension = '.pptx') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'document-local-open-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = await officeBytes(extension);
  const destination = path.join(directory, `本地副本 #1${extension}`);
  const calls = { queried: [], dialogs: [], read: [], opened: [] };
  let owned = true;
  const ports = {
    platform: 'darwin',
    getDownloadsPath: () => directory,
    listApplications: async (ext) => { calls.queried.push(ext); return [app, secondApp]; },
    showSaveDialog: async (options) => { calls.dialogs.push(options); return { canceled: false, filePath: destination }; },
    readDocument: async (source) => { calls.read.push(source); return { fileName: `季度 #1${extension}`, bytes }; },
    openApplication: async (selected, file, stillOwned) => { assert.equal(stillOwned(), true); calls.opened.push({ selected, file }); },
    ...overrides,
  };
  return {
    service: createDocumentLocalOpenService(ports), ports, calls, directory, destination, bytes,
    stillOwned: () => owned,
    release: () => { owned = false; },
  };
}

test('query resolves Office and PDF semantic types without reading content and strips application paths', async (t) => {
  const f = await fixture(t);
  for (const extension of ['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.pdf']) {
    const result = await f.service.getOptions(sourceFor('workspace-file', extension), f.stillOwned);
    assert.deepEqual(result, { ok: true, applications: [
      { id: app.id, name: app.name, isDefault: true, iconDataUrl: app.iconDataUrl },
      { id: secondApp.id, name: secondApp.name, isDefault: false },
    ] });
  }
  const windows = await f.service.getOptions({ kind: 'workspace-file', agentKey: 'agent', path: 'C:\\项目\\工作簿.XLSX' }, f.stillOwned);
  assert.equal(windows.ok, true);
  assert.deepEqual(f.calls.queried, ['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.pdf', '.xlsx']);
  assert.equal(f.calls.read.length, 0);
  assert.equal(f.calls.dialogs.length, 0);
  assert.equal(f.calls.opened.length, 0);
});

test('no application is a valid empty query; failures and unsupported platforms are distinct', async (t) => {
  const noApps = await fixture(t, { listApplications: async () => [] });
  assert.deepEqual(await noApps.service.getOptions(sourceFor('artifact'), noApps.stillOwned), { ok: true, applications: [] });
  assert.equal((await noApps.service.openCopy(sourceFor('artifact'), 'office', noApps.stillOwned)).error.code, 'local_app_unavailable');
  assert.equal(noApps.calls.dialogs.length, 0);
  const failure = await fixture(t, { listApplications: async () => { throw new Error('private application path'); } });
  const failed = await failure.service.getOptions(sourceFor('artifact'), failure.stillOwned);
  assert.equal(failed.error.code, 'local_app_query_failed');
  assert.ok(!JSON.stringify(failed).includes('private'));
  const unsupported = await fixture(t, { platform: 'linux' });
  assert.equal((await unsupported.service.getOptions(sourceFor('reference'), unsupported.stillOwned)).error.code, 'capability_denied');
  assert.equal((await failure.service.getOptions(sourceFor('artifact', '.exe'), failure.stillOwned)).error.code, 'unsupported_document_type');
});

test('Office content identification distinguishes the three OOXML and three legacy container types', async () => {
  const extensions = ['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx'];
  for (const extension of extensions) {
    const bytes = await officeBytes(extension);
    for (const requested of extensions) assert.equal(await isLocalDocumentBytes(bytes, requested), requested === extension, `${extension} as ${requested}`);
  }
  assert.equal(await isLocalDocumentBytes(Buffer.from('MZ disguised executable'), '.pptx'), false);
  assert.equal(await isLocalDocumentBytes(await officeBytes('.docx', { omitMain: true }), '.docx'), false);
  assert.equal(await isLocalDocumentBytes(await officeBytes('.xlsx', { manifest: 'x'.repeat(1024 * 1024 + 1) }), '.xlsx'), false);
  assert.equal(await isLocalDocumentBytes(Buffer.alloc(LOCAL_DOCUMENT_MAX_BYTES + 1), '.pptx'), false);
  const invalidCompound = await officeBytes('.ppt');
  invalidCompound.writeUInt32LE(0, 1024); // Cyclic directory chain.
  assert.equal(await isLocalDocumentBytes(invalidCompound, '.ppt'), false);
});

test('all three sources and Office/PDF formats save exact bytes before launching a selected nondefault app', async (t) => {
  for (const platform of ['darwin', 'win32']) {
    for (const kind of ['workspace-file', 'artifact', 'reference']) {
      for (const extension of ['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.pdf']) {
        const f = await fixture(t, { platform }, extension);
        const result = await f.service.openCopy(sourceFor(kind, extension), 'wps', f.stillOwned);
        assert.deepEqual(result, { ok: true, status: 'launch-requested' }, `${platform}/${kind}/${extension}`);
        assert.deepEqual(await fs.readFile(f.destination), f.bytes);
        assert.equal(f.calls.opened[0].selected.id, 'wps');
        assert.equal(f.calls.opened[0].file, await fs.realpath(f.destination));
        assert.equal(f.calls.queried.length, 2);
        assert.equal(f.calls.dialogs[0].defaultPath, path.join(f.directory, `季度 #1${extension}`));
        assert.deepEqual(f.calls.dialogs[0].filters[0].extensions, [extension.slice(1)]);
      }
    }
  }
});

test('PDF identification is bounded to the document header and never accepts an Office container', async () => {
  const bytes = await officeBytes('.pdf');
  assert.equal(await isLocalDocumentBytes(bytes, '.pdf'), true);
  assert.equal(await isLocalDocumentBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), '.pdf'), true);
  assert.equal(await isLocalDocumentBytes(Buffer.concat([Buffer.from('short prefix\n'), bytes]), '.pdf'), true);
  assert.equal(await isLocalDocumentBytes(Buffer.concat([Buffer.alloc(1024, 32), bytes]), '.pdf'), false);
  assert.equal(await isLocalDocumentBytes(Buffer.from('%PDF-no-version\n'), '.pdf'), false);
  assert.equal(await isLocalDocumentBytes(await officeBytes('.pptx'), '.pdf'), false);
  assert.equal(await isLocalDocumentBytes(bytes, '.pptx'), false);
});

test('cancelled save skips file reads; changing the extension or spoofing the app is rejected before reading', async (t) => {
  const cancelled = await fixture(t, { showSaveDialog: async () => ({ canceled: true }) });
  assert.deepEqual(await cancelled.service.openCopy(sourceFor('workspace-file'), 'office', cancelled.stillOwned), { ok: true, status: 'cancelled' });
  assert.equal(cancelled.calls.read.length, 0);
  assert.equal(cancelled.calls.opened.length, 0);
  const wrong = await fixture(t, { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/document.exe' }) });
  assert.equal((await wrong.service.openCopy(sourceFor('artifact'), 'office', wrong.stillOwned)).error.code, 'document_save_failed');
  assert.equal(wrong.calls.read.length, 0);
  assert.equal((await wrong.service.openCopy(sourceFor('artifact'), '/bin/exec', wrong.stillOwned)).error.code, 'local_app_unavailable');
});

test('mismatched bytes or semantic filenames cannot replace an existing file', async (t) => {
  for (const invalidDocument of [
    { fileName: 'renamed.pptx', bytes: await officeBytes('.docx') },
    { fileName: 'different.docx', bytes: await officeBytes('.pptx') },
  ]) {
    const f = await fixture(t, { readDocument: async () => invalidDocument });
    await fs.writeFile(f.destination, 'keep existing');
    assert.equal((await f.service.openCopy(sourceFor('reference'), 'office', f.stillOwned)).error.code, 'unsupported_document_type');
    assert.equal(await fs.readFile(f.destination, 'utf8'), 'keep existing');
    assert.equal(f.calls.opened.length, 0);
  }
});

test('original paths, original aliases and hard links are rejected while an independent copy preserves the original', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.directory, 'original.pptx');
  const hardLink = path.join(f.directory, 'hard-link.pptx');
  const symlink = path.join(f.directory, 'alias.pptx');
  await fs.writeFile(original, f.bytes);
  await fs.link(original, hardLink);
  await fs.symlink(original, symlink);
  for (const destination of [original, hardLink, symlink, f.destination]) {
    const service = createDocumentLocalOpenService({ ...f.ports,
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      readDocument: async () => ({ fileName: 'original.pptx', bytes: f.bytes, originalPath: original }),
    });
    const result = await service.openCopy(sourceFor('workspace-file'), 'office', f.stillOwned);
    assert.equal(result.ok, destination === f.destination);
    if (!result.ok) assert.equal(result.error.code, 'document_save_failed');
    assert.deepEqual(await fs.readFile(original), f.bytes);
  }
  assert.equal(f.calls.opened.length, 1);
});

test('managed storage rejects direct writes and writes through a symlink parent', async (t) => {
  const f = await fixture(t);
  const managed = path.join(f.directory, 'managed');
  const alias = path.join(f.directory, 'unmanaged-alias');
  await fs.mkdir(managed);
  await fs.symlink(managed, alias, 'dir');
  for (const directory of [managed, alias]) {
    const destination = path.join(directory, 'new.pptx');
    const service = createDocumentLocalOpenService({ ...f.ports,
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      readDocument: async () => ({ fileName: 'original.pptx', bytes: f.bytes, protectedRoots: [managed] }),
    });
    assert.equal((await service.openCopy(sourceFor('reference'), 'office', f.stillOwned)).error.code, 'document_save_failed');
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  assert.equal(f.calls.opened.length, 0);
});

test('remote documents can save outside a genuinely absent local store, but not a dangling protected store', async (t) => {
  const f = await fixture(t, {}, '.pdf');
  const missingRoot = path.join(f.directory, 'not-downloaded', 'platform');
  const service = createDocumentLocalOpenService({ ...f.ports,
    readDocument: async () => ({ fileName: 'remote.pdf', bytes: f.bytes, protectedRoots: [missingRoot] }),
  });
  assert.deepEqual(await service.openCopy(sourceFor('reference', '.pdf'), 'office', f.stillOwned), { ok: true, status: 'launch-requested' });
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
  const dangling = path.join(f.directory, 'dangling-store');
  await fs.symlink(path.join(f.directory, 'missing-target'), dangling, 'dir');
  const closed = createDocumentLocalOpenService({ ...f.ports,
    readDocument: async () => ({ fileName: 'remote.pdf', bytes: f.bytes, protectedRoots: [dangling] }),
  });
  assert.equal((await closed.openCopy(sourceFor('reference', '.pdf'), 'office', f.stillOwned)).error.code, 'document_save_failed');
  assert.equal(f.calls.opened.length, 1);
});

test('platform path comparisons cover Windows case, drive and extended UNC boundaries', () => {
  assert.equal(isLocalDocumentPathWithinRoot('C:\\Managed\\a.doc', 'c:\\managed', 'win32'), true);
  assert.equal(isLocalDocumentPathWithinRoot('C:\\ManagedCopy\\a.doc', 'c:\\managed', 'win32'), false);
  assert.equal(isLocalDocumentPathWithinRoot('D:\\Managed\\a.doc', 'c:\\managed', 'win32'), false);
  assert.equal(isLocalDocumentPathWithinRoot('\\\\?\\UNC\\server\\share\\managed\\a.xls', '\\\\server\\share\\Managed', 'win32'), true);
  assert.equal(isLocalDocumentPathWithinRoot('/storage/managed/a.ppt', '/storage/managed', 'darwin'), true);
  assert.equal(isLocalDocumentPathWithinRoot('/storage/managed-copy/a.ppt', '/storage/managed', 'darwin'), false);
});

test('Windows prevents alternate streams and reserved file names', async (t) => {
  const f = await fixture(t, { platform: 'win32' });
  for (const name of ['copy:stream.pptx', 'NUL.pptx', 'COM1.pptx']) {
    const service = createDocumentLocalOpenService({ ...f.ports,
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(f.directory, name) }),
    });
    assert.equal((await service.openCopy(sourceFor('artifact'), 'office', f.stillOwned)).error.code, 'document_save_failed');
  }
  assert.equal(f.calls.opened.length, 0);
});

test('a failed temporary write keeps the existing destination and removes partial temporary files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.destination, 'existing document');
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.zenmind-office-')) {
      handle.sync = async () => { throw new Error('disk I/O failed'); };
    }
    return handle;
  };
  try {
    assert.equal((await f.service.openCopy(sourceFor('artifact'), 'office', f.stillOwned)).error.code, 'document_save_failed');
  } finally { fs.open = originalOpen; }
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing document');
  assert.deepEqual(await fs.readdir(f.directory), [path.basename(f.destination)]);
  assert.equal(f.calls.opened.length, 0);
});

test('ownership loss at query, dialog, source read and final query prevents late launch', async (t) => {
  for (const stage of ['query', 'dialog', 'read', 'final-query']) {
    const f = await fixture(t);
    let queries = 0;
    const service = createDocumentLocalOpenService({ ...f.ports,
      listApplications: async () => { queries++; if (stage === 'query' || (stage === 'final-query' && queries === 2)) f.release(); return [app]; },
      showSaveDialog: async () => { if (stage === 'dialog') f.release(); return { canceled: false, filePath: f.destination }; },
      readDocument: async () => { if (stage === 'read') f.release(); return { fileName: 'original.pptx', bytes: f.bytes }; },
    });
    assert.equal((await service.openCopy(sourceFor('artifact'), 'office', f.stillOwned)).error.code, 'target_unavailable', stage);
    assert.equal(f.calls.opened.length, 0);
    if (stage !== 'final-query') await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  }
});

test('launch failure or app removal keeps the complete saved copy', async (t) => {
  for (const mode of ['launch-failure', 'app-removed', 'removed-during-native-check']) {
    const f = await fixture(t);
    let queries = 0;
    const service = createDocumentLocalOpenService({ ...f.ports,
      listApplications: async () => ++queries === 2 && mode === 'app-removed' ? [] : [app],
      openApplication: async () => {
        if (mode === 'removed-during-native-check') throw new LocalDocumentApplicationError('application-unavailable', 'removed');
        throw new Error('failed to spawn');
      },
    });
    const result = await service.openCopy(sourceFor('artifact'), 'office', f.stillOwned);
    assert.equal(result.error.code, mode === 'launch-failure' ? 'application_launch_failed' : 'local_app_unavailable');
    assert.deepEqual(await fs.readFile(f.destination), f.bytes);
  }
});

test('pending dialog prevents duplicate launches and cancellation releases the request', async (t) => {
  let finishDialog;
  const f = await fixture(t, { showSaveDialog: () => new Promise((resolve) => { finishDialog = resolve; }) });
  const source = sourceFor('artifact');
  const pending = f.service.openCopy(source, 'office', f.stillOwned);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await f.service.openCopy({ ...source }, 'office', f.stillOwned);
  assert.equal(duplicate.error.code, 'duplicate_id');
  finishDialog({ canceled: true });
  assert.deepEqual(await pending, { ok: true, status: 'cancelled' });
  const retry = f.service.openCopy(source, 'office', f.stillOwned);
  await new Promise((resolve) => setImmediate(resolve));
  finishDialog({ canceled: true });
  assert.deepEqual(await retry, { ok: true, status: 'cancelled' });
});
