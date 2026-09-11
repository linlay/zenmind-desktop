import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSiteHarness } = require('./fixtures/site-cdp-harness.cjs');
const { EmbeddedCdpGateway, createEmbeddedCdpTargetId } = require('../dist-electron/main/modules/web-surfaces/cdp/gateway.js');
const { createCdpIntegration } = require('../dist-electron/main/modules/web-surfaces/cdp/integration.js');
const { RunSiteCdpGrants } = require('../dist-electron/main/modules/agent-platform/realtime/run-site-cdp-grants.js');
const { withSiteCdpFocus } = require('../dist-electron/main/modules/web-surfaces/cdp/site-focus.js');

function gatewayFor(h, extra = {}) {
  return new EmbeddedCdpGateway({ getSurfaces: () => h.registry.listRegisteredSurfaces(),
    resolveWebContents: (_surface, tab) => h.contents.get(tab.webContentsId), logger: { debug() {}, warn() {} }, ...extra });
}
const identity = { runId: 'run-a', chatId: 'chat-a', owner: { kind: 'agent', agentKey: 'agent-a' } };
const source = { runId: 'run-a', chatId: 'chat-a', agentKey: 'agent-a' };

test('independent Website Runs keep distinct target queries and reject each other', async (t) => {
  const h = createSiteHarness(); const a = h.site('a'); const b = h.site('b');
  const grants = new RunSiteCdpGrants(); t.after(() => grants.revokeAll());
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
  const grants = new RunSiteCdpGrants(); const scope = h.capture(a); grants.bind(identity, scope);
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
  const grants = new RunSiteCdpGrants(); grants.bind(identity, scope);
  assert.throws(() => grants.resolve(source), { code: 'site_control_unavailable' });
  grants.revoke(identity.runId);
  assert.throws(() => grants.resolve(source), { code: 'site_control_unavailable' });
});
