import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Module,{createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('session exchange protects sender, consent, redirect, identity and cookie ownership',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'web-auth-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let prompts=0,waits=0;
 let handler,revoke,approve=1,fetches=0,retries=0,revoked=false,reply,nonce=1;
 const jar=new Map();const cookies={get:async({name})=>jar.has(name)?[jar.get(name)]:[],set:async d=>{jar.set(d.name,d);},remove:async(_url,n)=>{jar.delete(n);},flushStore:async()=>{}};
 const target={cookies};const transport={fetch:async(url,init)=>{fetches++;assert.equal(url,'https://notes.test/api/session');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');assert.equal(init.body,'{}');return reply?reply():new Response('{}',{headers:{'Set-Cookie':'notes=secret-session; Path=/; HttpOnly; Secure; SameSite=Lax'}});}};
 const session={defaultSession:target,fromPartition:name=>name==='webapp-auth-exchange'?transport:target};
 const token=()=> 'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+600})).toString('base64url')+'.sig';
 const identity={getDesktopSsoAccessToken:()=>revoked?'':token(),getDesktopSsoStatus:()=>({authenticated:!revoked,user:{issuer:'issuer',sub:'a'}}),subscribeDesktopSsoCredentialRevocation:listener=>{revoke=listener;}};
 const old=Module._load;
 Module._load=function(name,parent,...args){
  if(parent?.filename.endsWith('/webs/auth-session.js')) {
   if(name==='electron')return {app:{whenReady:()=>Promise.resolve()},ipcMain:{handle:(_name,fn)=>handler=fn},session,BrowserWindow:{fromWebContents:()=>null,getFocusedWindow:()=>null},dialog:{showMessageBox:async()=>{prompts++;return {response:approve}}}};
   if(name==='../identity')return identity;
   if(name.includes('user-paths'))return {getDesktopStateRoot:()=>root};
   if(name.includes('i18n'))return {t:key=>key};
  }
  return old.call(this,name,parent,...args);
 };
 let register;try{delete require.cache[require.resolve('../dist-electron/main/modules/webs/auth-session.js')];register=require('../dist-electron/main/modules/webs/auth-session.js').registerWebappAuth;}finally{Module._load=old;}
 const frame={url:'https://notes.test/app'},guest=new EventEmitter();Object.assign(guest,{id:1,mainFrame:frame,session:target,isDestroyed:()=>false});
 let surface={surfaceKind:'website',registrationId:'r1',surfaceId:'site'};
 register({registry:{resolveWebviewSurfaceTarget:()=>surface,waitForWebviewSurfaceTarget:async()=>{waits++;return surface}},webs:{webappWindowManager:{resolveAuthGuest:()=>null}},refreshToken:async force=>{if(force)retries++;return token();}});
 const invoke=(input={exchangePath:'/api/session'},senderFrame=frame)=>handler({sender:guest,senderFrame},input);
 assert.equal((await invoke(undefined,{})).error.code,'forbidden');assert.equal(fetches,0);
 revoked=true;assert.equal((await invoke()).error.code,'sign_in_required');assert.equal(prompts,0);assert.equal(fetches,0);revoked=false;
 const registered=surface;surface=null;assert.equal((await invoke()).error.code,'forbidden');assert.equal(waits,1);assert.equal(prompts,0);surface=registered;
 approve=0;assert.equal((await invoke()).error.code,'cancelled');assert.equal(fetches,0);approve=1;
 assert.deepEqual(await invoke(),{ok:true});assert.equal(jar.get('notes').value,'secret-session');
 assert.equal(fs.readFileSync(path.join(root,'web-auth-cookies.json'),'utf8').includes('secret-session'),false);
 reply=()=>new Response('',{status:302,headers:{Location:'https://evil.test','Set-Cookie':'evil=x'}});
 assert.equal((await invoke()).error.code,'exchange_rejected');assert.equal(jar.has('evil'),false);
 reply=()=>new Response('',{status:401});assert.equal((await invoke()).error.code,'exchange_rejected');assert.equal(retries,1);
 reply=()=>new Response('',{headers:{'Set-Cookie':'notes=x; Domain=notes.test; HttpOnly; Secure; SameSite=Lax; Path=/'}});assert.equal((await invoke()).error.code,'invalid_cookie');
 reply=async()=>{surface={...surface,registrationId:'r'+(++nonce)};return new Response('',{headers:{'Set-Cookie':'notes=late; HttpOnly; Secure; SameSite=Lax; Path=/'}});};
 assert.equal((await invoke()).error.code,'context_changed');assert.equal(jar.get('notes').value,'secret-session');
 reply=async()=>{revoked=true;revoke();return new Response('',{headers:{'Set-Cookie':'notes=old-account; HttpOnly; Secure; SameSite=Lax; Path=/'}});};
 assert.equal((await invoke()).error.code,'context_changed');await new Promise(resolve=>setImmediate(resolve));assert.equal(jar.size,0);
 revoked=false;reply=undefined;jar.set('notes',{value:'unmanaged'});assert.equal((await invoke()).error.code,'cookie_conflict');assert.equal(jar.get('notes').value,'unmanaged');
});
