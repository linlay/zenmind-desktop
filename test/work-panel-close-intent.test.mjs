import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } from "../dist-electron/shared/work-panel.js";
import { getWorkPanelReviewSession, hasWorkPanelReviewDraft } from "../dist-electron/shared/work-panel-review.js";
import { isDesktopCloseShortcut } from "../dist-electron/main/infrastructure/electron/platform-adapter.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync(new URL("../src/renderer/work-panel/WorkPanelHost.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("WorkPanelHost.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const closures = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["closeWorkPanelStep", "closeItemWithReviewProtection", "closeOtherItemsWithReviewProtection", "confirmDiscardReview", "readItemCloseState", "closeStateUnchanged"].includes(node.name.getText(ast))) {
    closures.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(closures.size, 6, "execute the real WorkPanel close and protection handlers");
const { outputText } = ts.transpileModule(
  [...closures].map(([name, initializer]) => `const ${name} = ${initializer};`).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);

function overview(state = EMPTY_WORK_PANEL_STATE, ownerChatId = "chat-a", explicitlyOpened = false) {
  return reduceWorkPanelCommand(state, {
    type: "openItem", ownerChatId, explicitlyOpened,
    descriptor: { kind: "webclient", module: "overview", route: `/overview/${ownerChatId}`,
      context: { chatId: ownerChatId, agentKey: "agent-a" } },
  });
}

function attachment(state, ownerChatId = "chat-a", handleId = "attachment") {
  return reduceWorkPanelCommand(state, {
    type: "openItem", ownerChatId,
    descriptor: { kind: "local-file", handleId, fileName: "attachment.png", previewKind: "image",
      reviewKind: "image", workspaceRelativePath: "attachment.png", reviewRevision: "100:200" },
  });
}

function host(state, { dirty = false, busy = false, confirm = true } = {}) {
  const stateRef = { current: state };
  const commands = [];
  const nodes = new Map();
  const rootRef = { current: { querySelector: (selector) => {
    const itemId = /data-work-panel-item="([^"]+)"/u.exec(selector)?.[1];
    if (!itemId) return null;
    if (!nodes.has(itemId)) nodes.set(itemId, {
      textContent: "original draft",
      matches: (query) => (busy && query.includes("busy")) || (dirty && query.includes("dirty")),
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    return nodes.get(itemId);
  } } };
  const context = vm.createContext({
    stateRef, rootRef,
    CSS: { escape: (value) => value },
    confirm: async () => typeof confirm === "function" ? confirm() : confirm,
    t: (key) => key,
    getWorkPanelReviewSession,
    hasWorkPanelReviewDraft,
    dispatchCommand: (command) => {
      commands.push(command);
      const result = reduceWorkPanelCommand(stateRef.current, command);
      stateRef.current = result.nextState;
      return result;
    },
  });
  vm.runInContext(`${outputText}\nglobalThis.closeStep = closeWorkPanelStep; globalThis.closeTab = closeItemWithReviewProtection; globalThis.closeOthers = closeOtherItemsWithReviewProtection;`, context);
  return { state: () => stateRef.current, commands, stateRef, rootRef, nodes,
    close: () => context.closeStep("chat-a"),
    closeTab: (itemId) => context.closeTab("chat-a", itemId),
    closeOthers: (itemId) => context.closeOthers("chat-a", itemId) };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: attachment-only opening closes the preview and panel with one shortcut`, async () => {
    assert.equal(isDesktopCloseShortcut(platform, {
      type: "keyDown", key: "w", meta: platform === "darwin", control: platform === "win32",
    }), true);
    const opened = attachment(overview().nextState);
    const panel = host(opened.nextState);
    assert.equal(await panel.close(), true);
    assert.equal(panel.commands.length, 1, "remove the preview and Overview in one committed command");
    assert.deepEqual(panel.state().workspaces, []);
    assert.deepEqual(panel.state().visibleOwnerChatIds, []);
  });

  test(`${platform}: explicitly opened panel retains Overview until the next shortcut`, async () => {
    const initial = overview(EMPTY_WORK_PANEL_STATE, "chat-a", true);
    const panel = host(attachment(initial.nextState).nextState);
    assert.equal(await panel.close(), true);
    assert.deepEqual(panel.state().workspaces[0].items.map((item) => item.itemId), [initial.item.itemId]);
    assert.deepEqual(panel.state().explicitlyOpenedOwnerChatIds, ["chat-a"]);
    assert.equal(await panel.close(), true);
    assert.deepEqual(panel.state().workspaces, []);
    assert.deepEqual(panel.state().explicitlyOpenedOwnerChatIds, []);
    assert.deepEqual(attachment(overview(panel.state()).nextState).nextState.explicitlyOpenedOwnerChatIds, []);
  });
}

test("explicitly restoring an attachment panel retains its intent across tabs, hiding, and other Chats", async () => {
  const initial = attachment(overview().nextState);
  const hidden = reduceWorkPanelCommand(initial.nextState, { type: "hideWorkspace", ownerChatId: "chat-a" });
  const shown = reduceWorkPanelCommand(hidden.nextState, { type: "showWorkspace", ownerChatId: "chat-a", explicitlyOpened: true });
  const otherChat = attachment(overview(shown.nextState, "chat-b").nextState, "chat-b");
  const active = reduceWorkPanelCommand(otherChat.nextState, { type: "activateItem", ownerChatId: "chat-a", itemId: initial.item.itemId });
  assert.deepEqual(active.nextState.explicitlyOpenedOwnerChatIds, ["chat-a"]);
  const panel = host(active.nextState);
  await panel.close();
  assert.equal(panel.state().workspaces.find((workspace) => workspace.ownerChatId === "chat-a").items.length, 1);
  assert.equal(panel.state().workspaces.find((workspace) => workspace.ownerChatId === "chat-b").items.length, 2);
  await panel.close();
  const closed = reduceWorkPanelCommand(panel.state(), {
    type: "closeItem", ownerChatId: "chat-b", itemId: otherChat.item.itemId, closeImplicitWorkspace: true,
  });
  assert.deepEqual(closed.nextState.workspaces, []);
});

test("showing an already visible panel can promote it to an explicit opening", async () => {
  const initial = attachment(overview().nextState);
  const shown = reduceWorkPanelCommand(initial.nextState, { type: "showWorkspace", ownerChatId: "chat-a", explicitlyOpened: true });
  assert.deepEqual(shown.nextState.explicitlyOpenedOwnerChatIds, ["chat-a"]);
  const restored = reduceWorkPanelCommand(shown.nextState, { type: "showWorkspace", ownerChatId: "chat-a" });
  assert.deepEqual(restored.nextState.explicitlyOpenedOwnerChatIds, ["chat-a"]);
});

test("implicit panels keep other content and ordinary tab closure still retains Overview", async () => {
  const first = attachment(overview().nextState);
  const second = attachment(first.nextState, "chat-a", "second");
  const panel = host(second.nextState);
  await panel.close();
  assert.equal(panel.state().workspaces[0].activeItemId, first.item.itemId);
  assert.equal(panel.state().workspaces[0].items.length, 2);
  await panel.close();
  assert.deepEqual(panel.state().workspaces, []);
  const ordinaryClose = host(first.nextState);
  await ordinaryClose.closeTab(first.item.itemId);
  assert.equal(ordinaryClose.state().workspaces[0].items.length, 1);
});

test("a pinned item or a website in its own window prevents implicit workspace reclamation", async () => {
  for (const dialog of [false, true]) {
    const web = reduceWorkPanelCommand(overview().nextState, {
      type: "openItem", ownerChatId: "chat-a",
      descriptor: { kind: "web", url: "https://example.test/", ...(!dialog ? { pinned: true } : {}) },
    });
    const presented = dialog ? reduceWorkPanelCommand(web.nextState, {
      type: "setDialogPresentation", ownerChatId: "chat-a", itemId: web.item.itemId,
      dialog: { ownerChatId: "chat-a", itemId: web.item.itemId, surfaceId: "page:a", transferId: "transfer-a" },
    }) : web;
    const panel = host(attachment(presented.nextState).nextState);
    await panel.close();
    assert.equal(panel.state().workspaces[0].items.length, 2);
    assert.ok(panel.state().workspaces[0].items.some((item) => item.itemId === web.item.itemId));
    if (dialog) assert.equal(panel.state().dialogItems[0].transferId, "transfer-a");
  }
});

test("busy, rejected dirty confirmation, and rejected annotation confirmation leave the whole panel intact", async () => {
  const initial = attachment(overview().nextState);
  for (const options of [{ busy: true }, { dirty: true, confirm: false }]) {
    const panel = host(initial.nextState, options);
    assert.equal(await panel.close(), false);
    assert.equal(panel.state(), initial.nextState);
    assert.equal(panel.commands.length, 0);
  }
  const started = reduceWorkPanelCommand(initial.nextState, {
    type: "startReview", ownerChatId: "chat-a", itemId: initial.item.itemId, kind: "image",
    source: { sourceKind: "workspace-file", fileName: "attachment.png", relativePath: "attachment.png", revision: "100:200" },
  });
  const annotated = reduceWorkPanelCommand(started.nextState, {
    type: "addImageReviewAnnotation", ownerChatId: "chat-a", itemId: initial.item.itemId,
    annotation: { id: "region-a", rect: { x: 0, y: 0, width: 10, height: 10 },
      normalizedRect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
  });
  assert.equal(annotated.ok, true);
  const guarded = host(annotated.nextState, { confirm: false });
  assert.equal(await guarded.close(), false);
  assert.equal(guarded.state(), annotated.nextState);
  const accepted = host(annotated.nextState);
  assert.equal(await accepted.close(), true);
  assert.deepEqual(accepted.state().workspaces, []);
  assert.deepEqual(accepted.state().review.sessionsByKey, {});
});

test("close approval cannot discard a draft that changed while the dialog was open", async () => {
  let approve;
  const opened = attachment(overview().nextState);
  const panel = host(opened.nextState, { dirty: true, confirm: () => new Promise((resolve) => { approve = resolve; }) });
  const closing = panel.close();
  panel.nodes.get(opened.item.itemId).textContent = "newer draft";
  approve(true);
  assert.equal(await closing, false);
  assert.equal(panel.commands.length, 0);
  assert.equal(panel.state(), opened.nextState);
});

test("close approval cannot close a replacement item or an unmounted host", async () => {
  for (const replace of [true, false]) {
    let approve;
    const opened = attachment(overview().nextState);
    const panel = host(opened.nextState, { dirty: true, confirm: () => new Promise((resolve) => { approve = resolve; }) });
    const closing = panel.close();
    if (replace) panel.stateRef.current = { ...opened.nextState, workspaces: opened.nextState.workspaces.map((workspace) => ({ ...workspace, items: workspace.items.map((item) => item.itemId === opened.item.itemId ? { ...item } : item) })) };
    else panel.rootRef.current = null;
    approve(true);
    assert.equal(await closing, false);
    assert.equal(panel.commands.length, 0);
  }
});

test("close others leaves new tabs intact when the target set changes during confirmation", async () => {
  let approve;
  const first = attachment(overview().nextState);
  const second = attachment(first.nextState, "chat-a", "second");
  const panel = host(second.nextState, { dirty: true, confirm: () => new Promise((resolve) => { approve = resolve; }) });
  const closing = panel.closeOthers(first.item.itemId);
  panel.stateRef.current = attachment(panel.state(), "chat-a", "new-during-confirmation").nextState;
  approve(true);
  assert.equal(await closing, false);
  assert.equal(panel.commands.length, 0);
  assert.equal(panel.state().workspaces[0].items.length, 4);
});

test("approved close others removes only the original closable targets", async () => {
  const first = attachment(overview().nextState);
  const second = attachment(first.nextState, "chat-a", "second");
  const panel = host(second.nextState, { dirty: true });
  assert.equal(await panel.closeOthers(first.item.itemId), true);
  assert.deepEqual(panel.state().workspaces[0].items.map((item) => item.itemId), [first.nextState.workspaces[0].items[0].itemId, first.item.itemId]);
});

const shellSource = fs.readFileSync(new URL("../src/renderer/app-shell/AppShell.tsx", import.meta.url), "utf8");
const shellAst = ts.createSourceFile("AppShell.tsx", shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const shellCallbacks = new Map();
function visitShell(node) {
  if (ts.isVariableDeclaration(node) && [
    "ensureChatWorkPanelWorkspace", "completeChatWorkPanelOpen", "clearPendingChatWorkPanelOpen",
    "requestChatWorkPanelOpenWhenRegistered", "toggleMainChatWorkPanel", "openChatWorkPanelFromSidebar",
  ].includes(node.name.getText(shellAst))) {
    shellCallbacks.set(node.name.getText(shellAst), node.initializer.getText(shellAst));
  }
  ts.forEachChild(node, visitShell);
}
visitShell(shellAst);
assert.equal(shellCallbacks.size, 6);
const shellCode = ts.transpileModule(
  [...shellCallbacks].map(([name, initializer]) => `const ${name} = ${initializer};`).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

function shell({ registered = true, existing = false } = {}) {
  const stateRef = { current: existing ? attachment(overview().nextState).nextState : EMPTY_WORK_PANEL_STATE };
  const pending = { current: null };
  const route = "/agent/agent-a?chatId=chat-a";
  const context = vm.createContext({
    useCallback: (callback) => callback,
    workPanelStateRef: stateRef,
    pendingChatWorkPanelOpenRef: pending,
    registeredMainChatSurfaceRef: { current: registered
      ? { identity: { kind: "canonical", agentKey: "agent-a", chatId: "chat-a" } } : null },
    registeredMainChatRouteRef: { current: registered ? route : "" },
    lastMainChatCommitRef: { current: null },
    activeChatRouteInfo: { agentKey: "agent-a", chatId: "chat-a" },
    desiredChatRouteChatId: "chat-a",
    activeChatWorkPanelOwnerKey: "chat-a",
    activeChatWorkPanelVisible: false,
    currentRoute: route,
    t: (key) => key,
    createAgentWebclientOverviewPath: ({ chatId }) => `/overview/${chatId}`,
    createAgentChatRoute: (agentKey, chatId) => `/agent/${agentKey}?chatId=${chatId}`,
    requestSidebarNavigation: () => {},
    setWorkPanelOpenError: () => {},
    window: { clearTimeout: () => {}, setTimeout: () => 1 },
    dispatchWorkPanelCommand: (command) => {
      const result = reduceWorkPanelCommand(stateRef.current, command);
      stateRef.current = result.nextState;
      return result;
    },
  });
  vm.runInContext(`${shellCode}\nglobalThis.toggle = toggleMainChatWorkPanel;
    globalThis.sidebar = openChatWorkPanelFromSidebar;
    globalThis.restore = () => requestChatWorkPanelOpenWhenRegistered("chat-a", "agent-a", "show");
    globalThis.commitPending = () => { const intent = pendingChatWorkPanelOpenRef.current;
      completeChatWorkPanelOpen(intent.chatId, intent.agentKey, intent.action, intent.explicitlyOpened); };`, context);
  return { state: () => stateRef.current, pending, toggle: context.toggle, sidebar: context.sidebar,
    restore: context.restore, commitPending: context.commitPending };
}

test("real AppShell header and sidebar entry points record explicit intent only after opening", () => {
  for (const existing of [false, true]) {
    const header = shell({ existing });
    header.toggle();
    assert.deepEqual(header.state().explicitlyOpenedOwnerChatIds, ["chat-a"]);
    const sidebar = shell({ existing });
    sidebar.sidebar("chat-a", "agent-a");
    assert.deepEqual(sidebar.state().explicitlyOpenedOwnerChatIds, ["chat-a"]);
  }
  const deferred = shell({ registered: false });
  deferred.toggle();
  assert.deepEqual(deferred.state().workspaces, []);
  assert.equal(deferred.pending.current.explicitlyOpened, true);
  deferred.commitPending();
  assert.deepEqual(deferred.state().explicitlyOpenedOwnerChatIds, ["chat-a"]);
});

test("real AppShell automatic window restoration does not promote an implicit panel", () => {
  const restored = shell({ existing: true });
  restored.restore();
  assert.deepEqual(restored.state().explicitlyOpenedOwnerChatIds, []);
  const deferred = shell({ existing: true, registered: false });
  deferred.restore();
  assert.equal(deferred.pending.current.explicitlyOpened, false);
  deferred.commitPending();
  assert.deepEqual(deferred.state().explicitlyOpenedOwnerChatIds, []);
});
