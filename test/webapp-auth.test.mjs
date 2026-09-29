import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { auth, createBackendClient } from '../contracts/webapp/bridge.mjs';
const require=createRequire(import.meta.url);
const {resolveSessionExchangeUrl,parseSessionCookies}=require('../dist-electron/main/modules/webs/auth-session-policy.js');
const {prepareWebviewAttachPreferences}=require('../dist-electron/main/modules/shell/webview-attach-policy.js');
test('auth SDK uses the visitor preload, never an HTTP action or backend client',async t=>{
 const old=globalThis.__ZENMIND_AUTH__,fetch=globalThis.fetch;
 t.after(()=>{globalThis.__ZENMIND_AUTH__=old;globalThis.fetch=fetch;});
 delete globalThis.__ZENMIND_AUTH__;assert.equal(auth.isAvailable(),false);await assert.rejects(auth.createSession({exchangePath:'/api/session'}),{code:'unavailable'});
 globalThis.fetch=()=>{throw Error('must not use publisher gateway')};
 globalThis.__ZENMIND_AUTH__={createSession:async input=>{assert.deepEqual(input,{exchangePath:'/api/session'});return {ok:true,token:'must-not-be-forwarded'};}};
 assert.equal(auth.isAvailable(),true);
 assert.deepEqual(await auth.createSession({exchangePath:'/api/session'}),{ok:true});
 globalThis.__ZENMIND_AUTH__={createSession:async()=>({ok:false,error:{code:'cancelled',message:'Cancelled'}})};
 await assert.rejects(auth.createSession({exchangePath:'/api/session'}),{code:'cancelled'});
 assert.equal(createBackendClient({url:'http://127.0.0.1:1234/webapps',token:'backend'}).auth,undefined);
});
test('exchange target stays same origin; HTTP is only allowed for a registered local WebApp',()=>{
 assert.equal(resolveSessionExchangeUrl('https://notes.test/page',{exchangePath:'/api/login'},false).href,'https://notes.test/api/login');
 for(const exchangePath of ['https://evil.test/login','//evil.test','/\\evil.test','/api/login?token=x','/api/login#x','/api/../login','/%2f%2fevil.test','/__desktop/actions/call'])assert.throws(()=>resolveSessionExchangeUrl('https://notes.test',{exchangePath},false));
 assert.throws(()=>resolveSessionExchangeUrl('http://127.0.0.1:42',{exchangePath:'/login'},false));
 assert.equal(resolveSessionExchangeUrl('http://127.0.0.1:42',{exchangePath:'/login'},true).origin,'http://127.0.0.1:42');
 assert.throws(()=>resolveSessionExchangeUrl('http://intranet.test',{exchangePath:'/login'},true));
 assert.throws(()=>resolveSessionExchangeUrl('https://notes.test',{exchangePath:'/login',token:'other'},false));
});
test('cookies reject broad domains, missing HttpOnly, weak SameSite, duplicates and long values',()=>{
 const u=new URL('https://notes.test/login'),now=Date.now(),expires=now+60000;
 const line='sid=random-value; HttpOnly; Secure; SameSite=Lax; Path=/';
 const [cookie]=parseSessionCookies([line],u,expires,now);assert.equal(cookie.expirationDate,expires/1000);assert.equal(cookie.domain,undefined);
 for(const lines of [[],[line+'; Domain=notes.test'],[line.replace('HttpOnly; ','')],[line.replace('Secure; ','')],[line.replace('Lax','None')],[line,line],[line.replace('Path=/','Path=/api')],[line+'; Max-Age=0'],[line+'; Expires=not-a-date'],[line.replace('random-value','x'.repeat(5000))]])assert.throws(()=>parseSessionCookies(lines,u,expires,now));
 assert.throws(()=>parseSessionCookies([line],u,now-1,now));
});
test('macOS and Windows network webviews receive only the sandboxed auth preload',()=>{
 for(const prefix of ['/Applications/App/preload','C:\\App\\preload']){
  const sep=prefix.startsWith('C:')?'\\':'/';
  const input={webPreferences:{},params:{src:'https://notes.test'},servicePreloadPath:prefix+sep+'service-webview.js',servicePreloadUrl:'file:///service-webview.js',isSafeServiceUrl:()=>false};
  assert.equal(prepareWebviewAttachPreferences(input).ok,true);assert.equal(input.webPreferences.preload,prefix+sep+'webapp-auth.js');assert.equal(input.webPreferences.sandbox,true);assert.equal(input.webPreferences.nodeIntegration,false);
 }
});
