import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const market = require('../dist-electron/main/modules/marketplace/connector-market.js');
const state = require('../dist-electron/main/modules/marketplace/connector-state.js');
const custom = require('../dist-electron/main/modules/marketplace/connector-custom.js');
const JSZip = require('jszip');
const connection = (extra = {}) => ({connectorId:'example.office',bound:true,enabled:false,readiness:'disabled',authentication:{connectorId:'example.office',status:'configured'},capabilities:{canConnect:true,canDisconnect:true,canEnable:true,hasCli:true,hasMcp:false,authMode:'token',authBrowser:'system'},...extra});

test('connection projection preserves configured status without leaking private fields', () => {
 const value = state.normalizeConnectorConnection({...connection(),credentials:{API_KEY:'secret'},internalPath:'/private'},'example.office');
 assert.equal(value.authentication.status,'configured');
 assert.equal(value.authentication.sessionId,'');
 assert.equal(value.credentials,undefined);
 assert.equal(value.internalPath,undefined);
 assert.throws(()=>state.normalizeConnectorConnection(connection({bound:false,enabled:true}),'example.office'));
});
test('authorization rejects mismatched, expired or non-web sessions and drops terminal URLs', () => {
 const auth={connectorId:'example.office',status:'pending',sessionId:'session-1',expiresAt:new Date(Date.now()+60000).toISOString(),authorizationUrl:'https://accounts.example.test/login'};
 assert.equal(state.normalizeConnectorAuth(auth,'example.office').authorizationUrl,auth.authorizationUrl);
 for(const override of [{connectorId:'other'},{sessionId:''},{expiresAt:'2000-01-01'},{authorizationUrl:'file:///etc/passwd'},{authorizationUrl:'https://user:secret@example.test/'}]) assert.throws(()=>state.normalizeConnectorAuth({...auth,...override},'example.office'));
 assert.equal(state.normalizeConnectorAuth({...auth,status:'authorized'},'example.office').authorizationUrl,undefined);
});
test('exact cancellation and explicit enable use bounded structured inputs', async(t)=>{
 const calls=[]; market.configureConnectorMarketPlatformCaller(async(path,options)=>{calls.push([path,options]);return connection();});
 t.after(()=>market.configureConnectorMarketPlatformCaller(null));
 await state.cancelConnectorConnection({connectorId:'example.office',sessionId:'session-1'});
 assert.equal(calls[0][0],'/api/admin/connectors/auth/cancel?id=example.office&sessionId=session-1');
 await assert.rejects(state.setConnectorConnectionEnabled({connectorId:'example.office',enabled:'true'}));
 assert.equal(calls.length,2);
});
test('custom connector forwards original JSON in a fixed ZIP and never enables it', async(t)=>{
 const calls=[]; const json='{"id":"example.office","id":"duplicate","type":"cli"}';
 market.configureConnectorMarketPlatformCaller(async(path,options)=>{
  calls.push(path); const body=Buffer.from(options.rawBody); const start=body.indexOf(Buffer.from('PK\x03\x04')); const end=body.lastIndexOf(Buffer.from('\r\n--desktop-connector-'));
  const zip=await JSZip.loadAsync(body.subarray(start,end));
  assert.deepEqual(Object.keys(zip.files),['connector.json','cli.json']);
  assert.equal(await zip.file('connector.json').async('string'),json);
  return {installed:true,id:'example.office',name:'Office',version:'1.0.0'};
 });t.after(()=>market.configureConnectorMarketPlatformCaller(null));
 const result=await custom.createCustomConnector({connectorJson:json,cliJson:'{}'});
 assert.equal(result.connectorId,'example.office'); assert.deepEqual(calls,['/api/admin/connectors/import']);
 await assert.rejects(custom.createCustomConnector({connectorJson:'{}',filename:'../escape'}));
 await assert.rejects(custom.createCustomConnector({connectorJson:{id:'example'}}));
});
test('Agent keys retain case and business permissions stay server authoritative',async(t)=>{
 market.configureConnectorMarketPlatformCaller(async(path,options)=>{
  assert.equal(path,'/api/admin/agents/connectors');assert.equal(options.body.agentKey,'ResearchAgent');
  return {agentKey:'ResearchAgent',connectorIds:['example.office'],activeConnectorIds:[],reloadPending:true};
 });t.after(()=>market.configureConnectorMarketPlatformCaller(null));
 assert.equal((await state.setConnectorAgent({agentKey:'ResearchAgent',connectorId:'example.office',enabled:true})).reloadPending,true);
});

test('connector IPC rejects foreign windows/frames before file selection or mutation',async()=>{
 const {registerMarketplaceIpcHandlers}=require('../dist-electron/main/modules/marketplace/ipc.js');
 const handlers=new Map(),frame={},webContents={mainFrame:frame,isDestroyed:()=>false};
 let dialogs=0;
 registerMarketplaceIpcHandlers({handle:(name,fn)=>handlers.set(name,fn)},{app:{},mainWindow:{webContents,isDestroyed:()=>false},showArchiveDialog:async()=>{dialogs++;return {canceled:true,filePaths:[]};},t:key=>key});
 for(const key of ['market.getCustomMcpConfig','market.saveCustomMcpConfig','market.importConnector','market.createConnector','market.connectConnector','market.saveConnectorCredentials','market.setConnectorAgent']) {
  await assert.rejects(handlers.get(key)({sender:{},senderFrame:frame},{}),/forbidden/);
  await assert.rejects(handlers.get(key)({sender:webContents,senderFrame:{}},{}),/forbidden/);
 }
 assert.equal(dialogs,0);
 assert.equal((await handlers.get('market.importConnector')({sender:webContents,senderFrame:frame})).canceled,true);
 assert.equal(dialogs,1);
});
test('market package expectations are passed to Platform before activation',async(t)=>{
 market.configureConnectorMarketPlatformCaller(async(_path,options)=>{
  const body=Buffer.from(options.rawBody).toString('utf8');
  assert.match(body,/name="expectedId"\r\n\r\nexample.office/);
  assert.match(body,/name="expectedVersion"\r\n\r\n1\.0\.0/);
  throw new Error('INVALID_PACKAGE: identity mismatch');
 });t.after(()=>market.configureConnectorMarketPlatformCaller(null));
 await assert.rejects(market.importConnectorBytes(Buffer.from('ZIP'),false,{id:'example.office',version:'1.0.0'}),/identity mismatch/);
});
