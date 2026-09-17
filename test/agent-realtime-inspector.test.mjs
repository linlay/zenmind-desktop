import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

function read(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function readTypeScriptFamily(...segments) {
  const target = path.join(projectRoot, ...segments);
  const directory = path.dirname(target);
  const stem = path.basename(target, ".ts");
  return fs.readdirSync(directory)
    .filter((name) => name === `${stem}.ts` || new RegExp(`^${stem}\\.part-\\d+\\.ts$`, "u").test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
}

test("Agent Realtime Inspector opens as one independent resizable window", () => {
  const controller = read("src", "main", "modules", "shell", "agent-realtime-inspector-window.ts");
  const runtime = read("src", "main", "app", "runtime.ts");
  const shellRuntime = read("src", "main", "modules", "shell", "runtime.ts");
  const register = readTypeScriptFamily("src", "main", "app", "module-registry.ts");
  const inspectorIpc = read("src", "main", "modules", "agent-platform", "realtime", "runtime-recording-ipc.ts");
  const bridge = read("src", "main", "modules", "agent-platform", "ipc.ts");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const preload = read("src", "preload", "index.ts");

  assert.match(controller, /const existingWindow = this\.getWindow\(\)/);
  assert.match(controller, /existingWindow\.restore\(\)/);
  assert.match(controller, /width: 1480/);
  assert.match(controller, /height: 920/);
  assert.match(controller, /resizable: true/);
  assert.match(controller, /modal: false/);
  assert.doesNotMatch(controller, /^\s*parent:/m);
  assert.match(runtime, /AGENT_REALTIME_INSPECTOR_ROUTE = "\/agent-realtime-inspector"/);
  assert.match(inspectorIpc, /diagnostics\.openAgentRealtimeInspector/);
  assert.match(inspectorIpc, /diagnostics\.listAgentRealtimeRecordings/);
  assert.match(register, /registerAgentRealtimeInspectorIpcHandlers\(\{/);
  assert.match(shellRuntime, /getAgentRealtimeInspectorWindow: \(\) => agentRealtimeInspectorWindowController\.getWindow\(\)/);
  assert.match(register, /overviewLease:\s*brokerDiagnostics\.overviewLease/);
  assert.match(register, /lastPlanTaskEventType/);
  assert.match(bridge, /streams: \[\.\.\.session\.streams\.values\(\)\]\.map\(streamBindingDiagnostic\)/);
  assert.match(read("src", "shared", "contracts", "desktop-api.ts"), /state:\s*"pending_chat_identity" \| "ready"/);
  assert.match(page, /<h2>Overview lease<\/h2>/);
  assert.match(page, /run\.lastPlanTaskEventType/);
  assert.match(preload, /openAgentRealtimeInspector: \(\) =>[\s\S]{0,100}diagnostics\.openAgentRealtimeInspector/);
});

test("Desktop Runtime Observer combines targets, memory, topology, and realtime events", () => {
  const app = read("src", "renderer", "App.tsx");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const recordingPanel = read("src", "renderer", "pages", "AgentRealtimeRecordingPanel.tsx");
  const styles = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.css");
  const settings = read("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(app, /location\.pathname === "\/agent-realtime-inspector"/);
  assert.match(page, /className="runtime-target-scroll"/);
  assert.match(page, /type ViewId = "targets" \| "events" \| "topology" \| "system"/);
  assert.match(page, /type DetailTab = "overview" \| "memory" \| "raw"/);
  assert.match(page, /MEMORY_HISTORY_WINDOW_MS = 5 \* 60 \* 1_000/);
  assert.match(page, /openAgentRealtimeTargetDevTools/);
  assert.match(page, /processMemoryExplanation/);
  assert.match(page, /className="runtime-detail-section runtime-overview-memory"/);
  assert.match(page, /<AgentRealtimeRecordingPanel surfaceId=\{recordingSurfaceId\}/);
  assert.match(page, /connection\?\.lastHeartbeatAt/);
  assert.match(page, /run\.lastRestoreResult/);
  assert.match(recordingPanel, /queryAgentRealtimeRecordingEvents/);
  assert.match(recordingPanel, /startAgentRealtimeRecording/);
  assert.match(recordingPanel, /stopAgentRealtimeRecording/);
  assert.match(recordingPanel, /settings\.debug\.realtime\.recording\.clearConfirm/);
  assert.match(recordingPanel, /for \(const recording of deletableRecordings\)/);
  assert.match(recordingPanel, /settings\.debug\.realtime\.recording\.closeSnapshot/);
  assert.match(recordingPanel, /order: liveMode \? "desc" : "asc"/);
  assert.match(recordingPanel, /eventRecordingCount/);
  assert.match(recordingPanel, /setAgentRealtimeLiveEventsEnabled\(\{ enabled: true \}\)/);
  assert.match(recordingPanel, /queryAgentRealtimeLiveEvents/);
  assert.match(recordingPanel, /getAgentRealtimeLiveEvent/);
  assert.doesNotMatch(recordingPanel, /renameAgentRealtimeRecording|EditOutlined/);
  assert.match(recordingPanel, /query: search\.trim\(\)/);
  assert.match(recordingPanel, /findTextMatches\(detailJson, detailSearch\)/);
  assert.match(recordingPanel, /scrollIntoView\(\{ block: "center", inline: "nearest" \}\)/);
  assert.match(recordingPanel, /moveDetailMatch\(event\.shiftKey \? -1 : 1\)/);
  assert.match(recordingPanel, /<mark/);
  assert.doesNotMatch(recordingPanel, /contentSearch|searchMetadata|searchContent/);
  assert.match(recordingPanel, /className=\{`runtime-event-detail-resizer/);
  assert.match(recordingPanel, /aria-valuenow=\{eventDetailHeight\}/);
  assert.match(page, /window\.setInterval\(\(\) => void loadSnapshot\(\), 500\)/);
  assert.match(styles, /grid-template-columns: minmax\(560px, 1fr\) 8px 360px/);
  assert.match(styles, /--runtime-accent: #5790ff/);
  assert.match(styles, /\.runtime-target-grid/);
  assert.match(page, /className=\{`runtime-detail-resizer/);
  assert.match(page, /handleDetailResizerPointerDown/);
  assert.match(page, /aria-valuenow=\{detailPanelWidth\}/);
  assert.match(styles, /\.runtime-detail-resizer/);
  assert.match(styles, /cursor: col-resize/);
  assert.match(styles, /\.runtime-target-events-button \{[\s\S]*color: #a9c7ff/);
  assert.match(styles, /\.runtime-recording-command button\.is-stop:not\(:disabled\)/);
  assert.match(styles, /\.runtime-recording-command button:disabled/);
  assert.match(styles, /\.runtime-event-detail-resizer/);
  assert.match(styles, /cursor: row-resize/);
  assert.match(styles, /\.runtime-recording-pager button:disabled/);
  assert.match(styles, /\.runtime-diagnostic-cards/);
  assert.match(page, /logicalFramePortsDescription/);
  assert.match(page, /runRecoveryDescription/);
  assert.match(settings, /diagnostics\.openAgentRealtimeInspector\(\)/);
  assert.doesNotMatch(settings, /diagnostics\.getAgentRealtimeDebugSnapshot\(\)/);
});

test("runtime diagnostics stay main-owned and sanitize target URLs", () => {
  const register = readTypeScriptFamily("src", "main", "app", "module-registry.ts");
  const registry = read("src", "main", "modules", "web-surfaces", "browser-surface-registry.ts");
  const preload = read("src", "preload", "index.ts");
  const inspectorIpc = read("src", "main", "modules", "agent-platform", "realtime", "runtime-recording-ipc.ts");
  const contracts = read("src", "shared", "contracts", "desktop-api.ts");

  assert.match(register, /createAgentRealtimeRuntimeDiagnostics/);
  assert.match(register, /parsed\.username = ""/);
  assert.match(register, /parsed\.password = ""/);
  assert.match(register, /parsed\.search = ""/);
  assert.match(register, /parsed\.hash = ""/);
  assert.match(register, /app\.getAppMetrics\(\)/);
  assert.match(register, /const orphaned = contents\.type === "webview"/);
  assert.doesNotMatch(register, /contents\.type !== "webview" \|\| claimedWebContentsIds/);
  assert.match(registry, /listDiagnosticSurfaces/);
  assert.match(registry, /listWebContentsDiagnostics/);
  assert.match(preload, /diagnostics\.openAgentRealtimeTargetDevTools/);
  assert.match(inspectorIpc, /runtime_inspector_sender_required/);
  assert.match(inspectorIpc, /event\.sender === inspectorWindow\.webContents/);
  assert.match(inspectorIpc, /senderFrame === inspectorWindow\.webContents\.mainFrame/);
  assert.match(inspectorIpc, /new URL\(senderFrame!\.url\)\.hash === `#\$\{options\.inspectorRoutePath\}`/);
  assert.doesNotMatch(inspectorIpc, /\.pathname === "\/agent-realtime-inspector"/);
  assert.match(contracts, /runtime: \{/);
  assert.match(contracts, /processes: AgentRealtimeDebugProcess\[\]/);
  assert.match(contracts, /targets: AgentRealtimeDebugTarget\[\]/);
  assert.doesNotMatch(contracts, /trace: AgentRealtimeDebugTraceEntry\[\]/);
});

test("snapshot recording replaces the legacy trace buffer and keeps live preview bounded", () => {
  const broker = read("src", "main", "modules", "agent-platform", "realtime", "realtime-broker.ts");
  const controller = read("src", "main", "modules", "agent-platform", "realtime", "runtime-recording-controller.ts");
  const worker = read("src", "main", "modules", "agent-platform", "realtime", "runtime-recording-worker.ts");
  const preload = read("src", "preload", "index.ts");

  assert.doesNotMatch(broker, /RealtimeDebugTraceBuffer/);
  assert.doesNotMatch(controller, /MAX_RENDERED_FRAMES|DEFAULT_MAX_ENTRIES/);
  assert.match(controller, /MAX_QUEUE_ENTRIES = 1_024/);
  assert.match(controller, /MAX_LIVE_EVENT_ENTRIES = 2_000/);
  assert.match(controller, /MAX_LIVE_EVENT_BYTES = 16 \* 1024 \* 1024/);
  assert.match(controller, /MAX_RECORDING_DURATION_MS = 30 \* 60 \* 1_000/);
  assert.match(worker, /MAX_RECORDING_BYTES = 256 \* 1024 \* 1024/);
  assert.match(worker, /MAX_TOTAL_BYTES = 1024 \* 1024 \* 1024/);
  assert.match(preload, /diagnostics\.startAgentRealtimeRecording/);
  assert.match(preload, /diagnostics\.exportAgentRealtimeRecording/);
  assert.doesNotMatch(preload, /clearAgentRealtimeDebugTrace/);
});
