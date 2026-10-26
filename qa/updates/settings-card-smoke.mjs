import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from '../../scripts/lib/brand-config.mjs';
const require = createRequire(import.meta.url);
const output = path.resolve('build/qa/update-settings');
fs.mkdirSync(output, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ConfigProvider,theme} from 'antd';
import {DesktopUpdateCard} from './src/renderer/updates/DesktopUpdateCard';
import './src/renderer/styles/theme.css';import './src/renderer/pages/settings/SettingsPage.css';
let snapshot={phase:'current',currentVersion:'0.5.10',progress:0,autoDownload:false,canInstall:true};
const listeners=new Set();window.calls=[];
window.electronAPI={updates:{getState:async()=>snapshot,onChanged:f=>{listeners.add(f);return()=>listeners.delete(f)},check:async()=>window.calls.push('check'),download:async()=>window.calls.push('download'),install:async()=>window.calls.push('install'),setAutoDownload:async value=>{window.calls.push('auto:'+value);window.showState({...snapshot,autoDownload:value},document.documentElement.dataset.theme)}}};
const root=createRoot(document.getElementById('root'));
window.showState=(value,mode)=>{snapshot=value;document.documentElement.dataset.theme=mode;listeners.forEach(f=>f(value));root.render(<ConfigProvider theme={{algorithm:mode==='dark'?theme.darkAlgorithm:theme.defaultAlgorithm,token:{fontFamily:'-apple-system,BlinkMacSystemFont,sans-serif',colorPrimary:'#2663eb',fontSize:13,borderRadius:6}}}><div className="settings-page"><DesktopUpdateCard/></div></ConfigProvider>)};
window.showState(snapshot,'light');
` }, bundle: true, jsx: 'automatic', outfile: path.join(output,'scene.js'), define: { 'process.env.NODE_ENV': '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(),resolveBrandId()))) } });
fs.writeFileSync(path.join(output,'index.html'),'<html><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>body{margin:0;padding:24px;background:var(--bg-base);color:var(--ink);font:13px -apple-system,sans-serif}.settings-page{max-width:700px;margin:auto}</style><div id="root"></div><script src="scene.js"></script></html>');
fs.writeFileSync(path.join(output,'runner.cjs'),`
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
app.setPath('userData',process.env.UPDATE_SETTINGS_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:800,height:300,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'index.html'));
 const js=s=>win.webContents.executeJavaScript(s),pause=()=>new Promise(r=>setTimeout(r,70));
 const base={currentVersion:'0.5.10',progress:42,autoDownload:false,canInstall:true};
 const cases=['disabled','not-configured','idle','checking','current','unavailable','available','downloading','verifying','ready','installing','error'];
 let checked=0;
 for(const mode of ['light','dark'])for(const width of [800,420,320]){
  win.setContentSize(width,300);
  for(const phase of cases){
   const state={...base,phase,...(['available','downloading','verifying','ready','installing','unavailable'].includes(phase)?{version:'0.5.11'}:{}),...(phase==='error'?{error:'checkFailed'}:{})};
   await js('window.showState('+JSON.stringify(state)+','+JSON.stringify(mode)+')');await pause();
   const geometry=await js("(()=>{const card=document.querySelector('[data-update-phase]'),action=card.querySelector('.desktop-update-actions'),content=card.querySelector('.desktop-update-content'),r=card.getBoundingClientRect(),a=action?.getBoundingClientRect(),c=content.getBoundingClientRect();return{phase:card.dataset.updatePhase,overflow:document.documentElement.scrollWidth>innerWidth,version:card.querySelector('.desktop-update-version')?.textContent??'',status:card.querySelector('.desktop-update-status')?.textContent??'',buttonOutside:a&&(a.right>r.right||a.bottom>r.bottom),overlap:a&&!(a.left>=c.right||a.top>=c.bottom),preference:!!card.querySelector('.desktop-update-preference')}})()");
   assert.equal(geometry.phase,phase);assert.equal(geometry.overflow,false);assert.equal(Boolean(geometry.buttonOutside),false);assert.equal(Boolean(geometry.overlap),false);assert.equal(geometry.version,state.version?'v'+state.version:'');if(phase==='error')assert.equal(geometry.status,'');assert.equal(geometry.preference,phase!=='disabled');checked++;
   await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   if(['current','error','downloading','ready'].includes(phase)&&[800,320].includes(width))fs.writeFileSync(path.join(__dirname,mode+'-'+width+'-'+phase+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
 await js('window.showState('+JSON.stringify({...base,phase:'current'})+',"light")');await pause();
 await js('document.querySelector(".desktop-update-actions button").click();document.querySelector(".ant-switch").click()');await pause();
 assert.deepEqual(await js('window.calls'),['check','auto:true']);
 await js('window.showState('+JSON.stringify({...base,phase:'available',version:'0.5.11'})+',"light")');await pause();await js('document.querySelector(".desktop-update-actions button").click()');await pause();assert.ok((await js('window.calls')).includes('download'));
 console.log('PASS '+checked+' update state/theme/width layouts; check, download and preference controls');app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'update-settings-'));
try{await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[path.join(output,'runner.cjs')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'',UPDATE_SETTINGS_PROFILE:profile}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Electron exited '+code)));});}finally{fs.rmSync(profile,{recursive:true,force:true});}
