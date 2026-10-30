// Real WorkPanel and canonical WebApp siblings with an isolated Chromium guest.
// Run: BRAND=cutej node qa/work-panel-new-tab-webapp-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const output = path.resolve("build/qa/work-panel-new-tab-webapp");
fs.mkdirSync(output, { recursive: true });
await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React,{useCallback,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {WorkPanelHost} from './src/renderer/work-panel/WorkPanelHost';
import {CanonicalWebappSurfaceHost} from './src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts';
import {resolveWorkPanelActiveItemId} from './src/renderer/work-panel/new-tab-selection';
import {EMPTY_WORK_PANEL_STATE,reduceWorkPanelCommand} from './src/shared/work-panel';
import './src/renderer/styles/theme.css';
import './src/renderer/styles/external-webview.css';
import './src/renderer/styles/app-shell.css';
const noop=()=>()=>{};
window.smokeErrors=[];
addEventListener('error',event=>window.smokeErrors.push(event.message));
addEventListener('unhandledrejection',event=>window.smokeErrors.push(String(event.reason)));
window.surfaceRegistrations={};
window.electronAPI={
 embeddedCdp:{registerSurface:async value=>{window.surfaceRegistrations[value.surfaceId]=value;return{ok:true};},
  unregisterSurface:async value=>{delete window.surfaceRegistrations[value.surfaceId];return{ok:true};},
  getSurfaceTargetState:async()=>({ok:false})},
 onWebviewOpenTab:noop,onWorkPanelFullscreenExitShortcut:noop,onWorkPanelBrowserShortcut:noop,
 currentPage:{publishSnapshot:async()=>({ok:true})},
 chatWorkPanel:{localFiles:{getReviewPreloadUrl:async()=>'',release:async()=>({ok:true}),select:async()=>({ok:false,files:[]})},
  resourceImages:{release:async()=>({ok:true})},documentHtml:{release:async()=>({ok:true})}},
 chatWorkPanelTabContextMenu:{onWebDialogCloseRequested:noop,onWebDialogOpenRequested:noop},
 webs:{webapps:{listOpenWindows:async()=>[]}},
 sso:{onStatusChanged:noop},clipboard:{writeText:async()=>{}},
 desktopActions:{onCall:noop,respond:async()=>({ok:true})},
 desktopShell:{requestWindowClose:()=>{}},
};
const url=new URLSearchParams(location.search).get('guest');
const items=new Map([['webapp:fixture',{id:'fixture',kind:'webapp',label:'Fixture App',url,chrome:'app'}]]);
const initial=reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE,{type:'openItem',ownerChatId:'chat-a',
 descriptor:{kind:'webapp-ref',webappId:'fixture',title:'Fixture App'}}).nextState;
const initialItem=initial.workspaces[0].activeItemId;
function Scene(){
 const[state,setState]=useState(initial);const stateRef=useRef(state);stateRef.current=state;
 const[selectedNewTabs,setSelectedNewTabs]=useState({});
 const[chat,setChat]=useState('chat-a');const[shown,setShown]=useState(true);
 const[isWindows,setWindows]=useState(false);
 const dispatch=useCallback(command=>{const result=reduceWorkPanelCommand(stateRef.current,command);
  if(result.ok){stateRef.current=result.nextState;setState(result.nextState);}return result;},[]);
 const workspace=state.workspaces.find(candidate=>candidate.ownerChatId===chat);
 const activeItem=resolveWorkPanelActiveItemId(workspace,selectedNewTabs);
 const visible=shown&&state.visibleOwnerChatIds.includes(chat);
 window.smoke={chat:setChat,show:setShown,windows:setWindows,state,selectedNewTabs,activeItem,
  openApp:()=>dispatch({type:'activateItem',ownerChatId:'chat-a',itemId:initialItem})};
 return <MemoryRouter><div className={'app-shell has-chat-work-panel '+(isWindows?'is-windows-platform':'is-mac-platform')}>
  <div className="app-content"><main className="app-main"><h1>Main Chat</h1></main>
   <WorkPanelHost activeChatId={visible?chat:null} state={state} selectedNewTabs={selectedNewTabs}
    setSelectedNewTabs={setSelectedNewTabs} dispatchCommand={dispatch} fullscreenOwnerChatId={null}
    onFullscreenChange={async()=>true} isMac={!isWindows} isWindows={isWindows}
    launcher={{agentKey:'main',agentMode:'GENERAL',agentLabel:'Main',chatLabel:'Fixture Chat',
     projectVisible:false,projectEnabled:false,webapps:[{id:'fixture',label:'Fixture App'}],
     onOpenWebapp:async(owner,app)=>dispatch({type:'openItem',ownerChatId:owner,
      descriptor:{kind:'webapp-ref',webappId:app.id,title:app.label}}).ok,
     onFocusWebappWindow:async()=>false}}/>
   <CanonicalWebappSurfaceHost activeEntryKey={null} itemMap={items} mountedEntryKeys={['webapp:fixture']}
    presentations={{fixture:{scope:'workpanel',ownerChatId:'chat-a',itemId:initialItem}}}
    activeWorkPanelItemId={activeItem} activeWorkPanelChatId={chat} workPanelVisible={visible}/>
  </div></div></MemoryRouter>;
}
createRoot(document.getElementById('root')).render(<Scene/>);
` },
  bundle: true, jsx: "automatic", outfile: path.join(output, "scene.js"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false",
    __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))) },
  loader: { ".svg": "dataurl", ".png": "dataurl" },
});
fs.writeFileSync(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>
html,body,#root,.app-shell{margin:0;width:100%;height:100%;font:14px system-ui}.app-shell{--chat-work-panel-width:600px;display:flex;flex-direction:column;background:var(--bg-base);color:var(--ink)}
.app-content{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}.app-main{position:relative;flex:1;min-width:0;padding:16px}.work-panel-host{height:100%}
@media(max-width:600px){.app-main{display:none}.app-shell{--chat-work-panel-width:100vw}}
</style><div id="root"></div><script src="scene.js"></script></html>`);
fs.writeFileSync(path.join(output, "runner.cjs"), `
const{app,BrowserWindow,webContents}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
app.setPath('userData',process.env.NEWTAB_WEBAPP_PROFILE);
app.on('window-all-closed',()=>{});
const errors=[];let win,server;const watchdog=setTimeout(()=>{console.error('Smoke timed out');app.exit(1)},45000);
const wait=async(expression,label=expression)=>{for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Timed out: '+label)};
app.whenReady().then(async()=>{
 server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><title>Fixture App</title><style>body{margin:0;padding:32px;background:#152338;color:white;font:20px system-ui}input{font:inherit;padding:12px}</style><h1>Fixture App</h1><label>Preserved input <input id="draft" value="original"></label><script>window.instance=crypto.randomUUID();</script>')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 win=new BrowserWindow({width:1000,height:720,show:false,webPreferences:{webviewTag:true,contextIsolation:true,sandbox:true}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)errors.push(event.message)});
 await win.loadFile(path.join(__dirname,'index.html'),{query:{guest:'http://127.0.0.1:'+server.address().port+'/app'}});
 const js=source=>win.webContents.executeJavaScript(source);
 await wait('!!document.querySelector(".canonical-webapp-surface.is-active webview")');
 await wait('document.querySelector(".canonical-webapp-surface webview").getWebContentsId()>0');
 const id=await js('document.querySelector(".canonical-webapp-surface webview").getWebContentsId()');
 const guest=webContents.fromId(id);
 for(let i=0;i<100;i++){if(await guest.executeJavaScript('!!document.getElementById("draft")'))break;await new Promise(resolve=>setTimeout(resolve,30));}
 await guest.executeJavaScript('document.getElementById("draft").value="persisted webapp draft"');
 const instance=await guest.executeJavaScript('window.instance');
 const add=()=>js('document.querySelector(".chat-work-panel-add-button").click()');
 const tabs=()=>js('Array.from(document.querySelectorAll("[role=tab]"),el=>el.textContent)');
 const clickTab=index=>js('document.querySelectorAll("[role=tab]")['+index+'].click()');
 const inputDraft=value=>js('(()=>{const input=document.querySelector(".work-panel-new-tab input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}))})()');
 const assertLauncher=async()=>{
  await wait('!!document.querySelector(".work-panel-new-tab input") && !document.querySelector(".canonical-webapp-surface.is-active")');
  assert.equal(await js('(()=>{const input=document.querySelector(".work-panel-new-tab input"),r=input.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===input})()'),true,'canonical WebApp must not cover the launcher input');
  assert.equal(await js('document.querySelector(".canonical-webapp-surface webview").tabIndex'),-1);
  assert.equal(await js('document.querySelectorAll(".canonical-webapp-surface webview").length'),1);
  assert.equal(await js('document.querySelector(".canonical-webapp-surface webview").getWebContentsId()'),id);
 };
 const assertApp=async()=>{
  await wait('!!document.querySelector(".canonical-webapp-surface.is-active") && !document.querySelector(".work-panel-new-tab")');
  assert.equal(await js('document.querySelector(".canonical-webapp-surface webview").getWebContentsId()'),id);
  assert.equal(await guest.executeJavaScript('document.getElementById("draft").value'),'persisted webapp draft');
  assert.equal(await guest.executeJavaScript('window.instance'),instance);
 };
 for(const windows of [false,true]){
  await js('window.smoke.windows('+windows+')');
  await add();await assertLauncher();await inputDraft('first-draft.example');
  await clickTab(0);await assertApp();
  if(!windows){await new Promise(resolve=>setTimeout(resolve,150));fs.writeFileSync(path.join(__dirname,'webapp-restored.png'),(await win.webContents.capturePage()).toPNG());}
  await clickTab(1);await assertLauncher();assert.equal(await js('document.querySelector(".work-panel-new-tab input").value'),'first-draft.example');
  await add();await assertLauncher();await inputDraft('second-draft.example');
  await clickTab(1);await assertLauncher();assert.equal(await js('document.querySelector(".work-panel-new-tab input").value'),'first-draft.example');
  await clickTab(2);await assertLauncher();assert.equal(await js('document.querySelector(".work-panel-new-tab input").value'),'second-draft.example');
  await js('document.querySelectorAll(".chat-work-panel-tab-close")[2].click()');await assertApp();
  assert.equal((await tabs()).length,2);
  await clickTab(1);await assertLauncher();
  await js('window.smoke.chat("chat-b")');await wait('!document.querySelector(".canonical-webapp-surface.is-active") && !document.querySelector(".work-panel-new-tab")');
  await js('window.smoke.chat("chat-a")');await assertLauncher();
  await js('window.smoke.show(false)');await wait('!document.querySelector(".canonical-webapp-surface.is-active") && !document.querySelector(".work-panel-new-tab")');
  await js('window.smoke.show(true)');await assertLauncher();
  await js('document.querySelector(".work-panel-new-tab-suggestions button").click()');await assertApp();assert.equal((await tabs()).length,1,'successful WebApp open consumes its launcher');
 }
 await add();await assertLauncher();await inputDraft('screenshot-draft.example');
 await wait('document.querySelector(".work-panel-new-tab input").value === "screenshot-draft.example"');
 for(const [mode,width] of [['light',1000],['dark',1000],['light',390]]){
  win.setSize(width,720);await js('document.documentElement.dataset.theme='+JSON.stringify(mode));await assertLauncher();
  assert.equal(await js('document.querySelector(".work-panel-new-tab").scrollWidth<=document.querySelector(".work-panel-new-tab").clientWidth'),true);
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.writeFileSync(path.join(__dirname,mode+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 const rendererErrors=await js('window.smokeErrors');assert.deepEqual(rendererErrors,[],'no renderer exceptions');assert.deepEqual(errors,[],'no app console errors');
 fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({platform:process.platform,guestId:id,guestPreserved:true,errors,checks:['webapp-to-launcher','input-hit-testing','tabindex-inactive','tab-drafts','multiple-tabs-close','chat-switch','panel-hide-show','webapp-open-consumes-launcher','macOS-Windows-logic','light-dark-narrow']},null,2));
 console.log('PASS: real WorkPanel + canonical WebApp siblings; launcher hit testing; one stable guest, preserved page state; tab drafts, close, Chat/panel transitions; WebApp open consumes launcher; macOS/Windows logic; light/dark/narrow; no renderer/console errors');
 clearTimeout(watchdog);win.destroy();server.close();app.exit(0);
}).catch(error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();if(server)server.close();clearTimeout(watchdog);app.exit(1)});
`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "work-panel-new-tab-webapp-"));
try {
  const env = { ...process.env, NEWTAB_WEBAPP_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(output, "runner.cjs")], { stdio: "inherit", env });
  const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(code, 0, "Electron WebApp/new-tab smoke failed");
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
