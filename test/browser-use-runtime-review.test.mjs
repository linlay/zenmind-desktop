import { registerBrowserTask } from "./helpers/browser-use-task.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BrowserUseRuntime } = require('../dist-electron/main/modules/browser-use/runtime.js');

const source = runId => ({ chatId: 'chat-a', runId, agentKey: 'cutej' });
const noFallback = async () => { throw new Error('Chrome must not route to WorkPanel'); };
function harness() {
  const calls = [];
  const client = {
    async request(method, params, pageId, signal) {
      calls.push({ method, params, pageId, signal });
      if (method === 'list') return [{ pageId: 'p1', title: 'Fixture', url: 'https://fixture.test', active: true }];
      if (method === 'observe') return { observationId: 'previous-observation', elements: [{ ref: 'e1' }] };
      return { status: 'done' };
    },
    async disconnect() {}, kill() {},
  };
  const runtime = new BrowserUseRuntime({ createClient: () => client, stopRun: async () => ({ ok: true }) });
  const cdp = (runId, method, surfaceId, params = {}) => runtime.cdp({ method, source: source(runId), surfaceId, params }, undefined, noFallback);
  return { runtime, calls, cdp };
}

test('legacy Chrome actions cannot write through another Run holding the browser', async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.runtime.connect('chat-a');
  await registerBrowserTask(h.runtime, source('run-a'));
  await registerBrowserTask(h.runtime, source('run-b'));
  const surfaceId = (await h.cdp('run-a', 'Surface.list')).result.surfaces[0].surfaceId;
  await assert.rejects(h.runtime.action({ action: 'desktop.web.interactElement', source: source('run-b'),
    args: { surfaceId, action: 'scroll', deltaY: 600 } }, undefined, noFallback), { code: 'browser_busy' });
  assert.equal(h.calls.some(call => call.method === 'interact'), false);
});

test('legacy Chrome actions cannot reuse a previous Run observation', async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.runtime.connect('chat-a');
  await registerBrowserTask(h.runtime, source('run-a'));
  const surfaceId = (await h.cdp('run-a', 'Surface.list')).result.surfaces[0].surfaceId;
  await h.cdp('run-a', 'Surface.observe', surfaceId);
  h.runtime.releaseRun('run-a');
  await registerBrowserTask(h.runtime, source('run-b'));
  await assert.rejects(h.runtime.action({ action: 'desktop.web.interactElement', source: source('run-b'),
    args: { surfaceId, action: 'fill', ref: 'e1', observationId: 'previous-observation', value: 'must not run' } }, undefined, noFallback), { code: 'stale_observation' });
  assert.equal(h.calls.some(call => call.method === 'interact'), false);
});

test('a taken-over native action cannot return a late successful result', async t => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await registerBrowserTask(h.runtime, source('native-run'));
  let finish, operationSignal;
  const action = h.runtime.action({ action: 'desktop.web.interactElement', source: source('native-run'), args: { action: 'scroll' } }, undefined,
    signal => { operationSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  await h.runtime.takeover('chat-a');
  assert.equal(operationSignal.aborted, true);
  finish({ ok: true, action: 'desktop.web.interactElement', result: { done: true } });
  await assert.rejects(action, { code: 'browser_run_unavailable' });
});
