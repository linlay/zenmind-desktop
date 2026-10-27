import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-download-lifecycle-'));
require('esbuild').buildSync({ stdin: { contents: [
  `export { ChromeWorkerEngine } from ${JSON.stringify(path.join(root, 'src/main/modules/browser-use/chrome-worker-engine.ts'))};`,
  `export { BrowserUseRuntime } from ${JSON.stringify(path.join(root, 'src/main/modules/browser-use/runtime.ts'))};`,
].join('\n'), resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(temporary, 'fixture.cjs'), logLevel: 'silent' });
const { ChromeWorkerEngine, BrowserUseRuntime } = require(path.join(temporary, 'fixture.cjs'));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const deferred = () => {
  const result = { settled: false };
  result.promise = new Promise(done => { result.resolve = value => { result.settled = true; done(value); }; });
  return result;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (read, message) => {
  for (let index = 0; index < 100; index++) { if (read()) return; await flush(); }
  assert.fail(message);
};
const identity = (chatId = 'chat-a', runId = 'run-a') => ({ chatId, runId, agentKey: 'cutej' });
const noFallback = async () => { throw new Error('A Chrome lifecycle check must not fall back to WorkPanel'); };

async function fixture(t, options = {}) {
  const calls = [], bytes = Buffer.from('fixture copy');
  const inputStarted = deferred(), trialStarted = deferred(), sessionStarted = deferred(), initialized = deferred();
  let inputs = 0, trials = 0, sessions = 0, serial = 0;
  const session = Object.assign(new EventEmitter(), {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Fetch.getResponseBody') return options.body ? options.body.promise : { body: bytes.toString('base64'), base64Encoded: true };
      return {};
    },
    async detach() { calls.push({ method: 'detach' }); },
  });
  const performInput = async () => { inputs++; inputStarted.resolve(); if (options.input) await options.input.promise; };
  const locator = {
    async click(params) {
      if (!params.trial) return performInput();
      trials++; trialStarted.resolve();
      if (options.trial) await options.trial.promise;
      if (options.unavailable) throw new Error(`Synthetic ${options.unavailable} target`);
    },
  };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, url: () => 'https://fixture.test/owned', locator: () => locator, mouse: { click: performInput },
  });
  const tab = { page, desktopPageId: 'owned-page', modalStates: () => [],
    captureSnapshot: async () => ({ ariaSnapshot: '', ariaSnapshotJSON: [] }), targetLocator: async () => ({ locator }),
    async createDownloadSession() { sessions++; sessionStarted.resolve(); return options.prepare ? await options.prepare.promise : session; },
  };
  const describe = async () => ({ pageId: tab.desktopPageId, url: page.url(), title: 'Owned fixture', active: true, isLoading: false });
  const controller = { browserContext: { once() {} }, list: async () => [await describe()], describe, async disconnect() {},
    async run(pageId, operation) {
      assert.equal(pageId, tab.desktopPageId);
      if (options.initialize) { initialized.resolve(); await options.initialize.promise; }
      return operation(tab);
    },
  };
  const engine = new ChromeWorkerEngine(async () => controller);
  const request = (method, params = {}, pageId) => {
    const promise = engine.request({ id: `wire-${++serial}`, method, params, ...(pageId ? { pageId } : {}) });
    void promise.catch(() => undefined); return promise;
  };
  t.after(async () => {
    options.input?.resolve(); options.trial?.resolve(); options.initialize?.resolve(); options.prepare?.resolve(session);
    options.body?.resolve({ body: bytes.toString('base64'), base64Encoded: true });
    await engine.disconnect();
  });
  await request('connect');
  const click = (params = {}) => request('click', { x: 1, y: 1, captureDownload: true, ...params }, tab.desktopPageId);
  const pause = (requestId = 'owned-attachment') => session.emit('Fetch.requestPaused', {
    requestId, resourceType: 'Document', request: { url: 'https://fixture.test/report' }, responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename=report.txt' }, { name: 'Content-Length', value: String(bytes.length) }],
  });
  return { engine, page, tab, session, calls, bytes, request, click, pause, inputStarted, trialStarted, sessionStarted, initialized,
    counts: () => ({ inputs, trials, sessions }), downloads: () => engine.transfers.list(tab.desktopPageId) };
}

test('Run release immediately revokes an armed capture while its original click is still in flight', { timeout: 10000 }, async t => {
  const input = deferred(), f = await fixture(t, { input });
  const click = f.click(); await waitFor(() => f.inputStarted.settled, 'the explicit click must dispatch its original input');
  assert.equal(f.calls.filter(call => call.method === 'Fetch.enable').length, 1, 'the explicit click must first arm a real response port');
  let clickSettled = false; void click.finally(() => { clickSettled = true; }).catch(() => undefined);
  const cleanup = f.request('release-transfers');
  try {
    await flush(); f.pause('user-download-after-run-release'); await flush();
    assert.equal(clickSettled, false, 'releasing capture must not replay or pretend to complete an in-flight input');
    assert.equal(f.calls.filter(call => call.method === 'Fetch.getResponseBody').length, 0);
    assert.deepEqual(f.downloads(), []);
  } finally { input.resolve(); await Promise.allSettled([click, cleanup]); }
  assert.equal(f.counts().inputs, 1);
});

for (const phase of ['initialize', 'trial', 'prepare']) test(`a Run released during ${phase} cannot arm or dispatch the old download click later`, { timeout: 10000 }, async t => {
  const gate = deferred(), f = await fixture(t, { [phase]: gate });
  const click = phase === 'trial'
    ? f.request('click', { selector: '#download', captureDownload: true }, f.tab.desktopPageId) : f.click();
  const started = phase === 'initialize' ? f.initialized : phase === 'trial' ? f.trialStarted : f.sessionStarted;
  await waitFor(() => started.settled, `the click must reach its controlled ${phase} boundary`);
  assert.equal(f.calls.some(call => call.method === 'Fetch.enable'), false, 'capture is not enabled before target preflight completes');
  const cleanup = f.request('release-transfers');
  gate.resolve(phase === 'prepare' ? f.session : undefined);
  const [result] = await Promise.allSettled([click, cleanup]);
  assert.equal(f.counts().inputs, 0, 'an old admitted click cannot dispatch after its capture authorization was revoked');
  assert.equal(f.calls.some(call => call.method === 'Fetch.enable'), false);
  if (result.status === 'fulfilled') assert.equal(result.value.action.outcome, 'not_started');
  f.pause('late-user-attachment'); await flush();
  assert.equal(f.calls.some(call => call.method === 'Fetch.getResponseBody'), false);
  assert.deepEqual(f.downloads(), []);
});

for (const unavailable of ['missing', 'disabled']) test(`a ${unavailable} target reports not_started without preparing download capture`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { unavailable });
  const result = await f.request('click', { selector: '#download', captureDownload: true }, f.tab.desktopPageId);
  assert.equal(result.action.outcome, 'not_started');
  assert.equal(f.counts().trials, 1); assert.equal(f.counts().inputs, 0); assert.equal(f.counts().sessions, 0);
  assert.equal(f.calls.some(call => call.method === 'Fetch.enable'), false);
  f.pause('unrelated-user-attachment'); await flush();
  assert.equal(f.calls.some(call => call.method === 'Fetch.getResponseBody'), false);
  assert.deepEqual(f.downloads(), []);
});

test('Main keeps a finished Run owner draining until its pending attachment body really settles', { timeout: 10000 }, async t => {
  const body = deferred(), f = await fixture(t, { body }), pending = new Set();
  const client = {
    request(method, params, pageId, signal) {
      if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      const work = f.request(method, params, pageId); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    async drain() { await Promise.allSettled([...pending]); },
    async disconnect() { await f.engine.disconnect(); }, kill() { void f.engine.disconnect(); },
  };
  const runtime = new BrowserUseRuntime({ createClient: () => client, preferences: {
    read: () => ({ defaultBackend: 'chrome', rememberChromeConnection: true, hasSavedAuthorization: true, secureStorageAvailable: true }),
    authorization: async () => 'SYNTHETIC_LIFECYCLE_AUTHORIZATION',
  } });
  t.after(() => runtime.dispose());
  const cdp = (source, method, surfaceId, params = {}) => runtime.cdp({ source, method, surfaceId, params }, undefined, noFallback);
  const register = async source => { runtime.registerRun(source); await cdp(source, 'Browser.select', undefined, { browser: 'chrome' }); };
  try {
    await runtime.connect('chat-a'); const first = identity(); await register(first);
    const surface = runtime.state('chat-a').pages[0].surfaceId;
    await cdp(first, 'Input.click', surface, { x: 1, y: 1, captureDownload: true });
    f.pause(); await waitFor(() => f.calls.some(call => call.method === 'Fetch.getResponseBody'), 'the original attachment body must be pending');
    runtime.releaseRun(first.runId); await flush();
    assert.equal(runtime.state(first.chatId).workspaceOwner.draining, true);
    assert.equal(runtime.state(first.chatId).workspaceOwner.runId, first.runId);
    assert.equal(f.calls.some(call => call.method === 'Fetch.disable' || call.method === 'Fetch.continueResponse'), false);
    assert.deepEqual(f.downloads(), []);
    const next = identity('chat-b', 'run-b'); await register(next);
    await assert.rejects(cdp(next, 'Surface.list'), { code: 'browser_workspace_draining' });
    body.resolve({ body: f.bytes.toString('base64'), base64Encoded: true });
    await waitFor(() => !runtime.state(first.chatId).workspaceOwner, 'ownership must release only after the body and original-response continuation settle');
    const result = await cdp(next, 'Surface.list');
    assert.equal(result.result.surfaces[0].surfaceId, surface);
    assert.equal(f.calls.filter(call => call.method === 'Fetch.continueResponse').length, 1);
    assert.deepEqual(f.downloads(), []);
  } finally { body.resolve({ body: f.bytes.toString('base64'), base64Encoded: true }); }
});
