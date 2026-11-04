import test from "node:test";
import assert from "node:assert/strict";
import {assessResult,classifyCall,summarizeChat,summarizeLedger} from "./summarize.mjs";

const chatId="11111111-1111-4111-8111-111111111111";
const content=value=>[{type:"text",text:JSON.stringify(value)}];
test("tool documentation mentioning failures is not counted as a failed execution; nested failure is",()=>{
  assert.equal(assessResult({content:content({content:'Example: {"ok":false,"error":{"code":"example_error"}}',filePath:"PRIVATE-PATH"})}).outcome,"success");
  const result=assessResult({content:content({response:{ok:false,error:{code:"browser_run_unavailable",message:"SECRET-CREDENTIAL"}}})});
  assert.equal(result.outcome,"failure");assert.deepEqual(result.errorCodes,["browser_run_unavailable"]);assert.ok(!JSON.stringify(result).includes("SECRET-CREDENTIAL"));
});
test("skill reads and DOM query scripts remain separately visible, without leaking arguments",()=>{
  const doc=classifyCall("file_read",{filePath:"/private/builtin.web-control/skills/web-control/SKILL.md"},"http://127.0.0.1:1");
  assert.equal(doc.web,false);assert.equal(doc.skillOnly,true);assert.equal(doc.skillDocumentation,true);
  const query=classifyCall("surface_evaluate",{expression:"[...document.querySelectorAll('select')].map(x=>x.value)"},"http://127.0.0.1:1");
  assert.equal(query.pageScript,true);assert.equal(query.domReadCandidate,true);
  assert.equal(classifyCall("surface_evaluate",{expression:"fetch('/api/submit',{method:'POST'})"},"http://127.0.0.1:1").backendAccess,true);
  assert.ok(!JSON.stringify(doc).includes("/private/"));
});
test("official Chrome reference docs are allowed without admitting business code or another connector",()=>{
  const approved=["/private/builtin.web-control/skills/web-control/references/chrome-workflows.md","C:\\private\\builtin.web-control\\skills\\web-control\\references\\troubleshooting.md"];
  for(const filePath of approved){const result=classifyCall("file_read",{filePath},"http://127.0.0.1:1");assert.equal(result.skillOnly,true);assert.equal(result.skillDocumentation,true);assert.equal(result.web,false);}
  for(const filePath of ["/workspace/business/chrome-workflows.md","/private/builtin.other/skills/web-control/references/troubleshooting.md","/private/builtin.web-control/skills/web-control/references/chrome-workflows.mjs"])
    assert.equal(classifyCall("file_read",{filePath},"http://127.0.0.1:1").skillOnly,false);
  assert.equal(classifyCall("file_read",{filePaths:[approved[0],"/workspace/business/order-service.mjs"]},"http://127.0.0.1:1").skillOnly,false);
});
test("only declared calls/results are counted; snapshots deduplicate and raw contents are omitted",()=>{
  const call={role:"assistant",_msgId:"message-1",tool_calls:[{id:"call1",function:{name:"surface_click",arguments:JSON.stringify({selector:"SECRET-SELECTOR"})}}]};
  const rows=[{chatId,runId:"run1",updatedAt:"2026-10-20T12:00:00Z",messages:[call]},{chatId,runId:"run1",messages:[call]},{chatId,runId:"run1",updatedAt:"2026-10-20T12:01:00Z",messages:[{role:"tool",tool_call_id:"call1",content:content({ok:true,result:{status:"clicked",secret:"SECRET-OUTPUT"}})}]}];
  const result=summarizeChat(Buffer.from(rows.map(row=>JSON.stringify(row)).join("\n")),chatId,"http://127.0.0.1:1");
  assert.deepEqual(result.counts,{calls:1,success:1,failure:0,indeterminate:0,unresolved:0});assert.equal(result.integrity.duplicateCalls,1);
  assert.ok(!JSON.stringify(result).includes("SECRET-"));
});
test("a later successful Chat's order is not attributed to an earlier failed Chat",()=>{
  const bytes=Buffer.from(JSON.stringify({mode:"workpanel",at:"2026-10-20T12:05:00Z",type:"order_submitted",details:{id:"WP-20261020-ABCDEF-001",phone:"SECRET-PHONE"}})+"\n");
  const ledger=summarizeLedger(bytes,{window:{start:"2026-10-20T12:00:00Z",end:"2026-10-20T12:01:00Z"}},"workpanel");
  assert.equal(ledger.selected.exactlyOneLocalSubmission,true);assert.equal(ledger.selected.exactlyOneLocalSubmissionInChatWindow,false);
  assert.ok(!JSON.stringify(ledger).includes("SECRET-PHONE"));
});
test("a selected Run excludes the seed's tools and time window",()=>{
  const call=(id,name)=>({role:"assistant",tool_calls:[{id,function:{name,arguments:"{}"}}]});
  const rows=[{chatId,runId:"seed",updatedAt:"2026-10-20T12:00:00Z",messages:[call("seed-call","http_request")]},{chatId,runId:"business",updatedAt:"2026-10-20T12:05:00Z",messages:[call("business-call","surface_open"),{role:"tool",tool_call_id:"business-call",content:content({ok:true})}]}];
  const bytes=Buffer.from(rows.map(row=>JSON.stringify(row)).join("\n"));
  const result=summarizeChat(bytes,chatId,"http://127.0.0.1:1","business");
  assert.deepEqual(result.runIds,["business"]);assert.equal(result.selectedRunId,"business");assert.equal(result.rows,1);assert.equal(result.excludedRows,1);assert.equal(result.window.start,"2026-10-20T12:05:00.000Z");
  assert.equal(result.counts.calls,1);assert.equal(result.policy.typedUiAndWebSkillDocumentationOnly,true);assert.equal(result.policy.noDirectBackendAccess,true);
  assert.throws(()=>summarizeChat(bytes,chatId,"http://127.0.0.1:1","missing"),/run_identity_not_found/);
});
test("screenshot results retain only a relative referenceName, without media or raw output",()=>{
  const rows=[{chatId,runId:"business",messages:[{role:"assistant",tool_calls:[{id:"shot",function:{name:"surface_screenshot",arguments:"{}"}}]},{role:"tool",tool_call_id:"shot",content:content({response:JSON.stringify({ok:true,result:{referenceName:"screenshot-order-123.png",data:"SECRET-IMAGE",absolutePath:"/PRIVATE/PATH",private:{referenceName:"do-not-read"}}})})}]}];
  const result=summarizeChat(Buffer.from(rows.map(row=>JSON.stringify(row)).join("\n")),chatId,"http://127.0.0.1:1");
  assert.deepEqual(result.screenshotReferences,[{runId:"business",toolCallId:"shot",referenceName:"screenshot-order-123.png"}]);
  assert.ok(!JSON.stringify(result).includes("SECRET-IMAGE"));assert.ok(!JSON.stringify(result).includes("/PRIVATE/PATH"));assert.ok(!JSON.stringify(result).includes("do-not-read"));
});
test("fixed nested diagnostic markers remain distinct from structured error codes",()=>{
  const result=assessResult({content:content({ok:false,error:{code:"desktop_cdp_client_rejected",message:"stale_observation: SECRET-PRIVATE-TEXT"}})});
  assert.deepEqual(result.errorCodes,["desktop_cdp_client_rejected"]);assert.deepEqual(result.diagnosticMarkers,["stale_observation"]);assert.ok(!JSON.stringify(result).includes("SECRET-PRIVATE-TEXT"));
  assert.deepEqual(assessResult({content:content({content:"Documentation: stale_observation and input_value_mismatch"})}).diagnosticMarkers,[]);
});
