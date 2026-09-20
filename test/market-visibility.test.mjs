import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { requestVisibleMarketJson, loadMarketplaceCatalog } = require('../dist-electron/main/modules/marketplace/common.js');
const { readMarketSkillContent } = require('../dist-electron/main/modules/marketplace/skill-detail.js');
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
