import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

function read(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("Agent Realtime Inspector opens as one independent resizable window", () => {
  const controller = read("src", "main", "app-shell", "agent-realtime-inspector-window.ts");
  const runtime = read("src", "main", "app", "runtime.ts");
  const register = read("src", "main", "ipc", "register.ts");
  const preload = read("src", "preload", "index.ts");

  assert.match(controller, /const existingWindow = this\.getWindow\(\)/);
  assert.match(controller, /existingWindow\.restore\(\)/);
  assert.match(controller, /width: 1480/);
  assert.match(controller, /height: 920/);
  assert.match(controller, /resizable: true/);
  assert.match(controller, /modal: false/);
  assert.doesNotMatch(controller, /^\s*parent:/m);
  assert.match(runtime, /AGENT_REALTIME_INSPECTOR_ROUTE = "\/agent-realtime-inspector"/);
  assert.match(register, /ipcMain\.handle\("diagnostics\.openAgentRealtimeInspector"/);
  assert.match(register, /overviewLease:\s*brokerDiagnostics\.overviewLease/);
  assert.match(read("src", "shared", "contracts", "desktop-api.ts"), /state:\s*"pending_chat_identity" \| "ready"/);
  assert.match(preload, /openAgentRealtimeInspector: \(\) =>[\s\S]{0,100}diagnostics\.openAgentRealtimeInspector/);
});

test("Desktop Runtime Observer combines targets, memory, topology, and realtime events", () => {
  const app = read("src", "renderer", "App.tsx");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const styles = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.css");
  const settings = read("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(app, /location\.pathname === "\/agent-realtime-inspector"/);
  assert.match(page, /className="runtime-target-scroll"/);
  assert.match(page, /type ViewId = "targets" \| "events" \| "topology" \| "system"/);
  assert.match(page, /type DetailTab = "overview" \| "memory" \| "events" \| "raw"/);
  assert.match(page, /MEMORY_HISTORY_WINDOW_MS = 5 \* 60 \* 1_000/);
  assert.match(page, /openAgentRealtimeTargetDevTools/);
  assert.match(page, /processMemoryExplanation/);
  assert.match(page, /className="runtime-detail-section runtime-overview-memory"/);
  assert.match(page, /className="runtime-detail-events is-compact"/);
  assert.match(page, /connection\?\.lastHeartbeatAt/);
  assert.match(page, /run\.lastRestoreResult/);
  assert.match(page, /eventSurfaceId !== "all" && entry\.surfaceId !== eventSurfaceId/);
  assert.match(page, /window\.setInterval\(\(\) => void loadSnapshot\(\), 500\)/);
  assert.match(styles, /grid-template-columns: minmax\(680px, 1fr\) minmax\(330px, 360px\)/);
  assert.match(styles, /--runtime-accent: #5790ff/);
  assert.match(styles, /\.runtime-target-grid/);
  assert.match(settings, /diagnostics\.openAgentRealtimeInspector\(\)/);
  assert.doesNotMatch(settings, /diagnostics\.getAgentRealtimeDebugSnapshot\(\)/);
});

test("runtime diagnostics stay main-owned and sanitize target URLs", () => {
  const register = read("src", "main", "ipc", "register.ts");
  const registry = read("src", "main", "browser-surface-registry.ts");
  const preload = read("src", "preload", "index.ts");
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
  assert.match(contracts, /runtime: \{/);
  assert.match(contracts, /processes: AgentRealtimeDebugProcess\[\]/);
  assert.match(contracts, /targets: AgentRealtimeDebugTarget\[\]/);
});
