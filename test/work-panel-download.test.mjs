import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpanel-download-source-'));
require('esbuild').buildSync({ stdin: { contents: [
  `export { WorkPanelPageAutomation } from ${JSON.stringify(path.join(root, 'src/main/modules/web-surfaces/cdp/page-automation.ts'))};`,
  `export { executePageAutomationCommand } from ${JSON.stringify(path.join(root, 'src/main/modules/web-surfaces/cdp/page-automation-commands.ts'))};`,
  `export { validateClickParams } from ${JSON.stringify(path.join(root, 'src/main/modules/web-surfaces/cdp/click-params.ts'))};`,
  `export { validateObservationParams } from ${JSON.stringify(path.join(root, 'src/main/modules/web-surfaces/cdp/observation-params.ts'))};`,
].join('\n'), resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent' });
const { WorkPanelPageAutomation, executePageAutomationCommand, validateClickParams, validateObservationParams } = require(path.join(directory, 'fixture.cjs'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const fileLimit = 4 * 1024 * 1024;

class DownloadItem extends EventEmitter {
  constructor(bytes = Buffer.from('fixture'), total = bytes.length) { super(); this.bytes = bytes; this.total = total; this.received = 0; this.paths = []; this.cancels = 0; }
  getFilename() { return 'report.csv'; }
  getMimeType() { return 'text/csv'; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  setSavePath(value) { this.paths.push(value); }
  cancel() { this.cancels++; }
  progress(received, total = this.total) { this.received = received; this.total = total; this.emit('updated'); }
  finish(bytes = this.bytes, outcome = 'completed') {
    this.received = bytes.length;
    if (this.paths.length) fs.writeFileSync(this.paths.at(-1), bytes);
    this.emit('done', {}, outcome);
  }
}

async function fixture(t) {
  const contents = new EventEmitter(), debuggerRef = new EventEmitter(), session = new EventEmitter();
  let attached = false;
  debuggerRef.isAttached = () => attached; debuggerRef.attach = () => { attached = true; };
  debuggerRef.sendCommand = async () => ({});
  Object.assign(contents, { id: 704, debugger: debuggerRef, session, isDestroyed: () => false });
  const automation = new WorkPanelPageAutomation({ debug() {}, warn() {} });
  t.after(() => automation.dispose()); await automation.prepare(contents);
  const download = (item = new DownloadItem(), source = contents) => { session.emit('will-download', {}, item, source); return item; };
  const command = (method, params) => executePageAutomationCommand({ method, params, surfaceId: 'owned-page', contents, automation,
    observations: {}, send: async () => { throw new Error('Download ACK must not dispatch a page command'); }, validate: async () => {} });
  return { contents, automation, download, command };
}

test('WorkPanel preparation and observation leave subsequent user downloads entirely native', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) { await f.automation.prepare(f.contents); f.automation.modalState(f.contents); }
  const item = f.download(); item.finish();
  assert.deepEqual(item.paths, []); assert.equal(item.cancels, 0);
  assert.deepEqual(f.automation.listDownloads(f.contents), []);
});

test('an explicit WorkPanel download window captures one small attachment and verifies the durable-file ACK', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.automation.armDownload(f.contents, abort.signal);
  const first = f.download(); first.finish();
  const second = f.download(); second.finish();
  assert.equal(first.paths.length, 1); assert.deepEqual(second.paths, []);
  const [entry] = f.automation.listDownloads(f.contents); assert.equal(entry.status, 'complete');
  const file = await f.automation.readDownload(f.contents, entry.downloadId);
  assert.equal(Buffer.from(file.data, 'base64').toString(), 'fixture');
  await assert.rejects(f.command('Surface.releaseDownload', { downloadId: entry.downloadId, sha256: '0'.repeat(64) }), { code: 'download_digest_mismatch' });
  assert.equal(fs.existsSync(first.paths[0]), true);
  assert.deepEqual((await f.command('Surface.releaseDownload', { downloadId: entry.downloadId, sha256: file.sha256 })).result, { released: true });
  assert.equal(fs.existsSync(path.dirname(first.paths[0])), false);
  assert.deepEqual((await f.command('Surface.releaseDownload', { downloadId: entry.downloadId, sha256: file.sha256 })).result, { released: true });
  assert.deepEqual(f.automation.listDownloads(f.contents), []);
  assert.equal(first.cancels + second.cancels, 0);
});

test('aborted, expired and foreign-page WorkPanel windows do not take user downloads', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.automation.armDownload(f.contents, abort.signal); abort.abort();
  const cancelled = f.download(); assert.deepEqual(cancelled.paths, []);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  f.automation.armDownload(f.contents); t.mock.timers.tick(10001);
  const expired = f.download(); assert.deepEqual(expired.paths, []);
  t.mock.timers.reset();
  f.automation.armDownload(f.contents);
  const foreign = f.download(new DownloadItem(), { id: 999 }); assert.deepEqual(foreign.paths, []);
  const own = f.download(); own.finish(); assert.equal(own.paths.length, 1);
  assert.equal(cancelled.cancels + expired.cancels + foreign.cancels + own.cancels, 0);
});

test('oversized and unknown-size WorkPanel downloads stay native and failed notices do not exhaust capacity', async t => {
  const f = await fixture(t);
  for (const total of [fileLimit + 1, 0, -1, NaN, ...Array(10).fill(fileLimit + 1)]) {
    f.automation.armDownload(f.contents);
    const item = f.download(new DownloadItem(Buffer.from('native'), total));
    assert.deepEqual(item.paths, []); assert.equal(item.cancels, 0);
    const entries = f.automation.listDownloads(f.contents);
    assert.equal(entries.length, 1); assert.equal(entries[0].status, 'failed');
  }
  // The first attachment consumes an armed window even when import preflight rejects it.
  assert.deepEqual(f.download().paths, []);
  f.automation.armDownload(f.contents);
  const small = f.download(); small.finish();
  assert.equal(small.paths.length, 1);
  assert.equal(f.automation.listDownloads(f.contents).filter(entry => entry.status === 'complete').length, 1);
});

test('acknowledging a WorkPanel file frees the eighth slot for another explicit capture', async t => {
  const f = await fixture(t), items = [];
  for (let index = 0; index < 8; index++) { f.automation.armDownload(f.contents); const item = f.download(); item.finish(); items.push(item); }
  f.automation.armDownload(f.contents);
  const blocked = f.download(); assert.deepEqual(blocked.paths, []); assert.equal(blocked.cancels, 0);
  assert.equal(f.automation.listDownloads(f.contents).filter(entry => entry.status === 'complete').length, 8);
  const first = f.automation.listDownloads(f.contents)[0], file = await f.automation.readDownload(f.contents, first.downloadId);
  await f.command('Surface.releaseDownload', { downloadId: first.downloadId, sha256: file.sha256 });
  f.automation.armDownload(f.contents);
  const ninth = f.download(); ninth.finish();
  assert.equal(ninth.paths.length, 1);
  assert.equal(f.automation.listDownloads(f.contents).length, 8);
  assert.equal(items.every(item => item.cancels === 0), true);
});

test('a claimed WorkPanel download that grows too large continues natively and cleans its rejected import after done', async t => {
  const f = await fixture(t);
  f.automation.armDownload(f.contents);
  const item = f.download(new DownloadItem(Buffer.from('small'), 5));
  item.progress(fileLimit + 1, fileLimit + 1);
  assert.equal(item.cancels, 0);
  assert.equal(f.automation.listDownloads(f.contents)[0].error, 'file_transfer_limit');
  assert.equal(fs.existsSync(path.dirname(item.paths[0])), true);
  item.finish(Buffer.alloc(fileLimit + 1));
  assert.equal(item.cancels, 0); assert.equal(fs.existsSync(path.dirname(item.paths[0])), false);
  assert.equal(f.automation.listDownloads(f.contents).filter(entry => entry.status === 'complete').length, 0);
});

test('Run cancellation removes WorkPanel imports and never publishes a late completed download or cancels the native item', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.automation.armDownload(f.contents, abort.signal);
  const item = f.download(), id = f.automation.listDownloads(f.contents)[0].downloadId;
  abort.abort(); item.finish();
  assert.equal(item.cancels, 0); assert.deepEqual(f.automation.listDownloads(f.contents), []);
  assert.equal(fs.existsSync(path.dirname(item.paths[0])), false);
  await assert.rejects(f.automation.readDownload(f.contents, id), { code: 'download_not_found' });
});

test('captureDownload is an explicit boolean on click parameters and cannot arm other interactions', () => {
  for (const captureDownload of [undefined, false, true]) {
    const flag = captureDownload === undefined ? {} : { captureDownload };
    validateClickParams({ x: 0, y: 0, ...flag });
    validateObservationParams('Surface.click', { observationId: 'observed', ref: 'e1', ...flag });
  }
  for (const captureDownload of ['true', 1, null]) {
    assert.throws(() => validateClickParams({ x: 0, y: 0, captureDownload }));
    assert.throws(() => validateObservationParams('Surface.click', { observationId: 'observed', ref: 'e1', captureDownload }));
  }
  for (const method of ['Surface.observe', 'Surface.scroll', 'Surface.interact'])
    assert.throws(() => validateObservationParams(method, { captureDownload: true, ...(method === 'Surface.interact' ? { action: 'fill', selector: '#name', value: 'x' } : {}) }));
});
