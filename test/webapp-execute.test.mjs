import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
let fetcher;
globalThis.__executeElectron = { net: { fetch: (...args) => fetcher(...args) } };
const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/modules/desktop-actions/webapp-execute'; export * from './src/shared/webapp-execute'; export * from './src/main/modules/webs/webapps/capability-policy'; export * from './src/main/modules/desktop-actions/webapp-connector';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire('+JSON.stringify(import.meta.url)+');' },
  plugins: [{name:'ports',setup(b) {
    b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {net,dialog,BrowserWindow,shell,session}=globalThis.__executeElectron;'}));
    b.onResolve({filter:/^\.\.\/artifacts$/},()=>({path:'artifacts',namespace:'stub-artifacts'}));
    b.onLoad({filter:/.*/,namespace:'stub-artifacts'},()=>({contents:'export const artifactRelativePath=()=>null;'}));
    b.onResolve({filter:/^\.\.\/agent-platform$/},()=>({path:'auth',namespace:'stub-auth'}));
    b.onLoad({filter:/.*/,namespace:'stub-auth'},()=>({contents:'export function readEmbeddedAuthorization(){}'}));
    b.onResolve({filter:/main-i18n$/},()=>({path:'i18n',namespace:'stub-i18n'}));
    b.onLoad({filter:/.*/,namespace:'stub-i18n'},()=>({contents:'export const t=key=>key;export const getMainLocale=()=>"en";'}));
  }}]
});
const api = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
let sequence=0;
const input = {message:'extract',input:0,outputSchema:{type:'object'}};
const json = (data, status=200) => new Response(JSON.stringify({code:status===200?0:status,data}),{status});
function fixture() {
  let identity='desktop-app';const grant=new AbortController();const request=new AbortController();
  const item={id:'one',version:'1',copilot:{agentKey:'executor',references:[{type:'skill',id:'chat-only'}]}};
  const runtime={status:'running',startedAt:++sequence};let onRun;
  const options={app:{}, getAssistantSettings:()=>({desktopHelperAgentKey:'helper'}),
    issueAgentAccessToken:async()=>({ok:true,token:'h.'+Buffer.from(JSON.stringify({sub:identity})).toString('base64url')+'.s'}),
    services:{getResponsiveServiceState:async()=>({status:'running',healthMeta:{webUrl:'http://127.0.0.1:1234'}})},
    webs:{webappManager:{list:()=>[item],readUserConfig:()=>({})},webappRuntime:{getStatus:()=>runtime}},
    assistantBridge:{listAgents:async()=>[{agentKey:'chosen'}],observeExecuteRun:async(requestId,agentKey,callback,signal)=>{
      onRun=()=>{if(!signal.aborted) callback({runId:'run-1',chatId:'chat-1',agentKey})};return ()=>{onRun=undefined};
    }}
  };
  return {options,invocation:{kind:'webappPage',webappId:'one',signal:grant.signal,requestSignal:request.signal},
    grant,request,item,runtime,setIdentity:x=>{identity=x},accepted:()=>onRun?.()};
}
const run=(f,args=input,limits)=>api.executeWebappExecute(f.options,args,f.invocation,limits);

test('execute uses Main identity, fixed permissions and Agent with no references; preserves JSON data', async()=>{
 const f=fixture();const calls=[];
 fetcher=async(url,options)=>{calls.push([url,options]);return json({chatId:'chat-1',status:'success',output:{createdAt:'business-time',amount:128}})};
 const result=await run(f);assert.equal(result.ok,true);assert.equal(result.result.output.createdAt,'business-time');
 const [url,options]=calls[0];assert.equal(new URL(url).pathname,'/api/execute');assert.match(options.headers.Authorization,/^Bearer h\./);
 const body=JSON.parse(options.body);assert.equal(body.agentKey,'executor');assert.equal(body.accessLevel,'default');assert.equal(body.input,0);assert.equal(body.references,undefined);assert.equal(body.skillIds,undefined);assert.ok(body.requestId);assert.equal(calls.length,1);
});
test('business failure resolves and configured Agent uses the existing select mechanism',async()=>{
 const f=fixture();f.item.userConfig={fields:[{type:'select',name:'agent',source:'desktop.agents'}]};f.options.webs.webappManager.readUserConfig=()=>({agent:'chosen'});
 fetcher=async(_url,options)=>{assert.equal(JSON.parse(options.body).agentKey,'chosen');return json({chatId:'chat-1',status:'failure',reason:'missing information'})};
 assert.deepEqual((await run(f)).result,{chatId:'chat-1',status:'failure',reason:'missing information'});
 f.options.assistantBridge.listAgents=async()=>[];assert.equal((await run(f)).error.code,'assistant_agent_unavailable');
});
test('invalid inputs, permissions and sources are rejected before HTTP',async()=>{
 let calls=0;fetcher=async()=>{calls++;throw Error('unexpected')};
 for (const args of [null,[],{...input,skillIds:[]},{...input,accessLevel:'full_access'},{...input,message:' '},{...input,message:'x'.repeat(12001)},{...input,outputSchema:{type:'array'}},{...input,input:{$file:'upload'}},{...input,input:NaN}]) assert.equal((await run(fixture(),args)).ok,false);
 const f=fixture();assert.equal((await api.executeWebappExecute(f.options,input,{kind:'desktop'})).error.code,'forbidden');assert.equal(calls,0);
});
for (const [platformCode,expected,status] of [['approval_required','approval_required',403],['output_invalid','output_invalid',422],['output_missing','output_missing',422],['cancelled','cancelled',409],['run_error','assistant_failed',500],['agent_not_found','assistant_agent_unavailable',404],['result_submit_unavailable','assistant_agent_unsupported',400],['execute_unsupported_agent','assistant_agent_unsupported',400],['unknown_field','invalid_args',400]]) test('maps '+platformCode+' without leaking raw cause',async()=>{
 fetcher=async()=>json({chatId:'chat-1',error:{code:platformCode,message:'secret-token'},cause:'secret-token'},status);
 const result=await run(fixture());assert.equal(result.error.code,expected);assert.equal(result.error.details.chatId,'chat-1');assert.equal(JSON.stringify(result).includes('secret-token'),false);
});
test('malformed and oversized responses fail without retry',async()=>{
 for(const data of [{chatId:'chat-1',status:'success'},{chatId:'chat-1',status:'unknown'},{chatId:'',status:'failure',reason:'x'}]) {
  fetcher=async()=>json(data);assert.equal((await run(fixture())).error.code,'invalid_platform_response');
 }
 let calls=0;fetcher=async()=>{calls++;return json({chatId:'chat-1',status:'success',output:{text:'x'.repeat(1024*1024)}})};
 assert.equal((await run(fixture())).error.code,'assistant_result_too_large');assert.equal(calls,1);
});
for(const reason of ['disconnect','revoke','timeout','stop','identity']) test(reason+' aborts exact HTTP request and actively interrupts its canonical Run',async()=>{
 const f=fixture();let start;let interrupted;const ready=new Promise(resolve=>{start=resolve});
 fetcher=async(url,options)=>{
  if(new URL(url).pathname==='/api/interrupt') {interrupted=JSON.parse(options.body);return json({accepted:true})}
  f.accepted();start();
  return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 };
 const promise=run(f,input,{timeoutMs:reason==='timeout'?30:1000,checkMs:5});await ready;
 if(reason==='disconnect')f.request.abort();if(reason==='revoke')f.grant.abort();if(reason==='stop')api.stopWebappExecutions();if(reason==='identity')f.setIdentity('other');
 const result=await promise;assert.equal(result.error.code,reason==='timeout'?'assistant_timeout':reason==='revoke'||reason==='identity'?'app_grant_required':'cancelled');
 assert.equal(interrupted.runId,'run-1');assert.equal(interrupted.chatId,'chat-1');assert.equal(interrupted.agentKey,'executor');
});
test('grant identity remains bound across independent request signals',async()=>{
 const f=fixture();fetcher=async()=>json({chatId:'chat-1',status:'success',output:{}});
 assert.equal((await run(f)).ok,true);f.setIdentity('other');f.invocation.requestSignal=new AbortController().signal;
 assert.equal((await run(f)).error.code,'app_grant_required');
});
test('in-flight limits are shared by page and backend and release after cancellation',async()=>{
 const f=fixture();let started=0;fetcher=async(_url,{signal})=>{started++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 const one=run(f);const two=api.executeWebappExecute(f.options,input,{...f.invocation,kind:'webappBackend'});
 while(started<2)await new Promise(resolve=>setImmediate(resolve));assert.equal((await run(f)).error.code,'app_capacity_exceeded');
 f.request.abort();await Promise.all([one,two]);fetcher=async()=>json({chatId:'chat-1',status:'success',output:{}});
 f.invocation.requestSignal=new AbortController().signal;assert.equal((await run(f)).ok,true);
});
test('both token scopes include execute without Manifest declarations',()=>{
 for(const scope of ['localPageGateway','backendActionToken'])assert.ok(api.getWebappAllowedActions({},scope).includes('assistant.execute'));
});

test('cancellation before a canonical Run arrives still aborts HTTP without guessing a Run',async()=>{
 const f=fixture();let ready;const started=new Promise(resolve=>{ready=resolve});let calls=0;
 f.options.assistantBridge.observeExecuteRun=async()=>()=>{};
 fetcher=async(_url,{signal})=>{calls++;ready();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 const operation=run(f);await started;f.request.abort();assert.equal((await operation).error.code,'cancelled');assert.equal(calls,1);
});
test('deadline during non-cancellable Agent lookup prevents a late POST',async()=>{
 const f=fixture();f.item.userConfig={fields:[{type:'select',name:'agent',source:'desktop.agents'}]};f.options.webs.webappManager.readUserConfig=()=>({agent:'chosen'});
 let complete;f.options.assistantBridge.listAgents=()=>new Promise(resolve=>{complete=resolve});let calls=0;
 fetcher=async()=>{calls++;throw Error('late POST')};
 const keeper=setTimeout(()=>{},100);try {
  const result=await run(f,input,{timeoutMs:10,checkMs:5});assert.equal(result.error.code,'assistant_timeout');
  complete([{agentKey:'chosen'}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
 } finally {clearTimeout(keeper)}
});
