// Run after build:main:types with: node_modules/.bin/electron qa/connector-auth-browser-smoke.cjs
// Uses a local Platform fixture and intercepted HTTPS content; never starts real authorization.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const {build}=require('esbuild');const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'connector-auth-smoke-'));
app.setPath('userData',path.join(tmp,'profile'));
const {registerConnectorAuthBrowser}=require('../dist-electron/main/modules/agent-platform/connector-auth-browser');
const {prepareIsolatedAuthGuest,configureIsolatedAuthGuest}=require('../dist-electron/main/infrastructure/electron/isolated-auth-guest');
const c=require('../dist-electron/shared/contracts/agent-webclient-bridge');
const wait=async predicate=>{const until=Date.now()+15000;while(Date.now()<until){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('Smoke test timed out');};
let server,window;
app.whenReady().then(async()=>{
 const hostPreload=path.join(tmp,'host.cjs');
 fs.writeFileSync(hostPreload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{connectorAuthBrowser:{onDialog(listener){const handler=(_,data)=>listener(data);ipcRenderer.on(${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_HOST_EVENT)},handler);return()=>ipcRenderer.removeListener(${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_HOST_EVENT)},handler);},close(id){return ipcRenderer.invoke(${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_HOST_CLOSE)},id);}}});`);
 await build({stdin:{contents:`import {installConnectorAuthBrowser} from './src/preload/service-webview-connector-auth';installConnectorAuthBrowser();`,resolveDir:root},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(tmp,'guest.cjs')});
 await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ConnectorAuthBrowser} from './src/renderer/connectors/ConnectorAuthBrowser';createRoot(document.getElementById('root')).render(React.createElement(ConnectorAuthBrowser));`,resolveDir:root},bundle:true,platform:'browser',format:'iife',plugins:[{name:'fixture-i18n',setup(b){b.onResolve({filter:/i18n\/useI18n/},()=>({path:'i18n',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useI18n=()=>({t:key=>({'connectorAuth.title':'连接器授权','connectorAuth.failed':'授权页面加载失败，请关闭后重试。'}[key]||key)});`}));}}],define:{'process.env.NODE_ENV':'"production"'},outfile:path.join(tmp,'ui.js')});
 const identity={connectorId:'wecom',sessionId:'smoke'};
 const auth={...identity,authBrowser:'embedded',status:'pending',authorizationUrl:'https://auth.example.test/login',expiresAt:new Date(Date.now()+60000).toISOString()};
 server=http.createServer((req,res)=>{if(req.url.startsWith('/api/admin/connectors/auth')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:auth}));}else if(req.url==='/driver'){res.end('<!doctype html><title>Authorization driver</title>');}else if(req.url==='/ui.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(tmp,'ui.js')));}else {res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#f1f5f9;font-family:system-ui"><h2>Connector authorization smoke test</h2><p>Local fixture — no real account or login.</p><div id="root"></div><script src="/ui.js"></script></body></html>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${server.address().port}`;
 window=new BrowserWindow({width:1000,height:850,show:false,webPreferences:{preload:hostPreload,webviewTag:true,contextIsolation:true,nodeIntegration:false}});
 let driver,authGuest;
 window.webContents.on('will-attach-webview',(event,prefs,params)=>{
  const result=prepareIsolatedAuthGuest(window.webContents.id,prefs,params);
  if(result===false)event.preventDefault();
  if(result===true){const s=session.fromPartition(params.partition);s.protocol.handle('https',()=>new Response('<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;text-align:center;padding:65px 20px;background:#fff"><h1>企业微信授权</h1><div style="margin:35px auto;width:180px;height:180px;background:repeating-conic-gradient(#2364ce 0% 25%,#fff 0% 50%) 50%/30px 30px;border:16px solid #eef4ff"></div><p>本地测试页面 · 非真实二维码</p><p>等待服务端确认授权结果</p>',{headers:{'Content-Type':'text/html; charset=utf-8'}}))}
 });
 window.webContents.on('console-message',(_,level,message)=>console.log('host:',message));
 window.webContents.on('did-attach-webview',(_,guest)=>{guest.on('console-message',(_,level,message)=>console.log('guest:',message));guest.on('preload-error',(_,preload,error)=>console.error('preload:',error));if(configureIsolatedAuthGuest(guest))authGuest=guest;else driver=guest;});
 registerConnectorAuthBrowser(ipcMain,{availability:async()=>({baseUrl,token:'fixture'}),authorize:sender=>{if(sender!==driver)throw Error('Untrusted');return {sender,target:{registrationId:'smoke',ownerWebContentsId:window.webContents.id,currentUrl:driver.getURL()}};}});
 await window.loadURL(baseUrl);
 await new Promise(r=>setTimeout(r,400));
 await window.webContents.executeJavaScript(`(()=>{const view=document.createElement('webview');view.style.cssText='position:absolute;width:2px;height:2px;left:-20px';view.setAttribute('preload',${JSON.stringify(pathToFileURL(path.join(tmp,'guest.cjs')).href)});view.setAttribute('src',${JSON.stringify(baseUrl+'/driver')});document.body.append(view);})()`);
 await wait(()=>driver && driver.getURL()===baseUrl+'/driver' && !driver.isLoading());
 console.log('driver bridge',await driver.executeJavaScript(`typeof window[${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_GLOBAL)}]`));
 console.log('opening');
 await driver.executeJavaScript(`window[${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_GLOBAL)}].subscribe(event=>window.closedAuth=event);window[${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_GLOBAL)}].open(${JSON.stringify(identity)})`);
 await wait(()=>authGuest && authGuest.getURL()===auth.authorizationUrl && !authGuest.isLoading());
 console.log('opened');
 assert.equal(await authGuest.executeJavaScript('document.querySelector("h1")?.textContent'),'企业微信授权');
 assert.equal(await authGuest.executeJavaScript('typeof require'),'undefined');
 assert.equal(await authGuest.executeJavaScript(`typeof window[${JSON.stringify(c.CONNECTOR_AUTH_BROWSER_GLOBAL)}]`),'undefined');
 assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".ant-modal webview").length'),1);
 window.show();await new Promise(r=>setTimeout(r,500));
 const screenshot=path.join(tmp,'desktop.png');fs.writeFileSync(screenshot,(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript('document.querySelector(".ant-modal-close").click()');
 await wait(async()=>await driver.executeJavaScript('window.closedAuth?.sessionId === "smoke"'));
 console.log(JSON.stringify({passed:true,screenshot}));
 window.destroy();server.close();app.quit();
}).catch(error=>{console.error(error);window?.destroy();server?.close();app.exit(1);});
