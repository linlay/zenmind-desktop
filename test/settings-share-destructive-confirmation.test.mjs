import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const settingsPath = "src/renderer/pages/settings/SettingsPage.tsx";
const sharePath = "src/renderer/pages/share-management/ShareManagementPage.tsx";
const operations = [
  [settingsPath, "handleDeleteWebsiteItem", "remove"],
  [settingsPath, "handleDeleteWebappItem", "uninstall"],
  [settingsPath, "handleUnpublishWebapp", "unpublish"],
  [settingsPath, "handleResetRuntimeEnv", "resetRuntimeEnv"],
  [sharePath, "revokeShare", "revokeChatShare"]
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the actual page handlers with only their UI and IPC dependencies stubbed.
// This checks the mutation boundary without loading unrelated settings services.
function createHarness(file, name, confirm, mutation) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declaration, `${name} exists in the page`);
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const calls = [];
  const feedback = [];
  const pending = { current: false };
  const invoke = async (...args) => {
    calls.push(args);
    return mutation?.(...args) ?? { ok: true, items: [], info: null, state: null, message: "completed" };
  };
  const context = {
    exports: {},
    confirm, destructiveActionPendingRef: pending, revokePendingRef: pending,
    deletingWebsiteId: "", websitePending: false, webappPublishPendingId: "", webappDeletingId: "", webappPending: false, runtimeResetPending: false,
    t: (key, values) => ({ key, values }),
    window: { electronAPI: { webs: { websites: { remove: invoke }, webapps: { uninstall: invoke, unpublish: invoke } }, settings: { resetRuntimeEnv: invoke }, assistant: { revokeChatShare: invoke } } },
    setDeletingWebsiteId() {}, setWebappDeletingId() {}, setWebappPublishPendingId() {}, setWebappPublishInfoById() {},
    setRuntimeResetPending() {}, setRuntimeResetResult() {}, setRevokingShareId() {},
    showSectionResultNotice: (...args) => feedback.push(args), showSectionNotice: (...args) => feedback.push(args),
    showActionFeedback: (...args) => feedback.push(args), clearActionFeedback() {},
    setRecords() {}, pendingWebsiteSelectionIdRef: { current: "" }, pendingWebsiteSnapshotRef: { current: null },
    setSelectedWebsiteId() {}, applyWebsiteDraftFromItem() {}, clearWebsiteDraft() {}, WEBSITE_NEW_ID: "new",
    refreshWebItemsFromSettings: async () => {}, onWebappPublishStateChange() {}, onWebappRuntimeStateChange() {},
    setSelectedWebappId() {}, setWebappLogContent() {}, setReadErrorSections() {},
    require: (name) => {
      assert.equal(name, "react/jsx-runtime");
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" };
    }
  };
  const run = new Function(...Object.keys(context), `${compiled}\nreturn ${name};`)(...Object.values(context));
  return { run, calls, pending, feedback };
}

for (const [file, name, mutationName] of operations) {
  test(`${mutationName}: cancellation makes no mutation and releases the operation lock`, async () => {
    const harness = createHarness(file, name, async () => false);
    await harness.run({ id: "target", label: "Original target", shareId: "target", url: "https://example.test/target" });
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.pending.current, false);
    assert.deepEqual(harness.feedback, []);
  });

  test(`${mutationName}: waits for approval, preserves the captured target, and ignores duplicate clicks`, async () => {
    const approval = deferred();
    const mutation = deferred();
    let confirmations = 0;
    const harness = createHarness(file, name, () => { confirmations += 1; return approval.promise; }, () => mutation.promise);
    const target = { id: "original", label: "Original target", shareId: "original", url: "https://example.test/original" };
    const running = harness.run(target);
    await harness.run({ ...target, id: "other", shareId: "other" });
    assert.equal(confirmations, 1);
    assert.deepEqual(harness.calls, []);
    target.id = "changed";
    target.shareId = "changed";
    approval.resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.calls, mutationName === "resetRuntimeEnv" ? [[]] : [["original"]]);
    await harness.run(target);
    assert.equal(harness.calls.length, 1);
    mutation.resolve({ ok: true, items: [], info: null, state: null, message: "completed" });
    await running;
    assert.equal(harness.pending.current, false);
  });

  test(`${mutationName}: failure preserves feedback and allows an explicit retry`, async () => {
    let attempts = 0;
    const harness = createHarness(file, name, async () => true, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Request failed");
      return { ok: true, items: [], info: null, state: null, message: "completed" };
    });
    const target = { id: "target", label: "Target", shareId: "target", url: "https://example.test/target" };
    await harness.run(target);
    assert.equal(harness.pending.current, false);
    assert.ok(harness.feedback.some((args) => args.includes("Request failed")));
    await harness.run(target);
    assert.equal(harness.calls.length, 2);
  });
}

test("managed web apps cannot be uninstalled through the settings handler", async () => {
  let confirmations = 0;
  const harness = createHarness(settingsPath, "handleDeleteWebappItem", async () => { confirmations += 1; return true; });
  await harness.run({ id: "managed", label: "Managed", removable: false });
  assert.equal(confirmations, 0);
  assert.deepEqual(harness.calls, []);
});
