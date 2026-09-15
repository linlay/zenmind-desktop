import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";
// Isolated real-component visual regression; no user profile or business services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
const require = createRequire(import.meta.url);
const output = path.resolve('build/qa/skin-visuals'); fs.mkdirSync(output,{recursive:true});
const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(process.env.SKIN_VISUAL_QA_PACKAGE ?? 'build/qa/bow-1.1.skin.zip')));
const manifest = JSON.parse(await zip.file('skin.json').async('string'));
const skin = { id: `pack:${'a'.repeat(32)}`, tokens: {}, visuals: {} };
for (const mode of ['light','dark']) {
  skin.tokens[mode]=manifest.variants[mode].tokens;
  const visual = manifest.variants[mode].visuals;
  skin.visuals[mode]={ styles:visual.styles, images:{} };
  for(const [slot,name] of Object.entries(visual.images)) skin.visuals[mode].images[slot]=`data:image/png;base64,${await zip.file(name).async('base64')}`;
}
await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React, { useEffect, useState } from 'react'; import { createRoot } from 'react-dom/client';
import { AppearanceProvider, useAppearance } from './src/renderer/appearance/AppearanceProvider';
import { SidebarActionIcon, SidebarIllustration } from './src/renderer/components/BrandMark';
import { SettingsSidebarIcon } from './src/renderer/app-shell/navigation/SettingsSidebarIcon';
import { AgentIcon } from './src/renderer/app-shell/navigation/AgentIcon';
import { SkinHeading } from './src/renderer/appearance/SkinVisual';
import './src/renderer/styles.css';
const skin=${JSON.stringify(skin)}; let selected=skin.id;
const settings=()=>({ok:true,settings:{skinId:selected,installedSkin:selected===skin.id?skin:undefined,background:null,backgroundDataUrl:null}});
window.electronAPI={settings:{getDesktopSkin:async()=>settings(),getThemePreference:async()=>'light',setDesktopSkin:async(id)=>{selected=id;return settings()},setNativeThemeSource:async(themeSource)=>({ok:true,themeSource})}};
function Scene(){const appearance=useAppearance();const [draft,setDraft]=useState('换肤时保留的草稿');useEffect(()=>{window.mounts=(window.mounts||0)+1},[]);window.preview={appearance};return <main className="app-shell is-mac-platform"><section className="preview"><div className="tools"><SettingsSidebarIcon kind="search"/><SidebarActionIcon kind="sidebar_left"/><SidebarActionIcon kind="back"/><button disabled><SidebarActionIcon kind="forward"/></button></div><div className="entry"><SidebarIllustration kind="futures"/>看板</div><div className="entry"><SidebarIllustration kind="schedule"/>自动化</div><div className="entry"><SidebarActionIcon kind="new_chat"/>新建对话</div><SkinHeading group="chats">对话</SkinHeading><div className="entry"><span>未读对话</span><i className="assistant-worker-unread-dot is-unread"/></div><SkinHeading group="assistants">项目</SkinHeading>{['terminal','database','library'].map((icon,i)=><div className="entry" key={icon}><AgentIcon icon={icon} size={24}/><span>{['cli-excelx','dbx-for-qiuer','AI 建设文档'][i]}</span><div className="assistant-worker-badge">{[1,12,'99+'][i]}</div></div>)}<SkinHeading group="webs">站点</SkinHeading><textarea value={draft} onChange={e=>setDraft(e.target.value)}/><div className="buttons"><button onClick={()=>appearance.setThemeMode('dark')}>深色</button><button onClick={()=>appearance.setSkinId('default')}>默认</button></div></section></main>};createRoot(document.getElementById('root')).render(<AppearanceProvider><Scene/></AppearanceProvider>);
`},bundle:true,outfile:path.join(output,'preview.js'),loader:{'.svg':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"',__DESKTOP_APP_BRAND__:JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(),resolveBrandId())))}});
fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="preview.css"><style>body{margin:0}.app-shell{min-height:100vh;background:var(--bg-base);color:var(--ink)}.preview{width:430px;padding:32px;font:18px system-ui}.tools,.entry,.buttons{display:flex;align-items:center;gap:16px;margin-bottom:20px}.tools svg,.tools img,.entry>.skin-visual{width:24px;height:24px}.entry span{flex:1}.skin-heading{display:block;margin:25px 0 15px;font-size:20px}.skin-heading-art{height:30px}.assistant-worker-unread-dot{display:block}.assistant-worker-badge{margin-left:auto}.preview textarea{box-sizing:border-box;width:100%;height:100px;background:var(--surface);color:var(--ink);border:1px solid var(--line);padding:12px}.preview button{border:0;background:transparent;color:inherit}.preview button:disabled{opacity:.35}.buttons{margin-top:16px}</style><div id="root"></div><script src="preview.js"></script>`);
const runner=path.join(output,'run.cjs');
fs.writeFileSync(runner,`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');app.setPath('userData',process.env.SKIN_VISUAL_TEMP);app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:520,height:780,webPreferences:{contextIsolation:true}});win.webContents.on('console-message',(_e,_level,msg)=>console.log('renderer:',msg));await win.loadFile(path.join(__dirname,'index.html'));const wait=async condition=>{for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(condition))return;await new Promise(r=>setTimeout(r,50))}throw Error('Timeout: '+condition+' state='+JSON.stringify(await win.webContents.executeJavaScript('({ready:window.preview?.appearance.skinLoadState,id:window.preview?.appearance.skin.id,images:[...document.images].map(i=>({src:i.src.slice(0,60),complete:i.complete})),text:document.body.innerText})')))};await wait('window.preview?.appearance.skinLoadState === "ready" && document.querySelectorAll("img.skin-visual").length > 8 && [...document.images].every(i=>i.complete)');let before=await win.webContents.executeJavaScript('({mounts:window.mounts,draft:document.querySelector("textarea").value})');for(const mode of ['light','dark']){await win.webContents.executeJavaScript('window.preview.appearance.setThemeMode('+JSON.stringify(mode)+')');await wait('document.documentElement.dataset.theme === '+JSON.stringify(mode)+' && [...document.images].every(i=>i.complete)');fs.writeFileSync(path.join(__dirname,mode+'.png'),(await win.webContents.capturePage()).toPNG())}await win.webContents.executeJavaScript('window.preview.appearance.setSkinId("default")');await wait('document.querySelectorAll("img.skin-visual").length === 0');assert.equal(await win.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--skin-unread")'),'');assert.deepEqual(await win.webContents.executeJavaScript('({mounts:window.mounts,draft:document.querySelector("textarea").value})'),before);console.log('Visual 1.1: PNGs loaded, light/dark rendered, defaults restored, draft and mount preserved');win.destroy();app.quit()}).catch(error=>{console.error(error);app.exit(1)});`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'skin-visual-smoke-'));
const env={...process.env,SKIN_VISUAL_TEMP:temp};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[runner],{env,stdio:'inherit'});
const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)});fs.rmSync(temp,{recursive:true,force:true});process.exitCode=code??1;
