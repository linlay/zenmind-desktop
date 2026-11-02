import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/renderer/app-shell/navigation/AppSidebar.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("AppSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "removeWebappItem") handler = node;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(handler, "The sidebar WebApp uninstall handler must exist");
const script = ts.transpileModule(`(() => { ${handler.getText(parsed)}; return removeWebappItem; })()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const item = { kind: "webapp", id: "example-app", label: "Example App", removable: true };

function fixture({ confirm = async () => true, remove = async () => ({ ok: true }), error = async () => true } = {}) {
  const confirmations = [], errors = [], removals = [], pendingChanges = [], nativeCalls = [];
  const removalStarted = deferred(), errorShown = deferred();
  const context = {
    Error,
    webItemRemovePendingId: "",
    webItemRemoveInFlightRef: { current: false },
    t: (key, values) => values?.name ? `${key}:${values.name}` : key,
    webappRemovalModal: {
      confirm(options) { confirmations.push(options); return confirm(options); },
      error(options) { errors.push(options); errorShown.resolve(); return error(options); },
    },
    onRemoveWebappItem: remove ? async target => { removals.push(target); removalStarted.resolve(); return remove(target); } : undefined,
    setWebItemRemovePendingId(value) { context.webItemRemovePendingId = value; pendingChanges.push(value); },
    window: Object.fromEntries(["confirm", "alert"].map(name => [name, () => {
      nativeCalls.push(name);
      throw new Error(`Native ${name} must not be used by WebApp uninstall`);
    }])),
  };
  return { context, confirmations, errors, removals, pendingChanges, nativeCalls,
    removalStarted: removalStarted.promise, errorShown: errorShown.promise, run: vm.runInNewContext(script, context) };
}

test("canceling the renderer confirmation leaves the WebApp installed and permits another request", async () => {
  const view = fixture({ confirm: async () => false });
  await view.run(item);
  assert.equal(view.confirmations.length, 1);
  assert.equal(view.confirmations[0].content, "sidebar.webapp.removeConfirm:Example App");
  assert.equal(view.confirmations[0].cancelText, "common.cancel");
  assert.equal(view.removals.length, 0);
  assert.equal(view.context.webItemRemovePendingId, "");
  assert.equal(view.context.webItemRemoveInFlightRef.current, false);
  await view.run(item);
  assert.equal(view.confirmations.length, 2);
  assert.deepEqual(view.nativeCalls, []);
});

test("duplicate requests cannot open a second confirmation or uninstall twice", async () => {
  const confirmation = deferred(), removal = deferred();
  const view = fixture({ confirm: () => confirmation.promise, remove: () => removal.promise });
  const first = view.run(item);
  await view.run(item);
  assert.equal(view.confirmations.length, 1);
  assert.equal(view.removals.length, 0);
  confirmation.resolve(true);
  await view.removalStarted;
  assert.deepEqual(view.removals, [item]);
  assert.equal(view.context.webItemRemovePendingId, item.id);
  await view.run({ ...item, id: "another-app" });
  assert.equal(view.confirmations.length, 1);
  removal.resolve({ ok: true });
  await first;
  assert.equal(view.errors.length, 0);
  assert.equal(view.context.webItemRemovePendingId, "");
  assert.equal(view.context.webItemRemoveInFlightRef.current, false);
  assert.deepEqual(view.pendingChanges, [item.id, ""]);
  assert.deepEqual(view.nativeCalls, []);
});

for (const failure of [
  { name: "domain failure", remove: async () => ({ ok: false, message: "Application is still publishing" }), message: "Application is still publishing" },
  { name: "rejected uninstall", remove: async () => { throw new Error("Uninstall request failed"); }, message: "Uninstall request failed" },
  { name: "unavailable uninstall API", remove: null, message: "sidebar.webapp.removeFailed" },
]) {
  test(`${failure.name} uses renderer feedback and releases pending state for retry`, async () => {
    const view = fixture({ remove: failure.remove });
    await view.run(item);
    assert.equal(view.errors.length, 1);
    assert.equal(view.errors[0].content, failure.message);
    assert.equal(view.errors[0].okText, "common.close");
    assert.equal(view.context.webItemRemovePendingId, "");
    assert.equal(view.context.webItemRemoveInFlightRef.current, false);
    await view.run(item);
    assert.equal(view.confirmations.length, 2);
    assert.deepEqual(view.nativeCalls, []);
  });
}

test("managed WebApps receive renderer feedback without offering or executing uninstall", async () => {
  const view = fixture();
  await view.run({ ...item, removable: false });
  assert.equal(view.confirmations.length, 0);
  assert.equal(view.removals.length, 0);
  assert.equal(view.errors[0].content, "sidebar.webapp.managedNotRemovable:Example App");
  assert.equal(view.context.webItemRemoveInFlightRef.current, false);
  assert.deepEqual(view.nativeCalls, []);
});

test("a failure dialog keeps duplicate requests blocked until it is dismissed", async () => {
  const dismissed = deferred();
  const view = fixture({ remove: async () => ({ ok: false, message: "Try again" }), error: () => dismissed.promise });
  const first = view.run(item);
  await view.errorShown;
  assert.equal(view.errors.length, 1);
  await view.run(item);
  assert.equal(view.confirmations.length, 1);
  assert.equal(view.removals.length, 1);
  dismissed.resolve(true);
  await first;
  assert.equal(view.context.webItemRemovePendingId, "");
  assert.equal(view.context.webItemRemoveInFlightRef.current, false);
  assert.deepEqual(view.nativeCalls, []);
});
