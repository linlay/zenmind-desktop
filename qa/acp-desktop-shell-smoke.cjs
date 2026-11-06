// Real Desktop composition, preload, renderer and managed services in an isolated home.
// Build/sync current service bundles and both Desktop builds first.
// ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
// ACP_ENGINE=claude selects the independently packaged Claude plugin.
// ACP_BACKGROUND_DRAIN=1 with ACP_ACTIVE_DRAIN exercises real background command trees.
// ACP_BACKGROUND_KILL=platform|adapter checks background tree cleanup and explicit memory recovery.
// ACP_ACTIVE_DRAIN=complete|cancel checks the other plugin active uninstall and drain.
// ACP_ACTIVE_UPGRADE_ARCHIVE=<other plugin candidate ZIP> checks two active Runs across an upgrade.
// ACP_NODE_UPDATE=1 checks shared-runtime update admission before shutdown (no signed app install).
// ACP_ISOLATION_ARCHIVE=<other plugin candidate ZIP> checks update/disable/uninstall isolation.
// ACP_PLATFORM_KILL=1 also checks active Run failure and memory after host SIGKILL.
// Native file-picker results and isolation uninstall confirmation are fixture inputs; product IPC/UI are real.
if (process.type !== 'browser') {
  const fs = require('node:fs'), path = require('node:path');
  const {execFileSync, spawn} = require('node:child_process');
  require('node:assert/strict').equal(process.platform,'darwin','Native macOS acceptance only');
  require('node:assert/strict').equal(process.env.ACP_LIVE_AUTH,'1','Explicit login/model-call opt-in required');
  const output=path.resolve('build/qa/acp-product');fs.mkdirSync(output,{recursive:true});
  const bundle=path.join(output,'Electron.app');
  fs.rmSync(bundle,{recursive:true,force:true});
  fs.rmSync(path.join(output,'shell-passed'),{force:true});
  if(process.env.ACP_NODE_UPDATE)for(const suffix of ['.json','-events.json','.png'])fs.rmSync(path.join(output,'shell-node-update'+suffix),{force:true});
  if(process.env.ACP_ACTIVE_UPGRADE_ARCHIVE)for(const name of ['shell-active-upgrade.json','shell-active-upgrade-events.json','shell-active-upgrade.png'])fs.rmSync(path.join(output,name),{force:true});
  if(process.env.ACP_BACKGROUND_KILL)for(const name of ['shell-background-kill-start.json','shell-background-kill-before.json','shell-background-kill.json','shell-background-kill-events.json','shell-background-kill.png'])fs.rmSync(path.join(output,name),{force:true});
  execFileSync('/bin/cp',['-cR',path.resolve(require('electron'),'../../..'),bundle]);
  // Stock Electron omits this Helper field. Declare its existing binary only
  // in the disposable QA copy, following the normal macOS dev-shell preparation.
  const plist=path.join(bundle,'Contents/Frameworks/Electron Helper.app/Contents/Info.plist');
  execFileSync('/usr/bin/plutil',['-replace','CFBundleExecutable','-string','Electron Helper',plist]);
  execFileSync('/usr/bin/plutil',['-replace','LSUIElement','-bool','true',plist]);
  execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'ignore'});
  const child=spawn(path.join(bundle,'Contents/MacOS/Electron'),[__filename],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  child.once('error',error=>{console.error(error);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code===0 && fs.existsSync(path.join(output,'shell-passed')) ? 0 : 1;});
  return;
}
const {app, BrowserWindow, webContents, dialog, ipcMain} = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
assert.equal(process.env.ACP_LIVE_AUTH,'1','Opt in to existing login and real model calls with ACP_LIVE_AUTH=1');
const engine = process.env.ACP_ENGINE || 'codex';
assert.ok(['codex','claude'].includes(engine));
assert.ok(engine === 'codex' || !process.env.ACP_DISCONNECT, 'TCP disconnect approval scenario is Codex-specific');
assert.ok(!process.env.ACP_PLATFORM_KILL || (!process.env.ACP_CLAUDE_AUTH && !process.env.ACP_CLAUDE_INTERACTIONS), 'Run lifecycle separately from Claude auth/tool scenarios');
const backgroundKill = process.env.ACP_BACKGROUND_KILL;
assert.ok(!backgroundKill || (['platform','adapter'].includes(backgroundKill) && !process.env.ACP_ACTIVE_DRAIN && !process.env.ACP_ACTIVE_UPGRADE_ARCHIVE && !process.env.ACP_ISOLATION_ARCHIVE && !process.env.ACP_UPGRADE_ARCHIVE && !process.env.ACP_PLATFORM_KILL && !process.env.ACP_DISCONNECT && !process.env.ACP_CLAUDE_AUTH && !process.env.ACP_CLAUDE_INTERACTIONS), 'Run background kill separately');
const activeUpgrade = process.env.ACP_ACTIVE_UPGRADE_ARCHIVE;
const nodeUpdate = process.env.ACP_NODE_UPDATE === '1';
assert.ok(!nodeUpdate || (!activeUpgrade && !process.env.ACP_ACTIVE_DRAIN && !process.env.ACP_BACKGROUND_DRAIN && !backgroundKill), 'Run shared Node update separately');
const drainMode = process.env.ACP_ACTIVE_DRAIN || (activeUpgrade || nodeUpdate ? 'complete' : undefined);
const backgroundDrain = process.env.ACP_BACKGROUND_DRAIN === '1';
assert.ok(!activeUpgrade || (!process.env.ACP_ACTIVE_DRAIN && !backgroundDrain), 'Run active upgrade separately from uninstall/background scenarios');
assert.ok(!backgroundDrain || drainMode, 'Background scenario requires active drain');
assert.ok(!drainMode || (['complete','cancel'].includes(drainMode) && !process.env.ACP_ISOLATION_ARCHIVE && !process.env.ACP_UPGRADE_ARCHIVE && !process.env.ACP_PLATFORM_KILL && !process.env.ACP_DISCONNECT && !process.env.ACP_CLAUDE_AUTH && !process.env.ACP_CLAUDE_INTERACTIONS), 'Run active drain separately');
const isolationArchive = process.env.ACP_ISOLATION_ARCHIVE;
assert.ok(!isolationArchive || (!process.env.ACP_UPGRADE_ARCHIVE && !process.env.ACP_PLATFORM_KILL && !process.env.ACP_DISCONNECT && !process.env.ACP_CLAUDE_AUTH && !process.env.ACP_CLAUDE_INTERACTIONS), 'Run isolation separately');
const firstMarker = (isolationArchive || drainMode || backgroundKill) ? `ISOLATION_${require('node:crypto').randomUUID()}` : engine === 'claude' && (process.env.ACP_PLATFORM_KILL === '1' || process.env.ACP_UPGRADE_ARCHIVE) ? `CLAUDE_KILL_${require('node:crypto').randomUUID()}` : 'SHELL_BROKER_READY';
const upgradeArchive = process.env.ACP_UPGRADE_ARCHIVE;
assert.ok(!upgradeArchive || (engine === 'claude' && !process.env.ACP_PLATFORM_KILL && !process.env.ACP_DISCONNECT && !process.env.ACP_CLAUDE_AUTH && !process.env.ACP_CLAUDE_INTERACTIONS), 'Run Claude upgrade separately');
const pluginId = `zenmind-agent-${engine}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-shell-'));
fs.chmodSync(root, 0o700);
for (const name of ['home','appData','userData','sessionData','desktop','temp']) {
  const directory=path.join(root,name); fs.mkdirSync(directory); app.setPath(name,directory);
}
app.setAppPath(path.resolve('.'));
const runtimeRoot=path.join(root,'home/.zenmind');
fs.mkdirSync(path.join(runtimeRoot,'registries'),{recursive:true});
fs.writeFileSync(path.join(runtimeRoot,'registries/.qa'),'isolated acceptance');
fs.writeFileSync(path.join(runtimeRoot,'desktop-init.json'),JSON.stringify({services:{'agent-platform':{lifecycleArgs:{deploy:['--document-preview-api-base-url','http://127.0.0.1:1','--document-preview-public-base-url','http://127.0.0.1:1']}},'agent-webclient':{lifecycleArgs:{start:['--base-url','http://127.0.0.1:7078']}}}}));
const output=path.resolve('build/qa/acp-product'); fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'shell-root'),root);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let main;
async function until(check, description, timeout=120000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await pause(200);}throw Error('Timed out: '+description);}
const js=code=>Promise.race([main.webContents.executeJavaScript(code),pause(45000).then(()=>{throw Error('Renderer request timed out');})]);
function copyAuthorizedProfile(profile, name) {
 const directory=path.join(profile,name);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,name==='codex'?'auth.json':'settings.json');
 if(name==='codex')fs.copyFileSync(path.join(os.homedir(),'.codex/auth.json'),file);
 else {
  // Reuse only the authorized gateway credential and endpoint, never hooks/MCP/history.
  const local=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude/settings.json'),'utf8'));
  const env=Object.fromEntries(['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL'].filter(key=>local.env?.[key]).map(key=>[key,local.env[key]]));
  assert.ok(env.ANTHROPIC_AUTH_TOKEN||env.ANTHROPIC_API_KEY,'authorized local Claude credentials required');
  fs.writeFileSync(file,JSON.stringify({env}),{mode:0o600});
 }
 fs.chmodSync(file,0o600);return file;
}
async function uninstallConfirmed(id, name) {
 const original=dialog.showMessageBox;let confirmations=0;
 dialog.showMessageBox=async(...args)=>{
  const options=args.at(-1);assert.ok(options.message.includes(name==='claude'?'Claude':'Codex'));
  assert.deepEqual(options.buttons,['Cancel','Uninstall']);confirmations++;return {response:1,checkboxChecked:false};
 };
 try {
  const result=await js(`window.electronAPI.plugins.uninstall(${JSON.stringify(id)}).catch(error=>({ok:false,message:error.message}))`);
  assert.equal(confirmations,1);return result;
 } finally {dialog.showMessageBox=original;}
}
const profiles=path.join(runtimeRoot,'agent-engine-profiles');
app.on('will-quit',()=>fs.rmSync(profiles,{recursive:true,force:true}));
const frameTypes=[];
// Drop real TCP connections below WebSocket, without fabricating protocol frames.
const sockets = new Set();
const upstreamFrames = [];
let relay, upstreamURL, lastQuery, disconnectUntil = 0;
async function enableDisconnectProbe() {
 const net = require('node:net');
 relay = net.createServer(client => {
  if (Date.now() < disconnectUntil) { client.destroy(); return; }
  const upstream = net.connect(Number(upstreamURL.port), upstreamURL.hostname);
  for (const socket of [client, upstream]) {
   sockets.add(socket);
   socket.on('close', () => sockets.delete(socket));
   socket.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
 });
 await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
 const OriginalWebSocket = globalThis.WebSocket;
 globalThis.WebSocket = class extends OriginalWebSocket {
  constructor(url) {
   const target = new URL(url);
   const primary = target.searchParams.get('source') === 'desktop-main';
   if (primary) {
    assert.equal(target.hostname, '127.0.0.1');
    upstreamURL = new URL(target);
    target.port = String(relay.address().port);
   }
   super(target.toString());
   this.primary = primary;
  }
  send(data) {
   if (this.primary) {
    const frame = JSON.parse(data);
    upstreamFrames.push({type: frame.type, runId: frame.payload?.runId, lastSeq: frame.payload?.lastSeq});
    if (frame.type === '/api/query') lastQuery = frame.payload;
   }
   return super.send(data);
  }
 };
 app.on('will-quit', () => { for (const socket of sockets) socket.destroy(); relay.close(); });
}
const {AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL: SEND}=require('../dist-electron/shared/contracts/agent-webclient-bridge.js');
ipcMain.on(SEND, (_event, request)=>{if(request?.frame?.type)frameTypes.push(request.frame.type);});
(async()=>{
 if (backgroundKill || drainMode || isolationArchive || engine === 'claude' || process.env.ACP_DISCONNECT === '1' || process.env.ACP_PLATFORM_KILL === '1') await enableDisconnectProbe();
 require('../dist-electron/main/index.js');
 await app.whenReady();
 await until(()=>{main=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('index.html'));return main;},'main window');
 await until(()=>js('!!window.electronAPI?.services'),'main preload');
 console.log('PASS real Desktop main window and preload', root);
 await until(async()=>{const state=await js('window.electronAPI.services.getStartupRestoreState()');fs.writeFileSync(path.join(output,'shell-startup.json'),JSON.stringify(state,null,2));if(state.phase==='failed')throw Error('Service startup failed: '+state.message);return state.phase==='succeeded';},'services ready',180000);
 fs.writeFileSync(path.join(output,'shell.png'),(await main.webContents.capturePage()).toPNG());
 console.log('SHELL READY');
 const runtimeConfig='http-proxy:\n  mode: fixed\n  url: http://127.0.0.1:7890\ncontainer-hub:\n  enabled: false\nautomation:\n  enabled: false\n';
 const configured=await js(`window.electronAPI.services.writeConfig("agent-platform","runtime",${JSON.stringify(runtimeConfig)})`);
 assert.equal(configured.ok,true,configured.message);
 const restarted=await js('window.electronAPI.services.restart("agent-platform")');
 assert.equal(restarted.ok,true,restarted.message);
 const archive=path.resolve(`../zenmind-agent-plugins/build/${pluginId}/0.1.0/darwin-arm64/${pluginId}-darwin-arm64.zip`);
 const originalDialog=dialog.showOpenDialog;
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]});
 await js("location.hash='#/settings/plugins'");
 await until(()=>js('!!document.querySelector(".service-catalog-import")'),'local plugin install entry');
 await js('document.querySelector(".service-catalog-import").click()');
 await until(async()=>JSON.stringify(await js('window.electronAPI.services.list()')).includes(pluginId),'installed plugin');
 dialog.showOpenDialog=originalDialog;
 const enabled=await js(`window.electronAPI.services.start(${JSON.stringify(pluginId)})`);
 assert.equal(enabled.ok,true,enabled.message);
 fs.writeFileSync(path.join(output,'shell-engine-state.json'),JSON.stringify(enabled.service,null,2));
 assert.equal(enabled.service.agentEngineSync?.lastError,'','engine enable synchronization');
 await until(async()=>{
  const result=await js('window.electronAPI.assistant.getProjectCreationOptions()');
  const external=result.options?.types.find(type=>type.key==='acp');
  fs.writeFileSync(path.join(output,'shell-creation-options.json'),JSON.stringify(external,null,2));
  return external?.available===true;
 },'enabled synchronized engine');
 console.log('PASS main shell local install UI → managed service enable → synchronized creation options');
 await js("location.hash='#/agent/qa'");
 await until(() => webContents.getAllWebContents().some(view => view.getType() === 'webview' && view.getURL().includes('/agent/qa')), 'main chat route mounted');
 await js("document.querySelector('.sidebar-settings-back')?.click()");
 await until(()=>js('!!document.querySelector(".sidebar-assistant-project-button")'),'new project action');
 await js('document.querySelector(".sidebar-assistant-project-button").click()');
 await until(()=>js('!!document.querySelector("input[value=acp]:not(:disabled)")'),'available external project type');
 await js('document.querySelector("input[value=acp]").click()');
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});
 await js('document.querySelector(".sidebar-project-directory-row button").click()');
 await until(()=>js(`document.querySelector('.sidebar-project-directory-row input').value === ${JSON.stringify(workspace)}`),'selected workspace');
 dialog.showOpenDialog=originalDialog;
 await until(()=>js('document.querySelector("button[type=submit]") && !document.querySelector("button[type=submit]").disabled'),'valid external project');
 await js('document.querySelector("button[type=submit]").click()');
 let guest;
 await until(()=>{guest=webContents.getAllWebContents().find(w=>w.getType()==='webview' && /\/agent\//.test(w.getURL()) && !/\/agent\/qa(?:\?|$)/.test(w.getURL()));return guest;},'Main Chat guest');
 const guestJS=source=>{guest=webContents.getAllWebContents().find(w=>w.getType()==='webview' && /\/agent\/acp-/.test(w.getURL()));return guest ? guest.executeJavaScript(source) : Promise.resolve(false);};
 await until(()=>guestJS('!!document.querySelector("#message-input")'),'real Composer');
 fs.writeFileSync(path.join(output,'shell-project.png'),(await main.webContents.capturePage()).toPNG());
 console.log('PASS real project dialog → Main Chat WebView');
 await guestJS(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Prepare session / refresh settings')?.click()`);
 await until(()=>fs.existsSync(path.join(runtimeRoot,'agent-engine-profiles')),'isolated engine profile');
 async function provisionProfile() {
 assert.equal((await js('window.electronAPI.services.stop("agent-platform")')).ok,true);
 const entries=fs.readdirSync(profiles);assert.equal(entries.length,1);
 copyAuthorizedProfile(path.join(profiles,entries[0]),engine);
 assert.equal((await js('window.electronAPI.services.start("agent-platform")')).ok,true);
 // The frontend guest stays mounted while the Broker reconnects to Platform.
 await until(()=>guestJS('!!document.querySelector("button[aria-label=Send]") && !document.querySelector("#message-input").disabled'),'authenticated Composer');
 await guestJS(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Prepare session / refresh settings')?.click()`);
 }
 async function send(text, waitForFinish = true, finishTimeout = 180000){
  await until(()=>guestJS('!!document.querySelector("#message-input") && !document.querySelector("#message-input").disabled && !document.querySelector("#interrupt-btn")'),'chat ready after service change');
  await guestJS(`(()=>{const input=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  let refreshed = false;
  async function refreshIfNeeded() {
   if (refreshed || !await guestJS(`(()=>{const panel=document.querySelector('section[aria-label="External session settings"]');return !!panel?.querySelector('[role="alert"]') && Array.from(panel.querySelectorAll('button')).some(button=>button.textContent==='Prepare session / refresh settings' && !button.disabled)})()`)) return;
   refreshed=true;
   await guestJS(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Prepare session / refresh settings').click()`);
   console.log('UI explicit prepare of the still-unsent draft');
  }
  const sendEnabled = () => guestJS('!!document.querySelector("button[aria-label=Send]") && !document.querySelector("button[aria-label=Send]").disabled');
  await until(async()=>{await refreshIfNeeded();return sendEnabled();},'send enabled');
  const sentBefore = frameTypes.filter(type=>type==='/api/query').length;
  await guestJS('document.querySelector("button[aria-label=Send]").click()');
  await until(async()=>{
   // Authentication can fail before the first UI polling interval. A submitted
   // Query is never an unsent draft: inspect its terminal instead of retrying it.
   if (frameTypes.filter(type=>type==='/api/query').length > sentBefore) {
    if (await guestJS('!!document.querySelector("#interrupt-btn")')) return true;
    if (!lastQuery) return false;
    const current=await chat();
    const starts=current.events.filter(event=>event.type==='run.start');
    return starts.length > sentBefore && current.events.some(event=>event.runId===starts.at(-1).runId && ['run.complete','run.error','run.cancel'].includes(event.type));
   }
   const wasRefreshed = refreshed;
   await refreshIfNeeded();
   if (!wasRefreshed && refreshed) {
    await until(sendEnabled,'explicit refreshed session ready');
    await guestJS('document.querySelector("button[aria-label=Send]").click()');
   }
   return false;
  },'run started');
  if (waitForFinish) await until(()=>guestJS('!document.querySelector("#interrupt-btn") && !!document.querySelector("button[aria-label=Send]")'),'run finished',finishTimeout);
 }
 let unauthenticatedQueries = 0;
 if (process.env.ACP_CLAUDE_AUTH === '1') {
  assert.equal(engine,'claude');
  assert.notEqual(process.env.ACP_CLAUDE_INTERACTIONS,'1','Run auth and memory scenarios separately');
  await until(()=>guestJS(`!!document.querySelector('[aria-label="Model"]') || !!document.querySelector('section[aria-label="External session settings"] [role="alert"]')`),'empty-profile preparation result');
  if (await guestJS(`!!document.querySelector('[aria-label="Model"]')`)) {
   assert.equal((await authStatus()).state,'unknown','session preparation must not claim authentication');
   await send('Reply AUTH_EMPTY_PROFILE_PROBE. Do not use tools.');
   unauthenticatedQueries=1;
   const failed=await chat();
   assert.equal(failed.events.filter(event=>event.type==='run.error').length,1,'missing credentials must fail the Run');
   assert.equal(failed.events.filter(event=>event.type==='run.complete').length,0);
  }
  await until(()=>guestJS(`Array.from(document.querySelectorAll('section[aria-label="External session settings"] button')).some(button=>button.textContent==='Claude Subscription'&&!button.disabled)`),'empty-profile auth methods');
  assert.ok(await guestJS(`Array.from(document.querySelectorAll('section[aria-label="External session settings"] button')).some(button=>button.textContent==='Anthropic Console'&&!button.disabled)`));
  assert.ok(await guestJS(`!document.querySelector('button[aria-label="Send"]') || document.querySelector('button[aria-label="Send"]').disabled`));
  assert.equal((await authStatus()).state,'required');
  const evidence=path.resolve('build/qa/acp013');fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,'auth-empty-profile.png'),(await main.webContents.capturePage()).toPNG());
  console.log('PASS Claude empty profile → auth required → existing login methods, no automatic replay');
 }
 await provisionProfile();
 if (engine === 'claude') {
  let configurationRetried = false;
  await until(async()=>{
   if (!configurationRetried && await guestJS(`!!document.querySelector('section[aria-label="External session settings"] [role="alert"]') && Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Prepare session / refresh settings'&&!button.disabled)`)) {
    configurationRetried=true;
    await guestJS(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Prepare session / refresh settings').click()`);
    console.log('UI explicit prepare retry after service restart');
   }
   return guestJS(`!!document.querySelector('[aria-label="Model"]') && !document.querySelector('[aria-label="Model"]').disabled`);
  },'Claude model configuration');
  const point=await guestJS(`(()=>{const r=document.querySelector('[aria-label="Model"]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until(()=>guestJS(`Array.from(document.querySelectorAll('.ant-select-item-option')).some(item=>/haiku/i.test(item.textContent))`),'Claude Haiku option');
  await guestJS(`Array.from(document.querySelectorAll('.ant-select-item-option')).find(item=>/haiku/i.test(item.textContent)).click()`);
  await until(()=>guestJS(`document.querySelector('[aria-label="Model"]').closest('.ant-select').textContent.toLowerCase().includes('haiku') && !document.querySelector('[aria-label="Model"]').disabled`),'Claude model confirmed');
 }
  async function authStatus() {
   const url=new URL('/api/agent-engines/auth/status',upstreamURL);url.protocol='http:';
   url.searchParams.set('engineId',pluginId+'/'+engine);
   const response=await fetch(url,{headers:{Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`}});
   assert.ok(response.ok);return (await response.json()).data;
  }
  async function chat(includeRawMessages=false) {
   const url = new URL('/api/chat', upstreamURL);
   url.protocol = 'http:';
   url.searchParams.set('chatId', lastQuery.chatId);
   url.searchParams.set('detail', 'full');
   if(includeRawMessages)url.searchParams.set('includeRawMessages','true');
   const response = await fetch(url, {headers:{Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`}});
   assert.ok(response.ok);
   return (await response.json()).data;
  }
 await send(`Reply exactly ${firstMarker}. Do not use tools.`);
 await until(()=>guestJS(`document.body.innerText.split(${JSON.stringify(firstMarker)}).length >= 3`),'first reply rendered after Chat navigation');
 fs.writeFileSync(path.join(output,'shell-chat.png'),(await main.webContents.capturePage()).toPNG());
 console.log('PASS actual Main Chat → preload Frame Port → Broker → real engine query');
 assert.equal((await js('window.electronAPI.services.restart("agent-platform")')).ok,true);
 await send('Reply exactly SHELL_RECONNECTED. Do not use tools.');
 await until(()=>guestJS('document.body.innerText.split("SHELL_RECONNECTED").length >= 3'),'reconnected reply rendered');
 fs.writeFileSync(path.join(output,'shell-reconnected.png'),(await main.webContents.capturePage()).toPNG());
 console.log('PASS main shell Platform restart → Broker reconnect → next query');
 if (process.env.ACP_CLAUDE_AUTH === '1') {
  assert.equal((await js('window.electronAPI.services.stop("agent-platform")')).ok,true);
  const settingsFile=path.join(profiles,fs.readdirSync(profiles)[0],'claude/settings.json');
  if (process.env.ACP_CLAUDE_INVALID_TOKEN === '1') {
   const invalid=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
   delete invalid.env.ANTHROPIC_API_KEY;
   invalid.env.ANTHROPIC_AUTH_TOKEN='acp-qa-invalid-credential';
   fs.writeFileSync(settingsFile,JSON.stringify(invalid),{mode:0o600});
  } else {
   fs.rmSync(settingsFile);
  }
  assert.equal((await js('window.electronAPI.services.start("agent-platform")')).ok,true);
  const rejectionStarted=Date.now();
  await send('Reply AUTH_CREDENTIAL_LOSS_PROBE. Do not use tools.',true,60000);
  const failed=await chat();
  const invalidRun=failed.events.filter(event=>event.type==='run.start').at(-1).runId;
  const errors=failed.events.filter(event=>event.type==='run.error'&&event.runId===invalidRun);
  assert.equal(errors.length,1,'unusable credentials must fail the Run');
  assert.equal((await authStatus()).state,'required');
  assert.equal(failed.events.filter(event=>event.runId===invalidRun && ['run.complete','run.cancel'].includes(event.type)).length,0);
  console.log('PASS Claude unusable credentials → one failed Run and auth required', {elapsedMs:Date.now()-rejectionStarted,invalidToken:process.env.ACP_CLAUDE_INVALID_TOKEN==='1'});
  await provisionProfile();
  await send('Reply exactly AUTH_RESTORED. Do not use tools.');
  assert.ok(await guestJS('document.body.innerText.split("AUTH_RESTORED").length >= 3'));
  assert.equal((await authStatus()).state,'authenticated');
  const evidence=path.resolve('build/qa/acp013');
  fs.writeFileSync(path.join(evidence,'auth-gateway-events.json'),JSON.stringify((await chat()).events,null,2));
  fs.writeFileSync(path.join(evidence,'auth-gateway.png'),(await main.webContents.capturePage()).toPNG());
  console.log('PASS Claude restored gateway profile → explicit retry succeeds, no prompt replay');
 }
 if (backgroundKill) {
  async function api(route, body) {
   const url=new URL(route,upstreamURL);url.protocol='http:';
   const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const result=await response.json();assert.ok(response.ok && [0,200].includes(result.code),`${route}: ${response.status} ${result.msg}`);return result.data;
  }
  const bindingFile=path.join(runtimeRoot,'chats',lastQuery.chatId,'.agent-engine-session.json');
  const originalBinding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
  const snapshot=path.join(runtimeRoot,'ru-agent-engines',pluginId,engine,originalBinding.lastUsed.artifactDigest.replace('sha256:',''));
  const worker=path.join(workspace,'kill-worker.sh'),child=path.join(workspace,'kill-child.sh');
  fs.writeFileSync(child,'#!/bin/sh\nbase="$1"\necho $$ > "$base/kill-child.pid"\nremaining=300\nwhile [ "$remaining" -gt 0 ]; do\n  date +%s > "$base/kill-heartbeat"\n  sleep 1\n  remaining=$((remaining - 1))\ndone\nexit 124\n',{mode:0o700});
  fs.writeFileSync(worker,'#!/bin/sh\nbase="$1"\necho $$ > "$base/kill-worker.pid"\n/bin/sh "$base/kill-child.sh" "$base" &\nwait $!\n',{mode:0o700});
  const command=`/bin/sh '${worker}' '${workspace}'`;
  const monitor=path.join(workspace,'kill-monitor.sh');
  fs.writeFileSync(monitor,'#!/bin/sh\nbase="$1"\necho $$ > "$base/kill-monitor.pid"\nwhile kill -0 "$(cat "$base/kill-worker.pid")" 2>/dev/null; do sleep 1; done\n',{mode:0o700});
  await send(`Run exactly this command once: ${command}. ${engine==='claude'?`Use Bash with run_in_background=true. Immediately after it returns, use Bash again with command /bin/sh '${monitor}' '${workspace}', run_in_background=false and timeout=300000 to wait for that worker. Do not search for TaskOutput; the foreground monitor is required.`:'Use exec_command with yield_time_ms=1000, then write_stdin to wait for its returned session_id.'} The QA controller alone stops this task. Do not edit scripts, kill tasks, use unrelated commands or end your turn while it runs.`,false);
  const runId=(await chat()).events.filter(event=>event.type==='run.start').at(-1).runId;
  const answered=new Set();
  await until(async()=>{
   const current=await chat();
   assert.equal(current.events.some(event=>event.runId===runId && ['run.complete','run.error','run.cancel'].includes(event.type)),false,'background Run must stay active');
   if(current.awaiting && !answered.has(current.awaiting.awaitingId)) {
    const ask=current.events.filter(event=>event.type==='awaiting.ask').at(-1);
    assert.equal(ask.mode,'approval','only the requested background tool may need permission');
    const option=ask.approvals[0];assert.ok(option);
    await api('/api/submit',{chatId:lastQuery.chatId,agentKey:lastQuery.agentKey,runId,awaitingId:ask.awaitingId,submitId:require('node:crypto').randomUUID(),params:[{id:option.id,decision:'approve'}]});answered.add(ask.awaitingId);
   }
   return fs.existsSync(path.join(workspace,'kill-heartbeat'));
  },'real background worker heartbeat');
  const workerPIDs=['worker','child'].map(name=>Number(fs.readFileSync(path.join(workspace,`kill-${name}.pid`),'utf8')));
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  assert.ok(workerPIDs.every(pid=>Number.isSafeInteger(pid)&&pid>1&&alive(pid)));
  const heartbeat=fs.readFileSync(path.join(workspace,'kill-heartbeat'),'utf8');
  await until(()=>fs.readFileSync(path.join(workspace,'kill-heartbeat'),'utf8')!==heartbeat,'background worker remains live',5000);
  // Active Run detail controls event filtering. Inspect public rawMessages for tool receipts.
  await until(async()=>{
   const current=await chat(true);
   fs.writeFileSync(path.join(output,'shell-background-kill-before.json'),JSON.stringify({events:current.events,rawMessages:current.rawMessages},null,2));
   assert.equal(current.events.some(event=>event.runId===runId && ['run.complete','run.error','run.cancel'].includes(event.type)),false,'background Run must stay active until kill');
   if(engine==='claude')return current.rawMessages.filter(message=>message.role==='tool').some(message=>{const result=JSON.parse(message.content);return result.input?.run_in_background===true && result.input.command===command && String(result.output).includes('background');});
   return current.rawMessages.some(message=>message.tool_calls?.some(call=>JSON.parse(call.function.arguments||'{}').command===command));
  },'public background tool receipt');
  const service=await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()');
  const platformPID=service.healthMeta.pid;assert.ok(platformPID>1 && service.paths.stateDir.startsWith(root));
  const rows=require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return {pid:Number(match[1]),parent:Number(match[2]),group:Number(match[3]),command:match[4]};});
  const owned=new Set([platformPID]);
  for(let changed=true;changed;) {changed=false;for(const row of rows)if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
  owned.delete(platformPID);assert.ok(workerPIDs.every(pid=>owned.has(pid)),'worker and child belong to this Platform');
  const adapters=rows.filter(row=>owned.has(row.pid)&&row.command.includes(snapshot+'/dist/index.mjs')&&!row.command.includes('__process-guardian'));
  assert.equal(adapters.length,1,'one owned Adapter entry');
  const adapter=adapters[0];assert.ok(owned.has(adapter.parent),'independent guardian belongs to this Platform');
  // Retire this snapshot while work remains live, so premature lease release is observable.
  assert.equal((await js(`window.electronAPI.services.stop(${JSON.stringify(pluginId)})`)).ok,true);
  const busy=await uninstallConfirmed(pluginId,engine);assert.equal(busy.ok,false);assert.match(busy.message,/engine_busy/);
  assert.ok(fs.existsSync(snapshot) && workerPIDs.every(alive));
  const killPID=backgroundKill==='platform'?platformPID:adapter.pid;
  fs.writeFileSync(path.join(output,'shell-background-kill-start.json'),JSON.stringify({engine,target:backgroundKill,killPID,platformPID,adapterPID:adapter.pid,guardianPID:adapter.parent,workerPIDs,owned:[...owned],runId,snapshot},null,2));
  console.log('READY real background kill',{engine,target:backgroundKill,processes:owned.size,workerPIDs});
  process.kill(killPID,'SIGKILL');
  await until(()=>{
   const remaining=[...owned].filter(alive);
   if(!fs.existsSync(snapshot))assert.equal(remaining.filter(alive).length,0,'snapshot cannot disappear before old process tree');
   return remaining.length===0;
  },'background tree exits after SIGKILL',15000);
  if(backgroundKill==='platform')assert.equal((await js('window.electronAPI.services.start("agent-platform")')).ok,true);
  else assert.equal((await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid,platformPID,'Adapter crash must not restart Platform');
  await until(()=>!fs.existsSync(snapshot),'retired snapshot collected after tree exit',15000);
  await until(async()=>{const current=await chat();return current.events.some(event=>event.runId===runId && ['run.error','run.cancel'].includes(event.type));},'background Run reaches terminal after crash');
  const interrupted=await chat(),terminals=interrupted.events.filter(event=>event.runId===runId && ['run.error','run.cancel','run.complete'].includes(event.type));
  assert.equal(terminals.length,1);assert.notEqual(terminals[0].type,'run.complete');assert.equal(interrupted.awaiting==null,true);
  const retained=JSON.parse(fs.readFileSync(bindingFile,'utf8'));assert.equal(retained.acpSessionId,originalBinding.acpSessionId);assert.equal(retained.profileId,originalBinding.profileId);
  assert.equal((await js(`window.electronAPI.services.start(${JSON.stringify(pluginId)})`)).ok,true);
  await send('The previous background task was stopped by the QA controller; do not resume or recreate it. What exact marker did I request in the very first message? Reply only with that marker. Do not use tools.');
  const recovered=await chat(),binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
  assert.equal(recovered.events.filter(event=>event.type==='content.snapshot').at(-1).text.trim(),firstMarker);
  assert.equal(binding.acpSessionId,originalBinding.acpSessionId);assert.equal(binding.profileId,originalBinding.profileId);assert.deepEqual(binding.configSelection,originalBinding.configSelection);
  assert.equal(recovered.runs.length,4);assert.equal(frameTypes.filter(type=>type==='/api/query').length,4,'no automatic prompt replay');
  assert.equal(recovered.events.filter(event=>event.runId===runId && ['run.error','run.cancel','run.complete'].includes(event.type)).length,1);
  assert.equal(workerPIDs.some(alive),false);
  fs.writeFileSync(path.join(output,'shell-background-kill.json'),JSON.stringify({engine,target:backgroundKill,processes:owned.size,workerPIDs,terminal:terminals[0].type,terminalCount:1,snapshotCollected:true,sameSession:true,sameProfile:true,configPreserved:true,memoryRestored:true,queryCount:4,survivors:[]},null,2));
  fs.writeFileSync(path.join(output,'shell-background-kill-events.json'),JSON.stringify(recovered.events,null,2));
  fs.writeFileSync(path.join(output,'shell-background-kill.png'),(await main.webContents.capturePage()).toPNG());
  console.log('PASS real background SIGKILL → tree cleanup → one terminal → same session/profile/config and explicit memory restored');
 }
 if (engine === 'claude' && process.env.ACP_CLAUDE_INTERACTIONS === '1') {
  let runId;
  async function begin(message) {
   await send(message,false);
   runId=(await chat()).events.filter(event=>event.type==='run.start').at(-1).runId;
  }
  async function finish(expected='run.complete') {
   await until(async()=>{
    const terminal=(await chat()).events.find(event=>event.runId===runId && ['run.complete','run.cancel','run.error'].includes(event.type));
    if(!terminal)return false;
    assert.equal(terminal.type,expected,JSON.stringify(terminal));return true;
   },'Claude terminal '+expected,180000);
   await until(()=>guestJS(`!!document.querySelector('#message-input') && !document.querySelector('#interrupt-btn')`),'Claude Composer restored');
  }
  const permission='.hitl-dialog-surface:has(input[type="radio"][value="approve"])';
  const target=path.join(workspace,'claude-approved.txt');
  await begin(`Use the Write tool to create only ${target} containing exactly APPROVED followed by a newline. Do not use Bash or other tools, retry or modify other files. Wait for the tool approval, then reply FILE_APPROVED.`);
  await until(()=>guestJS(`!!document.querySelector(${JSON.stringify(permission)})`),'Claude write approval');
  const pending=await chat();
  assert.equal(fs.existsSync(target),false);
  assert.ok(await guestJS(`document.querySelector(${JSON.stringify(permission)}).innerText.includes('claude-approved.txt')`),'approval identifies file');
  const ask=pending.events.filter(event=>event.type==='awaiting.ask').at(-1);
  assert.ok(ask.approvals[0].options.every(option=>['approve','reject'].includes(option.decision)),'unverified persistent grants stay hidden');
  const once=ask.approvals[0];assert.ok(once);
  guest.reload();
  await until(()=>guestJS(`!!document.querySelector(${JSON.stringify(permission)})`),'Claude pending approval replay');
  assert.equal((await chat()).awaiting.awaitingId,pending.awaiting.awaitingId);
  await guestJS(`document.querySelector(${JSON.stringify(permission)}).querySelector('input[value="approve"]').closest('label').click()`);
  await finish();
  assert.equal(fs.readFileSync(target,'utf8'),'APPROVED\n');
  console.log('PASS Claude Manual → exact one-time permission → file write and pending reload');
  await begin(`Use the Write tool to replace only ${target} with DENIED. Do not use Bash, retry or access other files. If the permission is rejected, stop and say DENIED.`);
  await until(()=>guestJS(`!!document.querySelector(${JSON.stringify(permission)})`),'Claude same-file permission is requested again');
  const denyAsk=(await chat()).events.filter(event=>event.type==='awaiting.ask').at(-1);
  const reject=denyAsk.approvals[0];assert.ok(reject);
  await guestJS(`document.querySelector(${JSON.stringify(permission)}).querySelector('input[value="reject"]').closest('label').click()`);
  await finish();
  assert.equal(fs.readFileSync(target,'utf8'),'APPROVED\n');
  console.log('PASS Claude same-file next-turn rejection → no write');
  await begin('Call AskUserQuestion now with one single-choice question Choose probe result, exactly two options OK and SKIP. Do not use any other tool. After the answer, reply only DONE.');
  await until(()=>guestJS(`!!document.querySelector('.composer-awaiting-shell [data-index="0"]')`),'Claude question form');
  assert.equal((await chat()).awaiting.mode,'question');
  await guestJS(`document.querySelector('.composer-awaiting-shell [data-index="0"]').click()`);
  await until(()=>guestJS(`Array.from(document.querySelectorAll('.composer-awaiting-shell button')).some(button=>button.textContent.includes('Submit')&&!button.disabled)`),'Claude question submit');
  await until(()=>guestJS(`!document.querySelector('.composer-awaiting-shell [data-index]')`),'Claude question page transition complete');
  await guestJS(`Array.from(document.querySelectorAll('.composer-awaiting-shell button')).find(button=>button.textContent.includes('Submit')).click()`);
  await finish();
  console.log('PASS Claude AskUserQuestion → existing question UI → complete');
  await begin('Explain how hash tables work in great detail. Do not use tools.');
  await guestJS(`document.querySelector('#interrupt-btn').click()`);
  await finish('run.cancel');
  console.log('PASS Claude Stop → single cancel → Composer restored');
  assert.equal((await js('window.electronAPI.services.restart("agent-platform")')).ok,true);
  await begin('What exact marker did I request in my very first message? Reply only with that marker. Do not use tools.');
  await finish();
  const replay=await chat();
  assert.equal(replay.events.filter(event=>event.type==='content.snapshot'&&event.text?.trim()==='SHELL_BROKER_READY').length,2);
  assert.equal(replay.runs.length,7);
  guest.reload();
  await until(()=>guestJS(`!!document.querySelector('#message-input') && document.body.innerText.includes('FILE_APPROVED')`),'Claude cold history replay');
  assert.equal((await chat()).runs.length,7);
  const evidence=path.resolve('build/qa/acp013');fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,'shell-claude-events.json'),JSON.stringify(replay.events,null,2));
  fs.writeFileSync(path.join(evidence,'shell-claude.png'),(await main.webContents.capturePage()).toPNG());
  console.log('PASS Claude tools → Platform restart → explicit memory restored → cold replay no duplicate history');
 }
 if (process.env.ACP_DISCONNECT === '1' || process.env.ACP_PLATFORM_KILL === '1' || upgradeArchive || isolationArchive || drainMode) {
  if (engine === 'codex') {
   await until(()=>guestJS(`(()=>{const input=document.querySelector('[aria-label="Mode"]');return input && !input.disabled && input.getBoundingClientRect().width>0})()`),'mode selector ready after restored query');
   guest.focus();
   await guestJS('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const modePoint = await guestJS(`(()=>{const element=document.querySelector('[aria-label="Mode"]');const rect=element.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`);
   guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...modePoint});
   guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...modePoint});
   await until(() => guestJS("Array.from(document.querySelectorAll('.ant-select-item-option')).some(item=>item.textContent==='Read-only')"), 'read-only option');
   await guestJS("Array.from(document.querySelectorAll('.ant-select-item-option')).find(item=>item.textContent==='Read-only').click()");
   await until(() => guestJS(`document.querySelector('[aria-label="Mode"]').closest('.ant-select').textContent.includes('Read-only') && !document.querySelector('[aria-label="Mode"]').disabled`), 'read-only selected');
  }
  const target = path.join(workspace, 'disconnect-approval.txt');
  const writeTool = engine === 'claude' ? 'the Write tool' : 'apply_patch';
  await send(`Invoke ${writeTool} now to create only ${target} containing RECOVERED on its own line. Trigger the tool approval dialog; do not ask in chat text. Do not run shell commands, retry or change other files. After approval reply DISCONNECT_RECOVERED.`, false);
  // Approval replaces Composer; enter the draft while the real input is still mounted.
  const draft = 'UNSENT_DISCONNECT_DRAFT';
  await guestJS(`(()=>{const input=document.querySelector('#message-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(draft)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await guestJS('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await guestJS('document.querySelector("#message-input").value'),draft,'draft is accepted before approval');
  const permission = '.hitl-dialog-surface:has(input[type="radio"][value="approve"])';
  await until(() => guestJS(`!!document.querySelector(${JSON.stringify(permission)})`), 'pending file approval');
  const before = await chat();
  assert.ok(before.awaiting?.awaitingId);
  assert.equal(fs.existsSync(target), false);
  const runId = before.events.filter(event => event.type === 'run.start').at(-1).runId;
  if (drainMode) {
   const changedEngine=engine==='claude'?'codex':'claude', changedPlugin=`zenmind-agent-${changedEngine}`;
   async function api(route, body, method=body===undefined?'GET':'POST') {
    const url=new URL(route,upstreamURL);url.protocol='http:';
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(240000)});
    const result=await response.json();assert.ok(response.ok && [0,200].includes(result.code),`${route}: ${response.status} ${JSON.stringify(result)}`);return result.data;
   }
   const directory=async()=>(await api('/api/agent-engines')).engines;
   const binding=id=>JSON.parse(fs.readFileSync(path.join(runtimeRoot,'chats',id,'.agent-engine-session.json'),'utf8'));
   const snapshot=b=>path.join(runtimeRoot,'ru-agent-engines',...b.engineId.split('/'),b.lastUsed.artifactDigest.replace('sha256:',''));
   const pids=b=>require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,args='],{encoding:'utf8'}).split('\n').filter(line=>line.includes(snapshot(b))).map(line=>Number(line.trim().split(/\s+/)[0]));
   const protectedBinding=binding(lastQuery.chatId),protectedPIDs=pids(protectedBinding);
   assert.ok(protectedPIDs.length);
   const protectedEntry=(await directory()).find(entry=>entry.engineId===protectedBinding.engineId);
   const protectedCredential=path.join(profiles,protectedBinding.profileId,engine,engine==='codex'?'auth.json':'settings.json');
   const originalCredential=fs.readFileSync(protectedCredential);
   const platformPID=(await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid;
   async function checkProtected(stage) {
    for(const pid of protectedPIDs)process.kill(pid,0);
    assert.equal((await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid,platformPID);
    assert.deepEqual(binding(lastQuery.chatId),protectedBinding);assert.deepEqual(fs.readFileSync(protectedCredential),originalCredential);
    assert.deepEqual((await directory()).find(entry=>entry.engineId===protectedBinding.engineId),protectedEntry);
    assert.ok(fs.existsSync(snapshot(protectedBinding)));assert.equal(fs.existsSync(target),false);
    const current=await chat();assert.equal(current.awaiting?.awaitingId,before.awaiting.awaitingId);
    assert.equal(current.events.filter(event=>event.runId===runId && ['run.complete','run.cancel','run.error'].includes(event.type)).length,0);
    console.log(`PASS ${stage}: protected ${engine} Run/approval/process/profile unchanged`);
   }
   const profilesBefore=fs.readdirSync(profiles);
   const route=await js('location.hash');await js("location.hash='#/settings/plugins'");
   await until(()=>js('!!document.querySelector(".service-catalog-import")'),'active target import entry');
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.resolve(`../zenmind-agent-plugins/build/${changedPlugin}/0.1.0/darwin-arm64/${changedPlugin}-darwin-arm64.zip`)]});
   await js('document.querySelector(".service-catalog-import").click()');
   await until(async()=>(await js('window.electronAPI.services.list()')).some(service=>service.id===changedPlugin),'target installed');dialog.showOpenDialog=originalDialog;
   assert.equal((await js(`window.electronAPI.services.start(${JSON.stringify(changedPlugin)})`)).ok,true);
   const targetWorkspace=path.join(root,'drain-workspace');fs.mkdirSync(targetWorkspace);
   const buildProject=require('../dist-electron/main/modules/assistant/coder-project').buildProjectAgentCreateRequest;
   const project=await api('/api/admin/agents/create',buildProject('acp',targetWorkspace,{engineId:changedPlugin+'/'+changedEngine}));
   const targetChat=require('node:crypto').randomUUID(), targetRun=require('node:crypto').randomUUID();
   const prepare=()=>api('/api/agent-engines/sessions/prepare',{chatId:targetChat,agentKey:project.key});
   const created=fs.readdirSync(profiles).filter(id=>!profilesBefore.includes(id));assert.equal(created.length,1);
   assert.equal((await js(`window.electronAPI.services.stop(${JSON.stringify(changedPlugin)})`)).ok,true);
   await until(async()=>(await directory()).some(entry=>entry.pluginId===changedPlugin && entry.runtimeState==='stopped'),'idle target stopped before copying authorized profile');
   const targetCredential=copyAuthorizedProfile(path.join(profiles,created[0]),changedEngine);
   assert.equal((await js(`window.electronAPI.services.start(${JSON.stringify(changedPlugin)})`)).ok,true);
   let prepared=await prepare();
   const option=prepared.configOptions.find(option=>changedEngine==='claude'?option.category==='model':option.category==='mode');assert.ok(option);
   const choice=option.choices.find(choice=>changedEngine==='claude'?/haiku/i.test(choice.name):choice.name==='Read-only');assert.ok(choice,JSON.stringify(option));
   prepared=await api('/api/agent-engines/sessions/config',{chatId:targetChat,preparationId:prepared.preparationId,configRevision:prepared.configRevision,selections:[{configId:option.id,value:choice.value}]},'PUT');
   console.log(`READY ${changedEngine} independent authenticated profile and model/mode configured`);
   const targetFile=path.join(targetWorkspace,'drained.txt');let queryResult,queryError;
   const worker=path.join(targetWorkspace,'background-worker.sh'),child=path.join(targetWorkspace,'background-child.sh');
   const backgroundPIDs=[];
   if(backgroundDrain) {
    fs.writeFileSync(child, '#!/bin/sh\nbase="$1"\necho $$ > "$base/child.pid"\nremaining=240\nwhile [ ! -f "$base/release-background" ] && [ "$remaining" -gt 0 ]; do\n  date +%s > "$base/heartbeat"\n  sleep 1\n  remaining=$((remaining - 1))\ndone\n[ -f "$base/release-background" ] || exit 124\nprintf "CHILD_DONE\\n" > "$base/child-complete"\n', {mode:0o700});
    fs.writeFileSync(worker, '#!/bin/sh\nbase="$1"\necho $$ > "$base/worker.pid"\n/bin/sh "$base/background-child.sh" "$base" &\nwait $! || exit $?\nprintf "DRAINED\\n" > "$base/drained.txt"\n', {mode:0o700});
   }
   const command=`/bin/sh '${worker}' '${targetWorkspace}'`;
   const targetMarker=activeUpgrade ? `UPGRADE_${require('node:crypto').randomUUID()}` : '';
   const message=backgroundDrain
    ? `Run exactly this command once: ${command}. ${changedEngine==='claude'?'Use Bash with run_in_background=true, then monitor that same background task with the available task/output tools until it finishes.':'Use exec_command with yield_time_ms=1000, then write_stdin to wait for its returned session_id. Request approval to run outside the read-only sandbox if necessary.'} The QA controller alone releases the gate; do not create release-background, alter scripts, kill tasks or perform unrelated work. Keep waiting until the task finishes; do not end your turn while it runs. When completed reply DRAINED_DONE.`
    : `${targetMarker ? `Remember this exact marker: ${targetMarker}. ` : ''}Use ${changedEngine==='claude'?'the Write tool':'apply_patch'} now to create only ${targetFile} containing DRAINED on its own line. Trigger tool approval; do not ask in text or run shell commands. After approval reply DRAINED_DONE.`;
   const targetQuery=api('/api/query?detail=full',{chatId:targetChat,agentKey:project.key,runId:targetRun,stream:false,message}).then(result=>{queryResult=result;},error=>{queryError=error;});
   const targetHistory=()=>api('/api/chat?chatId='+targetChat+'&detail=full');
   const answerFor=history=>{
    const ask=history.events.filter(event=>event.type==='awaiting.ask').at(-1),once=ask.approvals[0];assert.ok(once);
    return {chatId:targetChat,agentKey:project.key,runId:targetRun,awaitingId:ask.awaitingId,submitId:require('node:crypto').randomUUID(),params:[{id:once.id,decision:'approve'}]};
   };
   let pending;
   const approved=new Set();
   await until(async()=>{
    if(queryError)throw queryError;pending=await targetHistory();
    if(queryResult)throw Error('target ended before background/approval checkpoint');
    if(!backgroundDrain)return !!pending.awaiting;
    if(pending.awaiting && !approved.has(pending.awaiting.awaitingId)) {
     const answer=answerFor(pending);approved.add(answer.awaitingId);await api('/api/submit',answer);
    }
    if(!fs.existsSync(path.join(targetWorkspace,'heartbeat')))return false;
    for(const name of ['worker','child']) {const pid=Number(fs.readFileSync(path.join(targetWorkspace,name+'.pid'),'utf8'));assert.ok(pid>0);process.kill(pid,0);backgroundPIDs.push(pid);}
    return true;
   },backgroundDrain?'real background worker and child running':'both real engines awaiting approval');
   const processTree=backgroundDrain ? require('node:child_process').execFileSync('/bin/ps',['-p',backgroundPIDs.join(','),'-o','pid=,ppid=,pgid=,args='],{encoding:'utf8'}) : '';
   if(backgroundDrain)console.log('READY real background tree:',processTree.trim());
   const activeBinding=binding(targetChat),targetPIDs=pids(activeBinding);assert.ok(targetPIDs.length);
   const targetCredentials=fs.readFileSync(targetCredential);
   const service=(await js('window.electronAPI.services.list()')).find(service=>service.id===changedPlugin);
   const engineSync=require('../dist-electron/main/modules/plugins').getAgentEngineSync(app);
   const nodeBin=path.join(require('../dist-electron/main/infrastructure/filesystem/user-paths').getDesktopRoot(app),'bin');
   const runtimeBefore=nodeUpdate ? fs.readFileSync(path.join(nodeBin,'runtime.json')) : undefined;
   await checkProtected('both real Runs active');
   if(nodeUpdate) {
    await assert.rejects(()=>engineSync.prepareDesktopUpdate(),/updateBusy/);
    assert.deepEqual(fs.readFileSync(path.join(nodeBin,'runtime.json')),runtimeBefore);
    assert.deepEqual(binding(targetChat),activeBinding);
    assert.equal((await targetHistory()).awaiting?.awaitingId,pending.awaiting.awaitingId);
    for(const pid of targetPIDs)process.kill(pid,0);
    await checkProtected('shared Node update refused with both engines active');
   } else if(activeUpgrade) {
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.resolve(activeUpgrade)]});
    await js('document.querySelector(".service-catalog-import").click()');
    await until(async()=>{
     const installed=(await js('window.electronAPI.services.list()')).find(item=>item.id===changedPlugin);
     return installed.version!==activeBinding.lastUsed.pluginVersion && installed.agentEngineSync?.syncState==='applied';
    },'active target upgrade synchronized');
    dialog.showOpenDialog=originalDialog;
    assert.deepEqual(binding(targetChat),activeBinding,'upgrade cannot switch the active Run binding');
    assert.equal((await targetHistory()).awaiting?.awaitingId,pending.awaiting.awaitingId);
    for(const pid of targetPIDs)process.kill(pid,0);
    assert.ok(fs.existsSync(snapshot(activeBinding)));assert.equal(fs.existsSync(targetFile),false);
    await checkProtected('target upgraded while both approvals remain active');
   } else {
   assert.equal((await js(`window.electronAPI.services.stop(${JSON.stringify(changedPlugin)})`)).ok,true);
   await assert.rejects(prepare,/engine_unavailable/);
   if(!backgroundDrain)assert.equal((await targetHistory()).awaiting.awaitingId,pending.awaiting.awaitingId);
   else {for(const pid of backgroundPIDs)process.kill(pid,0);assert.ok(!queryResult && !queryError,'background Run remains active after disable');}
   const busy=await uninstallConfirmed(changedPlugin,changedEngine);assert.equal(busy.ok,false);assert.match(busy.message,/engine_busy/);
   for(const pid of targetPIDs)process.kill(pid,0);
   assert.ok(fs.existsSync(service.paths.programDir));assert.ok(fs.existsSync(snapshot(activeBinding)));
   assert.equal(fs.existsSync(targetFile),false);await checkProtected('disabled and uninstall engine_busy');
   }
   const answer=backgroundDrain ? undefined : answerFor(pending);
   if(backgroundDrain) {
    for(const pid of backgroundPIDs)process.kill(pid,0);
    const heartbeat=fs.readFileSync(path.join(targetWorkspace,'heartbeat'),'utf8');
    await until(()=>fs.readFileSync(path.join(targetWorkspace,'heartbeat'),'utf8')!==heartbeat,'background task still works after engine_busy',5000);
    if(drainMode==='complete')fs.writeFileSync(path.join(targetWorkspace,'release-background'),'complete');
   }
   if(drainMode==='cancel')await api('/api/interrupt',{chatId:targetChat,agentKey:project.key,runId:targetRun});
   else if(!backgroundDrain)await api('/api/submit',answer);
   await targetQuery;if(queryError)throw queryError;
   const terminal=drainMode==='cancel'?'run.cancel':'run.complete';
   let ended=await targetHistory();assert.deepEqual(ended.events.filter(event=>event.runId===targetRun && ['run.complete','run.cancel','run.error'].includes(event.type)).map(event=>event.type),[terminal]);
   if(backgroundDrain && changedEngine==='codex') {
    const call=ended.events.find(event=>event.type==='tool.snapshot' && JSON.parse(event.arguments || '{}').command===command);
    assert.ok(call && ended.events.some(event=>event.type==='tool.result' && event.toolId===call.toolId),'Codex command and its completion/cancellation result are paired');
   }
   if(backgroundDrain && changedEngine==='claude') {
    assert.ok(ended.events.filter(event=>event.type==='tool.result').some(event=>{const result=JSON.parse(event.result);return result.input?.run_in_background===true && result.input.command===command && String(result.output).includes('background');}),'real Claude background Bash receipt is persisted');
   }

   if(drainMode==='cancel') {assert.equal(fs.existsSync(targetFile),false);if(answer)await assert.rejects(()=>api('/api/submit',answer),/\/api\/submit: (?:400 .*"msg":"unknown_awaiting"|409 .*"msg":"(?:awaiting_expired|awaiting_interrupted|already_resolved)")/);assert.equal(fs.existsSync(targetFile),false);}
   else assert.equal(fs.readFileSync(targetFile,'utf8'),'DRAINED\n');
   const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
   const backgroundSurvivors=()=>backgroundDrain ? require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,args='],{encoding:'utf8'}).split('\n').filter(line=>line.includes(path.basename(root)) && line.includes('drain-workspace')) : [];
   await until(()=>[...targetPIDs,...backgroundPIDs].every(pid=>!alive(pid)) && (nodeUpdate || !fs.existsSync(snapshot(activeBinding))) && backgroundSurvivors().length===0,'target process exits and retired files protected or collected',15000);
   let restored;
   if(nodeUpdate) {
    await assert.rejects(()=>engineSync.prepareDesktopUpdate(),/updateBusy/);
    assert.deepEqual(fs.readFileSync(path.join(nodeBin,'runtime.json')),runtimeBefore);
    assert.deepEqual(fs.readFileSync(targetCredential),targetCredentials);
    await checkProtected('shared Node update still refused while only the other engine remains active');
   } else if(activeUpgrade) {
    await checkProtected('target old Run completed and old snapshot collected');
    prepared=await prepare();restored=binding(targetChat);
    assert.equal(restored.acpSessionId,activeBinding.acpSessionId);assert.equal(restored.profileId,activeBinding.profileId);
    assert.notEqual(restored.lastUsed.pluginVersion,activeBinding.lastUsed.pluginVersion);assert.notEqual(restored.lastUsed.artifactDigest,activeBinding.lastUsed.artifactDigest);
    assert.deepEqual(restored.configSelection,activeBinding.configSelection,'selected model/mode survives upgrade');
    await api('/api/query?detail=full',{chatId:targetChat,agentKey:project.key,runId:require('node:crypto').randomUUID(),stream:false,message:'What exact marker did I ask you to remember, and what exact file name and content did you just write? Answer from this conversation only. Do not use tools.'});
    ended=await targetHistory();assert.equal(ended.runs.length,2);assert.equal(ended.events.filter(event=>event.type==='run.complete').length,2);
    const answer=ended.events.filter(event=>event.type==='content.snapshot').at(-1).text;
    assert.ok(answer.includes(targetMarker) && answer.includes('drained.txt') && answer.includes('DRAINED'),'new version restores marker and file context');
    assert.deepEqual(binding(targetChat),restored);assert.deepEqual(fs.readFileSync(targetCredential),targetCredentials);
    await checkProtected('target new version restored memory and completed next Run');
   } else {
   const removed=await uninstallConfirmed(changedPlugin,changedEngine);assert.equal(removed.ok,true,removed.message);
   assert.equal(fs.existsSync(service.paths.programDir),false);assert.deepEqual(fs.readFileSync(targetCredential),targetCredentials);
   const retained=binding(targetChat);assert.equal(retained.acpSessionId,activeBinding.acpSessionId);assert.equal(retained.profileId,activeBinding.profileId);
   await assert.rejects(prepare,/engine_unavailable/);await checkProtected('target drained and uninstall retry succeeds');
   }
   await js(`location.hash=${JSON.stringify(route)}`);
   const allow=before.events.filter(event=>event.type==='awaiting.ask').at(-1).approvals[0];assert.ok(allow);
   // A retained guest can have clickable DOM while its owning webview is still
   // hidden behind settings. Wait for the actual host surface before input.
   await until(()=>js(`Array.from(document.querySelectorAll('webview')).some(view=>{try{if(view.getWebContentsId()!==${guest.id})return false;}catch{return false;}const r=view.getBoundingClientRect();return r.width>0 && r.height>0 && view.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})`),'protected webview visible in main shell');
   await guestJS('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   let approvalPoint;
   await until(async()=>{
    approvalPoint=await guestJS(`(()=>{const section=document.querySelector(${JSON.stringify(permission)});const button=section && section.querySelector('input[value="approve"]:not(:disabled)')?.closest('label');if(!button || button.matches(':disabled') || button.closest('[inert], [aria-disabled="true"]'))return null;button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();if(!r.width || !r.height)return null;const x=r.x+r.width/2,y=r.y+r.height/2;if(!button.contains(document.elementFromPoint(x,y)))return null;return{x:Math.round(x),y:Math.round(y)};})()`);
    return !!approvalPoint;
   },'protected approval visible and interactive after target drain');
   // Returning from settings can retain a hidden/inert guest during Chat replay.
   // Use one actual mouse click, then require the outbound submit before waiting on the model.
   const submitsBefore=frameTypes.filter(type=>type==='/api/submit').length;
   if(nodeUpdate)await guestJS(`window.__qaApprovalClicks=[];document.addEventListener('click',event=>window.__qaApprovalClicks.push({tag:event.target.tagName,text:event.target.textContent,trusted:event.isTrusted}),{capture:true});`);
   guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...approvalPoint});
   guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...approvalPoint});
   try {await until(()=>frameTypes.filter(type=>type==='/api/submit').length===submitsBefore+1,'protected approval submitted exactly once',10000);}
   catch(error){if(nodeUpdate)fs.writeFileSync(path.join(output,'shell-node-update-click.json'),JSON.stringify({approvalPoint,submitsBefore,frames:frameTypes,clicks:await guestJS('window.__qaApprovalClicks')},null,2));throw error;}
   console.log('PASS visible protected approval sends one submit');
   await until(async()=>(await chat()).events.some(event=>event.runId===runId && event.type==='run.complete'),'protected Run completes',180000);
   assert.equal(fs.readFileSync(target,'utf8'),'RECOVERED\n');
   if(nodeUpdate) {
    const resume=await engineSync.prepareDesktopUpdate();
    assert.ok((await directory()).every(entry=>!entry.enabled && entry.runtimeState==='stopped'));
    await assert.rejects(prepare,/engine_unavailable/);
    await engineSync.reconcile();
    assert.ok((await directory()).every(entry=>!entry.enabled),'reconciliation keeps shutdown admission closed');
    for(const pid of [...targetPIDs,...protectedPIDs])assert.equal(alive(pid),false);
    assert.deepEqual(fs.readFileSync(path.join(nodeBin,'runtime.json')),runtimeBefore);
    // The signed Desktop installer is intentionally outside this disposable QA.
    // Exercise rollback, then the existing managed restart and explicit recovery.
    await resume();
    assert.ok((await directory()).every(entry=>entry.enabled));
    const restarted=await js('window.electronAPI.services.restart("agent-platform")');assert.equal(restarted.ok,true,restarted.message);
    await prepare();restored=binding(targetChat);
    assert.equal(restored.acpSessionId,activeBinding.acpSessionId);assert.equal(restored.profileId,activeBinding.profileId);
    assert.deepEqual(restored.configSelection,activeBinding.configSelection);
    console.log('PASS both trees drained; update admission closed; rollback and restart preserve target binding/config');
   }
   await send('What exact marker did I request in the very first message? Reply only with that marker. Do not use tools.');
   const replay=await chat();assert.equal(replay.events.filter(event=>event.type==='content.snapshot').at(-1).text.trim(),firstMarker);
   assert.equal(replay.runs.length,4);assert.equal(replay.events.filter(event=>event.type==='run.complete').length,4);assert.equal(ended.runs.length,activeUpgrade?2:1);
   const resultName=nodeUpdate?'shell-node-update':activeUpgrade?'shell-active-upgrade':'shell-active-drain';
   const outcome=nodeUpdate ? {bothActiveBusy:true,oneActiveBusy:true,allDrained:true,admissionClosed:true,rollback:true,runtimeUnchangedUntilDrain:true,sameSession:true,sameProfile:true,configPreserved:true,signedDesktopUpgrade:false,targetQueries:1} : activeUpgrade ? {from:activeBinding.lastUsed,to:restored.lastUsed,sameSession:true,sameProfile:true,configPreserved:true,oldSnapshotCollected:true,targetMemory:true,fileContextRestored:true,targetQueries:2} : {background:backgroundDrain,backgroundProcesses:backgroundPIDs.length,processTree,mode:drainMode,busy:true,retrySucceeded:true,targetQueries:1};
   fs.writeFileSync(path.join(output,resultName+'.json'),JSON.stringify({...outcome,targetEngine:changedEngine,protectedEngine:engine,targetProcesses:targetPIDs.length,protectedProcesses:protectedPIDs.length,targetTerminal:terminal,targetProfileRetained:true,protectedMemory:true,protectedQueries:4},null,2));
   fs.writeFileSync(path.join(output,resultName+'-events.json'),JSON.stringify({target:ended.events,protected:replay.events},null,2));
   fs.writeFileSync(path.join(output,resultName+'.png'),(await main.webContents.capturePage()).toPNG());
   console.log(nodeUpdate ? 'PASS shared Node update waits for both real plugins; restart restores memory without query replay' : activeUpgrade ? `PASS ${changedEngine} active upgrade → drain → new version memory/config restored; real ${engine} Run and memory survive` : `PASS ${changedEngine} active disable/uninstall → engine_busy → ${drainMode} → retry succeeds; real ${engine} Run and memory survive`);
  } else if (isolationArchive) {
   const otherEngine=engine==='claude'?'codex':'claude', otherPlugin=`zenmind-agent-${otherEngine}`;
   const bindingFile=path.join(runtimeRoot,'chats',lastQuery.chatId,'.agent-engine-session.json');
   const previous=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
   const snapshot=path.join(runtimeRoot,'ru-agent-engines',pluginId,engine,previous.lastUsed.artifactDigest.replace('sha256:',''));
   const credential=path.join(profiles,previous.profileId,engine,engine==='claude'?'settings.json':'auth.json');
   const credentialBefore=fs.readFileSync(credential);
   const processIDs=require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,args='],{encoding:'utf8'}).split('\n').filter(line=>line.includes(snapshot)).map(line=>Number(line.trim().split(/\s+/)[0]));
   assert.ok(processIDs.length,'protected adapter must be running');
   const platformPID=(await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid;
   const directory=async()=>{
    const url=new URL('/api/agent-engines',upstreamURL);url.protocol='http:';
    const response=await fetch(url,{headers:{Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`}});
    assert.ok(response.ok);return (await response.json()).data.engines;
   };
   const protectedEntry=(await directory()).find(entry=>entry.engineId===previous.engineId);
   const checked=[];
   async function checkProtected(action) {
    assert.equal((await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid,platformPID);
    for(const pid of processIDs)process.kill(pid,0);
    assert.deepEqual((await directory()).find(entry=>entry.engineId===previous.engineId),protectedEntry,'other plugin directory unchanged');
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingFile,'utf8')),previous,'other session and configuration unchanged');
    assert.deepEqual(fs.readFileSync(credential),credentialBefore,'other credentials preserved');
    assert.ok(fs.existsSync(snapshot));
    const current=await chat();
    assert.equal(current.awaiting?.awaitingId,before.awaiting.awaitingId);
    assert.equal(current.events.filter(event=>event.runId===runId && ['run.complete','run.cancel','run.error'].includes(event.type)).length,0);
    assert.equal(fs.existsSync(target),false);
    checked.push(action);console.log(`PASS ${otherEngine} ${action} preserves active ${engine} Run, process, approval, directory and profile`);
   }
   const route=await js('location.hash');
   await js("location.hash='#/settings/plugins'");
   await until(()=>js('!!document.querySelector(".service-catalog-import")'),'other plugin import entry');
   for(const [version,archivePath] of [['0.1.0',path.resolve(`../zenmind-agent-plugins/build/${otherPlugin}/0.1.0/darwin-arm64/${otherPlugin}-darwin-arm64.zip`)],['0.1.1',path.resolve(isolationArchive)]]) {
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archivePath]});
    await js('document.querySelector(".service-catalog-import").click()');
    await until(async()=>(await js('window.electronAPI.services.list()')).some(service=>service.id===otherPlugin && service.version===version),'other plugin installed '+version);
    if(version==='0.1.0') {
     const enabled=await js(`window.electronAPI.services.start(${JSON.stringify(otherPlugin)})`);assert.equal(enabled.ok,true,enabled.message);
    }
    await until(async()=>(await directory()).some(entry=>entry.pluginId===otherPlugin && entry.pluginVersion===version && entry.enabled),'other version synchronized '+version);
    await checkProtected(version==='0.1.0'?'install':'upgrade');
   }
   dialog.showOpenDialog=originalDialog;
   const disabled=await js(`window.electronAPI.services.stop(${JSON.stringify(otherPlugin)})`);assert.equal(disabled.ok,true,disabled.message);
   await until(async()=>(await directory()).some(entry=>entry.pluginId===otherPlugin && !entry.enabled),'other plugin disabled');
   await checkProtected('disable');
   const removed=await uninstallConfirmed(otherPlugin,otherEngine);assert.equal(removed.ok,true,removed.message);
   assert.equal((await directory()).some(entry=>entry.pluginId===otherPlugin),false);
   assert.equal((await js('window.electronAPI.services.list()')).some(service=>service.id===otherPlugin),false);
   await checkProtected('uninstall');
   await js(`location.hash=${JSON.stringify(route)}`);
   await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const once=before.events.filter(event=>event.type==='awaiting.ask').at(-1).approvals[0];assert.ok(once);
   await until(()=>guestJS(`(()=>{const section=document.querySelector(${JSON.stringify(permission)});const button=section && section.querySelector('input[value="approve"]:not(:disabled)')?.closest('label');if(!button)return false;button.click();return true;})()`),'protected approval remains usable');
   await until(async()=>(await chat()).events.some(event=>event.runId===runId && event.type==='run.complete'),'protected Run completes',180000);
   assert.equal(fs.readFileSync(target,'utf8'),'RECOVERED\n');
   await send('What exact marker did I request in the very first message? Reply only with that marker. Do not use tools.');
   const replay=await chat(),restored=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
   assert.equal(replay.events.filter(event=>event.type==='content.snapshot').at(-1).text.trim(),firstMarker);
   assert.equal(restored.acpSessionId,previous.acpSessionId);assert.equal(restored.profileId,previous.profileId);
   assert.deepEqual(restored.lastUsed,previous.lastUsed);assert.deepEqual(restored.configSelection,previous.configSelection);
   assert.equal(replay.runs.length,4);assert.equal(replay.events.filter(event=>event.type==='run.complete').length,4);
   fs.writeFileSync(path.join(output,'shell-isolation.json'),JSON.stringify({protectedEngine:engine,changedEngine:otherEngine,checked,protectedVersion:previous.lastUsed,processesPreserved:processIDs.length,platformUnchanged:true,profilePreserved:true,approvalPreserved:true,memoryRestored:true,queryCount:4},null,2));
   fs.writeFileSync(path.join(output,'shell-isolation-events.json'),JSON.stringify(replay.events,null,2));
   fs.writeFileSync(path.join(output,'shell-isolation.png'),(await main.webContents.capturePage()).toPNG());
   console.log('PASS protected approval completes once and next explicit Query retains memory after other plugin removal');
  } else if (upgradeArchive) {
   const binding = () => JSON.parse(fs.readFileSync(path.join(runtimeRoot,'chats',lastQuery.chatId,'.agent-engine-session.json'),'utf8'));
   const previous=binding();
   const oldSnapshot=path.join(runtimeRoot,'ru-agent-engines',pluginId,engine,previous.lastUsed.artifactDigest.replace('sha256:',''));
   const platformPID=(await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid;
   const route=await js('location.hash');
   await js("location.hash='#/settings/plugins'");
   await until(()=>js('!!document.querySelector(".service-catalog-import")'),'upgrade import entry');
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.resolve(upgradeArchive)]});
   await js('document.querySelector(".service-catalog-import").click()');
   await until(async()=>{
    const services=await js('window.electronAPI.services.list()');
    const installed=services.find(service=>service.id===pluginId);
    return installed && installed.version!==previous.lastUsed.pluginVersion && installed.agentEngineSync?.syncState==='applied';
   },'upgraded plugin synchronized');
   dialog.showOpenDialog=originalDialog;
   assert.equal((await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()')).healthMeta.pid,platformPID,'plugin upgrade must not restart Platform');
   assert.ok(fs.existsSync(oldSnapshot),'active old snapshot remains leased');
   assert.deepEqual(binding(),previous,'active binding cannot switch versions');
   assert.equal((await chat()).awaiting?.awaitingId,before.awaiting.awaitingId,'upgrade preserves active approval');
   assert.equal(fs.existsSync(target),false);
   await js(`location.hash=${JSON.stringify(route)}`);
   await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const once=before.events.filter(event=>event.type==='awaiting.ask').at(-1).approvals[0];
   assert.ok(once);
   await until(()=>guestJS(`(()=>{const section=document.querySelector(${JSON.stringify(permission)});const button=section && section.querySelector('input[value="approve"]:not(:disabled)')?.closest('label');if(!button)return false;button.click();return true;})()`),'approve old Run after upgrade');
   await until(async()=>{
    const terminal=(await chat()).events.find(event=>event.runId===runId && ['run.complete','run.cancel','run.error'].includes(event.type));
    if(!terminal)return false;assert.equal(terminal.type,'run.complete');return true;
   },'old version completes approved write',180000);
   assert.equal(fs.readFileSync(target,'utf8'),'RECOVERED\n');
   await until(()=>!fs.existsSync(oldSnapshot),'drained old snapshot collected',10000);
   await send('What exact marker did I request in the very first message, and what exact file name and content did you just write? Answer from the conversation only. Do not use tools.');
   const restored=binding(),replay=await chat();
   assert.equal(restored.acpSessionId,previous.acpSessionId);
   assert.equal(restored.profileId,previous.profileId);
   assert.notEqual(restored.lastUsed.pluginVersion,previous.lastUsed.pluginVersion);
   assert.notEqual(restored.lastUsed.artifactDigest,previous.lastUsed.artifactDigest);
   assert.deepEqual(restored.configSelection,previous.configSelection,'model and mode selection survive upgrade');
   const answer=replay.events.filter(event=>event.type==='content.snapshot').at(-1).text;
   assert.ok(answer.includes(firstMarker) && answer.includes('disconnect-approval.txt') && answer.includes('RECOVERED'),'memory and file context survive upgrade');
   assert.equal(replay.runs.length,4);
   assert.equal(replay.events.filter(event=>event.runId===runId && ['run.complete','run.error','run.cancel'].includes(event.type)).length,1);
   fs.writeFileSync(path.join(output,'shell-upgrade.json'),JSON.stringify({engine,from:previous.lastUsed,to:restored.lastUsed,sameSession:true,sameProfile:true,configPreserved:true,oldSnapshotCollected:true,memoryRestored:true,fileContextRestored:true,queryCount:4},null,2));
   fs.writeFileSync(path.join(output,'shell-upgrade-events.json'),JSON.stringify(replay.events,null,2));
   fs.writeFileSync(path.join(output,'shell-upgrade.png'),(await main.webContents.capturePage()).toPNG());
   console.log('PASS Claude active upgrade → old approval completes → old snapshot collected → new version restores memory, file context and configuration');
  } else if (process.env.ACP_PLATFORM_KILL === '1') {
   const service = await js('(async()=> (await window.electronAPI.services.list()).find(service=>service.id==="agent-platform"))()');
   const pid = service.healthMeta.pid;
   assert.ok(Number.isSafeInteger(pid) && pid > 1 && service.paths.stateDir.startsWith(root));
   const processes = require('node:child_process').execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
   const owned = new Set([pid]);
   for (let changed=true; changed;) { changed=false; for (const [id,parent] of processes) if (owned.has(parent) && !owned.has(id)) {owned.add(id);changed=true;} }
   owned.delete(pid);
   assert.ok(owned.size >= 3, 'real guardian and adapter subtree must be present');
   process.kill(pid,'SIGKILL');
   const alive = id => {try {process.kill(id,0);return true;} catch(error) {if(error.code==='ESRCH')return false;throw error;}};
   await until(()=>![...owned].some(alive),'owned processes exit after Platform SIGKILL',10000);
   assert.equal((await js('window.electronAPI.services.start("agent-platform")')).ok,true);
   await until(()=>guestJS('!!document.querySelector("#message-input")'),'chat mounted after host crash');
   await until(async()=>{const replay=await chat();return replay.events.some(event=>event.runId===runId && ['run.error','run.cancel'].includes(event.type));},'interrupted run terminal restored');
   const interrupted = await chat();
   assert.equal(interrupted.awaiting == null,true);
   assert.equal(interrupted.events.filter(event=>event.runId===runId && ['run.error','run.cancel','run.complete'].includes(event.type)).length,1);
   assert.equal(fs.existsSync(target),false,'interrupted approval must not write');
   await until(()=>guestJS(`!document.querySelector(${JSON.stringify(permission)})`),'old approval removed');
   await until(()=>guestJS(`document.querySelector('#message-input')?.value===${JSON.stringify(draft)}`),'crash preserves unsent draft after Chat replay',10000);
   assert.equal(await guestJS('document.querySelector("#message-input").value'),draft,'crash must preserve unsent draft');
   const lateURL = new URL('/api/submit',upstreamURL);lateURL.protocol='http:';
   const late = await fetch(lateURL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${upstreamURL.searchParams.get('token')}`},body:JSON.stringify({chatId:lastQuery.chatId,agentKey:lastQuery.agentKey,runId,awaitingId:before.awaiting.awaitingId,submitId:require('node:crypto').randomUUID(),params:[]})});
   assert.equal(late.status,409);
   await send('What exact marker did I request in the very first message? Reply only with that marker. Do not use tools.');
   const recovered = await chat();
   assert.equal(recovered.runs.length,4);
   assert.equal(recovered.events.filter(event=>event.type==='content.snapshot' && event.text?.trim()===firstMarker).length,2);
   assert.equal(upstreamFrames.filter(frame=>frame.type==='/api/query').length,4,'crash must not replay query');
   fs.writeFileSync(path.join(output,'shell-platform-kill.json'),JSON.stringify({engine,runId,processes:owned.size,survivors:[],terminalCount:1,lateSubmit:late.status,draftPreserved:true,memoryRestored:true,queryCount:4},null,2));
   fs.writeFileSync(path.join(output,'shell-platform-kill-events.json'),JSON.stringify(recovered.events,null,2));
   fs.writeFileSync(path.join(output,'shell-platform-kill.png'),(await main.webContents.capturePage()).toPNG());
   console.log('PASS main shell Platform SIGKILL → clean subtree → one terminal → stale approval rejected → draft and explicit memory restored');
  } else {
  const attachesBefore = upstreamFrames.filter(frame => frame.type === '/api/attach').length;
  disconnectUntil = Date.now() + 3000;
  assert.ok(sockets.size > 0);
  for (const socket of sockets) socket.destroy();
  await until(() => upstreamFrames.filter(frame => frame.type === '/api/attach').length > attachesBefore, 'Broker attaches after TCP loss');
  await until(() => guestJS(`!!document.querySelector(${JSON.stringify(permission)}) && Array.from(document.querySelector(${JSON.stringify(permission)}).querySelectorAll('input[type="radio"]')).some(button=>!button.disabled)`), 'approval usable after reconnect');
  const restored = await chat();
  assert.equal(restored.awaiting.awaitingId, before.awaiting.awaitingId);
  assert.equal(restored.runs.length, before.runs.length);
  assert.equal(fs.existsSync(target), false);
  await guestJS(`document.querySelector(${JSON.stringify(permission)}).querySelector('input[value="approve"]').closest('label').click()`);
  await until(async () => (await chat()).events.some(event => event.runId === runId && event.type === 'run.complete'), 'original run completes after approval',180000);
  assert.equal(fs.readFileSync(target,'utf8'), 'RECOVERED\n');
  await until(()=>guestJS(`document.querySelector('#message-input')?.value===${JSON.stringify(draft)}`),'draft preserved after approval completes');
  const completed = await chat();
  assert.equal(completed.runs.length, 3);
  assert.equal(completed.events.filter(event => event.runId === runId && event.type === 'run.complete').length, 1);
  assert.equal(upstreamFrames.filter(frame => frame.type === '/api/query').length, 3);
  fs.writeFileSync(path.join(output,'shell-disconnect.json'),JSON.stringify({runId, awaitingPreserved:true,draftPreserved:true,queryCount:3,frames:upstreamFrames},null,2));
  fs.writeFileSync(path.join(output,'shell-disconnect.png'),(await main.webContents.capturePage()).toPNG());
  console.log('PASS active Run TCP loss → attach same Run/HITL → draft retained → approval completes once, no query replay');
  }
 }
 fs.writeFileSync(path.join(output,'shell-frames.json'),JSON.stringify(frameTypes));
 assert.equal(frameTypes.filter(type=>type==='/api/query').length,engine === 'claude' && process.env.ACP_CLAUDE_INTERACTIONS === '1' ? 7 : process.env.ACP_PLATFORM_KILL === '1' || upgradeArchive || isolationArchive || drainMode || backgroundKill ? 4 : process.env.ACP_DISCONNECT === '1' ? 3 : 2 + unauthenticatedQueries + (process.env.ACP_CLAUDE_AUTH === '1' ? 2 : 0),'only explicit sends create queries');
 fs.writeFileSync(path.join(output,'shell-passed'),'ok');
 app.quit();
})().catch(async error=>{console.error(error);if(main){fs.writeFileSync(path.join(output,'shell-failure.png'),(await main.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'shell-failure.txt'),await js('document.body.innerText'));}app.quit();process.exitCode=1;});
