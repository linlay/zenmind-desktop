import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {ArtifactStore,getArtifactDatabasePath,parseArtifactPush}=require('../dist-electron/main/modules/artifacts/store.js');
const {parseArtifactMetadata}=require('../dist-electron/main/modules/artifacts/metadata.js');
const {createArtifactRuntime}=require('../dist-electron/main/modules/artifacts/index.js');
const {createArtifactPlatformClient,ArtifactPlatformError}=require('../dist-electron/main/modules/artifacts/platform-client.js');
const at=1_800_000_000_000;
const metadata=(patch={})=>({chatId:'chat-1',runId:'run-1',artifactId:'artifact-1',name:'a.md',mimeType:'text/markdown',sizeBytes:3,sha256:'a'.repeat(64),publishedAt:at,...patch});
const item=(patch={})=>parseArtifactMetadata(metadata(patch));
const identity=(patch={})=>({chatId:'chat-1',runId:'run-1',artifactId:'artifact-1',...patch});
const push=(patch={})=>({frame:'push',type:'artifact.published',data:metadata(patch)});
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,app:{getPath:()=>dir}};}
const response=(data,status=200)=>new Response(JSON.stringify({code:status===200?0:status,data}),{status});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('condition not reached');}

test('migration keeps old metadata unresolved, then resolves only a unique exact manifest match',t=>{
 const {dir}=setup(t),filename=path.join(dir,'old.db');
 const db=new DatabaseSync(filename);
 db.exec(`CREATE TABLE artifacts(chat_id TEXT,artifact_id TEXT,name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,pushed_at INTEGER,PRIMARY KEY(chat_id,artifact_id));`);
 db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)').run('chat-1','artifact-1','a.md','text/markdown',3,'a'.repeat(64),at);
 db.close();
 const store=new ArtifactStore(()=>filename);
 assert.equal(store.list().records[0].contentState,'unresolved');
 assert.equal(store.list().records[0].category,'document');
 store.organize({...identity({runId:''}),favorite:true,tags:['重要','review']});
 store.replaceChatManifest('chat-1',[item()]);
 assert.equal(store.list().total,1);
 assert.equal(store.get(identity()).favorite,true);
 assert.deepEqual(store.get(identity()).tags,['重要','review']);
 assert.equal(store.get(identity({runId:''})),null);
 const restored=new ArtifactStore(()=>filename);
 assert.equal(restored.get(identity()).runId,'run-1');
});

test('run identity, conflict detection, annotation preservation, MIME and exact tag filtering',t=>{
 const {dir}=setup(t),store=new ArtifactStore(()=>path.join(dir,'library.db'));
 store.ingest(push());store.ingest(push({runId:'run-2',name:'b.png',mimeType:'image/png'}));
 assert.equal(store.list().total,2);
 store.organize({...identity(),favorite:true,tags:['100%_done','文档']});
 store.replaceChatManifest('chat-1',[item(),item({runId:'run-2',name:'b.png',mimeType:'image/png'})]);
 assert.equal(store.list({favoritesOnly:true}).total,1);
 assert.equal(store.list({category:'image'}).records[0].runId,'run-2');
 assert.equal(store.list({tag:'文档'}).total,1);
 assert.equal(store.list({tag:'文'}).total,0);
 assert.equal(store.list({search:'%_'}).total,1);
 assert.equal(store.list({search:"' OR 1=1 --"}).total,0);
 assert.throws(()=>store.organize({...identity(),tags:Array(21).fill('a')}));
 // Producer notice and manifest timestamps can differ without being two publications.
 store.ingest(push({publishedAt:at+1}));
 assert.equal(store.get(identity()).contentState,'ready');
 store.replaceChatManifest('chat-1',[item(),item({publishedAt:at+2})]);
 assert.equal(store.get(identity()).contentState,'ambiguous');
 assert.equal(store.get(identity()).favorite,true);
 assert.deepEqual(store.get(identity()).tags,['100%_done','文档']);
 // The complete authoritative manifest can resolve a locally suspected conflict.
 store.replaceChatManifest('chat-1',[item()]);
 assert.equal(store.get(identity()).contentState,'ready');
});

test('legacy collision is retained rather than assigning favorite to an arbitrary run',t=>{
 const {dir}=setup(t),store=new ArtifactStore(()=>path.join(dir,'library.db'));
 store.ingest({frame:'push',type:'resource.pushed',data:{...metadata({runId:undefined}),pushedAt:at}});
 store.organize({...identity({runId:''}),favorite:true});
 store.replaceChatManifest('chat-1',[item(),item({runId:'run-2'})]);
 assert.equal(store.list().total,3);
 assert.equal(store.get(identity({runId:''})).favorite,true);
 assert.equal(store.get(identity()).favorite,false);
 assert.equal(parseArtifactPush(push({publishedAt:undefined,pushedAt:at})),null);
});

test('Platform client reads all active chats without a false page cursor and follows both real page contracts',async()=>{
 const calls=[];
 const client=createArtifactPlatformClient({resolve:async()=>({baseUrl:'http://localhost:8080',token:'secret'}),fetchImpl:async(url,init)=>{
  calls.push([String(url),init]);const route=new URL(url);
  assert.equal(init.headers.Authorization,'Bearer secret');assert.equal(init.redirect,'error');
  if(route.pathname==='/api/chats')return response([{chatId:'chat-1',chatName:'report',agentKey:'agent'}]);
  if(route.pathname==='/api/archives')return response({total:2,items:[{chatId:route.searchParams.get('offset')==='0'?'archived-1':'archived-2'}]});
  if(route.pathname.endsWith('/list')){const body=JSON.parse(init.body);return response({items:[metadata({artifactId:body.cursor?'b':'a'})],...(body.cursor?{}:{nextCursor:'1'})});}
  if(route.pathname.endsWith('/read')){assert.deepEqual(JSON.parse(init.body),identity());return new Response('abc');}
  throw new Error('unexpected request');
 }});
 const signal=new AbortController().signal;
 assert.equal((await client.listChats(signal)).length,1);
 assert.equal(new URL(calls[0][0]).search,'');
 assert.equal((await client.listArchives(signal)).length,2);
 assert.equal((await client.listArtifacts('chat-1',signal)).length,2);
 assert.equal((await client.read(identity(),signal)).toString(),'abc');
});

test('Platform client preserves permission/change errors, retries app authentication, rejects malformed and oversized responses',async()=>{
 for(const [status,code] of [[403,'chat_access_denied'],[409,'artifact_changed'],[409,'artifact_ambiguous']]){
  const client=createArtifactPlatformClient({resolve:async()=>({baseUrl:'http://localhost',token:'token'}),fetchImpl:async()=>response({code},status)});
  await assert.rejects(client.read(identity(),new AbortController().signal),error=>error.code===code);
 }
 const reasons=[];
 let requests=0;
 const client=createArtifactPlatformClient({resolve:async reason=>{reasons.push(reason);return {baseUrl:'http://localhost',token:'token'};},fetchImpl:async()=>++requests===1?response({},401):response([])});
 await client.listChats(new AbortController().signal);
 assert.deepEqual(reasons,['missing','unauthorized']);
 const malformed=createArtifactPlatformClient({resolve:async()=>({baseUrl:'http://localhost',token:'token'}),fetchImpl:async()=>response({items:[metadata({chatId:'foreign'})]})});
 await assert.rejects(malformed.listArtifacts('chat-1',new AbortController().signal),/invalid_response/);
 const large=createArtifactPlatformClient({resolve:async()=>({baseUrl:'http://localhost',token:'token'}),fetchImpl:async()=>new Response('abc',{headers:{'content-length':String(101*1024*1024)}})});
 await assert.rejects(large.read(identity(),new AbortController().signal),/response_too_large/);
});

function runtimeFixture(t,api){
 const {app}=setup(t),handlers=new Map();let consumer,connection;
 const frame={},sender={mainFrame:frame,send(){}};const window={isDestroyed:()=>false,webContents:sender};
 const errors=[];
 const runtime=createArtifactRuntime({app,platform:'darwin',platformApi:api,
  broker:{subscribePush:o=>{consumer=o;return ()=>{};},subscribeConnection:o=>{connection=o;return ()=>{};}},
  ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},getMainWindow:()=>window,onError:e=>errors.push(e)});
 t.after(()=>runtime.dispose());
 const trusted={sender,senderFrame:frame};
 return {runtime,errors,store:new ArtifactStore(()=>getArtifactDatabasePath(app,'darwin')),
  connect:()=>connection.onState({phase:'connected'}),disconnect:()=>connection.onState({phase:'disconnected'}),
  push:frame=>consumer.onPush(frame),list:()=>handlers.get('artifacts.list')(trusted),
  sync:()=>handlers.get('artifacts.sync')(trusted),organize:input=>handlers.get('artifacts.organize')(trusted,input),handlers,trusted};
}
const chat={chatId:'chat-1',chatName:'报告',agentKey:'agent'};
const api=(patch={})=>({listChats:async()=>[chat],listArchives:async()=>[],listArtifacts:async()=>[item()],read:async()=>Buffer.from('abc'),...patch});

test('handshake syncs history with retries, metadata, failed/denied visibility and retryable resync',async t=>{
 let attempts=0,denied=true;
 const f=runtimeFixture(t,api({listChats:async()=>[chat,{...chat,chatId:'denied'}],listArtifacts:async id=>{
  if(id==='denied'){if(denied)throw new ArtifactPlatformError('chat_access_denied',403);return [item({chatId:id})];}
  if(++attempts===1)throw new Error('temporary');return [item()];
 }}));
 f.connect();await until(()=>f.list().sync.phase==='partial');
 assert.equal(attempts,2);assert.equal(f.list().sync.denied,1);
 assert.equal(f.list().records[0].chatName,'报告');
 f.organize({...identity(),favorite:true,tags:['report']});
 denied=false;f.sync();await until(()=>f.list().sync.phase==='complete');
 assert.equal(f.list().total,2);assert.equal(f.store.get(identity()).favorite,true);
 assert.throws(()=>f.handlers.get('artifacts.organize')({sender:{},senderFrame:{}},identity()),/denied/);
 assert.throws(()=>f.handlers.get('artifacts.sync')({sender:f.trusted.sender,senderFrame:{} }),/denied/);
});

test('delete/archive events beat late sync responses, restore reindexes and archive deletion cleans annotations',async t=>{
 for(const type of ['chat.deleted','chat.archived']){
  let resolve;const pending=new Promise(r=>resolve=r);
  const f=runtimeFixture(t,api({listArtifacts:()=>pending}));
  f.store.ingest(push());f.organize({...identity(),favorite:true,tags:['important']});
  f.connect();await until(()=>f.list().sync.total===1);
  f.push({type,data:{chatId:'chat-1'}});resolve([item()]);
  await until(()=>['complete','partial'].includes(f.list().sync.phase));
  if(type==='chat.deleted')assert.equal(f.list().total,0);
  else {
   assert.equal(f.list().records[0].sourceState,'archived');
   f.push({type:'archive.restored',data:{chatId:'chat-1'}});
   await until(()=>f.list().sync.phase==='complete');
   assert.equal(f.list().records[0].sourceState,'active');
   assert.equal(f.list().records[0].favorite,true);
   f.push({type:'archive.deleted',data:{chatId:'chat-1'}});
   assert.equal(f.list().total,0);assert.deepEqual(f.list().tags,[]);
  }
 }
});

test('disconnect and disposal revoke in-flight results and action contexts; reconnect recovers',async t=>{
 let resolve;let calls=0;
 const pending=new Promise(r=>resolve=r);
 const f=runtimeFixture(t,api({listArtifacts:()=>++calls===1?pending:Promise.resolve([item()])}));
 f.store.ingest(push());const context=f.runtime.actionContext(identity());
 f.connect();await until(()=>calls===1);f.disconnect();
 assert.equal(context.isCurrent(),false);f.connect();resolve([item()]);
 await until(()=>f.list().sync.phase==='complete');assert.equal(calls,2);
 const ready=f.runtime.actionContext(identity());assert.equal(ready.isCurrent(),true);
 f.runtime.dispose();assert.equal(ready.isCurrent(),false);assert.equal(f.handlers.size,0);
});

test('failed catalogs never clear cached content; offline archive membership is reconciled',async t=>{
 const f=runtimeFixture(t,api({listChats:async()=>{throw new Error('offline');}}));
 f.store.ingest(push());f.connect();await until(()=>f.list().sync.phase==='partial');assert.equal(f.list().total,1);
 const g=runtimeFixture(t,api({listChats:async()=>[],listArchives:async()=>[chat]}));
 g.store.ingest(push());g.connect();await until(()=>g.list().sync.phase==='complete');
 assert.equal(g.list().records[0].sourceState,'archived');
});
