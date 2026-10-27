import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const { buildAssistantNavigationAgentsFromPlatformAgents, applyAssistantNavigationPush } = require("../dist-electron/main/modules/assistant/navigation-status-client.js");
const { AGENT_PLATFORM_KNOWN_PUSH_TYPES } = require("../dist-electron/main/modules/agent-platform/realtime/realtime-broker.shared.js");
const bundle = await build({ stdin: { contents: `export * from './src/renderer/assistantNavigation'; export * from './src/renderer/app-shell/navigation/primaryChatView'; export * from './src/renderer/components/icons/agentAppearance'; export * from './src/renderer/components/icons/AgentDefaultPose'; export * from './src/shared/agent-webclient-routes';`, resolveDir: process.cwd() }, bundle: true, outfile: "agent-icons-test.cjs", write: false, platform: "node", format: "cjs", jsx: "automatic", packages: "external", define: { __DESKTOP_APP_BRAND__: JSON.stringify(APP_BRAND) } });
const mod = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(mod, mod.exports, require);
const api = mod.exports;
const EPOCH = 1793000000000;
const chat = (id, patch = {}) => ({ chatId: id, chatName: id, agentKey: "a", createdAt: EPOCH, updatedAt: EPOCH, lastRunId: "", lastRunContent: "primary response", isRead: true, readRunId: "", hasActiveRun: false, hasPendingAwaiting: false, ...patch });
function fixture() {
  return buildAssistantNavigationAgentsFromPlatformAgents([{ key: "a", name: "A", mode: "CODER", primaryChat: chat("older-primary", { pinned: true }), chats: [chat("latest")], stats: { totalCount: 20 } }], 1)[0];
}

test("primary snapshot survives Main/renderer projection independently of the sidebar preview", () => {
  const agent = fixture();
  const normalized = api.normalizeAssistantNavAgent(agent);
  assert.equal(normalized.primaryChat.chatId, "older-primary");
  assert.deepEqual(normalized.recentChats.map(chat => chat.chatId), ["latest"]);
  assert.equal(normalized.latestChatId, "latest");
  assert.equal(api.primaryChatNavigationTarget(normalized), "/agent/a?chatId=older-primary");
  const noPreviews = buildAssistantNavigationAgentsFromPlatformAgents([{ key: "a", primaryChat: chat("older-primary") }], 0)[0];
  assert.equal(noPreviews.primaryChat.chatId, "older-primary");
  assert.equal(noPreviews.recentChats.length, 0);
});
test("a missing primary never falls back to latest or pinned; its creation intent stays one-shot", () => {
  const agent = { ...fixture(), primaryChat: undefined };
  const target = api.primaryChatNavigationTarget(agent, EPOCH);
  assert.equal(target, `/agent/a?newChat=${EPOCH}&primaryNewChat=true`);
  assert.equal(api.resolveAgentWebclientDesktopChatRouteFromUrl("http://localhost/agent/a?chatId=accepted&primaryNewChat=true", "http://localhost/agent/a"), "/agent/a?chatId=accepted");
});
test("primary pointer notifications are included in Broker subscriptions", () => {
  assert.equal(AGENT_PLATFORM_KNOWN_PUSH_TYPES.has("chat.primary.changed"), true);
});
test("live primary reply, run, awaiting and read patches do not reorder or insert ordinary preview rows", () => {
  let agents = [fixture()];
  const before = agents[0].recentChats;
  const update = (type, payload) => { agents = applyAssistantNavigationPush(agents, { frame: "push", type, data: { agentKey: "a", chatId: "older-primary", ...payload } }).items; };
  update("chat.updated", { updatedAt: EPOCH + 100, lastRunId: "r", lastRunContent: "new reply" });
  assert.equal(agents[0].primaryChat.lastRunContent, "new reply");
  update("run.started", { startedAt: EPOCH + 200, runId: "r" });
  assert.equal(agents[0].primaryChat.hasActiveRun, true);
  update("awaiting.asking", { createdAt: EPOCH + 300, runId: "r", mode: "approval" });
  assert.equal(agents[0].primaryChat.hasPendingAwaiting, true);
  update("chat.unread", { createdAt: EPOCH + 400, lastRunId: "r", readRunId: "", agentUnreadCount: 1 });
  assert.equal(agents[0].primaryChat.isRead, false);
  update("chat.read", { readAt: EPOCH + 500, readRunId: "r", lastRunId: "r", isRead: true, agentUnreadCount: 0 });
  assert.equal(agents[0].primaryChat.isRead, true);
  assert.deepEqual(agents[0].recentChats.map(chat => chat.chatId), before.map(chat => chat.chatId));
});
for (const type of ["chat.archived", "chat.deleted"]) {
  test(`${type} clears the exact primary pointer and leaves unrelated Chat windows intact`, () => {
    const agents = [fixture()];
    const next = applyAssistantNavigationPush(agents, { frame: "push", type, data: { agentKey: "a", chatId: "older-primary" } });
    assert.equal(next.items[0].primaryChat, undefined);
    assert.deepEqual(next.items[0].recentChats, agents[0].recentChats);
  });
}
test("complete navigation remains the default, and the view preference does not touch old settings", () => {
  const previous = globalThis.window;
  const stored = new Map([["old-groups", "keep"]]);
  globalThis.window = { localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } };
  try {
    assert.equal(api.readPrimaryChatNavigation(), false);
    api.savePrimaryChatNavigation(true);
    assert.equal(api.readPrimaryChatNavigation(), true);
    api.savePrimaryChatNavigation(false);
    assert.equal(api.readPrimaryChatNavigation(), false);
    assert.equal(stored.get("old-groups"), "keep");
    window.localStorage.getItem = () => { throw Error("unavailable"); };
    assert.equal(api.readPrimaryChatNavigation(), false);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
test("Agent names, colors and legacy fallbacks follow WebClient mode rules", () => {
  assert.deepEqual(api.AGENT_ICON_NAMES, ["general", "coder", "kbase", "team", "executor", "proxy"]);
  for (const mode of api.AGENT_ICON_NAMES) assert.equal(api.resolveAgentIcon(undefined, mode).name, mode);
  assert.deepEqual(api.resolveAgentIcon({ name: "terminal", color: "#4370B4" }, "CODER"), { name: "coder", color: "#4370B4" });
  assert.equal(api.resolveAgentIcon("library", "KBASE").name, "kbase");
  assert.equal(api.resolveAgentIcon(undefined, "unknown").name, "general");
});
test("inline TEAM glyph masks remain unique across repeated Agent rows", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...[1, 2].map(key => React.createElement("svg", { key }, React.createElement(api.AgentDefaultPose, { variant: "team" })))));
  const ids = [...html.matchAll(/<mask id="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.ok(html.includes(`url(#${id})`));
});
