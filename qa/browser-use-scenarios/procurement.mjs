import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modes = ["chrome"];
const requirements = { quantity: 6, category: "workstation", ram: 32, ssd: 1024, warranty: 3, stock: 6, days: 4, budget: 72000, authorized: true };
const outerExpected = { project: "设计团队工作站采购", quantity: 6, costCenter: "DX-420", purpose: "用于设计团队三维建模与图形设计", invoice: "vat", payment: "net30" };
const addressExpected = { building: "研发楼B座", room: "6F-602", recipient: "林昭", phone: "13800001234" };
const budgetExpected = { expenseType: "CAPEX", budgetCode: "IT-2026-Q4", note: "设计团队Q4设备更新" };
const labels = { workpanel: "WorkPanel", chrome: "Chrome" };
const prices = {
  workpanel: [[10680,180],[10480,2400],[11050,0],[11180,400],[11580,300]],
  chrome: [[10230,4800],[10580,190],[10830,0],[10990,320],[11330,120]]
};
const offers = mode => {
  const prefix = mode === "workpanel" ? "WP" : "CH";
  const names = mode === "workpanel" ? ["澄星科技","山岚商用","辰光设备","青岚服务","行知数码"] : ["青禾智造","溪石设备","松屿商用","岩桥集成","映湖数码"];
  const good = names.map((vendor, index) => ({ id: `${prefix}-Q${index+1}`, vendor, model: ["Studio 14","Pro 14","Creator 14","Flex 14","Work 14"][index], category: "workstation", ram: index === 2 || index === 4 ? 64 : 32, ssd: index === 4 ? 2048 : 1024, warranty: index === 3 ? 4 : 3, stock: [8,12,10,9,10][index], days: [3,4,2,4,3][index], unit: prices[mode][index][0], shipping: prices[mode][index][1], authorized: true }));
  const base = { category: "workstation", ram: 32, ssd: 1024, warranty: 3, stock: 10, days: 3, authorized: true };
  return [
    { ...base, id: `${prefix}-R1`, vendor: "星原零售", model: "Light 14", ram: 16, unit: 7800, shipping: 0 },
    good[1],
    { ...base, id: `${prefix}-R2`, vendor: "海岚转售", model: "Studio 14", unit: 9300, shipping: 100, authorized: false },
    { ...base, id: `${prefix}-R3`, vendor: "远峰电脑", model: "Pro 13", ssd: 512, unit: 8500, shipping: 100 },
    good[4],
    { ...base, id: `${prefix}-R4`, vendor: "银杉设备", model: "Work 15", warranty: 1, unit: 9200, shipping: 0 },
    good[0],
    { ...base, id: `${prefix}-R5`, vendor: "原野商用", model: "Creator 14", stock: 4, unit: 9900, shipping: 200 },
    good[3],
    { ...base, id: `${prefix}-R6`, vendor: "雪松数码", model: "Studio 14", days: 7, unit: 10100, shipping: 0 },
    good[2],
    { ...base, id: `${prefix}-R7`, vendor: "映川网络", model: "Office 14", category: "office", unit: 8900, shipping: 0 },
    { ...base, id: `${prefix}-R8`, vendor: "杉木商用", model: "Premium 16", unit: 12500, shipping: 300 },
    { ...base, id: `${prefix}-R9`, vendor: "海川设备", model: "Entry 14", ram: 16, warranty: 2, unit: 8000, shipping: 0 }
  ];
};
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const publicOffer = (offer, quantity) => ({ ...offer, authorized: undefined, total: offer.unit * quantity + offer.shipping });
const safeJson = value => JSON.stringify(value).replace(/</g, "\\u003c");

function prompt(mode, baseUrl) {
  return `请在${labels[mode]}网页环境完成这项本地采购任务。允许只读已安装的builtin.web-control技能说明和参考文档；业务执行只用workpanel_open、surface_observe、surface_click、surface_element等类型化网页操作。禁止surface_evaluate、surface_cdp原始命令、终端、业务文件读取、HTTP请求或直接访问网页后台接口，也不要读取验收服务器源码或验证器。遇到授权或环境错误请立即停止并报告，不要另建Chat、检查平台或服务来自行修复。\n\n打开 ${baseUrl}/${mode}/login 。这是本机沙盒，所有账号、数据、手机号均为虚构，允许直接登录和提交本地订单，没有任何真实采购或第三方发送。点击“使用本页公开测试账号进入沙盒”即可登录；不要调用系统钥匙串或保存凭据登录。\n\n为设计团队采购6台移动工作站，预算为含运费含税总额72,000元。硬性条件：至少32GB内存、1TB固态、3年保修，可用库存至少6台，交期最多4个工作日，并且有有效原厂授权。请在报价页设置采购数量和这些筛选条件，按含税单价升序排序，跨分页检查报价，逐一打开候选报价详情核实授权与运费，从符合条件的报价中选出到货总价最低的3个候选加入对比，再选这3个里到货总价最低的供应商。不要只按单价决定。页面筛选或选择后可能替换DOM，元素引用失效时请重新观察。\n\n创建采购草稿并填写：项目名称“设计团队工作站采购”；数量6；成本中心“设计研发中心（DX-420）”；用途“用于设计团队三维建模与图形设计”；发票“增值税专用发票”；付款条件“验收后30天”。在同源收货信息iframe里填写并保存：研发楼B座、6F-602、收货人林昭、联系电话13800001234。在预算组件内填写并确认：资本性支出（CAPEX）、预算代码IT-2026-Q4、预算备注“设计团队Q4设备更新”。选择理由请结合你看到的3份报价，明确说明到货总价、库存和交期。\n\n保存草稿后进入复核页，核对3个候选、最终供应商、到货总价、预算结余、数量、收货信息和预算归集。确认无误后勾选已核对并提交到本地沙盒。最后回复订单编号、3个候选各自到货总价、最终选择与理由，并说明页面是否发生引用失效以及如何恢复。`;
}

export function createAcceptanceServer(options = {}) {
  const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g,"-")}-${crypto.randomBytes(3).toString("hex")}`;
  const runDir = path.resolve(options.runDir ?? path.join(here, "runs", runId));
  fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
  const verifierToken = crypto.randomBytes(24).toString("hex");
  const sessions = new Map();
  const states = Object.fromEntries(modes.map(mode => [mode, { mode, loginCount: 0, selected: [], quoteViews: [], queries: [], revision: 0, draft: null, reviewedHash: null, orders: [], events: [] }]));
  const ledgerPath = path.join(runDir, "ledger.jsonl"), statePath = path.join(runDir, "state.json");
  const save = () => { fs.writeFileSync(statePath + ".tmp", JSON.stringify(states, null, 2)); fs.renameSync(statePath + ".tmp", statePath); };
  const audit = (mode, type, details = {}) => {
    const event = { seq: (states[mode]?.events.length ?? 0) + 1, at: new Date().toISOString(), mode, type, details };
    states[mode]?.events.push(event); fs.appendFileSync(ledgerPath, JSON.stringify(event) + "\n"); save(); return event;
  };
  const data = Object.fromEntries(modes.map(mode => [mode, offers(mode)]));
  const byId = (mode,id) => data[mode].find(offer => offer.id === id);
  const newDraft = state => ({ candidates: [...state.selected], winner: null, outer: null, address: null, budget: null, reason: "", saved: false });
  const draftHash = draft => hash({ candidates: draft.candidates, winner: draft.winner, outer: draft.outer, address: draft.address, budget: draft.budget, reason: draft.reason });
  const validators = mode => {
    const state = states[mode], order = state.orders.at(-1), draft = order?.draft ?? state.draft;
    const qualified = data[mode].filter(offer => offer.category === requirements.category && offer.ram >= 32 && offer.ssd >= 1024 && offer.warranty >= 3 && offer.stock >= 6 && offer.days <= 4 && offer.authorized && offer.unit * 6 + offer.shipping <= 72000).sort((a,b) => a.unit*6+a.shipping-(b.unit*6+b.shipping));
    const expectedCandidates = qualified.slice(0,3).map(offer => offer.id), expectedWinner = qualified[0].id;
    const properQueries = state.queries.filter(query => query.quantity === 6 && query.category === "workstation" && query.ram === 32 && query.ssd === 1024 && query.warranty === 3 && query.stock === 6 && query.days === 4 && query.sort === "unitAsc");
    const checks = [
      ["login", state.loginCount > 0, true, state.loginCount],
      ["filtered_sorted_across_pages", new Set(properQueries.map(query=>query.page)).size >= 2, "at least 2 result pages under all requested filters", properQueries.map(query=>query.page)],
      ["candidate_details_opened", expectedCandidates.every(id=>state.quoteViews.includes(id)), expectedCandidates, state.quoteViews],
      ["three_lowest_qualified_candidates", equal([...(draft?.candidates??[])].sort(), [...expectedCandidates].sort()), expectedCandidates, draft?.candidates],
      ["lowest_landed_total_winner", draft?.winner === expectedWinner, expectedWinner, draft?.winner],
      ["outer_fields", equal(draft?.outer, outerExpected), outerExpected, draft?.outer],
      ["iframe_address", equal(draft?.address, addressExpected), addressExpected, draft?.address],
      ["open_shadow_budget", equal(draft?.budget, budgetExpected), budgetExpected, draft?.budget],
      ["reason_mentions_cost_stock_delivery", ["总价","库存","交期"].every(term=>draft?.reason?.includes(term)), ["总价","库存","交期"], draft?.reason],
      ["draft_saved", draft?.saved === true, true, draft?.saved],
      ["reviewed_same_draft", !!order && order.reviewedHash === draftHash(order.draft), "same draft hash at review and submit", order?.reviewedHash],
      ["local_order_submitted_once", state.orders.length === 1, 1, state.orders.length],
      ["dom_replacement_exercised", state.revision >= 4, ">=4", state.revision]
    ].map(([name,pass,expected,actual])=>({name,pass,expected,actual}));
    return { mode, status: checks.every(check=>check.pass) ? "pass" : order ? "fail" : "pending", checks, orderId: order?.id ?? null, expected: { candidates: expectedCandidates.map(id=>publicOffer(byId(mode,id),6)), winner: publicOffer(qualified[0],6) } };
  };
  const json = (res,status,value) => { res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); res.end(JSON.stringify(value)); };
  const requireAuth = (req,res,mode) => {
    const cookies = Object.fromEntries((req.headers.cookie??"").split(";").map(item=>item.trim().split("=")));
    const session = sessions.get(cookies[`acceptance_${mode}`]);
    if (!session || session.mode !== mode) { json(res,401,{error:"请先通过本地测试账号登录"}); return null; }
    return session;
  };
  const page = (mode, view) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${labels[mode]} 本地采购沙盒 · ${runId.slice(-6).toUpperCase()}</title><link rel="stylesheet" href="/procurement-assets/styles.css"></head><body class="${view==='address-frame'?'frame':''}"><header><div><strong>本地采购沙盒</strong><span class="mode">${labels[mode]} 独立数据集</span></div><small>所有数据均为虚构 · 仅在本机保存 · 不产生真实订单</small></header><nav aria-label="采购流程"><a href="/${mode}/catalog">1 报价目录</a><a href="/${mode}/compare">2 候选对比</a><a href="/${mode}/requisition">3 采购草稿</a><a href="/${mode}/review">4 复核提交</a></nav><main id="app"><p>正在读取本地页面…</p></main><div id="feedback" role="status" aria-live="polite"></div><script>globalThis.ACCEPTANCE=${safeJson({mode,view,label:labels[mode]})}</script><script type="module" src="/procurement-assets/app.js"></script></body></html>`;
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.headers.host && !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host)) return json(res,403,{error:"loopback only"});
      if (req.method === "GET" && url.pathname === "/health") return json(res,200,{ok:true,runId});
      if (url.pathname.startsWith("/_verify/")) {
        const presented = req.headers["x-acceptance-token"] ?? url.searchParams.get("token") ?? "";
        if (req.method !== "GET" || typeof presented !== "string" || presented.length !== verifierToken.length || !crypto.timingSafeEqual(Buffer.from(presented),Buffer.from(verifierToken))) return json(res,404,{error:"not found"});
        if (url.pathname === "/_verify/state") return json(res,200,states);
        if (url.pathname === "/_verify/audit") return json(res,200,modes.flatMap(mode=>states[mode].events).sort((a,b)=>a.at.localeCompare(b.at)));
        if (url.pathname === "/_verify/check") return json(res,200,url.searchParams.has("mode") ? validators(url.searchParams.get("mode")) : modes.map(validators));
        return json(res,404,{error:"not found"});
      }
      if (req.method === "GET" && ["/procurement-assets/app.js","/procurement-assets/styles.css"].includes(url.pathname)) {
        res.writeHead(200,{"Content-Type":url.pathname.endsWith(".js")?"text/javascript; charset=utf-8":"text/css; charset=utf-8","Cache-Control":"no-store"});
        return res.end(fs.readFileSync(path.join(here,"procurement-"+path.basename(url.pathname))));
      }
      const match = url.pathname.match(/^\/(workpanel|chrome)\/(.*)$/);
      if (!match) return json(res,404,{error:"not found"});
      const [,mode,route] = match, state = states[mode];
      if (req.method === "GET" && ["login","catalog","compare","requisition","review","submitted","address-frame"].includes(route)) {
        audit(mode,"page_view",{route}); res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Frame-Options":"SAMEORIGIN"}); return res.end(page(mode,route));
      }
      if (!route.startsWith("api/")) return json(res,404,{error:"not found"});
      let body = {};
      if (req.method === "POST") {
        let content = ""; for await (const chunk of req) { content += chunk; if (content.length > 64000) return json(res,413,{error:"请求过大"}); }
        try { body = JSON.parse(content || "{}"); } catch { return json(res,400,{error:"无效JSON"}); }
      }
      const action = route.slice(4);
      if (action === "login" && req.method === "POST") {
        const username = `buyer.${mode}@fixture.invalid`, password = mode === "workpanel" ? "Workpanel-Only-2026!" : "Chrome-Only-2026!";
        if (body.demo !== true && (body.username !== username || body.password !== password)) return json(res,400,{error:"请使用本页公开测试账号"});
        const id = crypto.randomBytes(20).toString("hex"), csrf = crypto.randomBytes(16).toString("hex"); sessions.set(id,{mode,csrf,username});
        res.setHeader("Set-Cookie",`acceptance_${mode}=${id}; HttpOnly; SameSite=Strict; Path=/${mode}/`); state.loginCount++; audit(mode,"login",{username,demo:body.demo===true}); return json(res,200,{ok:true,username,csrf});
      }
      const session = requireAuth(req,res,mode); if (!session) return;
      if (req.method === "POST" && req.headers["x-fixture-csrf"] !== session.csrf) return json(res,403,{error:"本地会话已变化，请刷新页面"});
      if (action === "session" && req.method === "GET") return json(res,200,{username:session.username,csrf:session.csrf,selected:state.selected,draft:state.draft,order:state.orders.at(-1)??null,revision:state.revision});
      if (action === "catalog" && req.method === "GET") {
        const q = Object.fromEntries(url.searchParams), query = { category:q.category??"",ram:+q.ram||0,ssd:+q.ssd||0,warranty:+q.warranty||0,stock:+q.stock||0,days:+q.days||0,quantity:Math.max(1,Math.min(100,+q.quantity||1)),sort:q.sort??"default",page:Math.max(1,+q.page||1) };
        let rows = data[mode].filter(offer=>(!query.category||offer.category===query.category)&&offer.ram>=query.ram&&offer.ssd>=query.ssd&&offer.warranty>=query.warranty&&offer.stock>=query.stock&&(!query.days||offer.days<=query.days));
        if (query.sort === "unitAsc") rows.sort((a,b)=>a.unit-b.unit); if (query.sort === "totalAsc") rows.sort((a,b)=>a.unit*query.quantity+a.shipping-b.unit*query.quantity-b.shipping);
        const count = rows.length, pages = Math.max(1,Math.ceil(count/2)); query.page = Math.min(query.page,pages); rows=rows.slice((query.page-1)*2,query.page*2);
        state.queries.push(query); state.revision++; audit(mode,"catalog_read",query);
        return json(res,200,{rows:rows.map(offer=>publicOffer(offer,query.quantity)),count,pages,page:query.page,selected:state.selected,revision:state.revision});
      }
      if (action === "quote" && req.method === "GET") {
        const offer=byId(mode,url.searchParams.get("id")); if(!offer) return json(res,404,{error:"报价不存在"});
        if(!state.quoteViews.includes(offer.id)) state.quoteViews.push(offer.id); audit(mode,"quote_view",{id:offer.id}); return json(res,200,offer);
      }
      if (action === "select" && req.method === "POST") {
        if(!byId(mode,body.id)) return json(res,400,{error:"报价不存在"});
        const next=new Set(state.selected); body.selected ? next.add(body.id) : next.delete(body.id); if(next.size>3) return json(res,400,{error:"最多比较3个候选，请先移除一个"});
        state.selected=[...next]; state.revision++; state.draft=null; state.reviewedHash=null; audit(mode,"candidate_selection",{selected:state.selected,revision:state.revision,trusted:body.trusted===true}); return json(res,200,{selected:state.selected});
      }
      if (action === "compare" && req.method === "GET") return json(res,200,{rows:state.selected.map(id=>publicOffer(byId(mode,id),6)),selected:state.selected});
      if (action === "winner" && req.method === "POST") {
        if(state.selected.length!==3||!state.selected.includes(body.id)) return json(res,400,{error:"请先选满3个候选，再选择最终供应商"});
        state.draft=newDraft(state); state.draft.winner=body.id; state.reviewedHash=null; audit(mode,"winner_selected",{id:body.id,trusted:body.trusted===true}); return json(res,200,{ok:true});
      }
      if (["address","budget","draft"].includes(action) && req.method === "POST") {
        if(!state.draft) return json(res,400,{error:"请先从候选对比创建采购草稿"});
        if(action==="address") {
          const value=Object.fromEntries(Object.keys(addressExpected).map(key=>[key,String(body[key]??"").trim()]));
          if(Object.values(value).some(item=>!item)) return json(res,400,{error:"请填写完整收货信息"}); state.draft.address=value;
        } else if(action==="budget") {
          const value=Object.fromEntries(Object.keys(budgetExpected).map(key=>[key,String(body[key]??"").trim()]));
          if(Object.values(value).some(item=>!item)) return json(res,400,{error:"请填写完整预算归集"}); state.draft.budget=value;
        } else {
          const value={project:String(body.project??"").trim(),quantity:Number(body.quantity),costCenter:String(body.costCenter??""),purpose:String(body.purpose??"").trim(),invoice:String(body.invoice??""),payment:String(body.payment??"")};
          if(Object.values(value).some(item=>!item)||value.quantity<1) return json(res,400,{error:"请填写完整采购草稿"}); state.draft.outer=value; state.draft.reason=String(body.reason??"").trim(); state.draft.saved=true;
        }
        state.reviewedHash=null; audit(mode,action==="draft"?"draft_saved":`${action}_saved`,{source:action==="address"?"same-origin-iframe":action==="budget"?"open-shadow-root":"main-form",trusted:body.trusted===true}); return json(res,200,{draft:state.draft});
      }
      if (action === "review" && req.method === "GET") {
        const draft=state.draft; if(!draft?.saved||!draft.address||!draft.budget||!draft.reason) return json(res,400,{error:"请先保存采购草稿、收货信息、预算归集和选择理由"});
        audit(mode,"review_opened",{hash:draftHash(draft)}); return json(res,200,{draft,winner:publicOffer(byId(mode,draft.winner),draft.outer.quantity),candidates:draft.candidates.map(id=>publicOffer(byId(mode,id),draft.outer.quantity)),budget:72000,hash:draftHash(draft)});
      }
      if (action === "review-ack" && req.method === "POST") {
        if(!state.draft?.saved||body.checked!==true) { state.reviewedHash=null; return json(res,200,{ok:true}); }
        state.reviewedHash=draftHash(state.draft); audit(mode,"review_acknowledged",{hash:state.reviewedHash,trusted:body.trusted===true}); return json(res,200,{ok:true});
      }
      if (action === "submit" && req.method === "POST") {
        const draft=state.draft; if(!draft?.saved||!draft.address||!draft.budget||!state.reviewedHash||state.reviewedHash!==draftHash(draft)) return json(res,400,{error:"请核对同一份完整草稿后再提交本地沙盒"});
        const prior=state.orders.find(order=>order.reviewedHash===state.reviewedHash); if(prior) return json(res,200,{order:prior});
        const order={id:`${mode==="workpanel"?"WP":"CH"}-${runId.slice(0,10).replaceAll("-","")}-${runId.slice(-6).toUpperCase()}-${String(state.orders.length+1).padStart(3,"0")}`,at:new Date().toISOString(),status:"submitted_local_sandbox",draft:structuredClone(draft),reviewedHash:state.reviewedHash};
        state.orders.push(order); audit(mode,"order_submitted",{id:order.id,hash:order.reviewedHash,trusted:body.trusted===true}); return json(res,200,{order});
      }
      if (action === "ui-event" && req.method === "POST") { audit(mode,"ui_event",{name:String(body.name??"").slice(0,80),revision:body.revision,trusted:body.trusted===true}); return json(res,200,{ok:true}); }
      return json(res,404,{error:"not found"});
    } catch (error) { json(res,500,{error:"本地沙盒请求失败",detail:String(error.message).slice(0,200)}); }
  });
  server.requestTimeout=15_000; server.headersTimeout=10_000;
  const start = async () => {
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(options.port??0,"127.0.0.1",resolve);});
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const tasks=Object.fromEntries(modes.map(mode=>[mode,{url:`${baseUrl}/${mode}/login`,prompt:prompt(mode,baseUrl)}]));
    const manifest={runId,pid:process.pid,baseUrl,runDir,ledgerPath,statePath,screenshotsDir:path.join(runDir,"screenshots"),tasksPath:path.join(runDir,"tasks.json"),verification:{token:verifierToken,state:`${baseUrl}/_verify/state`,audit:`${baseUrl}/_verify/audit`,check:`${baseUrl}/_verify/check`}};
    fs.writeFileSync(path.join(runDir,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600}); fs.writeFileSync(manifest.tasksPath,JSON.stringify(tasks,null,2)); save();
    return { ...manifest, manifestPath:path.join(runDir,"manifest.json"), tasks };
  };
  return {server,start,runDir,checks:()=>modes.map(validators)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance=createAcceptanceServer(); const result=await instance.start();
  console.log(JSON.stringify({pid:result.pid,baseUrl:result.baseUrl,manifestPath:result.manifestPath,tasksPath:result.tasksPath,ledgerPath:result.ledgerPath,screenshotsDir:result.screenshotsDir}));
  process.on("SIGTERM",()=>instance.server.close(()=>process.exit(0))); process.on("SIGINT",()=>instance.server.close(()=>process.exit(0)));
}
