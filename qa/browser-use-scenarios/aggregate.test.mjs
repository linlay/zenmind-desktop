import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {summarizeChat} from "../browser-use-acceptance/summarize.mjs";
import {aggregate,normalizeMapping,summarizeToolMetrics,writeAggregateReport} from "./aggregate.mjs";

const chatId="11111111-1111-4111-8111-111111111111",origin="http://127.0.0.1:12345";
const root=path.dirname(fileURLToPath(import.meta.url));
function pair(runId,id,tool,start,duration){return [
  {chatId,runId,seq:1,updatedAt:start,messages:[{role:"assistant",tool_calls:[{id,function:{name:tool,arguments:'{"private":"RAW-SECRET"}'}}]}]},
  {chatId,runId,seq:1,updatedAt:start+duration,messages:[{role:"tool",tool_call_id:id,durationMs:duration,content:[{type:"text",text:'{"response":{"ok":true,"result":{"private":"RAW-SECRET"}}}'}]}]}
];}
const jsonl=rows=>Buffer.from(rows.map(row=>JSON.stringify(row)).join("\n")+"\n");

test("explicit mapping supports one named Chat and per-entry overrides without discovering Runs",()=>{
  const input={schemaVersion:1,chatId,chatJsonl:"/explicit/one.jsonl",runs:[{runId:"run-a",scenario:"handoff"},{runId:"run-b",scenario:"handoff",phase:"followup",chatJsonl:"/explicit/two.jsonl"}]};
  const selected=normalizeMapping(input);assert.equal(selected.length,2);assert.equal(selected[0].phase,"main");assert.equal(selected[1].chatJsonl,"/explicit/two.jsonl");
  assert.throws(()=>normalizeMapping({...input,runs:[...input.runs,input.runs[0]]}),/duplicate_mapped_run/);
  assert.throws(()=>normalizeMapping({...input,chatJsonl:"relative.jsonl"}),/invalid_mapping_entry/);
  assert.throws(()=>normalizeMapping({...input,runs:[{runId:"run-a",scenario:"unknown"}]}),/invalid_mapping_entry/);
});

test("tool durations and characters use matched selected-Run results, excluding seed",()=>{
  const bytes=jsonl([...pair("seed","seed","http_request",1792500000000,999),...pair("selected","a","surface_click",1792500001000,7)]);
  const chat=summarizeChat(bytes,chatId,origin,"selected"),metrics=summarizeToolMetrics(bytes,chat);
  assert.equal(metrics.toolDurationMs,7);assert.equal(metrics.durationSamples,1);assert.equal(metrics.missingDuration,0);assert.equal(metrics.byTool.length,1);assert.equal(metrics.byTool[0].calls,1);assert.equal(metrics.byTool[0].tool,"surface_click");assert.ok(!JSON.stringify(metrics).includes("RAW-SECRET"));
});

test("aggregate reuses immutable named snapshots and leaves manual checks pending",async()=>{
  fs.mkdirSync(path.join(root,"runs"),{recursive:true});const dir=fs.mkdtempSync(path.join(root,"runs","aggregate-unit-"));
  try{
    const file=path.join(dir,"specified-chat.jsonl"),mappingPath=path.join(dir,"mapping.json"),token="a".repeat(48);
    fs.writeFileSync(file,jsonl([...pair("seed","seed","http_request",1792500000000,999),...pair("price","a","surface_click",1792500001000,7),...pair("controls","b","surface_element",1792500002000,11)]));
    fs.writeFileSync(mappingPath,JSON.stringify({schemaVersion:1,evaluationContext:{modelRouteLabel:"Alternate test route",source:"coordinator_ui",alternateRoute:true,performanceComparisonAllowed:false},chatId,chatJsonl:file,runs:[{runId:"price",scenario:"pricing"},{runId:"controls",scenario:"controls"}],reviews:{controls:{status:"fail",reviewedBy:"read_only_audit",reasonCodes:["missing_host_evidence"],runIds:["controls"]}}}));
    fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({runId:"fixture-unit",purpose:"unit-only",baseline:{toolCalls:112,wallMs:177740},verification:{token}}));
    let firstSnapshot,verified=0;
    const verifyRun=async options=>{
      if(firstSnapshot)assert.equal(options.chatBytes,firstSnapshot);else{firstSnapshot=options.chatBytes;fs.appendFileSync(file,jsonl(pair("later-unmapped","late","http_request",1792500003000,9999)));}
      verified++;const summary=summarizeChat(options.chatBytes,options.chatId,origin,options.runId);
      return {generatedAt:new Date().toISOString(),business:{scenarios:["pricing","controls"].map(scenario=>({scenario,status:"pass",checks:[{name:"saved",pass:true}],externalEvidenceRequired:["Confirm host evidence."]}))},chat:{...summary,wallMs:Date.parse(summary.window.end)-Date.parse(summary.window.start),usage:{modelCalls:1,promptTokens:100,completionTokens:2,firstTokenMs:3,generationMs:4},observationBudgets:[],downloadReferences:options.runId==="controls"?["sandbox-receipt.csv"]:[],hostToolResultCounts:{downloads:0,uploads:0,dialogs:0},syntheticSecretLeak:false,operatorButtonClickedByModel:false}};
    };
    const report=await aggregate({runDir:dir,mappingPath},{verifyRun});
    assert.equal(verified,2);assert.equal(report.selection.explicitlyNamedChatFiles,1);assert.equal(report.sources[0].excludedRunCount,1);assert.equal(report.sources[0].excludedRows,2);
    assert.equal(report.totals.toolCalls,2);assert.equal(report.totals.toolDurationMs,18);assert.equal(report.totals.modelCalls,2);assert.equal(report.totals.promptTokens,200);assert.deepEqual(report.totals.downloadReferences,["sandbox-receipt.csv"]);
    assert.equal(report.scenarios.find(s=>s.scenario==="pricing").manualReview.status,"pending");assert.equal(report.scenarios.find(s=>s.scenario==="controls").manualReview.status,"fail");assert.equal(report.scenarios.find(s=>s.scenario==="controls").modelAcceptance,"not_passed");assert.deepEqual(report.totals.explicitReviewFailures,["controls"]);assert.equal(report.scenarios.find(s=>s.scenario==="procurement").coverage,"not_mapped");assert.equal(report.modelAcceptance,"requires_manual_review");
    assert.equal(report.evaluationContext.alternateRoute,true);assert.equal(report.evaluationContext.performanceComparisonAllowed,false);assert.equal(report.scenarios.find(s=>s.scenario==="procurement").baselineComparison.comparisonAllowedByMapping,false);
    assert.ok(!JSON.stringify(report).includes("RAW-SECRET"));assert.ok(!JSON.stringify(report).includes(token));assert.equal(report.readOnly.historyDirectoryScans,0);
    const output=writeAggregateReport(report,dir);assert.equal(fs.statSync(output).mode&0o777,0o600);assert.ok(output.startsWith(path.join(dir,"reports")+path.sep));assert.throws(()=>writeAggregateReport(report,dir,path.join(dir,"outside.json")),/output_must_stay_in_reports/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test("unresolved result has no invented duration",()=>{
  const bytes=jsonl(pair("selected","pending","surface_click",1792500001000,7).slice(0,1));const chat=summarizeChat(bytes,chatId,origin,"selected"),metrics=summarizeToolMetrics(bytes,chat);
  assert.equal(metrics.toolDurationMs,0);assert.equal(metrics.durationSamples,0);assert.equal(metrics.missingDuration,1);assert.equal(metrics.byTool[0].unresolved,1);
});

test("a disabled timeout preserves no-dispatch evidence without automatically calling it a defect",()=>{
  const row=(messages,index)=>({chatId,runId:"selected",seq:index,updatedAt:1792500000000+index,messages});
  const call=(id,name,args)=>({role:"assistant",tool_calls:[{id,function:{name,arguments:JSON.stringify(args)}}]});
  const result=(id,value)=>({role:"tool",tool_call_id:id,durationMs:7,content:[{type:"text",text:JSON.stringify({response:{ok:true,result:value}})}]});
  const bytes=jsonl([row([call("observe","surface_observe",{})],1),row([result("observe",{observationId:"obs",elements:[{ref:"e1",disabled:true}]})],2),row([call("click","surface_click",{observationId:"obs",ref:"e1"})],3),row([result("click",{status:"timeout",action:{outcome:"not_started",pressed:false,released:false}})],4)]);
  const metrics=summarizeToolMetrics(bytes,summarizeChat(bytes,chatId,origin,"selected"));
  assert.equal(metrics.failureEvidence.length,1);assert.equal(metrics.failureEvidence[0].targetObservedDisabled,true);assert.equal(metrics.failureEvidence[0].actionOutcome,"not_started");assert.equal(metrics.failureEvidence[0].inputPressed,false);assert.equal(metrics.failureEvidence[0].classification,"requires_operator_assessment");
});
