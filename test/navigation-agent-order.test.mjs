import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createNavigationAgentOrderPlan } = require("../dist-electron/main/modules/assistant/project-agent-order.js");
const { readAssistantNavigationAgentOrderFromPlatform, orderNavigationAgents } = require("../dist-electron/main/modules/assistant/navigation-api.js");
const { registerAssistantIpcHandlers } = require("../dist-electron/main/modules/assistant/ipc.js");

test("primary navigation reorders ordinary and workspace Agents across each other while retaining hidden slots", () => {
  const plan = createNavigationAgentOrderPlan({
    requestedAgentKeys: ["chat", "project-b", "project-a"],
    currentAgentKeys: ["project-a", "project-b", "chat", "new-agent"],
    fullAgentKeys: ["project-a", "copilot-only", "project-b", "chat", "new-agent"],
  });
  assert.deepEqual(plan.agentKeys, ["chat", "project-b", "project-a", "new-agent"]);
  assert.deepEqual(plan.fullAgentKeys, ["chat", "copilot-only", "project-b", "project-a", "new-agent"]);
  for (const agentKeys of [["deleted"], ["copilot-only"], ["chat", "chat"], []]) {
    assert.throws(() => createNavigationAgentOrderPlan({ requestedAgentKeys: agentKeys, currentAgentKeys: ["chat"], fullAgentKeys: ["chat", "copilot-only"] }));
  }
});

test("primary projection follows global order without changing summaries, chats, or source lists", () => {
  const projectA = { agentKey: "project-a", primaryChat: { chatId: "old-primary" }, projectChats: [{ chatId: "recent" }] };
  const projectB = { agentKey: "project-b", primaryChat: null };
  const chat = { agentKey: "chat", recentChats: [{ chatId: "normal" }] };
  const items = [projectA, projectB, chat];
  const ordered = orderNavigationAgents(items, ["chat", "project-b", "hidden", "project-a"]);
  assert.deepEqual(ordered, [chat, projectB, projectA]);
  assert.equal(ordered[2], projectA);
  assert.equal(ordered[2].projectChats, projectA.projectChats);
  assert.deepEqual(items.map(x => x.agentKey), ["project-a", "project-b", "chat"]);
  assert.deepEqual(orderNavigationAgents(items, ["chat"]), [chat, projectA, projectB]);
  assert.equal(orderNavigationAgents(items, null), items);
});

test("public Agent order reads are authenticated; legacy endpoint absence disables ordering; failures are retained", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/agents/order");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { order: ["b", "a"] } }) };
  };
  assert.deepEqual(await readAssistantNavigationAgentOrderFromPlatform("http://127.0.0.1", "fixture-token"), ["b", "a"]);
  for (const status of [404, 405]) {
    globalThis.fetch = async () => ({ ok: false, status });
    assert.equal(await readAssistantNavigationAgentOrderFromPlatform("http://127.0.0.1", "token"), null);
  }
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(readAssistantNavigationAgentOrderFromPlatform("http://127.0.0.1", "token"), /503/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ order: ["duplicate", "duplicate"] }) });
  await assert.rejects(readAssistantNavigationAgentOrderFromPlatform("http://127.0.0.1", "token"), /invalid Agent catalog order/);
});

function register(callAgentPlatform) {
  const handlers = new Map();
  let refreshes = 0;
  registerAssistantIpcHandlers({ handle: (key, handler) => handlers.set(key, handler) }, {
    app: { once() {} }, assistantBridge: {}, conversationShare: {},
    assistantNavigationStatusClient: { scheduleRefresh: () => { refreshes++; } },
    desktopActionRendererRequests: new Map(), DESKTOP_ACTION_DEFINITIONS: [],
    callAgentPlatform: (_app, endpoint, options) => callAgentPlatform(endpoint, options),
  });
  return { invoke: keys => handlers.get("assistant.reorderNavigationAgents")(null, { agentKeys: keys }), refreshes: () => refreshes };
}

test("primary reorder IPC validates the current projection, saves only via public order API, and refreshes", async () => {
  const calls = [];
  const fixture = register(async (endpoint, options) => {
    calls.push(endpoint);
    if (endpoint === "/api/agents?hasWorkspace=true") return [{ key: "project", workspaceDir: "C:\\project" }];
    if (endpoint === "/api/agents?scope=nav&hasWorkspace=false") return [{ key: "chat" }, { key: "new" }];
    assert.equal(endpoint, "/api/agents/order");
    if (!options) return { order: ["project", "hidden", "chat", "new"] };
    assert.deepEqual(options, { method: "PUT", body: { order: ["chat", "hidden", "project", "new"] } });
    return { order: options.body.order, updatedAt: 1793000000000 };
  });
  const result = await fixture.invoke(["chat", "project"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.agentKeys, ["chat", "project", "new"]);
  assert.equal(result.updatedAt, 1793000000000);
  assert.equal(fixture.refreshes(), 1);
  assert.equal(calls.some(x => x.includes("/admin/")), false);
});

test("invalid or stale primary reorder never writes; Platform errors return a recoverable result", async () => {
  let writes = 0;
  const fixture = register(async (endpoint, options) => {
    if (options) writes++;
    if (endpoint === "/api/agents?hasWorkspace=true") return [];
    if (endpoint === "/api/agents?scope=nav&hasWorkspace=false") return [{ key: "chat" }];
    return { order: ["hidden", "chat"] };
  });
  for (const keys of [["chat", "chat"], [], ["hidden"], ["deleted"]]) assert.equal((await fixture.invoke(keys)).ok, false);
  assert.equal(writes, 0);
  assert.equal(fixture.refreshes(), 0);
  const failed = register(async () => { throw new Error("Platform unavailable"); });
  assert.match((await failed.invoke(["chat"])).message, /Platform unavailable/);
});

test("navigation refresh merges project/chat catalogs by shared order and preserves the complete-mode activity projection", async t => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { AssistantNavigationStatusClient } = require("../dist-electron/main/modules/assistant/navigation-status-client.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primary-order-snapshot-"));
  const before = globalThis.fetch;
  let order = ["chat", "project-b", "hidden", "project-a"];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const data = url.pathname === "/api/agents/order" ? { order }
      : url.pathname === "/api/chats" ? []
      : url.searchParams.get("hasWorkspace") === "true"
        ? [{ key: "project-a", workspaceDir: dir }, { key: "project-b", workspaceDir: dir }]
        : [{ key: "chat" }];
    return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
  };
  const client = new AssistantNavigationStatusClient({
    app: { getPath: () => dir },
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1" } }),
    issueAccessToken: async () => ({ ok: true, token: "fixture-token" }), onSnapshot() {},
    realtimeBroker: {
      async ensureConnected() {}, subscribePush() { return () => {}; }, cleanupConsumer() {},
      getConnectionPhase: () => "connected", getConnectionState: () => ({ phase: "connected" }),
      async forwardRequest(request) {
        request.onFrame({ frame: "response", type: request.type, code: 0,
          data: request.type === "/api/chats/order" ? { sortMode: "manual", pinnedChats: [] } : [] });
      },
    },
  });
  t.after(() => { client.stop(); globalThis.fetch = before; fs.rmSync(dir, { force: true, recursive: true }); });
  const first = await client.refreshNow();
  assert.equal(first.ok, true, first.message);
  assert.equal(first.agentOrderingSupported, true);
  assert.deepEqual(first.items.map(agent => agent.agentKey), ["chat", "project-b", "project-a"]);
  assert.deepEqual(first.activityItems.map(agent => agent.agentKey), ["project-a", "project-b", "chat"]);
  assert.equal(first.chatSortMode, "manual");
  order = ["project-b", "hidden", "project-a", "chat"];
  const next = await client.refreshNow();
  assert.deepEqual(next.items.map(agent => agent.agentKey), ["project-b", "project-a", "chat"]);
  assert.equal(next.chatSortMode, "manual");
  assert.deepEqual(next.chatItems, first.chatItems);
  assert.deepEqual(next.pinnedChatItems, first.pinnedChatItems);
});
