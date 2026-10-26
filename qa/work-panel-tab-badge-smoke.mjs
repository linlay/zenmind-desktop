import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require = createRequire(import.meta.url);
const output = path.resolve('build/qa/work-panel-tab-badge');
fs.mkdirSync(output,{recursive:true});
await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {GlobalOutlined} from '@ant-design/icons';
import {WorkPanelTab} from './src/renderer/work-panel/WorkPanelTab';
import './src/renderer/styles/theme.css';import './src/renderer/styles/app-shell.css';
window.closedTabCounts=[];window.activated=[];
createRoot(document.getElementById('root')).render(<div className="tabs">{[0,1,3,12,50].map((count,index)=><WorkPanelTab key={count}
 title={index===0?'Web':'www.baidu.com/very-long-page-title'} active={true} icon={<GlobalOutlined/>}
 badge={count ? <span className="chat-work-panel-tab-review-count">{count}</span> : undefined}
 onActivate={()=>window.activated.push(count)} onClose={()=>window.closedTabCounts.push(count)} closeLabel="Close tab"/>)}</div>);
`},bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(output,'scene.js')});
fs.writeFileSync(path.join(output,'index.html'),'<html><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>body{margin:0;padding:20px;background:var(--bg-base);font:14px -apple-system,sans-serif}.tabs{display:flex;gap:8px;--chat-work-panel-tab-height:30px;--work-panel-tab-ink:var(--ink);--work-panel-tab-muted:var(--ink-soft);--work-panel-tab-active:var(--control-tab-active-bg);--work-panel-tab-focus:var(--accent)}</style><div id="root"></div><script src="scene.js"></script></html>');
fs.writeFileSync(path.join(output,'runner.cjs'),`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',process.env.TAB_BADGE_SMOKE_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:850,height:180,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await win.loadFile(path.join(__dirname,'index.html'));
 const js=code=>win.webContents.executeJavaScript(code);
 for(let i=0;i<100;i++){if(await js('document.querySelectorAll(".chat-work-panel-tab").length===5'))break;await new Promise(r=>setTimeout(r,30));}
 for(const width of [850,520]){
  win.setSize(width,180);await new Promise(r=>setTimeout(r,100));
  for(const mode of ['light','dark']){
   await js('document.documentElement.dataset.theme='+JSON.stringify(mode));
   const gaps=[];
   for(let i=0;i<5;i++){
    await js('document.querySelectorAll(".chat-work-panel-tab-trigger")['+i+'].focus()');
    await new Promise(r=>setTimeout(r,160));
    const geometry=await js('(()=>{const tab=document.querySelectorAll(".chat-work-panel-tab")['+i+'];const badge=(tab.querySelector(".chat-work-panel-tab-review-count") || tab.querySelector(".chat-work-panel-tab-title")).getBoundingClientRect();const close=tab.querySelector(".chat-work-panel-tab-close").getBoundingClientRect();return {badgeRight:badge.right,closeLeft:close.left,opacity:getComputedStyle(tab.querySelector(".chat-work-panel-tab-close")).opacity}})()');
    gaps.push(geometry.closeLeft-geometry.badgeRight);
    assert.equal(geometry.opacity,'1');
    assert.ok(geometry.badgeRight+3<=geometry.closeLeft,'badge overlaps close hitbox: '+JSON.stringify(geometry));
   }
   assert.ok(Math.max(...gaps)-Math.min(...gaps)<1,'badge and no-badge gaps must match: '+gaps);
   fs.writeFileSync(path.join(__dirname,mode+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
 await js('document.querySelectorAll(".chat-work-panel-tab-close")[3].click()');
 assert.deepEqual(await js('window.closedTabCounts'),[12]);assert.deepEqual(await js('window.activated'),[]);
 console.log('PASS: badge/no-badge spacing matches; 1/3/12/50 annotation badges and close hitboxes are separate in light/dark and narrow tabs; close remains independent');
 win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tab-badge-smoke-'));
try{
 const child=spawn(require('electron'),[path.join(output,'runner.cjs')],{stdio:'inherit',env:{...process.env,TAB_BADGE_SMOKE_PROFILE:profile,ELECTRON_RUN_AS_NODE:''}});
 const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)process.exitCode=1;
}finally{fs.rmSync(profile,{recursive:true,force:true});}
