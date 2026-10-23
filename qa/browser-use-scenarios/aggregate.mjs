import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {pathToFileURL} from "node:url";
import {verify} from "./verify.mjs";

const scenarios = ["pricing", "controls", "async", "frames", "dialogs", "tabs", "files", "budget", "handoff", "resume", "procurement"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const text = value => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n") : "";
const sum = values => values.reduce((a, b) => a + b, 0);

export function normalizeMapping(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.runs) || input.runs.length < 1 || input.runs.length > 64)
    throw new Error("invalid_mapping");
  const seen = new Set();
  return input.runs.map((entry, index) => {
    const chatJsonl = entry?.chatJsonl ?? input.chatJsonl;
    const chatId = entry?.chatId ?? input.chatId;
    const phase = entry?.phase ?? "main";
    if (typeof chatJsonl !== "string" || !path.isAbsolute(chatJsonl) || !uuid.test(chatId ?? "") ||
        !identifier.test(entry?.runId ?? "") || !scenarios.includes(entry?.scenario) || !identifier.test(phase))
      throw new Error("invalid_mapping_entry");
    const key = `${chatId}|${entry.runId}`;
    if (seen.has(key)) throw new Error("duplicate_mapped_run");
    seen.add(key);
    return {index, chatJsonl: path.resolve(chatJsonl), chatId, runId: entry.runId, scenario: entry.scenario, phase};
  });
}

function rowsByLine(bytes) {
  return bytes.toString("utf8").split("\n").map((line, index) => {
    if (!line.trim()) return {line: index + 1, value: null};
    try { return {line: index + 1, value: JSON.parse(line)}; }
    catch { return {line: index + 1, value: null}; }
  });
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {samples: values.length, total: sum(values), mean: values.length ? sum(values) / values.length : null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, max: sorted.at(-1) ?? null};
}

export function summarizeToolMetrics(bytes, chat) {
  const rows = rowsByLine(bytes), byTool = new Map(), observations = new Map(), failureEvidence = [];
  const parse = value => { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } };
  const visit = (value, fn, depth = 0) => {
    value = parse(value);
    if (depth > 14 || !value || typeof value !== "object" || Array.isArray(value)) return;
    fn(value);
    for (const key of ["response", "result", "data", "output", "observation"]) visit(value[key], fn, depth + 1);
  };
  for (const call of chat.calls) {
    let item = byTool.get(call.tool);
    if (!item) {
      item = {tool: call.tool, calls: 0, success: 0, failure: 0, indeterminate: 0, unresolved: 0,
        durations: [], missingDuration: 0, resultCharacters: 0, resultUtf8Bytes: 0};
      byTool.set(call.tool, item);
    }
    item.calls++;
    item[call.outcome]++;
    const row = rows[call.resultLine - 1]?.value;
    const message = row?.messages?.find(message => message.role === "tool" &&
      (message.tool_call_id ?? message.toolCallId) === call.toolCallId);
    if (!message) { item.missingDuration++; continue; }
    if (typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0)
      item.durations.push(message.durationMs);
    else item.missingDuration++;
    const content = text(message.content);
    item.resultCharacters += Array.from(content).length;
    item.resultUtf8Bytes += Buffer.byteLength(content);
    const result = parse(content), actionDetails = {};
    visit(result, value => {
      if (typeof value.observationId === "string" && Array.isArray(value.elements))
        observations.set(value.observationId, new Map(value.elements.map(element => [element.ref, {disabled: element.disabled}])));
      if (["clicked", "condition_met", "timeout", "canceled", "failed", "navigation"].includes(value.status)) actionDetails.status = value.status;
      if (value.action && ["not_started", "complete", "unknown"].includes(value.action.outcome)) {
        actionDetails.outcome = value.action.outcome;
        actionDetails.pressed = value.action.pressed === true;
        actionDetails.released = value.action.released === true;
      }
    });
    if (call.outcome === "failure") {
      const sourceCall = rows[call.line - 1]?.value?.messages?.flatMap(message => message.tool_calls ?? []).find(item => item.id === call.toolCallId);
      const args = parse(sourceCall?.function?.arguments) ?? {};
      const disabled = observations.get(args.observationId)?.get(args.ref)?.disabled;
      failureEvidence.push({sequence: call.sequence, tool: call.tool, toolCallId: call.toolCallId,
        errorCodes: call.errorCodes, diagnosticMarkers: call.diagnosticMarkers ?? [],
        targetObservedDisabled: typeof disabled === "boolean" ? disabled : null,
        actionStatus: actionDetails.status ?? null, actionOutcome: actionDetails.outcome ?? null,
        inputPressed: actionDetails.pressed ?? null, inputReleased: actionDetails.released ?? null,
        classification: "requires_operator_assessment",
        note: "A disabled target refused before input dispatch can be an intentional negative check. Failure counts alone do not establish a product defect."});
    }
  }
  const tools = [...byTool.values()].map(({durations, ...item}) => ({...item, durationMs: statistics(durations)}));
  return {byTool: tools, failureEvidence, toolDurationMs: sum(tools.map(tool => tool.durationMs.total)),
    durationSamples: sum(tools.map(tool => tool.durationMs.samples)),
    missingDuration: sum(tools.map(tool => tool.missingDuration)),
    resultCharacters: sum(tools.map(tool => tool.resultCharacters)),
    resultUtf8Bytes: sum(tools.map(tool => tool.resultUtf8Bytes))};
}

export async function aggregate(options, dependencies = {}) {
  const verifyRun = dependencies.verifyRun ?? verify;
  const runDir = path.resolve(options.runDir);
  const mappingBytes = fs.readFileSync(path.resolve(options.mappingPath));
  if (mappingBytes.length > 1024 * 1024) throw new Error("mapping_too_large");
  const input = JSON.parse(mappingBytes), selected = normalizeMapping(input), reviews = input.reviews ?? {};
  if (!reviews || typeof reviews !== "object" || Array.isArray(reviews)) throw new Error("invalid_reviews");
  for (const [scenario, review] of Object.entries(reviews)) {
    if (!scenarios.includes(scenario) || !review || !["pending", "pass", "fail"].includes(review.status) ||
        (review.reviewedBy !== undefined && !identifier.test(review.reviewedBy)) ||
        !Array.isArray(review.reasonCodes) || !review.reasonCodes.every(code => identifier.test(code)) ||
        !Array.isArray(review.runIds) || !review.runIds.length ||
        !review.runIds.every(runId => selected.some(entry => entry.runId === runId && entry.scenario === scenario)))
      throw new Error("invalid_reviews");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  const sourceSnapshots = new Map();
  for (const entry of selected) {
    const existing = sourceSnapshots.get(entry.chatJsonl);
    if (existing) {
      if (existing.chatId !== entry.chatId) throw new Error("conflicting_chat_identity");
      existing.runIds.add(entry.runId);
      continue;
    }
    const bytes = fs.readFileSync(entry.chatJsonl);
    if (bytes.length > 64 * 1024 * 1024) throw new Error("specified_chat_too_large");
    sourceSnapshots.set(entry.chatJsonl, {bytes, chatId: entry.chatId, runIds: new Set([entry.runId])});
  }
  const startedAt = new Date().toISOString(), runs = [];
  let business, businessCheckedAt;
  for (const entry of selected) {
    const snapshot = sourceSnapshots.get(entry.chatJsonl);
    const evidence = await verifyRun({runDir, chatJsonl: entry.chatJsonl, chatBytes: snapshot.bytes,
      chatId: entry.chatId, runId: entry.runId});
    if (evidence.chat?.selectedRunId !== entry.runId || evidence.chat?.chatId !== entry.chatId ||
        evidence.chat.fileSha256 !== sha(snapshot.bytes)) throw new Error("evidence_snapshot_mismatch");
    // One final checker response supplies a consistent current dataset snapshot for
    // every scenario. It is not attributed retroactively to each historical Run.
    business = evidence.business;
    businessCheckedAt = evidence.generatedAt;
    const metrics = summarizeToolMetrics(snapshot.bytes, evidence.chat);
    const selectedRows = rowsByLine(snapshot.bytes).filter(row => row.value?.runId === entry.runId);
    const lastMessages = selectedRows.findLast(row => row.value?.messages?.length)?.value?.messages ?? [];
    const finalAssistantTextObserved = lastMessages.some(message => message.role === "assistant" &&
      !message.tool_calls?.length && text(message.content).trim().length > 0);
    runs.push({scenario: entry.scenario, phase: entry.phase, chatId: entry.chatId, runId: entry.runId,
      sourceSha256: evidence.chat.fileSha256, sourceReadOnly: true,
      window: evidence.chat.window, wallMs: evidence.chat.wallMs, counts: evidence.chat.counts,
      completionEvidence: {finalAssistantTextObserved, lastPersistedMessageRole: lastMessages.at(-1)?.role ?? null,
        terminalEvent: evidence.chat.terminalEvents?.at(-1) ?? null,
        note: evidence.chat.terminalEvents?.length ? "A terminal Run event is preserved separately from browser tool outcomes; inspect its error code."
          : finalAssistantTextObserved ? "A final assistant text is persisted; operator still confirms actual Run status."
            : "No final assistant text is persisted. This window is a partial stored span, not completed Run latency or proof of a browser failure."},
      policy: evidence.chat.policy, errorCodes: evidence.chat.errorCodes,
      diagnosticMarkers: evidence.chat.diagnosticMarkers, integrity: evidence.chat.integrity,
      usage: evidence.chat.usage, modelKeys: evidence.chat.modelKeys ?? [], ...metrics,
      observationBudgets: evidence.chat.observationBudgets,
      syntheticSecretLeak: evidence.chat.syntheticSecretLeak,
      operatorButtonClickedByModel: evidence.chat.operatorButtonClickedByModel,
      hostToolResultCounts: evidence.chat.hostToolResultCounts,
      downloadReferences: evidence.chat.downloadReferences,
      screenshotReferences: evidence.chat.screenshotReferences,
      modelAcceptance: "requires_manual_review"});
  }
  const current = new Map((business?.scenarios ?? []).map(item => [item.scenario, item]));
  const groups = scenarios.map(scenario => {
    const mapped = runs.filter(run => run.scenario === scenario), observed = current.get(scenario), review = reviews[scenario];
    const row = {scenario, coverage: mapped.length ? "mapped" : "not_mapped", runs: mapped.map(run => ({chatId: run.chatId, runId: run.runId, phase: run.phase})),
      currentBusiness: observed ? {status: observed.status, passed: observed.checks.filter(check => check.pass).length,
        total: observed.checks.length, checks: observed.checks, ...(observed.orderId ? {orderId: observed.orderId} : {})} : null,
      toolCalls: sum(mapped.map(run => run.counts.calls)), activeRunWallMsSum: sum(mapped.map(run => run.wallMs ?? 0)),
      llmReportedMs: sum(mapped.map(run => (run.usage?.firstTokenMs ?? 0) + (run.usage?.generationMs ?? 0))),
      toolDurationMs: sum(mapped.map(run => run.toolDurationMs)),
      downloadReferences: [...new Set(mapped.flatMap(run => run.downloadReferences ?? []))],
      manualReview: {status: mapped.length ? review?.status ?? "pending" : "not_mapped", reviewedBy: review?.reviewedBy ?? null,
        reasonCodes: review?.reasonCodes ?? [], evidenceRunIds: review?.runIds ?? [], evidence: null,
        checks: ["Confirm these are real CuteJ model Runs and that the specified tool records belong to this scenario.",
          "Correlate current business checks with the recorded Run windows; current dataset state is not a per-Run historical snapshot.",
          ...(observed?.externalEvidenceRequired ?? [])]}, modelAcceptance: review?.status === "fail" ? "not_passed" : mapped.length ? "requires_manual_review" : "not_mapped"};
    if (scenario === "procurement") row.baselineComparison = {baseline: manifest.baseline,
      comparisonAllowedByMapping: input.evaluationContext?.performanceComparisonAllowed !== false,
      toolCallDelta: mapped.length && input.evaluationContext?.performanceComparisonAllowed !== false ? row.toolCalls - manifest.baseline.toolCalls : null,
      wallMsDelta: mapped.length && input.evaluationContext?.performanceComparisonAllowed !== false ? row.activeRunWallMsSum - manifest.baseline.wallMs : null,
      singleMappedRun: mapped.length === 1,
      correctnessReadyForManualReview: observed?.status === "pass" && mapped.length === 1 && mapped[0].counts.unresolved === 0 && mapped[0].completionEvidence.finalAssistantTextObserved,
      timingComparisonAccepted: false,
      note: "Accept a speed comparison only after manual review confirms equivalent 13-check work and one local submission. Multiple Run sums exclude operator gaps."};
    return row;
  });
  const sources = [...sourceSnapshots.entries()].map(([filename, source]) => {
    const rows = rowsByLine(source.bytes).filter(row => row.value), excluded = rows.filter(row => !source.runIds.has(row.value.runId));
    return {chatId: source.chatId, fileName: path.basename(filename), sha256: sha(source.bytes), bytes: source.bytes.length,
      selectedRunIds: [...source.runIds], selectedRows: rows.length - excluded.length,
      excludedRows: excluded.length, excludedRunCount: new Set(excluded.map(row => row.value.runId)).size};
  });
  const report = {schemaVersion: 1, generatedAt: new Date().toISOString(), startedAt, fixtureRunId: manifest.runId,
    fixturePurpose: manifest.purpose,
    evaluationContext: input.evaluationContext ? {
      modelRouteLabel: typeof input.evaluationContext.modelRouteLabel === "string" ? input.evaluationContext.modelRouteLabel.slice(0,160) : null,
      source: input.evaluationContext.source === "coordinator_ui" ? "coordinator_ui" : "explicit_mapping",
      alternateRoute: input.evaluationContext.alternateRoute === true,
      performanceComparisonAllowed: input.evaluationContext.performanceComparisonAllowed !== false
    } : null,
    selection: {explicitMapping: true, automaticRunDiscovery: false, immutableChatSnapshots: true,
      selectedRuns: selected.length, explicitlyNamedChatFiles: sources.length, historyDirectoryScans: 0},
    sources, businessCheckedAt, scenarios: groups, runs,
    totals: {mappedScenarios: groups.filter(group => group.coverage === "mapped").length,
      mappedScenariosCurrentBusinessPass: groups.filter(group => group.coverage === "mapped" && group.currentBusiness?.status === "pass").length,
      explicitReviewFailures: groups.filter(group => group.manualReview.status === "fail").map(group => group.scenario),
      toolCalls: sum(runs.map(run => run.counts.calls)), success: sum(runs.map(run => run.counts.success)),
      failure: sum(runs.map(run => run.counts.failure)), unresolved: sum(runs.map(run => run.counts.unresolved)),
      activeRunWallMsSum: sum(runs.map(run => run.wallMs ?? 0)),
      llmReportedMs: sum(runs.map(run => (run.usage?.firstTokenMs ?? 0) + (run.usage?.generationMs ?? 0))),
      toolDurationMs: sum(runs.map(run => run.toolDurationMs)), promptTokens: sum(runs.map(run => run.usage?.promptTokens ?? 0)),
      completionTokens: sum(runs.map(run => run.usage?.completionTokens ?? 0)), modelCalls: sum(runs.map(run => run.usage?.modelCalls ?? 0)),
      observationBudgetRecords: sum(runs.map(run => run.observationBudgets?.length ?? 0)),
      downloadReferences: [...new Set(runs.flatMap(run => run.downloadReferences ?? []))]},
    modelAcceptance: "requires_manual_review", readOnly: {websiteMutations: 0, historyDirectoryScans: 0, sourceChatWrites: 0},
    limitations: ["Only explicitly mapped Runs from explicitly named Chat files are counted; seed and other Runs are excluded.",
      "Business checks describe the latest single checker response, not the state at each Run's historical end.",
      "Wall times are sums of selected Run windows; pauses between Runs and operator actions are excluded.",
      "Model usage is deduplicated by Run/seq and sums persisted per-call usage. Incomplete/canceled turns may have no persisted usage.",
      "Duration comes from matched tool result durationMs. Missing or unresolved results are reported, not estimated.",
      "The tool does not automatically approve all scenarios. Native dialogs, tab identity, download persistence, human action and cancellation require manual host/Chat review.",
      "No prompts, reasoning, tool arguments, raw results, file bytes, synthetic credential values or verifier token are included."]};
  const token = manifest.verification?.token;
  return token ? JSON.parse(JSON.stringify(report).split(token).join("[redacted]")) : report;
}

export function writeAggregateReport(report, runDir, filename) {
  const reports = path.resolve(runDir, "reports"), output = path.resolve(filename ?? path.join(reports, "scenarios-aggregate.json"));
  if (!output.startsWith(reports + path.sep) || !output.endsWith(".json")) throw new Error("output_must_stay_in_reports");
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {mode: 0o600});
  fs.chmodSync(output, 0o600);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {}, keys = {"--run-dir": "runDir", "--mapping": "mappingPath", "--output": "output"};
    for (let index = 0; index < args.length; index++) {
      if (!keys[args[index]] || !args[index + 1]) throw new Error("invalid_arguments");
      options[keys[args[index]]] = args[++index];
    }
    if (!options.runDir || !options.mappingPath) throw new Error("missing_arguments");
    const report = await aggregate(options), output = writeAggregateReport(report, options.runDir, options.output);
    console.log(JSON.stringify({ok: true, output, selectedRuns: report.selection.selectedRuns,
      mappedScenarios: report.totals.mappedScenarios, toolCalls: report.totals.toolCalls, modelAcceptance: report.modelAcceptance}));
  } catch {
    console.error(JSON.stringify({error: "scenario_aggregation_failed"})); process.exitCode = 1;
  }
}
