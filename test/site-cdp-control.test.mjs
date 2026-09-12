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

function gatewayFor(h, extra = {}) {
  return new EmbeddedCdpGateway({ getSurfaces: () => h.registry.listRegisteredSurfaces(),
    resolveWebContents: (_surface, tab) => h.contents.get(tab.webContentsId), logger: { debug() {}, warn() {} }, ...extra });
}
const identity = { runId: 'run-a', chatId: 'chat-a', owner: { kind: 'agent', agentKey: 'agent-a' } };
const source = { runId: 'run-a', chatId: 'chat-a', agentKey: 'agent-a' };

function awcpSnapshot(action = 'orders.read', inputSchema = { type: 'object' }, outputSchema) {
  return {
    revision: 'revision-a',
    actions: [{
      action,
      description: `Invoke ${action}`,
      inputSchema,
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
  await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: target.targetId }, scope);
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
      });
    }
    invokeCalls += 1;
    return { ok: true, requestId: 'request-input', action: 'orders.read', result: null };
  };

  const response = await bridge.invoke('request-input', {
    revision: 'revision-a', action: 'orders.read', args: { ids: '' },
  }, scope);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'invalid_arguments');
  assert.deepEqual(response.error.details.violations.map((item) => item.keyword), ['type']);
  assert.equal(invokeCalls, 0);
});

test('AWCP enforces mutually exclusive leaf and group condition schemas', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-condition'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const leaf = {
    type: 'object', required: ['field', 'oper', 'value'], additionalProperties: false,
    properties: { field: { type: 'string' }, oper: { type: 'string' }, value: {} },
  };
  const condition = {
    oneOf: [
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
    if (script.includes('.snapshot()')) return awcpSnapshot('orders.query', condition);
    invokeCalls += 1;
    const requestId = ['request-leaf', 'request-group'].find((candidate) => script.includes(candidate)) ?? '';
    return { ok: true, requestId, action: 'orders.query', result: null };
  };

  for (const [requestId, args] of [
    ['request-nodes-object', { join: 'and', nodes: { item: [] } }],
    ['request-missing-join', { nodes: [{ field: 'status', oper: 'eq', value: 'open' }] }],
    ['request-missing-value', { field: 'status', oper: 'eq' }],
  ]) {
    const response = await bridge.invoke(requestId, { revision: 'revision-a', action: 'orders.query', args }, scope);
    assert.equal(response.ok, false, requestId);
    assert.equal(response.error.code, 'invalid_arguments', requestId);
  }
  assert.equal(invokeCalls, 0);

  const validLeaf = await bridge.invoke('request-leaf', {
    revision: 'revision-a', action: 'orders.query', args: { field: 'status', oper: 'eq', value: 'open' },
  }, scope);
  const validGroup = await bridge.invoke('request-group', {
    revision: 'revision-a', action: 'orders.query',
    args: { join: 'and', nodes: [{ field: 'status', oper: 'eq', value: 'open' }] },
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

  const stale = await bridge.invoke('request-stale', { revision: 'old', action: 'orders.read', args: {} }, scope);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_snapshot');
  const missing = await bridge.invoke('request-missing', { revision: 'revision-a', action: 'orders.missing', args: {} }, scope);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'action_not_found');
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

  const omitted = await bridge.invoke('request-omitted', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  assert.equal(omitted.ok, true);
  snapshot = awcpSnapshot('orders.read', { type: 'object' }, {});
  const empty = await bridge.invoke('request-empty', { revision: 'revision-a', action: 'orders.read', args: {} }, scope);
  assert.equal(empty.ok, true);
  snapshot = awcpSnapshot('orders.read', { type: 'object' }, {
    type: 'object', required: ['items'], additionalProperties: false,
    properties: { items: { type: 'array', items: { type: 'string' } } },
  });
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

  await assert.rejects(
    bridge.invoke('request-schema', { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
    { code: 'awcp_invalid_contract' },
  );
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
    bridge.invoke('request-snapshot', { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
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
    await assert.rejects(
      bridge.invoke(requestId, { revision: 'revision-a', action: 'orders.read', args: {} }, scope),
      { code: 'awcp_invalid_response' },
    );
  }
});
