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
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
 await win.loadFile(require('path').join(__dirname,'index.html'));
 const js=s=>win.webContents.executeJavaScript(s),pause=()=>new Promise(r=>setTimeout(r,80));
 for(let i=0;i<40;i++){if(await js('!!document.querySelector(".enterprise-chat-launcher")'))break;await pause()}
 await js('document.querySelector(".enterprise-chat-launcher").click()');await pause();await pause();await pause();
 const rect=()=>js('(()=>{const r=document.querySelector(".enterprise-chat-panel").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
 async function drag(x,y,dx,dy){win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',x:x+dx,y:y+dy,button:'left'});await pause();win.webContents.sendInputEvent({type:'mouseUp',x:x+dx,y:y+dy,button:'left',clickCount:1});await pause()}
 const launcherRect=()=>js('(()=>{const r=document.querySelector(".enterprise-chat-launcher").getBoundingClientRect();return{x:r.x,y:r.y,right:r.right}})()');
 const assertAttached=async()=>{const p=await rect(),b=await launcherRect();assert.ok(Math.abs(b.right-p.x-p.width)<1,'launcher is not aligned to panel');assert.ok(Math.abs(b.y-p.y-p.height-12)<1,'launcher separated from panel')};
 await assertAttached();const buttonBefore=await launcherRect();
 const before=await rect();await drag(Math.round(before.x+160),Math.round(before.y+25),-120,-80);const after=await rect();
 assert.ok(Math.abs(after.x-before.x+120)<1,'header drag did not move panel horizontally: '+JSON.stringify({before,after}));assert.ok(Math.abs(after.y-before.y+80)<1,'header drag did not move panel vertically');
 const buttonAfter=await launcherRect();assert.ok(Math.abs(buttonAfter.x-buttonBefore.x+120)<1&&Math.abs(buttonAfter.y-buttonBefore.y+80)<1,'header drag left launcher behind');await assertAttached();
 await drag(Math.round(buttonAfter.x+18),Math.round(buttonAfter.y+18),-60,-40);const fromLauncher=await rect();assert.ok(Math.abs(fromLauncher.x-after.x+60)<1&&Math.abs(fromLauncher.y-after.y+40)<1,'launcher drag did not move panel');await assertAttached();
 await drag(Math.round(fromLauncher.x+160),Math.round(fromLauncher.y+25),-1200,-1200);const edge=await rect();await assertAttached();assert.ok(edge.x>=12&&edge.y>=12,'panel escaped viewport');
 await drag(Math.round(edge.x+160),Math.round(edge.y+25),1200,1200);
 win.setContentSize(420,650);await pause();const resized=await rect();await assertAttached();assert.ok(resized.x+resized.width<=408&&resized.y+resized.height<=638,'resized panel escaped viewport');
 const close=await js('(()=>{const r=document.querySelector(".enterprise-chat-header button:last-child").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 await drag(close.x,close.y,0,0);await pause();assert.equal(await js('!!document.querySelector(".enterprise-chat-panel")'),false,'close button stopped working');
 console.log('PASS linked header/launcher drag, attached geometry, viewport clamp, resize and close');app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'enterprise-chat-drag-'));
try{await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[path.join(output,'runner.cjs')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'',ENTERPRISE_CHAT_DRAG_PROFILE:profile}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Electron exited '+code)));});}finally{fs.rmSync(profile,{recursive:true,force:true});}
