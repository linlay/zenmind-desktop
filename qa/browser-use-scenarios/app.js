const config=globalThis.SCENARIO;
const $=selector=>document.querySelector(selector);
const status=text=>{$("#status").textContent=text};
const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function event(action,data={}){const response=await fetch(`/api/event/${action}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error??"本地动作失败");return result;}
const guard=fn=>async e=>{try{await fn(e)}catch(error){status(error.message)}};
const click=(id,fn)=>{$(id).onclick=guard(fn)};
const beacon=(action,data)=>navigator.sendBeacon(`/api/event/${action}`,JSON.stringify(data));

if(config.page==="pricing"){
  event("pricing-view").catch(()=>{});
  click("#scope-check",async e=>{const checked=$("#scope-check").getAttribute("aria-checked")!=="true";$("#scope-check").setAttribute("aria-checked",String(checked));await event("pricing-event",{event:"checked",checked,trusted:e.isTrusted})});
  click("#expand-invoice",async e=>{$("#invoice-fields").hidden=false;$("#expand-invoice").setAttribute("aria-expanded","true");await event("pricing-event",{event:"expanded",trusted:e.isTrusted})});
  click("#aria-disabled-delivery",async e=>{await event("pricing-event",{event:"disabled",trusted:e.isTrusted});status("此渠道不可用，未执行业务动作。")});
  click("#validate-tax",async e=>{const valid=$("#tax-id").value==="FIXTURE-TAX-2026";$("#tax-id").setAttribute("aria-invalid",String(!valid));$("#tax-error").hidden=valid;if(!valid)await event("pricing-event",{event:"invalid",trusted:e.isTrusted});status(valid?"发票信息校验通过":"请修正测试税号")});
  click("#save-pricing",async e=>{await event("pricing-save",{selected:$("input[name=price]:checked")?.value,taxId:$("#tax-id").value,trusted:e.isTrusted});status("价格与状态验收已保存")});
}
if(config.page==="controls"){
  $("#notification").onchange=guard(e=>event("controls-event",{event:"notification",trusted:e.isTrusted}));
  let index=-1;const input=$("#center"),list=$("#centers"),choices=[...list.children];
  const open=()=>{list.hidden=false;input.setAttribute("aria-expanded","true")};const close=()=>{list.hidden=true;input.setAttribute("aria-expanded","false")};
  const mark=()=>choices.forEach((e,i)=>e.setAttribute("aria-selected",String(i===index)));
  input.onclick=open;
  input.onkeydown=guard(async e=>{if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();open();index=(index+(e.key==="ArrowDown"?1:-1)+choices.length)%choices.length;mark();input.setAttribute("aria-activedescendant",choices[index].id)}else if(e.key==="Enter"&&!list.hidden&&index>=0){e.preventDefault();input.value=choices[index].textContent;close();await event("controls-event",{event:"enter",trusted:e.isTrusted})}else if(e.key==="Escape"){e.preventDefault();close();await event("controls-event",{event:"escape",trusted:e.isTrusted})}});
  choices.forEach((choice,i)=>choice.onclick=()=>{index=i;mark();input.value=choice.textContent;close()});
  $("#hover-zone").onpointerenter=guard(async e=>{$("#hover-menu").hidden=false;$("#more").setAttribute("aria-expanded","true");await event("controls-event",{event:"hover-open",trusted:e.isTrusted})});
  $("#hover-zone").onpointerleave=()=>{$("#hover-menu").hidden=true;$("#more").setAttribute("aria-expanded","false")};
  click("#preview-policy",async e=>{$("#hover-menu").hidden=true;$("#more").setAttribute("aria-expanded","false");await event("controls-event",{event:"hover-chosen",trusted:e.isTrusted});status("通知策略预览：仅保存本机配置。")});
  click("#save-controls",async e=>{await event("controls-save",{selected:[...$("#multi").selectedOptions].map(o=>o.value),notification:$("#notification").checked,center:input.value,trusted:e.isTrusted});status("协作配置已保存")});
}
if(config.page==="async"){
  let cursor=0,loading=false,total=24,selected=null,loaded=0;
  async function load(){if(loading||cursor===null)return;loading=true;$("#feed").setAttribute("aria-busy","true");$("#sentinel").textContent="异步加载中…";try{const response=await fetch(`/api/items?cursor=${cursor}`),data=await response.json();const fragment=document.createElement("div");fragment.innerHTML=data.rows.map(row=>`<article role="listitem" class="record"><h2>${escape(row.name)}</h2><p>编号 ${row.id} · 区域 ${row.region} · 交付 ${row.days}天 · 库存 ${row.stock} · 合规 ${row.compliant?"有效":"失效"} · 单价 ￥${row.price}</p><button data-select="${row.id}">选择记录${row.id}</button></article>`).join("");for(const b of fragment.querySelectorAll("button"))b.onclick=()=>{selected=b.dataset.select;status(`已选择 ${selected}，请检查全部记录后保存`)};$("#feed-items").append(...fragment.children);loaded+=data.rows.length;total=data.total;cursor=data.next;await event("async-loaded",{ids:data.rows.map(r=>r.id)});$("#feed-count").textContent=`已加载 ${loaded}/${total}`;$("#sentinel").textContent=cursor===null?"全部24条已加载":"继续滚动加载…";}finally{loading=false;$("#feed").setAttribute("aria-busy","false");if(cursor!==null&&$("#sentinel").getBoundingClientRect().top<innerHeight+200)setTimeout(()=>load().catch(e=>status(e.message)),50)}}
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))load().catch(e=>status(e.message))},{rootMargin:"200px"});observer.observe($("#sentinel"));load().catch(e=>status(e.message));
  click("#save-async",async e=>{await event("async-save",{selected,trusted:e.isTrusted});status("异步记录选择已保存")});
}
if(config.page==="frame"){
  let ready=false;
  click("#request-ready",async()=>{ready=false;$("#frame-ready").hidden=true;$("#save-frame").disabled=true;setTimeout(()=>{ready=true;$("#frame-ready").hidden=false;$("#save-frame").disabled=false},700)});
  click("#save-frame",async e=>{await event("frame-save",{kind:config.kind,recipient:$("#recipient").value,note:$("#note").value,ready,trusted:e.isTrusted});status("此框架的信息已保存")});
}
if(config.page==="dialogs"){
  let dirty=false;
  click("#alert",async e=>{alert("本地沙盒提示：无外部发送。");await event("dialog-event",{event:"alert",trusted:e.isTrusted});status("提示框已关闭")});
  click("#confirm",async e=>{const accepted=confirm("是否批准本地虚构预览？");await event("dialog-event",{event:"confirm",accepted,trusted:e.isTrusted});status(accepted?"确认已批准":"确认已取消")});
  click("#prompt",async e=>{const value=prompt("请输入本地测试备注（无真实信息）","");await event("dialog-event",{event:"prompt",value,trusted:e.isTrusted});status(value===null?"备注输入已取消":"备注输入已保存")});
  click("#protect",()=>{dirty=true;$("#protection-state").textContent="离页保护已启用"});
  addEventListener("beforeunload",e=>{if(!dirty)return;e.preventDefault();e.returnValue="";beacon("dialog-event",{event:"beforeunload"});setTimeout(()=>{if(document.visibilityState!=="hidden"){beacon("dialog-event",{event:"stayed"});$("#protection-state").textContent="已取消离开，仍在受保护页面"}},250)});
}
if(config.page==="tabs")click("#save-tabs",async e=>{await event("tabs-save",{atlas:$("#atlas-code").value,ridge:$("#ridge-code").value,trusted:e.isTrusted});status("供应商核对已保存")});
if(config.page==="supplier")addEventListener("pagehide",()=>beacon("tab-closed",{instance:config.instance}));
if(config.page==="files")click("#upload-files",async()=>{const data=new FormData();for(const f of $("#upload").files)data.append("files",f);const response=await fetch("/api/upload",{method:"POST",body:data}),result=await response.json();if(!response.ok)throw new Error(result.error);$("#upload-state").textContent=`已上传 ${result.files.map(f=>f.name).join("、")}`;status("指定虚构附件已保存到本机沙盒")});
if(config.page==="budget")click("#save-budget",async e=>{await event("budget-save",{receipt:$("#budget-receipt").value,trusted:e.isTrusted});status("末页回执已保存")});
if(config.page==="handoff"){
  const refresh=async()=>{const r=await fetch("/api/public-state"),s=await r.json();$("#identity-state").textContent=s.handoff.operatorConfirmed?"人工身份核验已完成，已登录":s.handoff.requested?"已请求人工接管，等待操作者":"等待人工身份核验";$("#continue-handoff").disabled=!s.handoff.operatorConfirmed};
  click("#request-handoff",async e=>{await event("handoff-request",{trusted:e.isTrusted});await refresh();status("已请求人工接管；小君应停止此场景")});
  click("#operator-confirm",async e=>{await event("operator-confirm",{trusted:e.isTrusted});await refresh()});
  click("#continue-handoff",async e=>{await event("handoff-continue",{trusted:e.isTrusted});status("人工确认后的续问已保存")});refresh().catch(()=>{});
}
if(config.page==="resume"){
  const refresh=async()=>{const r=await fetch("/api/public-state"),s=await r.json();$("#resume-state").textContent=s.resume.prepared?"本地准备已完成":s.resume.started?"准备中，等待操作者停止Run":"尚未开始";$("#resume-state").setAttribute("aria-busy",String(s.resume.started&&!s.resume.prepared));$("#ack-resume").disabled=!s.resume.prepared};
  click("#start-resume",async e=>{await event("resume-start",{trusted:e.isTrusted});await refresh()});click("#ack-resume",async e=>{await event("resume-ack",{trusted:e.isTrusted});status("重连后的继续回执已保存")});refresh().catch(()=>{});setInterval(()=>refresh().catch(()=>{}),1000);
}
