// Isolated SkinSettings fixture: never reads Desktop's profile or installs a package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-drop-smoke-'));
await build({
  stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {AppearanceProvider} from './src/renderer/appearance/AppearanceProvider';
    import {SkinSettings} from './src/renderer/appearance/SkinSettings';
    import './src/renderer/styles.css';
    window.calls=[];
    const importSkin=async file=>{window.calls.push(file?.name ?? 'picker');return new Promise(resolve=>window.finish=()=>resolve({ok:true,settings,cancelled:true}));};
    const settings={skinId:'default',background:null,backgroundDataUrl:null,installedSkins:[],packageApiVersion:1};
    window.electronAPI={settings:{
      getThemePreference:async()=> 'light',setNativeThemeSource:async theme=>({ok:true,themeSource:theme}),
      getDesktopSkin:async()=>({ok:true,settings}),
      importDesktopSkinPackage:()=>importSkin(),
      importDroppedDesktopSkinPackage:file=>importSkin(file),removeDesktopSkinPackage:async()=>({ok:true,settings})
    }};
    createRoot(document.getElementById('root')).render(<AppearanceProvider><SkinSettings/></AppearanceProvider>);
    window.drag=(type,names=['皮肤 test.ZIP'],directory=false,selector='.desktop-skin-import')=>{
      const data=new DataTransfer();
      const items=names.map(name=>{const item=data.items.add(new File(['fixture'],name));
        Object.defineProperty(item,'webkitGetAsEntry',{value:()=>({isDirectory:directory})});return item;});
      Object.defineProperty(data,'items',{value:items});
      const event=new DragEvent(type,{dataTransfer:data,bubbles:true,cancelable:true});
      document.querySelector(selector).dispatchEvent(event);return event.defaultPrevented;
    };
  ` },
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:path.join(root,'fixture.js'),
  loader:{'.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},
  define:{'process.env.NODE_ENV':'"test"',__DESKTOP_APP_BRAND__:JSON.stringify(require(path.join(repo,'dist-electron/shared/brand.js')).APP_BRAND)}
});
fs.writeFileSync(path.join(root,'index.html'),'<meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><style>body{padding:20px;overflow:auto}#root{max-width:850px}</style><div id="root"></div><script src="fixture.js"></script>');
fs.writeFileSync(path.join(root,'main.cjs'),`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:950,height:700});
 const js=code=>win.webContents.executeJavaScript(code);
 const until=async code=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timeout: '+code);};
 await win.loadFile(path.join(__dirname,'index.html'));
 await until('document.querySelector(".desktop-skin-import-actions button")?.disabled === false');
 for(const platform of ['mac','windows']){
  await js('document.body.className="app-shell is-'+platform+'-platform"');
  await js('drag("dragenter")');
  await until('!!document.querySelector(".desktop-skin-import.is-drag-active")');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,platform+'.png'),(await win.webContents.capturePage()).toPNG());
  await js('drag("dragleave")');
  await until('!document.querySelector(".is-drag-active")');
 }
 // Reproduce an older preload: it has only a no-argument picker API.
 await js('window.savedDropApi=window.electronAPI.settings.importDroppedDesktopSkinPackage;delete window.electronAPI.settings.importDroppedDesktopSkinPackage;true');
 await js('drag("drop")');
 await until('!!document.querySelector(".desktop-skin-error")');
 assert.deepEqual(await js('calls'),[], 'old preload must not open its picker');
 await js('window.electronAPI.settings.importDroppedDesktopSkinPackage=window.savedDropApi;true');
 await js('drag("drop",["button.zip"],false,".desktop-skin-import-actions button")');
 assert.equal(await js('calls.length'),0, 'dropping on the separate button must not import or open a picker');
 // The target is specifically the import area, not background or skin cards.
 await js('drag("drop",["outside.zip"],false,".desktop-background-setting")');
 assert.equal(await js('calls.length'),0);
 await js('drag("dragenter");drag("drop");drag("drop")');
 await until('calls.length===1 && !!window.finish');
 assert.deepEqual(await js('calls'),['皮肤 test.ZIP']);
 await until('document.querySelector(".desktop-skin-import-actions button").disabled');
 await js('finish()');
 await until('!document.querySelector(".desktop-skin-import-actions button").disabled');
 for(const [names,directory] of [[['bad.txt'],false],[['a.zip','b.zip'],false],[['folder.zip'],true]]){
  await js('drag("drop",'+JSON.stringify(names)+','+directory+')');
  await until('!!document.querySelector(".desktop-skin-error")');
  assert.equal(await js('calls.length'),1);
 }
 await js('document.querySelector(".desktop-skin-import-actions button").click()');
 await until('calls.length===2');
 assert.equal(await js('calls[1]'),'picker');
 await js('finish()');
 await until('!document.querySelector(".desktop-skin-import-actions button").disabled');
 await js('document.getElementById("root").style.width="300px";drag("dragenter")');
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await js('document.querySelector(".desktop-skin-import").scrollWidth <= document.querySelector(".desktop-skin-import").clientWidth'),true);
 fs.writeFileSync(path.join(__dirname,'narrow.png'),(await win.webContents.capturePage()).toPNG());
 console.log('PASS: skin import target, ZIP forwarding, picker fallback, cancellation, duplicate/invalid/directory drops and narrow layout');
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[path.join(root,'main.cjs')],{env,stdio:'inherit'});
const timeout=setTimeout(()=>child.kill(),30000);
const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timeout);
console.log(`Screenshots: ${root}`);process.exitCode=code??1;
