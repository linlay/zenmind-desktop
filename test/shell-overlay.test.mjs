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

function loadShareNavigation(react) {
  const file = path.join(process.cwd(), "src/renderer/app-shell/AppShell.tsx");
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const appShell = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "AppShell");
  const statements = appShell.body.statements.filter((node) =>
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === "previousShareRouteRef")) ||
    (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "useLayoutEffect" && node.getText(source).includes("previousShareRouteRef")),
  );
  assert.equal(statements.length, 2, "Exercise AppShell's actual navigation lifecycle");
  const { outputText } = ts.transpileModule(statements.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const render = new Function("useRef", "useLayoutEffect", "location", "activeChatRouteInfo", "conversationShareOverlay", "shellOverlay", outputText);
  return (route, shellOverlay) => render(
    react.useRef, react.useLayoutEffect, route, route,
    shellOverlay.activeOverlay?.kind === "conversationShare" ? shellOverlay.activeOverlay : null,
    shellOverlay,
  );
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
  const renderNavigation = navigation ? loadShareNavigation(react) : null;
  return {
    module,
    render(route = currentRoute) {
      currentRoute = route;
      cursor = 0;
      const overlay = module.useShellOverlay();
      renderNavigation?.(route, overlay);
      for (const effect of layoutEffects.splice(0)) effect();
      return overlay;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

test("opening search invalidates a pending tool menu request", async () => {
  const harness = createHookHarness();
  const refresh = deferred();
  let overlay = harness.render();

  const pendingOpen = overlay.requestToolMenuOpen(() => refresh.promise);
  overlay.openGlobalSearch();
  refresh.resolve();
  await pendingOpen;

  overlay = harness.render();
  assert.deepEqual(overlay.activeOverlay, { kind: "globalSearch" });
});

test("closing a pending tool menu request prevents a late open", async () => {
  const harness = createHookHarness();
  const refresh = deferred();
  let overlay = harness.render();

  const pendingOpen = overlay.requestToolMenuOpen(() => refresh.promise);
  overlay.closeToolMenu(null);
  refresh.resolve();
  await pendingOpen;

  overlay = harness.render();
  assert.equal(overlay.activeOverlay, null);
});

test("the latest tool menu request opens after either refresh outcome", async () => {
  const harness = createHookHarness();
  let overlay = harness.render();
  const staleRefresh = deferred();
  const currentRefresh = deferred();

  const staleOpen = overlay.requestToolMenuOpen(() => staleRefresh.promise);
  const currentOpen = overlay.requestToolMenuOpen(() => currentRefresh.promise);
  staleRefresh.resolve();
  currentRefresh.reject(new Error("offline"));
  await Promise.all([staleOpen, currentOpen]);

  overlay = harness.render();
  assert.deepEqual(overlay.activeOverlay, { kind: "toolMenu" });
});

test("bootstrap auto-open does not replace an active or pending overlay", async () => {
  const harness = createHookHarness();
  const refresh = deferred();
  let overlay = harness.render();

  const pendingOpen = overlay.requestToolMenuOpen(() => refresh.promise);
  overlay.openToolMenuIfIdle();
  assert.equal(harness.render().activeOverlay, null);

  overlay = harness.render();
  overlay.openGlobalSearch();
  overlay.openToolMenuIfIdle();
  assert.deepEqual(harness.render().activeOverlay, { kind: "globalSearch" });

  refresh.resolve();
  await pendingOpen;
  assert.deepEqual(harness.render().activeOverlay, { kind: "globalSearch" });
});

test("main-page navigation ends the share session and returning does not restore it", () => {
  for (const next of [
    { pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-2" },
    { pathname: "/agent/agent-2", agentKey: "agent-2", chatId: "chat-1" },
    { pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "" },
    { pathname: "/settings/tunnelHub", agentKey: "", chatId: "" },
  ]) {
    const harness = createHookHarness({ navigation: true });
    const initial = { pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-1" };
    harness.render(initial).openConversationShare("chat-1", "First");
    assert.equal(harness.render().activeOverlay.kind, "conversationShare");
    harness.render(next);
    assert.equal(harness.render().activeOverlay, null);
    harness.render(initial);
    assert.equal(harness.render().activeOverlay, null);
  }
});

test("sharing another chat and presentation-only navigation keep the share session", () => {
  const harness = createHookHarness({ navigation: true });
  harness.render().openConversationShare("chat-2", "Other chat");
  const share = harness.render().activeOverlay;
  harness.render({
    pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-1",
    search: "?theme=dark&chatId=chat-1&locale=en-US", key: "new-location-key",
  });
  assert.equal(harness.render().activeOverlay, share);
});

test("share navigation cleanup leaves other shell overlays alone", () => {
  for (const open of [(overlay) => overlay.openGlobalSearch(), (overlay) => overlay.openToolMenuIfIdle()]) {
    const harness = createHookHarness({ navigation: true });
    open(harness.render());
    const overlay = harness.render().activeOverlay;
    harness.render({ pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-2" });
    assert.equal(harness.render().activeOverlay, overlay);
  }
});

test("a callback from the share closed by navigation cannot close a new share", () => {
  const harness = createHookHarness({ navigation: true });
  harness.render().openConversationShare("chat-1", "First");
  const first = harness.render().activeOverlay;
  harness.render({ pathname: "/agent/agent-1", agentKey: "agent-1", chatId: "chat-2" });
  harness.render().openConversationShare("chat-2", "Second");
  const second = harness.render().activeOverlay;
  assert.ok(second.sessionId > first.sessionId);
  harness.render().closeConversationShare(first);
  assert.equal(harness.render().activeOverlay, second);
});
