import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { ChromeWorkerEngine } = require('../dist-electron/main/modules/browser-use/chrome-worker-engine.js');
const { chromeWorkerResponseError } = require('../dist-electron/main/modules/browser-use/chrome-worker.js');

function phaseFixture(phase) {
  const privateError = () => new Error('SYNTHETIC_PRIVATE_URL_AND_TOKEN');
  const page = new EventEmitter();
  Object.assign(page, { isClosed: () => false,
    mainFrame: () => ({ evaluate: async () => {
      if (phase === 'viewport') throw privateError();
      return { width: 800, height: 600 };
    } }),
  });
  let captures = 0;
  const tab = { desktopPageId: 'owned-page', page, modalStates: () => [],
    captureSnapshot: async () => {
      captures++;
      if (phase === 'snapshot') throw privateError();
      const node = { role: 'heading', name: 'Owned fixture', box: { x: 0, y: 0, width: 400, height: 50 } };
      if (phase === 'projection') Object.defineProperty(node, 'ref', { get() { throw privateError(); } });
      return { ariaSnapshotJSON: [node] };
    },
  };
  const controller = { run: async (_id, callback) => callback(tab), describe: async () => {
    if (phase === 'state') throw privateError();
    return { pageId: tab.desktopPageId, url: 'https://fixture.example/', title: 'Fixture', active: true, isLoading: false };
  } };
  return { tab, controller, engine: new ChromeWorkerEngine(), captures: () => captures };
}

for (const phase of ['snapshot', 'state', 'viewport', 'projection']) test(`observation ${phase} failures expose a fixed phase without page errors or action replay`, async () => {
  const f = phaseFixture(phase);
  const options = { viewportOnly: phase === 'viewport' };
  const code = `observation_${phase}_failed`;
  await assert.rejects(f.engine.observe(f.controller, f.tab.desktopPageId, options), error => {
    assert.equal(error.code, code);
    assert.equal(error.message.includes('SYNTHETIC_PRIVATE'), false);
    const reply = chromeWorkerResponseError(Object.assign(new Error('SYNTHETIC_PRIVATE_URL_AND_TOKEN'), { code }), 'observe');
    assert.equal(reply.code, code);
    assert.equal(JSON.stringify(reply).includes('SYNTHETIC_PRIVATE'), false);
    return true;
  });
  let writes = 0;
  const completed = { status: 'done', action: { outcome: 'complete' }, writes: ++writes };
  const result = await f.engine.withObservation(f.controller, f.tab, completed, options);
  assert.equal(result.action.outcome, 'complete');
  assert.equal(result.writes, 1); assert.equal(writes, 1);
  assert.equal(result.observationError.code, code);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(f.captures(), 2, 'one read per attempt, with no snapshot or write replay');
  await f.engine.disconnect();
});

test('a timed-out observation cannot replace the newer reference map when its original snapshot arrives late', async () => {
  let resolveOld;
  const page = new EventEmitter();
  Object.assign(page, { mainFrame: () => 'main-frame', isClosed: () => false });
  const tab = { desktopPageId: 'owned-page', page, modalStates: () => [],
    captureSnapshot: () => new Promise(resolve => { resolveOld = resolve; }),
    targetLocator: async () => ({ locator: { evaluate: async () => ({ sensitive: false, tag: 'button', value: '' }) } }),
  };
  const controller = { run: async (_id, callback) => callback(tab),
    describe: async () => ({ pageId: tab.desktopPageId, url: 'https://fixture.example/', title: 'Fixture', active: true, isLoading: false }) };
  const engine = new ChromeWorkerEngine();
  await assert.rejects(engine.captureTimed(controller, tab, {}, 20), { code: 'observation_timeout' });
  tab.captureSnapshot = async () => ({ ariaSnapshotJSON: [{ role: 'button', name: 'New action', ref: 'e2' }] });
  const current = await engine.observe(controller, tab.desktopPageId, {});
  resolveOld({ ariaSnapshotJSON: [{ role: 'button', name: 'Old action', ref: 'e1' }] });
  await delay(20);
  assert.equal(engine.target(tab.desktopPageId, { observationId: current.observationId, ref: 'e2' }), 'e2');
  assert.throws(() => engine.target(tab.desktopPageId, { observationId: current.observationId, ref: 'e1' }), { code: 'stale_observation' });
  await engine.disconnect();
  assert.equal(page.listenerCount('download'), 0);
});
