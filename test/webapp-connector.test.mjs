import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
let fetcher;let confirm;
const electron={net:{fetch:(...args)=>fetcher(...args)},dialog:{showMessageBox:(...args)=>confirm(...args)},BrowserWindow:class{constructor(){throw Error('unexpected browser')}},shell:{openExternal:()=>{throw Error('unexpected system browser')}}};
globalThis.__webappConnectorElectron=electron;
const {outputFiles}=await build({stdin:{contents:`export * from './src/main/modules/desktop-actions/webapp-connector'; export * from './src/main/modules/desktop-actions/webapp-assistant'; export * from './src/main/modules/desktop-actions/webapp-platform-client'; export * from './src/main/modules/desktop-actions/webapp-kanban';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module"; const require=createRequire('+JSON.stringify(process.cwd()+'/test/webapp-connector.test.mjs')+');'},plugins:[{name:'ports',setup(b){b.onResolve({filter:/\/artifacts$/},()=>({path:process.cwd()+'/src/main/modules/artifacts/actions.ts'}));b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const {net,dialog,BrowserWindow,shell,session}=globalThis.__webappConnectorElectron;'}));b.onResolve({filter:/agent-platform$/},()=>({path:'auth',namespace:'mock-auth'}));b.onLoad({filter:/.*/,namespace:'mock-auth'},()=>({contents:'export function readEmbeddedAuthorization(){throw Error("unexpected UI")}'}));b.onResolve({filter:/main-i18n$/},()=>({path:'i18n',namespace:'mock-i18n'}));b.onLoad({filter:/.*/,namespace:'mock-i18n'},()=>({contents:'export const t=(key)=>key;'}));}}]});
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const subject='desktop-user:'+'a'.repeat(64);
const token='header.'+Buffer.from(JSON.stringify({sub:subject})).toString('base64url')+'.signature';
const response=data=>new Response(JSON.stringify({code:0,data}),{headers:{'Content-Type':'application/json'}});
let sequence=0;
function fixture(){
 const startedAt=++sequence;
 const items=['one','two'].map(id=>({id}));
 return {app:{},services:{getResponsiveServiceState:async()=>({status:'running',healthMeta:{webUrl:'http://127.0.0.1:1234'}})},issueAgentAccessToken:async()=>({ok:true,token}),webs:{webappManager:{list:()=>items},webappRuntime:{getStatus:()=>({status:'running',startedAt})}},getMainWindow:()=>({isDestroyed:()=>false,webContents:{id:1}})};
}
test('business invocation uses a connector execution grant and revokes it without leaking credentials',async()=>{
 const calls=[];fetcher=async(url,options)=>{calls.push([new URL(url).pathname,options]);if(options.method==='DELETE')return response({revoked:true});if(url.includes('/grants'))return response({token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000});return response({status:'succeeded',output:{items:[]}})};
 const options=fixture(); confirm=async()=>({response:0});
 const result=await api.executeWebappConnector(options,'connector.invoke',{connectorId:'wecom',adapter:'cli',args:['calendar','schedules','list','--json','{}']},{kind:'webappPage',webappId:'one'});
 assert.equal(result.ok,true);assert.equal(calls.length,3);assert.equal(calls[1][1].headers.Authorization,'Bearer wap_test');assert.equal(calls[2][1].method,'DELETE');assert.equal(JSON.stringify(result).includes(token),false);
});
test('obsolete operations, caller-selected URL and backend login are denied',async()=>{
 let calls=0;fetcher=async()=>{calls++;throw Error('unexpected')};confirm=()=>{throw Error('unexpected')};
 for(const [action,args,kind] of [['connector.invoke',{connectorId:'wecom',operationId:'delete',revision:'r',arguments:{}},'webappBackend'],['desktop.authenticateConnector',{connectorId:'wecom',url:'https://evil.test'},'webappPage'],['desktop.authenticateConnector',{connectorId:'wecom'},'webappBackend']]){
 const result=await api.executeWebappConnector(fixture(),action,args,{kind,webappId:'one'});assert.equal(result.ok,false);
 }
 assert.equal(calls,0);
});
test('two WebApps share a host login and receive only its terminal status',async()=>{
 let finish;let prompts=0;confirm=async()=>{prompts++;await new Promise(resolve=>{finish=resolve});return {response:0}};
 fetcher=async()=>response({status:'authorized'});const options=fixture();
 const first=api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'one'});
 const second=api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'two'});
 while(!finish)await new Promise(resolve=>setImmediate(resolve));finish();
 const results=await Promise.all([first,second]);assert.equal(prompts,1);for(const result of results)assert.deepEqual(result,{ok:true,action:'desktop.authenticateConnector',result:{status:'authorized'}});
});
test('identity change during host confirmation prevents login',async()=>{
 const options=fixture();confirm=async()=>{options.issueAgentAccessToken=async()=>({ok:true,token:'header.'+Buffer.from(JSON.stringify({sub:'desktop-user:'+'b'.repeat(64)})).toString('base64url')+'.signature'});return {response:0}};
 let calls=0;fetcher=async()=>{calls++;throw Error('unexpected')};
 const result=await api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'one'});assert.equal(result.result.status,'cancelled');assert.equal(calls,0);
});
test('an uninstalled app releases only its waiter, not another app or the shared Platform session',async()=>{
 const options=fixture();const items=options.webs.webappManager.list();let ready=false;let cancels=0;let starts=0;
 confirm=async()=>({response:0});
 fetcher=async(url,request)=>{
  if(url.includes('/cancel')){cancels++;throw Error('unexpected cancellation')}
  if(request.method==='POST')starts++;
  if(request.method==='GET'&&!url.includes('sessionId='))return response({status:'unauthorized'});
  return response({connectorId:'wecom',sessionId:'shared',status:ready?'authorized':'preparing',expiresAt:new Date(Date.now()+60000).toISOString()});
 };
 const a=api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'one'});
 const b=api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'two'});
 while(!starts)await new Promise(resolve=>setImmediate(resolve));items.splice(0,1);
 const first=await a;assert.equal(first.result.status,'cancelled');ready=true;
 const second=await b;assert.equal(second.result.status,'authorized');assert.equal(starts,1);assert.equal(cancels,0);
});

test('legacy access requests succeed without declarations or confirmation',async()=>{
 const options=fixture();let calls=0;fetcher=async()=>{calls++;throw Error('unexpected')};
 confirm=()=>{throw Error('installation is already consent')};
 const page={kind:'webappPage',webappId:'one'};
 for(const input of [{capability:'kanban.read'},{capability:'connector.execute',connectorId:'wecom',adapter:'cli'}]) {
  assert.equal((await api.executeWebappConnector(options,'desktop.requestAccess',input,page)).result.status,'granted');
 }
 assert.equal(calls,0);
 const backend=await api.executeWebappConnector(options,'desktop.requestAccess',{capability:'kanban.read'},{kind:'webappBackend',webappId:'one'});
 assert.equal(backend.error.code,'forbidden');
});

test('a revoked runtime signal blocks response delivery and further calls',async()=>{
 const options=fixture();const controller=new AbortController();
 const invocation={kind:'webappPage',webappId:'one',signal:controller.signal};let deleted=0;
 fetcher=async(url,request)=>{
  if(request.method==='DELETE'){deleted++;return response({revoked:true})}
  if(url.includes('/grants'))return response({token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000});
  controller.abort();return response({items:[]});
 };
 const result=await api.executeWebappConnector(options,'connector.describe',{connectorId:'wecom'},invocation);
 assert.equal(result.error.code,'app_grant_required');assert.equal(deleted,1);
 const again=await api.executeWebappConnector(options,'connector.describe',{connectorId:'wecom'},invocation);
 assert.equal(again.error.code,'app_grant_required');
});

test('an existing token cannot switch to another personal account',async()=>{
 const options=fixture();const controller=new AbortController();
 const invocation={kind:'webappPage',webappId:'one',signal:controller.signal};
 fetcher=async(url,request)=>response(url.includes('/grants')&&request.method==='POST'?{token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000}:{items:[]});
 assert.equal((await api.executeWebappConnector(options,'connector.describe',{connectorId:'wecom'},invocation)).ok,true);
 options.issueAgentAccessToken=async()=>({ok:true,token:'h.'+Buffer.from(JSON.stringify({sub:'desktop-user:'+'b'.repeat(64)})).toString('base64url')+'.s'});
 const result=await api.executeWebappConnector(options,'connector.describe',{connectorId:'wecom'},invocation);
 assert.equal(result.error.code,'app_grant_required');
});

test('artifacts require the owning app runtime and explicit chat context',async()=>{
 const options=fixture();let calls=0;fetcher=async()=>{calls++;throw Error('unexpected')};
 for(const args of [{artifactId:'artifact'},{chatId:'other-chat',artifactId:'artifact'}]){
  const result=await api.executeWebappConnector(options,'artifact.get',args,{kind:'webappBackend',webappId:'one'});
  assert.equal(result.error.code,'app_grant_required');
 }
 assert.equal(calls,0);
});

test('skills expose only declared keys and safe metadata',async()=>{
 const options=fixture();options.webs.webappManager.list()[0].copilot={agentKey:'writer',mustUseSkills:['writing']};
 fetcher=async(url)=>{
  assert.equal(new URL(url).searchParams.get('agentKey'),'writer');
  return response({skills:[{key:'writing',name:'Writing',description:'Write',agentHasSkill:true,path:'/private/skills',token:'secret'},{key:'private',name:'Hidden'}]});
 };
 const result=await api.executeWebappConnector(options,'skill.list',{}, {kind:'webappBackend',webappId:'one'});
 assert.deepEqual(result.result,{items:[{skillId:'writing',name:'Writing',description:'Write',agentHasSkill:true}]});
 const hidden=await api.executeWebappConnector(options,'skill.describe',{skillId:'private'},{kind:'webappBackend',webappId:'one'});
 assert.equal(hidden.error.code,'skill_not_found');
});

test('background runs expose bounded safe events and cannot be stopped by another app',async()=>{
 const options=fixture();const controller=new AbortController();let observer;let detached=0;let stops=0;
 options.assistantBridge={
  startRun:async()=>({ok:true,chatId:'owned-chat',runId:'owned-run'}),
  observeRun:async(input)=>{observer=input;return {ready:Promise.resolve(),unsubscribe:()=>{detached++}}},
  stopRun:async()=>{stops++;return {ok:true}}
 };
 const context=await api.captureWebappContext(options,'one',controller.signal);
 const accepted=await api.startWebappAssistant(options,context,{agentKey:'writer',message:'hello'});
 assert.equal(accepted.accepted,true);
 observer.onEvent({type:'tool.result',token:'secret',result:{private:'value'}});
 observer.onEvent({type:'content.delta',delta:'x'.repeat(5000),token:'secret'});
 const result=await api.executeWebappAssistant(options,'assistant.events',{runId:'owned-run'},{kind:'webappBackend',webappId:'one',signal:controller.signal});
 assert.equal(result.result.events.filter(item=>item.type==='text.delta').map(item=>item.text).join('').length,5000);
 assert.equal(JSON.stringify(result).includes('secret'),false);
 const foreign=await api.executeWebappAssistant(options,'assistant.stop',{runId:'owned-run'},{kind:'webappBackend',webappId:'two'});
 assert.equal(foreign.error.code,'app_grant_required');assert.equal(stops,0);
 observer.onComplete({reason:'completed'});
 const terminal=await api.executeWebappAssistant(options,'assistant.events',{runId:'owned-run',cursor:result.result.cursor},{kind:'webappBackend',webappId:'one',signal:controller.signal});
 assert.equal(terminal.result.terminal,true);assert.equal(terminal.result.events.length,1);
 controller.abort();assert.ok(detached>0);
});

test('artifact grants are chat-scoped; restarting an app loses previous chat access',async()=>{
 const options=fixture();const context=await api.captureWebappContext(options,'one');
 api.rememberWebappChat(context.key,'chat');let deleted=0;
 fetcher=async(url,request)=>{
  if(request.method==='DELETE'){deleted++;return response({revoked:true})}
  if(url.includes('/grants')){assert.deepEqual(JSON.parse(request.body),{version:2,appId:'one',execution:[],chatIds:['chat']});return response({token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000})}
  return response({items:[{chatId:'chat',artifactId:'a',name:'report.txt'}]});
 };
 const own=await api.executeWebappConnector(options,'artifact.list',{chatId:'chat'},{kind:'webappBackend',webappId:'one'});
 assert.equal(own.ok,true);assert.equal(deleted,1);
 const other=await api.executeWebappConnector(options,'artifact.list',{chatId:'chat'},{kind:'webappBackend',webappId:'two'});
 assert.equal(other.error.code,'app_grant_required');
 options.webs.webappRuntime.getStatus=()=>({status:'running',startedAt:'new'});
 const restarted=await api.executeWebappConnector(options,'artifact.list',{chatId:'chat'},{kind:'webappBackend',webappId:'one'});
 assert.equal(restarted.error.code,'app_grant_required');
});

test('artifact reads reject oversized bytes and always revoke the grant',async()=>{
 const options=fixture();const context=await api.captureWebappContext(options,'one');api.rememberWebappChat(context.key,'chat');let deleted=0;
 fetcher=async(url,request)=>{
  if(request.method==='DELETE'){deleted++;return response({revoked:true})}
  if(url.includes('/grants'))return response({token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000});
  return new Response(new Uint8Array(1024*1024+1));
 };
 const result=await api.executeWebappConnector(options,'artifact.read',{chatId:'chat',artifactId:'a'},{kind:'webappBackend',webappId:'one'});
 assert.equal(result.error.code,'artifact_too_large');assert.equal(deleted,1);
});

test('Kanban only exposes read projections and suppresses disconnected cloud cache',async()=>{
 const options=fixture();confirm=()=>{throw Error('unexpected consent')};
 options.getKanbanRuntime=()=>({listIssues:()=>({ok:true,connectionState:'closed',boardId:'cloud-board',projects:[],issues:[
  {id:'local',title:'Local',syncMode:'local',status:'todo',priority:1,runtimePath:'/private/local',chatId:'other-chat'},
  {id:'cloud',title:'Cloud',syncMode:'cloud',status:'todo',priority:1}
 ]})});
 const invocation={kind:'webappBackend',webappId:'one'};
 const result=await api.executeWebappKanban(options,'kanban.issues.list',{},invocation);
 assert.equal(result.result.items.length,1);assert.equal(result.result.items[0].id,'local');
 assert.equal(JSON.stringify(result).includes('/private'),false);assert.equal(JSON.stringify(result).includes('other-chat'),false);
});

test('connector login needs no manifest declaration',async()=>{
 const options=fixture();confirm=async()=>({response:0});const calls=[];
 fetcher=async(url,request)=>{calls.push(url);assert.equal(new URL(url).pathname,'/api/desktop/connector/auth');assert.equal(request.method,'GET');return response({status:'authorized'})};
 const result=await api.executeWebappConnector(options,'desktop.authenticateConnector',{connectorId:'wecom'},{kind:'webappPage',webappId:'one'});
 assert.equal(result.result.status,'authorized');assert.equal(calls.length,1);
});

test('connector discovery lists installed adapters without exposing catalog internals',async()=>{
 const options=fixture();confirm=()=>{throw Error('unexpected consent')};
 fetcher=async(url,request)=>{assert.equal(new URL(url).pathname,'/api/connectors');assert.equal(request.method,'GET');return response({connectors:[
  {id:'wecom',name:'WeCom',version:'1.0.0',hasCli:true,hasMcp:true,preparation:{path:'/private'}},
  {id:'no-adapter',name:'Other',hasCli:false,hasMcp:false}
 ]})};
 const result=await api.executeWebappConnector(options,'connector.list',{}, {kind:'webappPage',webappId:'one'});
 assert.deepEqual(result.result,{items:[{connectorId:'wecom',name:'WeCom',packageVersion:'1.0.0',adapters:['cli','mcp']}]});
});

test('CLI and MCP execute without consent; backend and obsolete payloads remain invalid',async()=>{
 const options=fixture();
 const grants=[];fetcher=async(url,request)=>{
  if(request.method==='DELETE')return response({revoked:true});
  if(url.includes('/grants')){grants.push(JSON.parse(request.body));return response({token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000})}
  return response({exitCode:0,stdout:'{"success":true}'});
 };
 confirm=()=>{throw Error('unexpected consent')};const page={kind:'webappPage',webappId:'one'};
 const input={connectorId:'wecom',adapter:'cli',args:['message','aibot','send','--json','{"text":"%PATH% & 中文"}'],idempotencyKey:'daily-key-123'};
 assert.equal((await api.executeWebappConnector(options,'connector.invoke',input,page)).ok,true);
 assert.deepEqual(grants.at(-1),{version:2,appId:'one',execution:[{connectorId:'wecom',adapter:'cli'}]});
 const backend=await api.executeWebappConnector(options,'connector.invoke',input,{kind:'webappBackend',webappId:'one'});
 assert.equal(backend.error.code,'forbidden');assert.equal(grants.length,1);
 const mcp=await api.executeWebappConnector(options,'connector.invoke',{connectorId:'wecom',adapter:'mcp',component:'main',toolName:'send',arguments:{}},page);
 assert.equal(mcp.ok,true);
 assert.deepEqual(grants.at(-1).execution,[{connectorId:'wecom',adapter:'mcp'}]);
 const legacy=await api.executeWebappConnector(options,'connector.invoke',{connectorId:'wecom',operationId:'message.send',revision:'old',arguments:{}},page);
 assert.equal(legacy.error.code,'connector_contract_upgrade_required');
 const oldAccess=await api.executeWebappConnector(options,'desktop.requestAccess',{capability:'connector.read'},page);
 assert.equal(oldAccess.error.code,'invalid_arguments');
});

test('legacy restrictive declarations do not constrain installed apps',async()=>{
 const options=fixture();options.webs.webappManager.list()[0].desktopBridge={version:1,kanbanRead:false,connectorExecution:[]};
 confirm=()=>{throw Error('unexpected consent')};
 fetcher=async(url,request)=>response(url.includes('/grants')&&request.method==='POST'?{token:'wap_test',grantId:'g',appId:'one',expiresAt:Date.now()+60000}:{exitCode:0});
 assert.equal((await api.executeWebappConnector(options,'connector.invoke',{connectorId:'another',adapter:'cli',args:['status']},{kind:'webappPage',webappId:'one'})).ok,true);
});
