import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { configurePluginResources, syncPluginResources, stopPluginResources, __testInternals: state } = require('../dist-electron/main/modules/plugins/resources.js');
const { fetchAgentPlatformWithAuth } = require('../dist-electron/main/modules/desktop-actions/platform-http.js');

function fixture(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-automation-'));
  const app = { getPath: name => path.join(root, name) };
  const service = { kind: 'plugin', id: 'automation-plugin', version: 'v1', resources: { webapps: [], agents: [], automations: [{
    id: 'declared-task', name: 'Task', agentKey: 'test', cron: '0 9 * * *', query: { message: 'test' }
  }] } };
  configurePluginResources({ callAgentPlatform: (_app, endpoint, options) => fetchAgentPlatformWithAuth('http://platform.test', endpoint, {
    ...options, issueToken: async () => ({ ok: true, token: 'test-token' }), fetchImpl
  }) });
  t.after(() => { configurePluginResources({ callAgentPlatform: null }); fs.rmSync(root, { recursive: true, force: true }); });
  state.writeOwnership(app, service.id, { desiredStatus: 'running', automations: { 'declared-task': { platformId: 'server-task', updatedAt: 'old' } } });
  return { root, app, service };
}
const response = (status, msg, data = null) => new Response(JSON.stringify({ code: status === 200 ? 0 : status, msg, data }), { status });
const missing = () => response(404, 'automation not found');

for (const failure of ['timeout', 'unauthorized', 'server', 'validation', 'route404']) {
  test(`automation update ${failure} never creates another task and retains ownership`, async t => {
    const calls = [];
    let recovered = false;
    const ctx = fixture(t, async (url, init) => {
      calls.push([new URL(url).pathname, JSON.parse(init.body).id]);
      if (recovered) return response(200, 'success', { id: 'server-task' });
      switch (failure) {
        case 'timeout': throw new Error('response lost');
        case 'unauthorized': return response(401, 'unauthorized');
        case 'server': return response(503, 'unavailable');
        case 'validation': return response(400, 'invalid request');
        case 'route404': return new Response('404 page not found', { status: 404 });
      }
    });
    await assert.rejects(syncPluginResources(ctx.app, ctx.service, ctx.root));
    const owned = state.readOwnership(ctx.app, ctx.service.id);
    assert.equal(owned.automations['declared-task'].platformId, 'server-task');
    assert.equal(owned.pendingAgentPlatformSync, true);
    assert.ok(calls.every(([route]) => route === '/api/automation/update'));
    recovered = true;
    await syncPluginResources(ctx.app, ctx.service, ctx.root);
    assert.deepEqual(calls.at(-1), ['/api/automation/update', 'server-task']);
    assert.equal(state.readOwnership(ctx.app, ctx.service.id).pendingAgentPlatformSync, false);
  });
}

test('automation is recreated only after Platform explicitly reports the old task missing', async t => {
  const calls = [];
  const ctx = fixture(t, async (url, init) => {
    const route = new URL(url).pathname;
    calls.push([route, JSON.parse(init.body).id]);
    return route.endsWith('/update') ? missing() : response(200, 'success', { id: 'replacement-task' });
  });
  await syncPluginResources(ctx.app, ctx.service, ctx.root);
  assert.deepEqual(calls, [['/api/automation/update', 'server-task'], ['/api/automation/create', 'declared-task']]);
  assert.equal(state.readOwnership(ctx.app, ctx.service.id).automations['declared-task'].platformId, 'replacement-task');
});

test('automation delete response loss can finish on an explicit not-found retry', async t => {
  let requests = 0;
  const ctx = fixture(t, async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/automation/delete');
    assert.equal(JSON.parse(init.body).id, 'server-task');
    if (++requests === 1) throw new Error('delete succeeded but response lost');
    return missing();
  });
  await assert.rejects(stopPluginResources(ctx.app, ctx.service), /response lost/);
  assert.equal(state.readOwnership(ctx.app, ctx.service.id).pendingAgentPlatformRemoval, true);
  await stopPluginResources(ctx.app, ctx.service);
  const owned = state.readOwnership(ctx.app, ctx.service.id);
  assert.deepEqual(owned.automations, {});
  assert.equal(owned.pendingAgentPlatformRemoval, false);
});

test('automation delete route-level 404 does not discard cleanup ownership', async t => {
  const ctx = fixture(t, async () => new Response('404 page not found', { status: 404 }));
  await assert.rejects(stopPluginResources(ctx.app, ctx.service));
  const owned = state.readOwnership(ctx.app, ctx.service.id);
  assert.equal(owned.automations['declared-task'].platformId, 'server-task');
  assert.equal(owned.pendingAgentPlatformRemoval, true);
});
