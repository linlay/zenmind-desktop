import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SurfaceObservationRegistry } = require('../dist-electron/main/modules/web-surfaces/cdp/observation.js');
const { validateDesktopCdpParams } = require('../dist-electron/main/modules/web-surfaces/cdp/params.js');
const { EmbeddedCdpGateway, createEmbeddedWebSurfaceId } = require('../dist-electron/main/modules/web-surfaces/cdp/gateway.js');

function harness(onProbe = () => {}) {
  const contents = new EventEmitter();
  Object.assign(contents, { id: 601, isDestroyed: () => false, getURL: () => 'https://fixture.test/', getTitle: () => 'Fixture' });
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') {
      const [, request] = JSON.parse('[' + params.expression.slice(params.expression.lastIndexOf('})(') + 3, -1) + ']');
      const override = await onProbe(request, contents);
      return { result: { value: override ?? (request.kind === 'observe' ? {
        observationId: request.observationId, url: contents.getURL(), title: 'Fixture', text: 'Visible text',
        elements: [{ ref: 'e1', role: 'button', name: 'Submit', tag: 'button' }], truncated: false,
      } : { x: 10.25, y: 20.75, matched: true, prepared: true, domFocused: true, documentFocused: true,
        topDocumentFocused: true, targetIsMainDocument: true, valueMatched: request.kind === 'verify-fill' }) } };
    }
    return {};
  };
  let attached = false;
  contents.debugger = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; contents.debugger.emit('detach', {}, 'canceled_by_user'); },
    sendCommand: send,
  });
  return { contents, send, calls, registry: new SurfaceObservationRegistry() };
}

test('observation/ref contracts reject invalid limits, coercions and selectors before execution', () => {
  for (const params of [undefined, {}, { maxTextLength: 30_000, maxElements: 500 }]) validateDesktopCdpParams('Surface.observe', params);
  validateDesktopCdpParams('Surface.click', { observationId: 'o', ref: 'e1', waitFor: { state: 'url', value: 'https://fixture.test/' } });
  for (const action of ['fill', 'select']) validateDesktopCdpParams('Surface.interact', { observationId: 'o', ref: 'e1', action, value: '' });
  for (const [method, params] of [
    ['Surface.observe', { maxElements: '10' }], ['Surface.observe', { maxElements: 501 }],
    ['Surface.observe', { maxTextLength: 0 }], ['Surface.observe', { maxTextLength: 30_001 }],
    ['Surface.click', { observationId: 'o', ref: 'e1', selector: '#submit' }],
    ['Surface.click', { observationId: '', ref: 'e1' }], ['Surface.click', { observationId: 'o', ref: 'e1', timeoutMs: true }],
    ['Surface.interact', { observationId: 'o', ref: 'e1', action: 'fill' }],
    ['Surface.interact', { observationId: 'o', ref: 'e1', action: 'focus', value: 'secret-value' }],
  ]) assert.throws(() => validateDesktopCdpParams(method, params), { code: 'invalid_args' });
  assert.throws(() => validateDesktopCdpParams('Surface.interact', { observationId: 'o', ref: 'e1', action: 'fill', value: 'secret-value'.repeat(4000) }),
    (error) => !error.message.includes('secret-value'));
});

test('new observations replace earlier refs and evaluate only in the host isolated world', async (t) => {
  const h = harness(); t.after(() => h.registry.dispose());
  const first = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  const second = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  assert.notEqual(first.observationId, second.observationId);
  await assert.rejects(h.registry.interact('surface-a', { observationId: first.observationId, ref: 'e1', action: 'focus' }, h.contents, h.send, async () => {}), { code: 'observation_stale' });
  const before = h.calls.length;
  await assert.rejects(h.registry.interact('surface-b', { observationId: second.observationId, ref: 'e1', action: 'focus' }, h.contents, h.send, async () => {}), { code: 'observation_stale' });
  assert.equal(h.calls.length, before);
  assert.ok(h.calls.filter((call) => call.method === 'Runtime.evaluate').every((call) => call.params.contextId === 42));
  assert.ok(h.calls.filter((call) => call.method === 'Page.createIsolatedWorld').every((call) => call.params.grantUniveralAccess === false));
});

test('navigation, unexpected detach and guest replacement invalidate refs without input', async (t) => {
  for (const invalidation of ['did-start-navigation', 'did-navigate-in-page', 'detach', 'replaced']) {
    const h = harness(); t.after(() => h.registry.dispose());
    const observed = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
    if (invalidation === 'detach') h.contents.debugger.emit('detach', {}, 'target_closed');
    else if (invalidation !== 'replaced') h.contents.emit(invalidation);
    const target = invalidation === 'replaced' ? harness().contents : h.contents;
    await assert.rejects(h.registry.click('surface-a', { observationId: observed.observationId, ref: 'e1' }, target, h.send, async () => {}), { code: 'observation_stale' });
    assert.equal(h.calls.filter((call) => call.method.startsWith('Input.')).length, 0);
  }
});

test('cancellation after preparing fill sends no editing event', async (t) => {
  const controller = new AbortController();
  const h = harness((request) => { if (request.kind === 'fill') controller.abort(); });
  t.after(() => h.registry.dispose());
  const observed = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  await assert.rejects(h.registry.interact('surface-a', { observationId: observed.observationId, ref: 'e1', action: 'fill', value: 'new text' }, h.contents, h.send, async () => {}, controller.signal), { code: 'canceled' });
  assert.equal(h.calls.filter((call) => call.method.startsWith('Input.')).length, 0);
});

test('ref click reuses the existing press/release cleanup when canceled', async (t) => {
  const controller = new AbortController();
  const h = harness(); t.after(() => h.registry.dispose());
  const observed = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  const send = async (method, params, timeout) => {
    const result = await h.send(method, params, timeout);
    if (params.type === 'mousePressed') controller.abort();
    return result;
  };
  const result = await h.registry.click('surface-a', { observationId: observed.observationId, ref: 'e1' }, h.contents, send, async () => {}, controller.signal);
  assert.equal(result.status, 'canceled');
  assert.equal(result.action.released, true);
  assert.deepEqual(h.calls.filter((call) => call.method.startsWith('Input.')).map((call) => call.params.type), ['mousePressed', 'mouseReleased']);
});

test('gateway keeps observation refs across its owned detach and enforces Chat ownership', async (t) => {
  const h = harness();
  const tab = { tabId: 'item', currentUrl: h.contents.getURL(), title: 'Fixture', webContentsId: h.contents.id };
  const container = { id: 'panel', targetGeneration: 'registration', surfaceKind: 'chat-work-panel', surfaceRole: 'workpanel-web',
    ownerChatId: 'chat-a', label: 'Fixture', url: h.contents.getURL(), open: true, active: false, tabs: [tab], activeTabId: tab.tabId };
  const gateway = new EmbeddedCdpGateway({ getSurfaces: () => [container], resolveWebContents: () => h.contents,
    logger: { debug() {}, warn() {} } });
  t.after(() => gateway.stop());
  const surfaceId = createEmbeddedWebSurfaceId(container, tab);
  const request = { surfaceId, source: { chatId: 'chat-a' } };
  const observation = (await gateway.executeCommand({ ...request, method: 'Surface.observe' })).result;
  const clicked = (await gateway.executeCommand({ ...request, method: 'Surface.click', params: { observationId: observation.observationId, ref: 'e1' } })).result;
  assert.equal(clicked.status, 'clicked');
  const before = h.calls.length;
  await assert.rejects(gateway.executeCommand({ ...request, source: { chatId: 'chat-b' }, method: 'Surface.observe' }), { code: 'target_not_owned_by_chat' });
  assert.equal(h.calls.length, before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gateway.executeCommand({ ...request, method: 'Surface.interact', params: { observationId: observation.observationId, ref: 'e1', action: 'focus' } }, undefined, controller.signal), /canceled/u);
  assert.equal(h.calls.length, before);
});

test('WorkPanel viewport changes and resets invalidate the earlier observation before more input', async (t) => {
  const h = harness();
  const emulations = [];
  h.contents.enableDeviceEmulation = params => emulations.push(params);
  h.contents.disableDeviceEmulation = () => emulations.push('reset');
  const tab = { tabId: 'item', currentUrl: h.contents.getURL(), title: 'Fixture', webContentsId: h.contents.id };
  const container = { id: 'panel', targetGeneration: 'registration', surfaceKind: 'chat-work-panel', surfaceRole: 'workpanel-web',
    ownerChatId: 'chat-a', label: 'Fixture', url: h.contents.getURL(), open: true, active: false, tabs: [tab], activeTabId: tab.tabId };
  const gateway = new EmbeddedCdpGateway({ getSurfaces: () => [container], resolveWebContents: () => h.contents,
    logger: { debug() {}, warn() {} } });
  t.after(() => gateway.stop());
  const request = { surfaceId: createEmbeddedWebSurfaceId(container, tab), source: { chatId: 'chat-a' } };
  for (const params of [{ width: 390, height: 844, mobile: true }, { reset: true }]) {
    const observation = (await gateway.executeCommand({ ...request, method: 'Surface.observe' })).result;
    await gateway.executeCommand({ ...request, method: 'Surface.setViewport', params });
    const before = h.calls.filter(call => call.method.startsWith('Input.')).length;
    await assert.rejects(gateway.executeCommand({ ...request, method: 'Surface.click', params: { observationId: observation.observationId, ref: 'e1' } }), { code: 'observation_stale' });
    assert.equal(h.calls.filter(call => call.method.startsWith('Input.')).length, before);
  }
  assert.equal(emulations[0].screenPosition, 'mobile');
  assert.deepEqual(emulations[0].viewSize, { width: 390, height: 844 });
  assert.equal(emulations[1], 'reset');
});

test('WorkPanel semantic commands preserve the saved-password automation hold', async (t) => {
  const { holdPageAutomation } = require('../dist-electron/main/modules/web-surfaces/cdp/command-queue.js');
  const h = harness();
  h.contents.id = 605;
  const tab = { tabId: 'held-item', currentUrl: h.contents.getURL(), title: 'Fixture', webContentsId: h.contents.id };
  const container = { id: 'held-panel', targetGeneration: 'registration', surfaceKind: 'chat-work-panel', surfaceRole: 'workpanel-web',
    ownerChatId: 'chat-a', label: 'Fixture', url: h.contents.getURL(), open: true, active: false, tabs: [tab], activeTabId: tab.tabId };
  const gateway = new EmbeddedCdpGateway({ getSurfaces: () => [container], resolveWebContents: () => h.contents,
    logger: { debug() {}, warn() {} } });
  t.after(() => gateway.stop());
  const surfaceId = createEmbeddedWebSurfaceId(container, tab);
  const release = holdPageAutomation(h.contents.id);
  try {
    for (const [method, params] of [
      ['Surface.observe', {}],
      ['Surface.click', { observationId: 'before-password-fill', ref: 'e1' }],
      ['Surface.interact', { observationId: 'before-password-fill', ref: 'e1', action: 'fill', value: 'must not execute' }],
    ]) {
      await assert.rejects(gateway.executeCommand({ method, params, surfaceId, source: { chatId: 'chat-a' } }), { code: 'credential_fill_in_progress' });
    }
    assert.equal(h.calls.length, 0, 'the credential hold rejects before attaching or reading the page');
  } finally { release(); }
  assert.equal((await gateway.executeCommand({ method: 'Surface.observe', surfaceId, source: { chatId: 'chat-a' } })).result.provider, 'workpanel');
});

test('fill diagnostics expose fixed booleans without field contents or native frame identities', async t => {
  const h = harness(); t.after(() => h.registry.dispose());
  const frame = { processId: 123, routingId: 456 };
  Object.assign(h.contents, { mainFrame: frame, focusedFrame: frame, isFocused: () => true,
    hostWebContents: { focusedFrame: frame, isFocused: () => false } });
  const observation = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  const diagnostics = [];
  await h.registry.interact('surface-a', { observationId: observation.observationId, ref: 'e1', action: 'fill', value: 'PRIVATE-FIELD-VALUE' },
    h.contents, h.send, async () => {}, undefined, (phase, evidence) => diagnostics.push({ phase, evidence }));
  assert.deepEqual(diagnostics.map(item => item.phase), ['before_input', 'after_input']);
  assert.ok(diagnostics.every(item => Object.values(item.evidence).every(value => typeof value === 'boolean')));
  assert.equal(diagnostics[0].evidence.nativeGuestFocused, true);
  assert.equal(diagnostics[0].evidence.valueMatched, false);
  assert.equal(diagnostics[1].evidence.valueMatched, true);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE-FIELD-VALUE'), false);
  assert.equal(JSON.stringify(diagnostics).includes('123'), false);
  assert.equal(JSON.stringify(diagnostics).includes('456'), false);
});

test('observed guests can be destroyed before registry cleanup without accessing destroyed native getters', async () => {
  const h = harness();
  const debuggerRef = h.contents.debugger;
  let destroyed = false;
  Object.defineProperty(h.contents, 'debugger', { get() {
    if (destroyed) throw new Error('Object has been destroyed');
    return debuggerRef;
  } });
  h.contents.isDestroyed = () => destroyed;
  const observation = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  destroyed = true;
  assert.doesNotThrow(() => h.contents.emit('destroyed'));
  assert.doesNotThrow(() => h.registry.dispose());
  assert.doesNotThrow(() => h.registry.dispose());
  assert.equal(debuggerRef.listenerCount('detach'), 0);
  assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(h.contents.listenerCount('render-process-gone'), 0);
  await assert.rejects(h.registry.interact('surface-a', { observationId: observation.observationId, ref: 'e1', action: 'focus' },
    h.contents, h.send, async () => {}), { code: 'observation_stale' });
});

test('native listener cleanup errors cannot interrupt idempotent observation release', async () => {
  const h = harness();
  const observation = await h.registry.observe('surface-a', {}, h.contents, h.send, async () => {});
  h.contents.debugger.off = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => h.registry.dispose());
  assert.doesNotThrow(() => h.registry.dispose());
  await assert.rejects(h.registry.click('surface-a', { observationId: observation.observationId, ref: 'e1' },
    h.contents, h.send, async () => {}), { code: 'observation_stale' });
});
