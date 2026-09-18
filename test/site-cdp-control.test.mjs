import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
const { EmbeddedCdpGateway, createEmbeddedCdpTargetId } = require('../dist-electron/main/modules/web-surfaces/cdp/gateway.js');
const { createCdpIntegration } = require('../dist-electron/main/modules/web-surfaces/cdp/integration.js');
const { RunSiteControlGrants } = require('../dist-electron/main/modules/agent-platform/realtime/run-site-control-grants.js');
const { withSiteCdpFocus } = require('../dist-electron/main/modules/web-surfaces/cdp/site-focus.js');
const { AwcpGuestBridge } = require('../dist-electron/main/modules/web-surfaces/awcp/guest-bridge.js');
const { compileAwcpSchema } = require('../dist-electron/main/modules/web-surfaces/awcp/schema-validator.js');

test('AWCP type diagnostics identify the rejected node without exposing its value', () => {
  const validate = compileAwcpSchema({
    type: 'object', properties: {
      value: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object' } } } },
      'a/b~c': { type: 'array', items: { type: 'string' } },
    },
  });
  assert.deepEqual(validate({ value: { nodes: { item: [{ secret: 'private' }] } } }), [{
    instancePath: '/value/nodes', keyword: 'type', expectedType: 'array', actualType: 'object',
  }]);
  assert.deepEqual(validate({ 'a/b~c': [null] }), [{
    instancePath: '/a~1b~0c/0', keyword: 'type', expectedType: 'string', actualType: 'null',
  }]);
  assert.deepEqual(validate({ value: { nodes: [{}] } }), []);
});

test('AWCP anyOf diagnostics select the actual typed condition branch', () => {
  const validate = compileAwcpSchema({
    type: 'object', required: ['value'], properties: { value: { $ref: '#/$defs/condition' } }, additionalProperties: false,
    $defs: { condition: {
      type: 'object', anyOf: [
        { type: 'object', properties: { join: { type: 'string', enum: ['and', 'or'] }, nodes: { type: 'array', minItems: 1, items: { $ref: '#/$defs/condition' } } }, required: ['join', 'nodes'], additionalProperties: false },
        { type: 'object', properties: { field: { type: 'string', enum: ['supplier'] }, oper: { type: 'string', enum: ['eq'] }, stringValue: { type: 'string' } }, required: ['field', 'oper', 'stringValue'], additionalProperties: false },
        { type: 'object', properties: { field: { type: 'string', enum: ['amount'] }, oper: { type: 'string', enum: ['gt'] }, numberValue: { type: 'number' } }, required: ['field', 'oper', 'numberValue'], additionalProperties: false },
      ],
    } },
  });
  assert.deepEqual(validate({ value: { field: 'amount', oper: 'gt', numberValue: '10' } }), [{
    instancePath: '/value/numberValue', keyword: 'type', expectedType: 'number', actualType: 'string',
  }]);
  const unknownField = validate({ value: { field: 'unknown', oper: 'gt', numberValue: 10 } });
  assert.ok(unknownField.length > 0 && unknownField.every((error) => error.instancePath === '/value/field'));
  const unknownOper = validate({ value: { field: 'amount', oper: 'unknown', numberValue: 10 } });
  assert.ok(unknownOper.length > 0 && unknownOper.every((error) => error.instancePath === '/value/oper'));
  const withFunc = compileAwcpSchema({
    type: 'object', properties: { value: { $ref: '#/$defs/condition' } },
    $defs: { condition: { type: 'object', anyOf: [
      { type: 'object', properties: { field: { const: 'amount' }, oper: { const: 'gt' }, numberValue: { type: 'number' } }, required: ['field', 'oper', 'numberValue'], additionalProperties: false },
      { type: 'object', properties: { field: { const: 'amount' }, func: { const: 'count' }, oper: { const: 'gt' }, numberValue: { type: 'number' } }, required: ['field', 'func', 'oper', 'numberValue'], additionalProperties: false },
    ] } },
  });
  assert.deepEqual(withFunc({ value: { field: 'amount', func: 'count', oper: 'gt', numberValue: '10' } }), [{
    instancePath: '/value/numberValue', keyword: 'type', expectedType: 'number', actualType: 'string',
  }]);
  const unknownFunc = withFunc({ value: { field: 'amount', func: 'unknown', oper: 'gt', numberValue: 10 } });
  assert.ok(unknownFunc.length > 0 && unknownFunc.every((error) => error.instancePath === '/value/func'));
});

test('AWCP discovery rejects an invalid unused Action atomically and never runs a handler', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-atomic'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let handlerCalls = 0;
  let badAction = { action: 'orders.write', description: 'Write', inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } }, example: {} };
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return { revision: 'revision-a', actions: [awcpSnapshot().actions[0], badAction] };
    handlerCalls++;
    return null;
  };
  await assert.rejects(bridge.snapshot('bad-ref', scope), (error) => error.code === 'awcp_invalid_contract' &&
    error.details?.action === 'orders.write' && error.details?.keyword === '$ref');
  badAction = { action: 'orders.write', description: 'Write', inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }, example: {} };
  await assert.rejects(bridge.snapshot('bad-example', scope), (error) => error.code === 'awcp_invalid_contract' &&
    error.details?.action === 'orders.write' && error.details?.violations?.some((v) => v.keyword === 'required'));
  badAction = { action: 'orders.write', description: 'Write', inputSchema: { type: 'object' } };
  await assert.rejects(bridge.snapshot('missing-example', scope), { code: 'awcp_invalid_contract' });
  assert.equal(handlerCalls, 0);
  await assert.rejects(bridge.invoke('no-partial', { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'discovery_required');
});

function gatewayFor(h, extra = {}) {
  return new EmbeddedCdpGateway({ getSurfaces: () => h.registry.listRegisteredSurfaces(),
    resolveWebContents: (_surface, tab) => h.contents.get(tab.webContentsId), logger: { debug() {}, warn() {} }, ...extra });
}
const identity = { runId: 'run-a', chatId: 'chat-a', owner: { kind: 'agent', agentKey: 'agent-a' } };
const source = { runId: 'run-a', chatId: 'chat-a', agentKey: 'agent-a' };

function awcpSnapshot(action = 'orders.read', inputSchema = { type: 'object' }, outputSchema, example = {}) {
  return {
    revision: 'revision-a',
    actions: [{
      action,
      description: `Invoke ${action}`,
      inputSchema,
      example,
      ...(outputSchema === undefined ? {} : { outputSchema }),
    }],
  };
}

test('independent Website Runs keep distinct target queries and reject each other', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
  const grants = new RunSiteControlGrants(); t.after(() => grants.revokeAll());
  grants.bind(identity, h.capture(a));
  grants.bind({ runId: 'run-b', chatId: 'chat-b', owner: { kind: 'team', teamId: 'team-b' } }, h.capture(b));
  const aScope = grants.resolve(source);
  const bScope = grants.resolve({ runId: 'run-b', chatId: 'chat-b', teamId: 'team-b' });
  const gateway = gatewayFor(h);
  const [at, bt] = await Promise.all([aScope, bScope].map((scope) => gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope)));
  assert.notEqual(at.targetId, bt.targetId);
  assert.equal(at.surfaceId, a.surfaceId); assert.equal(bt.surfaceId, b.surfaceId);
  await assert.rejects(gateway.executeCommand({ method: 'Runtime.evaluate', targetId: at.targetId }, bScope), { code: 'target_not_in_current_surface' });
});

test('background command focus transactions serialize, restore on errors, and revalidate queued grants', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a); scope.activate(); t.after(() => scope.release());
  const calls = [];
  let unblock; const gate = new Promise((resolve) => { unblock = resolve; });
  const first = withSiteCdpFocus(scope, async (phase) => { calls.push('first:' + phase); }, async () => { calls.push('first:command'); await gate; throw new Error('command failed'); });
  const rejected = assert.rejects(first, /command failed/);
  const second = withSiteCdpFocus(scope, async (phase) => { calls.push('second:' + phase); }, async () => { calls.push('second:command'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['first:capture', 'first:command']);
  unblock(); await rejected; await second;
  assert.deepEqual(calls, ['first:capture', 'first:command', 'first:restore', 'second:capture', 'second:command', 'second:restore']);
  await assert.rejects(withSiteCdpFocus(scope, async (phase) => { if (phase === 'capture') scope.release(); calls.push('revoked:' + phase); }, async () => assert.fail('revoked command executed')), { code: 'site_control_unavailable' });
  assert.equal(calls.at(-1), 'revoked:restore');
});

test('authorized background Website discovers new and descendant tabs without changing public current', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
  const scope = h.capture(a); scope.activate(); t.after(() => scope.release());
  const gateway = gatewayFor(h);
  h.foreground(b);
  const first = await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope);
  assert.equal(first.surfaceId, a.surfaceId);
  for (let n = 0; n < 2; n++) {
    const added = h.addTab(a);
    assert.equal(h.contents.get(added.webContentsId).throttle, false);
    const targets = await gateway.executeCommand({ method: 'Target.getTargets' }, scope);
    assert.equal(targets.result.targetInfos.length, n + 2);
    const targetId = targets.result.currentTargetId;
    await gateway.executeCommand({ method: 'Runtime.evaluate', targetId, params: { expression: 'document.title' } }, scope);
    assert.equal(h.commands.at(-1).id, added.webContentsId);
    assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' })).surfaceId, b.surfaceId);
  }
  await assert.rejects(gateway.executeCommand({ method: 'Runtime.evaluate', targetId: first.targetId }), { code: 'target_not_in_current_surface' });
  const bTarget = (await gateway.executeCommand({ method: 'Target.getCurrentTarget' })).targetId;
  await assert.rejects(gateway.executeCommand({ method: 'Runtime.evaluate', targetId: bTarget }, scope), { code: 'target_not_in_current_surface' });
});

test('scope identity cannot be forged, reattached to another application, or resurrected after close', async () => {
  const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
  const grants = new RunSiteControlGrants(); const scope = h.capture(a); grants.bind(identity, scope);
  const gateway = gatewayFor(h);
  const target = (await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, grants.resolve(source))).targetId;
  h.foreground(b);
  await assert.rejects(gateway.executeCommand({ method: 'Target.getTargets' }, { ...scope }), { code: 'site_control_unavailable' });
  assert.throws(() => grants.resolve({ ...source, chatId: 'wrong' }), { code: 'site_control_unavailable' });
  assert.throws(() => grants.resolve({ ...source, agentKey: 'wrong' }), { code: 'site_control_unavailable' });
  assert.throws(() => grants.resolve({ ...source, teamId: 'wrong' }), { code: 'site_control_unavailable' });
  h.closeTab(a, a.activeTabId);
  a.registrationId = 'reopened-a'; a.tabs = [h.tab(h.guest(a.url))]; a.activeTabId = a.tabs[0].tabId; h.register(a);
  assert.throws(() => grants.resolve(source), { code: 'site_control_unavailable' });
  await assert.rejects(gateway.executeCommand({ method: 'Runtime.evaluate', targetId: target }, scope), { code: 'site_control_unavailable' });
  const replacement = h.capture(a);
  assert.throws(() => grants.bind(identity, replacement), { code: 'site_control_unavailable' });
  grants.revokeAll();
});

test('background throttle leases are reference counted and restore original state on terminal or crash', () => {
  const h = createSiteHarness(); const a = h.site('a'); const guest = h.contents.get(a.tabs[0].webContentsId);
  const first = h.capture(a); first.activate(); const second = h.capture(a); second.activate();
  assert.deepEqual(guest.throttleChanges, [false]);
  first.release(); assert.equal(guest.throttle, false);
  second.release(); assert.equal(guest.throttle, true);
  guest.throttle = false;
  const third = h.capture(a); third.activate(); third.release(); assert.equal(guest.throttle, false);
  const fourth = h.capture(a); fourth.activate(); guest.emit('render-process-gone');
  assert.throws(() => fourth.readSurface(), { code: 'site_control_unavailable' });
  assert.equal(guest.listenerCount('destroyed'), 0);
});

test('WebApp keeps one guest across WorkPanel presentation and revokes when guest changes', async () => {
  const h = createSiteHarness(); const app = h.site('app', 'webapp'); const b = h.site('b');
  const scope = h.capture(app); scope.activate(); const gateway = gatewayFor(h);
  const target = await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope);
  h.foreground(b); app.presentationScope = 'workpanel'; app.ownerChatId = 'workpanel-chat'; h.register(app);
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope)).targetId, target.targetId);
  await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: target.targetId, params: { expression: 'document.title' } }, scope);
  delete app.presentationScope; delete app.ownerChatId; h.register(app);
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope)).targetId, target.targetId);
  app.tabs = [h.tab(h.guest(app.url))]; app.activeTabId = app.tabs[0].tabId; h.register(app);
  await assert.rejects(gateway.executeCommand({ method: 'Target.getTargets' }, scope), { code: 'site_control_unavailable' });
});

test('tab host controls carry exact guest generation and do not route WebApp tabs as WorkPanel items', async (t) => {
  const h = createSiteHarness(); const app = h.site('app', 'webapp'); const b = h.site('b');
  const scope = h.capture(app); scope.activate(); t.after(() => scope.release());
  h.foreground(b); app.presentationScope = 'workpanel'; app.ownerChatId = 'other-chat'; h.register(app);
  const calls = [];
  const integration = createCdpIntegration({ browserSurfaces: h.registry, getCurrentPageSnapshot: () => null,
    listServices: () => [], isLoopbackUrl: () => true, version: 'test',
    switchTab: async (...args) => { calls.push(['switch', ...args]); },
    closeTab: async (...args) => { calls.push(['close', ...args]); },
  });
  await integration.closeTarget(scope.readSurface(), app.tabs[0], scope);
  assert.deepEqual(calls[0], ['close', app.surfaceId, app.tabs[0].tabId, undefined,
    { registrationId: app.registrationId, webContentsId: app.tabs[0].webContentsId }]);
  const a = h.site('a'); const aScope = h.capture(a); aScope.activate(); t.after(() => aScope.release());
  const beforePopup = aScope.readSurface();
  const old = a.tabs[0]; h.addTab(a); h.foreground(b);
  await integration.activateTarget(beforePopup, old, aScope);
  assert.equal(calls.at(-1)[0], 'switch');
  const gateway = gatewayFor(h, { activateTarget: integration.activateTarget, closeTarget: integration.closeTarget });
  await gateway.executeCommand({ method: 'Page.bringToFront', targetId: createEmbeddedCdpTargetId(aScope.readSurface(), old) }, aScope);
  assert.equal(calls.at(-1)[0], 'switch'); assert.equal(calls.at(-1)[3], undefined);
});

test('scope expires when closed before Run acceptance and revoked grants never fall back to current', () => {
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a);
  h.closeTab(a, a.activeTabId);
  const grants = new RunSiteControlGrants(); grants.bind(identity, scope);
  assert.throws(() => grants.resolve(source), { code: 'site_control_unavailable' });
  grants.revoke(identity.runId);
  assert.throws(() => grants.resolve(source), { code: 'site_control_unavailable' });
});

test('AWCP snapshot reads and validates the current Registry without invoking an Action', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-snapshot'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const scripts = [];
  guest.executeJavaScript = async (script) => {
    scripts.push(script);
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return awcpSnapshot();
    return assert.fail('snapshot request invoked an Action');
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const result = await bridge.snapshot('snapshot-a', scope);
  assert.deepEqual(result, {
    ok: true,
    method: 'AWCP.getSnapshot',
    revision: 'revision-a',
    actions: awcpSnapshot().actions,
  });
  assert.equal(scripts.some((script) => script.includes('globalThis.awcp.invoke')), false);
});

test('AWCP discovery is bound to a Run and exact guest, not matching page revisions', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-binding');
  const scope = h.capture(a); scope.activate();
  const otherRun = h.capture(a); otherRun.activate();
  const bridge = new AwcpGuestBridge(h.registry);
  t.after(() => { bridge.dispose(); scope.release(); otherRun.release(); });
  const scripts = [];
  const originalTab = a.tabs[0];
  const originalGuest = h.contents.get(originalTab.webContentsId);
  originalGuest.executeJavaScript = async (script) => {
    scripts.push(script);
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return awcpSnapshot();
    return { ok: true, requestId: 'original-invoke', action: 'orders.read', result: {} };
  };
  const payload = { revision: 'revision-a', action: 'orders.read', args: {} };
  const rejects = (reason) => (error) => error.code === 'awcp_preflight_rejected' &&
    error.details.reason === reason && error.details.stage === 'desktop_preflight' && error.details.executionStarted === false;
  await assert.rejects(bridge.invoke('undiscovered', payload, scope), rejects('discovery_required'));
  assert.equal(scripts.length, 0);
  await bridge.snapshot('discover-original', scope);
  await assert.rejects(bridge.invoke('other-run', payload, otherRun), rejects('discovery_required'));
  assert.equal(scripts.length, 2);
  const secondTab = h.addTab(a);
  const secondGuest = h.contents.get(secondTab.webContentsId);
  let secondCalls = 0;
  secondGuest.executeJavaScript = async (script) => {
    secondCalls++;
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return awcpSnapshot(); // deliberately identical revision and Action
    return { ok: true, requestId: 'second-invoke', action: 'orders.read', result: {} };
  };
  await assert.rejects(bridge.invoke('wrong-page', payload, scope), rejects('page_changed'));
  assert.equal(secondCalls, 0);
  a.activeTabId = originalTab.tabId; h.register(a);
  assert.equal((await bridge.invoke('original-invoke', payload, scope)).ok, true);
  a.activeTabId = secondTab.tabId; h.register(a);
  await bridge.snapshot('discover-second', scope);
  assert.equal((await bridge.invoke('second-invoke', payload, scope)).ok, true);
});

test('AWCP refresh and main-frame in-page navigation invalidate discovery even with an unchanged revision', async (t) => {
  for (const event of ['did-start-navigation', 'did-navigate-in-page']) {
    const h = createSiteHarness(); const a = h.site('awcp-navigation'); const scope = h.capture(a); scope.activate();
    const guest = h.contents.get(a.tabs[0].webContentsId);
    let invokes = 0;
    guest.executeJavaScript = async (script) => {
      if (script.includes('protocolVersion')) return 1;
      if (script.includes('.snapshot()')) return awcpSnapshot();
      invokes++;
      return { ok: true, requestId: 'after-rediscovery', action: 'orders.read', result: {} };
    };
    const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
    await bridge.snapshot('before-navigation', scope);
    assert.ok(bridge.discoveries.contract(scope));
    guest.emit(event, {}, 'https://awcp-navigation.example/new', ...(event === 'did-start-navigation' ? [false, true] : [true]));
    assert.equal(bridge.discoveries.contract(scope), undefined);
    const payload = { revision: 'revision-a', action: 'orders.read', args: {} };
    await assert.rejects(bridge.invoke('stale-page', payload, scope),
      (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'page_changed');
    assert.equal(invokes, 0);
    await bridge.snapshot('after-navigation', scope);
    assert.equal((await bridge.invoke('after-rediscovery', payload, scope)).ok, true);
    assert.equal(invokes, 1);
  }
});

test('AWCP discovery listeners are bounded and released with the scope or bridge', async () => {
  for (const cleanup of ['scope', 'bridge']) {
    const h = createSiteHarness(); const a = h.site('awcp-cleanup'); const scope = h.capture(a); scope.activate();
    const guest = h.contents.get(a.tabs[0].webContentsId);
    guest.executeJavaScript = async (script) => script.includes('protocolVersion') ? 1 : awcpSnapshot();
    const bridge = new AwcpGuestBridge(h.registry);
    try {
      for (let i = 0; i < 12; i++) await bridge.snapshot(`discovery-${i}`, scope);
      assert.equal(guest.listenerCount('did-start-navigation'), 1);
      assert.equal(guest.listenerCount('did-navigate-in-page'), 1);
      if (cleanup === 'scope') scope.release(); else bridge.dispose();
      assert.equal(guest.listenerCount('did-start-navigation'), 0);
      assert.equal(guest.listenerCount('did-navigate-in-page'), 0);
      assert.equal(guest.listenerCount('destroyed'), cleanup === 'scope' ? 0 : 1);
      assert.equal(guest.listenerCount('render-process-gone'), cleanup === 'scope' ? 0 : 1);
    } finally { bridge.dispose(); scope.release(); }
  }
});

test('AWCP already-aborted calls never discover or invoke page Actions', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-aborted'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  guest.executeJavaScript = async (script) => {
    if (script.includes('.cancel(')) return true;
    assert.fail('aborted call executed a page script');
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.snapshot('aborted-snapshot', scope, controller.signal), { code: 'awcp_cancelled' });
  await assert.rejects(bridge.invoke('aborted-invoke', { revision: 'revision-a', action: 'orders.read', args: {} }, scope, controller.signal), { code: 'awcp_cancelled' });
});

test('AWCP captures one active guest and cancel never drifts to a newly active tab', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a); scope.activate();
  const firstGuest = h.contents.get(a.tabs[0].webContentsId);
  const scripts = [];
  let holdInvoke;
  firstGuest.executeJavaScript = (script) => {
    scripts.push(script);
    if (script.includes('protocolVersion')) return Promise.resolve(1);
    if (script.includes('.snapshot()')) return Promise.resolve(awcpSnapshot());
    if (script.includes('.cancel(')) return Promise.resolve(true);
    return new Promise((resolve) => { holdInvoke = resolve; });
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  await bridge.snapshot('discover-cancel', scope);
  const pending = bridge.invoke('request-a', { revision: 'revision-a', action: 'orders.read', args: { value: "');throw new Error('unsafe')//" } }, scope);
  await new Promise((resolve) => setImmediate(resolve));
  const secondTab = h.addTab(a);
  const secondGuest = h.contents.get(secondTab.webContentsId);
  secondGuest.executeJavaScript = () => assert.fail('cancel drifted to the newly active tab');
  assert.equal(bridge.cancel('request-a'), true);
  await assert.rejects(pending, { code: 'awcp_cancelled' });
  assert.ok(scripts.some((script) => script.includes('globalThis.awcp.invoke')));
  assert.ok(scripts.some((script) => script.includes('globalThis.awcp?.cancel')));
  holdInvoke?.({ ok: true, requestId: 'request-a', action: 'orders.read', result: null });
  assert.equal(bridge.cancel('request-a'), false);
});

test('AWCP preserves business failures and rejects protocol, correlation, and payload violations', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let protocolVersion = 1;
  let response = { ok: false, requestId: 'request-a', action: 'orders.read', error: { code: 'stale_snapshot', message: 'stale' } };
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return protocolVersion;
    if (script.includes('.snapshot()')) return awcpSnapshot();
    return response;
  };

  await bridge.snapshot('discover-business', scope);
  assert.deepEqual(await bridge.invoke('request-a', { revision: 'revision-a', action: 'orders.read', args: {} }, scope), response);
  response = { ok: true, requestId: 'wrong', action: 'orders.read', result: null };
  await assert.rejects(bridge.invoke('request-b', { revision: 'revision-a', action: 'orders.read', args: {} }, scope), { code: 'awcp_response_mismatch' });
  protocolVersion = 2;
  await assert.rejects(bridge.invoke('request-c', { revision: 'revision-a', action: 'orders.read', args: {} }, scope), { code: 'awcp_protocol_unavailable' });
  protocolVersion = 1;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return protocolVersion;
    if (script.includes('.snapshot()')) return awcpSnapshot();
    throw Object.assign(new Error('untrusted guest failure'), { code: 'guest_internal_error' });
  };
  await assert.rejects(
    bridge.invoke('request-transport', { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
    { code: 'awcp_transport_failed', message: 'The authorized page AWCP invocation failed.' },
  );
  await assert.rejects(bridge.invoke('request-d', { revision: 'revision-a', action: 'orders.read', args: {}, targetId: 'forged' }, scope), { code: 'awcp_invalid_request' });
  await assert.rejects(bridge.invoke('request-e', { revision: 'revision-a', action: 'Orders.read', args: {} }, scope), { code: 'awcp_invalid_request' });
  await assert.rejects(bridge.invoke('request-f', { revision: 'revision-a', action: 'orders.read', args: { value: Number.NaN } }, scope), { code: 'awcp_invalid_request' });
});

test('AWCP scope revocation cancels its captured guest and clears the invocation', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const scripts = [];
  guest.executeJavaScript = (script) => {
    scripts.push(script);
    if (script.includes('protocolVersion')) return Promise.resolve(1);
    if (script.includes('.snapshot()')) return Promise.resolve(awcpSnapshot());
    if (script.includes('.cancel(')) return Promise.resolve(true);
    return new Promise(() => undefined);
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => bridge.dispose());
  await bridge.snapshot('discover-revoke', scope);
  const pending = bridge.invoke('request-a', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  await new Promise((resolve) => setImmediate(resolve));
  scope.release();
  await assert.rejects(pending, { code: 'site_control_unavailable', statusCode: 409 });
  assert.ok(scripts.some((script) => script.includes('globalThis.awcp?.cancel')));
  assert.equal(bridge.cancel('request-a'), false);
});

test('AWCP guest close and main-frame navigation terminate only the captured invocation', async (t) => {
  for (const lifecycle of ['destroyed', 'did-start-navigation']) {
    const h = createSiteHarness(); const a = h.site(lifecycle); const scope = h.capture(a); scope.activate();
    const guest = h.contents.get(a.tabs[0].webContentsId);
    guest.executeJavaScript = (script) => {
      if (script.includes('protocolVersion')) return Promise.resolve(1);
      if (script.includes('.snapshot()')) return Promise.resolve(awcpSnapshot());
      if (script.includes('.cancel(')) return Promise.resolve(true);
      return new Promise(() => undefined);
    };
    const bridge = new AwcpGuestBridge(h.registry);
    t.after(() => { bridge.dispose(); scope.release(); });
    const requestId = `request-${lifecycle}`;
    await bridge.snapshot(`discover-${lifecycle}`, scope);
    const pending = bridge.invoke(requestId, { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
    await new Promise((resolve) => setImmediate(resolve));

    if (lifecycle === 'destroyed') guest.emit('destroyed');
    else guest.emit('did-start-navigation', {}, 'https://example.test/next', false, true);

    await assert.rejects(pending, {
      code: lifecycle === 'destroyed' ? 'site_control_unavailable' : 'awcp_navigation_interrupted',
    });
    assert.equal(bridge.cancel(requestId), false);
  }
});

test('AWCP validates inputSchema before invoking the page handler', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-input'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) {
      return awcpSnapshot('orders.read', {
        type: 'object',
        required: ['ids'],
        additionalProperties: false,
        properties: { ids: { type: 'array', items: { type: 'string' } } },
      }, undefined, { ids: ['one'] });
    }
    invokeCalls += 1;
    return { ok: true, requestId: 'request-input', action: 'orders.read', result: null };
  };

  await bridge.snapshot('discover-input', scope);
  await assert.rejects(bridge.invoke('request-input', {
    revision: 'revision-a', action: 'orders.read', args: { ids: '' },
  }, scope), (error) => {
    assert.equal(error.code, 'awcp_preflight_rejected');
    assert.equal(error.details.executionStarted, false);
    assert.equal(error.details.reason, 'input_schema_mismatch');
    assert.deepEqual(error.details.violations, [{
      instancePath: '/ids', keyword: 'type', expectedType: 'array', actualType: 'string',
    }]);
    return true;
  });
  assert.equal(invokeCalls, 0);
});

test('AWCP enforces typed leaf and group anyOf condition schemas', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-condition'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const leaf = {
    type: 'object', required: ['field', 'oper', 'stringValue'], additionalProperties: false,
    properties: { field: { type: 'string', enum: ['status'] }, oper: { type: 'string', enum: ['eq'] }, stringValue: { type: 'string' } },
  };
  const condition = {
    type: 'object', anyOf: [
      leaf,
      {
        type: 'object', required: ['join', 'nodes'], additionalProperties: false,
        properties: {
          join: { type: 'string', enum: ['and', 'or'] },
          nodes: { type: 'array', minItems: 1, items: leaf },
        },
      },
    ],
  };
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return awcpSnapshot('orders.query', condition, undefined,
      { field: 'status', oper: 'eq', stringValue: 'open' });
    invokeCalls += 1;
    const requestId = ['request-leaf', 'request-group'].find((candidate) => script.includes(candidate)) ?? '';
    return { ok: true, requestId, action: 'orders.query', result: null };
  };

  await bridge.snapshot('discover-condition', scope);
  for (const [requestId, args] of [
    ['request-nodes-object', { join: 'and', nodes: { item: [] } }],
    ['request-missing-join', { nodes: [{ field: 'status', oper: 'eq', stringValue: 'open' }] }],
    ['request-missing-value', { field: 'status', oper: 'eq' }],
  ]) {
    await assert.rejects(bridge.invoke(requestId, { revision: 'revision-a', action: 'orders.query', args }, scope),
      (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'input_schema_mismatch');
  }
  assert.equal(invokeCalls, 0);

  const validLeaf = await bridge.invoke('request-leaf', {
    revision: 'revision-a', action: 'orders.query', args: { field: 'status', oper: 'eq', stringValue: 'open' },
  }, scope);
  const validGroup = await bridge.invoke('request-group', {
    revision: 'revision-a', action: 'orders.query',
    args: { join: 'and', nodes: [{ field: 'status', oper: 'eq', stringValue: 'open' }] },
  }, scope);
  assert.equal(validLeaf.ok, true);
  assert.equal(validGroup.ok, true);
  assert.equal(invokeCalls, 2);
});

test('AWCP preflight returns stale_snapshot and action_not_found without invoking the page handler', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-preflight'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return awcpSnapshot();
    invokeCalls += 1;
    return null;
  };

  await bridge.snapshot('discover-preflight', scope);
  await assert.rejects(bridge.invoke('request-stale', { revision: 'old', action: 'orders.read', args: {} }, scope),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'stale_snapshot');
  await assert.rejects(bridge.invoke('request-missing', { revision: 'revision-a', action: 'orders.missing', args: {} }, scope),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'action_not_found');
  assert.equal(invokeCalls, 0);
});

test('AWCP enforces declared outputSchema and keeps an omitted or empty schema compatible', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-output'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let snapshot = awcpSnapshot();
  let result = { arbitrary: true };
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return snapshot;
    const requestId = ['request-omitted', 'request-empty', 'request-valid', 'request-output-invalid']
      .find((candidate) => script.includes(candidate)) ?? '';
    return { ok: true, requestId, action: 'orders.read', result };
  };

  await bridge.snapshot('discover-output', scope);
  const omitted = await bridge.invoke('request-omitted', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  assert.equal(omitted.ok, true);
  snapshot = awcpSnapshot('orders.read', { type: 'object' }, {});
  await bridge.snapshot('discover-empty-output', scope);
  const empty = await bridge.invoke('request-empty', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  assert.equal(empty.ok, true);
  snapshot = awcpSnapshot('orders.read', { type: 'object' }, {
    type: 'object', required: ['items'], additionalProperties: false,
    properties: { items: { type: 'array', items: { type: 'string' } } },
  });
  await bridge.snapshot('discover-typed-output', scope);
  result = { items: ['one'] };
  const valid = await bridge.invoke('request-valid', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  assert.equal(valid.ok, true);
  result = { items: '' };
  await assert.rejects(
    bridge.invoke('request-output-invalid', { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
    (error) => error.code === 'awcp_invalid_response' &&
      error.details?.reason === 'output_schema_mismatch' &&
      error.details?.violations?.[0]?.instancePath === '/items',
  );
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) return snapshot;
    return {
      ok: false,
      requestId: 'request-raced-stale',
      action: 'orders.read',
      error: { code: 'stale_snapshot', message: 'The Registry revision changed.' },
    };
  };
  const racedStale = await bridge.invoke(
    'request-raced-stale',
    { revision: 'revision-a', action: 'orders.read', args: {} },
    scope,
  );
  assert.equal(racedStale.ok, false);
  assert.equal(racedStale.error.code, 'stale_snapshot');
});

test('AWCP rejects invalid schemas before invoking the page handler', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-schema'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) {
      return awcpSnapshot('orders.read', { type: 'object' }, { $ref: 'https://untrusted.invalid/schema' });
    }
    invokeCalls += 1;
    return null;
  };

  await assert.rejects(bridge.snapshot('discover-schema', scope), { code: 'awcp_invalid_contract' });
  assert.equal(invokeCalls, 0);
});

test('AWCP rejects malformed snapshots without invoking the page handler', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-snapshot'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('protocolVersion')) return 1;
    if (script.includes('.snapshot()')) {
      return { revision: 'revision-a', actions: [{
        action: 'orders.read', description: 'read', inputSchema: {}, outputSchema: null,
      }] };
    }
    invokeCalls += 1;
    return null;
  };

  await assert.rejects(
    bridge.snapshot('request-snapshot', scope),
    { code: 'awcp_invalid_contract' },
  );
  assert.equal(invokeCalls, 0);
});

test('AWCP never emits non-JSON success results', async (t) => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  const invalidResults = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    () => undefined,
    sparse,
    Object.assign([], { extra: true }),
    cycle,
  ];
  for (const [index, invalidResult] of invalidResults.entries()) {
    const h = createSiteHarness(); const a = h.site(`awcp-json-${index}`); const scope = h.capture(a); scope.activate();
    const guest = h.contents.get(a.tabs[0].webContentsId);
    const bridge = new AwcpGuestBridge(h.registry);
    t.after(() => { bridge.dispose(); scope.release(); });
    const requestId = `request-json-${index}`;
    guest.executeJavaScript = async (script) => {
      if (script.includes('protocolVersion')) return 1;
      if (script.includes('.snapshot()')) return awcpSnapshot();
      return { ok: true, requestId, action: 'orders.read', result: invalidResult };
    };
    await bridge.snapshot(`discover-json-${index}`, scope);
    await assert.rejects(
      bridge.invoke(requestId, { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
      { code: 'awcp_invalid_response' },
    );
  }
});

test('invalid mouse parameters never acquire page focus or send input', async (t) => {
  const h = createSiteHarness();
  const site = h.site('validation');
  const scope = h.capture(site); scope.activate(); t.after(() => scope.release());
  const phases = [];
  const gateway = gatewayFor(h, { controlSiteFocus: async (_surface, _tab, _scope, phase) => phases.push(phase) });
  const { targetId } = await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope);
  const commandsBefore = h.commands.length;
  await assert.rejects(gateway.executeCommand({
    method: 'Input.dispatchMouseEvent', targetId,
    params: { type: 'mousePressed', x: '646', y: '344', button: 'left', clickCount: '1' }
  }, scope), (error) => error.code === 'invalid_args' && error.details.issues.length === 3);
  assert.deepEqual(phases, []);
  assert.equal(h.commands.length, commandsBefore);
});

test('Input.click runs one authorized focus transaction and never forwards the virtual method to Chromium', async (t) => {
  const h = createSiteHarness(); const a = h.site('click');
  const scope = h.capture(a); scope.activate(); t.after(() => scope.release());
  const phases = [];
  const gateway = gatewayFor(h, { controlSiteFocus: async (_surface, _tab, _scope, phase) => { phases.push(phase); } });
  const { targetId } = await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, scope);
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const original = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    await original(method, params);
    return method === 'Runtime.evaluate' ? { result: { value: { x: 10.5, y: 20.25, matched: true } } } : {};
  };
  const { result } = await gateway.executeCommand({ method: 'Input.click', targetId, params: { x: 10.5, y: 20.25 } }, scope);
  assert.equal(result.status, 'clicked');
  assert.deepEqual(phases, ['capture', 'input', 'restore']);
  assert.equal(h.commands.some(c => c.method === 'Input.click'), false);
  assert.deepEqual(h.commands.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params.type), ['mousePressed', 'mouseReleased']);
  assert.equal(guest.debugger.isAttached(), false);
  const controller = new AbortController(); controller.abort();
  const before = h.commands.length;
  await assert.rejects(gateway.executeCommand({ method: 'Input.click', targetId, params: { selector: '#b' } }, scope, controller.signal), /canceled/);
  assert.equal(h.commands.length, before);
});
