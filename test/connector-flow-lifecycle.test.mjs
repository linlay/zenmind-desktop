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
  const calls = []; let configured = false;
  const session = status => ({ connectorId: 'actual-id', sessionId: 'first', status, expiresAt: '', authBrowser: 'embedded', authorizationUrl: 'https://work.weixin.qq.com/step1' });
  const state = () => ({ connectorId: 'actual-id', configured, readiness: configured ? 'ready' : 'configuration_required', authentication: session(configured ? 'authorized' : 'unauthorized'), capabilities: { hasCli: false, authMode: 'self' } });
  const api = {
    install: async () => { calls.push('install'); return { ok: true, connectorId: 'actual-id' }; },
    getConnectorConnection: async () => state(),
    connectConnector: async () => { calls.push('connect'); configured = true; return session('authorized'); },
    cancelConnectorConnection: async identity => { calls.push(`cancel:${identity.sessionId}`); return state(); },
    setConnectorEnabled: async () => { calls.push('enable'); return state(); },
    setConnectorAgent: async () => { calls.push('bind'); return { agentKey: 'xiaojun', connectorIds: ['actual-id'], activeConnectorIds: ['actual-id'], reloadPending: false }; },
  };
  const controller = new AbortController();
  const intent = { item: { id: 'market-id' }, installed: false, connectorId: 'market-id', mountAgent: true, agentKey: 'xiaojun', signal: controller.signal, onPhase() {}, onInstalled() {}, onConnection() {}, async onSession() {}, onTokenSchema() {} };
  return { calls, api, intent, controller, session, state };
}
function noAuthState(extra={}) {
 return {connectorId:'actual-id',configured:false,configurationRequired:false,readiness:'no_auth',authentication:{connectorId:'actual-id',status:'no_auth',sessionId:'',expiresAt:''},capabilities:{authMode:'none',authBrowser:'',hasCli:true,canConnect:false,canCheck:false,canDisconnect:false},preparation:{connectorId:'actual-id',status:'ready'},...extra};
}
test('no-auth connector installs and mounts without authentication or redundant CLI preparation',async()=>{
 const s=setup();s.api.getConnectorConnection=async()=>noAuthState();
 await runMarketConnectorFlow(s.intent,s.api,async()=>{});
 assert.deepEqual(s.calls,['install','bind']);
 s.calls.length=0;s.intent.installed=true;s.intent.connectorId='actual-id';
 await runMarketConnectorFlow(s.intent,s.api,async()=>{});
 assert.deepEqual(s.calls,['bind']);
});
test('no-auth CLI prepares before mounting and failed preparation never mounts',async()=>{
 const s=setup();s.intent.installed=true;s.intent.connectorId='actual-id';let ready=false;
 s.api.getConnectorConnection=async()=>noAuthState(ready?{}:{readiness:'preparing',authentication:{connectorId:'actual-id',status:'setup_required'},preparation:{status:'pending'}});
 s.api.prepareConnector=async()=>{s.calls.push('prepare');ready=true;return {status:'ready'};};
 await runMarketConnectorFlow(s.intent,s.api,async()=>{});
 assert.deepEqual(s.calls,['prepare','bind']);
 s.calls.length=0;ready=false;s.api.prepareConnector=async()=>({status:'failed',message:'CLI dependency missing'});
 await assert.rejects(runMarketConnectorFlow(s.intent,s.api,async()=>{}),/CLI dependency missing/);
 assert.deepEqual(s.calls,[]);
});
test('no-auth CLI readiness requires fresh ready preparation even when readiness remains no_auth',async()=>{
 for(const preparation of [undefined,{connectorId:'actual-id',status:'failed'}]) {
  const s=setup();s.intent.installed=true;s.intent.connectorId='actual-id';let ready=false;
  s.api.getConnectorConnection=async()=>noAuthState({preparation:ready?{connectorId:'actual-id',status:'ready'}:preparation});
  s.api.prepareConnector=async()=>{s.calls.push('prepare');ready=true;return {status:'ready'};};
  await runMarketConnectorFlow(s.intent,s.api,async()=>{});
  assert.deepEqual(s.calls,['prepare','bind']);
  s.calls.length=0;ready=false;
  s.api.prepareConnector=async()=>{s.calls.push('prepare');return {status:'ready'};};
  await assert.rejects(runMarketConnectorFlow(s.intent,s.api,async()=>{}),/notReady/);
  assert.deepEqual(s.calls,['prepare'],'prepare response cannot replace the refreshed snapshot');
 }
});
test('canceling no-auth CLI preparation prevents a late mount',async()=>{
 const s=setup();s.intent.installed=true;s.intent.connectorId='actual-id';
 s.api.getConnectorConnection=async()=>noAuthState({readiness:'preparing'});
 s.api.prepareConnector=async()=>{s.controller.abort();return {status:'ready'};};
 await assert.rejects(runMarketConnectorFlow(s.intent,s.api,async()=>{}));
 assert.deepEqual(s.calls,[]);
});
test('unavailable no-auth connector without CLI cannot report success',async()=>{
 const s=setup();s.intent.installed=true;s.intent.connectorId='actual-id';s.intent.mountAgent=false;
 s.api.getConnectorConnection=async()=>noAuthState({readiness:'unavailable',capabilities:{authMode:'none',hasCli:false}});
 await assert.rejects(runMarketConnectorFlow(s.intent,s.api,async()=>{}),/notReady/);
 assert.deepEqual(s.calls,[]);
});
test('no-auth readiness cannot hide failed authorization and mount an Agent',async()=>{
 const s=setup();s.intent.installed=true;s.intent.connectorId='actual-id';
 s.api.getConnectorConnection=async()=>noAuthState({authentication:{status:'failed',message:'Unavailable'}});
 await assert.rejects(runMarketConnectorFlow(s.intent,s.api,async()=>{}),/Unavailable/);
 assert.deepEqual(s.calls,[]);
});
test('market identity resolves to the installed Platform identity and one explicit add configures and mounts', async () => {
  const s = setup(); await runMarketConnectorFlow(s.intent, s.api, async () => {});
  assert.deepEqual(s.calls, ['install', 'connect', 'bind']);
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
  test(`explicit retry reconnects a still-configured account after ${status} authorization`, async () => {
    const s = setup(); let connected = false;
    const failed = { ...s.state(), configured: true, readiness: 'unavailable', authentication: s.session(status) };
    const ready = { ...failed, readiness: 'ready', authentication: s.session('authorized') };
    s.api.getConnectorConnection = async () => connected ? ready : failed;
    s.api.connectConnector = async () => { s.calls.push('connect'); connected = true; return ready.authentication; };
    s.api.setConnectorEnabled = async () => { s.calls.push('enable'); return ready; };
    await runMarketConnectorFlow({ ...s.intent, installed: true, connectorId: 'actual-id' }, s.api, async () => {});
    assert.deepEqual(s.calls, ['connect', 'bind']);
  });
}
test('still-configured token authorization failure returns to credential input without enabling', async () => {
  const s = setup();
  s.api.getConnectorConnection = async () => ({ ...s.state(), configured: true, readiness: 'unavailable', authentication: s.session('failed'), capabilities: { hasCli: false, authMode: 'token' } });
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

test('pending token verification is reported without mounting or silently opening chat', async () => {
  const s = setup();
  s.api.getConnectorConnection = async () => ({...s.state(), capabilities:{hasCli:false,authMode:'token'}});
  s.api.saveConnectorCredentials = async () => ({...s.state(), configured:true, readiness:'pending_verification', authentication:{...s.session('pending_verification'),pendingVerification:true}});
  const result = await runMarketConnectorFlow({...s.intent,installed:true,connectorId:'actual-id',credentials:{API_KEY:'new-value'}},s.api);
  assert.equal(result.result,'pending_verification');
  assert.deepEqual(s.calls,[]);
});
test('saved pending replacement credentials keep their status even if the next snapshot has valid old credentials', async () => {
  const s = setup();
  s.api.getConnectorConnection = async () => ({...s.state(), capabilities:{hasCli:false,authMode:'token'}});
  s.api.saveConnectorCredentials = async () => ({...s.state(), configured:true, readiness:'ready', authentication:{...s.session('authorized'),pendingVerification:true}});
  const result = await runMarketConnectorFlow({...s.intent,installed:true,connectorId:'actual-id',credentials:{API_KEY:'new-value'}},s.api);
  assert.equal(result.result,'pending_verification'); assert.deepEqual(s.calls,[]);
});
test('a ready connector with pending replacement credentials can still use its active credentials', async () => {
  const s = setup();
  s.api.getConnectorConnection = async () => ({...s.state(), configured:true, readiness:'ready', authentication:{...s.session('authorized'),pendingVerification:true}});
  const result = await runMarketConnectorFlow({...s.intent,installed:true,connectorId:'actual-id'},s.api);
  assert.equal(result.result,'complete'); assert.deepEqual(s.calls,['bind']);
});

test('explicit replacement credentials are submitted even when existing credentials are ready', async () => {
  const s = setup();
  const ready = {...s.state(), configured:true, readiness:'ready', authentication:s.session('authorized'), capabilities:{hasCli:false,authMode:'token'}};
  s.api.getConnectorConnection = async () => ready;
  s.api.saveConnectorCredentials = async input => { assert.equal(input.credentials.API_KEY,'replacement'); s.calls.push('save'); return ready; };
  await runMarketConnectorFlow({...s.intent,installed:true,connectorId:'actual-id',credentials:{API_KEY:'replacement'}},s.api);
  assert.deepEqual(s.calls,['save','bind']);
});

function mcpSetup() {
  const s = setup();
  s.intent.installed = true; s.intent.connectorId = 'actual-id';
  s.api.getConnectorConnection = async () => noAuthState({ capabilities: { authMode: 'none', hasCli: false, hasMcp: true } });
  s.agent = () => ({ agentKey: 'xiaojun', connectorIds: ['actual-id'], activeConnectorIds: ['actual-id'], reloadPending: false });
  s.api.setConnectorAgent = async () => s.agent();
  s.api.getConnectorAgent = async () => s.agent();
  s.tools = (mcp, extra = {}) => ({ agentKey: 'xiaojun', connectorId: 'actual-id', reloadPending: false, mcp, ...extra });
  s.component = (status, toolCount = 0, serverKey = 'actual-id') => ({ serverKey, status, toolCount });
  return s;
}

test('mounted MCP waits for every current component before completing the new-chat handoff', async () => {
  const s = mcpSetup(); const phases = []; let polls = 0, completed = false;
  s.intent.onPhase = phase => { phases.push(phase); if (phase === 'complete') completed = true; };
  s.api.getConnectorAgentTools = async target => {
    assert.equal(target.connectorId, 'actual-id'); assert.equal(target.agentKey, 'xiaojun'); polls++;
    return s.tools([s.component('ready', 2), s.component(polls < 3 ? 'syncing' : 'ready', 0, 'actual-id.secondary')]);
  };
  await runMarketConnectorFlow(s.intent, s.api, async () => {
    assert.equal(completed, false, 'mount and account readiness do not release the new-chat window');
    assert.equal(phases.at(-1), 'syncing');
  });
  assert.equal(polls, 3);
  assert.deepEqual(phases, ['mounting', 'syncing', 'complete']);
});

test('reload during MCP synchronization requires the newly published Agent snapshot', async () => {
  const s = mcpSetup(); let polls = 0;
  s.api.getConnectorAgentTools = async () => {
    polls++;
    if (polls === 1) return s.tools([s.component('ready', 5)], { reloadPending: true });
    return s.tools([s.component(polls === 2 ? 'pending' : 'ready', polls === 2 ? 0 : 1)]);
  };
  await runMarketConnectorFlow(s.intent, s.api, async () => {});
  assert.equal(polls, 3, 'a ready component while the old publication is being replaced cannot complete');
});

test('other connectors or a different Agent cannot supply MCP readiness', async () => {
  const s = mcpSetup();
  for (const extra of [{ connectorId: 'other-id' }, { agentKey: 'another-agent' }]) {
    s.api.getConnectorAgentTools = async () => s.tools([s.component('ready', 3)], extra);
    await assert.rejects(runMarketConnectorFlow(s.intent, s.api, async () => {}), /agentStateMismatch/);
  }
  s.api.setConnectorAgent = async () => ({ ...s.agent(), agentKey: 'another-agent' });
  s.api.getConnectorAgentTools = async () => assert.fail('a foreign mount must not reach tool synchronization');
  await assert.rejects(runMarketConnectorFlow(s.intent, s.api, async () => {}), /agentStateMismatch/);
});

test('MCP missing, unmounted, unavailable and ready-with-zero-tools states fail without polling forever', async () => {
  const s = mcpSetup();
  const cases = [
    [[], /toolsMissing/],
    [[s.component('unmounted')], /toolsMissing/],
    [[s.component('syncing'), s.component('unavailable', 0, 'actual-id.secondary')], /toolsUnavailable/],
    [[s.component('ready'), s.component('ready', 0, 'actual-id.secondary')], /toolsEmpty/],
  ];
  for (const [mcp, reason] of cases) {
    s.api.getConnectorAgentTools = async () => s.tools(mcp);
    await assert.rejects(runMarketConnectorFlow(s.intent, s.api, async () => assert.fail('terminal state must not wait')), reason);
  }
});

test('CLI and native flows do not read MCP tool state', async () => {
  for (const hasCli of [true, false]) {
    const s = setup(); const phases = [];
    s.api.getConnectorConnection = async () => noAuthState({ capabilities: { authMode: 'none', hasCli, hasMcp: false } });
    s.intent.onPhase = phase => phases.push(phase);
    s.api.getConnectorAgentTools = async () => assert.fail('pure CLI/native must not poll MCP');
    await runMarketConnectorFlow(s.intent, s.api, async () => {});
    assert.deepEqual(phases, ['installing', 'mounting', 'complete']);
  }
});

test('cancel during MCP polling rejects a late ready response without completing', async () => {
  const s = mcpSetup(); const phases = []; let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  s.intent.onPhase = phase => phases.push(phase);
  s.api.getConnectorAgentTools = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const operation = runMarketConnectorFlow(s.intent, s.api, async () => {});
  await started; s.controller.abort(); finish(s.tools([s.component('ready', 3)]));
  await assert.rejects(operation);
  assert.deepEqual(phases, ['mounting', 'syncing']);
});

test('MCP synchronization timeout is bounded even when published components remain pending', async () => {
  let now = 1000;
  const clock = class extends Date { static now() { return now; } };
  const timed = { exports: {} };
  vm.runInNewContext(compiled, { module: timed, exports: timed.exports, URL, Date: clock, Promise, Error, setTimeout, clearTimeout });
  const s = mcpSetup();
  s.api.getConnectorAgentTools = async () => s.tools([s.component('pending')]);
  await assert.rejects(timed.exports.runMarketConnectorFlow(s.intent, s.api, async () => { now += 61000; }), /toolsSyncTimeout/);
});
