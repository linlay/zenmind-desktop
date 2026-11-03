import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from '../scripts/lib/brand-config.mjs';
const require = createRequire(import.meta.url);
const output = path.resolve('build/qa/enterprise-chat-drag');
fs.mkdirSync(output, { recursive: true });
await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {EnterpriseChatFloatingPanel} from './src/renderer/enterprise-chat/EnterpriseChatFloatingPanel';
import './src/renderer/styles/theme.css';import './src/renderer/styles/enterprise-chat.css';
const user={id:'self',displayName:'测试员工',email:'',avatarUrl:'',kind:'employee',online:true};
const state={enabled:true,connectionState:'connected',message:'',serverUrl:'https://fixture.invalid',currentUser:user,selfProfile:{motto:'',avatarDataUrl:'',hasCustomAvatar:false},users:[user],conversations:[],activeMessages:[],activeConversationId:'',latestEventId:0};
window.refreshCalls=0;window.electronAPI={enterpriseChat:{getState:async()=>state,refresh:async()=>{window.refreshCalls++;return state},onStateChanged:()=>()=>{}}};
createRoot(document.getElementById('root')).render(<EnterpriseChatFloatingPanel desktopSsoStatus={{authenticated:true,completedSteps:{session:true,userInfo:true,accessToken:true}}}/>);
`},bundle:true,jsx:'automatic',outfile:path.join(output,'scene.js'),define:{'process.env.NODE_ENV':'"production"',__DESKTOP_APP_BRAND__:JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(),resolveBrandId())))}});
fs.writeFileSync(path.join(output,'index.html'),"<html><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"scene.css\"><style>*{box-sizing:border-box}body{margin:0;background:var(--bg-base);font:13px -apple-system,sans-serif}</style><div id=\"root\"></div><script src=\"scene.js\"></script></html>");
fs.writeFileSync(path.join(output,'runner.cjs'),`
const {app,BrowserWindow}=require('electron'),assert=require('assert/strict');
app.setPath('userData',process.env.ENTERPRISE_CHAT_DRAG_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:800,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const errors=[];
 win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});
 await win.loadFile(require('path').join(__dirname,'index.html'));
 const js=s=>win.webContents.executeJavaScript(s),pause=()=>new Promise(r=>setTimeout(r,80));
 for(let i=0;i<40;i++){if(await js('!!document.querySelector(".enterprise-chat-launcher")'))break;await pause()}
 await js('document.querySelector(".enterprise-chat-launcher").click()');await pause();await pause();await pause();
 const rect=()=>js('(()=>{const r=document.querySelector(".enterprise-chat-panel").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
 async function drag(x,y,dx,dy){const v=await js('({width:innerWidth,height:innerHeight})'),endX=Math.max(0,Math.min(x+dx,v.width-1)),endY=Math.max(0,Math.min(y+dy,v.height-1));win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',x:endX,y:endY,modifiers:['leftButtonDown']});await pause();win.webContents.sendInputEvent({type:'mouseUp',x:endX,y:endY,button:'left',clickCount:1});await pause()}
 const launcherRect=()=>js('(()=>{const r=document.querySelector(".enterprise-chat-launcher").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}})()');
 const assertAttached=async()=>{const p=await rect(),b=await launcherRect();assert.ok(Math.abs(b.right-p.x-p.width)<1,'launcher is not aligned to panel');assert.ok(Math.abs(b.y-p.y-p.height-12)<1,'launcher separated from panel')};
 const assertVisible=async()=>{const p=await rect(),b=await launcherRect(),v=await js('({width:innerWidth,height:innerHeight})');assert.ok(p.x>=11&&p.y>=11&&p.x+p.width<=v.width-11&&p.y+p.height<=v.height-11,'panel escaped viewport: '+JSON.stringify({p,v}));assert.ok(p.x+p.width<=b.x||b.right<=p.x||p.y+p.height<=b.y||b.y+b.height<=p.y,'panel covers launcher: '+JSON.stringify({p,b}));assert.ok(await js('(()=>{const b=document.querySelector(".enterprise-chat-launcher"),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()'),'launcher is not clickable')};
 const assertStableToggle=async()=>{const before=await launcherRect(),wasOpen=await js('!!document.querySelector(".enterprise-chat-panel")');await drag(Math.round(before.x+before.width/2),Math.round(before.y+before.height/2),0,0);await pause();await pause();await pause();assert.deepEqual(await launcherRect(),before,'opening or closing moved launcher');assert.equal(await js('!!document.querySelector(".enterprise-chat-panel")'),!wasOpen,'launcher click did not toggle panel');if(!wasOpen)await assertVisible()};
 await assertAttached();const buttonBefore=await launcherRect();
 const before=await rect();await drag(Math.round(before.x+160),Math.round(before.y+25),-120,-80);const after=await rect();
 assert.ok(Math.abs(after.x-before.x+120)<1,'header drag did not move panel horizontally: '+JSON.stringify({before,after}));assert.ok(Math.abs(after.y-before.y+80)<1,'header drag did not move panel vertically');
 const buttonAfter=await launcherRect();assert.ok(Math.abs(buttonAfter.x-buttonBefore.x+120)<1&&Math.abs(buttonAfter.y-buttonBefore.y+80)<1,'header drag left launcher behind');await assertAttached();
 await drag(Math.round(buttonAfter.x+18),Math.round(buttonAfter.y+18),-60,-40);const fromLauncher=await rect();assert.ok(Math.abs(fromLauncher.x-after.x+60)<1&&Math.abs(fromLauncher.y-after.y+40)<1,'launcher drag did not move panel');await assertAttached();
 await drag(Math.round(fromLauncher.x+160),Math.round(fromLauncher.y+25),-1200,-1200);const edge=await rect();await assertVisible();await assertStableToggle();await assertStableToggle();
 await drag(Math.round(edge.x+160),Math.round(edge.y+25),1200,1200);
 win.setContentSize(420,650);await pause();await assertVisible();await assertStableToggle();await assertStableToggle();
 const close=await js('(()=>{const r=document.querySelector(".enterprise-chat-header button:last-child").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 await drag(close.x,close.y,0,0);await pause();assert.equal(await js('!!document.querySelector(".enterprise-chat-panel")'),false,'close button stopped working');
 for(const size of [{width:900,height:800},{width:420,height:650}]){
  win.setContentSize(size.width,size.height);await pause();
  const points=[{x:12,y:12},{x:size.width-50,y:12},{x:12,y:size.height-50},{x:size.width-50,y:size.height-50},{x:Math.round(size.width/2),y:Math.round(size.height/2)}];
  for(const position of points){
   await js('localStorage.setItem("zenmind.enterpriseChat.launcherPosition.v1",'+JSON.stringify(JSON.stringify(position))+')');
   await win.loadFile(require('path').join(__dirname,'index.html'));
   for(let i=0;i<40;i++){if(await js('!!document.querySelector(".enterprise-chat-launcher")'))break;await pause()}
   const capture=size.width===900&&position.x===Math.round(size.width/2);
   if(capture)require('fs').writeFileSync(require('path').join(__dirname,'launcher-closed.png'),(await win.webContents.capturePage()).toPNG());
   await assertStableToggle();
   if(capture)require('fs').writeFileSync(require('path').join(__dirname,'launcher-open.png'),(await win.webContents.capturePage()).toPNG());
   await assertStableToggle();
   assert.deepEqual(await js('JSON.parse(localStorage.getItem("zenmind.enterpriseChat.launcherPosition.v1"))'),position,'toggle rewrote saved position');
  }
 }
 assert.deepEqual(errors,[],'renderer console errors');
 console.log('PASS linked header/launcher drag, stable open/close at corners and center, visible panel, resize and close');app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'enterprise-chat-drag-'));
try{await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[path.join(output,'runner.cjs')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'',ENTERPRISE_CHAT_DRAG_PROFILE:profile}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Electron exited '+code)));});}finally{fs.rmSync(profile,{recursive:true,force:true});}
