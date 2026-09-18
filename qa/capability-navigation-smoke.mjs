// Isolated sidebar UI: mocked native menus, no services or user profile mutations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const repo = process.cwd();
const require = createRequire(path.join(repo, "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-navigation-ui-"));
await build({ stdin: { contents: `
import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,useLocation,useNavigate} from 'react-router-dom';
import {AppSidebar} from ${JSON.stringify(path.join(repo, "src/renderer/app-shell/navigation/AppSidebar.tsx"))};
import {resolveSidebarMode} from ${JSON.stringify(path.join(repo, "src/renderer/app-shell/navigation/capabilityNavigation.ts"))};
import ${JSON.stringify(path.join(repo, "src/renderer/styles.css"))};
window.menuRequests=[];window.closedWebsites=[];
window.electronAPI={sidebarContextMenu:{popup:async(request)=>{window.menuRequests.push(request);return {actionId:null};}}};
function Fixture(){
 const location=useLocation(),navigate=useNavigate();
 const [order,setOrder]=useState(()=>JSON.parse(localStorage.getItem('test-order')||'null')||['kanban','schedules','new-chat','chats','group:assistants','group:webs']);
 const [options,setOptions]=useState({collapsed:false,platform:'darwin',market:true,help:true,sso:null,menuOpen:false,website:false,websitePinned:true});
 const [retained,setRetained]=useState(null);
 const mode=retained?.locationKey===location.key?retained.mode:location.state?.sidebarMode==='capabilities'?'capabilities':resolveSidebarMode(location.pathname,order);
 useEffect(()=>{setRetained(current=>current?.locationKey===location.key?current:null)},[location.key]);
 window.navigate=navigate;window.setOptions=(patch)=>setOptions(old=>({...old,...patch}));window.order=order;window.mode=mode;
 return <div className={'app-shell '+(mode!=='primary'?'is-secondary-sidebar-mode ':'')+(options.platform==='darwin'?'is-mac-platform':'is-windows-platform')}>
 <div className="app-sidebar-shell"><AppSidebar desktopSsoStatus={options.sso} isCollapsed={options.collapsed} isMac={options.platform==='darwin'} isWindows={options.platform==='win32'} currentPathname={location.pathname} currentRoute={location.pathname} sidebarMode={mode} sidebarNavOrder={options.website?[...order,'website:qa']:order} onSidebarNavOrderChange={next=>{setRetained({locationKey:location.key,mode});setOrder(next);localStorage.setItem('test-order',JSON.stringify(next));}} webItems={options.website?[{id:'qa',entryKey:'website:qa',label:'QA Website',kind:'website',url:'https://example.com',createdAt:1,updatedAt:1}]:[]} pinnedWebEntryKeys={options.website&&options.websitePinned?['website:qa']:[]} webOpenEntryKeys={options.website?['website:qa']:[]} onSetWebItemPinned={async()=>{}} onCloseWebItem={async(item)=>{window.closedWebsites.push(item.entryKey);}} marketEnabled={options.market} helpEnabled={options.help} toolMenuOpen={options.menuOpen} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}} onRequestToolNavigate={to=>{const mode=resolveSidebarMode(to);if(to===location.pathname){setRetained({locationKey:location.key,mode});}else{navigate(to,{state:{sidebarMode:mode}});}return true;}} onRequestNavigate={to=>{navigate(to);return true;}} onExitSecondarySidebarMode={()=>navigate('/kanban')}/></div></div>;
}
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/agents']}><Fixture/></MemoryRouter>);
`, resolveDir: repo, loader: "tsx" }, outfile: path.join(root, "fixture.js"), bundle: true, loader: { ".svg": "dataurl" }, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(require(path.join(repo, "dist-electron/shared/brand.js")).APP_BRAND) } });
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>.app-sidebar-shell{width:240px!important;height:100vh}.app-sidebar{height:100vh}.app-shell{height:100vh}</style><div id="root"></div><script src="fixture.js"></script></html>`);
fs.writeFileSync(path.join(root, "main.cjs"), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'));
(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});await win.loadFile(path.join(__dirname,'index.html'));const js=(s)=>win.webContents.executeJavaScript(s);const until=async(s)=>{for(let n=0;n<100;n++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+s);};
await until('document.querySelector(".sidebar-capability-visibility-button")');
for(const [id,route] of [['agents','/agents'],['skills','/skills'],['mcp-servers','/connectors'],['registries','/registries'],['archives','/archives'],['market','/market'],['artifact-management','/artifact-management'],['share-management','/share-management'],['help','/help']]){
 await js('window.navigate('+JSON.stringify(route)+')');await until('window.mode==="capabilities"');
 await js('document.querySelector('+JSON.stringify('[data-sidebar-capability-id="'+id+'"]').concat(').parentElement.querySelector("button").click()'));
 await until('window.order[0]==='+JSON.stringify('capability:'+id));
 assert.equal(await js('window.mode'),'capabilities');
 win.webContents.sendInputEvent({type:'mouseMove',x:1000,y:700});
 assert.equal(await js('getComputedStyle(document.querySelector('+JSON.stringify('[data-sidebar-capability-id="'+id+'"]').concat(').parentElement.querySelector("button")).opacity')), '1');

 await js('window.navigate("/kanban")');await until('window.mode==="primary"');
 await js('window.navigate('+JSON.stringify(route)+')');await until('window.mode==="primary"');
 assert.equal(await js('window.order[0]'), 'capability:'+id);
 assert.equal(await js('window.menuRequests.length'),0);
 assert.equal(await js('document.querySelector('+JSON.stringify('[data-sidebar-capability-id="'+id+'"]').concat(').parentElement.querySelector("button").getAttribute("aria-pressed")')), 'true');
}
await js('window.navigate("/kanban")');await until('document.querySelector(".sidebar-primary-link")');
await js('document.activeElement.blur()');
const point=await js(\`(()=>{const r=document.querySelector('[data-sidebar-capability-id="agents"]').getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+r.height/2)}})()\`);
win.webContents.sendInputEvent({type:'mouseMove',x:1000,y:700});
await until(\`getComputedStyle(document.querySelector('[data-sidebar-capability-id="agents"]').parentElement.querySelector('button')).opacity==='0'\`);
await js('window.navigate("/connectors");document.querySelector("[data-sidebar-capability-id=mcp-servers]").focus()');
await until('document.querySelector("[data-sidebar-capability-id=mcp-servers]").classList.contains("sidebar-link-active")');
assert.equal(await js('getComputedStyle(document.querySelector("[data-sidebar-capability-id=mcp-servers]").parentElement.querySelector("button")).opacity'),'0');
win.webContents.sendInputEvent({type:'mouseMove',...point});
await until(\`getComputedStyle(document.querySelector('[data-sidebar-capability-id="agents"]').parentElement.querySelector('button')).opacity==='1'\`);
// Account identity stays stable while capability pages are selected.
for(const platform of ['darwin','win32']){
 for(const sso of [null,{configured:true,authenticated:false,completedSteps:{}},{configured:true,authenticated:true,user:{name:'Frank Linlay'},completedSteps:{userInfo:true,accessToken:true}}]){
  await js('window.setOptions('+JSON.stringify({platform,sso})+')');
  for(const route of ['/agents','/skills','/artifact-management','/kanban']){
   await js('window.navigate('+JSON.stringify(route)+')');
   const expected=sso?.authenticated?'Frank Linlay':'未登录';
   await until('document.querySelector(".sidebar-tool-menu-trigger > .sidebar-link-label")?.textContent==='+JSON.stringify(expected));
   assert.equal(await js('document.querySelector(".sidebar-tool-menu-trigger").classList.contains("sidebar-link-active")'),false);
   assert.equal(await js('document.querySelectorAll(".sidebar-tool-menu-trigger .sidebar-account-menu-avatar").length'),sso?.authenticated?1:0);
  }
 }
}
// Footer menu opens the dedicated sidebar, including the current primary route.
for(const route of ['/agents','/skills','/artifact-management']){
 for(const sameRoute of [false,true]){
  await js('window.navigate('+JSON.stringify(sameRoute?route:'/kanban')+');window.setOptions({menuOpen:true})');
  await until('document.querySelector('+JSON.stringify('.sidebar-tool-menu-item[href="'+route+'"]')+')');
  await js('document.querySelector('+JSON.stringify('.sidebar-tool-menu-item[href="'+route+'"]')+').click()');
  await until('window.mode==="capabilities"');
  assert.equal(await js('window.order.includes('+JSON.stringify('capability:'+({'/agents':'agents','/skills':'skills','/artifact-management':'artifact-management'}[route]))+')'),true);
  await js('window.setOptions({menuOpen:false});window.navigate("/kanban")');await until('window.mode==="primary"');
  await js('document.querySelector('+JSON.stringify('a.sidebar-primary-link[href="'+route+'"]')+').click()');
  await until('window.mode==="primary" && !!document.querySelector(".sidebar-footer")');
 }
}
await js('window.navigate("/kanban")');
// Drag an actual capability row below Kanban using Chromium drag events.
await js(\`(()=>{const from=document.querySelector('[data-sidebar-capability-id="agents"]').closest('.sidebar-sortable-nav-entry');const to=document.querySelector('a[href="/kanban"]').closest('.sidebar-sortable-nav-entry');const dataTransfer=new DataTransfer();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));const r=to.getBoundingClientRect();to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientY:r.bottom-1}));to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientY:r.bottom-1}));})()\`);
await until('window.order.indexOf("capability:agents")===window.order.indexOf("kanban")+1');
for(const platform of ['darwin','win32']){
 await js('window.setOptions({platform:'+JSON.stringify(platform)+',collapsed:true})');await until('document.querySelector(".app-sidebar.is-collapsed")');
 await js(\`document.querySelector('[data-sidebar-capability-id="agents"]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,altKey:true,key:'ArrowUp'}))\`);
 await until('window.order.indexOf("capability:agents")<window.order.indexOf("kanban")');
 await js(\`document.querySelector('[data-sidebar-capability-id="agents"]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,altKey:true,key:'ArrowDown'}))\`);
 await until('window.order.indexOf("capability:agents")>window.order.indexOf("kanban")');
}
const saved=await js('window.order');await win.reload();await until('document.querySelector(".sidebar-primary-link")');assert.deepEqual(await js('window.order'),saved);
await js('window.setOptions({market:false,help:false})');await until(\`!document.querySelector('[data-sidebar-capability-id="market"]')\`);assert.deepEqual(await js('window.order'),saved);
await js('window.setOptions({market:true,help:true});document.documentElement.dataset.theme="dark"');await until(\`document.querySelector('[data-sidebar-capability-id="market"]')\`);
await js(\`document.querySelector('.sidebar-capability-visibility-button').focus();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))\`);
fs.writeFileSync(path.join(__dirname,'navigation-dark.png'),(await win.webContents.capturePage({x:0,y:0,width:260,height:780})).toPNG());
await js(\`window.navigate('/agents/example')\`);await until('window.mode==="primary"');
await js(\`document.querySelector('[data-sidebar-capability-id="agents"]').parentElement.querySelector('button').focus()\`);
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
await until('!window.order.includes("capability:agents")');assert.equal(await js('window.mode'),'primary');assert.equal(await js('window.menuRequests.length'),0);
await js('window.navigate("/kanban")');await js('new Promise(resolve=>requestAnimationFrame(resolve))');
await js('window.navigate("/agents")');await until('window.mode==="capabilities"');
assert.equal(await js(\`document.querySelector('[data-sidebar-capability-id="agents"]').parentElement.querySelector('button').getAttribute('aria-pressed')\`),'false');
await js(\`document.documentElement.dataset.theme="light";document.querySelector('.sidebar-capability-visibility-button').focus();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))\`);fs.writeFileSync(path.join(__dirname,'capabilities-light.png'),(await win.webContents.capturePage({x:0,y:0,width:260,height:780})).toPNG());
await js('window.navigate("/kanban");window.setOptions({website:true,collapsed:false})');
for(const platform of ['darwin','win32']){
 for(const collapsed of [false,true]){
  await js('window.setOptions('+JSON.stringify({platform,collapsed})+')');
  await until('document.querySelector(".sidebar-pinned-web-row .sidebar-website-child-action")');
  assert.equal(await js('document.querySelectorAll(".sidebar-pinned-web-row .sidebar-website-status-action").length'),0);
  if(!collapsed){
   const centers=await js('(()=>{const a=document.querySelector(".sidebar-pinned-web-row .sidebar-website-child-action").getBoundingClientRect();const b=document.querySelector("[data-sidebar-capability-id=mcp-servers]").parentElement.querySelector("button").getBoundingClientRect();return [a.left+a.width/2,b.left+b.width/2]})()');
   assert.ok(Math.abs(centers[0]-centers[1])<1,'Capability and website action centers align: '+centers);
  }
  const count=await js('window.menuRequests.length');
  await js('document.querySelector(".sidebar-pinned-web-row .sidebar-website-child-action").focus();document.querySelector(".sidebar-pinned-web-row .sidebar-website-child-action").click()');
  await until('window.menuRequests.length>'+count);
  const request=await js('window.menuRequests.at(-1)');
  assert.equal(request.target.webKind,'website');assert.equal(request.target.pinned,true);assert.equal(request.target.canClose,true);
  await until('getComputedStyle(document.querySelector(".sidebar-pinned-web-row .sidebar-website-status-dot")).opacity==="1"');
  assert.equal(await js('window.closedWebsites.length'),0);
 }
}
await js('window.setOptions({collapsed:false,websitePinned:false});window.navigate("/webs/website:qa")');
await until('document.querySelector(".sidebar-website-child-row:not(.sidebar-pinned-web-row) .sidebar-website-child-action")');
assert.equal(await js('document.querySelectorAll(".sidebar-website-status-action").length'),0);
const websiteMenuCount=await js('window.menuRequests.length');
await js('document.querySelector(".sidebar-website-child-row .sidebar-website-child-action").focus();document.querySelector(".sidebar-website-child-row .sidebar-website-child-action").click()');
await until('window.menuRequests.length>'+websiteMenuCount);
assert.equal(await js('window.menuRequests.at(-1).target.pinned'),false);
// Selected and focused Website retains its green dot until the row is actually hovered.
win.webContents.sendInputEvent({type:'mouseMove',x:1000,y:700});
await until('getComputedStyle(document.querySelector(".sidebar-website-child-row .sidebar-website-child-action")).opacity==="0"');
await js('document.querySelector(".sidebar-website-child-row").scrollIntoView({block:"center"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const websitePoint=await js('(()=>{const r=document.querySelector(".sidebar-website-child-row").getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+r.height/2)}})()');
win.webContents.sendInputEvent({type:'mouseMove',...websitePoint});
await until('getComputedStyle(document.querySelector(".sidebar-website-child-row .sidebar-website-child-action")).opacity==="1"');
await until('getComputedStyle(document.querySelector(".sidebar-website-child-row .sidebar-website-status-dot")).opacity==="0"');
win.webContents.sendInputEvent({type:'mouseMove',x:1000,y:700});
await until('getComputedStyle(document.querySelector(".sidebar-website-child-row .sidebar-website-child-action")).opacity==="0"');

await until('getComputedStyle(document.querySelector(".sidebar-website-child-row .sidebar-website-status-dot")).opacity==="1"');
assert.equal(await js('window.closedWebsites.length'),0);
console.log('Capability navigation UI smoke passed: '+__dirname);win.destroy();app.quit();})().catch(e=>{console.error(e);app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { env, stdio: "inherit" });
const code = await new Promise((resolve) => child.once("exit", resolve));
process.exitCode = code ?? 1;
