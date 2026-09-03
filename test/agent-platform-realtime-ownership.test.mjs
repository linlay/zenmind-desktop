import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("only the physical realtime client constructs the Agent Platform /ws URL", () => {
  const mainRoot = path.join(root, "src/main");
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.tsx?$/u.test(entry.name)) {
        const source = fs.readFileSync(target, "utf8");
        if (/new URL\(["']\/ws["']/u.test(source)) matches.push(path.relative(root, target));
      }
    }
  };
  visit(mainRoot);
  assert.deepEqual(matches.sort(), [
    "src/main/kanban-desktop-ws-client.ts",
    "src/main/realtime/agent-platform-realtime-client.ts",
  ]);
});

test("Assistant, navigation, and Desktop WS api are Broker consumers", () => {
  const sources = [
    "src/main/assistant/core/agent-platform-bridge.ts",
    "src/main/assistant/core/assistant-navigation-status-client.ts",
    "src/main/desktop-ws-server.ts",
  ].map(read);
  for (const source of sources) {
    assert.match(source, /RealtimeBroker/u);
    assert.doesNotMatch(source, /new URL\(["']\/ws["']/u);
  }
  const petRuntime = read("src/main/assistant/pet/runtime.ts");
  const assistantRuntime = read("src/main/bridge/assistant-runtime.ts");
  assert.doesNotMatch(petRuntime, /AgentPlatformPetStatusClient|pet-status-client|realtimeBroker/u);
  assert.doesNotMatch(assistantRuntime, /handleDesktopPetAssistantEvent/u);
  assert.equal(fs.existsSync(path.join(root, "src/main/assistant/pet/pet-stream-client.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/main/assistant/core/assistant-ws-transport.ts")), false);
});

test("known non-Agent-Platform sockets remain explicit static-gate exemptions", () => {
  assert.match(read("src/main/kanban-desktop-ws-client.ts"), /new URL\("\/ws", config\.serverUrl\)/u);
  assert.match(read("src/main/enterprise-chat-runtime.ts"), /createWebSocket/u);
  assert.match(read("src/main/embedded-cdp-gateway.ts"), /Sec-WebSocket-Accept/u);
  assert.match(read("src/renderer/pages/settings/SettingsPage.tsx"), /new WebSocket\(wsUrl\.toString\(\)\)/u);
});

test("shutdown stops delivery, tears down adapters and WorkPanel, then disposes the physical client", () => {
  const events = read("src/main/app/app-events.ts");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const beforeQuit = events.slice(events.indexOf('options.app.on("before-quit"'), events.indexOf('options.app.on("will-quit"'));
  assert.ok(beforeQuit.indexOf("beginRealtimeShutdown") < beforeQuit.indexOf("prepareQuitUi"));
  const willQuit = events.slice(events.indexOf('options.app.on("will-quit"'), events.indexOf('options.app.on("window-all-closed"'));
  assert.ok(willQuit.indexOf("stopAssistantBridgeRuntime") < willQuit.indexOf("disposeRealtimeBroker"));
  assert.doesNotMatch(willQuit, /stopAgentPlatformPetStatusClient/u);
  assert.match(appShell, /progress\.phase === "preparing"[\s\S]{0,180}workPanelStateRef\.current = EMPTY_WORK_PANEL_STATE[\s\S]{0,100}setWorkPanelState\(EMPTY_WORK_PANEL_STATE\)/u);
});
