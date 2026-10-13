import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = "src/renderer/app-shell/navigation/AppSidebar.tsx";
const enterprise = "src/renderer/enterprise-chat/EnterpriseChatFloatingPanel.tsx";
const kanban = "src/renderer/pages/kanban/KanbanPage.tsx";

// Execute the production handlers with controlled React state setters and IPC.
// This covers the async confirmation boundary without mounting the full shell.
function readHandler(file, name, bindings) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(tree) === "useCallback") {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `Production handler ${name} exists`);
  const executable = ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return vm.runInNewContext(executable, { Error, ...bindings });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function state(initial) {
  return { value: initial, set(update) { this.value = typeof update === "function" ? update(this.value) : update; } };
}

test("sidebar removal locks before confirmation, cancels, and rechecks the original webapp", async () => {
  const item = { kind: "webapp", id: "one", entryKey: "webapp:one", label: "One" };
  const confirmation = deferred();
  const pending = state("");
  const removed = [];
  let asks = 0;
  const bindings = {
    t: key => key, notify() {}, webItemRemovePendingRef: { current: false },
    webItemsRef: { current: [item] }, setWebItemRemovePendingId: pending.set.bind(pending),
    confirmDialog: () => { asks++; return confirmation.promise; },
    onRemoveWebappItem: async value => { removed.push(value); return { ok: true }; }
  };
  const remove = readHandler(sidebar, "removeWebappItem", bindings);
  const first = remove(item);
  await remove(item);
  assert.equal(asks, 1);
  assert.equal(pending.value, item.id);
  assert.equal(removed.length, 0);
  confirmation.resolve(false);
  await first;
  assert.equal(pending.value, "");
  assert.equal(bindings.webItemRemovePendingRef.current, false);
  assert.equal(removed.length, 0);

  bindings.confirmDialog = async () => true;
  bindings.webItemsRef.current = [];
  await readHandler(sidebar, "removeWebappItem", bindings)(item);
  assert.equal(removed.length, 0);
  const currentItem = { ...item, label: "Current label" };
  bindings.webItemsRef.current = [currentItem];
  await readHandler(sidebar, "removeWebappItem", bindings)(item);
  assert.equal(removed[0], currentItem);
});

test("sidebar sign-out never applies an earlier confirmation to another account", async () => {
  const confirmation = deferred();
  const pending = state(false);
  const status = { authenticated: true, user: { sub: "account-a" } };
  let logouts = 0;
  const bindings = {
    t: key => key, desktopSsoBusy: false, desktopSsoStatus: status,
    logoutConfirmationPendingRef: { current: false },
    ssoActionRef: { current: { desktopSsoBusy: false, desktopSsoStatus: status, onDesktopSsoLogout: () => { logouts++; } } },
    setLogoutConfirmationPending: pending.set.bind(pending), confirmDialog: () => confirmation.promise,
    closeToolMenu() {}
  };
  const signOut = readHandler(sidebar, "handleDesktopSsoLogoutClick", bindings);
  const operation = signOut({ preventDefault() {}, stopPropagation() {} });
  assert.equal(pending.value, true);
  bindings.ssoActionRef.current.desktopSsoStatus = { authenticated: true, user: { sub: "account-b" } };
  confirmation.resolve(true);
  await operation;
  assert.equal(logouts, 0);
  assert.equal(pending.value, false);
});

function enterpriseBindings(confirmDialog) {
  const busy = state("");
  const errors = [];
  const snapshots = [];
  const sent = [];
  const pickers = [];
  const bindings = {
    t: key => key, busy: "", snapshot: { activeConversationId: "im-original" },
    confirmationPendingRef: { current: false }, confirmationContextRef: { current: { key: "account-a:im-original" } },
    confirmDialog, setBusy: busy.set.bind(busy), setError: value => errors.push(value),
    setSnapshot: value => snapshots.push(value), setAttachmentMenuOpen() {},
    setAgentChatPickerOpen: value => pickers.push(value), newClientMessageId: () => "message-one",
    window: { electronAPI: { enterpriseChat: {
      sendSupportBundle: async value => { sent.push(value); return "updated"; },
      sendRawAgentChat: async value => { sent.push(value); return "updated"; }
    } } }
  };
  return { bindings, busy, errors, snapshots, sent, pickers };
}

for (const name of ["sendSupportBundle", "sendRawAgentChat"]) {
  const chat = { id: "agent-original", title: " Original chat " };
  test(`${name} requires acceptance and suppresses a repeated click`, async () => {
    const confirmation = deferred();
    let asks = 0;
    const fixture = enterpriseBindings(() => { asks++; return confirmation.promise; });
    const send = readHandler(enterprise, name, fixture.bindings);
    const operation = send(chat);
    await send(chat);
    assert.equal(asks, 1);
    assert.equal(fixture.sent.length, 0);
    confirmation.resolve(false);
    await operation;
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.busy.value, "");
    assert.equal(fixture.bindings.confirmationPendingRef.current, false);
  });

  test(`${name} cancels when the account, conversation or panel changes before acceptance`, async () => {
    const confirmation = deferred();
    const fixture = enterpriseBindings(() => confirmation.promise);
    const operation = readHandler(enterprise, name, fixture.bindings)(chat);
    fixture.bindings.confirmationContextRef.current = { key: "account-b:im-other" };
    confirmation.resolve(true);
    await operation;
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.snapshots.length, 0);
  });

  test(`${name} sends once to the confirmed conversation and keeps the source chat identity`, async () => {
    const fixture = enterpriseBindings(async () => true);
    await readHandler(enterprise, name, fixture.bindings)(chat);
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.sent[0].conversationId, "im-original");
    assert.equal(fixture.sent[0].clientMessageId, "message-one");
    if (name === "sendRawAgentChat") {
      assert.equal(fixture.sent[0].chatId, chat.id);
      assert.equal(fixture.sent[0].chatName, "Original chat");
    }
    assert.deepEqual(fixture.snapshots, ["updated"]);
    assert.equal(fixture.busy.value, "");
  });
}

test("enterprise hide remains a scoped local preference and preserves the confirmed sequence", async () => {
  const confirmation = deferred();
  const fixture = enterpriseBindings(() => confirmation.promise);
  const preferences = state([{ scope: "other", conversationId: "one", lastSeq: 10 }]);
  Object.assign(fixture.bindings, {
    preferenceScope: "scope-a", setOpenConversationMenuId() {}, conversationTitle: value => value.title,
    setHiddenConversationPreferences: preferences.set.bind(preferences)
  });
  const hide = readHandler(enterprise, "hideConversation", fixture.bindings);
  const operation = hide({ id: "one", title: "One", lastSeq: 42 });
  assert.equal(preferences.value.length, 1);
  confirmation.resolve(true);
  await operation;
  assert.equal(preferences.value.length, 2);
  assert.equal(preferences.value[1].scope, "scope-a");
  assert.equal(preferences.value[1].conversationId, "one");
  assert.equal(preferences.value[1].lastSeq, 42);
  assert.equal(fixture.sent.length, 0);
});

function kanbanBindings(confirmDialog) {
  const busy = state(null);
  const modal = state({ mode: "edit", issue: { id: "another" } });
  const detail = state("another");
  const feedback = [];
  const deleted = [];
  const issue = { id: "local-one", title: "One", syncMode: "local" };
  const bindings = {
    t: key => key, setContextMenu() {}, busyIssueId: null, deleteIssuePendingRef: { current: false },
    issuesRef: { current: [issue] }, missingKanbanApiMessage: "missing", confirmDialog,
    canEditKanbanIssueBody: value => value.syncMode === "local",
    readKanbanApi: () => ({ deleteIssue: async id => { deleted.push(id); return { ok: true, issues: [], message: "deleted" }; } }),
    setBusyIssueId: busy.set.bind(busy), setIssues() {}, sortIssues: value => value,
    setFeedback: value => feedback.push(value), setModal: modal.set.bind(modal), setDetailIssueId: detail.set.bind(detail)
  };
  return { bindings, issue, busy, modal, detail, feedback, deleted };
}

test("Kanban deletion is single-flight and does not close a different issue selected meanwhile", async () => {
  const confirmation = deferred();
  const fixture = kanbanBindings(() => confirmation.promise);
  const remove = readHandler(kanban, "deleteIssue", fixture.bindings);
  const operation = remove(fixture.issue);
  assert.equal(await remove(fixture.issue), false);
  assert.equal(fixture.busy.value, fixture.issue.id);
  confirmation.resolve(true);
  assert.equal(await operation, true);
  assert.deepEqual(fixture.deleted, [fixture.issue.id]);
  assert.equal(fixture.modal.value.issue.id, "another");
  assert.equal(fixture.detail.value, "another");
  assert.equal(fixture.busy.value, null);
});

test("Kanban rechecks local edit permission and recovers from a rejected deletion", async () => {
  const confirmation = deferred();
  const fixture = kanbanBindings(() => confirmation.promise);
  const operation = readHandler(kanban, "deleteIssue", fixture.bindings)(fixture.issue);
  fixture.bindings.issuesRef.current = [{ ...fixture.issue, syncMode: "cloud" }];
  confirmation.resolve(true);
  assert.equal(await operation, false);
  assert.equal(fixture.deleted.length, 0);

  fixture.bindings.issuesRef.current = [fixture.issue];
  fixture.bindings.confirmDialog = async () => true;
  fixture.bindings.readKanbanApi = () => ({ deleteIssue: async () => { throw new Error("Delete rejected"); } });
  assert.equal(await readHandler(kanban, "deleteIssue", fixture.bindings)(fixture.issue), false);
  assert.equal(fixture.feedback.at(-1).message, "Delete rejected");
  assert.equal(fixture.busy.value, null);
  assert.equal(fixture.bindings.deleteIssuePendingRef.current, false);
});
