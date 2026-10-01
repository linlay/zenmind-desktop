import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from '../scripts/lib/brand-model.mjs';
const require = createRequire(import.meta.url);
const repo = process.cwd(); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'website-bridges-ui-'));
const modulePath = name => JSON.stringify(path.join(repo, 'dist-electron/main/modules/web-surfaces/website-bridges', name));
const source = name => JSON.stringify(path.join(repo, 'src/renderer', name));
await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WebsiteBridgesSettings} from ${source('pages/settings/WebsiteBridgesSettings.tsx')};
import {RendererI18nContext} from ${source('i18n/i18n-context.ts')};
import {createTranslator} from ${JSON.stringify(path.join(repo, 'src/shared/i18n/index.ts'))};
import {ConfigProvider,theme} from 'antd';
import ${source('styles/theme.css')};
function App(){ const [dark,setDark]=React.useState(false);window.setDark=setDark;
return <RendererI18nContext.Provider value={{locale:'zh-CN',source:'default',t:createTranslator('zh-CN'),setLocale:async()=>{}}}><ConfigProvider theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm}}><WebsiteBridgesSettings/></ConfigProvider></RendererI18nContext.Provider> }
createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: repo, loader: 'tsx' },
  outfile: path.join(temp, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId([], process.env)))) } });
fs.writeFileSync(path.join(temp, 'index.html'), '<meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><style>body{font-family:system-ui;background:var(--bg-base);margin:0;padding:24px}*{box-sizing:border-box}</style><div id="root"></div><script src="ui.js"></script>');
const methods = ['listWebsiteBridges', 'importWebsiteBridge', 'exportWebsiteBridge', 'setWebsiteBridgeEnabled', 'removeWebsiteBridge', 'readWebsiteBridgeScript'];
fs.writeFileSync(path.join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('electronAPI',{settings:{${methods.map(name => `${name}:(arg)=>ipcRenderer.invoke('settings.${name}',arg)`).join(',')}}});`);
fs.writeFileSync(path.join(temp, 'main.cjs'), `
const {app,BrowserWindow,ipcMain,dialog}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile')); app.on('window-all-closed',()=>{});
const {createWebsiteBridgeManager}=require(${modulePath('manager.js')});const {registerWebsiteBridgeIpc}=require(${modulePath('ipc.js')});
const manager=createWebsiteBridgeManager({packagesRoot:path.join(__dirname,'packages'),configRoot:path.join(__dirname,'config')});let win;
const timer=setTimeout(()=>{console.error('UI smoke timed out');app.exit(1)},30000);
(async()=>{await app.whenReady();
const pkg=path.join(__dirname,'forum.zip');fs.writeFileSync(pkg,await manager.exportBytes('qiuer-forum'));
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[pkg]});dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(__dirname,'export.zip')});
registerWebsiteBridgeIpc(ipcMain,{browserSurfaces:{websiteBridges:manager},getMainWindow:()=>win,platform:process.platform});
win=new BrowserWindow({show:false,width:1180,height:940,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
const js=code=>win.webContents.executeJavaScript(code);const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+code)};
const click=async text=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()')};
await win.loadFile(path.join(__dirname,'index.html'));await until('document.querySelector(".website-bridge-source")?.value.includes("context")');
assert.equal(await js('document.querySelectorAll(".website-bridge-routes button").length'),4);
await js('Array.from(document.querySelectorAll(".website-bridge-routes button")).find(b=>b.textContent.includes("/forum/new")).click()');
await until('document.querySelector(".website-bridge-source")?.value.includes("forum.posts.create")');
assert.equal(await js('document.querySelector(".website-bridge-source").value.includes("forum.comments.create")'),false);
fs.writeFileSync(path.join(__dirname,'light.png'),(await win.webContents.capturePage()).toPNG());
await js('document.querySelector("[role=switch]").click()');await until('document.querySelector("[role=switch]").getAttribute("aria-checked")==="false"');assert.equal(manager.list().items[0].enabled,false);
await click('导入更新');await until('document.querySelector("[role=status]")?.textContent.includes("已导入")');assert.equal(manager.list().items[0].enabled,false);
await click('导出 ZIP');await until('document.querySelector("[role=status]")?.textContent.includes("已导出")');assert.ok(fs.existsSync(path.join(__dirname,'export.zip')));
await js('document.documentElement.dataset.theme="dark";window.setDark(true)');await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(__dirname,'dark.png'),(await win.webContents.capturePage()).toPNG());
win.setSize(600,920);await new Promise(r=>setTimeout(r,100));assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);fs.writeFileSync(path.join(__dirname,'narrow.png'),(await win.webContents.capturePage()).toPNG());
await click('卸载');await until('!!document.querySelector(".ant-modal-confirm-btns, .ant-modal-footer")');await js('document.querySelector(".ant-modal-footer .ant-btn-primary").click()');await until('document.querySelectorAll(".website-bridge-item").length===0');assert.equal(manager.list().items.length,0);
clearTimeout(timer);console.log('Website bridge UI smoke passed: import/update, export, disable persistence, page scripts, uninstall, narrow layout. Screenshots: '+__dirname);win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', timeout: 40000 });
if (result.status !== 0) process.exit(result.status ?? 1);
