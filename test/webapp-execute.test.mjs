import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
let fetcher;
globalThis.__executeNodeFetch=(...args)=>fetcher(...args);
globalThis.__executeElectron = { net: { fetch: (...args) => fetcher(...args) } };
const { outputFiles } = await build({
  stdin: { contents: `export * from './src/main/modules/desktop-actions/webapp-execute'; export * from './src/main/infrastructure/network/node-json-request'; export * from './src/shared/webapp-execute'; export * from './src/main/modules/webs/webapps/capability-policy'; export * from './src/main/modules/desktop-actions/webapp-connector'; export {probeWebappExecutionIdentity} from './src/main/modules/desktop-actions/webapp-platform-client';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire('+JSON.stringify(import.meta.url)+');' },
  plugins: [{name:'ports',setup(b) {
    b.onResolve({filter:/node-json-request$/},()=>({path:'node-request',namespace:'stub-node-request'}));
    b.onLoad({filter:/.*/,namespace:'stub-node-request'},()=>({contents:`
      export class NodeJsonRequestError extends Error { constructor(code) {super(code);this.code=code;} }
      export async function postNodeJson(url,options) {
        const response=await globalThis.__executeNodeFetch(url,options);
        const bytes=await response.arrayBuffer();
        if(bytes.byteLength>options.maxResponseBytes)throw new NodeJsonRequestError('response_too_large');
        return new Response(bytes,{status:response.status,headers:response.headers});
      }`}));
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
    assistantBridge:{listAgents:async()=>[{agentKey:'chosen'}],observeExecuteRun:(requestId,agentKey,callback,signal)=>{
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
 const body=JSON.parse(options.body);assert.equal(body.agentKey,'executor');assert.equal(body.accessLevel,'ask_for_approval');assert.equal(body.input,0);assert.equal(body.references,undefined);assert.equal(body.skillIds,undefined);assert.ok(body.requestId);assert.equal(calls.length,1);
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
 if(['agent_not_found','result_submit_unavailable','execute_unsupported_agent','unknown_field'].includes(platformCode))assert.equal(result.error.details.executionState,'not_started');
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
 if(reason==='identity') {assert.equal(interrupted,undefined);return;}
 for(let i=0;i<100&&!interrupted;i++)await new Promise(resolve=>setImmediate(resolve));
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
 f.options.assistantBridge.observeExecuteRun=()=>()=>{};
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

test('empty helper fails as agent unavailable before any execution request',async()=>{
 const f=fixture();delete f.item.copilot;f.options.getAssistantSettings=()=>({desktopHelperAgentKey:''});
 let calls=0;fetcher=async()=>{calls++;throw Error('unexpected POST')};
 const result=await run(f);assert.equal(result.error.code,'assistant_agent_unavailable');assert.equal(result.error.details.executionState,'not_started');assert.equal(calls,0);
});
test('connection refusal proves execution has not started',async()=>{
 fetcher=async()=>{throw new api.NodeJsonRequestError('connection_refused')};
 const result=await run(fixture());assert.equal(result.error.code,'assistant_unavailable');assert.equal(result.error.details.executionState,'not_started');
});
test('a transient identity probe failure does not kill an execution; final verification is still strict',async()=>{
 const f=fixture();let finish;let start;const ready=new Promise(resolve=>{start=resolve});let probes=0;
 const original=f.options.services.getResponsiveServiceState;
 fetcher=async()=>{start();return new Promise(resolve=>{finish=resolve})};
 const pending=run(f,input,{timeoutMs:1000,checkMs:5});await ready;
 f.options.services.getResponsiveServiceState=async()=>{probes++;throw Error('temporary service probe failure')};
 while(!probes)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(f.request.signal.aborted,false);assert.equal(f.grant.signal.aborted,false);
 f.options.services.getResponsiveServiceState=original;finish(json({chatId:'chat-1',status:'success',output:{}}));assert.equal((await pending).ok,true);
 const g=fixture();fetcher=async()=>{g.options.services.getResponsiveServiceState=async()=>{throw Error('unavailable at delivery')};return json({chatId:'chat-1',status:'success',output:{}})};
 assert.equal((await run(g)).ok,false);
});
test('delivery retries a transient missing identity once without repeating the execution POST',async()=>{
 const f=fixture();let posts=0,checks=0;const issue=f.options.issueAgentAccessToken;
 fetcher=async()=>{
  posts++;f.options.issueAgentAccessToken=async()=>++checks===1?{ok:false}:issue();
  return json({chatId:'chat-1',status:'success',output:{amount:128}});
 };
 const result=await run(f);assert.equal(result.ok,true);assert.equal(result.result.output.amount,128);assert.equal(posts,1);assert.equal(checks,2);
});
test('delivery gives up after one retry when identity stays unavailable',async()=>{
 const f=fixture();let posts=0,checks=0;
 fetcher=async()=>{posts++;f.options.issueAgentAccessToken=async()=>{checks++;return {ok:false}};return json({chatId:'chat-1',status:'success',output:{}})};
 const result=await run(f);assert.equal(result.error.code,'desktop_identity_required');assert.equal(result.error.details.executionState,'unknown');assert.equal(checks,2);assert.equal(posts,1);
});
test('delivery rejects a changed identity immediately instead of retrying it',async()=>{
 const f=fixture();let checks=0;const issue=f.options.issueAgentAccessToken;
 fetcher=async()=>{f.setIdentity('other');f.options.issueAgentAccessToken=async()=>{checks++;return issue()};return json({chatId:'chat-1',status:'success',output:{}})};
 assert.equal((await run(f)).error.code,'app_grant_required');assert.equal(checks,1);
});
test('identity recovery cannot deliver a result to a different subject or a replacement application instance',async()=>{
 for(const change of ['identity','instance']) {
  const f=fixture();let checks=0;const issue=f.options.issueAgentAccessToken;
  fetcher=async()=>{
   f.options.issueAgentAccessToken=async()=>{checks++;if(checks===1)return {ok:false};if(change==='identity')f.setIdentity('other');else f.runtime.startedAt++;return issue()};
   return json({chatId:'chat-1',status:'success',output:{}});
  };
  assert.equal((await run(f)).error.code,'app_grant_required');assert.equal(checks,2);
 }
});
test('cancellation and the overall deadline interrupt the delivery retry delay',async()=>{
 for(const reason of ['cancel','deadline']) {
  const f=fixture();let checks=0;
  fetcher=async()=>{
   f.options.issueAgentAccessToken=async()=>{checks++;if(reason==='cancel')setTimeout(()=>f.request.abort(),10);return {ok:false}};
   return json({chatId:'chat-1',status:'success',output:{}});
  };
  const result=await run(f,input,{timeoutMs:reason==='deadline'?30:1000,checkMs:1000});
  assert.equal(result.error.code,reason==='cancel'?'cancelled':'assistant_timeout');assert.equal(checks,1);
 }
});
test('validated Platform errors also recheck identity before retaining their Chat',async()=>{
 const f=fixture();let checks=0;const issue=f.options.issueAgentAccessToken;
 fetcher=async()=>{f.options.issueAgentAccessToken=async()=>++checks===1?{ok:false}:issue();return json({chatId:'chat-1',error:{code:'output_invalid'}},422)};
 const result=await run(f);assert.equal(result.error.code,'output_invalid');assert.equal(result.error.details.chatId,'chat-1');assert.equal(checks,2);
});
test('interrupt obtains a fresh token with the original subject after the execute token has aged',async()=>{
 const f=fixture();let start;const ready=new Promise(resolve=>{start=resolve});let authorization;
 fetcher=async(url,options)=>{
  if(new URL(url).pathname==='/api/interrupt'){authorization=options.headers.Authorization;return json({accepted:true})}
  f.accepted();start();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 };
 const pending=run(f);await ready;
 f.options.issueAgentAccessToken=async()=>({ok:true,token:'h.'+Buffer.from(JSON.stringify({sub:'desktop-app'})).toString('base64url')+'.fresh'});
 f.request.abort();assert.equal((await pending).error.code,'cancelled');
 for(let i=0;i<100&&!authorization;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.match(authorization,/\.fresh$/);
});
test('interrupt rejection emits a fixed diagnostic without credentials or raw errors',async t=>{
 const f=fixture();const records=[];const original=console.warn;console.warn=(...args)=>records.push(args);t.after(()=>{console.warn=original});
 let start;const ready=new Promise(resolve=>{start=resolve});
 fetcher=async(url,options)=>{
  if(new URL(url).pathname==='/api/interrupt')return json({error:{code:'unauthorized',message:'private-secret'}},401);
  f.accepted();start();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 };
 const pending=run(f);await ready;f.request.abort();assert.equal((await pending).error.code,'cancelled');
 for(let i=0;i<100&&!records.some(item=>item[1]?.code==='assistant_interrupt_failed');i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(records.some(item=>item[1]?.code==='assistant_interrupt_failed'));assert.equal(JSON.stringify(records).includes('private-secret'),false);
 assert.ok(records.every(item=>typeof item[1]?.requestId==='string'&&typeof item[1]?.elapsedMs==='number'));
});

test('execution identity probes coalesce across sequential callers in the same short window',async()=>{
 const f=fixture();let states=0;let tokens=0;
 const state=f.options.services.getResponsiveServiceState;const token=f.options.issueAgentAccessToken;
 f.options.services.getResponsiveServiceState=async()=>{states++;return state()};
 f.options.issueAgentAccessToken=async()=>{tokens++;return token()};
 for(let i=0;i<8;i++)assert.equal((await api.probeWebappExecutionIdentity(f.options)).subject,'desktop-app');
 assert.equal(states,1);assert.equal(tokens,1);
});
