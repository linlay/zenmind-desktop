import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const output = path.resolve('build/qa/work-panel-new-tab');
fs.mkdirSync(output, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {WorkPanelNewTab} from './src/renderer/work-panel/WorkPanelNewTab';
import './src/renderer/styles/theme.css';
window.calls=[];
function Scene(){
 const [tab,setTab]=useState('a');const [drafts,setDrafts]=useState({a:'',b:''});
 window.selectTab=setTab;
 return <WorkPanelNewTab key={tab} urlDraft={drafts[tab]} onUrlDraftChange={value=>setDrafts(current=>({...current,[tab]:value}))} localOnly={false} projectVisible={true} projectEnabled={true}
 webapps={[{id:'docs',label:'Office Docs'}]} openWebappWindowIds={new Set()}
 websites={[{id:'zen',title:'ZenMind',url:'https://zenmind.example'}]}
 onOpenWeb={url=>window.calls.push(['web',url])} onOpenFiles={async()=>window.calls.push(['files'])}
 onOpenSideChat={()=>window.calls.push(['sideChat'])} onOpenProject={()=>window.calls.push(['project'])}
 onOpenWebapp={app=>window.calls.push(['webapp',app.id])}/>; }
createRoot(document.getElementById('root')).render(<Scene/>);
` }, bundle: true, outfile: path.join(output, 'scene.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))) } });
fs.writeFileSync(path.join(output,'index.html'), '<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>body{margin:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif}#root{position:absolute;inset:0;--work-panel-tab-hover:var(--control-tab-hover-bg)}</style><div id="root"></div><script src="scene.js"></script></html>');
fs.writeFileSync(path.join(output,'runner.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',process.env.NEWTAB_SMOKE_PROFILE);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:780,height:650,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 win.webContents.on('console-message',event=>console.log('renderer:',event.message));
 await win.loadFile(path.join(__dirname,'index.html'));
 const js=code=>win.webContents.executeJavaScript(code);
 for(let i=0;i<100;i++){if(await js('!!document.querySelector("input")'))break;await new Promise(r=>setTimeout(r,30));}
 const change=value=>js('(()=>{const input=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 assert.equal(await js('document.querySelector(".work-panel-new-tab-address").getBoundingClientRect().height'),32);
 assert.equal(await js('document.querySelector(".work-panel-new-tab-tools button").getBoundingClientRect().height'),38);
 assert.equal(await js('document.querySelector(".work-panel-new-tab-address button")'),null);
 await change('draft-a.example/path');await js('window.selectTab("b")');
 await new Promise(r=>setTimeout(r,50));
 assert.equal(await js('document.querySelector("input").value'),'');
 await change('draft-b.example');await js('window.selectTab("a")');
 await new Promise(r=>setTimeout(r,50));
 assert.equal(await js('document.querySelector("input").value'),'draft-a.example/path');
 await change('javascript:alert(1)');await js('document.querySelector("form").requestSubmit()');
 assert.equal(await js('!!document.querySelector("[role=alert]")'),true);assert.equal(await js('window.calls.length'),0);
 await change('example.com');await js('document.querySelector("form").requestSubmit()');
 assert.deepEqual(await js('window.calls[0]'),['web','https://example.com/']);
 await js('document.querySelectorAll(".work-panel-new-tab-tools button")[2].click()');
 assert.deepEqual(await js('window.calls[1]'),['files']);
 assert.equal(await js('document.querySelectorAll(".work-panel-new-tab-tools button")[1].disabled'),true);
 await js('document.querySelectorAll(".work-panel-new-tab-tools button")[3].click()');assert.deepEqual(await js('window.calls[2]'),['sideChat']);
 await js('document.querySelectorAll(".work-panel-new-tab-suggestions button")[1].click()');assert.deepEqual(await js('window.calls[3]'),['webapp','docs']);
 await change('');await new Promise(r=>setTimeout(r,100));
 fs.writeFileSync(path.join(__dirname,'light.png'),(await win.webContents.capturePage()).toPNG());
 await js('document.documentElement.dataset.theme="dark"');await new Promise(r=>setTimeout(r,100));
 fs.writeFileSync(path.join(__dirname,'dark.png'),(await win.webContents.capturePage()).toPNG());
 win.setSize(360,650);await new Promise(r=>setTimeout(r,100));
 assert.equal(await js('getComputedStyle(document.querySelector(".work-panel-new-tab-tools")).gridTemplateColumns.split(" ").length'),1);
 assert.equal(await js('document.querySelector(".work-panel-new-tab").scrollWidth <= innerWidth'),true);
 fs.writeFileSync(path.join(__dirname,'narrow.png'),(await win.webContents.capturePage()).toPNG());
 console.log('PASS: per-tab URL drafts, no address action icons, compact sizing, URL validation, tools, light/dark/narrow layout');win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-new-tab-smoke-'));
try {
 const child = spawn(require('electron'), [path.join(output,'runner.cjs')], { stdio:'inherit', env:{...process.env, NEWTAB_SMOKE_PROFILE:profile, ELECTRON_RUN_AS_NODE:''} });
 const code = await new Promise(resolve=>child.on('exit',resolve));
 if(code !== 0) process.exitCode=1;
} finally { fs.rmSync(profile,{recursive:true,force:true}); }
