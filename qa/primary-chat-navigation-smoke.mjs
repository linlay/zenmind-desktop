// Actual AppSidebar + Electron Chromium; native services are deterministic fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const repo = process.cwd();
const output = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-primary-navigation-"));
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {AppSidebar} from './src/renderer/app-shell/navigation/AppSidebar';
import {PrimaryChatNavigationDebugSetting} from './src/renderer/pages/settings/PrimaryChatNavigationDebugSetting';
import {RendererI18nContext} from './src/renderer/i18n/i18n-context';
import {createTranslator} from './src/shared/i18n';
import './src/renderer/styles.css';
window.electronAPI={assistant:{getProjectCreationOptions:async()=>({ok:false,message:'fixture'})}};
const epoch=1793000000000;
const chat=(id,agentKey,patch={})=>({chatId:id,chatName:id,agentKey,createdAt:epoch,updatedAt:epoch,lastRunId:'r',lastRunContent:'最新回复摘要',isRead:true,readRunId:'',hasActiveRun:false,hasPendingAwaiting:false,...patch});
const agents=Array.from({length:18},(_,i)=>({agentKey:'agent-'+i,displayName:['普通助理','编程项目','知识库','协作团队','执行器','代理'][i%6]+' '+i,mode:['GENERAL','CODER','KBASE','TEAM','EXECUTOR','PROXY'][i%6],workspaceDir:'/fixture/project-'+i,role:'',recentChats:[chat('recent-'+i,'agent-'+i)],projectChats:[chat('recent-'+i,'agent-'+i)],primaryChat:i===1?undefined:chat('primary-'+i,'agent-'+i,{hasActiveRun:i===2,hasPendingAwaiting:i===3,isRead:i!==4}),chatCount:1,unreadCount:0,unreadChatCount:0,hasPendingAwaiting:false,latestChatId:'recent-'+i,latestPreview:'preview'}));
window.qa={routes:[],histories:[],orders:[],set:null,state:null};
function Fixture(){
 const [options,setOptions]=useState({primary:false,collapsed:false,windows:false,fullScreen:false,error:''});
 const [route,setRoute]=useState('/agent/agent-0?chatId=primary-0');
 window.qa.set=patch=>setOptions(old=>({...old,...patch}));window.qa.state=options;
 const navigate=target=>{window.qa.routes.push(target);setRoute(target);return true;};
 return <div className={'app-shell '+(options.windows?'is-windows-platform':'is-mac-platform')} style={{display:'flex',height:'100vh',width:'100%',background:'var(--bg-base)','--app-sidebar-width':options.collapsed?'64px':'264px'}}>
 <div className='app-sidebar-shell' style={{width:options.collapsed?64:264,height:'100%',minHeight:0,flex:'none'}}><AppSidebar
 isCollapsed={options.collapsed} isMac={!options.windows} isWindows={options.windows}
 currentPathname={route.split('?')[0]} currentRoute={route} primaryChatNavigation={options.primary} primaryChatNavAgents={agents} primaryChatNavError={options.error}
 sidebarNavOrder={['new-chat','chats','group:assistants','group:webs']} onSidebarNavOrderChange={order=>window.qa.orders.push(order)}
 webItems={[]} assistantNavAgents={agents} chatNavAgentOptions={agents} chatDefaultAgentKey='agent-0'
 assistantNavChatItems={[chat('ordinary','agent-0')]} assistantPinnedChatItems={[chat('pinned','agent-0')]}
 assistantNavAgentsLoaded assistantChatPinningSupported assistantChatOrderingSupported
 onOpenChatHistory={key=>window.qa.histories.push(key||'all')} onShareChat={()=>{}}
 onRequestNavigate={navigate} onRequestAgentChatNavigate={navigate}
 onToggleCollapsed={()=>setOptions(old=>({...old,collapsed:!old.collapsed}))}
 toolMenuOpen={false} onRequestToolMenuOpen={()=>{}} onAutoOpenToolMenu={()=>{}} onCloseToolMenu={()=>{}}
 /></div><main style={{flex:1,padding:30}}><PrimaryChatNavigationDebugSetting enabled={options.primary} onChange={primary=>setOptions(old=>({...old,primary}))}/><input id='fixture-draft' defaultValue='keep draft'/><div id='fixture-guest' data-instance='stable'>Chat surface</div></main></div>;
}
createRoot(document.getElementById('root')).render(<RendererI18nContext.Provider value={{locale:'zh-CN',source:'user',t:createTranslator('zh-CN'),setLocale:async()=>{}}}><MemoryRouter><Fixture/></MemoryRouter></RendererI18nContext.Provider>);
`;
await build({ stdin: { contents: source, resolveDir: repo, loader: "tsx" }, outfile: path.join(output,"app.js"), bundle:true, platform:"browser", jsx:"automatic", loader:{".svg":"file",".png":"file",".woff2":"file"}, define:{"process.env.NODE_ENV":'"development"', __DESKTOP_APP_BRAND__:JSON.stringify(APP_BRAND)} });
fs.writeFileSync(path.join(output,"index.html"), '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
const checker = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const output=process.env.PRIMARY_NAVIGATION_QA_DIR;
app.setPath('userData',path.join(output,'profile'));
const errors=[];
const server=http.createServer((request,response)=>{const name=path.basename(new URL(request.url,'http://localhost').pathname)||'index.html';const file=path.join(output,name);response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html');if(!fs.existsSync(file)){response.writeHead(404);response.end();return;}response.end(fs.readFileSync(file));});
let win;const js=code=>win.webContents.executeJavaScript(code);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(code){for(let n=0;n<150;n++){try{if(await js(code))return;}catch{}await delay(20);}throw Error('Timed out: '+code);}
const click=selector=>js('document.querySelector('+JSON.stringify(selector)+').click()');
(async()=>{await app.whenReady();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
win.webContents.on('render-process-gone',(_event,details)=>console.error('Renderer exited:',details));
win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
await win.loadURL('http://127.0.0.1:'+server.address().port);
win.webContents.debugger.attach('1.3');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await until('!!document.querySelector(".sidebar-new-chat-button")');
assert.equal(await js('window.qa.state.primary'),false);
assert.equal(await js('document.querySelector(".primary-chat-mode-toggle")'),null);
await js('document.querySelector(".app-sidebar-shell").style.width="160px";document.querySelector(".app-shell").style.setProperty("--app-sidebar-width","160px")');
assert.equal(await js('(()=>{const outer=document.querySelector(".app-sidebar").getBoundingClientRect();return [...document.querySelectorAll(".sidebar-top-actions button")].every(button=>{const rect=button.getBoundingClientRect();return rect.left>=outer.left&&rect.right<=outer.right;});})()'),true);
await js('document.querySelector(".app-sidebar-shell").style.width="264px";document.querySelector(".app-shell").style.setProperty("--app-sidebar-width","264px")');
await js('document.querySelector("#fixture-draft").value="untouched draft"');
await delay(80);fs.writeFileSync(path.join(output,'standard.png'),(await win.webContents.capturePage()).toPNG());
if(await js('document.querySelector("[data-sidebar-group-id=assistants]").getAttribute("aria-expanded")!=="true"')) await click('[data-sidebar-group-id="assistants"]');
await delay(250);
await until('!!document.querySelector(".assistant-worker-header")');
const expanded=await js('document.querySelector("[data-sidebar-group-id=assistants]").getAttribute("aria-expanded")');
// The real header and name are the interaction region, not just the SVG.
await until('document.querySelector(".assistant-worker-header [data-pointer-resting]")!==null');
const clocks=await js('[...document.querySelectorAll(".assistant-worker-header [data-pointer-resting]")].slice(0,4).map(root=>({period:parseFloat(root.style.getPropertyValue("--agent-idle-period")),delay:parseFloat(root.style.getPropertyValue("--agent-idle-delay"))}))');
assert.equal(clocks.length,4);for(const clock of clocks){assert.ok(clock.period>=22&&clock.period<32);assert.ok(clock.delay>=0&&clock.delay<7);}assert.ok(new Set(clocks.map(clock=>clock.period)).size>1);
assert.equal(await js('(()=>{const motion=document.querySelector(".assistant-worker-header [data-agent-motion]");const animation=motion.getAnimations()[0];if(!animation)return false;animation.pause();const timing=animation.effect.getTiming();animation.currentTime=timing.delay+timing.duration*.9;return getComputedStyle(motion).transform!=="none"&&getComputedStyle(motion).transform!=="matrix(1, 0, 0, 1, 0, 0)";})()'),true);
await js('(()=>{const name=document.querySelector(".assistant-worker-name");const r=name.getBoundingClientRect();name.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerType:"mouse",clientX:r.left+30,clientY:r.top+5}));})()');
await until('document.querySelector(".assistant-worker-header [data-agent-avatar]").dataset.pointerMood!=="rest"');
assert.equal(await js('document.querySelectorAll(".assistant-worker-header [data-agent-avatar]")[1].dataset.pointerMood'), 'rest');
assert.ok(await js('document.querySelector(".assistant-worker-header [data-agent-motion]").style.transform'));
await js('window.dispatchEvent(new Event("blur"))');
assert.equal(await js('document.querySelector(".assistant-worker-header [data-agent-avatar]").dataset.pointerResting'),'true');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
await delay(80);
assert.equal(await js('document.querySelector(".assistant-worker-header [data-agent-motion]").getAnimations().length'),0);
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await delay(80);
await js('document.querySelector(".sidebar-nav").scrollTop=160');await delay(40);
const scroll=await js('document.querySelector(".sidebar-nav").scrollTop');
assert.ok(scroll>0,'fixture must exercise actual sidebar scrolling');
await js('window.qa.standardNode=document.querySelector(".sidebar-new-chat-button")');
await click('[role="switch"][aria-labelledby="primary-chat-navigation-label"]');await until('document.querySelectorAll(".primary-chat-item").length===18');
assert.equal(await js('document.querySelector(".sidebar-new-chat-button").getBoundingClientRect().height'),0);
assert.equal(await js('window.qa.routes.length'),0);
assert.equal(await js('(()=>{const dot=document.querySelector(".primary-chat-status .assistant-worker-unread-dot");return dot.getBoundingClientRect().width===8&&getComputedStyle(dot).opacity==="1";})()'),true);
await js('document.querySelector(".primary-chat-item").focus();document.querySelector(".primary-chat-item").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
assert.equal(await js('document.activeElement.dataset.sidebarNavId'),'primary:agent-1');
await click('.primary-chat-row:nth-child(2) .primary-chat-item');await until('window.qa.routes.length>0');
assert.equal(await js('window.qa.routes.at(-1)'),'/agent/agent-0?chatId=primary-0');
await click('.primary-chat-row:nth-child(3) .primary-chat-item');
assert.match(await js('window.qa.routes.at(-1)'),/^\\/agent\\/agent-1\\?newChat=\\d{13}&primaryNewChat=true$/);
await click('.primary-chat-history');assert.equal(await js('window.qa.histories.at(-1)'),'agent-0');
await js('window.qa.set({collapsed:true})');await until('!!document.querySelector(".primary-chat-navigation.is-collapsed")');
await click('.primary-chat-item');assert.equal(await js('window.qa.routes.at(-1)'),'/agent/agent-0?chatId=primary-0');
await js('window.qa.set({collapsed:false})');await until('!document.querySelector(".primary-chat-navigation.is-collapsed")');
await click('[role="switch"][aria-labelledby="primary-chat-navigation-label"]');await until('!document.querySelector(".primary-chat-navigation")');
assert.equal(await js('document.querySelector(".sidebar-new-chat-button").getBoundingClientRect().height>0'),true);
assert.equal(await js('document.querySelector("[data-sidebar-group-id=assistants]").getAttribute("aria-expanded")'),expanded);
try { await until('document.querySelector(".sidebar-nav").scrollTop==='+scroll); } catch(error) { console.error('Scroll restoration:',{expected:scroll,actual:await js('document.querySelector(".sidebar-nav").scrollTop')});throw error; }
assert.equal(await js('document.querySelector(".sidebar-nav").scrollTop'),scroll);
assert.equal(await js('document.querySelector("#fixture-draft").value'),'untouched draft');
assert.equal(await js('window.qa.standardNode===document.querySelector(".sidebar-new-chat-button")'),true);
assert.equal(await js('document.querySelector("#fixture-guest").dataset.instance'),'stable');
assert.deepEqual(await js('window.qa.orders'),[]);
await js('window.qa.set({primary:true})');await until('!!document.querySelector(".primary-chat-navigation")');
await js('document.querySelector(".sidebar-nav").scrollTop=0');
for(const theme of ['light','dark']){await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await delay(80);fs.writeFileSync(path.join(output,theme+'.png'),(await win.webContents.capturePage()).toPNG());}
// Both Windows branches keep the primary mode entry exclusively in Debug settings.
await js('window.qa.set({windows:true,fullScreen:false})');await until('document.querySelector(".app-shell.is-windows-platform")!==null');
assert.equal(await js('!!document.querySelector(".sidebar-chrome")'),false);
await js('window.qa.set({fullScreen:true})');await until('window.qa.state.fullScreen===true');
assert.equal(await js('document.querySelector(".primary-chat-mode-toggle")'),null);
await click('[role="switch"][aria-labelledby="primary-chat-navigation-label"]');await until('!document.querySelector(".primary-chat-navigation")');
assert.equal(await js('document.querySelector(".sidebar-new-chat-button").getBoundingClientRect().height>0'),true);
assert.deepEqual(errors,[]);
console.log(JSON.stringify({ok:true,checks:['standard default','primary open and create intent','history','collapsed navigation','original expanded state and scroll','draft and guest retained','no order writes','light/dark','Windows/fullscreen branches','Debug-only switch','independent idle clocks','row hover and pointer reset','reduced motion'],output},null,2));
win.destroy();server.close();app.quit();})().catch(error=>{console.error(error);if(win)win.destroy();server.close();app.exit(1);});
`;
fs.writeFileSync(path.join(output,"checks.cjs"), checker);
const env={...process.env,PRIMARY_NAVIGATION_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require("electron"),[path.join(output,"checks.cjs")],{env,stdio:"inherit"});
process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});
