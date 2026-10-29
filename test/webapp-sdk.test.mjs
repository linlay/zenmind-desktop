import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient, auth, assistant, automation, artifact, desktop, connector, skill, kanban } from '../contracts/webapp/bridge.mjs';

test('the public SDK uses eight singular namespaces and reports reserved capabilities', async()=>{
 for(const group of [auth,assistant,automation,artifact,desktop,connector,skill,kanban])assert.equal(Object.isFrozen(group),true);
 assert.equal(desktop.native,undefined);assert.equal(desktop.assistant,undefined);
 await assert.rejects(automation.list(),{code:'not_implemented'});
 await assert.rejects(desktop.screen.capture(),{code:'not_implemented'});
});
test('Node backend SDK uses only the injected loopback scope without DOM access',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;assert.equal(url,'http://127.0.0.1:17070/webapps/actions/call');
  assert.equal(options.headers.Authorization,'Bearer scoped');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body),{action:'connector.list',args:{}});
  return new Response(JSON.stringify({ok:true,result:{items:[]}}));
 };
 const client=createBackendClient({url:'http://127.0.0.1:17070/webapps',token:'scoped'});
 assert.deepEqual(await client.connector.list(),{items:[]});assert.equal(client.desktop,undefined);
 await assert.rejects(client.artifact.saveAs({}),{code:'not_implemented'});
 await assert.rejects(client.assistant.image({}),{code:'not_implemented'});assert.equal(calls,1);
 for(const url of ['https://example.test/webapps','http://127.0.0.1:17070','http://user:password@localhost/webapps','http://localhost/webapps?redirect=evil'])assert.throws(()=>createBackendClient({url,token:'scoped'}));
});
test('SDK subscriptions carry cursors, omit protocol internals and stop at terminal',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);assert.deepEqual(body,{action:'assistant.events',args:{runId:'run',cursor:0}});calls++;
  return new Response(JSON.stringify({ok:true,result:{events:[{cursor:1,type:'text.delta',text:'hello'}],cursor:1,terminal:true}}));
 };
 const events=[];for await(const event of assistant.subscribe({runId:'run'}))events.push(event);
 assert.deepEqual(events,[{cursor:1,type:'text.delta',text:'hello'}]);assert.equal(calls,1);
});
test('artifact reads expose bytes rather than filesystem paths',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{dataBase64:Buffer.from('report').toString('base64')}}));
 const stream=await artifact.read({chatId:'chat',artifactId:'report'});
 assert.equal(await new Response(stream).text(),'report');
});

test('execute SDK validates JSON, preserves failure and keeps signal outside the body',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const controller=new AbortController();
 globalThis.fetch=async(_url,options)=>{
  assert.equal(JSON.parse(options.body).action,'assistant.execute');assert.equal(JSON.parse(options.body).args.signal,undefined);
  assert.ok(options.signal);return new Response(JSON.stringify({ok:true,result:{chatId:'chat',status:'failure',reason:'missing'}}));
 };
 const input={message:'extract',input:false,outputSchema:{type:'object'}};
 assert.equal((await assistant.execute(input,{signal:controller.signal})).status,'failure');
 const cycle={};cycle.self=cycle;
 for(const value of [cycle,NaN,new Date(),[,,],{toJSON(){return 'hidden'}}]) await assert.rejects(assistant.execute({...input,input:value}),{code:'invalid_args'});
 await assert.rejects(assistant.execute({...input,skillIds:[]}),{code:'invalid_args'});
 controller.abort();await assert.rejects(assistant.execute(input,{signal:controller.signal}),{code:'cancelled'});
});
test('execute SDK cancellation during response body decoding remains cancelled',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const controller=new AbortController();
 globalThis.fetch=async()=>({ok:true,json:async()=>{controller.abort();throw new DOMException('aborted','AbortError')}});
 await assert.rejects(assistant.execute({message:'test',outputSchema:{type:'object'}},{signal:controller.signal}),{code:'cancelled'});
});

test('execute treats an explicit undefined input as absent and accepts the same 64-level boundary as Main',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let body;
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,result:{chatId:'chat',status:'success',output:{}}}))};
 const input={message:'depth',outputSchema:{type:'object'}};
 await assistant.execute({...input,input:undefined});assert.equal(Object.hasOwn(body.args,'input'),false);
 let value='leaf';for(let i=0;i<64;i++)value={nested:value};
 await assistant.execute({...input,input:value});await assert.rejects(assistant.execute({...input,input:{nested:value}}),{code:'invalid_args'});
});
