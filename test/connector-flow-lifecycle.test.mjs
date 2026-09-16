import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} };
const source = fs.readFileSync(new URL('../src/renderer/pages/functional-market/connectorFlow.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(compiled, { module, exports: module.exports, URL, Date, Promise, Error, setTimeout, clearTimeout });
const { runMarketConnectorFlow, createConnectorSessionOwner, connectorAuthorizationUrl, sameConnectorAuthorization } = module.exports;
function setup() {
  const calls = []; let bound = false;
  const session = status => ({ connectorId: 'actual-id', sessionId: 'first', status, expiresAt: '', authBrowser: 'embedded', authorizationUrl: 'https://work.weixin.qq.com/step1' });
  const state = () => ({ connectorId: 'actual-id', bound, enabled: bound, readiness: bound ? 'ready' : 'not_connected', authentication: session(bound ? 'authorized' : 'unauthorized'), capabilities: { hasCli: false, authMode: null } });
  const api = {
    install: async () => { calls.push('install'); return { ok: true, connectorId: 'actual-id' }; },
    getConnectorConnection: async () => state(),
    connectConnector: async () => { calls.push('connect'); bound = true; return session('authorized'); },
    cancelConnectorConnection: async identity => { calls.push(`cancel:${identity.sessionId}`); return state(); },
    setConnectorEnabled: async () => { calls.push('enable'); return state(); },
    setConnectorAgent: async () => { calls.push('bind'); return { activeConnectorIds: ['actual-id'], reloadPending: false }; },
  };
  const controller = new AbortController();
  const intent = { item: { id: 'market-id' }, installed: false, connectorId: 'market-id', enable: true, agentKey: 'xiaojun', signal: controller.signal, onPhase() {}, onInstalled() {}, onConnection() {}, async onSession() {}, onTokenSchema() {} };
  return { calls, api, intent, controller, session, state };
}
test('market identity resolves to the installed Platform identity and one explicit add enables and mounts', async () => {
  const s = setup(); await runMarketConnectorFlow(s.intent, s.api, async () => {});
  assert.deepEqual(s.calls, ['install', 'connect', 'enable', 'bind']);
});
test('cancel before connect returns cancels its late exact session without enabling or binding', async () => {
  const s = setup(); let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  s.api.connectConnector = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const operation = runMarketConnectorFlow(s.intent, s.api, async () => {});
  await started; s.controller.abort(); finish(s.session('pending'));
  await assert.rejects(operation); assert.deepEqual(s.calls, ['install', 'cancel:first']);
});
test('explicitly resumed pending session is owned and canceled once on leave', async () => {
  const calls = [];
  const owner = createConnectorSessionOwner(async identity => calls.push(identity.sessionId));
  await owner.observe({ connectorId: 'c', sessionId: 'existing', status: 'pending' });
  await Promise.all([owner.cancel(), owner.cancel()]); assert.deepEqual(calls, ['existing']);
});
test('passive observation without acquiring a session never cancels another view authorization', async () => {
  let count = 0; const owner = createConnectorSessionOwner(async () => { count++; });
  await owner.cancel(); assert.equal(count, 0);
});
test('a completed account is preserved when cancel races completion', async () => {
  let count = 0; const owner = createConnectorSessionOwner(async () => { count++; });
  await owner.observe({ connectorId: 'c', sessionId: 'first', status: 'authorized' });
  await owner.cancel(); assert.equal(count, 0);
});
test('cancellation failures are surfaced and duplicate cleanup does not repeatedly mutate', async () => {
  let count = 0; const owner = createConnectorSessionOwner(async () => { count++; throw new Error('offline'); });
  await owner.observe({ connectorId: 'c', sessionId: 'first', status: 'pending' });
  await assert.rejects(owner.cancel(), /offline/); await assert.rejects(owner.cancel(), /offline/); assert.equal(count, 1);
});
test('authorization links reject executable protocols and userinfo', () => {
  assert.equal(connectorAuthorizationUrl('javascript:alert(1)'), null);
  assert.equal(connectorAuthorizationUrl('https://user:secret@example.com'), null);
  assert.equal(connectorAuthorizationUrl('https://work.weixin.qq.com/step2'), 'https://work.weixin.qq.com/step2');
});

test('same session with a new authorization step reopens while identical snapshots deduplicate', () => {
  const previous = { connectorId: 'c', sessionId: 's', authorizationUrl: 'https://work.weixin.qq.com/step1' };
  const session = { connectorId: 'c', sessionId: 's' };
  assert.equal(sameConnectorAuthorization(previous, session, previous.authorizationUrl), true);
  assert.equal(sameConnectorAuthorization(previous, session, 'https://work.weixin.qq.com/step2'), false);
});
test('authorization display failure cancels the owned pending session before exit', async () => {
  const s = setup();
  s.api.connectConnector = async () => s.session('pending');
  s.intent.onSession = async () => { throw new Error('display failed'); };
  await assert.rejects(runMarketConnectorFlow(s.intent, s.api, async () => {}), /display failed/);
  assert.deepEqual(s.calls, ['install', 'cancel:first']);
});
for (const status of ['canceled', 'failed']) {
  test(`explicit retry reconnects a still-bound account after ${status} authorization`, async () => {
    const s = setup(); let connected = false;
    const failed = { ...s.state(), bound: true, readiness: 'unavailable', authentication: s.session(status) };
    const ready = { ...failed, enabled: true, readiness: 'ready', authentication: s.session('authorized') };
    s.api.getConnectorConnection = async () => connected ? ready : failed;
    s.api.connectConnector = async () => { s.calls.push('connect'); connected = true; return ready.authentication; };
    s.api.setConnectorEnabled = async () => { s.calls.push('enable'); return ready; };
    await runMarketConnectorFlow({ ...s.intent, installed: true, connectorId: 'actual-id' }, s.api, async () => {});
    assert.deepEqual(s.calls, ['connect', 'enable', 'bind']);
  });
}
test('still-bound token authorization failure returns to credential input without enabling', async () => {
  const s = setup();
  s.api.getConnectorConnection = async () => ({ ...s.state(), bound: true, readiness: 'unavailable', authentication: s.session('failed'), capabilities: { hasCli: false, authMode: 'token' } });
  s.api.getConnectorTokenSchema = async () => ({ fields: [{ key: 'API_KEY', type: 'password', required: true }] });
  const result = await runMarketConnectorFlow({ ...s.intent, installed: true, connectorId: 'actual-id' }, s.api, async () => {});
  assert.equal(result.result, 'credentials'); assert.deepEqual(s.calls, []);
});


test('auth_browser policy selects only the configured login surface and keeps the session identity', async () => {
 const calls=[];
 const api={connectorAuthBrowser:{open:async identity=>calls.push(['embedded',JSON.parse(JSON.stringify(identity))])},shell:{openExternal:async url=>{calls.push(['system',url]);return {ok:true};}}};
 const session={connectorId:'wecom',sessionId:'same-session',status:'pending',authorizationUrl:'https://work.weixin.qq.com/auth'};
 await module.exports.openConnectorAuthorization({...session,authBrowser:'embedded'},api);
 assert.deepEqual(calls.pop(),['embedded',{connectorId:'wecom',sessionId:'same-session'}]);
 await module.exports.openConnectorAuthorization({...session,authBrowser:'system'},api);
 assert.deepEqual(calls.pop(),['system',session.authorizationUrl]);
 await module.exports.openConnectorAuthorization(session,api);
 assert.deepEqual(calls.pop(),['system',session.authorizationUrl]);
 await module.exports.openConnectorAuthorization({...session,authBrowser:'system'},api,'embedded');
 assert.deepEqual(calls.pop(),['embedded',{connectorId:'wecom',sessionId:'same-session',browser:'embedded'}]);
 await assert.rejects(module.exports.openConnectorAuthorization({...session,status:'authorized'},api));
 assert.equal(calls.length,0);
});
