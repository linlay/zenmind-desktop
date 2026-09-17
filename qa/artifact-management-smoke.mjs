// Isolated artifact-page checks with a mocked readonly bridge and no user data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const repo = process.cwd();
const require = createRequire(path.join(repo, "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-management-ui-"));
await build({ stdin: { contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArtifactManagementPage} from ${JSON.stringify(path.join(repo, "src/renderer/pages/artifact-management/ArtifactManagementPage.tsx"))};
import {RendererI18nContext} from ${JSON.stringify(path.join(repo, "src/renderer/i18n/i18n-context.ts"))};
import {createTranslator} from ${JSON.stringify(path.join(repo, "src/shared/i18n/index.ts"))};
import ${JSON.stringify(path.join(repo, "src/renderer/styles.css"))};
let items=Array.from({length:55},(_,i)=>({chatId:'chat-'+i,artifactId:'artifact-'+i,name:'Report '+i+'.pdf',mimeType:'application/pdf',sizeBytes:1024*(i+1),sha256:'a'.repeat(64),pushedAt:1800000000000-i}));
let listener=()=>{};window.opened=[];window.fail=false;
window.pushArtifact=()=>{items=[{...items[0],artifactId:'new-artifact',name:'New live artifact.html'},...items];listener()};
window.electronAPI={artifacts:{list:async({search='',offset=0,limit=50}={})=>{if(window.fail)throw Error('test');const records=items.filter(item=>item.name.toLowerCase().includes(search.toLowerCase()));return{total:records.length,records:records.slice(offset,offset+limit)}},onChanged:fn=>{listener=fn;return()=>{listener=()=>{}}}},assistant:{listHistoryChats:async()=>({ok:true,items:items.map(item=>({chatId:item.chatId,agentKey:'agent-1',chatName:'Source '+item.chatId}))})}};
function Fixture(){const [locale,setLocale]=useState('zh-CN');window.setLocale=setLocale;return <RendererI18nContext.Provider value={{locale,source:'user',t:createTranslator(locale),setLocale:async(next)=>setLocale(next)}}><ArtifactManagementPage onOpenChat={request=>window.opened.push(request)}/></RendererI18nContext.Provider>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`, resolveDir: repo, loader: "tsx" }, outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(require(path.join(repo, "dist-electron/shared/brand.js")).APP_BRAND) } });
fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>');
fs.writeFileSync(path.join(root, "main.cjs"), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'));
(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',(_event,_level,message)=>{if(message.includes('Error'))console.error(message)});await win.loadFile(path.join(__dirname,'index.html'));const js=(s)=>win.webContents.executeJavaScript(s);const until=async(s)=>{for(let n=0;n<100;n++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+s);};
await until('document.querySelectorAll("tbody tr").length===50');
await until('document.querySelector(".artifact-management-chat")');await js('document.querySelector(".artifact-management-chat").click()');assert.equal(await js('window.opened[0].agentKey'),'agent-1');
await js('document.querySelector(".artifact-management-pagination button:last-child").click()');await until('document.querySelectorAll("tbody tr").length===5');
await js('document.querySelector(".artifact-management-pagination button:first-child").click()');await until('document.querySelectorAll("tbody tr").length===50');
await js('window.pushArtifact()');await until('document.querySelector("tbody").textContent.includes("New live artifact.html")');
await js(\`(()=>{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'New live');input.dispatchEvent(new Event('input',{bubbles:true}));})()\`);await until('document.querySelectorAll("tbody tr").length===1');
await js('document.querySelector("summary").click()');assert.equal(await js('document.querySelector("details").open'),true);
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(path.join(__dirname,'artifacts-light.png'),(await win.webContents.capturePage()).toPNG());
await js('window.setLocale("en-US");document.documentElement.dataset.theme="dark"');await until('document.querySelector("h1").textContent==="Artifacts"');
await js('window.fail=true;document.querySelector(".artifact-management-header button").click()');await until('document.querySelector("[role=alert]")');
await js('window.fail=false;document.querySelector(".artifact-management-header button").click()');await until('document.querySelectorAll("tbody tr").length===1');
await js(\`(()=>{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'missing');input.dispatchEvent(new Event('input',{bubbles:true}));})()\`);await until('document.querySelector("[role=status]")?.textContent.includes("No matching artifacts")');
console.log('Artifact management UI smoke passed: '+__dirname);win.destroy();app.quit();})().catch(e=>{console.error(e);app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { env, stdio: "inherit" });
const code = await new Promise((resolve) => child.once("exit", resolve));
process.exitCode = code ?? 1;
