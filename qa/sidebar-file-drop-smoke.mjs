// Isolated renderer smoke test; no Desktop profile, services, or installation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-file-drop-"));
await build({
  stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {SidebarFileDropTarget} from './src/renderer/app-shell/navigation/SidebarFileDropTarget';
    import './src/renderer/styles/navigation.css';
    window.calls=[];
    const receive=zone=>async file=>{window.calls.push({zone,name:file.name});await new Promise(r=>window.finish=r);};
    createRoot(document.getElementById('root')).render(<div className="app-sidebar-shell" style={{height:520,width:240,minWidth:0}}>
      <SidebarFileDropTarget className="app-sidebar" enabled projectDisabled={false} webappDisabled={false}
        onWebapp={receive('webapp')} onProject={receive('project')}><nav>Navigation</nav></SidebarFileDropTarget>
    </div>);
    window.drag=(selector,type,names=['sample.zip'],protectedType)=>{
      const data=new DataTransfer();
      const items=names.map(name=>{
        const item=data.items.add(new File(['fixture'],name));
        Object.defineProperty(item,'webkitGetAsEntry',{value:()=>protectedType !== undefined ? null : ({name,isDirectory:name==='project folder'||name==='folder.zip',isFile:name!=='project folder'&&name!=='folder.zip'})});
        return item;
      });
      Object.defineProperty(data,'items',{value:items,configurable:true});
      if(protectedType !== undefined){
        Object.defineProperty(data,'files',{value:[]});
        Object.defineProperty(data,'items',{value:names.map(()=>({kind:'file',type:protectedType,webkitGetAsEntry:()=>null,getAsFile:()=>null}))});
      }
      if(!names.length)data.setData('application/x-zenmind-navigation','new-chat');
      const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data});
      document.querySelector(selector).dispatchEvent(event);return event.defaultPrevented;
    };
  `, resolveDir: repo, loader: "tsx" },
  outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"test"', __DESKTOP_APP_BRAND__: JSON.stringify(require(path.join(repo, "dist-electron/shared/brand.js")).APP_BRAND) }
});
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta charset="UTF-8"><style>
:root{--surface-strong:#f9fafb;--control-border:#cbd5e1;--ink:#172033;--ink-soft:#64748b;--accent:#587de8;--panel-shadow:0 8px 24px #0002}body{margin:16px;font:13px system-ui;background:#e8edf4}*{box-sizing:border-box}
</style><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
fs.writeFileSync(path.join(root, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:600,height:600,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 win.webContents.on("console-message", (_event, level, message) => { if(level >= 2) console.error(message); });
 const js=code=>win.webContents.executeJavaScript(code);
 const until=async(code)=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timeout: '+code);};
 await win.loadFile(path.join(__dirname,'index.html'));
 await until('!!document.querySelector("aside")');
 for(const platform of ['mac','windows']){
  await js('document.body.className="app-shell is-'+platform+'-platform"');
  await js('drag("aside","dragenter",[])');
  assert.equal(await js('!!document.querySelector(".sidebar-file-drop-overlay")'),false);
  await js('drag("aside","dragenter")');
  await until('document.querySelectorAll("[data-file-drop-zone]").length===2');
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-file-drop-zone]")).map(el=>el.dataset.fileDropZone)'),['project','webapp']);
  await until('document.querySelector("[data-file-drop-zone=project]").getAttribute("aria-disabled")==="true"');
  await js('drag("[data-file-drop-zone=webapp]","dragover")');
  await until('!!document.querySelector(".is-hovered")');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,platform+'.png'),(await win.webContents.capturePage()).toPNG());
  await js('window.dispatchEvent(new Event("dragend"))');
  await until('!document.querySelector(".sidebar-file-drop-overlay")');
 }
 await js('document.querySelector(".app-sidebar-shell").style.width="48px";document.querySelector("aside").classList.add("is-collapsed");drag("aside","dragenter")');
 await until('!!document.querySelector("[data-file-drop-zone=project]")');
 assert.equal(await js('getComputedStyle(document.querySelector(".app-sidebar-shell")).overflow'),'visible');
 assert.ok(await js('document.querySelector(".sidebar-file-drop-overlay").getBoundingClientRect().width>=180'));
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 fs.writeFileSync(path.join(__dirname,'collapsed.png'),(await win.webContents.capturePage()).toPNG());
 assert.equal(await js('drag("[data-file-drop-zone=webapp]","drop")'),true);
 await until('calls.length===1 && !!window.finish');
 await js('drag("aside","dragenter");drag("aside","drop")');
 assert.equal(await js('calls.length'),1);
 await js('finish()');
 await until('!document.querySelector(".sidebar-file-drop-overlay")');
 await js('drag("aside","dragenter",["project folder"])');
 await until('!!document.querySelector("[data-file-drop-zone=project]")');
 await until('document.querySelector("[data-file-drop-zone=webapp]").getAttribute("aria-disabled")==="true"');
 await js('drag("[data-file-drop-zone=project]","drop",["project folder"])');
 await until('calls.length===2');
 assert.deepEqual(await js('calls'),[{zone:'webapp',name:'sample.zip'},{zone:'project',name:'project folder'}]);
 await js('finish()');
 await until('!document.querySelector(".sidebar-file-drop-overlay")');
 await js('drag("aside","dragenter",["bad.txt"])');
 await until('!!document.querySelector("[data-file-drop-zone=webapp]")');
 await js('drag("[data-file-drop-zone=webapp]","drop",["bad.txt"])');
 await until('!!document.querySelector("[role=alert]")');
 assert.equal(await js('calls.length'),2);
 await js('document.querySelector(".ant-modal .ant-btn-primary").click()');
 await js('drag("aside","dragenter",["a.zip","b.zip"])');
 await until('!!document.querySelector("[data-file-drop-zone=webapp]")');
 await js('drag("[data-file-drop-zone=webapp]","drop",["a.zip","b.zip"])');
 await until('document.querySelector("[role=alert]")?.textContent.includes("一次")');
 assert.equal(await js('calls.length'),2);
 await js('document.querySelector(".ant-modal .ant-btn-primary").click()');
 for(const names of [['folder.zip'],['README'],['APP.ZIP']]){
  await js('drag("aside","dragenter",'+JSON.stringify(names)+')');
  await until('!!document.querySelector("[data-file-drop-zone=project]")');
  const disabled=await js('Array.from(document.querySelectorAll("[data-file-drop-zone]")).map(el=>el.getAttribute("aria-disabled"))');
  assert.deepEqual(disabled,names[0]==='folder.zip'?['false','true']:names[0]==='APP.ZIP'?['true','false']:['true','true']);
  await js('window.dispatchEvent(new Event("dragend"))');
  await until('!document.querySelector(".sidebar-file-drop-overlay")');
 }
 // Protected native drag data must not misclassify a directory as a file.
 for(const mime of ['', 'application/zip', 'image/png']){
  await js('drag("aside","dragenter",["protected"],'+JSON.stringify(mime)+')');
  await until('!!document.querySelector("[data-file-drop-zone=project]")');
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[data-file-drop-zone]")).map(el=>el.getAttribute("aria-disabled"))'),mime===''?['false','false']:mime==='application/zip'?['true','false']:['true','true']);
  await js('window.dispatchEvent(new Event("dragend"))');
  await until('!document.querySelector(".sidebar-file-drop-overlay")');
 }
 await js('drag("aside","dragenter")');
 await until('!!document.querySelector("[data-file-drop-zone=project]")');
 await js('drag("[data-file-drop-zone=project]","drop")');
 await until('!!document.querySelector("[role=alert]")');
 assert.equal(await js('calls.length'),2);
 console.log('PASS: drag zones, internal sorting exclusion, cancellation, collapsed layout, ZIP/folder routing, duplicate and invalid drops');
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { stdio: "inherit", env });
const timeout = setTimeout(() => child.kill(), 30000);
const code = await new Promise(resolve => child.on("exit", resolve));
clearTimeout(timeout);
console.log(`Screenshots: ${root}`);
process.exitCode = code ?? 1;
