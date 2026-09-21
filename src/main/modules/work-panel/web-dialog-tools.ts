import { BROWSER_ZOOM_STEPS } from "../../../shared/work-panel-browser";
import { t } from "../../support/i18n/main-i18n";

export function workPanelDialogTools() {
  const labels = {
    more: t("externalWebview.more"), find: t("externalWebview.find"), print: t("externalWebview.print"),
    zoom: t("externalWebview.zoom"), zoomOut: t("externalWebview.zoomOut"), zoomIn: t("externalWebview.zoomIn"),
    reset: t("externalWebview.zoomReset"), external: t("externalWebview.openExternal"), copy: t("externalWebview.copyLink"),
    previous: t("externalWebview.findPrevious"), next: t("externalWebview.findNext"), close: t("externalWebview.findClose"),
    failed: t("externalWebview.actionFailed"),
  };
  return `
const toolLabels=${JSON.stringify(labels).replaceAll("<", "\\u003c")};
const zoomSteps=${JSON.stringify(BROWSER_ZOOM_STEPS)};
const more=document.createElement('button');more.type='button';more.textContent='⋮';more.title=toolLabels.more;more.setAttribute('aria-label',toolLabels.more);more.setAttribute('aria-expanded','false');document.querySelector('form').append(more);
const menu=document.createElement('div');menu.className='browser-menu';menu.hidden=true;document.body.append(menu);
const findbar=document.createElement('div');findbar.className='browser-find';findbar.hidden=true;findbar.setAttribute('role','search');document.querySelector('main').prepend(findbar);
const query=document.createElement('input');query.placeholder=toolLabels.find;query.setAttribute('aria-label',toolLabels.find);const count=document.createElement('output');count.setAttribute('aria-live','polite');count.textContent='0/0';findbar.append(query,count);
let findTarget=null,findRequest=0,printing=false;
function toolButton(parent,label,click,text=label){const b=document.createElement('button');b.type='button';b.textContent=text;b.title=label;b.setAttribute('aria-label',label);b.onclick=click;parent.append(b);return b;}
function closeMenu(){menu.hidden=true;more.setAttribute('aria-expanded','false');}
function clearFind(){if(findTarget){try{findTarget.stopFindInPage('clearSelection');}catch{}}findTarget=null;findRequest=0;query.value='';count.textContent='0/0';findbar.hidden=true;}
function findText(next=false,forward=true){if(!findTarget)return;try{if(query.value)findRequest=findTarget.findInPage(query.value,{findNext:!next,forward});else{findTarget.stopFindInPage('clearSelection');findRequest=0;count.textContent='0/0';}}catch{document.getElementById('error').textContent=toolLabels.failed;}}
toolButton(findbar,toolLabels.previous,()=>findText(true,false),'↑');toolButton(findbar,toolLabels.next,()=>findText(true,true),'↓');toolButton(findbar,toolLabels.close,()=>{clearFind();pages.get(active)?.web.focus();},'×');
query.oninput=()=>findText();query.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();clearFind();pages.get(active)?.web.focus();}else if(e.key==='Enter'){e.preventDefault();findText(true,!e.shiftKey);}};
function zoomValue(){try{return Math.round(pages.get(active).web.getZoomFactor()*100);}catch{return 100;}}
function syncZoom(){const value=zoomValue();zoomOutput.textContent=value+'%';zoomMinus.disabled=value<=25;zoomPlus.disabled=value>=300;zoomReset.disabled=value===100;}
function changeZoom(direction){const p=pages.get(active);if(!p)return;const current=zoomValue();const value=direction===0?100:direction>0?(zoomSteps.find(x=>x>current)||300):([...zoomSteps].reverse().find(x=>x<current)||25);try{p.web.setZoomFactor(value/100);syncZoom();}catch{document.getElementById('error').textContent=toolLabels.failed;}}
window.workPanelBrowser.command=(id,action)=>{if(id!==active)return;const p=pages.get(id);if(!p)return;closeMenu();if(action==='find'){if(findTarget!==p.web){clearFind();findTarget=p.web;}findbar.hidden=false;query.focus();query.select();}else if(action==='print'){if(printing)return;printing=true;p.web.print({silent:false,printBackground:true}).catch(error=>{if(!/cancel/i.test(String(error)))window.workPanelBrowser.error(id,toolLabels.failed);}).finally(()=>{printing=false;});}else changeZoom(action==='zoom-in'?1:action==='zoom-out'?-1:0);};
toolButton(menu,toolLabels.find,()=>window.workPanelBrowser.command(active,'find'));toolButton(menu,toolLabels.print,()=>window.workPanelBrowser.command(active,'print'));
const zoomRow=document.createElement('div');zoomRow.className='browser-zoom';const zoomLabel=document.createElement('span');zoomLabel.textContent=toolLabels.zoom;zoomRow.append(zoomLabel);menu.append(zoomRow);
const zoomMinus=toolButton(zoomRow,toolLabels.zoomOut,()=>changeZoom(-1),'−');const zoomOutput=document.createElement('output');zoomRow.append(zoomOutput);const zoomPlus=toolButton(zoomRow,toolLabels.zoomIn,()=>changeZoom(1),'+');const zoomReset=toolButton(zoomRow,toolLabels.reset,()=>changeZoom(0),'↻');
toolButton(menu,toolLabels.external,()=>{closeMenu();send('external');});toolButton(menu,toolLabels.copy,()=>{closeMenu();send('copy');});
more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden){menu.style.top=(more.getBoundingClientRect().bottom+6)+'px';syncZoom();menu.querySelector('button').focus();}};
document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target)&&e.target!==more)closeMenu();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){closeMenu();more.focus();e.stopPropagation();}});
const originalSelect=window.workPanelBrowser.select;window.workPanelBrowser.select=id=>{if(id!==active){clearFind();closeMenu();}originalSelect(id);};
const originalAdd=window.workPanelBrowser.add;window.workPanelBrowser.add=(...args)=>{clearFind();closeMenu();originalAdd(...args);const web=pages.get(args[0]).web;web.addEventListener('found-in-page',e=>{if(web===findTarget&&e.result.requestId===findRequest)count.textContent=e.result.activeMatchOrdinal+'/'+e.result.matches;});web.addEventListener('dom-ready',()=>{if(web===findTarget)clearFind();});web.addEventListener('focus',closeMenu);};
const originalRemove=window.workPanelBrowser.remove;window.workPanelBrowser.remove=id=>{if(id===active){clearFind();closeMenu();}originalRemove(id);};
`;
}

export const WORK_PANEL_DIALOG_TOOLS_CSS = `
.browser-menu{position:absolute;right:12px;top:142px;z-index:20;width:240px;display:flex;flex-direction:column;gap:2px;padding:6px;font-size:13px;font-weight:400;line-height:18px;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px;box-shadow:0 8px 30px #0003}
.browser-menu[hidden],.browser-find[hidden]{display:none}.browser-menu>button{text-align:left;border:0;min-height:28px;padding:4px 8px}.browser-zoom{display:flex;align-items:center;gap:2px;padding:4px 0;margin:2px 0;border-block:1px solid color-mix(in srgb,CanvasText 16%,transparent)}.browser-zoom span{flex:1;padding-left:8px}.browser-zoom output{min-width:42px;text-align:center}.browser-zoom button{border:0;width:26px;height:26px;padding:0;font-size:13px}
.browser-find{position:absolute;right:12px;top:8px;z-index:10;display:flex;align-items:center;gap:4px;padding:6px;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:8px;box-shadow:0 4px 16px #0002}.browser-find input{width:140px}.browser-find button{border:0}.browser-find output{min-width:36px;font-variant-numeric:tabular-nums}
`;
