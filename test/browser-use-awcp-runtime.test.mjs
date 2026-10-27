import { registerBrowserTask, releaseBrowserTask } from "./helpers/browser-use-task.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-awcp-runtime-'));
for (const [source, target] of [['browser-use/runtime', 'browser-use/runtime'], ['awcp/index', 'awcp/index'], ['awcp/protocol', 'awcp/protocol']]) {
  const destination = path.join(directory, `${target}.js`); fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/modules', `${source}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
const { BrowserUseRuntime } = require(path.join(directory, 'browser-use/runtime.js'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const source = (chatId = 'chat-a', runId = 'run-a') => ({ chatId, runId, agentKey: 'cutej' });
const signal = () => new AbortController().signal;
const privateScript = '/* SYNTHETIC_INSTALLED_BRIDGE_SOURCE */ void 0';
const noFallback = async () => { throw new Error('Chrome must not fall back'); };

async function fixture(t, overrides = {}) {
  const clients = [], scripts = [];
  const runtime = new BrowserUseRuntime({
    getWebsiteBridgeScript(url) { scripts.push(url); return privateScript; },
    createClient() {
      const client = { calls: [], pages: [{ pageId: `private-${clients.length}`, url: 'https://fixture.test/forum', title: 'Forum' }],
        async request(method, params, pageId) {
          this.calls.push({ method, params, pageId });
          if (method === 'list') return this.pages;
          if (method === 'connect' || method === 'state') return { connected: true, pages: this.pages };
          if (method === 'observe') return { observationId: 'fresh-observation', elements: [{ ref: 'e1' }], text: 'Current page' };
          if (method === 'awcp-manual') return { ok: true, method: 'AWCP.getManual', revision: 'revision-1',
            site: { name: 'Forum', description: 'Local fixture' }, sections: [{ section: 'forum.posts.list', title: 'Read posts' }] };
          if (method === 'awcp-invoke') return this.businessError ?? { ok: true, requestId: params.requestId, action: params.payload.action, result: { items: [] } };
          return { status: 'done' };
        },
        async disconnect() {}, kill() {},
      };
      clients.push(client); return client;
    }, ...overrides,
  });
  t.after(() => runtime.dispose());
  await runtime.connect('chat-a'); await registerBrowserTask(runtime, source());
  return { runtime, clients, scripts, surfaceId: runtime.state('chat-a').pages[0].surfaceId };
}

test('Main dispatches AWCP only to the frozen Chat page and compiles installed scripts privately', async t => {
  const f = await fixture(t);
  const result = await f.runtime.awcp('manual-1', 'AWCP.getManual', {}, source(), signal(), f.surfaceId);
  assert.equal(result.handled, true); assert.equal(result.result.revision, 'revision-1');
  const dispatched = f.clients[0].calls.find(call => call.method === 'awcp-manual');
  assert.equal(dispatched.pageId, 'private-0'); assert.equal(dispatched.params.runId, 'run-a');
  assert.equal(dispatched.params.runLease, 1);
  assert.equal(dispatched.params.expectedUrl, 'https://fixture.test/forum');
  assert.equal(dispatched.params.bridgeScript, privateScript); assert.deepEqual(f.scripts, ['https://fixture.test/forum']);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_INSTALLED_BRIDGE_SOURCE'), false);
  assert.equal(JSON.stringify(f.runtime.state('chat-a')).includes('private-0'), false);
});

test('forged Run owners, cross-Chat pages and pending acceptance cannot reach scripts or AWCP', async t => {
  const f = await fixture(t);
  await f.runtime.connect('chat-b'); await registerBrowserTask(f.runtime, source('chat-b', 'run-b'));
  await assert.rejects(f.runtime.awcp('x', 'AWCP.getManual', {}, { ...source(), agentKey: 'another' }, signal(), f.surfaceId), { code: 'browser_run_unavailable' });
  await assert.rejects(f.runtime.awcp('x', 'AWCP.getManual', {}, source('chat-b', 'run-b'), signal(), f.surfaceId), { code: 'target_not_found' });
  f.runtime.releaseRun('run-a'); f.runtime.prepareRun(source('chat-a', 'pending'));
  await assert.rejects(f.runtime.awcp('x', 'AWCP.getManual', {}, source('chat-a', 'pending'), signal(), f.surfaceId), { code: 'browser_run_unavailable' });
  assert.deepEqual(f.scripts, []);
  assert.equal(f.clients.some(client => client.calls.some(call => call.method.startsWith('awcp-'))), false);
});

test('only ordinary non-Chrome Runs remain unhandled; a Chrome Run never borrows a WorkPanel page', async t => {
  const f = await fixture(t);
  await registerBrowserTask(f.runtime, source('workpanel-chat', 'workpanel-run'));
  assert.deepEqual(await f.runtime.awcp('m', 'AWCP.getManual', {}, source('workpanel-chat', 'workpanel-run'), signal(), 'page:workpanel'), { handled: false });
  await assert.rejects(f.runtime.awcp('m', 'AWCP.getManual', {}, source(), signal(), 'page:workpanel'), { code: 'awcp_target_unavailable' });
  await assert.rejects(f.runtime.awcp('m', 'AWCP.getManual', {}, source('workpanel-chat', 'workpanel-run'), signal(), f.surfaceId), { code: 'browser_run_unavailable' });
});

test('model-authored script or host options are rejected by the common AWCP envelope before dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.awcp('m', 'AWCP.getManual', { bridgeScript: 'untrusted' }, source(), signal(), f.surfaceId), { code: 'awcp_invalid_request' });
  await assert.rejects(f.runtime.awcp('m', 'AWCP.getManual', { runLease: 999 }, source(), signal(), f.surfaceId), { code: 'awcp_invalid_request' });
  await assert.rejects(f.runtime.awcp('m', 'AWCP.invoke', { revision: 'revision-1', action: 'forum.posts.list', args: {}, expectedUrl: 'https://other.test' }, source(), signal(), f.surfaceId), { code: 'awcp_invalid_request' });
  assert.deepEqual(f.scripts, []);
  const state = await f.runtime.cdp({ method: 'Surface.getCurrent', source: source() }, undefined, noFallback);
  assert.equal(state.result.capabilities.awcp, true); assert.equal(state.result.capabilities.evaluate, false); assert.equal(state.result.capabilities.rawCdp, false);
});

test('AWCP business failures retain page response identity and invalidate prior typed-action references', async t => {
  const f = await fixture(t);
  await f.runtime.cdp({ method: 'Surface.observe', source: source(), surfaceId: f.surfaceId }, undefined, noFallback);
  const failure = { ok: false, requestId: 'invoke-1', action: 'forum.posts.list', error: { code: 'action.login_required', message: 'Sign in first' } };
  f.clients[0].businessError = failure;
  assert.deepEqual(await f.runtime.awcp('invoke-1', 'AWCP.invoke', { revision: 'revision-1', action: 'forum.posts.list', args: {} }, source(), signal(), f.surfaceId), { handled: true, result: failure });
  await assert.rejects(f.runtime.cdp({ method: 'Surface.click', source: source(), surfaceId: f.surfaceId,
    params: { observationId: 'fresh-observation', ref: 'e1' } }, undefined, noFallback), { code: 'stale_observation' });
  assert.equal(f.clients[0].calls.some(call => call.method === 'click'), false);
});

test('Run completion and package changes revoke AWCP state without dispatching typed business actions', async t => {
  const f = await fixture(t);
  await f.runtime.awcp('m', 'AWCP.getManual', {}, source(), signal(), f.surfaceId);
  f.runtime.refreshWebsiteBridges();
  assert.equal(f.clients[0].calls.filter(call => call.method === 'awcp-refresh').length, 1);
  f.runtime.releaseRun('run-a');
  assert.equal(f.clients[0].calls.filter(call => call.method === 'awcp-release-run' && call.params.runId === 'run-a').length, 1);
  assert.deepEqual(f.clients[0].calls.find(call => call.method === 'awcp-release-run').params, { runId: 'run-a', runLease: 1 });
  assert.equal(f.runtime.state('chat-a').connection, 'connected');
  await assert.rejects(f.runtime.awcp('late', 'AWCP.getManual', {}, source(), signal(), f.surfaceId), { code: 'browser_run_unavailable' });
});

test('Main reuses a Run AWCP lease and advances it only for the next shared-workspace owner', async t => {
  const f = await fixture(t, { preferences: {
    read: () => ({ defaultBackend: 'chrome', rememberChromeConnection: true, hasSavedAuthorization: true }),
    authorization: async () => 'SYNTHETIC_AUTHORIZATION_TOKEN',
  } });
  await f.runtime.awcp('first-directory', 'AWCP.getManual', {}, source(), signal(), f.surfaceId);
  await f.runtime.awcp('first-section', 'AWCP.getManual', { revision: 'revision-1', section: 'forum.posts.list' }, source(), signal(), f.surfaceId);
  assert.deepEqual(f.clients[0].calls.filter(call => call.method === 'awcp-manual').map(call => call.params.runLease), [1, 1]);
  await releaseBrowserTask(f.runtime, 'run-a');
  await registerBrowserTask(f.runtime, source('chat-b', 'run-b'));
  await f.runtime.awcp('next-directory', 'AWCP.getManual', {}, source('chat-b', 'run-b'), signal(), f.surfaceId);
  assert.equal(f.clients.length, 1, 'the authorized connection is reused by the next owner');
  assert.equal(f.clients[0].calls.filter(call => call.method === 'awcp-manual').at(-1).params.runLease, 2);
  assert.deepEqual(f.clients[0].calls.find(call => call.method === 'awcp-release-run').params, { runId: 'run-a', runLease: 1 });
});

test('bridge resolution failures are fixed host errors and cannot leak package paths or source', async t => {
  const f = await fixture(t, { getWebsiteBridgeScript() { throw new Error('SYNTHETIC_PRIVATE_BRIDGE_PATH'); } });
  await assert.rejects(f.runtime.awcp('m', 'AWCP.getManual', {}, source(), signal(), f.surfaceId), error =>
    error.code === 'awcp_bridge_unavailable' && !error.message.includes('SYNTHETIC_PRIVATE_BRIDGE_PATH'));
  assert.equal(f.clients[0].calls.some(call => call.method === 'awcp-manual'), false);
});
