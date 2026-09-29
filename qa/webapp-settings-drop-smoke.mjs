// Isolated renderer check: no real app installation or user profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-settings-drop-'));
await build({ stdin: { contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WebappImportDropTarget} from './src/renderer/pages/settings/WebappImportDropTarget';
import './src/renderer/styles/control-center.css';
import './src/renderer/pages/settings/SettingsPage.css';
window.calls=[];window.errors=[];
function App(){const [pending,setPending]=React.useState(false);return <div className="settings-page">
<WebappImportDropTarget pending={pending} onError={message=>errors.push(message)} onImport={async file=>{calls.push(file.name);setPending(true);await new Promise(resolve=>window.finish=resolve);setPending(false);}}>
<div className="page-head"><h1>网页应用</h1></div>
<div className="control-center-shell web-settings-shell">
<aside className="service-sider service-catalog web-settings-catalog"><h2>已安装的网页应用</h2><p>暂无已安装的网页应用。</p></aside>
<article className="control-center-detail web-settings-detail"><input placeholder="配置" /></article>
</div></WebappImportDropTarget></div>}
createRoot(document.getElementById('root')).render(<App/>);
window.drag=(selector,type,names=['app.zip'],directory=false)=>{const data=new DataTransfer();for(const name of names)data.items.add(new File(['fixture'],name));if(directory){const items=Array.from(data.items);Object.defineProperty(items[0],'webkitGetAsEntry',{value:()=>({isDirectory:true})});Object.defineProperty(data,'items',{value:items});}document.querySelector(selector).dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));};
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', __DESKTOP_APP_BRAND__: JSON.stringify(require('../dist-electron/shared/brand.js').APP_BRAND) }, outfile: path.join(root,'fixture.js'), loader: { '.woff': 'dataurl', '.woff2': 'dataurl' } });
fs.writeFileSync(path.join(root,'index.html'), `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}:root{--surface-soft:#242424;--line:#444;--ink:#eee;--ink-soft:#bbb;--accent:#779eff}body{margin:0;padding:16px;background:#181818;color:#eee}h1{margin:0}article{background:#222}</style><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
fs.writeFileSync(path.join(root,'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:780});win.webContents.on("console-message",(_event,level,message)=>{if(level>=2)console.error(message)});const js=code=>win.webContents.executeJavaScript(code);
const until=async code=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout '+code);};
await win.loadFile(path.join(__dirname,'index.html'));await until('!!document.querySelector("aside")');
assert.equal(await js('Math.abs(document.querySelector("aside").getBoundingClientRect().bottom-document.querySelector(".web-settings-shell").getBoundingClientRect().bottom)<2'),true);
for(const selector of ['aside','article','h1']){
 await js('drag('+JSON.stringify(selector)+',"dragenter")');await until('!!document.querySelector(".webapp-import-drop-hint")');
 await js('drag('+JSON.stringify(selector)+',"drop")');await until('document.querySelector("section").getAttribute("aria-busy")==="true"');
 const count=await js('calls.length');await js('drag("article","drop")');assert.equal(await js('calls.length'),count);
 await js('finish()');await until('document.querySelector("section").getAttribute("aria-busy")==="false"');
}
assert.equal(await js('calls.length'),3);
for(const [names,dir] of [[['bad.txt'],false],[['a.zip','b.zip'],false],[['folder.zip'],true]]){
 await js('drag("article","drop",'+JSON.stringify(names)+','+dir+')');
}
assert.equal(await js('errors.length'),3);assert.equal(await js('calls.length'),3);
await js('drag("article","dragenter")');await until('!!document.querySelector(".webapp-import-drop-hint")');
fs.writeFileSync(path.join(__dirname,'drag.png'),(await win.webContents.capturePage()).toPNG());
await js('window.dispatchEvent(new Event("blur"))');await until('!document.querySelector(".webapp-import-drop-hint")');
fs.writeFileSync(path.join(__dirname,'layout.png'),(await win.webContents.capturePage()).toPNG());
win.setSize(700,780);await new Promise(r=>setTimeout(r,100));assert.equal(await js('document.querySelector("aside").getBoundingClientRect().height<=300'),true);
console.log('PASS: full-height catalog, page-wide ZIP drops, busy guard, invalid inputs, cancellation, narrow layout');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[path.join(root,'main.cjs')],{stdio:'inherit',env});
const timer=setTimeout(()=>child.kill(),30000);
const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);
console.log(`Screenshots: ${root}`);process.exitCode=code??1;
