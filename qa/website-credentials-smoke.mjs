// Drives the "密码与登录" settings page in a real Electron window against the real
// system key protector (macOS Keychain / Windows DPAPI). System authentication is
// simulated, because a smoke run cannot answer an operating-system prompt.
// Run after `npm run build:main:prepared`: node qa/website-credentials-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from '../scripts/lib/brand-model.mjs';
const require = createRequire(import.meta.url);
const repo = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'website-credentials-ui-'));
const modulePath = name => JSON.stringify(path.join(repo, 'dist-electron/main/modules/credentials', name));
const source = name => JSON.stringify(path.join(repo, 'src/renderer', name));

await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WebsiteCredentialsSettings} from ${source('pages/settings/WebsiteCredentialsSettings.tsx')};
import {RendererI18nContext} from ${source('i18n/i18n-context.ts')};
import {createTranslator} from ${JSON.stringify(path.join(repo, 'src/shared/i18n/index.ts'))};
import {ConfigProvider,theme} from 'antd';
import ${source('styles/theme.css')};
function App(){ const [dark,setDark]=React.useState(false);window.setDark=setDark;
return <RendererI18nContext.Provider value={{locale:'zh-CN',source:'default',t:createTranslator('zh-CN'),setLocale:async()=>{}}}><ConfigProvider theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm}}><WebsiteCredentialsSettings/></ConfigProvider></RendererI18nContext.Provider>; }
createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: repo, loader: 'tsx' },
  outfile: path.join(temp, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId([], process.env)))) } });
fs.writeFileSync(path.join(temp, 'index.html'), '<meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><style>body{font-family:system-ui;background:var(--bg-base);margin:0;padding:24px}*{box-sizing:border-box}</style><div id="root"></div><script src="ui.js"></script>');
const methods = ['getWebsiteCredentials', 'setWebsiteCredentialCapture', 'addWebsiteCredential', 'updateWebsiteCredential', 'removeWebsiteCredential', 'revealWebsiteCredential', 'setWebsiteCredentialNeverSave', 'importWebsiteCredentials', 'exportWebsiteCredentials'];
fs.writeFileSync(path.join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('electronAPI',{settings:{${methods.map(name => `${name}:(arg)=>ipcRenderer.invoke('settings.${name}',arg)`).join(',')},onWebsiteCredentialsLocked:(listener)=>{const handle=()=>listener();ipcRenderer.on('credentials.locked',handle);return()=>ipcRenderer.off('credentials.locked',handle)}}});`);

fs.writeFileSync(path.join(temp, 'main.cjs'), `
const {app,BrowserWindow,ipcMain,dialog}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile')); app.on('window-all-closed',()=>{});
const {createWebsiteCredentialStore}=require(${modulePath('store.js')});
const {createSystemVaultKeyProtector}=require(${modulePath('key-protector.js')});
const {restrictDirectoryToCurrentUser}=require(${modulePath('access-control.js')});
const {createAuthenticationGate}=require(${modulePath('system-auth.js')});
const {registerWebsiteCredentialIpc}=require(${modulePath('ipc.js')});
const {createLoginCapture}=require(${modulePath('capture/controller.js')});
const vaultDirectory=path.join(__dirname,'secrets','website-credentials');
let win; let outcome='authenticated'; let prompts=0;
const timer=setTimeout(()=>{console.error('UI smoke timed out');app.exit(1)},30000);
(async()=>{await app.whenReady();
const protector=createSystemVaultKeyProtector();
assert.equal(protector.available(),true,'system key protection must be available on this machine');
const store=createWebsiteCredentialStore({vaultDirectory,policyFile:path.join(__dirname,'config','website-credentials.json'),protector,hardenDirectory:directory=>restrictDirectoryToCurrentUser(directory)});
const gate=createAuthenticationGate({graceMs:0,authenticator:{authenticate:async()=>{prompts+=1;return outcome}}});
const capture=createLoginCapture({store,presentOffer:()=>false,withdrawOffer(){}});
registerWebsiteCredentialIpc(ipcMain,{getMainWindow:()=>win,store,gate,capture});
win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
const js=code=>win.webContents.executeJavaScript(code).catch(error=>{console.error('SCRIPT:',code.slice(0,200));throw error});
const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out waiting for: '+code)};
const click=async text=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==='+JSON.stringify(text)+'||b.textContent.trim()==='+JSON.stringify(text)+').click()')};
const type=async(index,value)=>{await js('(()=>{const input=document.querySelectorAll(".website-credential-form input")['+index+'];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}))})()')};
const status=text=>until('Array.from(document.querySelectorAll("[role=status],[role=alert]")).some(node=>node.textContent.includes('+JSON.stringify(text)+'))');
const detail=()=>js('Array.from(document.querySelectorAll(".website-credential-meta code")).map(node=>node.textContent)');
// Screenshots are for human review only; headless environments may not be able to capture.
const shot=async name=>{try{fs.writeFileSync(path.join(__dirname,name+'.png'),(await win.webContents.capturePage()).toPNG())}catch(error){console.warn('Screenshot '+name+' skipped: '+error.message)}};
const save=()=>js('document.querySelector(".ant-modal-footer .ant-btn-primary").click()');

await win.loadFile(path.join(__dirname,'index.html'));await until('!!document.querySelector(".website-credential-empty")');
await shot('empty');

// Recording is opt-in.
assert.equal(store.isCaptureEnabled(),false);await js('document.querySelector(".website-credential-capture [role=switch]").click()');await until('document.querySelector(".website-credential-capture [role=switch]").getAttribute("aria-checked")==="true"');assert.equal(store.isCaptureEnabled(),true);
store.setNeverSave('https://never.example.com',true);await click('刷新');await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("不再询问的网站（1）"))');await click('不再询问的网站（1）');await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="恢复询问")');await click('恢复询问');await until('!Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("不再询问的网站"))');assert.deepEqual(store.state().neverSaveOrigins,[]);
await js('document.querySelector(".ant-modal-close")?.click()');

// Add: adding does not require system authentication.
await click('添加账号');await until('document.querySelectorAll(".website-credential-form input").length===4');
await type(0,'http://accounts.example.com');await type(1,'alice@example.com');await type(2,'correct horse battery staple');await save();await status('网站地址无效');
await type(0,'https://accounts.example.com/login');await type(3,'工作账号');await save();await status('已保存');
await until('document.querySelectorAll(".website-credential-item").length===1');assert.equal(prompts,0);
assert.deepEqual(await detail(),['al***@example.com','••••••••']);

// Real system protection: nothing readable on disk, and the directory is owner-only.
for(const name of fs.readdirSync(vaultDirectory)){const content=fs.readFileSync(path.join(vaultDirectory,name),'utf8');for(const secret of ['correct horse','alice','example.com','工作账号'])assert.equal(content.includes(secret),false,name+' leaks '+secret);}
assert.deepEqual(fs.readdirSync(vaultDirectory).sort(),['key-envelope','vault']);
if(process.platform==='darwin')assert.equal(fs.statSync(vaultDirectory).mode&0o777,0o700);

// Reveal is refused without system authentication, and shows the secret with it.
outcome='failed';await click('显示');await status('系统认证未通过');assert.deepEqual(await detail(),['al***@example.com','••••••••']);
outcome='unavailable';await click('显示');await status('暂不支持系统认证');assert.deepEqual(await detail(),['al***@example.com','••••••••']);
outcome='authenticated';await click('显示');await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="隐藏")');
assert.deepEqual(await detail(),['alice@example.com','correct horse battery staple']);
await shot('revealed');
await click('隐藏');assert.deepEqual(await detail(),['al***@example.com','••••••••']);
// Locking the screen hides a revealed password at once.
await click('显示');await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="隐藏")');
win.webContents.send('credentials.locked');await until('!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="隐藏")');
assert.deepEqual(await detail(),['al***@example.com','••••••••']);

// Toggles and edits are authenticated changes that persist.
outcome='failed';await js('document.querySelectorAll(".service-card .website-credential-option [role=switch]")[0].click()');await status('系统认证未通过');assert.equal(store.state().credentials[0].agentAllowed,true);
outcome='authenticated';await js('document.querySelectorAll(".service-card .website-credential-option [role=switch]")[0].click()');await status('已保存');assert.equal(store.state().credentials[0].agentAllowed,false);
await js('document.querySelectorAll(".service-card .website-credential-option [role=switch]")[1].click()');await until('document.querySelector(".website-credential-item small")?.textContent.includes("默认账号")');
assert.equal(await js('document.querySelector(".website-credential-item small").textContent'),'默认账号 · 禁止智能体使用');
// Locking the screen also discards an edit that holds the revealed password.
await click('编辑');await until('document.querySelectorAll(".website-credential-form input").length===4');
win.webContents.send('credentials.locked');await until('!document.querySelector(".ant-modal-wrap:not([style*=none]) .website-credential-form")');
await click('编辑');await until('document.querySelectorAll(".website-credential-form input").length===4');
assert.equal(await js('document.querySelectorAll(".website-credential-form input")[2].value'),'correct horse battery staple');
await type(2,'new password');await save();await until('!document.querySelector(".ant-modal-wrap:not([style*=none]) .website-credential-form")');
assert.equal(store.reveal(store.state().credentials[0].id).password,'new password');
await js('document.documentElement.dataset.theme="dark";window.setDark(true)');await new Promise(r=>setTimeout(r,150));await shot('dark');
win.setSize(600,820);await new Promise(r=>setTimeout(r,150));assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);await shot('narrow');

// Import a browser CSV, export an encrypted backup, then restore it after deleting everything.
const csv=path.join(__dirname,'passwords.csv'),backupFile=path.join(__dirname,'export.pwbackup');let openPath=csv;
fs.writeFileSync(csv,'name,url,username,password,note\\nA,https://accounts.example.com/x,alice@example.com,ignored because it exists,\\nB,https://shop.example.com/login,bob,"pw,1",\\nC,android://x@com.app/,carol,pw,\\n');
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[openPath]});dialog.showSaveDialog=async()=>({canceled:false,filePath:backupFile});
const backupInputs=async(...values)=>{await until('document.querySelectorAll(".website-credential-form input").length==='+values.length);for(let i=0;i<values.length;i++)await type(i,values[i])};
// The file dialog may stay open through a lock: authentication is checked again once a file is chosen.
dialog.showOpenDialog=async()=>{outcome='failed';return {canceled:false,filePaths:[openPath]}};
await click('导入');await status('系统认证未通过');assert.equal(store.state().credentials.length,1);
outcome='authenticated';dialog.showOpenDialog=async()=>({canceled:false,filePaths:[openPath]});
await click('导入');await status('已导入 1 个账号，跳过 1 个已存在的，1 行无法导入');assert.equal(store.state().credentials.length,2);
await click('导出备份');await backupInputs('export password','export password');await save();await status('加密备份已导出');
const exported=fs.readFileSync(backupFile,'utf8');for(const secret of ['new password','pw,1','alice','shop.example.com'])assert.equal(exported.includes(secret),false,'backup leaks '+secret);
const before=store.exportAll();for(const item of store.state().credentials)store.remove(item.id);
openPath=backupFile;await click('刷新');await until('document.querySelectorAll(".website-credential-item").length===0');
await click('导入');await backupInputs('wrong password');await save();await status('备份密码不正确');assert.equal(store.state().credentials.length,0);
await type(0,'export password');await save();await status('已导入 2 个账号');assert.deepEqual(store.exportAll(),before);
await js('Array.from(document.querySelectorAll(".website-credential-item")).find(b=>b.textContent.includes("accounts.example.com")).click()');

// Delete.
await click('删除');await until('!!document.querySelector(".ant-modal-footer .ant-btn-dangerous")');await js('document.querySelector(".ant-modal-footer .ant-btn-dangerous").click()');
await until('document.querySelectorAll(".website-credential-item").length===1');assert.equal(store.state().credentials.length,1);
clearTimeout(timer);console.log('Website credentials UI smoke passed: capture switch, never-save list, add, validation, encrypted at rest, authenticated reveal/edit/toggle/delete, CSV import, encrypted backup export and restore, narrow layout. Screenshots: '+__dirname);win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, stdio: 'inherit', timeout: 40000 });
if (result.status !== 0) process.exit(result.status ?? 1);
