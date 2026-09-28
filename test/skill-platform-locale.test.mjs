import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchAgentPlatformWithAuth } = require('../dist-electron/main/modules/desktop-actions/platform-http.js');
const { setMainLocaleForCurrentProcess, getMainLocale } = require('../dist-electron/main/support/i18n/main-i18n.js');

test('skill requests carry the current locale without changing the stable API route', async t => {
 const original=getMainLocale();t.after(()=>setMainLocaleForCurrentProcess(original));
 for(const locale of ['zh-CN','en-US','zh-CN']) {
  setMainLocaleForCurrentProcess(locale);
  const data=await fetchAgentPlatformWithAuth('http://localhost:19000','/api/skills',{
   issueToken:async()=>({ok:true,token:'test-token'}),
   fetchImpl:async(url,init)=>{
    assert.equal(url,'http://localhost:19000/api/skills');assert.equal(init.headers['X-Locale'],locale);
    return new Response(JSON.stringify({code:0,data:{skills:[],pinned:[]}}));
   }
  });
  assert.deepEqual(data,{skills:[],pinned:[]});
 }
});
