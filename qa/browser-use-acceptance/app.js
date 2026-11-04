const { mode, view, label } = globalThis.ACCEPTANCE;
const app = document.querySelector("#app");
const e = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const money = value => "¥" + Number(value).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
const message = text => { document.querySelector("#feedback").textContent = text; };
let session;
async function api(action, method = "GET", value) {
  const response = await fetch(`/${mode}/api/${action}`, { method, headers: method === "POST" ? {"Content-Type":"application/json","X-Fixture-CSRF":session?.csrf ?? ""} : {}, body: method === "POST" ? JSON.stringify(value ?? {}) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "本地页面请求失败");
  return data;
}
const guard = handler => async event => { try { await handler(event); } catch(error) { message(error.message); } };
const field = (name, title, value = "", extra = "") => `<label>${title}<input name="${name}" aria-label="${title}" value="${e(value)}" ${extra}></label>`;
const select = (name,title,options,value="") => `<label>${title}<select name="${name}" aria-label="${title}">${options.map(([id,text])=>`<option value="${id}" ${String(value)===String(id)?"selected":""}>${text}</option>`).join("")}</select></label>`;
const stepHeading = (title, subtitle) => `<div class="heading"><div><p class="eyebrow">${label} · 本地沙盒</p><h1>${title}</h1><p>${subtitle}</p></div><span class="badge">${e(session?.username ?? "公开测试账号")}</span></div>`;

async function showQuote(id) {
  const quote=await api(`quote?id=${encodeURIComponent(id)}`);
  document.querySelector("#quote-dialog")?.remove();
  const dialog=document.createElement("dialog"); dialog.id="quote-dialog";
  dialog.innerHTML=`<div class="dialog-heading"><h2>${e(quote.vendor)} · 报价详情</h2><button aria-label="关闭报价详情">关闭</button></div><dl>
  <dt>报价编号</dt><dd>${e(quote.id)}</dd><dt>设备型号</dt><dd>${e(quote.model)}</dd><dt>含税单价</dt><dd>${money(quote.unit)}</dd><dt>运费</dt><dd>${money(quote.shipping)}，每单固定收取</dd>
  <dt>配置</dt><dd>${quote.ram}GB内存 / ${quote.ssd}GB固态</dd><dt>原厂保修</dt><dd>${quote.warranty}年</dd><dt>当前库存</dt><dd>${quote.stock}台</dd><dt>交货时间</dt><dd>${quote.days}个工作日</dd>
  <dt>原厂授权证明</dt><dd class="${quote.authorized?"good":"bad"}">${quote.authorized?"有效，供应商已提供授权证明":"未提供，不满足原厂授权要求"}</dd></dl><p class="muted">请结合含税价格与固定运费比较到货总价。此报价不会发给任何第三方。</p>`;
  dialog.querySelector("button").onclick=()=>dialog.close(); dialog.addEventListener("close",()=>dialog.remove()); document.body.append(dialog); dialog.showModal();
}

async function login() {
  const username=`buyer.${mode}@fixture.invalid`, password=mode==="workpanel"?"Workpanel-Only-2026!":"Chrome-Only-2026!";
  app.innerHTML=`<section class="login-card">${stepHeading("进入本地采购沙盒","此处不连接任何真实身份系统，也不需要系统钥匙串。")}<aside class="notice">公开测试账号：<code>${username}</code><br>公开测试密码：<code>${password}</code></aside>
  <form id="login-form"><div class="form-grid">${field("username","测试账号", "",'autocomplete="username" required')}${field("password","测试密码","",'type="password" autocomplete="off" required')}</div><button class="primary" type="submit">登录测试账号</button></form>
  <div class="divider">或者</div><button id="demo-login" class="primary wide">使用本页公开测试账号进入沙盒</button><p class="muted">所有订单、联系人和账号都是虚构测试数据。提交只保存在此本机沙盒。</p></section>`;
  document.querySelector("#login-form").onsubmit=guard(async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget)); await api("login","POST",values);location.href=`/${mode}/catalog`;});
  document.querySelector("#demo-login").onclick=guard(async event=>{await api("login","POST",{demo:true,trusted:event.isTrusted});location.href=`/${mode}/catalog`;});
}

let filters;
try { filters=JSON.parse(sessionStorage.getItem(`filters-${mode}`)); } catch {}
filters ??= {category:"",ram:0,ssd:0,warranty:0,stock:0,days:0,quantity:1,sort:"default",page:1};
const persistFilters = () => sessionStorage.setItem(`filters-${mode}`,JSON.stringify(filters));
async function catalog() {
  const result=await api("catalog?"+new URLSearchParams(filters)); filters.page=result.page; persistFilters();
  app.innerHTML=`${stepHeading("供应商报价目录","先设置采购条件，再跨页比较。原厂授权证明在每份报价详情内。")}<section class="panel"><form id="filter-form"><div class="filters">
  ${select("category","设备类型",[["","全部设备"],["workstation","移动工作站"],["office","办公笔记本"]],filters.category)}
  ${select("ram","内存至少",[[0,"不限"],[16,"16GB"],[32,"32GB"],[64,"64GB"]],filters.ram)}
  ${select("ssd","固态容量至少",[[0,"不限"],[512,"512GB"],[1024,"1TB"],[2048,"2TB"]],filters.ssd)}
  ${select("warranty","保修至少",[[0,"不限"],[1,"1年"],[2,"2年"],[3,"3年"],[4,"4年"]],filters.warranty)}
  ${select("days","交期最多",[[0,"不限"],[2,"2个工作日"],[3,"3个工作日"],[4,"4个工作日"],[7,"7个工作日"]],filters.days)}
  ${field("stock","可用库存至少",filters.stock,'type="number" min="0" max="100"')}${field("quantity","采购数量（用于计算到货总价）",filters.quantity,'type="number" min="1" max="100"')}
  ${select("sort","报价排序",[["default","供应商默认顺序"],["unitAsc","含税单价升序"],["totalAsc","到货总价升序"]],filters.sort)}
  </div><div class="toolbar"><button class="primary" type="submit">应用筛选与排序</button><button type="button" id="refresh-quotes">重新加载当前报价</button></div></form></section>
  <section class="panel"><div class="section-bar"><h2>报价结果 <span class="muted">${result.count}份 · 每页2份</span></h2><span id="revision">页面版本 ${result.revision} · 选择后会重建DOM</span></div>
  <div class="table-scroll"><table><thead><tr><th>加入对比</th><th>供应商 / 型号</th><th>配置 / 保修</th><th>库存 / 交期</th><th>含税单价</th><th>固定运费</th><th>${filters.quantity}台到货总价</th><th>核验详情</th></tr></thead><tbody>${result.rows.map(quote=>`<tr><td><input type="checkbox" aria-label="加入对比：${e(quote.vendor)}" data-select="${quote.id}" ${result.selected.includes(quote.id)?"checked":""}></td><td><strong>${e(quote.vendor)}</strong><br>${e(quote.model)}<small>${quote.id}</small></td><td>${quote.ram}GB / ${quote.ssd}GB<br>${quote.warranty}年保修</td><td>${quote.stock}台<br>${quote.days}个工作日</td><td>${money(quote.unit)}</td><td>${money(quote.shipping)}</td><td class="amount">${money(quote.total)}</td><td><button data-quote="${quote.id}" aria-label="查看${e(quote.vendor)}报价详情">查看报价</button></td></tr>`).join("")}</tbody></table></div>
  <div class="pagination"><button id="previous" ${result.page<=1?"disabled":""}>上一页</button><span>第 ${result.page} / ${result.pages} 页</span><button id="next" ${result.page>=result.pages?"disabled":""}>下一页</button></div></section>
  <div class="comparison-tray"><span>已加入候选 <strong>${result.selected.length} / 3</strong></span><a class="button primary" href="/${mode}/compare">查看候选对比</a></div>`;
  document.querySelector("#filter-form").onsubmit=guard(async event=>{event.preventDefault();filters={...Object.fromEntries(new FormData(event.currentTarget)),page:1};persistFilters();await catalog();message("筛选与排序已应用，结果DOM已替换。请重新读取当前页面。");});
  document.querySelector("#refresh-quotes").onclick=guard(async()=>{await catalog();message("当前报价DOM已重新加载，旧元素引用已失效。");});
  for(const button of document.querySelectorAll("[data-quote]")) button.onclick=guard(()=>showQuote(button.dataset.quote));
  for(const input of document.querySelectorAll("[data-select]")) input.onchange=guard(async event=>{await api("select","POST",{id:input.dataset.select,selected:input.checked,trusted:event.isTrusted});await catalog();message("候选已更新，报价行DOM已替换。");});
  document.querySelector("#previous").onclick=guard(async()=>{filters.page--;persistFilters();await catalog();});
  document.querySelector("#next").onclick=guard(async()=>{filters.page++;persistFilters();await catalog();});
  await api("ui-event","POST",{name:"catalog_dom_rebuilt",revision:result.revision});
}

async function compare() {
  const result=await api("compare");
  app.innerHTML=`${stepHeading("候选报价对比","本次对比按6台计算；请核对授权证明，按到货总价决定最终供应商。")}<section class="panel"><form id="winner-form"><div class="table-scroll"><table><thead><tr><th>最终选择</th><th>供应商</th><th>配置</th><th>含税单价</th><th>固定运费</th><th>6台到货总价</th><th>库存</th><th>交期</th><th>报价详情</th></tr></thead><tbody>${result.rows.map(quote=>`<tr><td><input type="radio" name="winner" value="${quote.id}" aria-label="选择${e(quote.vendor)}为最终供应商"></td><td><strong>${e(quote.vendor)}</strong><br>${e(quote.model)}</td><td>${quote.ram}GB / ${quote.ssd}GB<br>${quote.warranty}年保修</td><td>${money(quote.unit)}</td><td>${money(quote.shipping)}</td><td class="amount">${money(quote.total)}</td><td>${quote.stock}台</td><td>${quote.days}个工作日</td><td><button type="button" data-quote="${quote.id}">查看${e(quote.vendor)}报价详情</button></td></tr>`).join("")}</tbody></table></div>
  <div class="toolbar"><a href="/${mode}/catalog" class="button">返回报价目录调整候选</a><button class="primary" ${result.rows.length!==3?"disabled":""}>创建采购草稿</button></div></form></section>`;
  document.querySelector("#winner-form").onsubmit=guard(async event=>{event.preventDefault();const id=new FormData(event.currentTarget).get("winner");if(!id)throw new Error("请选择最终供应商");await api("winner","POST",{id,trusted:event.isTrusted});location.href=`/${mode}/requisition`;});
  for(const button of document.querySelectorAll("[data-quote]")) button.onclick=guard(()=>showQuote(button.dataset.quote));
}

class BudgetPicker extends HTMLElement {
  constructor(){super();this.root=this.attachShadow({mode:"open"});}
  connectedCallback(){this.render();}
  setValues(value){this.values=value??{};this.render();}
  render(){
    const values=this.values??{};
    this.root.innerHTML=`<style>:host{display:block;font:14px system-ui;color:#25344c}h3{margin:0 0 14px}form{display:grid;grid-template-columns:1fr 1fr;gap:14px}label{display:grid;gap:7px}input,select{font:inherit;padding:9px;border:1px solid #bbc8d8;border-radius:7px;box-sizing:border-box;min-width:0}button{font:inherit;border:0;border-radius:7px;background:#245fe4;color:white;padding:10px 14px;cursor:pointer}p{margin:10px 0 0;color:#267147;grid-column:1/-1}.wide{grid-column:1/-1}</style><h3>预算归集组件（开放 Shadow DOM）</h3><form>
      ${select("expenseType","费用类型",[["","请选择"],["OPEX","费用性支出（OPEX）"],["CAPEX","资本性支出（CAPEX）"]],values.expenseType)}${field("budgetCode","预算代码",values.budgetCode??"","required")}${field("note","预算备注",values.note??"","required")}
      <button type="submit">确认预算归集</button><p id="saved">${values.budgetCode?"预算归集已保存":"请填写后确认保存"}</p></form>`;
    this.root.querySelector("form").onsubmit=guard(async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));const result=await api("budget","POST",{...values,trusted:event.isTrusted});this.values=result.draft.budget;this.root.querySelector("#saved").textContent="预算归集已保存";document.querySelector("#budget-status").textContent=`已保存：${values.expenseType} / ${values.budgetCode}`;message("开放Shadow DOM预算组件保存成功。");});
  }
}
customElements.define("budget-picker",BudgetPicker);

async function addressFrame(){
  const values=session.draft?.address??{};
  app.innerHTML=`<section class="frame-panel"><h2>收货信息（同源 iframe）</h2><form id="address-form"><div class="form-grid">${field("building","收货楼宇",values.building??"","required")}${field("room","楼层与房间",values.room??"","required")}${field("recipient","收货人",values.recipient??"","required")}${field("phone","联系电话",values.phone??"",'inputmode="numeric" required')}</div><button class="primary">保存收货信息</button><p id="frame-status" role="status">${values.building?"收货信息已保存":"请填写并保存此iframe里的4个字段"}</p></form></section>`;
  document.querySelector("#address-form").onsubmit=guard(async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));await api("address","POST",{...values,trusted:event.isTrusted});document.querySelector("#frame-status").textContent="收货信息已保存";parent.postMessage({type:"acceptance-address-saved",address:values},location.origin);});
}

async function requisition(){
  const draft=session.draft;
  if(!draft){app.innerHTML=`${stepHeading("尚未创建采购草稿","请先选择3个候选，并在对比页选择最终供应商。")}<a class="button primary" href="/${mode}/compare">前往候选对比</a>`;return;}
  const values=draft.outer??{};
  app.innerHTML=`${stepHeading("填写采购草稿","主表单、同源iframe和预算组件分别保存；完整保存后进入复核。")}<section class="panel"><h2>采购主表单</h2><p class="muted">候选：${draft.candidates.map(e).join("、")} · 最终报价：${e(draft.winner)}</p><form id="draft-form"><div class="form-grid">
    ${field("project","项目名称",values.project??"","required")}${field("quantity","采购数量",values.quantity??"",'type="number" min="1" required')}
    ${select("costCenter","成本中心",[["","请选择"],["DX-410","行政服务中心（DX-410）"],["DX-420","设计研发中心（DX-420）"],["DX-430","销售运营中心（DX-430）"]],values.costCenter)}
    ${select("payment","付款条件",[["","请选择"],["advance","预付款"],["net30","验收后30天"],["net60","验收后60天"]],values.payment)}
    <label class="wide">采购用途<textarea name="purpose" aria-label="采购用途" required>${e(values.purpose??"")}</textarea></label>
    <fieldset class="wide"><legend>发票类型</legend><label class="inline"><input type="radio" name="invoice" value="normal" ${values.invoice==="normal"?"checked":""}>增值税普通发票</label><label class="inline"><input type="radio" name="invoice" value="vat" ${values.invoice==="vat"?"checked":""}>增值税专用发票</label></fieldset>
    <label class="wide">选择理由<textarea name="reason" aria-label="选择理由" required placeholder="结合3个候选的到货总价、库存与交期说明最终选择">${e(draft.reason??"")}</textarea></label></div><button class="primary">保存采购草稿</button><span id="draft-status">${draft.saved?"采购草稿已保存":"尚未保存"}</span></form></section>
    <section class="panel"><h2>收货信息</h2><p id="address-status">${draft.address?`已保存：${e(draft.address.building)} ${e(draft.address.room)} ${e(draft.address.recipient)}`:"尚未保存收货信息"}</p><iframe title="收货信息（本地沙盒）" src="/${mode}/address-frame"></iframe></section>
    <section class="panel"><p id="budget-status">${draft.budget?`已保存：${e(draft.budget.expenseType)} / ${e(draft.budget.budgetCode)}`:"尚未保存预算归集"}</p><budget-picker></budget-picker></section>
    <div class="bottom-actions"><a class="button" href="/${mode}/compare">返回候选对比</a><button id="go-review" class="primary">前往复核草稿摘要</button></div>`;
  document.querySelector("budget-picker").setValues(draft.budget);
  document.querySelector("#draft-form").onsubmit=guard(async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));await api("draft","POST",{...values,trusted:event.isTrusted});document.querySelector("#draft-status").textContent="采购草稿已保存";message("采购草稿已保存，请继续核对收货信息和预算归集。");});
  document.querySelector("#go-review").onclick=guard(async()=>{await api("review");location.href=`/${mode}/review`;});
  addEventListener("message",event=>{if(event.origin===location.origin&&event.data?.type==="acceptance-address-saved"){const value=event.data.address;document.querySelector("#address-status").textContent=`已保存：${value.building} ${value.room} ${value.recipient}`;message("同源iframe收货信息已保存。");}});
}

async function review(){
  let result;
  try {result=await api("review");}catch(error){app.innerHTML=`${stepHeading("草稿尚未完整保存",error.message)}<a class="button primary" href="/${mode}/requisition">返回采购草稿</a>`;return;}
  const {draft,winner,candidates}=result, outer=draft.outer;
  app.innerHTML=`${stepHeading("复核采购草稿摘要","请核对所有字段，再确认提交到本机沙盒。不会产生真实采购。")}<section class="panel"><h2>3个候选与最终选择</h2><table><thead><tr><th>供应商</th><th>报价编号</th><th>数量</th><th>含税单价</th><th>运费</th><th>到货总价</th><th>最终选择</th></tr></thead><tbody>${candidates.map(quote=>`<tr><td>${e(quote.vendor)}</td><td>${e(quote.id)}</td><td>${outer.quantity}</td><td>${money(quote.unit)}</td><td>${money(quote.shipping)}</td><td>${money(quote.total)}</td><td>${quote.id===winner.id?"是":"否"}</td></tr>`).join("")}</tbody></table><div class="totals"><p>最终到货总价：<strong>${money(winner.total)}</strong></p><p>预算上限：${money(result.budget)} · 预算结余：<strong>${money(result.budget-winner.total)}</strong></p></div></section>
  <section class="panel"><h2>申请、收货与预算</h2><dl><dt>项目名称</dt><dd>${e(outer.project)}</dd><dt>成本中心</dt><dd>${e(outer.costCenter)}</dd><dt>采购数量</dt><dd>${outer.quantity}台</dd><dt>采购用途</dt><dd>${e(outer.purpose)}</dd><dt>发票类型</dt><dd>${outer.invoice==="vat"?"增值税专用发票":"增值税普通发票"}</dd><dt>付款条件</dt><dd>${outer.payment==="net30"?"验收后30天":e(outer.payment)}</dd><dt>收货信息</dt><dd>${e(Object.values(draft.address).join(" / "))}</dd><dt>预算归集</dt><dd>${e(Object.values(draft.budget).join(" / "))}</dd><dt>选择理由</dt><dd>${e(draft.reason)}</dd></dl></section>
  <section class="panel submit-panel"><label class="inline"><input type="checkbox" id="review-ack">我已核对草稿摘要，确认仅提交本地沙盒</label><div class="toolbar"><a href="/${mode}/requisition" class="button">返回修改草稿</a><button id="submit-order" class="primary" disabled>提交本地沙盒订单</button></div></section>`;
  document.querySelector("#review-ack").onchange=guard(async event=>{const checked=event.target.checked;await api("review-ack","POST",{checked,trusted:event.isTrusted});document.querySelector("#submit-order").disabled=!checked;message(checked?"复核已确认，可以提交本地订单":"复核确认已取消");});
  document.querySelector("#submit-order").onclick=guard(async event=>{await api("submit","POST",{trusted:event.isTrusted});location.href=`/${mode}/submitted`;});
}

async function submitted(){
  const latest=await api("session"), order=latest.order;
  app.innerHTML=order?`${stepHeading("本地沙盒订单已提交","业务结果已保存在本机。没有向任何供应商发送订单。")}<section class="panel success"><span class="badge">提交成功</span><h2>订单编号：<code>${e(order.id)}</code></h2><p>最终报价：${e(order.draft.winner)}</p><p>数量：${order.draft.outer.quantity}台</p><p>本地状态：已提交</p><p>请向任务发起者报告订单编号、3个候选的到货总价和选择理由。</p><a href="/${mode}/review" class="button">查看已提交订单摘要</a></section>`:`<h1>尚无已提交订单</h1><a href="/${mode}/catalog">返回报价目录</a>`;
}

try {
  if(view==="login") await login();
  else {
    try { session=await api("session"); } catch { location.replace(`/${mode}/login`); throw new Error("请先登录公开测试账号"); }
    await ({catalog,compare,requisition,review,submitted,"address-frame":addressFrame}[view]??catalog)();
  }
} catch(error){message(error.message);}
