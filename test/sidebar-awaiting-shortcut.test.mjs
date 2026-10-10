import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildSync } from "esbuild";
import ts from "typescript";

const compiled = buildSync({
  entryPoints: ["src/renderer/services/mainChatAwaitingShortcut.ts"],
  bundle: true, write: false, platform: "node", format: "cjs",
}).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, URL, URLSearchParams });
const { forwardMainChatAwaitingDigit } = module.exports;

function fixture() {
  const calls = [];
  return {
    calls,
    input: {
      chatId: "chat-a", agentKey: "agent", digit: "2",
      currentRoute: "/agent/agent?chatId=chat-a",
      registeredRoute: "/agent/agent?chatId=chat-a",
      committed: { webContentsId: 17, identity: { kind: "canonical", agentKey: "agent", chatId: "chat-a" } },
      webview: { getWebContentsId: () => 17, send: async (...args) => { calls.push(args); } },
    },
  };
}

test("forwards a digit only to the committed Chat without focusing the guest", () => {
  const { input, calls } = fixture();
  assert.equal(forwardMainChatAwaitingDigit(input), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["desktop:service-webview:deliver", {
    type: "desktop:agent-webclient:awaiting-digit", chatId: "chat-a", agentKey: "agent", digit: "2",
  }]]);
});

for (const patch of [
  { chatId: "chat-b" }, { agentKey: "other" }, { digit: "0" }, { digit: "Enter" },
  { currentRoute: "/agent/agent?chatId=chat-b" },
  { currentRoute: "/agent/agent?newChat=1" },
  { registeredRoute: "/agent/agent?chatId=chat-b" },
  { committed: null }, { webview: null },
  { committed: { webContentsId: 18, identity: { kind: "canonical", agentKey: "agent", chatId: "chat-a" } } },
  { committed: { webContentsId: 17, identity: { kind: "canonical", agentKey: "agent", chatId: "chat-b" } } },
]) {
  test(`rejects stale or unavailable Chat: ${JSON.stringify(patch)}`, () => {
    const { input, calls } = fixture();
    assert.equal(forwardMainChatAwaitingDigit({ ...input, ...patch }), false);
    assert.equal(calls.length, 0);
  });
}

test("a disposed guest drops the key without scheduling a retry", () => {
  const { input, calls } = fixture();
  input.webview.send = () => { throw new Error("destroyed"); };
  assert.equal(forwardMainChatAwaitingDigit(input), false);
  assert.equal(calls.length, 0);
});

test("asynchronous guest disposal is handled without retrying the key", async () => {
  const { input } = fixture();
  let attempts = 0;
  input.webview.send = async () => { attempts += 1; throw new Error("destroyed"); };
  assert.equal(forwardMainChatAwaitingDigit(input), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
});

const sidebar = fs.readFileSync("src/renderer/app-shell/navigation/AppSidebar.tsx", "utf8");
const start = sidebar.indexOf("  function handleSidebarNavKeyDown(");
const end = sidebar.indexOf("  async function beginCreateProject", start);
const handler = ts.transpileModule(sidebar.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function press(key, overrides = {}, state = {}) {
  const calls = [];
  const row = { dataset: { sidebarNavKind: "chats-chat", sidebarChatId: "chat-a", sidebarAgentKey: "agent" } };
  const event = {
    key, target: row, nativeEvent: {},
    preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); },
    ...overrides,
  };
  const context = {
    isPrimaryMode: true, activeChatDragId: "", activeProjectDragKey: "",
    document: { activeElement: row }, getSidebarRovingEventElement: () => row,
    onAwaitingDigit: (...args) => { calls.push(args); return true; },
    moveSidebarChatSelection: (_, direction) => calls.push(direction),
    ...state,
  };
  vm.createContext(context); vm.runInContext(handler, context);
  context.handleSidebarNavKeyDown(event);
  return calls;
}

test("sidebar digit and arrows keep their separate behavior", () => {
  assert.deepEqual(press("2"), [["chat-a", "agent", "2"], "prevent", "stop"]);
  assert.deepEqual(press("ArrowDown"), ["prevent", "next"]);
  assert.deepEqual(press("ArrowUp"), ["prevent", "previous"]);
});

for (const blocked of [
  { repeat: true }, { defaultPrevented: true }, { nativeEvent: { isComposing: true } },
  { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { target: {} },
]) {
  test(`sidebar does not forward editing/modifier/repeat input: ${JSON.stringify(blocked)}`, () => {
    assert.deepEqual(press("1", blocked), []);
  });
}
test("dragging or loss of sidebar focus prevents forwarding", () => {
  assert.deepEqual(press("1", {}, { activeChatDragId: "drag" }), []);
  assert.deepEqual(press("1", {}, { activeProjectDragKey: "drag" }), []);
  assert.deepEqual(press("1", {}, { document: { activeElement: null } }), []);
});
