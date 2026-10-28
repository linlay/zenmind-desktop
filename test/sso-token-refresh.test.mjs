import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestSsoTokens, parseSsoTokenResponse } = require('../dist-electron/main/modules/identity/sso-token-client.js');
const { createSsoCredentialStore } = require('../dist-electron/main/modules/identity/sso-credentials.js');
const { createDesktopSsoController } = require('../dist-electron/main/modules/identity/sso-controller.js');
const { buildOidcConfigFromRecord, resolveDesktopSsoConfigPath, getDesktopSsoStatus, clearDesktopSsoLocalSession, desktopSsoRuntimeState } = require('../dist-electron/main/modules/identity/oidc-sso.js');
const { getDesktopSsoIdTokenFilePath, getSecretsRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths.js');
const origin = 'https://ai.example.test';
const record = { enabled:true, browserOrigin:origin, loginUrl:origin+'/login',
  tokenExchange:{url:origin+'/authorization'}, tokenRefresh:{url:origin+'/api/login/oidc/refresh'},
  userInfo:{url:origin+'/userinfo',authMode:'cookie',subPath:'data.staffno'}, accessTokenCookie:{url:origin,name:'id_token'} };
const config = buildOidcConfigFromRecord(record);
const jwt = (sub='oidc-sub', exp=Date.now()/1000+3600) => [ {alg:'RS256'}, {sub,iss:'https://issuer.example.test',aud:'client',iat:Math.floor(Date.now()/1000),exp} ].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.')+'.signature';
const response = (status, data) => ({ok:status>=200&&status<300,status,json:async()=>data});
const protection = {available:()=>true,encrypt:s=>Buffer.from('encrypted:'+s),decrypt:b=>b.toString().slice(10)};
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
test('encrypted store rejects unavailable encryption and mismatched environments',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-credentials-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=appFor(root);const store=createSsoCredentialStore(app,'darwin',protection);const value=await previous();store.save(value);
  assert.equal(store.read(origin).refreshToken,value.refreshToken);
  assert.throws(()=>store.read('https://other.test'));
  const blocked=createSsoCredentialStore(app,'darwin',{...protection,available:()=>false});assert.throws(()=>blocked.read(origin));
  store.clear();assert.equal(store.read(origin),null);
});
function fixture(t,handler){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-controller-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=appFor(root);const file=resolveDesktopSsoConfigPath(app,'darwin');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record));
  const events=[];const sets=[];
  const session={cookies:{get:async()=>[{name:'SESSION',value:'cookie',domain:'ai.example.test',path:'/'}],set:async c=>sets.push(c),remove:async()=>{},flushStore:async()=>{}},flushStorageData:async()=>{},fetch:handler};
  const options={app,platform:'darwin',credentialProtection:protection,session:{defaultSession:session},getMainWindow:()=>({webContents:{send:(_c,s)=>events.push(s)}}),openBrowserUrl:async()=>{},openExternal:async()=>{}};
  const controller=createDesktopSsoController(options);return {app,controller,options,events,sets};
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
  assert.equal(fs.readFileSync(path.join(getSecretsRoot(f.app),'sso-credentials.enc'),'utf8').startsWith('encrypted:'),true);
  f.options.session.defaultSession.cookies.get=async()=>[];
  const restarted=createDesktopSsoController(f.options);
  const [a,b]=await Promise.all([restarted.ensureBusinessToken(true),restarted.ensureBusinessToken(true)]);
  assert.equal(a,b);assert.equal(refreshes,1);
  assert.equal(createSsoCredentialStore(f.app,'darwin',protection).read(origin).refreshToken,'refresh-2');
  assert.equal(getDesktopSsoStatus(f.app).user.sub,'staff-1');
  assert.equal(JSON.stringify(f.events).includes('refresh-2'),false);
});
test('refresh 401 clears encrypted and projected credentials',async t=>{
  let failed=false;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):failed?response(401,{}):response(200,{id_token:jwt(),refresh_token:'r'}));
  await f.controller.exchangeBrowserCookieAccessToken();failed=true;
  await assert.rejects(f.controller.ensureBusinessToken(true));
  assert.equal(getDesktopSsoStatus(f.app).authenticated,false);
  assert.equal(fs.existsSync(getDesktopSsoIdTokenFilePath(f.app)),false);
  assert.equal(createSsoCredentialStore(f.app,'darwin',protection).read(origin),null);
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
  assert.equal(createSsoCredentialStore(f.app,'darwin',protection).read(origin),null);
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
test('startup restores from encrypted credentials without requiring browser session metadata',async t=>{
  let refreshes=0;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(200,{data:{staffno:'staff-1'}}):(refreshes++,response(200,{id_token:jwt(),refresh_token:'r'})));
  createSsoCredentialStore(f.app,'darwin',protection).save({...await previous(),accountId:'staff-1'});
  f.options.session.defaultSession.cookies.get=async()=>[];
  const result=await f.controller.restoreDesktopSsoSession();
  assert.equal(result.state,'authenticated');assert.equal(refreshes,1);
});
test('rotated refresh credential survives userinfo failure without publishing a new identity',async t=>{
  let fail=false;
  const f=fixture(t,async url=>url.endsWith('/userinfo')?response(fail?500:200,{data:{staffno:'staff-1'}}):response(200,{id_token:jwt(),refresh_token:fail?'rotated':'first'}));
  await f.controller.exchangeBrowserCookieAccessToken();const old=fs.readFileSync(getDesktopSsoIdTokenFilePath(f.app),'utf8');fail=true;
  await assert.rejects(f.controller.ensureBusinessToken(true));
  assert.equal(createSsoCredentialStore(f.app,'darwin',protection).read(origin).refreshToken,'rotated');
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
  assert.ok(createSsoCredentialStore(f.app,'darwin',protection).read(origin).refreshToken);
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
  assert.equal(createSsoCredentialStore(f.app,'darwin',protection).read(origin).refreshToken,'rotated');
});
test('rotated credentials stay recoverable in memory when atomic persistence fails',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sso-save-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=appFor(root),store=createSsoCredentialStore(app,'darwin',protection),value=await previous();
  fs.mkdirSync(path.join(getSecretsRoot(app),'sso-credentials.enc'),{recursive:true});
  assert.throws(()=>store.save(value));assert.equal(store.read(origin).refreshToken,value.refreshToken);
});
