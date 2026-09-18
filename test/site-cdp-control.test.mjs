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

function awcpIndex(actions = ['orders.read'], revision = 'revision-a') {
  return {
    revision,
    site: { name: 'Orders', description: 'Order operations.' },
    sections: actions.map((action) => ({ section: action, title: `Use ${action}` })),
  };
}

function awcpSection(action = 'orders.read', options = {}) {
  return {
    revision: options.revision ?? 'revision-a',
    section: action,
    description: options.description ?? `Perform ${action}.`,
    inputSchema: options.inputSchema ?? { type: 'object' },
    ...(options.omitExamples ? {} : { examples: options.examples ?? [{}] }),
  };
}

function awcpProbe(actualVersion = 1, overrides = {}) {
  return { present: true, entryType: 'object', actualVersion, manualType: 'function', invokeType: 'function', ...overrides };
}

function awcpManualValue(script, options = {}) {
  if (!script.includes('.manual(')) return undefined;
  const action = options.action ?? 'orders.read';
  return script.includes('section')
    ? (options.section ?? awcpSection(action, options))
    : (options.index ?? awcpIndex(options.actions ?? [action], options.revision));
}

test('AWCP treats Schema as page-owned data and accepts a section without examples', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-isolation'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let handlerCalls = 0;
  const successResponse = { ok: true, requestId: 'invoke-read', action: 'orders.read', result: {} };
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) {
      if (!script.includes('section')) return awcpIndex(['orders.read', 'orders.write']);
      return script.includes('orders.write')
        ? awcpSection('orders.write', { inputSchema: { $ref: 'https://page.invalid/schema' } })
        : awcpSection('orders.read', { omitExamples: true });
    }
    handlerCalls += 1;
    return successResponse;
  };

  const index = await bridge.manual('manual-index', {}, scope);
  assert.deepEqual(index.sections.map(({ section }) => section), ['orders.read', 'orders.write']);
  const read = await bridge.manual('manual-read', { section: 'orders.read', revision: index.revision }, scope);
  assert.equal('examples' in read, false);
  await bridge.manual('manual-write', { section: 'orders.write', revision: index.revision }, scope);
  assert.deepEqual(await bridge.invoke('invoke-read', {
    revision: 'revision-a', action: 'orders.read', args: {},
  }, scope), successResponse);
  assert.equal(handlerCalls, 1);
});

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

test('AWCP directory is lightweight and section reads are revision-bound', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-manual'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) return awcpManualValue(script);
    invokeCalls += 1;
    return { ok: true, requestId: 'invoke-a', action: 'orders.read', result: {} };
  };

  await assert.rejects(
    bridge.manual('section-first', { section: 'orders.read', revision: 'revision-a' }, scope),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'manual_required',
  );
  const index = await bridge.manual('index', {}, scope);
  assert.deepEqual(index.sections, [{ section: 'orders.read', title: 'Use orders.read' }]);
  assert.equal('inputSchema' in index, false);
  await assert.rejects(bridge.manual('legacy-section', { section: 'orders.read' }, scope), { code: 'awcp_invalid_request' });
  const section = await bridge.manual('section', { section: 'orders.read', revision: index.revision }, scope);
  assert.equal(section.section, 'orders.read');
  assert.equal(section.revision, index.revision);
  assert.equal(invokeCalls, 0);
});

test('AWCP manual binding is scoped to one Run and exact guest', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
  const scopeA = h.capture(a); scopeA.activate(); const scopeB = h.capture(b); scopeB.activate();
  const bridge = new AwcpGuestBridge(h.registry);
  t.after(() => { bridge.dispose(); scopeA.release(); scopeB.release(); });
  for (const site of [a, b]) {
    h.contents.get(site.tabs[0].webContentsId).executeJavaScript = async (script) => {
      if (script.includes('actualVersion')) return awcpProbe();
      if (script.includes('.manual(')) return awcpManualValue(script);
      return { ok: true, requestId: script.includes('invoke-a') ? 'invoke-a' : 'invoke-b', action: 'orders.read', result: site.surfaceId };
    };
  }
  const index = await bridge.manual('index-a', {}, scopeA);
  await bridge.manual('section-a', { section: 'orders.read', revision: index.revision }, scopeA);
  await assert.rejects(
    bridge.invoke('invoke-b', { revision: index.revision, action: 'orders.read', args: {} }, scopeB),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'manual_required',
  );
  assert.equal((await bridge.invoke('invoke-a', { revision: index.revision, action: 'orders.read', args: {} }, scopeA)).ok, true);
});

test('AWCP navigation invalidates bindings and released scopes remove listeners', async () => {
  const h = createSiteHarness(); const a = h.site('awcp-navigation'); const guest = h.contents.get(a.tabs[0].webContentsId);
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) return awcpManualValue(script);
    return { ok: true, requestId: 'invoke-after-navigation', action: 'orders.read', result: null };
  };
  const scope = h.capture(a); scope.activate();
  const bridge = new AwcpGuestBridge(h.registry);
  const baseline = guest.listenerCount('did-start-navigation');
  const index = await bridge.manual('index-navigation', {}, scope);
  await bridge.manual('section-navigation', { section: 'orders.read', revision: index.revision }, scope);
  assert.equal(guest.listenerCount('did-start-navigation'), baseline + 1);
  guest.emit('did-start-navigation', {}, 'https://example.test/next', false, true);
  await assert.rejects(
    bridge.invoke('invoke-after-navigation', { revision: index.revision, action: 'orders.read', args: {} }, scope),
    (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === 'page_changed',
  );
  scope.release();
  assert.equal(guest.listenerCount('did-start-navigation'), baseline);
  bridge.dispose();
});

test('AWCP cancellation remains pinned to the captured guest', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-cancel'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  const scripts = [];
  guest.executeJavaScript = (script) => {
    scripts.push(script);
    if (script.includes('actualVersion')) return Promise.resolve(awcpProbe());
    if (script.includes('.manual(')) return Promise.resolve(awcpManualValue(script));
    if (script.includes('.cancel(')) return Promise.resolve(true);
    return new Promise(() => undefined);
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const index = await bridge.manual('index-cancel', {}, scope);
  await bridge.manual('section-cancel', { section: 'orders.read', revision: index.revision }, scope);
  const pending = bridge.invoke('request-cancel', { revision: index.revision, action: 'orders.read', args: {} }, scope);
  await new Promise((resolve) => setImmediate(resolve));
  const secondTab = h.addTab(a);
  h.contents.get(secondTab.webContentsId).executeJavaScript = () => assert.fail('cancel drifted to a new guest');
  assert.equal(bridge.cancel('request-cancel'), true);
  await assert.rejects(pending, { code: 'awcp_cancelled' });
  assert.ok(scripts.some((script) => script.includes('globalThis.awcp?.cancel')));
});

test('AWCP distinguishes missing, unsupported and malformed entry points', async (t) => {
  const cases = [
    [{ present: false }, 'awcp_protocol_unavailable'],
    [awcpProbe(0), 'awcp_unsupported_protocol'],
    [awcpProbe(1, { manualType: 'object' }), 'awcp_invalid_contract'],
  ];
  for (const [probe, code] of cases) {
    const h = createSiteHarness(); const a = h.site(code); const scope = h.capture(a); scope.activate();
    const guest = h.contents.get(a.tabs[0].webContentsId);
    guest.executeJavaScript = async (script) => script.includes('actualVersion') ? probe : awcpIndex();
    const bridge = new AwcpGuestBridge(h.registry);
    t.after(() => { bridge.dispose(); scope.release(); });
    await assert.rejects(bridge.manual(`manual-${code}`, {}, scope), (error) => {
      assert.equal(error.code, code);
      if (code === 'awcp_unsupported_protocol') {
        assert.deepEqual(error.details, { supportedVersions: [1], actualVersion: 0 });
      }
      return true;
    });
  }
});

test('AWCP forwards page-owned field errors without Desktop Schema prevalidation', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-fields'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) return awcpManualValue(script, {
      inputSchema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    });
    invokeCalls += 1;
    return {
      ok: false,
      requestId: 'invalid-fields',
      action: 'orders.read',
      error: {
        code: 'invalid_arguments',
        message: 'Invalid arguments.',
        details: { executionStarted: false, fieldErrors: [{ path: ['enabled'], messages: ['必须是 boolean 类型。'] }] },
      },
    };
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const index = await bridge.manual('index-fields', {}, scope);
  await bridge.manual('section-fields', { section: 'orders.read', revision: index.revision }, scope);
  const response = await bridge.invoke('invalid-fields', {
    revision: index.revision, action: 'orders.read', args: { enabled: 'true' },
  }, scope);
  assert.equal(invokeCalls, 1);
  assert.deepEqual(response.error.details.fieldErrors[0].path, ['enabled']);
  assert.equal('stage' in response.error.details, false);
});

test('AWCP host preflight rejects stale revisions, unknown actions and unread sections', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-preflight'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  let invokeCalls = 0;
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) return awcpManualValue(script, { actions: ['orders.read', 'orders.write'] });
    invokeCalls += 1;
    return null;
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const index = await bridge.manual('index-preflight', {}, scope);
  await bridge.manual('section-preflight', { section: 'orders.read', revision: index.revision }, scope);
  for (const [requestId, revision, action, reason] of [
    ['stale', 'old', 'orders.read', 'stale_revision'],
    ['missing', index.revision, 'orders.missing', 'action_not_found'],
    ['unread', index.revision, 'orders.write', 'manual_required'],
  ]) {
    await assert.rejects(
      bridge.invoke(requestId, { revision, action, args: {} }, scope),
      (error) => error.code === 'awcp_preflight_rejected' && error.details.reason === reason,
    );
  }
  assert.equal(invokeCalls, 0);
});

test('AWCP maps manual errors and invalidates a binding after a page stale response', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-stale'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  let manualError = null;
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) {
      if (!script.includes('section')) return awcpIndex(['orders.read']);
      if (manualError) return { error: { code: manualError, section: 'orders.read', message: 'changed' } };
      return awcpSection();
    }
    return { ok: false, requestId: 'page-stale', action: 'orders.read', error: { code: 'stale_revision', message: 'changed' } };
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const index = await bridge.manual('index-stale', {}, scope);
  manualError = 'section_not_found';
  await assert.rejects(
    bridge.manual('section-missing', { section: 'orders.read', revision: index.revision }, scope),
    (error) => error.details.reason === 'action_not_found',
  );
  manualError = null;
  await bridge.manual('section-stale', { section: 'orders.read', revision: index.revision }, scope);
  const response = await bridge.invoke('page-stale', { revision: index.revision, action: 'orders.read', args: {} }, scope);
  assert.equal(response.error.code, 'stale_revision');
  await assert.rejects(
    bridge.invoke('after-stale', { revision: index.revision, action: 'orders.read', args: {} }, scope),
    (error) => error.details.reason === 'manual_required',
  );
});

test('AWCP rejects old contract fields, mismatched correlation and non-JSON results', async (t) => {
  const h = createSiteHarness(); const a = h.site('awcp-contract'); const scope = h.capture(a); scope.activate();
  const guest = h.contents.get(a.tabs[0].webContentsId);
  let directory = { ...awcpIndex(), sections: [{ section: 'orders.read', title: 'Use orders.read', action: 'orders.read' }] };
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    if (script.includes('.manual(')) return script.includes('section') ? awcpSection() : directory;
    return { ok: true, requestId: 'wrong', action: 'orders.read', result: null };
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  await assert.rejects(bridge.manual('legacy-directory', {}, scope), { code: 'awcp_invalid_contract' });
  directory = awcpIndex();
  const index = await bridge.manual('index-contract', {}, scope);
  await bridge.manual('section-contract', { section: 'orders.read', revision: index.revision }, scope);
  await assert.rejects(
    bridge.invoke('correlated', { revision: index.revision, action: 'orders.read', args: {} }, scope),
    { code: 'awcp_response_mismatch' },
  );
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) return awcpProbe();
    return { ok: true, requestId: 'invalid-json', action: 'orders.read', result: undefined };
  };
  await assert.rejects(
    bridge.invoke('invalid-json', { revision: index.revision, action: 'orders.read', args: {} }, scope),
    { code: 'awcp_invalid_response' },
  );
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
