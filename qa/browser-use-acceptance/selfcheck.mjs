// Component smoke test only. It always creates an independent server/dataset and never touches the model's run.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createAcceptanceServer } from "./server.mjs";

const require=createRequire(import.meta.url);
const {chromium}=require("playwright-core");
const root=path.dirname(fileURLToPath(import.meta.url));
const runDir=path.join(root,"runs",`selfcheck-${Date.now()}`);
const fixture=createAcceptanceServer({runDir});
const manifest=await fixture.start();
const executablePath=process.env.BROWSER_USE_TEST_CHROME ?? (process.platform==="darwin"?"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":process.platform==="win32"?path.join(process.env.PROGRAMFILES??"C:\\Program Files","Google/Chrome/Application/chrome.exe"):"/usr/bin/google-chrome");
const browser=await chromium.launch({executablePath,headless:true});
try {
  for(const mode of ["workpanel","chrome"]){
    const expected=fixture.checks().find(item=>item.mode===mode).expected;
    const wanted=expected.candidates.map(item=>item.id);
    const context=await browser.newContext(); const page=await context.newPage();
    await page.goto(`${manifest.baseUrl}/${mode}/login`);
    await page.getByRole("button",{name:"使用本页公开测试账号进入沙盒"}).click();
    await page.waitForURL(`**/${mode}/catalog`);
    for(const [name,value] of Object.entries({category:"workstation",ram:"32",ssd:"1024",warranty:"3",days:"4",sort:"unitAsc"}))await page.locator(`select[name="${name}"]`).selectOption(value);
    await page.getByLabel("可用库存至少",{exact:true}).fill("6");
    await page.getByLabel("采购数量（用于计算到货总价）",{exact:true}).fill("6");
    const previous=await page.locator("#revision").innerText();
    await page.getByRole("button",{name:"应用筛选与排序"}).click();
    await page.waitForFunction(text=>document.querySelector("#revision").textContent!==text,previous);
    for(;;){
      const ids=await page.locator("[data-quote]").evaluateAll(items=>items.map(item=>item.dataset.quote));
      for(const id of ids){
        await page.locator(`[data-quote="${id}"]`).click();
        await page.getByRole("button",{name:"关闭报价详情"}).click();
        if(wanted.includes(id)){
          const revision=await page.locator("#revision").innerText();
          await page.locator(`[data-select="${id}"]`).click();
          await page.waitForFunction(text=>document.querySelector("#revision").textContent!==text,revision);
        }
      }
      if(await page.getByRole("button",{name:"下一页",exact:true}).isDisabled())break;
      const revision=await page.locator("#revision").innerText();
      await page.getByRole("button",{name:"下一页",exact:true}).click();
      await page.waitForFunction(text=>document.querySelector("#revision").textContent!==text,revision);
    }
    await page.getByRole("link",{name:"查看候选对比",exact:true}).click();
    await page.locator(`input[name="winner"][value="${expected.winner.id}"]`).check();
    await page.getByRole("button",{name:"创建采购草稿"}).click();
    await page.waitForURL(`**/${mode}/requisition`);
    await page.getByLabel("项目名称",{exact:true}).fill("设计团队工作站采购");
    await page.getByLabel("采购数量",{exact:true}).fill("6");
    await page.getByLabel("成本中心",{exact:true}).selectOption("DX-420");
    await page.getByLabel("付款条件",{exact:true}).selectOption("net30");
    await page.getByLabel("采购用途",{exact:true}).fill("用于设计团队三维建模与图形设计");
    await page.getByLabel("增值税专用发票",{exact:true}).check();
    await page.getByLabel("选择理由",{exact:true}).fill("比较候选的到货总价、库存和交期后，选择符合条件且总价最低的供应商。");
    const frame=page.frameLocator('iframe[title="收货信息（本地沙盒）"]');
    for(const [name,value] of Object.entries({"收货楼宇":"研发楼B座","楼层与房间":"6F-602","收货人":"林昭","联系电话":"13800001234"}))await frame.getByLabel(name,{exact:true}).fill(value);
    await frame.getByRole("button",{name:"保存收货信息"}).click();
    await page.locator("#address-status").filter({hasText:"已保存"}).waitFor();
    const budget=page.locator("budget-picker");
    await budget.getByLabel("费用类型",{exact:true}).selectOption("CAPEX");
    await budget.getByLabel("预算代码",{exact:true}).fill("IT-2026-Q4");
    await budget.getByLabel("预算备注",{exact:true}).fill("设计团队Q4设备更新");
    await budget.getByRole("button",{name:"确认预算归集"}).click();
    await page.locator("#budget-status").filter({hasText:"已保存"}).waitFor();
    await page.getByRole("button",{name:"保存采购草稿",exact:true}).click();
    await page.locator("#draft-status").filter({hasText:"已保存"}).waitFor();
    await page.getByRole("button",{name:"前往复核草稿摘要"}).click();
    await page.getByLabel("我已核对草稿摘要，确认仅提交本地沙盒").check();
    await page.getByRole("button",{name:"提交本地沙盒订单"}).click();
    await page.waitForURL(`**/${mode}/submitted`);
    await page.screenshot({path:path.join(manifest.screenshotsDir,`${mode}-selfcheck.png`),fullPage:true});
    await context.close();
  }
  const checks=fixture.checks();
  fs.writeFileSync(path.join(runDir,"selfcheck-result.json"),JSON.stringify(checks,null,2));
  if(checks.some(item=>item.status!=="pass"))throw new Error(JSON.stringify(checks));
  console.log(JSON.stringify({ok:true,runDir,checks:checks.map(item=>({mode:item.mode,status:item.status,count:item.checks.length,orderId:item.orderId}))}));
}finally{await browser.close();await new Promise(resolve=>fixture.server.close(resolve));}
