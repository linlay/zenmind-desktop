import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
const contents = new Map();
const sessions = new Map();
const electron = {
  net: { fetch: async () => ({ok:true,json:async()=>({code:0,data:status})}) },
  webContents: { fromId: id => contents.get(id) },
  session: { fromPartition: key => { if(!sessions.has(key)) sessions.set(key,{}); return sessions.get(key); } },
};
globalThis.__connectorElectron = electron;
const {outputFiles}=await build({stdin:{contents:`export * from './src/main/modules/agent-platform/connector-auth-browser'; export * from './src/main/infrastructure/electron/isolated-auth-guest'; export * from './src/shared/contracts/agent-webclient-bridge';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'electron-mock',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {net,webContents,session}=globalThis.__connectorElectron;'}));}}]});
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
let status;
function wc(id){const e=new EventEmitter();Object.assign(e,{id,mainFrame:{},isDestroyed:()=>false,sent:[],send(channel,data){this.sent.push({channel,data});}});contents.set(id,e);return e;}
function harness(){
 status={connectorId:'wecom',sessionId:'first',authBrowser:'embedded',status:'pending',authorizationUrl:'https://work.weixin.qq.com/auth',expiresAt:new Date(Date.now()+60000).toISOString()};
 const owner=wc(1),sender=wc(2);const target={registrationId:'registration',ownerWebContentsId:1,currentUrl:'https://local.test/connectors'};
 const handlers=new Map();api.registerConnectorAuthBrowser({handle:(name,fn)=>handlers.set(name,fn)},{availability:async()=>({baseUrl:'http://127.0.0.1:8080',token:'test'}),authorize:s=>{if(s!==sender)throw Error('untrusted');return {sender:s,target};}});
 const invoke=(action,input={connectorId:'wecom',sessionId:'first'},event={sender,senderFrame:sender.mainFrame})=>handlers.get(api.CONNECTOR_AUTH_BROWSER_CHANNEL)(event,{action,input});
 const cleanup=()=>sender.emit('destroyed');
 return {owner,sender,target,handlers,invoke,cleanup};
}
test('authorization identity, URL, state and policy are all required',()=>{
 const id={connectorId:'wecom',sessionId:'first'};harness().cleanup();
 assert.equal(api.readEmbeddedAuthorization(status,id),status.authorizationUrl);
 for(const change of [{sessionId:'old'},{authBrowser:'system'},{status:'authorized'},{expiresAt:'invalid'},{authorizationUrl:'javascript:alert(1)'},{authorizationUrl:'https://user:pass@work.weixin.qq.com/'}]) assert.throws(()=>api.readEmbeddedAuthorization({...status,...change},id));
 assert.throws(()=>api.readConnectorAuthBrowserIdentity({connectorId:'../wecom',sessionId:'first'}));
});
test('trusted open is deduplicated, updates keep the isolated partition, foreign and stale calls are rejected',async()=>{
 const h=harness();try{
 await h.invoke('open');const first=h.owner.sent[0].data;
 await h.invoke('open');assert.equal(h.owner.sent.length,1);
 status.authorizationUrl='https://work.weixin.qq.com/step2';await h.invoke('open');assert.equal(h.owner.sent[1].data.partition,first.partition);
 await assert.rejects(h.invoke('open',{connectorId:'wecom',sessionId:'old'}));
 await assert.rejects(h.invoke('open',undefined,{sender:h.sender,senderFrame:{}}));
 const close=h.handlers.get(api.CONNECTOR_AUTH_BROWSER_HOST_CLOSE);
 assert.throws(()=>close({sender:h.sender,senderFrame:h.sender.mainFrame},first.dialogId));
 close({sender:h.owner,senderFrame:h.owner.mainFrame},first.dialogId);
 assert.deepEqual(h.sender.sent[0].data,{connectorId:'wecom',sessionId:'first'});
 }finally{h.cleanup();}
});
test('close or source generation change during status lookup prevents a late open',async()=>{
 const h=harness();const oldFetch=electron.net.fetch;let resolve;
 electron.net.fetch=()=>new Promise(r=>{resolve=r;});
 try{
 const opening=h.invoke('open');await new Promise(r=>setImmediate(r));await h.invoke('close');
 resolve({ok:true,json:async()=>({code:0,data:status})});await assert.rejects(opening);assert.equal(h.owner.sent.length,0);
 }finally{electron.net.fetch=oldFetch;h.cleanup();}
});
test('macOS and Windows auth guests reject preload, popups, downloads and non-web navigation',()=>{
 for(const platform of ['darwin','win32']){
 const partition=`connector-auth:${platform}`;const dispose=api.registerIsolatedAuthGuest(partition,1,'https://work.weixin.qq.com/auth');
 const prefs={preload:'/unsafe.js',nodeIntegration:true};
 assert.equal(api.prepareIsolatedAuthGuest(2,prefs,{partition,src:'https://work.weixin.qq.com/auth'}),false);
 assert.equal(api.prepareIsolatedAuthGuest(1,prefs,{partition,src:'https://work.weixin.qq.com/auth'}),true);
 assert.equal(prefs.preload,undefined);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.sandbox,true);
 const guest=new EventEmitter();guest.session=Object.assign(new EventEmitter(),{setPermissionRequestHandler(fn){this.request=fn;},setPermissionCheckHandler(fn){this.check=fn;}});
 // Use the exact registered Electron session, as the real guest does.
 Object.assign(electron.session.fromPartition(partition),guest.session);
 const sess=electron.session.fromPartition(partition);sess.on=EventEmitter.prototype.on;sess.emit=EventEmitter.prototype.emit;
 guest.session=sess;guest.setWindowOpenHandler=fn=>{guest.popup=fn;};
 assert.equal(api.configureIsolatedAuthGuest(guest),true);assert.deepEqual(guest.popup({url:'https://example.test'}),{action:'deny'});
 let prevented=0;guest.emit('will-navigate',{preventDefault(){prevented++;}},'file:///etc/passwd');assert.equal(prevented,1);
 guest.emit('will-redirect',{preventDefault(){prevented++;}},'https://work.weixin.qq.com/callback');assert.equal(prevented,1);
 dispose();assert.equal(api.prepareIsolatedAuthGuest(1,{}, {partition,src:'https://work.weixin.qq.com/auth'}),false);
 }
});
