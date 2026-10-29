import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createBackendClient } from '../contracts/webapp/bridge.mjs';
const require=createRequire(import.meta.url);
let onRun;
const {startDesktopActionBridge,stopDesktopActionBridge}=require('../dist-electron/main/modules/desktop-actions/action-http-server.js');
const {writeDesktopActionBridgeSettingsConfig}=require('../dist-electron/main/modules/desktop-actions/settings.js');
const {issueWebappActionToken,revokeWebappActionToken}=require('../dist-electron/main/modules/webs/webapps/action-tokens.js');
const {startWebappGateway}=require('../dist-electron/main/modules/webs/webapps/gateway.js');
const input={message:'extract',input:false,outputSchema:{type:'object'}};
const envelope=JSON.stringify({action:'assistant.execute',args:input});
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port};
async function fixture(t) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'execute-http-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const item={schemaVersion:2,id:'webapp-1234567890abcdef',key:'execute-test',label:'Execute test',version:'1.0.0',target:'any',frontend:{root:'frontend',index:'index.html',routeConfig:{backendPrefixes:[]}},desktopBridge:{version:2}};
 fs.mkdirSync(path.join(home,'frontend'));fs.writeFileSync(path.join(home,'frontend/index.html'),'<p>test</p>');fs.writeFileSync(path.join(home,'webapp.json'),JSON.stringify(item));
 const app={getPath:name=>path.join(home,name)};let mode='success';let started,closed;let interruptBody;let posts=0;
 const platform=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
  assert.match(req.headers.authorization,/^Bearer h\./);
  if(req.url==='/api/interrupt'){interruptBody=body;res.end(JSON.stringify({code:0,data:{accepted:true}}));return}
  assert.equal(req.url,'/api/execute');setImmediate(()=>onRun?.({runId:'run-1',chatId:'chat-1',agentKey:body.agentKey}));posts++;assert.equal(body.agentKey,'executor');assert.equal(body.accessLevel,'ask_for_approval');
  res.once('close',()=>{if(!res.writableFinished)closed?.()});started?.();
  if(mode==='success')res.end(JSON.stringify({code:0,data:{chatId:'chat-1',status:'success',output:{amount:128}}}));
 });
 const platformPort=await listen(platform);t.after(()=>{platform.closeAllConnections();platform.close()});
 const probe=http.createServer();const bridgePort=await listen(probe);await new Promise(resolve=>probe.close(resolve));
 writeDesktopActionBridgeSettingsConfig(app,{schemaVersion:1,port:bridgePort});
 const runtime={status:'running',startedAt:Date.now(),webUrl:'http://runtime'};
 const options={app,getAssistantSettings:()=>({desktopHelperAgentKey:'executor'}),
  issueAgentAccessToken:async()=>({ok:true,token:'h.'+Buffer.from(JSON.stringify({sub:'desktop-app'})).toString('base64url')+'.s'}),
  services:{getResponsiveServiceState:async()=>({status:'running',healthMeta:{webUrl:`http://127.0.0.1:${platformPort}`}})},
  webs:{webappManager:{list:()=>[item],readUserConfig:()=>({})},webappRuntime:{getStatus:()=>runtime}},
  assistantBridge:{observeExecuteRun:(_id,_key,callback)=>{onRun=callback;return()=>{onRun=undefined}},listAgents:async()=>[]}
 };
 const bridge=startDesktopActionBridge(options);await once(bridge,'listening');t.after(()=>{stopDesktopActionBridge();bridge.closeAllConnections()});
 const page=issueWebappActionToken(item,'localPageGateway');const backend=issueWebappActionToken(item,'backendActionToken');
 t.after(()=>{revokeWebappActionToken(page);revokeWebappActionToken(backend)});
 const gateway=await startWebappGateway({app,item,webappDir:home,backendUrl:'',pageActionToken:page,integrationPorts:{getConfiguredDesktopActionBridgePort:()=>bridgePort}});
 runtime.webUrl=gateway.webUrl;t.after(()=>gateway.close());
 const backendURL=`http://127.0.0.1:${bridgePort}/webapps`;
 return {gateway,bridge,backendURL,backend,page,get posts(){return posts},get interrupt(){return interruptBody},
  block(){mode='blocked';return {started:new Promise(resolve=>{started=resolve}),closed:new Promise(resolve=>{closed=resolve})}}};
}
test('real gateway and native Node backend transport deliver equivalent results and deny scope substitution',async t=>{
 const f=await fixture(t);
 const page=await fetch(new URL('/__desktop/actions/call',f.gateway.webUrl),{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(f.gateway.webUrl).origin},body:envelope});
 assert.equal(page.status,200);assert.deepEqual((await page.json()).result,{chatId:'chat-1',status:'success',output:{amount:128}});
 const backend=createBackendClient({url:f.backendURL,token:f.backend});assert.equal((await backend.assistant.execute(input)).output.amount,128);assert.equal(f.posts,2);
 for(const [route,token] of [['/webapps/actions/call',f.page],['/webapps/pages/actions/call',f.backend]]) {
  const response=await fetch(new URL(route,f.backendURL),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:envelope});assert.equal(response.status,403);
 }
 const publicCall=await fetch(new URL('/actions/call',f.backendURL),{method:'POST',headers:{'Content-Type':'application/json'},body:envelope});assert.equal((await publicCall.json()).error.code,'forbidden');
});
for(const kind of ['page','backend','stop'])test(kind+' cancellation reaches the real Platform HTTP connection and interrupt endpoint',async t=>{
 const f=await fixture(t);const state=f.block();const controller=new AbortController();
 let operation;
 if(kind==='page')operation=fetch(new URL('/__desktop/actions/call',f.gateway.webUrl),{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(f.gateway.webUrl).origin},body:envelope,signal:controller.signal});
 else operation=createBackendClient({url:f.backendURL,token:f.backend}).assistant.execute(input,{signal:controller.signal});
 const observed=operation.then(value=>({value}),error=>({error}));await state.started;
 // Give the passive canonical Run notification a turn before cancellation.
 await new Promise(resolve=>setImmediate(resolve));
 if(kind==='stop')stopDesktopActionBridge();else controller.abort();
 const result=await observed;
 if(kind==='stop')assert.equal(result.error.code,'cancelled');else assert.ok(result.error);
 await Promise.race([state.closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Platform connection stayed open')),1500))]);
 for(let i=0;i<50&&!f.interrupt;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.interrupt?.runId,'run-1');assert.equal(f.interrupt.agentKey,'executor');
});
