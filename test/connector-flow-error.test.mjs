import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup() {
  const slots = []; let cursor = 0; const calls = []; const timers = new Map(); let nextTimer = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useCallback(fn) { return fn; }, useEffect() {},
  };
  const api = { market: {
    getConnectorConnections: async () => [],
    update: async id => { calls.push(['update', id]); throw new Error('update failed'); },
  }, connectorAuthBrowser: {}, assistant: { getSettings: async () => ({ chatDefaultAgentKey: 'cutej' }) } };
  const flow = { runMarketConnectorFlow: async intent => { calls.push(['connect', intent.item.id]); throw new Error('command for darwin is required'); } };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../src/renderer/pages/functional-market/useMarketConnectorFlow.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: name => name === 'react' ? react : flow, window: { electronAPI: api, setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } }, AbortController, Error, console });
  return { calls, api, flow, timers, render() { cursor = 0; return module.exports.useMarketConnectorFlow(); } };
}
const wecom = { id: 'wecom', connectorId: 'wecom-cli', name: '企业微信' };
const jira = { id: 'jira', name: 'Jira' };
test('a failed WeCom connection is not shown or retried in Jira details', async () => {
  const s = setup(); await s.render().start(wecom);
  const runtime = s.render();
  assert.equal(runtime.getError(wecom), 'command for darwin is required');
  assert.equal(runtime.getError(jira), '');
  await runtime.retry(jira);
  assert.equal(s.calls.length, 1);
  await runtime.retry(wecom);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1][1], 'wecom');
});
test('update failure retries that update instead of an earlier connector connection', async () => {
  const s = setup(); await s.render().start(wecom); await s.render().mutate(jira, 'update');
  const runtime = s.render();
  assert.equal(runtime.getError(wecom), '');
  assert.equal(runtime.getError(jira), 'update failed');
  assert.equal(runtime.flow, null);
  await runtime.retry(jira);
  assert.deepEqual(s.calls, [['connect', 'wecom'], ['update', 'jira'], ['update', 'jira']]);
});

test('refresh clears a recovered preparation failure but preserves unrelated and mutation errors', async () => {
  const s = setup();
  s.flow.runMarketConnectorFlow = async intent => { intent.onPhase('preparing'); throw new Error('version failed'); };
  await s.render().start(wecom);
  s.api.market.getConnectorConnections = async () => [{ connectorId: 'jira', readiness: 'ready' }];
  await s.render().refresh(); assert.equal(s.render().getError(wecom), 'version failed');
  s.api.market.getConnectorConnections = async () => [{ connectorId: 'wecom-cli', readiness: 'ready' }];
  await s.render().refresh(); assert.equal(s.render().error, '');
  await s.render().mutate(wecom, 'update'); await s.render().refresh();
  assert.equal(s.render().error, 'update failed');
  s.render().dismissError(); assert.equal(s.render().error, '');
});
test('ready connector does not hide a failed Agent mount', async () => {
  const s = setup();
  s.flow.runMarketConnectorFlow = async intent => { intent.onPhase('mounting'); throw new Error('mount failed'); };
  s.api.market.getConnectorConnections = async () => [{ connectorId: 'wecom-cli', readiness: 'ready' }];
  await s.render().start(wecom); await s.render().refresh();
  assert.equal(s.render().error, 'mount failed');
});

test('authorization watchdog releases loading even while status request never settles', async () => {
  const s = setup(); let intent, entered;
  const started = new Promise(resolve => { entered = resolve; });
  s.flow.runMarketConnectorFlow = input => { intent = input; input.onPhase('authorizing'); entered(); return new Promise(() => {}); };
  const running = s.render().start(wecom);
  await started;
  assert.equal(s.render().busy, true);
  const timer = [...s.timers.values()][0]; assert.equal(timer.ms, 180000);
  timer.fn(); await running;
  assert.equal(intent.signal.aborted, true);
  assert.equal(s.render().busy, false);
  assert.equal(s.render().getError(wecom), 'market.connector.flow.authorizationTimeout');
  assert.equal(s.timers.size, 0);
  s.flow.runMarketConnectorFlow = async () => ({ result: 'complete' });
  await s.render().start(jira); assert.equal(s.render().error, '');
});
test('leaving authorization clears its watchdog before mounting', async () => {
  const s = setup();
  s.flow.runMarketConnectorFlow = async intent => {
    intent.onPhase('authorizing'); assert.equal(s.timers.size, 1);
    intent.onPhase('mounting'); assert.equal(s.timers.size, 0);
    return { result: 'complete' };
  };
  await s.render().start(wecom); assert.equal(s.render().busy, false);
});
