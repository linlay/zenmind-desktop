// Isolated Electron rendering check; never starts Desktop services or opens its profile.
// Run from the repository root: node qa/desktop-appearance-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "package.json"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-appearance-smoke-"));
const source = (file) => JSON.stringify(path.join(repo, "src/renderer", file));
const previewDir = path.join(root, "preview");
const brand = { ...require(path.join(repo, "dist-electron/shared/brand.js")).APP_BRAND, storageNamespace: "appearance-smoke", protocols: { open: { scheme: "appearance-smoke" } }, installer: { shutdownArg: "--stop" } };
await build({
  entryPoints: [path.join(repo, "qa/desktop-skins-preview.tsx")],
  outfile: path.join(previewDir, "preview.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"', __DESKTOP_APP_BRAND__: JSON.stringify(brand) }
});
fs.writeFileSync(path.join(previewDir, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop 皮肤预览</title><link rel="stylesheet" href="./preview.css"><div id="root"></div><script src="./preview.js"></script></html>');
fs.writeFileSync(path.join(previewDir, "guest.html"), '<!doctype html><html><meta charset="UTF-8"><style>body{margin:0;padding:60px;background:#f2f4f7;color:#293342;font:16px system-ui}h1{font-weight:600}p{color:#667085}</style><h1>独立的嵌入页面</h1><p>Desktop 皮肤切换时，这个页面保留自己的背景与实例。</p><script>window.guestInstance=crypto.randomUUID();</script></html>');
await build({
  stdin: {
    contents: `
      import React, { useLayoutEffect, useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Button, Input, Select, Segmented, Modal } from 'antd';
      import { AppearanceProvider, useAppearance } from ${source("appearance/AppearanceProvider.tsx")};
      import { bootstrapAppearance } from ${source("appearance/browser.ts")};
      import { Popover } from ${source("components/Popover/index.tsx")};
      import ${source("styles.css")};
      import ${source("pages/settings/SettingsPage.css")};
      localStorage.setItem('appearance-smoke.theme', 'system');
      bootstrapAppearance();
      window.fixture = { bootstrap: document.documentElement.dataset.theme, mounts: 0 };
      function Probe() {
        const appearance = useAppearance();
        const [modal, setModal] = useState(false);
        const [selectOpen, setSelectOpen] = useState(false);
        const [modalApi, modalContext] = Modal.useModal();
        useLayoutEffect(() => { window.fixture.api = appearance; window.fixture.showModal = setModal; window.fixture.showSelect = setSelectOpen; window.fixture.confirm = () => modalApi.confirm({content:'Confirm inherits the skin'}); });
        useEffect(() => { window.fixture.mounts++; }, []);
        return <main id="shell" data-mode={appearance.themeMode} data-theme={appearance.resolvedTheme}>
          <h2>Desktop appearance / {appearance.resolvedTheme}</h2>
          {modalContext}
          <section><h3>Native controls</h3>
            <button id="native-primary" className="sidebar-website-primary-button">Primary</button>
            <button id="native-default" className="sidebar-website-secondary-button">Secondary</button>
            <button id="native-disabled" className="sidebar-website-primary-button" disabled>Disabled</button>
          </section>
          <section className="settings-page"><h3>Ant Design controls</h3>
            <Button id="ant-primary" type="primary">Primary</Button>
            <Button id="ant-default">Secondary</Button>
            <Button id="ant-disabled" type="primary" disabled>Disabled</Button>
            <Input id="ant-input" defaultValue="Input preserves state" style={{width:200}} />
            <Select id="ant-select" open={selectOpen} onDropdownVisibleChange={setSelectOpen} popupClassName="settings-select-popup" defaultValue="A" options={[{value:'A'},{value:'B'}]} style={{width:100}} />
            <Segmented options={['Light','Dark','System']} />
          </section>
          <section><h3>Navigation and main-window portals</h3>
            <div className="app-sidebar" style={{position:'static',width:240,padding:0}}>
              <button id="nav-selected" className="sidebar-primary-link sidebar-link sidebar-link-active">Selected navigation</button>
            </div>
            <Popover open className="fixture-popover" closeOnOutsideClick={false} content={<span id="portal-content">Body portal</span>}>
              <button id="portal-trigger">Popover</button>
            </Popover>
            <div id="native-dialog" className="sidebar-website-dialog" style={{width:240}}>Dialog surface</div>
          </section>
          <section id="platform" className="app-shell is-mac-platform" style={{height:60,display:'block'}}>
            <div className="app-sidebar is-collapsed" style={{width:160,position:'static',padding:0}}>
              <div className="sidebar-top-actions"><button id="collapse" className="app-sidebar-collapse-button">☰</button></div>
            </div>
          </section>
          <Modal open={modal} title="Themed modal" onCancel={()=>setModal(false)} footer={null}>Body portal</Modal>
        </main>;
      }
      const root = createRoot(document.getElementById('root'));
      root.render(<React.StrictMode><AppearanceProvider><Probe /></AppearanceProvider></React.StrictMode>);
      window.fixture.unmount = () => root.unmount();
    `,
    resolveDir: repo, loader: "tsx"
  },
  outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"development"',
    __DESKTOP_APP_BRAND__: JSON.stringify({ storageNamespace: "appearance-smoke", protocols: { open: { scheme: "appearance-smoke" } }, installer: { shutdownArg: "--stop" } })
  }
});
fs.writeFileSync(path.join(root, "index.html"), `<link rel="stylesheet" href="./fixture.css"><style>
  * { transition: none !important; animation: none !important; }
  body { background: var(--bg-base); font-family: sans-serif; }
  main { padding: 24px; } section { margin: 20px 0; } section > * { margin: 4px; }
  .fixture-popover { padding: 14px; } #platform { margin-top: 55px; }
  #shell .app-sidebar { height: auto; min-height: 0; }
</style><div id="root"></div><script src="./fixture.js"></script>`);
fs.writeFileSync(path.join(root, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{settings:{getThemePreference:()=>ipcRenderer.invoke('theme.read'),setNativeThemeSource:(theme)=>ipcRenderer.invoke('theme.write',theme),getDesktopSkin:()=>ipcRenderer.invoke('settings.getDesktopSkin'),setDesktopSkin:(id)=>ipcRenderer.invoke('settings.setDesktopSkin',id),importDesktopBackground:()=>ipcRenderer.invoke('settings.importDesktopBackground'),resetDesktopBackground:()=>ipcRenderer.invoke('settings.resetDesktopBackground')}});`);
fs.writeFileSync(path.join(root, "main.cjs"), `
const {app,BrowserWindow,ipcMain,nativeTheme,nativeImage,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'profile'));
app.setPath('sessionData',path.join(__dirname,'session'));
let profile='dark',failSave=false;
ipcMain.handle('theme.read',()=>profile);
ipcMain.handle('theme.write',(_event,theme)=>{
  if(failSave)throw new Error('fixture save failure');
  profile=theme;nativeTheme.themeSource=theme;return {ok:true,themeSource:theme};
});
let win;
const fixtureApp={getPath:(key)=>path.join(__dirname,'desktop-data',key)};
const {registerAppearanceIpcHandlers}=require(${JSON.stringify(path.join(repo, "dist-electron/main/modules/settings/appearance-ipc.js"))});
registerAppearanceIpcHandlers(ipcMain,{app:fixtureApp,platform:process.platform,getMainWindow:()=>win});
(async()=>{
  await app.whenReady();nativeTheme.themeSource='dark';
  win=new BrowserWindow({show:false,width:1000,height:820,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,webviewTag:true}});
  win.webContents.on("console-message", (_event, level, message) => { if(level >= 2) console.error("renderer:", message); });
  const js=(code)=>win.webContents.executeJavaScript(code);
  const until=async(code)=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,20));}console.error(await js('({theme:document.documentElement.dataset.theme,primary:getComputedStyle(document.querySelector("#ant-primary")).backgroundColor,seed:getComputedStyle(document.documentElement).getPropertyValue("--control-primary-bg"),className:document.querySelector("#ant-primary").className})'));throw new Error('Timed out: '+code);};
  const style=(selector,prop)=>js('getComputedStyle(document.querySelector('+JSON.stringify(selector)+'))['+JSON.stringify(prop)+']');
  const equal=async(selector,prop,expected)=>assert.equal(await style(selector,prop),expected,selector+' '+prop);
  await win.loadFile(path.join(__dirname,'index.html'));
  await until('!!window.fixture?.api && document.querySelector("#shell")?.dataset.theme === "dark"');
  const mounts=await js('fixture.mounts');assert.equal(await js('fixture.bootstrap'),'dark');
  win.webContents.debugger.attach('1.3');
  const cdp=(method,args={})=>win.webContents.debugger.sendCommand(method,args);
  await cdp('DOM.enable');await cdp('CSS.enable');
  const force=async(selector,states)=>{
    const {root}=await cdp('DOM.getDocument');
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector});
    await cdp('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:states});
  };
  for(const [mode,primary] of [['dark','rgb(79, 136, 255)'],['light','rgb(38, 99, 235)']]){
    await js('fixture.api.setThemeMode('+JSON.stringify(mode)+')');
    await until('getComputedStyle(document.querySelector("#ant-primary")).backgroundColor === '+JSON.stringify(primary));
    await equal('#native-primary','backgroundColor',primary);
    const portalInk=mode==='dark'?'rgb(242, 243, 245)':'rgb(29, 33, 41)';
    await equal('.fixture-popover','color',portalInk);
    await equal('#ant-input','color',portalInk);
    fs.writeFileSync(path.join(__dirname,mode+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  // Deliberately distinct tokens reveal specificity overrides and fixed colors.
  const palette={
    '--accent':'#7c3aed','--accent-rgb':'124, 58, 237','--accent-strong':'#6d28d9','--accent-soft':'#ede9fe',
    '--control-primary-hover':'#6d28d9','--control-primary-active':'#5b21b6',
    '--control-button-bg':'#213025','--control-input-bg':'#263a2c','--control-popover-bg':'#182f20',
    '--control-hover-bg':'#35583f','--control-active-bg':'#41694b','--control-disabled-bg':'#303730',
    '--control-border':'#617565','--control-icon-color':'#bfe5c4','--control-icon-hover-color':'#effff0',
    '--nav-selected-bg':'#354d3b','--nav-selected-text':'#d5efdb','--desktop-overlay-panel-bg':'#203c2a',
    '--control-radius':'14px','--control-radius-sm':'9px','--control-radius-lg':'18px','--overlay-radius':'20px'
  };
  await js('Object.entries('+JSON.stringify(palette)+').forEach(([key,value])=>document.documentElement.style.setProperty(key,value))');
  await js('fixture.api.setThemeMode("dark")');
  await until('getComputedStyle(document.querySelector("#ant-primary")).backgroundColor === "rgb(124, 58, 237)"');
  for(const selector of ['#native-primary','#ant-primary']){
    await equal(selector,'backgroundColor','rgb(124, 58, 237)');
    await force(selector,['hover']);await equal(selector,'backgroundColor','rgb(109, 40, 217)');
    await force(selector,['hover','active']);await equal(selector,'backgroundColor','rgb(91, 33, 182)');
    await force(selector,[]);
  }
  for(const selector of ['#native-default','#ant-default']){
    await equal(selector,'backgroundColor','rgb(33, 48, 37)');
    await force(selector,['hover']);await equal(selector,'backgroundColor','rgb(53, 88, 63)');await force(selector,[]);
    await force(selector,['hover','active']);await equal(selector,'backgroundColor','rgb(65, 105, 75)');await force(selector,[]);
  }
  for(const selector of ['#native-disabled','#ant-disabled']){
    await force(selector,['hover']);await equal(selector,'backgroundColor','rgb(48, 55, 48)');await force(selector,[]);
  }
  await equal('#ant-input','backgroundColor','rgb(38, 58, 44)');
  await equal('#ant-primary','borderRadius','14px');
  await equal('#native-primary','borderRadius','9px');
  await equal('#nav-selected','backgroundColor','rgb(53, 77, 59)');
  await equal('#nav-selected','color','rgb(213, 239, 219)');
  await equal('.fixture-popover','backgroundColor','rgb(24, 47, 32)');
  await equal('#native-dialog','backgroundColor','rgb(32, 60, 42)');
  await equal('#native-dialog','borderRadius','20px');
  for(const platform of ['mac','windows']){
    await js('document.querySelector("#platform").className="app-shell is-'+platform+'-platform"');
    await equal('#collapse','color','rgb(191, 229, 196)');
    await force('#collapse',['hover']);await equal('#collapse','color','rgb(239, 255, 240)');await force('#collapse',[]);
  }
  await js('document.querySelector("#native-primary").focus()');
  await force('#native-primary',['focus-visible']);await equal('#native-primary','outlineStyle','solid');await equal('#native-primary','outlineWidth','2px');await force('#native-primary',[]);
  fs.writeFileSync(path.join(__dirname,'custom.png'),(await win.webContents.capturePage()).toPNG());
  await js('fixture.showModal(true)');await until('!!document.querySelector(".ant-modal-content")');
  await equal('.ant-modal-content','backgroundColor','rgb(32, 60, 42)');
  await equal('.ant-modal-content','borderRadius','20px');
  await js('fixture.showModal(false)');
  await js('fixture.showSelect(true)');await until('!!document.querySelector(".ant-select-dropdown")');
  await equal('.ant-select-dropdown','backgroundColor','rgb(24, 47, 32)');
  await js('fixture.showSelect(false)');
  await js('void fixture.confirm()');await until('!!document.querySelector(".ant-modal-confirm")');
  await equal('.ant-modal-confirm .ant-modal-content','backgroundColor','rgb(32, 60, 42)');
  assert.equal(await js('fixture.mounts'),mounts,'Theme updates must preserve mounted content');
  await js('fixture.api.setThemeMode("system")');
  nativeTheme.themeSource='light';await until('fixture.api.resolvedTheme === "light"');
  nativeTheme.themeSource='dark';await until('fixture.api.resolvedTheme === "dark"');
  failSave=true;assert.equal(await js('fixture.api.setThemeMode("light").then(()=>false,()=>true)'),true);
  await until('fixture.api.themeMode === "system"');
  await js('fixture.unmount()');assert.equal(await js('document.documentElement.dataset.desktopSkin'),undefined);
  failSave=false;
  await require(${JSON.stringify(path.join(repo, "qa/desktop-skins-checks.cjs"))})(win,path.join(__dirname,'preview'));
  await require(${JSON.stringify(path.join(repo, "qa/desktop-skin-settings-checks.cjs"))})(win,path.join(__dirname,'preview'),fixtureApp);
  console.log(JSON.stringify({ok:true,defaultModes:true,nativeAndAntStates:true,portalTheme:true,platformCss:true,noRemount:true,systemTracking:true,rollback:true}));
  win.destroy();app.exit(0);
})().catch(error=>{console.error(error.stack);app.exit(1);});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "main.cjs")], { env, stdio: ["ignore", "inherit", "inherit"] });
const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
clearTimeout(timer);
console.log("Appearance fixtures and screenshots:", root);
console.log("Interactive skin preview:", path.join(previewDir, "index.html"));
process.exitCode = code ?? 1;
