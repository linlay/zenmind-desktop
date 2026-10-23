import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const webTools = new Set(["workpanel_open","workpanel_state","workpanel_close","surface_open","surface_list","surface_state","surface_observe","surface_click","surface_element","surface_navigate","surface_activate","surface_close","surface_screenshot","surface_evaluate","surface_cdp","awcp_manual","awcp_invoke"]);
const increment = (counts,key) => { counts[key]=(counts[key]??0)+1; };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const safeName = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(value) ? value : "unknown";
const codeName = value => typeof value === "string" && (/^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,12}$/.test(value) || /^E[A-Z0-9_]{1,35}$/.test(value) || /^\d{3,5}$/.test(value)) && value.length<=100 ? value : null;
const textContent = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part=>part?.type==="text").map(part=>part.text??"").join("\n") : "";
const jsonValue = value => { if(typeof value!=="string")return value;try{return JSON.parse(value);}catch{return null;} };
const timestamp = value => typeof value==="number" && Number.isFinite(value) && value>1e12 ? value : typeof value==="string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => value===null ? null : new Date(value).toISOString();

function parseJsonl(bytes) {
  const records=[], invalidLines=[];
  const text=bytes.toString("utf8"), lines=text.split("\n");
  let trailingPartial=false;
  for(let i=0;i<lines.length;i++){
    if(!lines[i].trim())continue;
    try{records.push({line:i+1,value:JSON.parse(lines[i])});}
    catch{if(i===lines.length-1&&!text.endsWith("\n"))trailingPartial=true;else invalidLines.push(i+1);}
  }
  return {records,invalidLines,trailingPartial};
}

export function classifyCall(name,args,fixtureOrigin) {
  let family=webTools.has(name)?"web_control":name==="file_read"?"file_read":name==="wait"?"general_wait":"non_web_tool";
  const paths=[args.filePath,args.path,...(Array.isArray(args.filePaths)?args.filePaths:[])].filter(value=>typeof value==="string");
  const skillDocumentation=name==="file_read" && paths.length>0 && paths.every(value=>/\bbuiltin\.[a-z0-9_.-]+\//i.test(value.replaceAll("\\","/")) && /\.md$/i.test(value));
  const skillOnly=name==="file_read" && paths.length>0 && paths.every(value=>value.replaceAll("\\","/").includes("builtin.web-control/") && /\/(?:SKILL|surface|commands|workpanel|awcp|chrome-workflows|troubleshooting)\.md$/.test(value.replaceAll("\\","/")));
  const fixtureFile=name==="file_read" && paths.some(value=>value.replaceAll("\\","/").includes("browser-use-acceptance/"));
  const method=typeof args.method==="string"?safeName(args.method):null;
  const pageScript=name==="surface_evaluate" || ((name==="surface_cdp"||name==="desktop_cdp") && ["Runtime.evaluate","Runtime.callFunctionOn","Page.addScriptToEvaluateOnNewDocument"].includes(method));
  const expression=typeof args.expression==="string"?args.expression:typeof args.params?.expression==="string"?args.params.expression:"";
  const forbiddenScript=/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|eval|Function)\b|\.(click|submit|requestSubmit|dispatchEvent|setAttribute|removeAttribute|append|appendChild|remove|replaceChildren|insertAdjacentHTML)\s*\(|\.(innerHTML|outerHTML|textContent|value|checked|selectedIndex)\s*=(?!=)/;
  const domReadCandidate=pageScript && !!expression && /\b(document|querySelector|querySelectorAll)\b/.test(expression) && !forbiddenScript.test(expression) && !args.expressionFile;
  const backendAccess=name==="web_fetch"||name==="web_search"||name==="http"||name==="http_request"||name==="http_cli"|| (name==="surface_cdp"&&/^Network\.(?:loadNetworkResource|replayXHR)/.test(method??"")) || (pageScript&&/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(expression));
  if(name==="desktop_cdp")family="web_raw_bridge";
  const targetValues=[args.url,args.params?.url,args.href].filter(value=>typeof value==="string");
  let outsideFixtureTargets=0;
  for(const value of targetValues){try{if(new URL(value).origin!==fixtureOrigin)outsideFixtureTargets++;}catch{if(name==="workpanel_open"||name==="surface_open")outsideFixtureTargets++;}}
  return {family,web:family==="web_control"||family==="web_raw_bridge",skillOnly,skillDocumentation,fixtureFile,pageScript,domReadCandidate,backendAccess,fileBackedScript:!!args.expressionFile,outsideFixtureTargets,operation:method??(typeof args.action==="string"?safeName(args.action):null)};
}

export function assessResult(message) {
  const text=textContent(message.content), parsed=jsonValue(text);
  const codes=new Set(); let failed=message.isError===true||message.is_error===true, explicitSuccess=false, uncertain=false;
  const addCode=value=>{const safe=codeName(value);if(safe)codes.add(safe);};
  const errorStrings=[], diagnosticMarkers=new Set();
  function visit(value,depth=0){
    if(depth>12||!value||typeof value!=="object"||Array.isArray(value))return;
    if(value.ok===false||value.success===false||value.isError===true||value.is_error===true)failed=true;
    if(value.ok===true||value.success===true||value.exitCode===0||["success","completed"].includes(value.status))explicitSuccess=true;
    if(typeof value.exitCode==="number"&&value.exitCode!==0)failed=true;
    if(["failed","error","timeout","canceled","cancelled"].includes(value.status)){failed=true;addCode(value.status.includes("_")?value.status:`tool_${value.status}`);}
    if(value.status==="navigation"||value.action?.outcome==="unknown")uncertain=true;
    if(value.exceptionDetails){failed=true;addCode("javascript_exception");}
    if(value.error && (typeof value.error!=="object"||Object.keys(value.error).length>0)){
      failed=true;
      if(typeof value.error==="string"){errorStrings.push(value.error);addCode(value.error);}
      else{addCode(value.error.code);visit(value.error,depth+1);}
    }
    if(failed){addCode(value.code);addCode(value.errorCode);addCode(value.error_code);if(typeof value.message==="string")errorStrings.push(value.message);}
    for(const key of ["response","result","data","output"]){
      const nested=jsonValue(value[key]);if(nested&&typeof nested==="object")visit(nested,depth+1);
      if(failed&&typeof value[key]==="string")errorStrings.push(value[key]);
    }
  }
  visit(parsed);
  if(!parsed&&/^\s*(?:Error:|ERROR:|错误[:：]|失败[:：])/.test(text)){failed=true;errorStrings.push(text);}
  if(failed){
    for(const value of errorStrings){
      const normalized=value.replaceAll('\\"','"');
      for(const match of normalized.matchAll(/"(?:code|errorCode|error_code)"\s*:\s*"([A-Za-z0-9_]{1,100})"/g))addCode(match[1]);
      for(const match of value.matchAll(/\b(?:browser_[a-z_]+|desktop_(?:action|cdp)_[a-z_]+|surface_[a-z_]+_(?:failed|unavailable|forbidden|found))\b/g))addCode(match[0]);
      for(const marker of ["stale_observation","input_value_mismatch","element_obscured","browser_disconnected","target_closed","observation_mismatch"])if(new RegExp(`\\b${marker}\\b`).test(value))diagnosticMarkers.add(marker);
    }
    if(!codes.size)codes.add("uncoded_tool_failure");
  }
  return {outcome:failed?"failure":uncertain?"indeterminate":"success",successEvidence:failed?null:explicitSuccess?"explicit_result_flag":"completed_tool_message_without_declared_failure",errorCodes:[...codes].sort(),diagnosticMarkers:[...diagnosticMarkers].sort()};
}

function screenshotReferences(message) {
  const values=new Set();
  function visit(value,depth=0){
    value=jsonValue(value);
    if(depth>12||!value||typeof value!=="object"||Array.isArray(value))return;
    if(typeof value.referenceName==="string"&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value.referenceName)&&!value.referenceName.split("/").includes(".."))values.add(value.referenceName);
    for(const key of ["response","result","data","output"])visit(value[key],depth+1);
  }
  visit(textContent(message.content));
  return [...values];
}

export function summarizeChat(bytes,chatId,fixtureOrigin,selectedRunId=null) {
  const parsed=parseJsonl(bytes), calls=[], pending=new Map(), fingerprints=new Set(), resultFingerprints=new Set(), warnings=[];
  const times=[], runIds=new Set(), modeHints=new Set(); let duplicateCalls=0, duplicateResults=0, orphanResults=0, selectedRows=0;
  const escaped=fixtureOrigin.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const modePattern=new RegExp(escaped+"/(workpanel|chrome)/","g");
  for(const {line,value:row} of parsed.records){
    if(row.chatId!==undefined&&row.chatId!==chatId)throw new Error("chat_identity_mismatch");
    const runId=typeof row.runId==="string"?row.runId:"unknown";
    if(selectedRunId!==null&&runId!==selectedRunId)continue;
    selectedRows++;runIds.add(runId);
    const updated=timestamp(row.updatedAt);if(updated!==null)times.push(updated);
    for(const message of Array.isArray(row.messages)?row.messages:[]){
      const ts=timestamp(message.ts);if(ts!==null)times.push(ts);
      if(message.role==="user")for(const match of textContent(message.content).matchAll(modePattern))modeHints.add(match[1]);
      for(const call of Array.isArray(message.tool_calls)?message.tool_calls:[]){
        const id=typeof call.id==="string"?call.id:`missing-${line}-${calls.length}`,name=safeName(call.function?.name??call.name), args=jsonValue(call.function?.arguments??{})??{};
        const fingerprint=`${runId}|${id}|${message._msgId??""}|${sha(Buffer.from(JSON.stringify(call.function??call)))}`;
        if(fingerprints.has(fingerprint)){duplicateCalls++;continue;}fingerprints.add(fingerprint);
        const entry={sequence:calls.length+1,line,runId,toolCallId:id,tool:name,at:iso(ts??updated),...classifyCall(name,args,fixtureOrigin),outcome:"unresolved",errorCodes:[]};
        const key=`${runId}|${id}`;if(pending.has(key))warnings.push({code:"duplicate_pending_tool_call_id",line});
        const list=pending.get(key)??[];list.push(entry);pending.set(key,list);calls.push(entry);
      }
      if(message.role==="tool"){
        const id=message.tool_call_id??message.toolCallId;
        const resultFingerprint=`${runId}|${id}|${sha(Buffer.from(JSON.stringify(message)))}`;
        if(resultFingerprints.has(resultFingerprint)){duplicateResults++;continue;}resultFingerprints.add(resultFingerprint);
        const key=`${runId}|${id}`, list=pending.get(key), entry=list?.shift();if(list?.length===0)pending.delete(key);
        if(!entry){orphanResults++;continue;}
        Object.assign(entry,assessResult(message),{resultLine:line,resultAt:iso(ts??updated)});
        if(entry.tool==="surface_screenshot"&&entry.outcome==="success")entry.referenceNames=screenshotReferences(message);
      }
    }
  }
  const byTool={}, errorCodes={}, diagnosticMarkers={}, families={};
  for(const call of calls){
    const item=byTool[call.tool]??={tool:call.tool,family:call.family,calls:0,success:0,failure:0,indeterminate:0,unresolved:0,skillDocumentationReads:0,pageScriptCalls:0,domReadCandidates:0,operations:{},errorCodes:{}};
    item.calls++;item[call.outcome]++;if(call.skillDocumentation)item.skillDocumentationReads++;if(call.pageScript)item.pageScriptCalls++;if(call.domReadCandidate)item.domReadCandidates++;
    if(call.operation)increment(item.operations,call.operation);for(const code of call.errorCodes){increment(item.errorCodes,code);increment(errorCodes,code);}for(const marker of call.diagnosticMarkers??[])increment(diagnosticMarkers,marker);increment(families,call.family);
  }
  const nonWeb=calls.filter(call=>!call.web), docs=nonWeb.filter(call=>call.skillOnly), nonDocs=nonWeb.filter(call=>!call.skillOnly), pageScripts=calls.filter(call=>call.pageScript);
  const start=times.length?Math.min(...times):null,end=times.length?Math.max(...times):null;
  if(selectedRunId!==null&&selectedRows===0)throw new Error("run_identity_not_found");
  return {chatId,fileSha256:sha(bytes),bytes:bytes.length,rows:selectedRows,sourceRows:parsed.records.length,excludedRows:parsed.records.length-selectedRows,selectedRunId,runIds:[...runIds],window:{start:iso(start),end:iso(end)},modeHints:[...modeHints],
    counts:{calls:calls.length,success:calls.filter(call=>call.outcome==="success").length,failure:calls.filter(call=>call.outcome==="failure").length,indeterminate:calls.filter(call=>call.outcome==="indeterminate").length,unresolved:calls.filter(call=>call.outcome==="unresolved").length},
    policy:{strictWebToolsOnly:calls.length>0&&nonWeb.length===0,webToolsAndWebSkillDocumentationOnly:calls.length>0&&nonDocs.length===0,typedUiAndWebSkillDocumentationOnly:calls.length>0&&nonDocs.length===0&&pageScripts.length===0&&!calls.some(call=>["surface_cdp","desktop_cdp","awcp_invoke"].includes(call.tool)),noNonDocumentationFileReads:!calls.some(call=>call.family==="file_read"&&!call.skillDocumentation),noFixtureBusinessFileReads:!calls.some(call=>call.fixtureFile),noDirectBackendAccess:!calls.some(call=>call.backendAccess),zeroPageScripts:pageScripts.length===0,
      nonWebCalls:nonWeb.length,skillDocumentationReads:calls.filter(call=>call.skillDocumentation).length,webSkillDocumentationReads:docs.length,otherNonWebCalls:nonDocs.length,pageScriptCalls:pageScripts.length,domReadCandidates:pageScripts.filter(call=>call.domReadCandidate).length,rawCdpCalls:calls.filter(call=>["surface_cdp","desktop_cdp"].includes(call.tool)).length,fileBackedScriptCalls:calls.filter(call=>call.fileBackedScript).length,outsideFixtureTargetCalls:calls.filter(call=>call.outsideFixtureTargets).length,newChatCalls:calls.filter(call=>call.tool==="chat_start").length},
    byTool:Object.values(byTool),errorCodes,diagnosticMarkers,screenshotReferences:calls.filter(call=>call.tool==="surface_screenshot").flatMap(call=>(call.referenceNames??[]).map(referenceName=>({runId:call.runId,toolCallId:call.toolCallId,referenceName}))),integrity:{invalidLines:parsed.invalidLines,trailingPartial:parsed.trailingPartial,duplicateCalls,duplicateResults,orphanResults,warnings},calls};
}

export function summarizeLedger(bytes,chat,mode) {
  const parsed=parseJsonl(bytes), start=timestamp(chat.window.start),end=timestamp(chat.window.end);
  const inWindow=event=>start!==null&&end!==null&&timestamp(event.at)!==null&&timestamp(event.at)>=start-2000&&timestamp(event.at)<=end+2000;
  const rows=parsed.records.map(record=>record.value), byMode={};
  for(const selectedMode of ["workpanel","chrome"]){
    const all=rows.filter(row=>row.mode===selectedMode), window=all.filter(inWindow), types={},windowTypes={};
    for(const event of all)increment(types,safeName(event.type));for(const event of window)increment(windowTypes,safeName(event.type));
    const orders=all.filter(event=>event.type==="order_submitted"),windowOrders=window.filter(event=>event.type==="order_submitted");
    byMode[selectedMode]={events:all.length,types,chatWindowEvents:window.length,chatWindowTypes:windowTypes,pageViews:types.page_view??0,localSubmissions:orders.length,chatWindowLocalSubmissions:windowOrders.length,
      exactlyOneLocalSubmission:orders.length===1,exactlyOneLocalSubmissionInChatWindow:windowOrders.length===1,orderIds:orders.map(event=>event.details?.id).filter(id=>typeof id==="string"&&/^(WP|CH)-[A-Z0-9-]{1,60}$/.test(id)),trustedUiEvents:all.filter(event=>event.details?.trusted===true).length,untrustedOrUnmarkedEvents:all.filter(event=>event.details?.trusted!==true).length,
      firstEventAt:all[0]?.at??null,lastEventAt:all.at(-1)?.at??null};
  }
  return {fileSha256:sha(bytes),events:rows.length,byMode,selectedMode:mode??null,selected:mode?byMode[mode]:null,integrity:{invalidLines:parsed.invalidLines,trailingPartial:parsed.trailingPartial}};
}

export async function buildSummary(options) {
  const runDir=path.resolve(options.runDir), chatId=String(options.chatId??"");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId))throw new Error("invalid_chat_id");
  const manifestPath=path.join(runDir,"manifest.json"), manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
  if(typeof manifest.verification?.token!=="string"||!/^[0-9a-f]{48}$/.test(manifest.verification.token))throw new Error("invalid_verifier_manifest");
  const fixtureOrigin=new URL(manifest.baseUrl).origin;
  const endpoint=new URL(manifest.verification.check);
  if(endpoint.protocol!=="http:"||endpoint.hostname!=="127.0.0.1"||endpoint.origin!==fixtureOrigin||endpoint.pathname!=="/_verify/check"||endpoint.search)throw new Error("invalid_verifier_endpoint");
  const chatFile=options.chatJsonl?path.resolve(options.chatJsonl):path.join(options.chatRoot??path.join(os.homedir(),".cutej","chats"),`${chatId}.jsonl`);
  if(fs.statSync(chatFile).size>64*1024*1024)throw new Error("specified_chat_too_large");
  if(options.runId!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(options.runId))throw new Error("invalid_run_id");
  const chat=summarizeChat(fs.readFileSync(chatFile),chatId,fixtureOrigin,options.runId??null);
  const mode=options.mode??(chat.modeHints.length===1?chat.modeHints[0]:null);
  if(mode!==null&&!["workpanel","chrome"].includes(mode))throw new Error("invalid_dataset_mode");
  let ledgerBytes=Buffer.alloc(0),ledgerPresent=true;
  try{ledgerBytes=fs.readFileSync(path.join(runDir,"ledger.jsonl"));}catch(error){if(error.code!=="ENOENT")throw error;ledgerPresent=false;}
  const ledger=summarizeLedger(ledgerBytes,chat,mode);ledger.present=ledgerPresent;
  const response=await fetch(endpoint,{headers:{"X-Acceptance-Token":manifest.verification.token},redirect:"error",signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error("verifier_read_failed");
  const values=await response.json(), checks=Array.isArray(values)?values:[values];
  const business=checks.map(value=>({mode:safeName(value.mode),status:["pass","fail","pending"].includes(value.status)?value.status:"unknown",passed:value.checks.filter(item=>item.pass===true).length,total:value.checks.length,
    checks:value.checks.map(item=>({name:safeName(item.name),pass:item.pass===true})),orderId:typeof value.orderId==="string"&&/^(WP|CH)-[A-Z0-9-]{1,60}$/.test(value.orderId)?value.orderId:null}));
  const selected=business.find(value=>value.mode===mode);
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),fixtureRunId:manifest.runId,chat,ledger,business,
    conclusion:{mode,strictWebToolsOnly:chat.policy.strictWebToolsOnly,webToolsAndWebSkillDocumentationOnly:chat.policy.webToolsAndWebSkillDocumentationOnly,typedUiAndWebSkillDocumentationOnly:chat.policy.typedUiAndWebSkillDocumentationOnly,zeroPageScripts:chat.policy.zeroPageScripts,
      businessCurrentState:selected?.status??"unattributed",singleSubmissionInThisChatWindow:ledger.selected?.exactlyOneLocalSubmissionInChatWindow??null,
      businessEvidenceInChatWindow:ledger.selected?.chatWindowLocalSubmissions?"submission":ledger.selected?.chatWindowEvents?"activity_without_submission":"none",
      businessCompletionConsistentWithThisChat:selected?.status==="pass"&&ledger.selected?.exactlyOneLocalSubmissionInChatWindow===true&&chat.calls.some(call=>call.web&&call.outcome==="success"),
      sourceChatReadOnly:true,websiteMutationsBySummarizer:0,userHistoryDirectoryScans:0},
    limitations:["The verifier describes current dataset state and can include a later Chat; ledger timestamps separately identify submissions in this Chat's observed time window.","DOM read candidates use a static heuristic. They are page script calls and must not be reported as zero code execution.","HTTP ledger entries do not carry a Run identity. Temporal alignment and Chat tool records are evidence of consistency, not a cryptographic attribution proof.","Skill documentation reads are listed separately and do not make the literal web-tools-only flag pass.","No prompts, reasoning, tool arguments, raw outputs, credential values, verifier token or user file contents are included."]};
  // Defensive final scrub, even if an untrusted tool name or error code happened to contain the verifier credential.
  return JSON.parse(JSON.stringify(report).split(manifest.verification.token).join("[redacted]"));
}

async function main() {
  const args=process.argv.slice(2), options={};
  const keys={"--run-dir":"runDir","--chat-id":"chatId","--chat-jsonl":"chatJsonl","--chat-root":"chatRoot","--run-id":"runId","--mode":"mode","--output":"output"};
  for(let index=0;index<args.length;index++){if(!keys[args[index]]||!args[index+1])throw new Error("invalid_arguments");options[keys[args[index]]]=args[++index];}
  if(!options.runDir||!options.chatId)throw new Error("missing_arguments");
  const result=await buildSummary(options), output=JSON.stringify(result,null,2)+"\n";
  if(options.output){const filename=path.resolve(options.output),allowed=path.resolve(options.runDir)+path.sep;if(!filename.startsWith(allowed))throw new Error("report_must_stay_in_run_directory");fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});fs.writeFileSync(filename,output,{mode:0o600});fs.chmodSync(filename,0o600);}
  process.stdout.write(output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(error=>{const allowed=new Set(["invalid_chat_id","invalid_run_id","run_identity_not_found","invalid_verifier_endpoint","invalid_verifier_manifest","specified_chat_too_large","invalid_dataset_mode","verifier_read_failed","chat_identity_mismatch","invalid_arguments","missing_arguments","report_must_stay_in_run_directory"]);console.error(JSON.stringify({error:allowed.has(error.message)?error.message:"evidence_summary_failed"}));process.exitCode=1;});}
