import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { requestSsoTokens, parseSsoTokenResponse } = require('../dist-electron/main/modules/identity/sso-token-client.js');
const { createSsoCredentialStore } = require('../dist-electron/main/modules/identity/sso-credentials.js');
const { createDesktopSsoController } = require('../dist-electron/main/modules/identity/sso-controller.js');
const { buildOidcConfigFromRecord, resolveDesktopSsoConfigPath, getDesktopSsoStatus, clearDesktopSsoLocalSession, desktopSsoRuntimeState } = require('../dist-electron/main/modules/identity/oidc-sso.js');
const { getDesktopSsoIdTokenFilePath, getSecretsRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
const { getSessionPath, getDesktopSsoUserInfoFilePath } = require('../dist-electron/main/modules/identity/sso-paths.js');
const { getDesktopSsoAvatarCacheDir } = require('../dist-electron/main/modules/identity/avatar-storage.js');
const { subscribeDesktopSsoCredentialRevocation } = require('../dist-electron/main/modules/identity/sso-state.js');
const origin = 'https://ai.example.test';
const record = { enabled:true, browserOrigin:origin, loginUrl:origin+'/login',
  tokenExchange:{url:origin+'/authorization'}, tokenRefresh:{url:origin+'/api/login/oidc/refresh'},
  userInfo:{url:origin+'/userinfo',authMode:'cookie',subPath:'data.staffno'}, accessTokenCookie:{url:origin,name:'id_token'} };
const config = buildOidcConfigFromRecord(record);
const jwt = (sub='oidc-sub', exp=Date.now()/1000+3600) => [ {alg:'RS256'}, {sub,iss:'https://issuer.example.test',aud:'client',iat:Math.floor(Date.now()/1000),exp} ].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.')+'.signature';
const response = (status, data) => ({ok:status>=200&&status<300,status,json:async()=>data});
const previous = async () => parseSsoTokenResponse({id_token:jwt(),refresh_token:'refresh & secret'},config,()=>assert.fail());
const appFor = root => ({getPath:n=>n==='home'?root:path.join(root,n)});

for (const status of [400,401,404,500,502]) {
  test(`refresh classifies HTTP ${status} and bounds retries`,async()=>{
    let calls=0;const waits=[];
    await assert.rejects(requestSsoTokens(config,async(_url,init)=>{
      calls++;assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)),{grant_type:'refresh_token',refresh_token:'refresh & secret'});
      assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Cookie,undefined);
      return response(status,{error_description:'DO NOT LEAK'});
    },{previous:await previous(),signal:AbortSignal.timeout(1000),wait:async ms=>{waits.push(ms)}}),e=>!e.message.includes('DO NOT LEAK'));
    assert.equal(calls,status===502?3:1);assert.deepEqual(waits,status===502?[1000,3000]:[]);
  });
}
test('refresh selects id_token, ignores access_token, and retains an unrotated refresh token',async()=>{
  const p=await previous();const next=await requestSsoTokens(config,async()=>response(200,{id_token:jwt(),access_token:jwt('different')}),{previous:p,signal:AbortSignal.timeout(1000)});
  assert.equal(next.subject,'oidc-sub');assert.equal(next.refreshToken,p.refreshToken);
  await assert.rejects(parseSsoTokenResponse({id_token:jwt('other')},config,()=>{},p));
  await assert.rejects(parseSsoTokenResponse({id_token:jwt(),refresh_token:''},config,()=>{},p));
  await assert.rejects(parseSsoTokenResponse({id_token:jwt('oidc-sub',1)},config,()=>{},p));
});
test('config rejects mixed protocols, cross-origin endpoints and incomplete refresh configuration',()=>{
  for(const change of [{sessionRestore:{authMode:'bearer'}},{cookieAccessTokenExchange:{url:origin}},{tokenRefresh:{url:'https://other.test/refresh'}},{tokenRefresh:undefined},{tokenRefresh:{url:origin+'/refresh?token=x'}}]){
    assert.throws(()=>buildOidcConfigFromRecord({...record,...change}));
  }
});
test('private credential store uses owner-only permissions and rejects mismatched environments',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-credentials-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=appFor(root);const store=createSsoCredentialStore(app,'darwin');const value=await previous();store.save(value);
  assert.equal(store.read(origin).refreshToken,value.refreshToken);
  assert.throws(()=>store.read('https://other.test'));
  assert.equal(fs.statSync(path.join(getSecretsRoot(app),'sso-credentials.json')).mode & 0o777,0o600);
  assert.equal(fs.statSync(getSecretsRoot(app)).mode & 0o777,0o700);
  store.clear();assert.equal(store.read(origin),null);
});
function fixture(t,handler){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-controller-refresh-'));
  const app=Object.assign(new EventEmitter(),appFor(root));
  t.after(()=>{app.emit('before-quit');desktopSsoRuntimeState.callbackHooks={};clearDesktopSsoLocalSession(app);fs.rmSync(root,{recursive:true,force:true});});
  const file=resolveDesktopSsoConfigPath(app,'darwin');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record));
  const events=[];const sets=[];const restores=[];
  const session={cookies:{get:async()=>[{name:'SESSION',value:'cookie',domain:'ai.example.test',path:'/'}],set:async c=>sets.push(c),remove:async()=>{},flushStore:async()=>{}},flushStorageData:async()=>{},fetch:handler};
  const options={app,platform:'darwin',session:{defaultSession:session},getMainWindow:()=>({webContents:{send:(_c,s)=>events.push(s)}}),onRestoreResult:r=>restores.push(r),openBrowserUrl:async()=>{},openExternal:async()=>{}};
  const controller=createDesktopSsoController(options);return {app,controller,options,events,sets,restores};
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: OIDC timer renews once without login steps, missing token files or window activation`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 10, 1) });
    const first = jwt('oidc-sub', Date.now() / 1000 + 8 * 3600);
    let requests = 0;
    const f = fixture(t, async (url, init) => {
      if (url.endsWith('/userinfo')) return response(200, { data: { staffno: 'staff-1', avatar: origin + '/avatar.png' } });
      requests++;
      if (url.endsWith('/refresh')) assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
      return response(200, { id_token: requests === 1 ? first : jwt('oidc-sub', Date.now() / 1000 + 8 * 3600), refresh_token: 'r-' + requests });
    });
    const configPath = resolveDesktopSsoConfigPath(f.app, 'darwin');
    fs.writeFileSync(configPath, JSON.stringify({ ...record, userInfo: { ...record.userInfo, avatarUrlPath: 'data.avatar' } }));
    // Simulate both window branches while retaining the host-native credential store.
    f.options.platform = platform;
    const activations = [];
    f.app.focus = () => activations.push('app.focus');
    f.options.getMainWindow = () => ({
      isDestroyed: () => false, isMinimized: () => true,
      restore: () => activations.push('restore'), show: () => activations.push('show'),
      focus: () => activations.push('focus'), setAlwaysOnTop: value => activations.push(['top', value]),
      webContents: { send: (_channel, value) => f.events.push(value) }
    });
    desktopSsoRuntimeState.callbackHooks = { onStatusChanged: f.controller.broadcastStatus, onReturnToAppRequested: f.controller.returnToApp };
    await f.controller.exchangeBrowserCookieAccessToken();
    const tokenFile = getDesktopSsoIdTokenFilePath(f.app);
    const userFile = path.join(path.dirname(tokenFile), 'sso-user-info.json');
    const avatarDir = getDesktopSsoAvatarCacheDir(f.app);
    fs.mkdirSync(avatarDir, { recursive: true });
    const avatarFile = path.join(avatarDir, 'cached-avatar.png');
    fs.writeFileSync(avatarFile, 'cached image');
    f.events.length = 0; f.restores.length = 0; activations.length = 0;
    let revocations = 0;
    t.after(subscribeDesktopSsoCredentialRevocation(() => { revocations++; }));
    const removals = [];
    const rm = fs.rmSync, rename = fs.renameSync;
    t.mock.method(fs, 'rmSync', (file, options) => { removals.push(file); return rm(file, options); });
    let replacements = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === tokenFile) {
        replacements++;
        assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), first);
        assert.equal(desktopSsoRuntimeState.currentBusinessToken, first);
        assert.equal(fs.existsSync(userFile), true);
        assert.equal(fs.existsSync(avatarFile), true);
      }
      return rename(from, to);
    });
    t.mock.timers.tick((8 * 60 - 15) * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 2);
    assert.equal(replacements, 1);
    assert.equal(f.events.length, 1);
    assert.equal(f.restores.length, 1);
    assert.deepEqual(f.events[0].completedSteps, { session: true, userInfo: true, accessToken: true });
    assert.equal(f.events[0].user.sub, 'staff-1');
    assert.ok(f.restores[0].accessToken);
    assert.equal(f.restores[0].accessToken, fs.readFileSync(tokenFile, 'utf8').trim());
    assert.equal(revocations, 0, 'A successful renewal must never withdraw the previous identity');
    assert.deepEqual(activations, []);
    assert.equal(removals.some(file => [tokenFile, userFile, avatarDir].includes(file)), false);
    assert.equal(fs.existsSync(avatarFile), true);
    for (let i = 0; i < 10; i++) await f.controller.ensureBusinessToken();
    assert.equal(requests, 2);
    f.controller.returnToApp();
    assert.deepEqual(activations, platform === 'darwin'
      ? ['restore', 'show', 'app.focus', 'focus']
      : ['restore', 'show', ['top', true], 'focus', ['top', false]]);
  });
}

test('unchanged OIDC expiry keeps the expiry deadline and only repeats when a later check requests renewal', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 10, 1) });
  const unchanged = jwt('oidc-sub', Date.now() / 1000 + 8 * 3600);
  let requests = 0;
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const f = fixture(t, async url => url.endsWith('/userinfo') ? response(200, { data: { staffno: 'staff-1' } })
    : (requests++, response(200, { id_token: unchanged, refresh_token: 'r-' + requests })));
  await f.controller.exchangeBrowserCookieAccessToken();
  t.mock.timers.tick((8 * 60 - 15) * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
  t.mock.timers.tick(5 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2, 'An unchanged expiry must not create an immediate renewal timer loop');
  await f.controller.ensureBusinessToken();
  assert.equal(requests, 3, 'The five-minute fallback may still renew a token inside the refresh window');
  assert.equal(logs.filter(([event, data]) => event === '[sso-renewal] completed' && data.expiryAdvanced === false).length, 2);
  assert.equal(JSON.stringify(logs).includes(unchanged), false);
  t.mock.timers.tick(10 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getDesktopSsoStatus(f.app).authenticated, false);
  assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)), false);
  assert.ok(createSsoCredentialStore(f.app, 'darwin').read(origin).refreshToken);
});

for (const operation of ['stage', 'replace']) {
  for (const fileIndex of [0, 1, 2]) {
    test(`OIDC ${operation} failure for file ${fileIndex + 1} rolls back all projections and retains rotated credentials`, async t => {
      let requests = 0;
      const f = fixture(t, async url => url.endsWith('/userinfo') ? response(200, { data: { staffno: 'staff-1' } })
        : response(200, { id_token: jwt('oidc-sub', Date.now() / 1000 + 3600 + ++requests), refresh_token: 'r-' + requests }));
      await f.controller.exchangeBrowserCookieAccessToken();
      desktopSsoRuntimeState.callbackHooks = { onStatusChanged: f.controller.broadcastStatus };
      const files = [getSessionPath(f.app), getDesktopSsoUserInfoFilePath(f.app), getDesktopSsoIdTokenFilePath(f.app)];
      const snapshots = files.map(file => fs.readFileSync(file));
      const status = getDesktopSsoStatus(f.app);
      f.events.length = 0; f.restores.length = 0;
      let injected = false;
      const method = operation === 'stage' ? 'writeFileSync' : 'renameSync';
      const original = fs[method];
      const mocked = t.mock.method(fs, method, (...args) => {
        const target = String(args[operation === 'stage' ? 0 : 1]);
        const matches = operation === 'stage'
          ? path.basename(target).startsWith(`.${path.basename(files[fileIndex])}.`)
          : target === files[fileIndex];
        if (!injected && matches) {
          injected = true;
          throw new Error('simulated publication failure');
        }
        return original(...args);
      });
      try { await assert.rejects(f.controller.ensureBusinessToken(true)); }
      finally { mocked.mock.restore(); }
      assert.equal(injected, true);
      files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), snapshots[i]));
      assert.deepEqual(getDesktopSsoStatus(f.app), status);
      assert.equal(desktopSsoRuntimeState.currentBusinessToken, snapshots[2].toString().trim());
      assert.equal(f.events.length, 0);
      assert.equal(f.restores.length, 0);
      assert.equal(createSsoCredentialStore(f.app, 'darwin').read(origin).refreshToken, 'r-2');
      for (const dir of new Set(files.map(file => path.dirname(file)))) {
        assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
      }
    });
  }
}

test('login saves credentials; restart refresh works without Cookie; concurrent refresh is single-flight',async t=>{
  let exchanges=0,refreshes=0;let cookieAvailable=true;
  const f=fixture(t,async(url,init)=>{
    if(url.endsWith('/userinfo'))return response(200,{data:{staffno:'staff-1'}});
    if(url.endsWith('/authorization')){exchanges++;assert.match(init.headers.Cookie,/SESSION/);return response(200,{id_token:jwt(),refresh_token:'refresh-1',access_token:jwt('wrong')});}
    refreshes++;assert.equal(new URLSearchParams(init.body).get('refresh_token'),'refresh-1');return response(200,{id_token:jwt(),refresh_token:'refresh-2'});
  });
  await f.controller.exchangeBrowserCookieAccessToken();assert.equal(exchanges,1);assert.equal(getDesktopSsoStatus(f.app).authenticated,true);
  const file=getDesktopSsoIdTokenFilePath(f.app);assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(path.join(getSecretsRoot(f.app),'sso-credentials.json'),'utf8')).refreshToken,'refresh-1');
  f.options.session.defaultSession.cookies.get=async()=>[];
  const restarted=createDesktopSsoController(f.options);
  const [a,b]=await Promise.all([restarted.ensureBusinessToken(true),restarted.ensureBusinessToken(true)]);
  assert.equal(a,b);assert.equal(refreshes,1);
  assert.equal(createSsoCredentialStore(f.app,'darwin').read(origin).refreshToken,'refresh-2');
  assert.equal(getDesktopSsoStatus(f.app).user.sub,'staff-1');
  assert.equal(JSON.stringify(f.events).includes('refresh-2'),false);
});
test('refresh 401 clears private and projected credentials',async t=>{
  let failed=false;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):failed?response(401,{}):response(200,{id_token:jwt(),refresh_token:'r'}));
  await f.controller.exchangeBrowserCookieAccessToken();failed=true;
  await assert.rejects(f.controller.ensureBusinessToken(true));
  assert.equal(getDesktopSsoStatus(f.app).authenticated,false);
  assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);
  assert.equal(createSsoCredentialStore(f.app,'darwin').read(origin),null);
});
test('late refresh after logout cannot recreate credentials or token file',async t=>{
  let release;let waiting=false;
  const f=fixture(t,async url=>{
    if(url.endsWith('/userinfo'))return response(200,{data:{staffno:'staff-1'}});
    if(!waiting)return response(200,{id_token:jwt(),refresh_token:'r'});
    return new Promise(resolve=>{release=()=>resolve(response(200,{id_token:jwt(),refresh_token:'rotated'}));});
  });
  await f.controller.exchangeBrowserCookieAccessToken();waiting=true;
  const flight=f.controller.ensureBusinessToken(true);await new Promise(r=>setImmediate(r));
  clearDesktopSsoLocalSession(f.app);release();assert.equal(await flight,'');
  assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);
  assert.equal(createSsoCredentialStore(f.app,'darwin').read(origin),null);
});
test('a temporary failure stops automatic requests until an explicit retry, including after expiry',async t=>{
  let fail=false,requests=0;
  const f=fixture(t,async url=>{
    if(url.endsWith('/userinfo'))return response(200,{data:{staffno:'staff-1'}});
    requests++;return fail?response(500,{}):response(200,{id_token:jwt(),refresh_token:'r'});
  });
  await f.controller.exchangeBrowserCookieAccessToken();fail=true;
  await assert.rejects(f.controller.ensureBusinessToken(true));assert.equal(requests,2);
  assert.equal(getDesktopSsoStatus(f.app).authenticated,true);
  await assert.rejects(f.controller.ensureBusinessToken(true));await f.controller.retryDesktopSsoSessionRestoreIfNeeded();assert.equal(requests,2);
  const now=Date.now;Date.now=()=>now()+7200_000;
  try {await assert.rejects(f.controller.ensureBusinessToken());assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);}finally{Date.now=now;}
  fail=false;await f.controller.retrySession();assert.equal(requests,3);assert.equal(getDesktopSsoStatus(f.app).authenticated,true);
});
test('startup restores from private credentials without requiring browser session metadata',async t=>{
  let refreshes=0;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):(refreshes++,response(200,{id_token:jwt(),refresh_token:'r'})));
  createSsoCredentialStore(f.app,'darwin').save({...await previous(),accountId:'staff-1'});
  f.options.session.defaultSession.cookies.get=async()=>[];
  const result=await f.controller.restoreDesktopSsoSession();
  assert.equal(result.state,'authenticated');assert.equal(refreshes,1);
});
test('rotated refresh credential survives userinfo failure without publishing a new identity',async t=>{
  let fail=false;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(fail?500:200,{data:{staffno:'staff-1'}}):response(200,{id_token:jwt(),refresh_token:fail?'rotated':'first'}));
  await f.controller.exchangeBrowserCookieAccessToken();const old=fs.readFileSync(getDesktopSsoIdTokenFilePath(f.app),'utf8');fail=true;
  await assert.rejects(f.controller.ensureBusinessToken(true));
  assert.equal(createSsoCredentialStore(f.app,'darwin').read(origin).refreshToken,'rotated');
  assert.equal(fs.readFileSync(getDesktopSsoIdTokenFilePath(f.app),'utf8'),old);
});
test('legacy token file is removed only after successful credential recovery',async t=>{
  let fail=true;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):response(fail?500:200,{id_token:jwt(),refresh_token:'r'}));
  const legacy=path.join(path.dirname(getDesktopSsoIdTokenFilePath(f.app)),'sso-access-token.txt');
  fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.writeFileSync(legacy,jwt());
  await f.controller.restoreDesktopSsoSession();assert.equal(fs.existsSync(legacy),true);assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);
  fail=false;await f.controller.retrySession();assert.equal(fs.existsSync(legacy),false);assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),true);
});
test('gateway logout uses Cookie GET without following its EIAM redirect',async t=>{
  let captured;
  const f=fixture(t,async(url,init)=>{captured={url,init};return response(302,{});});
  const file=resolveDesktopSsoConfigPath(f.app,'darwin');fs.writeFileSync(file,JSON.stringify({...record,logoutUrl:origin+'/api/login/oidc/logout'}));
  assert.equal(await f.controller.logoutWebSession(),true);
  assert.equal(captured.init.method,'GET');assert.equal(captured.init.redirect,'manual');assert.match(captured.init.headers.Cookie,/SESSION/);assert.equal(captured.init.headers.Authorization,undefined);
});
test('expiry withdraws the business projection even after automatic renewal stops',async t=>{
  let count=0;const short=jwt('oidc-sub',Date.now()/1000+0.7);
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):++count===1?response(200,{id_token:short,refresh_token:'r'}):response(500,{}));
  await f.controller.exchangeBrowserCookieAccessToken();
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.equal(count,2);assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);
  assert.equal(getDesktopSsoStatus(f.app).authenticated,false);
  assert.ok(createSsoCredentialStore(f.app,'darwin').read(origin).refreshToken);
});
test('a refresh already in flight may finish after expiry while the old proof is withdrawn',async t=>{
  let count=0,aborted=false;const short=jwt('oidc-sub',Date.now()/1000+0.7);
  const f=fixture(t,async(url,init)=>{
    if(url.endsWith('/userinfo'))return response(200,{data:{staffno:'staff-1'}});
    if(++count===1)return response(200,{id_token:short,refresh_token:'r'});
    await new Promise(resolve=>setTimeout(resolve,900));aborted=init.signal.aborted;
    return response(200,{id_token:jwt(),refresh_token:'rotated'});
  });
  await f.controller.exchangeBrowserCookieAccessToken();
  await new Promise(resolve=>setTimeout(resolve,1800));
  assert.equal(aborted,false);assert.equal(count,2);assert.equal(getDesktopSsoStatus(f.app).authenticated,true);
  assert.equal(createSsoCredentialStore(f.app,'darwin').read(origin).refreshToken,'rotated');
});
test('rotated credentials stay recoverable in memory when atomic persistence fails',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-save-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=appFor(root),store=createSsoCredentialStore(app,'darwin'),value=await previous();
  fs.mkdirSync(path.join(getSecretsRoot(app),'sso-credentials.json'),{recursive:true});
  assert.throws(()=>store.save(value));assert.equal(store.read(origin).refreshToken,value.refreshToken);
});

test('failure status exposes a fixed stage and reason without upstream exception text',async t=>{
 const f=fixture(t,async()=>response(200,{access_token:jwt(),refresh_token:'DO-NOT-LEAK'}));
 await assert.rejects(f.controller.exchangeBrowserCookieAccessToken(),e=>e.message.includes('id_token')&&!e.message.includes('DO-NOT-LEAK'));
 const status=getDesktopSsoStatus(f.app);
 assert.match(status.error,/id_token/);
 assert.equal(JSON.stringify(f.events).includes('DO-NOT-LEAK'),false);
});
test('userinfo field mapping errors remain distinct from token exchange failures',async t=>{
 const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{different:'private-account'}}):response(200,{id_token:jwt(),refresh_token:'r'}));
 await assert.rejects(f.controller.exchangeBrowserCookieAccessToken(),e=>!e.message.includes('private-account'));
 const {describeSsoFailure,SsoKnownFailure}=require('../dist-electron/main/modules/identity/sso-failures.js');
 assert.equal(getDesktopSsoStatus(f.app).error,describeSsoFailure('accountParse',new SsoKnownFailure('accountMissing')).message);
});
test('unexpected errors never copy native messages or token-shaped text into diagnostics',()=>{
 const {describeSsoFailure}=require('../dist-electron/main/modules/identity/sso-failures.js');
 const failure=describeSsoFailure('syncCookies',new Error('token=eyJ.secret.signature Cookie=private refresh_token=private'));
 assert.equal(failure.code,'unexpected');assert.doesNotMatch(failure.message,/eyJ|Cookie=|refresh_token=|private/);
});

test('legacy encrypted credentials are ignored without OS access and removed after a new login',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-no-keychain-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=appFor(root),store=createSsoCredentialStore(app,'darwin');
 const legacy=path.join(getSecretsRoot(app),'sso-credentials.enc');
 fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.writeFileSync(legacy,'unreadable-legacy-ciphertext');
 assert.equal(store.read(origin),null);assert.equal(fs.readFileSync(legacy,'utf8'),'unreadable-legacy-ciphertext');
 const value=await previous();store.save(value);assert.equal(fs.existsSync(legacy),false);
 assert.equal(store.read(origin).refreshToken,value.refreshToken);
});

test('cancelled OIDC login rejects a late token response without restoring the old attempt', async t => {
  const { startDesktopSsoLogin, cancelDesktopSsoLogin } = require('../dist-electron/main/modules/identity/oidc-sso.js');
  let release;
  const f = fixture(t, async () => new Promise(resolve => {
    release = () => resolve(response(200, { id_token: jwt(), refresh_token: 'late-refresh' }));
  }));
  const login = await startDesktopSsoLogin(f.app);
  assert.equal(login.ok, true, login.message);
  const flight = f.controller.exchangeBrowserCookieAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  cancelDesktopSsoLogin(f.app);
  const cancelled = getDesktopSsoStatus(f.app);
  release();
  assert.equal(await flight, '');
  assert.deepEqual(getDesktopSsoStatus(f.app), cancelled);
  assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)), false);
  assert.equal(createSsoCredentialStore(f.app, 'darwin').read(origin), null);
});
