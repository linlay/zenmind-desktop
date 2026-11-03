import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { requestVisibleMarketJson, loadMarketplaceCatalog } = require('../dist-electron/main/modules/marketplace/common.js');
const { readMarketSkillContent } = require('../dist-electron/main/modules/marketplace/skill-detail.js');
const { getMainLocale, setMainLocaleForCurrentProcess } = require('../dist-electron/main/support/i18n/main-i18n.js');
const base = 'https://market.example/api/v1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-visibility-'));
const app = { getPath: name => path.join(root,name), getVersion: () => '0.4.6' };
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const types = ['skill', 'mcp', 'connector'];
function setup() {
 let viewer = null; const calls = []; let tokenCalls = 0;
 const options = { apiBaseUrl: base, readMarketViewer: () => viewer,
  issueMarketAccessToken: async () => { tokenCalls++; return viewer; },
  fetchImpl: async (url, init) => {
   const auth = new Headers(init.headers).get('Authorization');calls.push({url,init,auth});
   if (url.endsWith('/auth/me')) return Response.json({user:{id:auth?.slice(7)}});
   if (url.endsWith('/skill-md')) return auth==='Bearer alice' ? Response.json({content:'# Private skill'}) : new Response('denied',{status:403});
   const user = auth?.slice(7);
   return Response.json({schemaVersion:1,items:types.flatMap(type => [
    {id:type+'-all',type,name:'Public',version:'1.0.0'},
    ...(user==='alice' ? [{id:type+'-single',type,name:'Alice only',version:'1.0.0'}] : []),
    ...(['alice','bob'].includes(user) ? [{id:type+'-multiple',type,name:'Selected people',version:'1.0.0'}] : [])
   ])});
  }
 };
 return {options,calls,setViewer: value=>{viewer=value},tokenCalls:()=>tokenCalls};
}
test('all resource types consume the server-visible catalog for anonymous, single and multiple users', async () => {
 const s=setup();
 for(const user of [null,'alice','bob','charlie',null]) {
  s.setViewer(user);const result=await loadMarketplaceCatalog(app,s.options);
  assert.equal(result.offline,false);
  for(const type of types) assert.deepEqual(result.catalog.items.filter(x=>x.type===type).map(x=>x.id),[type+'-all',...(user==='alice'?[type+'-single']:[]),...(['alice','bob'].includes(user)?[type+'-multiple']:[])]);
 }
 for(const call of s.calls) assert.equal(call.init.cache, 'no-store');
 const anonymous=s.calls.filter(c=>!c.auth);assert.equal(anonymous.length,2);assert.ok(anonymous.every(c=>c.init.credentials==='omit'&&!c.init.headers));
});
test('restricted skill documentation uses the same identity and does not expose denied response bodies', async () => {
 const s=setup();s.setViewer('alice');assert.equal((await readMarketSkillContent(app,'private',s.options)).content,'# Private skill');
 s.setViewer('bob');await assert.rejects(readMarketSkillContent(app,'private',s.options),/market_skill_content_unavailable/);
});
test('expired identity is refreshed before catalog endpoints can silently degrade to anonymous', async () => {
 const s=setup();s.setViewer('alice');const reasons=[];
 s.options.issueMarketAccessToken=async (_,reason)=>{reasons.push(reason);return reasons.includes('unauthorized')?'fresh':'expired'};
 s.options.fetchImpl=async (url,init)=>{const token=new Headers(init.headers).get('Authorization');return token==='Bearer expired'?new Response('',{status:401}):Response.json(url.endsWith('/auth/me')?{user:{id:'alice'}}:{items:[]});};
 await requestVisibleMarketJson(app,base+'/desktop/catalog',s.options);
 assert.deepEqual(reasons,['missing','unauthorized','missing']);
});
test('signed-out browsing never requests credentials; signed-in reads fail closed without a token', async () => {
 const s=setup();await requestVisibleMarketJson(app,base+'/desktop/catalog',s.options);assert.equal(s.tokenCalls(),0);
 s.setViewer('alice');s.options.issueMarketAccessToken=async()=>'';
 await assert.rejects(requestVisibleMarketJson(app,base+'/desktop/catalog',s.options),/authentication is unavailable/);
});
test('account changes discard an old response and custom catalog URLs never receive credentials', async () => {
 const s=setup();s.setViewer('alice');const fetch=s.options.fetchImpl;
 s.options.fetchImpl=async(url,init)=>{const r=await fetch(url,init);if(url.endsWith('/desktop/catalog'))s.setViewer('bob');return r};
 await assert.rejects(requestVisibleMarketJson(app,base+'/desktop/catalog',s.options),/identity changed/);
 await assert.rejects(requestVisibleMarketJson(app,'https://elsewhere.example/catalog',s.options),/configured API/);
 assert.ok(s.calls.every(c=>c.url.startsWith(base)));
});

test('catalog transport failures give localized network guidance and recover on the next load', async t => {
 const previousLocale=getMainLocale();t.after(()=>setMainLocaleForCurrentProcess(previousLocale));
 const failures=[
  new TypeError('fetch failed'), new TypeError('Failed to fetch'),
  new TypeError('Load failed'), new DOMException('A network error occurred.', 'NetworkError'),
  ...['EACCES','EPERM','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH'].map(code =>
   new Error('network unavailable',{cause:Object.assign(new Error('request blocked'),{code})}))
 ];
 for (const [locale,message] of [
  ['zh-CN','暂时无法连接市场，请检查网络连接后重试。'],
  ['en-US','Unable to connect to the market. Check your network connection and try again.']
 ]) {
  setMainLocaleForCurrentProcess(locale);
  const s=setup();const fetch=s.options.fetchImpl;
  for (const failure of failures) {
   s.options.fetchImpl=async()=>{throw failure};
   const result=await loadMarketplaceCatalog(app,s.options);
   assert.equal(result.offline,true);
   assert.deepEqual(result.catalog.items,[]);
   assert.equal(result.message,message);
  }
  // An HTTP error that mentions fetch is not evidence that the user is offline.
  s.options.fetchImpl=async()=>Response.json({message:'fetch failed on the server'},{status:403});
  const denied=await loadMarketplaceCatalog(app,s.options);
  assert.notEqual(denied.message,message);
  assert.match(denied.message,/fetch failed on the server/);
  s.options.fetchImpl=fetch;
  const recovered=await loadMarketplaceCatalog(app,s.options);
  assert.equal(recovered.offline,false);assert.ok(recovered.catalog.items.length>0);
  assert.equal(s.tokenCalls(),0,'network failures must not initiate sign-in');
 }
});
