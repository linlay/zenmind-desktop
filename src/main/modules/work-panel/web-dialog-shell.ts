import { workPanelDialogTools, WORK_PANEL_DIALOG_TOOLS_CSS } from "./web-dialog-tools";
import { t } from "../../support/i18n/main-i18n";

export const WORK_PANEL_DIALOG_RESTORE_URL = "https://workpanel.invalid/restore";
export const WORK_PANEL_DIALOG_ACTION_URL = "https://workpanel.invalid/action";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Only the trusted host runs this script. Remote guests have neither a preload
// nor access to this document; all actions are revalidated by Main.
export function workPanelDialogShell(nonce: string, agentLabel: string, chatLabel: string, chatId: string, platform: NodeJS.Platform = process.platform) {
  const chrome = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "native";
  const title = `${t("chatWorkPanel.dialog.agent")}: ${agentLabel} · ${t("chatWorkPanel.dialog.chat")}: ${chatLabel} · ${chatId}`;
  return `<!doctype html><html><head><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex;flex-direction:column;font:13px system-ui;background:Canvas;color:CanvasText}
nav,form{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 16%,transparent)}
.window-titlebar{box-sizing:border-box;display:flex;align-items:center;gap:12px;height:40px;min-height:40px;padding:0 12px;-webkit-app-region:drag;user-select:none}
[data-platform=mac] .window-titlebar{padding-left:88px}
[data-platform=windows] .window-titlebar{padding-right:150px}
.window-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.window-titlebar a{-webkit-app-region:no-drag;flex-shrink:0;font-size:11px;padding:4px 8px}
[data-platform=native] .window-title{display:none}
button,a,input{font:inherit;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:6px;padding:6px 10px}button,a{cursor:pointer;text-decoration:none}button:disabled{opacity:.4;cursor:default}button:hover,a:hover{background:color-mix(in srgb,CanvasText 8%,Canvas)}:focus-visible{outline:2px solid Highlight;outline-offset:2px}
nav{overflow-x:auto;flex-shrink:0}#tabs{display:flex;gap:6px}.tab{display:flex;min-width:120px;max-width:240px;border-radius:6px;border:1px solid transparent}.tab[aria-selected=true]{border-color:Highlight;background:color-mix(in srgb,Highlight 12%,Canvas)}.tab button{border:0;background:transparent}.tab .title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
form input{flex:1;min-width:0}main{flex:1;min-height:0;position:relative}webview{position:absolute;inset:0;display:flex;width:100%;height:100%}webview[hidden]{visibility:hidden;pointer-events:none}#error{color:MarkText;background:Mark;padding:6px 12px}#error:empty{display:none}
${WORK_PANEL_DIALOG_TOOLS_CSS}</style></head><body data-platform="${chrome}"><div class="window-titlebar"><span class="window-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><a href="${WORK_PANEL_DIALOG_RESTORE_URL}">${escapeHtml(t("chatWorkPanel.dialog.restore"))}</a></div>
<nav><div id="tabs" role="tablist"></div><button id="new" title="${escapeHtml(t("chatWorkPanel.dialog.newTab"))}">+</button></nav>
<form><button type="button" id="back" aria-label="${escapeHtml(t("chatWorkPanel.dialog.back"))}">←</button><button type="button" id="forward" aria-label="${escapeHtml(t("chatWorkPanel.dialog.forward"))}">→</button><button type="button" id="reload" aria-label="${escapeHtml(t("chatWorkPanel.dialog.reload"))}">↻</button><input id="address" aria-label="${escapeHtml(t("chatWorkPanel.dialog.address"))}" placeholder="https://" spellcheck="false"><button type="submit">${escapeHtml(t("chatWorkPanel.dialog.go"))}</button></form><div id="error" role="status"></div><main></main>
<script nonce="${nonce}">
const pages=new Map();let active='',creating=false;
const address=document.getElementById('address');
function send(action,id=active,url=''){location.href='${WORK_PANEL_DIALOG_ACTION_URL}?'+new URLSearchParams({action,id,url});}
function select(id){if(!pages.has(id))return;active=id;creating=false;address.value=pages.get(id).url;for(const [key,p] of pages){p.web.hidden=key!==id;p.tab.setAttribute('aria-selected',String(key===id));}paint();}
function paint(){const p=pages.get(active);if(!p)return;if(document.activeElement!==address&&!creating)address.value=p.url;document.getElementById('back').disabled=!p.back;document.getElementById('forward').disabled=!p.forward;document.getElementById('error').textContent=p.error||'';}
window.workPanelBrowser={
 add(id,url,title){const web=document.createElement('webview');web.setAttribute('allowpopups','');const tab=document.createElement('div');tab.className='tab';tab.setAttribute('role','tab');const label=document.createElement('button');label.className='title';label.textContent=title||url;label.onclick=()=>send('select',id);const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label',${JSON.stringify(t("chatWorkPanel.dialog.closeTab"))});close.onclick=()=>send('close',id);tab.append(label,close);document.getElementById('tabs').append(tab);pages.set(id,{web,tab,label,url,back:false,forward:false});web.src=url;document.querySelector('main').append(web);select(id);},
 remove(id){const p=pages.get(id);if(!p)return;p.web.remove();p.tab.remove();pages.delete(id);if(active===id)select(pages.keys().next().value);},
 select,
 update(id,data){const p=pages.get(id);if(!p)return;Object.assign(p,data);p.label.textContent=data.title||data.url;p.label.title=data.url;paint();},
 error(id,message){const p=pages.get(id);if(p){p.error=message;paint();}}
};
document.getElementById('new').onclick=()=>{creating=true;address.value='';address.focus();};
for(const action of ['back','forward','reload'])document.getElementById(action).onclick=()=>send(action);
document.querySelector('form').onsubmit=e=>{e.preventDefault();let url=address.value.trim();if(!url)return;if(!/^[a-z][a-z0-9+.-]*:/i.test(url))url='https://'+url;send(creating?'new':'navigate',active,url);creating=false;};
${workPanelDialogTools()}</script></body></html>`;
}
