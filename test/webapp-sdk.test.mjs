import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient, assistant, automation, artifact, desktop, connector, skill, kanban } from '../contracts/webapp/bridge.mjs';

test('the public SDK uses seven singular namespaces and reports reserved capabilities', async()=>{
 for(const group of [assistant,automation,artifact,desktop,connector,skill,kanban])assert.equal(Object.isFrozen(group),true);
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
