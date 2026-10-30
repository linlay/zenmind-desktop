// Real Electron WebView, isolated layout preload, Desktop controls and WebClient hook.
// No services, model calls, user profile changes or chat mutations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";

const repo = process.cwd();
const require = createRequire(path.join(repo, "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-chat-header-"));
const output = path.resolve(process.argv[2] || "build/qa/desktop-chat-header");
fs.mkdirSync(output, { recursive: true });
const alias = { react: path.join(repo, "node_modules/react"), "react-dom": path.join(repo, "node_modules/react-dom") };
const shared = { bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias,
  loader: { ".svg": "file" }, define: { "process.env.NODE_ENV": '"production"',
    __DESKTOP_APP_BRAND__: JSON.stringify(require("./dist-electron/shared/brand.js").APP_BRAND) } };
await build({ ...shared, stdin: { loader: "tsx", resolveDir: repo, contents: `
import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DesktopChatHeaderNavigation} from './src/renderer/app-shell/navigation/DesktopChatHeaderNavigation';
import {WebappCopilotButton} from './src/renderer/app-shell/navigation/WebappCopilotButton';
import {AppSidebar} from './src/renderer/app-shell/navigation/AppSidebar';
import {SidebarActionIcon} from './src/renderer/components/BrandMark';
import {MemoryRouter} from 'react-router-dom';
import {createWebclientHeaderLayoutHost} from './src/renderer/service-webview/headerLayoutHost';
import './src/renderer/styles.css';
window.actions={search:0,back:0,forward:0};window.documents=0;
window.electronAPI={assistant:{getProjectCreationOptions:async()=>({ok:false,message:'fixture'})}};
function Host(){
 const [config,setConfig]=useState({collapsed:true,platform:'darwin',fullscreen:false,canGoBack:false,canGoForward:true,width:240,mainChat:true,webapp:false,copilot:false,dockOpen:false,overlay:false,sidebarMode:'primary'});
 const isMac=config.platform==='darwin',fixed=config.sidebarMode==='primary'&&(isMac||config.fullscreen);
 const collapsed=config.collapsed&&config.sidebarMode==='primary',width=collapsed?66:config.width;
 const [inset,setInset]=useState(142);const webview=useRef(null),relay=useRef(null),sequence=useRef({revision:0,signature:''});
 const input=useRef(null);input.current={sidebarCollapsed:config.collapsed,headerLeftInset:collapsed&&fixed&&config.mainChat?inset:0};
 const src=useRef(location.origin+'/guest.html?chatId=fixture&desktopSidebarCollapsed=1&desktopHeaderLeftInset=142');
 window.configure=(patch)=>setConfig(old=>({...old,...patch}));
 useEffect(()=>{const target=webview.current;const host=createWebclientHeaderLayoutHost({webview:target,
  trustedUrl:()=>src.current,isCurrentGuest:()=>webview.current===target,read:()=>input.current,revisionState:sequence.current});
  relay.current=host;const loaded=()=>window.documents++;target.addEventListener('did-finish-load',loaded);
  return ()=>{host.dispose();target.removeEventListener('did-finish-load',loaded)};},[]);
 useLayoutEffect(()=>relay.current?.refresh(),[config.collapsed,config.mainChat,config.platform,config.fullscreen,inset]);
 const toggle=()=>setConfig(old=>({...old,collapsed:!old.collapsed}));
 const toggleCopilot=()=>setConfig(old=>({...old,dockOpen:!old.dockOpen}));
 const search=()=>window.actions.search++,back=()=>window.actions.back++,forward=()=>window.actions.forward++;
 return <div className={'app-shell '+(isMac?'is-mac-platform':'is-windows-platform')+(config.fullscreen?' is-window-fullscreen':'')+(collapsed?' is-sidebar-collapsed':'')+(fixed?' has-fixed-sidebar-header-navigation':'')+(config.mainChat?' has-main-chat-header-actions':'')+(config.webapp?' has-webapp-surface':'')+(config.dockOpen?' has-assistant-dock-full':'')+(config.dockOpen&&config.overlay?' has-assistant-dock-overlay':'')} style={{'--app-sidebar-width':width+'px','--assistant-dock-embedded-width':'360px'}}>
  {!isMac&&!config.fullscreen?<header className="app-system-bar"><div className="app-system-bar-drag-region">
   <span className="app-system-bar-brand-mark">Z</span><nav className="app-system-bar-primary-actions">
    <button className="app-system-bar-action" onClick={search}>S</button>
    <button className="app-system-bar-action" disabled={!config.canGoBack} onClick={back}>←</button>
    <button className="app-system-bar-action" disabled={!config.canGoForward} onClick={forward}>→</button>
    <button className="app-system-bar-action app-system-bar-sidebar-toggle" aria-expanded={!collapsed} onClick={toggle}>◧</button>
   </nav></div></header>:null}
  <div className="app-sidebar-shell"><AppSidebar isCollapsed={collapsed} isMac={isMac} isWindows={!isMac}
   currentPathname={config.mainChat?'/agent/fixture':config.webapp?'/webs/webapp:fixture':'/market'} currentRoute={config.mainChat?'/agent/fixture':config.webapp?'/webs/webapp:fixture':'/market'}
   assistantLauncherVisible={config.copilot&&!config.webapp} sidebarNavOrder={[]} webItems={[]} onShareChat={()=>{}}
   sidebarMode={config.sidebarMode} toolMenuOpen={false} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}}
   onToggleCollapsed={toggle} onOpenGlobalSearch={search} onSidebarNavigateBack={back} onSidebarNavigateForward={forward}/></div>
  <div className="app-content">{config.webapp&&config.copilot&&config.sidebarMode==='primary'?<WebappCopilotButton open={config.dockOpen} onToggle={toggleCopilot}/>:null}<webview ref={webview} className="qa-guest" src={src.current} preload={window.preloadUrl}/></div>
  <div className="app-window-controls-layer">
   {fixed?<DesktopChatHeaderNavigation isCollapsed={collapsed} leftInset={collapsed&&!config.mainChat?21:isMac?88:8} canGoBack={config.canGoBack} canGoForward={config.canGoForward}
     onSearch={search} onBack={back} onForward={forward} onToggle={toggle} onInsetChange={setInset}/>:null}
   {config.mainChat?<div className="main-chat-header-actions qa-right-actions"><button className="main-chat-header-action">⋯</button><button className="main-chat-header-action">↗</button><button className="main-chat-header-action main-chat-work-panel-toggle"><SidebarActionIcon kind="sidebar_left" className="main-chat-work-panel-toggle-icon"/></button></div>:null}
  </div>
  {config.dockOpen?<aside className="agent-webclient-copilot-dock is-open"><button className="copilot-dock-close-button" onClick={toggleCopilot}>×</button></aside>:null}
 </div>;
}
createRoot(document.getElementById('root')).render(<MemoryRouter><Host/></MemoryRouter>);
` }, outfile: path.join(root, "host.js") });
await build({ ...shared, stdin: { loader: "tsx", resolveDir: repo, contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useDesktopHeaderLayout} from ${JSON.stringify(path.resolve(repo, "../agent-webclient/src/app/layout/useDesktopHeaderLayout.ts"))};
window.documentIdentity=crypto.randomUUID();
function Guest(){const layout=useDesktopHeaderLayout(true);return <><nav id="guest-header" style={{paddingLeft:layout.headerLeftInset}}><input id="search" placeholder="搜索当前对话"/><span>主聊天</span></nav><main><textarea id="draft" defaultValue="未发送草稿"/></main></>}
createRoot(document.getElementById('root')).render(<Guest/>);
` }, outfile: path.join(root, "guest.js") });
await build({ stdin: { contents: "import { installServiceWebviewHeaderLayout } from './src/preload/service-webview-header-layout'; installServiceWebviewHeaderLayout();",
  resolveDir: repo }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: path.join(root, "preload.cjs") });
const preloadUrl = new URL(`file://${path.join(root, "preload.cjs")}`).toString();
fs.writeFileSync(path.join(root, "host.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><style>
html,body,#root{height:100%;margin:0}
.qa-guest{width:100%;height:100%;display:flex}

</style><div id="root"></div><script>window.preloadUrl=${JSON.stringify(preloadUrl)}</script><script src="/host.js"></script>`);
fs.writeFileSync(path.join(root, "guest.html"), `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font:14px system-ui}body{background:#f7faf8;color:#22382a}
nav{height:44px;display:flex;align-items:center;padding:4px 16px 0;gap:30px;border-bottom:1px solid #dde6df}
input{width:180px;height:28px;padding:4px 8px;border:1px solid #dde6df;border-radius:7px;background:#fff}
main{padding:24px}textarea{width:420px;height:100px;padding:12px;border:1px solid #dde6df;border-radius:12px}
</style><div id="root"></div><script src="/guest.js"></script>`);
fs.writeFileSync(path.join(root, "main.cjs"), `
const {app,BrowserWindow,webContents}=require('electron');const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{await app.whenReady();const server=http.createServer((req,res)=>{const name=path.basename(new URL(req.url,'http://localhost').pathname);const file=path.join(__dirname,name);if(!(['host.html','host.js','host.css','guest.html','guest.js'].includes(name)||name.endsWith('.svg'))||!fs.existsSync(file)){res.writeHead(404);res.end();return}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false}});
await win.loadURL('http://127.0.0.1:'+server.address().port+'/host.html');win.show();win.focus();await pause(150);
const js=s=>win.webContents.executeJavaScript(s);let guest;
const until=async(fn)=>{for(let attempt=0;attempt<150;attempt++){if(await fn())return;await pause(30)}throw new Error('Timed out: '+fn)};
await until(()=>js('!!document.querySelector("webview")?.getWebContentsId()').catch(()=>false));
guest=webContents.fromId(await js('document.querySelector("webview").getWebContentsId()'));
const gj=s=>guest.executeJavaScript(s);
await until(()=>gj('!!document.querySelector("#search")').catch(()=>false));
await until(()=>gj('document.querySelector("#guest-header").style.paddingLeft==="142px"'));
const identity=await gj('window.documentIdentity'),id=guest.id,url=guest.getURL(),src=await js('document.querySelector("webview").getAttribute("src")');
await gj('document.querySelector("#draft").value="保留的输入草稿"');
const activeSelector='.main-chat-header-navigation button, .app-system-bar-primary-actions button';
const center=async(index)=>js('(()=>{const r=document.querySelectorAll('+JSON.stringify(activeSelector)+')['+index+'].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
const clickPoint=async(point)=>{win.focus();win.webContents.focus();await pause(30);win.webContents.sendInputEvent({type:'mouseMove',...point});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await pause(80)};
const click=async(index)=>clickPoint(await center(index));
const cases=[];
for(const platform of ['darwin','win32']){for(const fullscreen of [false,true]){
 const fixed=platform==='darwin'||fullscreen,expectedInset=fixed?(platform==='darwin'?142:62):0;
 await js('window.configure('+JSON.stringify({platform,fullscreen,collapsed:true,mainChat:true,sidebarMode:'primary',copilot:false})+')');
 await until(()=>gj('document.querySelector("#guest-header").style.paddingLeft==="'+expectedInset+'px"'));
 const before=await js('({...window.actions})');await click(0);await click(1);await click(2);
 assert.deepEqual(await js('({...window.actions})'),{search:before.search+1,back:before.back,forward:before.forward+1});
 const point=await center(3);assert.equal(await js('document.querySelectorAll('+JSON.stringify(activeSelector)+')[3].getAttribute("aria-expanded")'),'false');
 if(platform==='darwin')assert.deepEqual(point,{x:184,y:22});
 if(fixed){
  const rightCenter=await js('(()=>{const r=document.querySelector(".main-chat-work-panel-toggle-icon").getBoundingClientRect();return r.top+r.height/2})()');
  assert.equal(rightCenter,point.y,'WorkPanel icon must align with the fixed navigation');
 }
 const positions=await js('(()=>{const a=document.querySelector(".main-chat-header-navigation")?.getBoundingClientRect();const c=document.querySelector("webview").getBoundingClientRect();return {right:a?.right,top:a?.top,guestLeft:c.left}})()');
 const searchLeft=await gj('document.querySelector("#search").getBoundingClientRect().left');
 if(fixed)assert.ok(positions.right<=positions.guestLeft+searchLeft,'Desktop buttons overlap the WebClient search input');
 // Keep the physical pointer in place across every expansion, collapse and width change.
 for(const width of [240,264,360]){
  await js('window.configure({width:'+width+'})');
  for(let cycle=0;cycle<2;cycle++){
   await clickPoint(point);await until(()=>gj('document.querySelector("#guest-header").style.paddingLeft==="0px"'));
   assert.deepEqual(await center(3),point);assert.equal(await js('document.querySelectorAll('+JSON.stringify(activeSelector)+')[3].getAttribute("aria-expanded")'),'true');
   await clickPoint(point);await until(()=>gj('document.querySelector("#guest-header").style.paddingLeft==="'+expectedInset+'px"'));
   assert.deepEqual(await center(3),point);assert.equal(await js('document.querySelectorAll('+JSON.stringify(activeSelector)+')[3].getAttribute("aria-expanded")'),'false');
  }
 }
 assert.equal(guest.id,id);assert.equal(guest.getURL(),url);assert.equal(await gj('window.documentIdentity'),identity);assert.equal(await gj('document.querySelector("#draft").value'),'保留的输入草稿');assert.equal(await js('document.querySelector("webview").getAttribute("src")'),src);
 if(platform==='darwin')assert.equal(await js('(()=>{const buttons=document.querySelectorAll(".sidebar-top-actions button");return [...buttons].filter(e=>e.getBoundingClientRect().width>0).length})()'),0,'collapsed macOS sidebar must not expose duplicate controls');
 for(const theme of ['light','dark']){await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await pause(60);fs.writeFileSync(path.join(${JSON.stringify(output)},platform+'-'+(fullscreen?'fullscreen-':'')+theme+'.png'),(await win.webContents.capturePage({x:0,y:0,width:1280,height:140})).toPNG())}
 // Collapsed WebApps retain their full height; only the expand control stays in the rail.
 await js('window.configure({mainChat:false,copilot:true,collapsed:true,width:240})');
 await until(()=>gj('document.querySelector("#guest-header").style.paddingLeft==="0px"'));
 assert.equal(await js('document.querySelector("webview").getBoundingClientRect().top'),platform==='win32'&&!fullscreen?30:0);
 if(fixed){
  const visible=await js('(()=>{return [...document.querySelectorAll(".main-chat-header-navigation button")].filter(e=>e.getBoundingClientRect().width>0).length})()');
  assert.equal(visible,1,'collapsed non-Chat pages must not show a toolbar row');
  const bounds=await js('(()=>{const r=document.querySelector(".main-chat-header-navigation").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})()');
  assert.ok(bounds.left>=0&&bounds.right<=66,'expand control must fit within the sidebar rail');
  assert.ok(await js('document.querySelector(".sidebar-nav").getBoundingClientRect().top')>=bounds.bottom,'expand control must not overlap sidebar entries');
  assert.equal((await center(3)).x,33);
 }
 fs.writeFileSync(path.join(${JSON.stringify(output)},platform+'-'+(fullscreen?'fullscreen-':'')+'webapp-collapsed.png'),(await win.webContents.capturePage({x:0,y:0,width:1280,height:140})).toPNG());
 const nonChatExpand=await center(3);await clickPoint(nonChatExpand);await pause(230);assert.deepEqual(await center(3),point);
 assert.equal(await js('document.querySelector("webview").getBoundingClientRect().top'),platform==='win32'&&!fullscreen?30:0);
 if(platform==='darwin'){
  const assistant=await js('(()=>{const e=document.querySelector(".sidebar-assistant-top-button"),r=e.getBoundingClientRect(),icon=e.querySelector("svg").getBoundingClientRect();return {left:r.left,width:r.width,cy:icon.top+icon.height/2,visible:getComputedStyle(e).display!=="none"}})()');
  assert.ok(assistant.visible&&assistant.width>0&&assistant.left>=196,'Copilot must not overlap the fixed group');
  assert.equal(assistant.cy,point.y,'Copilot icon must align with the fixed navigation');
  assert.equal(await js('(()=>{return [...document.querySelectorAll(".sidebar-top-actions button")].filter(e=>e.getBoundingClientRect().width>0).length})()'),1);
  await js('window.configure({sidebarMode:"settings"})');await pause(80);
  assert.equal(await js('document.querySelector(".main-chat-header-navigation")'),null);
 }
 // A WebApp has one always-visible launcher in its viewport, including with a collapsed rail.
 await js('window.configure({webapp:true,mainChat:false,copilot:true,sidebarMode:"primary",collapsed:true,dockOpen:false,overlay:false})');await pause(240);
 const launcher=()=>js('(()=>{const e=document.querySelector(".webapp-copilot-button"),r=e.getBoundingClientRect(),g=document.querySelector("webview").getBoundingClientRect(),s=getComputedStyle(e);return {x:r.left+r.width/2,y:r.top+r.height/2,right:r.right,top:r.top,width:r.width,contentRight:g.right,contentTop:g.top,guestTop:g.top,opacity:s.opacity,visibility:s.visibility,pressed:e.getAttribute("aria-pressed")}})()');
 win.webContents.sendInputEvent({type:'mouseMove',x:400,y:400});await pause(30);
 const initial=await launcher();assert.equal(initial.opacity,'1');assert.equal(initial.visibility,'visible');assert.equal(initial.width,24);
 assert.equal(initial.contentRight-initial.right,14);assert.equal(initial.top-initial.contentTop,platform==='darwin'?10:8);
 assert.equal(initial.guestTop,platform==='win32'&&!fullscreen?30:0);
 assert.equal(await js('document.querySelector(".sidebar-assistant-top-button")'),null,'WebApp must not duplicate the launcher in the sidebar');
 const draftRect=await gj('(()=>{const r=document.querySelector("#draft").getBoundingClientRect();return {x:r.x+30,y:r.y+20}})()');
 const guestRect=await js('(()=>{const r=document.querySelector("webview").getBoundingClientRect();return {x:r.x,y:r.y}})()');
 const draftPoint={x:guestRect.x+draftRect.x,y:guestRect.y+draftRect.y};
 assert.equal(await js('document.elementFromPoint('+draftPoint.x+','+draftPoint.y+').tagName'),'WEBVIEW','floating control must not intercept the rest of the page');
 // Electron synthetic input targets one WebContents; route page input to the guest.
 guest.focus();guest.sendInputEvent({type:'mouseMove',...draftRect});guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...draftRect});guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...draftRect});await pause(50);
 assert.equal(await gj('document.activeElement.id'),'draft','page remains clickable around the floating button');
 win.webContents.focus();
 for(const collapsed of [false,true]){await js('window.configure({collapsed:'+collapsed+'})');await pause(240);const r=await launcher();assert.equal(r.right,initial.right);assert.equal(r.top,initial.top);assert.equal(r.guestTop,initial.guestTop);}
 await clickPoint({x:initial.x,y:initial.y});await pause(240);
 const opened=await launcher();assert.equal(opened.pressed,'true');assert.equal(opened.contentRight-opened.right,14);assert.ok(initial.right-opened.right>=360,'launcher follows the resized WebApp viewport beside the Dock');
 await clickPoint({x:opened.x,y:opened.y});await pause(240);assert.equal((await launcher()).pressed,'false');
 win.focus();win.webContents.focus();await js('document.querySelector(".webapp-copilot-button").focus()');
 assert.equal(await js('document.activeElement.className'),'webapp-copilot-button');
 await pause(50);win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await pause(240);assert.equal((await launcher()).pressed,'true','keyboard opens Copilot');
 await js('window.configure({overlay:true})');await pause(240);
 const closePoint=await js('(()=>{const r=document.querySelector(".copilot-dock-close-button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
 await clickPoint(closePoint);await pause(240);assert.equal((await launcher()).pressed,'false','overlay Dock keeps an accessible close button');
 win.webContents.sendInputEvent({type:'mouseMove',x:400,y:400});
 for(const theme of ['light','dark']){await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await pause(50);fs.writeFileSync(path.join(${JSON.stringify(output)},platform+'-'+(fullscreen?'fullscreen-':'')+'webapp-copilot-'+theme+'.png'),(await win.webContents.capturePage({x:0,y:0,width:1280,height:140})).toPNG())}
 await js('window.configure({copilot:false})');await pause(50);assert.equal(await js('document.querySelector(".webapp-copilot-button")'),null,'respects the disabled Copilot preference');
 await js('window.configure({webapp:false,mainChat:true})');await pause(50);assert.equal(await js('document.querySelector(".webapp-copilot-button")'),null,'launcher is exclusive to WebApp pages');
 assert.equal(await gj('window.documentIdentity'),identity);assert.equal(await gj('document.querySelector("#draft").value'),'保留的输入草稿');
 cases.push({platform,fullscreen,point,positions,searchLeft,webappLauncher:initial});
}}
await js('window.configure({platform:"darwin",fullscreen:false,sidebarMode:"primary",mainChat:true,collapsed:true,canGoBack:true})');await pause(80);
const back=await js('window.actions.back');await click(1);assert.equal(await js('window.actions.back'),back+1);
const report={ok:true,guestId:id,documentIdentity:identity,loads:await js('window.documents'),cases};assert.equal(report.loads,1,'sidebar changes reloaded the guest');fs.writeFileSync(path.join(${JSON.stringify(output)},'report.json'),JSON.stringify(report,null,2));console.log('Desktop chat header UI smoke passed: '+${JSON.stringify(output)});win.destroy();server.close();app.quit();})().catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let outputText = "";
child.stdout.on("data", (data) => { outputText += data; });
child.stderr.on("data", (data) => { outputText += data; });
const watchdog = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(watchdog);
if (code !== 0 || !outputText.includes("Desktop chat header UI smoke passed:")) {
  throw new Error(`Desktop chat header smoke failed (${code}):\n${outputText}`);
}
console.log(outputText.trim());
