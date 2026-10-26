import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SurfaceObservationRegistry } = require('../dist-electron/main/modules/web-surfaces/cdp/observation.js');
const { observationExpression } = require('../dist-electron/main/modules/web-surfaces/cdp/observation-script.js');
const { validateDesktopCdpParams } = require('../dist-electron/main/modules/web-surfaces/cdp/params.js');

function harness(onProbe = () => undefined) {
  const contents = new EventEmitter();
  Object.assign(contents, { id: 701, isDestroyed: () => false, getURL: () => 'https://fixture.test/' });
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') {
      const [, request] = JSON.parse('[' + params.expression.slice(params.expression.lastIndexOf('})(') + 3, -1) + ']');
      const override = await onProbe(request);
      return { result: { value: override ?? (request.kind === 'observe'
        ? { observationId: request.observationId, url: 'https://fixture.test/', title: 'Fixture', text: 'Text', elements: [{ ref: 'e1', role: 'checkbox', name: 'Agree', tag: 'input' }], truncated: false }
        : request.kind === 'viewport' ? { width: 800, height: 600 }
          : { x: 10, y: 20, matched: true, prepared: true }) } };
    }
    return {};
  };
  const debuggerRef = Object.assign(new EventEmitter(), { isAttached: () => true, attach() {}, detach() {}, sendCommand: send });
  contents.debugger = debuggerRef;
  return { contents, send, calls, registry: new SurfaceObservationRegistry() };
}
const inputs = (calls) => calls.filter(call => call.method.startsWith('Input.'));

test('WorkPanel interaction contract matches the Chrome typed actions', () => {
  for (const params of [
    { observationId: 'o', ref: 'e1', action: 'hover' },
    { selector: '#agree', action: 'check' },
    { observationId: 'o', ref: 'e1', action: 'uncheck' },
    { action: 'type', value: 'abc' },
    { action: 'press', key: 'ControlOrMeta+A' },
    { action: 'scroll', deltaY: -300 },
    { selector: 'select', action: 'select', values: ['a', 'b'] },
  ]) validateDesktopCdpParams('Surface.interact', params);
  validateDesktopCdpParams('Surface.scroll', { deltaX: 10, deltaY: 400 });
  validateDesktopCdpParams('Surface.observe', { viewportOnly: true });
  for (const [method, params] of [
    ['Surface.interact', { action: 'hover' }],
    ['Surface.interact', { selector: '#a', observationId: 'o', ref: 'e1', action: 'focus' }],
    ['Surface.interact', { action: 'press', key: 'F5' }],
    ['Surface.interact', { action: 'type', value: 'x'.repeat(2001) }],
    ['Surface.interact', { selector: '#a', action: 'scroll', deltaY: 10 }],
    ['Surface.interact', { selector: '#a', action: 'select', value: 'a', values: ['a'] }],
    ['Surface.scroll', { deltaY: 5000 }],
    ['Surface.observe', { viewportOnly: 'yes' }],
  ]) assert.throws(() => validateDesktopCdpParams(method, params), { code: 'invalid_args' });
});

test('hover moves the pointer to the settled element point without pressing', async t => {
  const h = harness(); t.after(() => h.registry.dispose());
  const observed = await h.registry.observe('s', {}, h.contents, h.send, async () => {});
  await h.registry.interact('s', { observationId: observed.observationId, ref: 'e1', action: 'hover' }, h.contents, h.send, async () => {});
  assert.deepEqual(inputs(h.calls).map(call => call.params.type), ['mouseMoved']);
  assert.equal(inputs(h.calls)[0].params.x, 10);
});

test('check clicks only when the state differs and verifies the result; radios cannot be unchecked', async t => {
  let checked = false;
  const h = harness(request => request.kind === 'check-state' ? { checked, radio: false } : undefined);
  t.after(() => h.registry.dispose());
  const observed = await h.registry.observe('s', {}, h.contents, h.send, async () => {});
  const pressed = h.send;
  h.contents.debugger.sendCommand = async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') checked = true;
    return pressed(method, params);
  };
  const send = (method, params) => h.contents.debugger.sendCommand(method, params);
  const changed = await h.registry.interact('s', { observationId: observed.observationId, ref: 'e1', action: 'check' }, h.contents, send, async () => {});
  assert.equal(changed.changed, true);
  assert.deepEqual(inputs(h.calls).map(call => call.params.type), ['mousePressed', 'mouseReleased']);
  const unchanged = await h.registry.interact('s', { observationId: observed.observationId, ref: 'e1', action: 'check' }, h.contents, send, async () => {});
  assert.equal(unchanged.changed, false);
  assert.equal(inputs(h.calls).length, 2, 'an already checked box receives no input');

  const radio = harness(request => request.kind === 'check-state' ? { checked: true, radio: true } : undefined);
  t.after(() => radio.registry.dispose());
  const radioObserved = await radio.registry.observe('s', {}, radio.contents, radio.send, async () => {});
  await assert.rejects(radio.registry.interact('s', { observationId: radioObserved.observationId, ref: 'e1', action: 'uncheck' }, radio.contents, radio.send, async () => {}),
    { code: 'radio_cannot_uncheck' });
  assert.equal(inputs(radio.calls).length, 0);
});

test('type sends one key pair per character and press uses the platform select-all modifier', async t => {
  const h = harness(); t.after(() => h.registry.dispose());
  await h.registry.interact('s', { action: 'type', value: 'ab' }, h.contents, h.send, async () => {});
  assert.deepEqual(inputs(h.calls).map(call => [call.params.type, call.params.text ?? null]),
    [['keyDown', 'a'], ['keyUp', null], ['keyDown', 'b'], ['keyUp', null]]);
  h.calls.length = 0;
  await h.registry.interact('s', { action: 'press', key: 'ControlOrMeta+A' }, h.contents, h.send, async () => {});
  const [down, up] = inputs(h.calls);
  // macOS selects all with Command (Meta=4); Windows and Linux use Control (2).
  if (process.platform === 'darwin') assert.equal(down.params.modifiers, 4);
  else assert.equal(down.params.modifiers, 2);
  assert.deepEqual(down.params.commands, ['selectAll']);
  assert.equal(up.params.type, 'keyUp');
  h.calls.length = 0;
  await h.registry.interact('s', { action: 'press', key: 'Enter' }, h.contents, h.send, async () => {});
  assert.equal(inputs(h.calls)[0].params.text, '\r');
});

test('untargeted scroll wheels at the viewport centre with the requested deltas', async t => {
  const h = harness(); t.after(() => h.registry.dispose());
  await h.registry.interact('s', { action: 'scroll', deltaY: 250, deltaX: -20 }, h.contents, h.send, async () => {});
  const [wheel] = inputs(h.calls);
  assert.deepEqual({ type: wheel.params.type, x: wheel.params.x, y: wheel.params.y, deltaX: wheel.params.deltaX, deltaY: wheel.params.deltaY },
    { type: 'mouseWheel', x: 400, y: 300, deltaX: -20, deltaY: 250 });
});

test('a post-action observation replaces earlier refs; its failure keeps the action result', async t => {
  const h = harness(); t.after(() => h.registry.dispose());
  const first = await h.registry.observe('s', {}, h.contents, h.send, async () => {});
  const after = await h.registry.observeAfterAction('s', { viewportOnly: true }, h.contents, h.send, async () => {});
  assert.notEqual(after.observation.observationId, first.observationId);
  await assert.rejects(h.registry.interact('s', { observationId: first.observationId, ref: 'e1', action: 'focus' }, h.contents, h.send, async () => {}),
    { code: 'observation_stale' });
  const failing = harness(request => request.kind === 'observe' ? { error: 'page_evaluation_failed' } : undefined);
  t.after(() => failing.registry.dispose());
  const failed = await failing.registry.observeAfterAction('s', {}, failing.contents, failing.send, async () => {});
  assert.equal(failed.observationError.code, 'page_evaluation_failed');
});

function chromeExecutable() {
  if (process.env.BROWSER_USE_TEST_CHROME) return process.env.BROWSER_USE_TEST_CHROME;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`;
  return '/usr/bin/google-chrome';
}
const executablePath = chromeExecutable();
const chromeAvailable = fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile();

test('real page: selector targets, multiple select, check state and viewport-only observation', { skip: !chromeAvailable }, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<button id="top">Top</button>
    <select id="tags" multiple aria-label="Tags"><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></select>
    <input type="checkbox" id="agree" aria-label="Agree"><input type="radio" name="r" id="radio" aria-label="Radio" checked>
    <div style="height:3000px"></div><button id="bottom">Bottom</button><button class="dup">1</button><button class="dup">2</button>`);
  const run = (request) => page.evaluate(expression => (0, eval)(expression), observationExpression('__test_key', { observationId: 'o1', ...request }));

  const full = await run({ kind: 'observe', maxTextLength: 2000, maxElements: 50 });
  assert.ok(full.elements.some(element => element.name === 'Bottom'));
  const visible = await run({ kind: 'observe', maxTextLength: 2000, maxElements: 50, viewportOnly: true });
  assert.equal(visible.viewportOnly, true);
  assert.ok(visible.elements.some(element => element.name === 'Top'));
  assert.ok(!visible.elements.some(element => element.name === 'Bottom'), 'off-screen controls are filtered');

  assert.deepEqual(await run({ kind: 'select', selector: '#tags', values: ['a', 'b'] }), { matched: true });
  assert.deepEqual(await page.$eval('#tags', select => [...select.selectedOptions].map(option => option.value)), ['a', 'b']);
  assert.deepEqual(await run({ kind: 'select', selector: '#tags', values: ['c'] }), { error: 'option_not_found' });
  assert.deepEqual(await run({ kind: 'check-state', selector: '#agree' }), { checked: false, radio: false });
  assert.deepEqual(await run({ kind: 'check-state', selector: '#radio' }), { checked: true, radio: true });
  assert.deepEqual(await run({ kind: 'check-state', selector: '#top' }), { error: 'element_not_checkable' });
  assert.deepEqual(await run({ kind: 'focus', selector: '.dup' }), { error: 'ambiguous_selector' });
  assert.deepEqual(await run({ kind: 'focus', selector: '#missing' }), { error: 'element_not_found' });
  assert.deepEqual(await run({ kind: 'focus', selector: '[[' }), { error: 'invalid_selector' });
  const located = await run({ kind: 'locate', selector: '#bottom' });
  assert.equal(located.matched, true);
  assert.ok(located.y >= 0 && located.y < 600, 'locate scrolls the selector target into view');
});
