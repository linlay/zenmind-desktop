import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentPlatformRealtimeClient } = require('../dist-electron/main/modules/agent-platform/realtime/agent-platform-realtime-client.js');
const { setMainLocaleForCurrentProcess, getMainLocale } = require('../dist-electron/main/support/i18n/main-i18n.js');
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness(t, source = 'desktop-main') {
  const sockets = [];
  const client = new AgentPlatformRealtimeClient({
    app: {}, getDesktopDeviceId: () => 'test', issueAccessToken: async () => ({ ok: true, token: 'token' }),
    source, onFrame() {}, heartbeatTimeoutMs: 0,
    createWebSocket(url) {
      const socket = { url, sent: [], onopen: null, onmessage: null, onclose: null, onerror: null,
        send(data) { this.sent.push(JSON.parse(data)); }, close() {},
        emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); },
      };
      sockets.push(socket);
      queueMicrotask(() => socket.emit({ frame: 'push', type: 'connected', data: {
        protocolVersion: 2, sessionId: `${source}-${sockets.length}`, serverTime: 1791000000000,
        liveness: { heartbeatIntervalMs: 30000, silenceTimeoutMs: 100000 },
      } }));
      return socket;
    },
  });
  t.after(() => client.dispose());
  return { client, sockets };
}

test('global locale updates every connected lane before subsequent business requests', async t => {
  const previous = getMainLocale();
  setMainLocaleForCurrentProcess('en-US');
  const lanes = ['desktop-main', 'desktop-btw', 'desktop-explain'].map(source => harness(t, source));
  t.after(() => { lanes.forEach(h => h.client.dispose()); setMainLocaleForCurrentProcess(previous); });
  for (const h of lanes) {
    await h.client.ensureConnected('http://localhost:8080', 'token');
    assert.equal(new URL(h.sockets[0].url).searchParams.get('locale'), 'en-US');
  }
  setMainLocaleForCurrentProcess('zh-CN');
  for (const h of lanes) h.client.send({ frame: 'request', type: '/api/agent/model-config', id: 'model', payload: { agentKey: 'zenmi', modelKey: 'luna' } });
  await turn();
  for (const h of lanes) {
    const socket = h.sockets[0];
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].type, '/api/locale');
    assert.deepEqual(socket.sent[0].payload, { locale: 'zh-CN' });
    socket.emit({ frame: 'response', type: '/api/locale', id: socket.sent[0].id, code: 0, data: { locale: 'zh-CN' } });
  }
  await turn();
  for (const h of lanes) {
    assert.equal(h.sockets[0].sent[1].type, '/api/agent/model-config');
    assert.deepEqual(h.sockets[0].sent[1].payload, { agentKey: 'zenmi', modelKey: 'luna' });
    assert.equal(h.sockets[0].sent.some(f => f.type === '/api/detach' || f.type === '/api/attach'), false);
    h.sockets[0].onclose();
    await h.client.ensureConnected('http://localhost:8080', 'token');
    assert.equal(new URL(h.sockets[1].url).searchParams.get('locale'), 'zh-CN');
  }
});

test('rapid language changes serialize settings before business requests', async t => {
  const previous = getMainLocale();
  setMainLocaleForCurrentProcess('en-US');
  const h = harness(t);
  t.after(() => { h.client.dispose(); setMainLocaleForCurrentProcess(previous); });
  await h.client.ensureConnected('http://localhost:8080', 'token');
  const socket = h.sockets[0];
  setMainLocaleForCurrentProcess('zh-CN');
  setMainLocaleForCurrentProcess('en-US');
  h.client.send({ frame: 'request', type: '/api/query', id: 'query', payload: { message: 'hello' } });
  await turn();
  assert.equal(socket.sent.length, 1);
  socket.emit({ frame: 'response', id: socket.sent[0].id, code: 0 });
  await turn();
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1].payload, { locale: 'en-US' });
  socket.emit({ frame: 'response', id: socket.sent[1].id, code: 0 });
  await turn();
  assert.equal(socket.sent[2].type, '/api/query');
  assert.deepEqual(socket.sent[2].payload, { message: 'hello' });
});

test('failed locale acknowledgement does not release queued business requests', async t => {
  const previous = getMainLocale();
  setMainLocaleForCurrentProcess('en-US');
  const h = harness(t);
  t.after(() => { h.client.dispose(); setMainLocaleForCurrentProcess(previous); });
  await h.client.ensureConnected('http://localhost:8080', 'token');
  const socket = h.sockets[0];
  setMainLocaleForCurrentProcess('zh-CN');
  h.client.send({ frame: 'request', type: '/api/query', id: 'query', payload: { message: 'hello' } });
  await turn();
  socket.emit({ frame: 'error', type: 'invalid_locale', id: socket.sent[0].id, code: 400, msg: 'invalid locale' });
  await turn();
  assert.equal(socket.sent.some(frame => frame.type === '/api/query'), false);
  assert.equal(h.client.getState().phase, 'reconnecting');
  await h.client.ensureConnected('http://localhost:8080', 'token');
  assert.equal(new URL(h.sockets[1].url).searchParams.get('locale'), 'zh-CN');
});
