import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeClick } = require('../dist-electron/main/modules/web-surfaces/cdp/click.js');
const { validateDesktopCdpParams } = require('../dist-electron/main/modules/web-surfaces/cdp/params.js');
const { withCdpCommandQueue } = require('../dist-electron/main/modules/web-surfaces/cdp/command-queue.js');

function harness(onSend = () => {}) {
  const contents = new EventEmitter(); contents.isDestroyed = () => false; contents.getURL = () => 'https://test/page';
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params }); await onSend(method, params, contents);
    if (method === 'Runtime.evaluate') return { result: { value: params.expression.endsWith(',"wait")') ? { matched: true, visible: true } : { x: 20.5, y: 30.25, matched: true } } };
    return {};
  };
  return { contents, send, calls };
}

test('click parameter contract: both modes, optional wait and strict types', () => {
  for (const p of [{ x: 0, y: 1.5 }, { selector: '#b' }, { selector: '#b', waitFor: { selector: '#d', state: 'visible' } }, { x: 1, y: 2, waitFor: { state: 'url', value: 'https://test/page' } }]) validateDesktopCdpParams('Input.click', p);
  for (const p of [{ x: '0', y: 1 }, { x: 0 }, { selector: '#b', x: 1, y: 2 }, { selector: '#b', waitFor: null }, { selector: '#b', timeoutMs: '3000' }, { selector: '#b', waitFor: { state: 'checked', selector: '#b', checked: 'true' } }, { selector: '#b', waitFor: { state: 'url', value: 'url', selector: '#b' } }]) assert.throws(() => validateDesktopCdpParams('Input.click', p), { code: 'invalid_args' });
});

test('no waitFor sends one press/release and does not poll after release', async () => {
  const h = harness();
  const r = await executeClick({ x: 20.5, y: 30.25 }, h.contents, h.send, async () => {});
  assert.equal(r.status, 'clicked'); assert.equal(r.conditionMatched, null);
  assert.equal(r.action.outcome, 'complete');
  assert.deepEqual(h.calls.slice(-2).map(c => c.params.type), ['mousePressed', 'mouseReleased']);
  assert.equal(h.calls.filter(c => c.method === 'Runtime.evaluate').length, 2);
  assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
});

test('condition polling follows release for both modes', async () => {
  for (const locator of [{ selector: '#b' }, { x: 20.5, y: 30.25 }]) {
    const h = harness(); const r = await executeClick({ ...locator, waitFor: { state: 'visible', selector: '#d' } }, h.contents, h.send, async () => {});
    assert.equal(r.status, 'condition_met'); assert.equal(r.conditionMatched, true);
    assert.equal(h.calls.at(-1).method, 'Runtime.evaluate');
  }
});

test('cancel after press still releases; never clicks twice', async () => {
  const controller = new AbortController();
  const h = harness((_m, p) => { if (p.type === 'mousePressed') controller.abort(); });
  const r = await executeClick({ selector: '#b' }, h.contents, h.send, async () => {}, controller.signal);
  assert.equal(r.status, 'canceled'); assert.equal(r.action.released, true);
  assert.deepEqual(h.calls.filter(c => c.method.startsWith('Input.')).map(c => c.params.type), ['mousePressed', 'mouseReleased']);
});

test('navigation after press releases original guest and stops DOM observation', async () => {
  const h = harness((_m, p, c) => { if (p.type === 'mousePressed') c.emit('did-start-navigation', {}, 'https://new', false, true); });
  const r = await executeClick({ selector: '#b', waitFor: { state: 'visible', selector: '#d' } }, h.contents, h.send, async () => {});
  assert.equal(r.status, 'navigation'); assert.equal(r.action.released, true);
  assert.equal(h.calls.filter(c => c.method === 'Runtime.evaluate').length, 2);
});

test('uncertain press performs only release cleanup and preserves unknown outcome', async () => {
  const h = harness((_m, p) => { if (p.type === 'mousePressed') throw new Error('transport lost'); });
  const r = await executeClick({ selector: '#b' }, h.contents, h.send, async () => {});
  assert.equal(r.status, 'failed'); assert.equal(r.action.outcome, 'unknown'); assert.equal(r.action.released, true);
  assert.equal(h.calls.filter(c => c.params.type === 'mousePressed').length, 1);
});

test('timeout after click reports completed action without replay', async () => {
  const h = harness(); const original = h.send;
  h.send = async (m, p, timeout) => p.expression?.endsWith(',"wait")') ? { result: { value: { matched: false } } } : original(m, p, timeout);
  const r = await executeClick({ selector: '#b', timeoutMs: 100, waitFor: { state: 'visible', selector: '#d' } }, h.contents, h.send, async () => {});
  assert.equal(r.status, 'timeout'); assert.equal(r.action.outcome, 'complete');
  assert.equal(h.calls.filter(c => c.params.type === 'mousePressed').length, 1);
});

test('raw commands queue behind the entire composed transaction', async () => {
  const events = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const click = withCdpCommandQueue(1, async () => { events.push('press'); await gate; events.push('release'); });
  const raw = withCdpCommandQueue(1, async () => { events.push('raw'); });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['press']);
  release(); await Promise.all([click, raw]); assert.deepEqual(events, ['press', 'release', 'raw']);
});
