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
  assert.match(preload, /openAgentRealtimeInspector: \(\) =>[\s\S]{0,100}diagnostics\.openAgentRealtimeInspector/);
});

test("Agent Realtime Inspector uses a compact frame list and separate payload context", () => {
  const app = read("src", "renderer", "App.tsx");
  const page = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.tsx");
  const styles = read("src", "renderer", "pages", "AgentRealtimeInspectorPage.css");
  const settings = read("src", "renderer", "pages", "settings", "SettingsPage.tsx");

  assert.match(app, /location\.pathname === "\/agent-realtime-inspector"/);
  assert.match(page, /className="agent-realtime-inspector-frame-list"/);
  assert.match(page, /detailTab === "payload"/);
  assert.match(page, /settings\.debug\.realtime\.physicalConnection/);
  assert.match(page, /settings\.debug\.realtime\.logicalFramePorts/);
  assert.match(page, /settings\.debug\.realtime\.runRecovery/);
  assert.match(page, /connection\?\.lastHeartbeatAt/);
  assert.match(page, /run\.lastRestoreResult/);
  assert.match(page, /snapshot\?\.trace\.forEach/);
  assert.match(page, /surfaceId !== "all" && entry\.surfaceId !== surfaceId/);
  assert.match(page, /window\.setInterval\(\(\) => void loadSnapshot\(\), 500\)/);
  assert.match(page, /settings\.debug\.realtime\.frozen/);
  assert.match(styles, /grid-template-columns: minmax\(560px, 62%\) minmax\(320px, 38%\)/);
  assert.match(styles, /height: 28px/);
  assert.match(settings, /diagnostics\.openAgentRealtimeInspector\(\)/);
  assert.doesNotMatch(settings, /diagnostics\.getAgentRealtimeDebugSnapshot\(\)/);
});
