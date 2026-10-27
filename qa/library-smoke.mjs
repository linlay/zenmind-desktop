// Render the real Library page in an isolated Electron profile with deterministic API fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-library-'));
const { APP_BRAND } = require('../dist-electron/shared/brand.js');
const source = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import { ArtifactManagementPage } from './src/renderer/pages/artifact-management/ArtifactManagementPage';
import { LibraryDeleteNotice } from './src/renderer/app-shell/history/LibraryDeleteNotice';
import { RendererI18nContext } from './src/renderer/i18n/i18n-context';
import { createTranslator } from './src/shared/i18n';
import './src/renderer/styles.css';
const names=['Annual report.docx','Landscape.png','Dashboard.html','Dataset.xlsx','Source project.zip','Demo.mp4','Archive report.pdf','Legacy.txt','Conflicting.txt'];
const categories=['document','image','web','document','archive','media','document','document','document'];
const mimes=['application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','text/html','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/zip','video/mp4','application/pdf','text/plain','text/plain'];
const data=names.map((name,index)=>({chatId:'chat-'+index,runId:index===7?'':'run-'+index,artifactId:'artifact-'+index,name,mimeType:mimes[index],sizeBytes:123456,sha256:'a'.repeat(64),pushedAt:1800000000000+index,category:categories[index],favorite:index===1,tags:index<3?['Research']:[],contentState:index===7?'unresolved':index===8?'ambiguous':'ready',sourceState:index===6?'archived':'active',accessState:'available',chatName:'Research conversation '+index,agentKey:'agent'}));
let sync={phase:'partial',completed:9,total:9,failed:1,denied:1};
const listeners=new Set();const notify=()=>listeners.forEach(fn=>fn());
window.qa={views:[],actions:[],patches:[],queries:[],syncs:0};
window.electronAPI={settings:{getPlatform:async()=>window.qa.platform||'darwin'},assistant:{getChatInfo:async chatId=>({chatId,agentKey:'agent'})},artifacts:{
 list:async input=>{window.qa.queries.push(input);let items=data.filter(item=>(!input.chatId||item.chatId===input.chatId)&&(!input.category||item.category===input.category)&&(!input.favoritesOnly||item.favorite)&&(!input.tag||item.tags.includes(input.tag))&&(!input.search||item.name.toLowerCase().includes(input.search.toLowerCase())));return {records:structuredClone(items.slice(input.offset||0,(input.offset||0)+(input.limit||50))),total:items.length,tags:[...new Set(data.flatMap(item=>item.tags))],sync:{...sync}};},
 organize:async input=>{window.qa.patches.push(input);Object.assign(data.find(item=>item.chatId===input.chatId&&item.runId===input.runId&&item.artifactId===input.artifactId),input);notify();},
 onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 sync:async()=>{window.qa.syncs++;sync={...sync,phase:'syncing'};setTimeout(()=>{sync={...sync,phase:'complete',failed:0,denied:0};notify();},150);return {...sync};},
 act:async input=>{window.qa.actions.push(input);return {ok:true,agentKey:'agent',relativePath:'artifacts/'+input.runId+'/'+data.find(item=>item.chatId===input.chatId).name};}
}};
function Fixture(){const [locale,setLocale]=useState('zh-CN'),[dark,setDark]=useState(false),[instance,setInstance]=useState(0);
 window.qa.setLocale=setLocale;window.qa.setDark=value=>{document.documentElement.dataset.theme=value?'dark':'light';setDark(value);};window.qa.remount=()=>setInstance(value=>value+1);
 return <ConfigProvider theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm}}><RendererI18nContext.Provider value={{locale,source:'user',t:createTranslator(locale),setLocale:async()=>{}}}>
 <ArtifactManagementPage key={instance} onView={request=>{window.qa.views.push(request);return true;}} onOpenChat={()=>{}}/>
 <div style={{display:'none'}}><LibraryDeleteNotice chatId='chat-1'/></div>
 </RendererI18nContext.Provider></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' }, outfile: path.join(output, 'app.js'), bundle: true, platform: 'browser', jsx: 'automatic', loader: { '.svg': 'file', '.png': 'file', '.woff2': 'file' }, define: { 'process.env.NODE_ENV': '"development"', __DESKTOP_APP_BRAND__: JSON.stringify(APP_BRAND) } });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
const checker = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const output=process.env.LIBRARY_QA_DIR;app.setPath('userData',path.join(output,'profile'));
const errors=[];
const server=http.createServer((req,res)=>{const name=path.basename(new URL(req.url,'http://localhost').pathname)||'index.html';const file=path.join(output,name);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.end(fs.readFileSync(file));});
let win;const js=code=>win.webContents.executeJavaScript(code),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(code){for(let i=0;i<150;i++){if(await js(code))return;await delay(20);}throw Error('Timed out: '+code);}
const click=selector=>js('document.querySelector('+JSON.stringify(selector)+').click()');
(async()=>{await app.whenReady();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1280,height:820,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 await win.loadURL('http://127.0.0.1:'+server.address().port);
 await until('document.querySelectorAll("tbody tr").length===9');
 assert.equal(await js('document.querySelector("h1").textContent'),'资料库');
 assert.equal(await js('document.querySelectorAll("tbody tr:nth-child(7) .artifact-management-actions button[disabled]").length'),2);
 assert.equal(await js('document.querySelectorAll("tbody tr:nth-child(8) .artifact-management-actions button[disabled]").length'),2);
 await delay(120);fs.writeFileSync(path.join(output,'light.png'),(await win.webContents.capturePage()).toPNG());
 await click('tbody tr:first-child .artifact-management-star');await until('window.qa.patches.length===1');
 assert.equal(await js('document.querySelector("tbody tr:first-child .artifact-management-star").getAttribute("aria-pressed")'),'true');
 await click('.artifact-management-filters button');await until('document.querySelectorAll("tbody tr").length===2');
 await click('.artifact-management-filters button');await until('document.querySelectorAll("tbody tr").length===9');
 await js('document.querySelector(".artifact-management-filters .ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
 await until('document.querySelectorAll(".ant-select-item-option").length>0');
 await js('[...document.querySelectorAll(".ant-select-item-option")].find(e=>e.textContent==="图片").click()');
 await until('document.querySelectorAll("tbody tr").length===1');assert.equal(await js('window.qa.queries.at(-1).category'),'image');
 await click('tbody tr .artifact-management-name');await until('document.querySelector(".ant-modal-body")!==null');
 await js('document.querySelector(".artifact-management-tag-editor input").focus()');
 await win.webContents.insertText('Approved');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await until('document.querySelectorAll(".artifact-management-tag-editor .ant-select-selection-item").length===2');
 await click('.ant-modal-body button.artifact-management-button');await until('window.qa.patches.length===2');
 assert.deepEqual(await js('window.qa.patches.at(-1).tags'),['Research','Approved']);
 await click('.ant-modal-close');await delay(350);
 await click('tbody tr .artifact-management-actions button');await until('window.qa.views.length===1');
 assert.equal(await js('window.qa.actions.at(-1).runId'),'run-1');
 await click('.artifact-management-header button');await until('window.qa.syncs===1');await until('document.querySelector(".artifact-management-sync").textContent.includes("同步完成")');
 await js('window.qa.setLocale("en-US");window.qa.setDark(true)');await until('document.querySelector("h1").textContent==="Library"');
 await delay(120);fs.writeFileSync(path.join(output,'dark.png'),(await win.webContents.capturePage()).toPNG());
 win.setContentSize(680,700);await delay(100);
 assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth'),true);
 fs.writeFileSync(path.join(output,'narrow.png'),(await win.webContents.capturePage()).toPNG());
 await js('window.qa.platform="win32";window.qa.remount()');await until('document.querySelectorAll("tbody tr").length===9');
 await click('tbody tr:first-child .artifact-management-extra-menu');await until('document.querySelector(".ant-dropdown-menu")!==null');
 assert.equal(await js('document.querySelector(".ant-dropdown-menu").textContent.includes("Show in File Explorer")'),true);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'passed'),'ok');
 console.log(JSON.stringify({ok:true,checks:['real Library component','source restrictions','favorite toggle and filtering','MIME filtering','tag editing','Run identity on view','manual sync','Chinese/English','light/dark','narrow viewport','Windows file manager label'],output},null,2));
 win.destroy();server.close();app.quit();
})().catch(error=>{console.error(error);if(win)win.destroy();server.close();app.exit(1);});
`;
fs.writeFileSync(path.join(output, 'checks.cjs'), checker);
const env = { ...process.env, LIBRARY_QA_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(output, 'checks.cjs')], { env, stdio: 'inherit' });
process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
if (process.exitCode === 0 && !fs.existsSync(path.join(output, 'passed'))) throw new Error('Electron exited before completing QA: ' + output);
