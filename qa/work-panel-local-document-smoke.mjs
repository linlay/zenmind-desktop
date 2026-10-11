// Real WorkPanelHost and document guests; opening and reading must leave the composer untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), "work-panel-local-document-"));
await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: String.raw`
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {WorkPanelHost} from './src/renderer/work-panel/WorkPanelHost';
import {EMPTY_WORK_PANEL_STATE,reduceWorkPanelCommand} from './src/shared/work-panel';
import {registerServiceSurfaceWebviewRef} from './src/renderer/services/serviceSurfaceWebviewRefs';
import {MAIN_CHAT_SURFACE_ID} from './src/shared/surface-identity';
import {dispatchDesktopCloseShortcut} from './src/renderer/services/desktopCloseShortcutRegistry';
import './src/renderer/styles/theme.css';
import './src/renderer/styles/app-shell.css';
import './src/renderer/styles/external-webview.css';
window.contextRequests=[];window.reveals=[];window.releasedDocuments=[];window.handoffs=[];window.registrations=0;window.windowCloses=0;window.rendererErrors=[];
window.addEventListener('error',event=>window.rendererErrors.push({message:event.message,stack:event.error?.stack}));
const noop=()=>()=>{};
window.electronAPI={
  onWorkPanelBrowserShortcut:noop,onWebviewOpenTab:noop,onWorkPanelFullscreenExitShortcut:noop,
  embeddedCdp:{registerSurface:async()=>{window.registrations++;return{ok:true}},unregisterSurface:async()=>{}},
  desktopShell:{requestWindowClose:()=>window.windowCloses++},
  webs:{webapps:{listOpenWindows:async()=>[]}},
  chatWorkPanel:{localFiles:{getReviewPreloadUrl:async()=>'',release:async()=>{}},resourceImages:{release:async()=>{}},documentHtml:{release:async()=>{}}},
  chatWorkPanelTabContextMenu:{onWebDialogCloseRequested:noop,onWebDialogOpenRequested:noop},
  localDocuments:{
    close:async id=>{window.releasedDocuments.push(id);return{ok:true}},
    reveal:async id=>{window.reveals.push(id);if(window.failReveal){window.failReveal=false;return{ok:false}}return{ok:true}},
    editingContext:async request=>{window.contextRequests.push(request);throw Error('Document preview must not prepare composer text')},
  },
};
const mainChat=document.createElement('div');
registerServiceSurfaceWebviewRef(MAIN_CHAT_SURFACE_ID,{current:mainChat});
function Scene(){
  const initialState={...EMPTY_WORK_PANEL_STATE,visibleOwnerChatIds:['chat-edit'],workspaces:[{workspaceId:'workspace-edit',ownerChatId:'chat-edit',activeItemId:'html',items:window.fixtureDocuments.map(document=>({itemId:document.documentId,title:document.fileName,stableKey:'local-document:'+document.documentId,closable:true,pinned:false,descriptor:{kind:'native',surfaceKey:'local-document',context:document,title:document.fileName}}))}]};
  const [state,setState]=useState(initialState),[activeChatId,setActiveChatId]=useState('chat-edit'),[mounted,setMounted]=useState(true),[draft,setDraft]=useState('已有草稿，不要覆盖。');
  const stateRef=useRef(state);stateRef.current=state;
  const dispatchCommand=command=>{const result=reduceWorkPanelCommand(stateRef.current,command);if(result.ok){stateRef.current=result.nextState;setState(result.nextState)}return result};
  mainChat.send=(channel,payload)=>{window.handoffs.push({channel,payload});throw Error('Document preview must leave the composer untouched')};
  window.fixture={setActiveChatId,setMounted,dispatchClose:dispatchDesktopCloseShortcut,restore:()=>setState(initialState),getState:()=>state,bump:id=>setState(s=>({...s,workspaces:s.workspaces.map(workspace=>({...workspace,items:workspace.items.map(item=>item.itemId===id?{...item,descriptor:{...item.descriptor,context:{...item.descriptor.context,version:item.descriptor.context.version+1}}}:item)}))}))};
  return <MemoryRouter><div className="app-shell has-chat-work-panel is-mac-platform" style={{'--chat-work-panel-width':'480px'}}><div className="app-content">
    <main style={{flex:1,minWidth:0,padding:24,display:'flex',flexDirection:'column',color:'var(--ink)'}}><h2>小君</h2><p>已有对话内容</p><textarea aria-label="对话草稿" style={{marginTop:'auto',minHeight:160,width:'100%'}} value={draft} onChange={event=>setDraft(event.target.value)}/></main>
    {mounted?<WorkPanelHost activeChatId={activeChatId} state={state} dispatchCommand={dispatchCommand} fullscreenOwnerChatId={null} onFullscreenChange={async()=>true} isMac={true} isWindows={false} launcher={{agentKey:'main',agentMode:'CODER',agentLabel:'小君',chatLabel:'文件编辑',projectEnabled:false,webapps:[],onOpenWebapp:()=>{},onFocusWebappWindow:()=>{}}}/>:null}
  </div></div></MemoryRouter>;
}
createRoot(document.getElementById('root')).render(<Scene/>);
` },
  bundle: true, loader: { ".svg": "dataurl" }, jsx: "automatic", outfile: path.join(output, "scene.js"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))) },
});

fs.writeFileSync(path.join(output, "runner.cjs"), String.raw`
const {app,BrowserWindow,webContents}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'));app.on('window-all-closed',()=>{});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><script>window.loadIdentity=Math.random()</script><style>body{font:16px system-ui;padding:32px;color:#25364c;background:white}</style><h1>'+ (req.url==='/html'?'HTML 原文件':'Markdown 原文件')+'</h1><p>修改保存后，在原标签自动刷新。</p><input placeholder="切换标签保留此输入"/>')});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(win,expression){for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript('(()=>{try{return ('+expression+')}catch{return false}})()'))return;await wait(30)}throw Error('Timeout: '+expression)}
app.whenReady().then(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const documents=[{documentId:'markdown',fileName:'验证文档.md',kind:'markdown',url:base+'/markdown',partition:'local-document-workpanel-markdown',version:1,ownerChatId:'chat-edit'},{documentId:'html',fileName:'交互页面.html',kind:'html',url:base+'/html',partition:'local-document-workpanel-html',version:1,ownerChatId:'chat-edit'}];
  fs.writeFileSync(path.join(__dirname,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>*{box-sizing:border-box}html,body,#root{margin:0;height:100%;font-family:system-ui}</style></head><body><div id="root"></div><script>window.fixtureDocuments='+JSON.stringify(documents)+'</script><script src="scene.js"></script></body></html>');
  const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{webviewTag:true,contextIsolation:true,sandbox:true}});await win.loadFile(path.join(__dirname,'index.html'));const js=code=>win.webContents.executeJavaScript(code);
  await until(win,'document.querySelectorAll("webview").length===2 && [...document.querySelectorAll("webview")].every(v=>v.getWebContentsId()>0&&!v.isLoading())');
  const ids=await js('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())');const md=webContents.fromId(ids[0]),html=webContents.fromId(ids[1]);
  assert.equal(await js('window.registrations'),0);assert.equal(await js('[...document.querySelectorAll("webview")].every(v=>!v.hasAttribute("preload")&&!v.hasAttribute("allowpopups"))'),true);
  assert.equal(await html.executeJavaScript('typeof window.electronAPI+":"+typeof require'),'undefined:undefined');
  await html.executeJavaScript('document.querySelector("input").value="保留我的输入"');
  await js('document.querySelectorAll("[role=tab]")[0].click();window.fixture.setActiveChatId(null)');await until(win,'document.querySelector(".chat-work-panel").hidden');assert.deepEqual(await js('window.releasedDocuments'),[]);
  await js('window.fixture.setActiveChatId("chat-edit");document.querySelectorAll("[role=tab]")[1].click()');await until(win,'!document.querySelector(".chat-work-panel").hidden');
  assert.deepEqual(await js('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())'),ids);assert.equal(await html.executeJavaScript('document.querySelector("input").value'),'保留我的输入');
  const mdBefore=await md.executeJavaScript('window.loadIdentity'),htmlBefore=await html.executeJavaScript('window.loadIdentity');await js('window.fixture.bump("markdown")');
  for(let i=0;i<100&&await md.executeJavaScript('window.loadIdentity')===mdBefore;i++)await wait(30);
  assert.notEqual(await md.executeJavaScript('window.loadIdentity'),mdBefore,'watch version reloads only the changed file');assert.equal(await html.executeJavaScript('window.loadIdentity'),htmlBefore);assert.deepEqual(await js('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())'),ids);
  const assertDraftUnchanged=async()=>{
    assert.equal(await js('document.querySelector("textarea").value'),'已有草稿，不要覆盖。');
    assert.deepEqual(await js('window.contextRequests'),[],'preview actions never request edit-context text');
    assert.deepEqual(await js('window.handoffs'),[],'preview actions never send composer draft actions');
    assert.equal(await js('document.querySelectorAll(".work-panel-local-document-edit").length'),0);
  };
  await assertDraftUnchanged();
  fs.writeFileSync(path.join(__dirname,'chat-and-local-document.png'),(await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("[data-local-document-id=html] .document-preview-actions > button").click()');
  for(let i=0;i<100&&await html.executeJavaScript('window.loadIdentity')===htmlBefore;i++)await wait(30);
  assert.notEqual(await html.executeJavaScript('window.loadIdentity'),htmlBefore,'toolbar reload updates only its current guest');
  assert.deepEqual(await js('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())'),ids);
  await assertDraftUnchanged();
  await html.loadURL('http://127.0.0.1:1/fail').catch(()=>{});await until(win,'!!document.querySelector(".document-preview-error")');await js('document.querySelector(".document-preview-error button").click()');await until(win,'!document.querySelector(".document-preview-error") && document.querySelectorAll("webview")[1].getURL().endsWith("/html") && !document.querySelectorAll("webview")[1].isLoading()');assert.deepEqual(await js('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())'),ids);
  await js('document.querySelector("[data-local-document-id=html] .document-preview-more").click()');
  await until(win,'!!document.querySelector(".ant-popover:not(.ant-popover-hidden) .document-preview-zoom-reset")');
  await js('document.querySelector(".ant-popover:not(.ant-popover-hidden) .document-preview-zoom button:last-child").click()');
  await until(win,'Math.round(document.querySelectorAll("webview")[1].getZoomFactor()*100)===110');
  await js('document.querySelector(".ant-popover:not(.ant-popover-hidden) .document-preview-zoom-reset").click()');
  await until(win,'document.querySelectorAll("webview")[1].getZoomFactor()===1');
  await js('window.failReveal=true;document.querySelector(".ant-popover:not(.ant-popover-hidden) .document-preview-reveal").click()');
  await until(win,'!!document.querySelector(".work-panel-local-document-error")');
  assert.deepEqual(await js('window.reveals'),['html']);
  await js('document.querySelector(".work-panel-local-document-error button").click()');
  await until(win,'window.reveals.length===2 && !document.querySelector(".work-panel-local-document-error")');
  assert.deepEqual(await js('window.reveals'),['html','html']);
  await assertDraftUnchanged();
  win.setSize(780,600);await js('document.querySelector(".app-shell").style.setProperty("--chat-work-panel-width","360px")');await wait(100);
  assert.equal(await js('(()=>{const panel=document.querySelector(".chat-work-panel").getBoundingClientRect();return [...document.querySelectorAll("[data-local-document-id=html] .document-preview-actions button")].every(button=>{const r=button.getBoundingClientRect();return r.left>=panel.left&&r.right<=panel.right&&r.height>=28})})()'),true);
  fs.writeFileSync(path.join(__dirname,'narrow-workpanel.png'),(await win.webContents.capturePage()).toPNG());
  await js('document.querySelectorAll(".chat-work-panel-tab-close")[1].click()');await until(win,'window.releasedDocuments.length===1');assert.deepEqual(await js('window.releasedDocuments'),['html']);
  await js('window.fixture.dispatchClose({guestId:'+ids[0]+',fallbackToWindowClose:true})');await until(win,'window.releasedDocuments.length===2');assert.deepEqual(await js('window.releasedDocuments'),['html','markdown']);assert.equal(await js('window.windowCloses'),0,'closing the final file does not close the main window');
  await js('window.fixture.restore()');await until(win,'document.querySelectorAll("webview").length===2 && [...document.querySelectorAll("webview")].every(v=>v.getWebContentsId()>0&&!v.isLoading())');
  await assertDraftUnchanged();
  await js('window.fixture.setMounted(false)');await wait(100);
  assert.deepEqual(await js('window.releasedDocuments'),['html','markdown'],'host unmount does not revoke Main-owned selected files');
  await assertDraftUnchanged();
  const errors=await js('window.rendererErrors');const native=errors.filter(error=>/^Uncaught Error: Invalid guestInstanceId: \d+$/.test(error.message)&&error.stack.includes('disconnectedCallback (node:electron/js2c/isolated_bundle'));assert.deepEqual(errors.filter(error=>!native.includes(error)),[]);if(native.length)console.log('Existing Electron bare-webview detach diagnostics: '+native.length);
  console.log('PASS: real WorkPanelHost, retained guests across Chat/tab switches, per-file version reload, untouched existing composer draft, no edit-context requests, reload/zoom/reveal retry, 360px toolbar, close/release difference, final-tab window safety, and unmount lease retention.');console.log('Screenshots: '+__dirname);win.destroy();server.close();app.quit();
}).catch(error=>{console.error(error);server.close();app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(output, "runner.cjs")], { env, stdio: "inherit" });
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
fs.rmSync(path.join(output, "profile"), { recursive: true, force: true });
fs.rmSync(path.join(output, "session"), { recursive: true, force: true });
assert.equal(code, 0, `WorkPanel local document smoke failed; fixture retained at ${output}`);
