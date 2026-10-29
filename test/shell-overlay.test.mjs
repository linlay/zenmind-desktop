import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = path.join(
  process.cwd(),
  "src",
  "renderer",
  "app-shell",
  "useShellOverlay.ts",
);

function loadShellOverlayModule(react) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  const mod = { exports: {} };
  new Function("exports", "require", "module", outputText)(
    mod.exports,
    (specifier) => (specifier === "react" ? react : require(specifier)),
    mod,
  );
  return mod.exports;
}

function createHookHarness({ navigation = false } = {}) {
  const slots = [];
  const layoutEffects = [];
  let cursor = 0;
  let currentRoute = { pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-1" };
  const react = {
    useReducer(reducer, initialState) {
      const index = cursor++;
      slots[index] ??= { state: initialState };
      const slot = slots[index];
      return [
        slot.state,
        (action) => {
          slot.state = reducer(slot.state, action);
        },
      ];
    },
    useRef(initialValue) {
      const index = cursor++;
      slots[index] ??= { current: initialValue };
      return slots[index];
    },
    useCallback(callback) {
      cursor += 1;
      return callback;
    },
    useEffect() {
      cursor += 1;
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
      slots[index] = { deps };
      layoutEffects.push(effect);
    },
  };
  const module = loadShellOverlayModule(react);
  return {
    module,
    render(route = currentRoute) {
      currentRoute = route;
      cursor = 0;
      const overlay = module.useShellOverlay(navigation ? JSON.stringify([route.pathname, route.agentKey, route.chatId]) : "");
      for (const effect of layoutEffects.splice(0)) effect();
      return overlay;
    },
  };
}

test("shell overlay reducer replaces the active overlay and ignores stale closes", () => {
  const { reduceShellOverlay } = loadShellOverlayModule({});
  const firstShare = {
    kind: "conversationShare",
    chatId: "chat-1",
    chatName: "First",
    sessionId: 1,
  };
  const secondShare = { ...firstShare, chatId: "chat-2", sessionId: 2 };

  let state = reduceShellOverlay(null, { type: "open", overlay: firstShare });
  state = reduceShellOverlay(state, { type: "open", overlay: secondShare });
  state = reduceShellOverlay(state, {
    type: "close",
    overlay: firstShare,
  });
  assert.deepEqual(state, secondShare);

  const globalSearch = { kind: "globalSearch" };
  state = reduceShellOverlay(state, {
    type: "open",
    overlay: globalSearch,
  });
  state = reduceShellOverlay(state, {
    type: "close",
    overlay: secondShare,
  });
  assert.equal(state, globalSearch);
});

test("a stale close cannot close a newer overlay of the same kind", () => {
  const harness = createHookHarness();
  let overlay = harness.render();

  overlay.openGlobalSearch();
  const firstSearch = harness.render().activeOverlay;
  overlay = harness.render();
  overlay.openGlobalSearch();
  const secondSearch = harness.render().activeOverlay;

  overlay = harness.render();
  overlay.closeGlobalSearch(firstSearch);
  assert.equal(harness.render().activeOverlay, secondSearch);

  overlay = harness.render();
  overlay.closeGlobalSearch(secondSearch);
  assert.equal(harness.render().activeOverlay, null);
});

test("tool menu opens synchronously without requesting account refresh", () => {
  const harness = createHookHarness();
  const overlay = harness.render();
  let refreshRequested = false;

  // Guard against restoring the old refresh callback dependency at runtime.
  overlay.requestToolMenuOpen(() => {
    refreshRequested = true;
    return new Promise(() => {});
  });

  assert.deepEqual(harness.render().activeOverlay, { kind: "toolMenu" });
  assert.equal(refreshRequested, false);
});

test("opening search replaces the tool menu without a late reopen", async () => {
  const harness = createHookHarness();
  let overlay = harness.render();

  overlay.requestToolMenuOpen();
  const menu = harness.render().activeOverlay;
  overlay.openGlobalSearch();
  overlay.closeToolMenu(menu);
  await Promise.resolve();

  overlay = harness.render();
  assert.deepEqual(overlay.activeOverlay, { kind: "globalSearch" });
});

test("tool menu can close immediately and ignores a previous menu's close", async () => {
  const harness = createHookHarness();
  let overlay = harness.render();

  overlay.requestToolMenuOpen();
  const firstMenu = harness.render().activeOverlay;
  overlay.requestToolMenuOpen();
  const currentMenu = harness.render().activeOverlay;
  overlay.closeToolMenu(firstMenu);
  assert.equal(harness.render().activeOverlay, currentMenu);

  overlay.closeToolMenu(currentMenu);
  await Promise.resolve();

  overlay = harness.render();
  assert.equal(overlay.activeOverlay, null);
});

test("bootstrap auto-open opens an idle menu and preserves any active overlay", () => {
  const harness = createHookHarness();
  let overlay = harness.render();

  overlay.openToolMenuIfIdle();
  const menu = harness.render().activeOverlay;
  assert.deepEqual(menu, { kind: "toolMenu" });
  overlay.openToolMenuIfIdle();
  assert.equal(harness.render().activeOverlay, menu);

  overlay.closeToolMenu(menu);
  assert.equal(harness.render().activeOverlay, null);

  overlay = harness.render();
  overlay.openGlobalSearch();
  overlay.openToolMenuIfIdle();
  assert.deepEqual(harness.render().activeOverlay, { kind: "globalSearch" });

  overlay.openConversationShare("chat-1", "Chat");
  const share = harness.render().activeOverlay;
  overlay.openToolMenuIfIdle();
  assert.equal(harness.render().activeOverlay, share);
});

test("navigation closes only the share session; stale closes cannot affect its replacement", () => {
  const h = createHookHarness({ navigation: true });
  h.render().openConversationShare("chat-1", "First");
  const first = h.render().activeOverlay;
  h.render({ pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-1", search: "?theme=dark" });
  assert.equal(h.render().activeOverlay, first);
  for (const next of [
    { pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-2" },
    { pathname: "/agent/agent-2", agentKey: "agent-2", chatId: "chat-2" },
    { pathname: "/settings", agentKey: "", chatId: "" }
  ]) {
    h.render(next);
    assert.equal(h.render().activeOverlay, null);
    h.render().openConversationShare("chat-2", "Second");
    h.render().closeConversationShare(first);
    assert.equal(h.render().activeOverlay.kind, "conversationShare");
  }
  for (const open of [o => o.openGlobalSearch(), o => o.openToolMenuIfIdle()]) {
    const otherHarness = createHookHarness({ navigation: true });
    open(otherHarness.render());
    const other = otherHarness.render().activeOverlay;
    otherHarness.render({ pathname: "/other" });
    assert.equal(otherHarness.render().activeOverlay, other);
  }
});
