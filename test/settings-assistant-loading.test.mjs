import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.resolve("src/renderer/pages/settings/SettingsPage.tsx");
const source = fs.readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let loadingEffect;
function findLoadingEffect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[1]?.getText(ast) === "[shouldReadAssistantSettings]") {
    loadingEffect = node.arguments[0];
  }
  ts.forEachChild(node, findLoadingEffect);
}
findLoadingEffect(ast);
assert.ok(loadingEffect, "SettingsPage must load assistant preferences and agent options");
const compiled = ts.transpileModule(`const runEffect = ${loadingEffect.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const chatAgent = { agentKey: "chat-agent", displayName: "Chat Agent" };
const settings = {
  desktopHelperAgentKey: "helper-agent",
  chatDefaultAgentKey: chatAgent.agentKey,
  desktopCopilotPages: {},
};

function createHarness(requests) {
  let requestCount = 0;
  const state = { assistantAgents: [], chatAgents: [] };
  const context = {
    window: { electronAPI: { assistant: {
      getSettings: () => requests[requestCount++].promise,
      listCopilotAgents: async () => ({ ok: true, items: [] }),
      listAgents: async () => [],
      listNavigationAgents: async () => ({ ok: true, items: [chatAgent] }),
    } } },
    shouldReadAssistantSettings: true,
    assistantSettingsLoadedRef: { current: false },
    readChatAgentOptions: (result) => result.items,
    readAssistantAgentOptions: (result, fallback) => [...result.items, ...fallback],
    DEFAULT_DESKTOP_HELPER_AGENT_KEY: "helper-agent",
    DEFAULT_CHAT_DEFAULT_AGENT_KEY: "chat-agent",
    createDefaultDesktopCopilotPagePreferences: () => ({}),
    ASSISTANT_SETTINGS_SECTION_IDS: ["assistant", "navigation", "websites", "webapps"],
    setAssistantSettings: (value) => { state.settings = value; },
    setDesktopHelperAgentKey: (value) => { state.helperAgentKey = value; },
    setChatDefaultAgentKey: (value) => { state.defaultAgentKey = value; },
    setDesktopCopilotPages: (value) => { state.copilotPages = value; },
    setAssistantAgentOptions: (value) => { state.assistantAgents = value; },
    setChatAgentOptions: (value) => { state.chatAgents = value; },
    setReadErrorSections: (_sections, value) => { state.error = value; },
  };
  const run = new Function("context", `const { ${Object.keys(context).join(", ")} } = context;\n${compiled}\nreturn runEffect();`);
  return {
    state,
    enter: (active = true) => run({ ...context, shouldReadAssistantSettings: active }),
    requestCount: () => requestCount,
  };
}

test("direct assistant settings entry loads agent options after StrictMode effect replay", async () => {
  const first = deferred();
  const replay = deferred();
  const harness = createHarness([first, replay]);
  const cleanup = harness.enter();
  cleanup();
  harness.enter();
  first.resolve({ ...settings, chatDefaultAgentKey: "stale-agent" });
  await flush();
  assert.deepEqual(harness.state.chatAgents, []);
  replay.resolve(settings);
  await flush();
  assert.deepEqual(harness.state.chatAgents, [chatAgent]);
  assert.deepEqual(harness.state.assistantAgents, [chatAgent]);
  assert.equal(harness.state.defaultAgentKey, chatAgent.agentKey);
  assert.equal(harness.state.error, "");
});

test("returning before the abandoned request settles loads agents and preserves the successful cache", async () => {
  const abandoned = deferred();
  const current = deferred();
  const harness = createHarness([abandoned, current]);
  harness.enter()();
  harness.enter(false);
  const cleanup = harness.enter();
  current.resolve(settings);
  await flush();
  assert.deepEqual(harness.state.chatAgents, [chatAgent]);
  abandoned.reject(new Error("late request failure"));
  await flush();
  assert.equal(harness.state.error, "");
  cleanup();
  harness.enter(false);
  harness.enter();
  assert.equal(harness.requestCount(), 2);
  assert.deepEqual(harness.state.chatAgents, [chatAgent]);
});

test("a failed assistant settings request can retry when the user returns", async () => {
  const failed = deferred();
  const retry = deferred();
  const harness = createHarness([failed, retry]);
  const cleanup = harness.enter();
  failed.reject(new Error("agent list unavailable"));
  await flush();
  assert.equal(harness.state.error, "agent list unavailable");
  cleanup();
  harness.enter(false);
  harness.enter();
  retry.resolve(settings);
  await flush();
  assert.deepEqual(harness.state.chatAgents, [chatAgent]);
  assert.equal(harness.state.error, "");
});
