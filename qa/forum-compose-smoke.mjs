// Isolated React form and mocked API: never connects to or publishes on the real forum.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-compose-smoke-'));
const ui = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';
function App(){const[d,setD]=React.useState({title:'',bodyMarkdown:'',type:'DISCUSSION',tags:'',section:'AI'});const[open,setOpen]=React.useState(false);const[q,setQ]=React.useState('');const[markdown,setMarkdown]=React.useState(false);window.draft=d;
const field=k=>({value:d[k],onChange:e=>setD({...d,[k]:e.target.value})});
return <form className="forum-compose" onSubmit={e=>{e.preventDefault();window.nativeSubmissions.push({...d});}}><div className="forum-form-grid"><select {...field('type')}><option>DISCUSSION</option><option>ARTICLE</option></select></div><button type="button" className="forum-section-trigger" aria-expanded={open} onClick={()=>setOpen(!open)}><span>{d.section}</span></button>{open&&<div className="forum-section-popover"><input type="search" value={q} onChange={e=>setQ(e.target.value)}/><button type="button" className="forum-section-option" aria-pressed={d.section==='Other'} onClick={()=>{setD({...d,section:'Other'});setOpen(false)}}><span>Other</span></button></div>}<input maxLength={200} {...field('title')}/><button type="button" onClick={()=>setMarkdown(!markdown)}>{markdown?'可视编辑':'Markdown 源码'}</button><textarea id="forum-compose-body" {...field('bodyMarkdown')}/><input placeholder="最多 5 个标签" {...field('tags')}/><button className="forum-primary">发布</button></form>}
createRoot(document.getElementById('root')).render(<App/>);
window.nativeSubmissions=[];window.fetch=async(url)=>{if(String(url).endsWith('/sections'))return new Response(JSON.stringify({items:[{id:1,slug:'ai',name:'AI',canPost:true},{id:2,slug:'other',name:'Other',canPost:true}]}));throw Error('Unexpected request from bridge: '+url);};
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
fs.writeFileSync(path.join(temp, 'ui.js'), ui.outputFiles[0].text);
const modulePath = name => JSON.stringify(path.resolve('dist-electron/main/modules/web-surfaces/website-bridges', name));
fs.writeFileSync(path.join(temp,'main.cjs'),`
const{app,BrowserWindow,session}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{builtinForumBridge}=require(${modulePath('builtin.js')});const{buildWebsiteBridgeScript}=require(${modulePath('injection-script.js')});
app.setPath('userData',path.join(__dirname,'profile'));let win;const timer=setTimeout(()=>app.exit(1),30000);
(async()=>{await app.whenReady();await session.defaultSession.protocol.handle('https',()=>new Response('<div id="root"></div><script>'+fs.readFileSync(path.join(__dirname,'ui.js'),'utf8')+'</script>',{headers:{'content-type':'text/html'}}));
win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});await win.loadURL('https://1024.qiuer.net/forum/new');
const js=s=>win.webContents.executeJavaScript(s);for(let i=0;i<100&&!await js('!!document.querySelector("form")');i++)await new Promise(r=>setTimeout(r,10));
const inject=()=>js(buildWebsiteBridgeScript('https://1024.qiuer.net/forum/new',[builtinForumBridge()]));await inject();assert.deepEqual(await js('awcp.manual().sections.map(s=>s.section)'),['forum.compose.fill','forum.compose.publish']);let seq=0;
const invoke=(action,args={})=>js('awcp.invoke('+JSON.stringify({requestId:'r'+(++seq),revision:undefined,action,args}).replace('"action":','"revision":awcp.manual().revision,"action":')+')');
const filled=await invoke('forum.compose.fill',{title:'Test title',bodyMarkdown:'Test body',type:'ARTICLE',section:'other',tags:['AWCP']});assert.equal(filled.ok,true,JSON.stringify(filled));assert.equal(await js('draft.title'),'Test title');assert.equal(await js('draft.bodyMarkdown'),'Test body');assert.equal(await js('nativeSubmissions.length'),0);
const token=filled.result.draftToken;const changed=await invoke('forum.compose.fill',{title:'Changed',bodyMarkdown:'Test body'});assert.equal(changed.ok,true);assert.equal((await invoke('forum.compose.publish',{draftToken:token})).error.code,'action.draft_changed');assert.equal(await js('nativeSubmissions.length'),0);
const current=await invoke('forum.compose.fill',{title:'Changed',bodyMarkdown:'Test body'});
await js('document.querySelector(".forum-primary").disabled=true');const disabled=await invoke('forum.compose.publish',{draftToken:current.result.draftToken});assert.equal(disabled.ok,false);assert.equal(await js('nativeSubmissions.length'),0);await js('document.querySelector(".forum-primary").disabled=false');
const published=await invoke('forum.compose.publish',{draftToken:current.result.draftToken});assert.equal(published.ok,true,JSON.stringify(published));assert.equal(published.result.status,'submitted');assert.equal(published.result.published,null);assert.equal(await js('nativeSubmissions[0].title'),'Changed');assert.equal(await js('nativeSubmissions[0].bodyMarkdown'),'Test body');assert.equal(await js('nativeSubmissions[0].type'),'ARTICLE');assert.equal(await js('nativeSubmissions[0].tags'),'AWCP');assert.equal(await js('nativeSubmissions[0].section'),'Other');assert.equal((await invoke('forum.compose.publish',{draftToken:current.result.draftToken})).error.code,'action.publish_unknown');assert.equal(await js('nativeSubmissions.length'),1);
await js('delete globalThis.awcp');await inject();assert.equal(await js('awcp.protocolVersion'),1);
clearTimeout(timer);console.log('PASS: Batch fill, section selection, changed-draft refusal, disabled button refusal, native submit handler receives all fields, no direct POST, no duplicate click, missing-entry recovery. No real forum requests.');win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', timeout: 40000 });
process.exitCode = result.status ?? 1;
