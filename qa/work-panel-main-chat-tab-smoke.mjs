// Real WorkPanelHost, AppShell resize/selection code and a live Main Chat guest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = process.cwd();
const output = fs.mkdtempSync(path.join(os.tmpdir(), "work-panel-main-chat-"));
const source = ts.createSourceFile("AppShell.tsx", fs.readFileSync("src/renderer/app-shell/AppShell.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let pointerHandler, resetSelection, tabProps, clearSelection;
function visit(node) {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(source), node.initializer?.getText(source));
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleWorkPanelResizerPointerDown") pointerHandler = node.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("!showWorkPanelMainChatTab")) resetSelection = node.getText(source);
  if (ts.isJsxAttribute(node) && node.name.getText(source) === "mainChatTab") tabProps = node.initializer.expression.getText(source);
  if (ts.isIfStatement(node) && node.expression.getText(source).includes('command.type === "activateItem"') &&
      node.thenStatement.getText(source).includes("setWorkPanelMainChatOwnerKey")) clearSelection = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!pointerHandler || !resetSelection || !tabProps || !clearSelection) throw new Error("AppShell integration not found");
const actual = name => {
  if (!declarations.has(name)) throw new Error(`Missing AppShell declaration: ${name}`);
  return `const ${name} = ${declarations.get(name)};`;
};

await build({
  stdin: { resolveDir: repo, loader: "tsx", contents: `
import React,{useState,useRef,useCallback,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {WorkPanelHost} from './src/renderer/work-panel/WorkPanelHost';
import {WorkPanelResizeGuide} from './src/renderer/work-panel/WorkPanelResizeGuide';
import {DesktopBackground} from './src/renderer/appearance/DesktopBackground';
import {createAppearanceSnapshot} from './src/renderer/appearance/model';
import {createDocumentAppearanceTarget} from './src/renderer/appearance/browser';
import {findDesktopSkin} from './src/renderer/appearance/skins';
import {RendererI18nContext} from './src/renderer/i18n/i18n-context';
import {createTranslator} from './src/shared/i18n';
import {EMPTY_WORK_PANEL_STATE,reduceWorkPanelCommand} from './src/shared/work-panel';
import {resolveWorkPanelActiveItemId} from './src/renderer/work-panel/new-tab-selection';
import {clampWorkPanelWidth,resolveWorkPanelMaxWidth,resolveWorkPanelDragState,WORK_PANEL_COLLAPSED_MAIN_GAP,WORK_PANEL_COLLAPSE_DRAG_BUFFER,WORK_PANEL_MIN_WIDTH,WORK_PANEL_MAIN_MIN_WIDTH} from './src/shared/work-panel-layout';
import './src/renderer/styles.css';
const appearanceTarget=createDocumentAppearanceTarget(document.documentElement);
const noop=()=>()=>{};
window.errors=[];addEventListener('error',e=>window.errors.push(e.message));
addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
window.electronAPI={
 onWebviewOpenTab:noop,onWorkPanelFullscreenExitShortcut:noop,
 chatWorkPanel:{localFiles:{getReviewPreloadUrl:async()=>'',release:async()=>({ok:true})},resourceImages:{release:async()=>({ok:true})},documentHtml:{release:async()=>({ok:true})}},
 chatWorkPanelTabContextMenu:{onWebDialogCloseRequested:noop,onWebDialogOpenRequested:noop},
 webs:{webapps:{listOpenWindows:async()=>[]}},sso:{onStatusChanged:noop},
 desktopActions:{onCall:noop,respond:async()=>({ok:true})},
};
let initial=EMPTY_WORK_PANEL_STATE;
for(const ownerChatId of ['a','b']){
 initial=reduceWorkPanelCommand(initial,{type:'openItem',ownerChatId,descriptor:{kind:'webclient',module:'overview',route:'/overview/'+ownerChatId,context:{chatId:ownerChatId,agentKey:'main'},title:'概览',pinned:true,closable:false}}).nextState;
 initial=reduceWorkPanelCommand(initial,{type:'openItem',ownerChatId,descriptor:{kind:'webclient',module:'file',route:'/file/'+ownerChatId,context:{chatId:ownerChatId,agentKey:'main',path:'draft.md'},title:'Draft'}}).nextState;
}
function Scene(){
 const [state,setState]=useState(initial),stateRef=useRef(state);stateRef.current=state;
 const [owner,setOwner]=useState('a'),[shown,setShown]=useState(true),[windows,setWindows]=useState(false);
 const [sidebarWidth,setSidebarWidth]=useState(160);
 const [locale,setLocale]=useState('zh-CN');
 const [skinBackground,setSkinBackground]=useState(null);
 const [workPanelFullscreenOwnerChatId,setFullscreen]=useState(null);
 const [workPanelMainChatOwnerKey,setWorkPanelMainChatOwnerKey]=useState(null);
 const [selectedWorkPanelNewTabs,setSelectedWorkPanelNewTabs]=useState({});
 const [preferredWorkPanelWidth,setPreferredWorkPanelWidth]=useState(560);
 const [workPanelDragMainChatOpacity,setWorkPanelDragMainChatOpacity]=useState(1);
 const [workPanelDragPreviewWidth,setWorkPanelDragPreviewWidth]=useState(null);
 const [workPanelDragGuide,setWorkPanelDragGuide]=useState(null);
 const [isWorkPanelResizing,setIsWorkPanelResizing]=useState(false);
 const workPanelResizeStateRef=useRef(null),workPanelResizeCleanupRef=useRef(null);
 const activeChatWorkPanelOwnerKey=owner,activeChatWorkPanelVisible=shown;
 const appContentWidth=1000,effectiveSidebarWidth=sidebarWidth,renderedCopilotDockWidth=0,isSidebarResizing=false,isCopilotDockResizing=false;
 ${['workPanelMaxWidth','renderedWorkPanelWidth','isMainChatCollapsedByWorkPanel','showWorkPanelMainChatTab','isWorkPanelMainChatActive'].map(actual).join('\n')}
 ${resetSelection};
 ${pointerHandler}
 ${actual('appShellStyle')}
 const dispatch=useCallback(command=>{
  const result=reduceWorkPanelCommand(stateRef.current,command);
  if(result.ok){
   stateRef.current=result.nextState;setState(result.nextState);
   ${clearSelection}
  }return result;
 },[]);
 const workspace=state.workspaces.find(w=>w.ownerChatId===owner);
 const mainChatTab=${tabProps};
 window.qa={owner:setOwner,show:setShown,windows:setWindows,sidebar:setSidebarWidth,locale:setLocale,fullscreen:setFullscreen,split:()=>setPreferredWorkPanelWidth(560),state,
  skin:(theme,id)=>{const snapshot=createAppearanceSnapshot(theme,false,findDesktopSkin(id));appearanceTarget.apply(snapshot);setSkinBackground(snapshot.background);},
  openDraft:()=>dispatch({type:'activateItem',ownerChatId:owner,itemId:workspace.items.find(i=>i.title==='Draft').itemId})};
 return <RendererI18nContext.Provider value={{locale,source:'user',t:createTranslator(locale),setLocale:async value=>setLocale(value)}}><MemoryRouter><div style={{...appShellStyle,width:1000+sidebarWidth}} className={'app-shell has-chat-work-panel has-embedded-surface has-service-webview-surface has-webclient-background-surface '+(windows?'is-windows-platform':'is-mac-platform is-mac-translucent-sidebar')+(isMainChatCollapsedByWorkPanel?' is-main-chat-collapsed-by-work-panel':'')+(isWorkPanelMainChatActive?' is-main-chat-in-work-panel':'')+(workPanelFullscreenOwnerChatId?' is-work-panel-fullscreen':'')+(isWorkPanelResizing?' is-work-panel-resizing':'')}>
 <DesktopBackground background={skinBackground}/>
 <div className='app-sidebar-shell'>Sidebar</div><div className='app-sidebar-resizer'><span className='app-sidebar-resizer-line'/></div>
 <div className='app-content'><main className='app-main' id='desktop-main-chat-panel'>
 <section className='embedded-surface-page embedded-surface-page-embedded agent-webclient-background-surface'><div className='embedded-surface-frame-shell'>
 {React.createElement('webview',{id:'main-chat-guest',className:'embedded-surface-frame',src:'./guest.html',style:{display:'flex',width:'100%',height:'100%'}})}
 </div></section>
 </main>
 {shown&&isWorkPanelResizing&&workPanelDragGuide&&<WorkPanelResizeGuide {...workPanelDragGuide}/>}
 {shown&&<div className={'chat-work-panel-resizer'+(isWorkPanelResizing?' is-active':'')} role='separator' tabIndex={0} onPointerDown={handleWorkPanelResizerPointerDown}><span className='chat-work-panel-resizer-line'/></div>}
 <WorkPanelHost activeChatId={shown?owner:null} state={state} selectedNewTabs={selectedWorkPanelNewTabs} setSelectedNewTabs={setSelectedWorkPanelNewTabs}
 dispatchCommand={dispatch} fullscreenOwnerChatId={workPanelFullscreenOwnerChatId} onFullscreenChange={async value=>{setFullscreen(value);return true;}}
 mainChatTab={mainChatTab} isMac={!windows} isWindows={windows}
 launcher={{agentKey:'main',agentMode:'GENERAL',agentLabel:'Main',chatLabel:owner,projectVisible:false,projectEnabled:false,webapps:[],onOpenWebapp:async()=>false,onFocusWebappWindow:async()=>false}}/>
 </div>{isWorkPanelResizing&&<div className='chat-work-panel-resize-overlay'/>}</div></MemoryRouter></RendererI18nContext.Provider>;
}
createRoot(document.getElementById('root')).render(<Scene/>);
` },
  bundle: true, jsx: "automatic", outfile: path.join(output, "scene.js"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false",
    __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId()))) },
  plugins: [{ name: "fixture-service", setup(builder) {
    builder.onResolve({ filter: /service-webview\/ServiceWebviewSurface$/ }, () => ({ path: "service", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ resolveDir: repo, loader: "tsx", contents:
      `import React from 'react';export function ServiceWebviewSurface(props){return <div className="fixture-document"><h2>{props.embedPath}</h2><textarea defaultValue="Document draft"/></div>}` }));
  } }],
  loader: { ".svg": "dataurl", ".png": "dataurl" },
});
fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="scene.css"><style>html,body,#root{margin:0;width:100%;height:100%;font:14px system-ui}*{box-sizing:border-box}.fixture-document{padding:30px;height:100%;background:var(--bg-base);color:var(--ink)}</style><div id="root"></div><script src="scene.js"></script></html>');
fs.writeFileSync(path.join(output, "guest.html"), '<!doctype html><style>body{margin:0;background:#e9f1fc;color:#152238;font:20px system-ui}main{height:3000px;padding:30px}input{font:inherit}#fade-probe{display:none;position:fixed;left:8px;top:80px;width:8px;height:100px;background:rgb(230,20,70)}</style><main><h1>Main Chat</h1><input id="draft" value="Original"><p>Scroll and draft stay in this guest.</p></main><div id="fade-probe"></div><script>window.instance=crypto.randomUUID()</script>');
fs.writeFileSync(path.join(output, "runner.cjs"), `
const {app,BrowserWindow,webContents}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createCanvas,loadImage}=require(${JSON.stringify(require.resolve("@napi-rs/canvas"))});
app.setPath('userData',path.join(__dirname,'profile'));
let win;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<160;i++){try{if(await js(code))return;}catch{}await delay(30);}throw Error('Timed out: '+code)}
const clickTab=title=>js('Array.from(document.querySelectorAll(".chat-work-panel.is-visible [role=tab]")).find(t=>t.textContent==='+JSON.stringify(title)+').click()');
const tabs=()=>js('Array.from(document.querySelectorAll(".chat-work-panel.is-visible [role=tab]"),t=>({title:t.textContent,active:t.getAttribute("aria-selected"),close:!!t.parentElement.querySelector(".chat-work-panel-tab-close")}))');
const beginDrag=()=>js('document.querySelector(".chat-work-panel-resizer").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,button:0,pointerId:1,clientX:440}))');
const moveDrag=async dx=>{
 await js('window.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,clientX:'+(440+dx)+'}))');await delay(50);
};
const finishDrag=async(type='pointerup')=>{
 await js('window.dispatchEvent(new '+(type==='blur'?'FocusEvent':'PointerEvent')+'('+JSON.stringify(type)+',{pointerId:1}))');await delay(50);
};
const drag=async(dx)=>{
 await beginDrag();await moveDrag(dx);await finishDrag();
};
const opacity=()=>js('Number(getComputedStyle(document.querySelector(".app-main")).opacity)');
const assertGuide=async(left,text)=>{
 const guide=await js('(()=>{const g=document.querySelector(".main-chat-resize-guide");if(!g)return null;return {left:parseFloat(g.style.left),text:g.textContent,writing:getComputedStyle(g.querySelector("span")).writingMode,pointer:getComputedStyle(g).pointerEvents}})()');
 assert.ok(guide,'gesture must show a threshold guide');assert.equal(guide.left,left);assert.equal(guide.text,text);
 assert.equal(guide.writing,'vertical-rl');assert.equal(guide.pointer,'none');
 assert.equal(await js('!!document.querySelector(".main-chat-resize-hint")'),false,'only the threshold guide should remain');
};
const captureGuide=async name=>{
 const filename=path.join(__dirname,name+'.png');
 if(fs.existsSync(filename))return;
 await delay(80);fs.writeFileSync(filename,(await win.webContents.capturePage()).toPNG());
};
const assertSeparator=()=>js('(()=>{const s=document.querySelector(".chat-work-panel-resizer"),r=s.getBoundingClientRect(),p=document.querySelector(".work-panel-host").getBoundingClientRect(),n=document.querySelector(".app-sidebar-resizer").getBoundingClientRect();return {center:r.left+r.width/2,panelLeft:p.left,separate:n.right<=r.left,hits:[.2,.5,.8].every(f=>[.5,r.width/2,r.width-.5].every(dx=>document.elementFromPoint(r.left+dx,r.top+r.height*f)?.closest(".chat-work-panel-resizer")===s)),cursor:getComputedStyle(s).cursor,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()').then(result=>{
 assert.equal(result.center,result.panelLeft,'separator must stay on the panel boundary after switching tabs');
 assert.equal(result.separate,true,'navigation and WorkPanel hitboxes must stay separate');
 assert.equal(result.hits,true,'the entire WorkPanel separator must receive real hit tests');
 assert.equal(result.cursor,'ew-resize');return result;
});
const mouseDrag=async(dx,verifyReveal=false)=>{
 await delay(80);
 const {x,y}=await assertSeparator();
 await js('window.pointerTrace=[]');
 const input=event=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',event);
 await input({type:'mouseMoved',x:x+20,y,buttons:0});
 await input({type:'mouseMoved',x,y,buttons:0});await delay(60);
 assert.equal(await js('window.pointerTrace.some(e=>e.x==='+x+'&&e.y==='+y+'&&e.separator&&e.hover)'),true,'Chromium must deliver pointer hover to the separator');
 await input({type:'mousePressed',button:'left',buttons:1,clickCount:1,x,y});await delay(30);
 if(verifyReveal)for(const [distance,width,alpha] of [[1,7,.2],[24,30,.4],[48,54,.6],[72,78,.8],[96,102,1]]){
  await input({type:'mouseMoved',button:'left',buttons:1,x:x+distance,y});await delay(80);
  const preview=await js('(()=>{const main=document.querySelector(".app-main"),r=document.querySelector(".chat-work-panel-resizer").getBoundingClientRect();return {width:Math.round(main.getBoundingClientRect().width),guestWidth:Math.round(document.querySelector("#main-chat-guest").getBoundingClientRect().width),line:r.left+r.width/2,opacity:Number(getComputedStyle(main).opacity),hint:document.querySelector(".main-chat-resize-guide")?.textContent}})()');
  assert.equal(preview.width,width,'only the uncovered viewport changes width');
  assert.equal(preview.guestWidth,420,'Main Chat layout must keep its minimum width');
  assert.equal(preview.line,x+distance,'the separator must stay under the pointer at every step');
  assert.equal(preview.opacity,alpha,'Chat and Overview must use the same reveal steps');
  assert.equal(preview.hint,'展开对话区');await assertGuide(102,'展开对话区');
  if(distance===96){
   await captureGuide('expand-guide-zh');
   await js('window.qa.locale("en-US")');await until('document.querySelector(".main-chat-resize-guide")?.textContent==="Expand chat"');
   await assertGuide(102,'Expand chat');
   await captureGuide('expand-guide-en');
   await js('window.qa.locale("zh-CN")');await until('document.querySelector(".main-chat-resize-guide")?.textContent==="展开对话区"');
  }
 }
 await input({type:'mouseMoved',button:'left',buttons:1,x:x+dx,y});await delay(80);
 await input({type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:x+dx,y});await delay(80);
};
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:1160,height:720,useContentSize:true,show:false,webPreferences:{webviewTag:true,contextIsolation:true,sandbox:true}});
 // Ignore OS pointer traffic so the user's physical mouse cannot alter this
 // isolated window's hover/capture while Chromium coordinate input runs.
 win.setIgnoreMouseEvents(true);
 await win.loadFile(path.join(__dirname,'index.html'));
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 await js('window.pointerTrace=[];window.addEventListener("pointermove",e=>{const s=e.target instanceof Element?e.target.closest(".chat-work-panel-resizer"):null;window.pointerTrace.push({x:e.clientX,y:e.clientY,separator:!!s,hover:!!s&&s.matches(":hover")})},{capture:true})');
 await until('window.qa && document.querySelector("#main-chat-guest").getWebContentsId()>0 && !document.querySelector("#main-chat-guest").isLoading()');
 const id=await js('document.querySelector("#main-chat-guest").getWebContentsId()'),guest=webContents.fromId(id);
 const instance=await guest.executeJavaScript('window.instance');
 await guest.executeJavaScript('document.querySelector("#draft").value="Preserved Main Chat draft";scrollTo(0,360)');
 for(const windows of [false,true])for(const theme of ['light','dark'])for(const sidebarWidth of [160,64]){
  // Keep the viewport in desktop mode; constrain the fixture shell itself so
  // both sidebar widths leave the same 1000px content area.
  await js('window.qa.sidebar('+sidebarWidth+')');await delay(250);
  await js('window.qa.windows('+windows+');document.documentElement.dataset.theme='+JSON.stringify(theme));
  await until('!!document.querySelector(".chat-work-panel-item.is-active textarea")');
  await js('document.querySelector(".chat-work-panel-item.is-active textarea").value="Preserved document draft"');
  assert.equal((await tabs()).some(t=>t.title==='对话'),false);
  await beginDrag();
  for(const distance of [1,24,120]){
   await moveDrag(distance);
   assert.equal(await js('!!document.querySelector(".main-chat-resize-guide")'),false,'ordinary resizing above 420px must not show an expand guide');
   assert.equal(await opacity(),1);
  }
  await finishDrag();await js('window.qa.split()');await delay(50);
  await beginDrag();
  for(const [extra,alpha] of [[0,1],[23,1],[24,.8],[48,.6],[72,.4],[95,.4],[96,.2]]){
   await moveDrag(-20-extra);assert.equal(await opacity(),alpha);
   const preview=await js('(()=>{const m=document.querySelector(".app-content").getBoundingClientRect(),r=document.querySelector(".chat-work-panel-resizer").getBoundingClientRect();return {line:r.left+r.width/2-m.left,guest:Math.round(document.querySelector("#main-chat-guest").getBoundingClientRect().width),hint:document.querySelector(".main-chat-resize-guide")?.textContent}})()');
   assert.equal(preview.line,420-extra,'separator must follow the closing pointer at '+extra+'px: '+JSON.stringify({windows,theme,sidebarWidth,...preview}));
   assert.equal(preview.guest,420,'chat guest must keep its minimum width at '+extra+'px: '+JSON.stringify(preview));
   if(extra>0){assert.equal(preview.hint,'收起对话区');await assertGuide(324,'收起对话区');}
  }
  for(const dx of [-68,8,-116]){await moveDrag(dx);await assertGuide(324,'收起对话区');}
  await captureGuide('collapse-guide-zh');
  await js('window.qa.locale("en-US")');await until('document.querySelector(".main-chat-resize-guide")?.textContent==="Collapse chat"');
  await assertGuide(324,'Collapse chat');
  await captureGuide('collapse-guide-en');
  await js('window.qa.locale("zh-CN")');await until('document.querySelector(".main-chat-resize-guide")?.textContent==="收起对话区"');
  await finishDrag();
  assert.equal(await js('!!document.querySelector(".main-chat-resize-guide")'),false);
  await until('document.querySelector(".app-shell").classList.contains("is-main-chat-collapsed-by-work-panel")');
  await beginDrag();
  for(const [distance,alpha] of [[0,.2],[23,.2],[24,.4],[48,.6],[72,.8],[95,.8],[96,1],[120,1],[414,1],[450,1],[120,1],[48,.6],[0,.2]]){
   await moveDrag(distance);assert.equal(await opacity(),alpha);
   if(distance>0&&distance<414)await assertGuide(102,'展开对话区');
   if(distance>=414)assert.equal(await js('!!document.querySelector(".main-chat-resize-guide")'),false,'expand guide must disappear once Main Chat reaches 420px');
  }
  await finishDrag();
  for(const type of ['pointerup','pointercancel','blur']){
   await beginDrag();await moveDrag(48);assert.equal(await opacity(),.6);await finishDrag(type);
   assert.equal(await js('document.querySelector(".app-shell").classList.contains("is-main-chat-collapsed-by-work-panel")'),true);
  }
  await drag(96);assert.equal(await opacity(),1);await drag(-96);
  let items=await tabs();assert.equal(items[0].title,'对话');assert.equal(items[1].title,'概览');assert.equal(items[0].close,false);assert.equal(items[1].close,false);
  await clickTab('概览');await assertSeparator();
  await mouseDrag(112,true);await drag(-112);
  await clickTab('对话');
  await until('document.querySelector(".app-shell").classList.contains("is-main-chat-in-work-panel")');
  assert.equal((await tabs()).filter(t=>t.active==='true').length,1);
  await assertSeparator();
  const geometry=await js('(()=>{const m=document.querySelector(".app-main"),g=document.querySelector("#main-chat-guest"),t=document.querySelector(".chat-work-panel.is-visible .chat-work-panel-tabs"),r=g.getBoundingClientRect(),tr=t.getBoundingClientRect();return {mainWidth:m.getBoundingClientRect().width,guestTop:r.top,tabsBottom:tr.bottom,visible:getComputedStyle(m).visibility,hit:document.elementFromPoint(r.left+100,r.top+100)===g}})()');
  assert.equal(geometry.mainWidth,994);assert.equal(geometry.guestTop,geometry.tabsBottom);assert.equal(geometry.visible,'visible');assert.equal(geometry.hit,true,'Main Chat must receive input below the tabs');
  assert.equal(await js('document.querySelectorAll("#main-chat-guest").length'),1);
  assert.equal(await js('document.querySelector("#main-chat-guest").getWebContentsId()'),id);
  assert.equal(await guest.executeJavaScript('window.instance'),instance);
  assert.equal(await guest.executeJavaScript('document.querySelector("#draft").value'),'Preserved Main Chat draft');
  assert.equal(await guest.executeJavaScript('scrollY'),360);
  await guest.executeJavaScript('scrollTo(0,0)');await delay(120);
  fs.writeFileSync(path.join(__dirname,(windows?'windows':'mac')+'-'+theme+'-'+sidebarWidth+'.png'),(await win.webContents.capturePage()).toPNG());
  await guest.executeJavaScript('scrollTo(0,360)');
  await clickTab('概览');await until('!document.querySelector(".app-shell").classList.contains("is-main-chat-in-work-panel")');
  await clickTab('Draft');await until('!!document.querySelector(".chat-work-panel-item.is-active textarea")');
  assert.equal(await js('document.querySelector(".chat-work-panel-item.is-active textarea").value'),'Preserved document draft');
  await clickTab('对话');await until('document.querySelector(".app-shell").classList.contains("is-main-chat-in-work-panel")');
  await js('document.querySelector(".chat-work-panel.is-visible .chat-work-panel-add-button").click()');
  await until('!!document.querySelector(".work-panel-new-tab")');assert.equal((await tabs())[0].active,'false');
  await clickTab('对话');await until('!document.querySelector(".work-panel-new-tab")');
  await js('window.qa.openDraft()');await until('!document.querySelector(".app-shell").classList.contains("is-main-chat-in-work-panel")');
  await clickTab('对话');await js('window.qa.show(false)');await delay(50);await js('window.qa.show(true)');await delay(50);
  assert.equal((await tabs())[0].active,'false');
  await clickTab('对话');await js('window.qa.owner("b")');await delay(50);assert.equal((await tabs())[0].active,'false');
  await js('window.qa.owner("a")');await delay(50);assert.equal((await tabs())[0].active,'false');
  await clickTab('对话');await mouseDrag(16);assert.equal((await tabs())[0].active,'true');
  await mouseDrag(112,true);
  await until('!document.querySelector(".app-shell").classList.contains("is-main-chat-collapsed-by-work-panel")');
  assert.equal((await tabs()).some(t=>t.title==='对话'),false);
  assert.equal(await js('getComputedStyle(document.querySelector(".app-main")).visibility'),'visible');
  await js('window.qa.split()');await delay(50);
 }
 // Verify the rendered guest pixels over real bundled skin backgrounds.
 // Computed opacity alone cannot catch transparent-WebView composition failures.
 win.setContentSize(1160,720);await js('window.qa.sidebar(160)');await delay(250);
 const samplePixel=async(pointExpression='(()=>{const r=document.querySelector("#main-chat-guest").getBoundingClientRect();return {x:r.left+12,y:r.top+100,width:innerWidth}})()')=>{
  await delay(60);
  const point=await js(pointExpression);
  const shot=await loadImage((await win.webContents.capturePage()).toPNG());
  const canvas=createCanvas(shot.width,shot.height),ctx=canvas.getContext('2d');ctx.drawImage(shot,0,0);
  const scale=shot.width/point.width;
  return [...ctx.getImageData(Math.floor(point.x*scale),Math.floor(point.y*scale),1,1).data].slice(0,3);
 };
 await guest.executeJavaScript('document.querySelector("#fade-probe").style.display="block"');
 for(const windows of [false,true])for(const theme of ['light','dark'])for(const skin of ['default','mist','ocean','violet']){
  await js('window.qa.windows('+windows+');window.qa.skin('+JSON.stringify(theme)+','+JSON.stringify(skin)+');window.qa.split()');
  if(skin!=='default')await until('!!document.querySelector(".desktop-background-image[data-background-state=ready]")');
  await guest.executeJavaScript('document.body.style.background='+JSON.stringify(skin==='default'?'#e9f1fc':'transparent'));
  await beginDrag();const pixels=[];
  for(const extra of [0,24,48,72,96]){await moveDrag(-20-extra);pixels.push(await samplePixel());}
  // The endpoint still contains 20% chat; interpolate across the remaining 80%.
  const full=pixels[0],empty=pixels[4];
  assert.ok(full.some((v,i)=>Math.abs(v-empty[i])>60),'guest probe must visibly contrast with '+skin);
  for(let index=0;index<5;index++)for(let c=0;c<3;c++){
   const alpha=1-index/4,expected=empty[c]+(full[c]-empty[c])*alpha;
   // Entering the translucent WebView compositor can shift endpoint channels;
   // allow <16 levels, still below half the probe's smallest fade interval.
   assert.ok(Math.abs(pixels[index][c]-expected)<16,'rendered skin fade mismatch '+JSON.stringify({windows,theme,skin,index,pixels,expected}));
  }
  await finishDrag();
  const gapPoint='(()=>{const r=document.querySelector(".app-content").getBoundingClientRect();return {x:r.left+3,y:r.top+100,width:innerWidth}})()';
  const expectedGap=theme==='dark'?24:255;
  for(const channel of await samplePixel(gapPoint))assert.ok(Math.abs(channel-expectedGap)<3,'collapsed separator gap must be neutral '+JSON.stringify({windows,theme,skin,channel}));
  await js('document.querySelector(".chat-work-panel.is-visible .chat-work-panel-add-button").click()');
  await until('!!document.querySelector(".chat-work-panel.is-visible.is-new-tab-active .work-panel-new-tab")');
  if(skin!=='default'){
   const surfaces=await js('(()=>{const p=document.querySelector(".chat-work-panel.is-visible"),n=p.querySelector(".work-panel-new-tab");return {panel:getComputedStyle(p).backgroundColor,page:getComputedStyle(n).backgroundColor,veil:getComputedStyle(n).getPropertyValue("--shell-sidebar-bg").trim(),content:getComputedStyle(document.querySelector(".app-content")).backgroundColor}})()');
   assert.equal(surfaces.panel,'rgba(0, 0, 0, 0)');assert.equal(surfaces.content,'rgba(0, 0, 0, 0)');
   assert.ok(surfaces.page.startsWith('rgba('),'launcher must have a translucent reading surface');
   const launcherPoint='(()=>{const r=document.querySelector(".work-panel-new-tab").getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-24,width:innerWidth}})()';
   const before=await samplePixel(launcherPoint);
   await js('document.querySelector(".desktop-background").style.filter="invert(1)"');
   const after=await samplePixel(launcherPoint);
   await js('document.querySelector(".desktop-background").style.filter=""');
   assert.ok(before.some((v,i)=>Math.abs(v-after[i])>15),'wallpaper must be visible through the new-tab page '+JSON.stringify({windows,theme,skin,before,after}));
   await captureGuide((windows?'windows':'mac')+'-'+theme+'-'+skin+'-new-tab');
  }
  for(const channel of await samplePixel(gapPoint))assert.ok(Math.abs(channel-expectedGap)<3,'new-tab background must not leak into gap');
  await clickTab('Draft');await beginDrag();
  for(const distance of [24,48,72,96]){
   await moveDrag(distance);const pixel=await samplePixel(),alpha=distance/96;
   for(let c=0;c<3;c++)assert.ok(Math.abs(pixel[c]-(empty[c]+(full[c]-empty[c])*alpha))<16,'rendered skin fade-in mismatch '+JSON.stringify({windows,theme,skin,distance,pixel,full,empty}));
  }
  await finishDrag();
 }
 assert.equal(await js('document.querySelector("#main-chat-guest").getWebContentsId()'),id);
 assert.equal(await guest.executeJavaScript('window.instance'),instance);
 assert.deepEqual(await js('window.errors'),[]);
 console.log('PASS: pointer and separator move one-to-one, chat guest stays at 420px, overlay clipping and fade, Chinese/English resize hints, both tabs/sidebar widths, stable guest/drafts/scroll, macOS/Windows layouts');
 console.log('Screenshots: '+__dirname);win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(output, "runner.cjs")], { env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => {
  child.on("exit", code => resolve(code ?? 1));
  child.on("error", reject);
});
