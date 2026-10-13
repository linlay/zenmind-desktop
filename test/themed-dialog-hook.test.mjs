import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/renderer/components/useThemedDialogs.tsx");
const executable = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

// Keep refs and dependency-sensitive callbacks across renders. Effects can be
// cleaned up by a real unmount or replayed like React StrictMode in development.
// Only the hook runtime and Ant's dialog handles are mocked; all dialog control
// flow comes from the complete production module above.
function mountDialogs() {
  const slots = [];
  const effectsToRun = [];
  const dialogs = [];
  const holder = { type: "owned-modal-holder" };
  let cursor = 0;
  const sameDependencies = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: "ref", value: { current: initial } };
      return slots[index].value;
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !sameDependencies(slots[index].dependencies, dependencies)) {
        slots[index] = { kind: "callback", value: callback, dependencies };
      }
      return slots[index].value;
    },
    useEffect(setup, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        const next = { kind: "effect", setup, dependencies, cleanup: undefined };
        slots[index] = next;
        effectsToRun.push(() => { previous?.cleanup?.(); next.cleanup = setup(); });
      }
    }
  };
  const modal = Object.fromEntries(["confirm", "error", "info", "success", "warning"].map(kind => [kind, options => {
    const dialog = { kind, options, destroyCalls: 0 };
    dialog.handle = { destroy() {
      dialog.destroyCalls++;
      // Ant may notify afterClose during destruction. Exercise that re-entry.
      options.afterClose?.();
    } };
    dialogs.push(dialog);
    return dialog.handle;
  }]));
  const translate = key => ({ "common.confirm": "Confirm", "common.cancel": "Cancel" })[key] ?? key;
  const exported = {};
  vm.runInNewContext(executable, {
    exports: exported,
    require(name) {
      if (name === "react") return react;
      if (name === "antd") return { Modal: { useModal: () => [modal, holder] } };
      if (name === "../i18n/useI18n") return { useI18n: () => ({ t: translate }) };
      throw new Error(`Unexpected production import: ${name}`);
    }
  }, { filename: sourcePath });
  const render = () => {
    cursor = 0;
    const result = exported.useThemedDialogs();
    for (const setup of effectsToRun.splice(0)) setup();
    return result;
  };
  return {
    api: render(), dialogs, modal, holder, render,
    unmount() {
      for (const slot of slots) {
        if (slot.kind === "effect") { slot.cleanup?.(); slot.cleanup = undefined; }
      }
    },
    replayEffects() {
      const effects = slots.filter(slot => slot.kind === "effect");
      for (const effect of effects) effect.cleanup?.();
      for (const effect of effects) effect.cleanup = effect.setup();
    }
  };
}

test("confirmation uses its owner's modal holder, cancel focus, and the shared overlay layer", async () => {
  const fixture = mountDialogs();
  assert.equal(fixture.api.contextHolder, fixture.holder);
  assert.equal(fixture.api.modal, fixture.modal);
  const response = fixture.api.confirm("Delete this item?");
  const { kind, options } = fixture.dialogs[0];
  assert.equal(kind, "confirm");
  assert.equal(options.content, "Delete this item?");
  assert.equal(options.title, "Confirm");
  assert.equal(options.okText, "Confirm");
  assert.equal(options.cancelText, "Cancel");
  assert.equal(options.autoFocusButton, "cancel");
  assert.equal(options.maskClosable, false);
  assert.equal(options.centered, true);
  assert.equal(options.zIndex, 10000);
  options.onCancel();
  assert.equal(await response, false);
});

test("acceptance resolves once and preserves custom content, labels, and danger intent", async () => {
  const { api, dialogs } = mountDialogs();
  const content = { type: "p", props: { children: "Meaningful confirmation" } };
  const response = api.confirm(content, { title: "Remove", okText: "Delete", cancelText: "Keep", danger: true });
  const { options } = dialogs[0];
  assert.equal(options.content, content);
  assert.equal(options.title, "Remove");
  assert.equal(options.okText, "Delete");
  assert.equal(options.cancelText, "Keep");
  assert.equal(options.okButtonProps.danger, true);
  options.onOk();
  options.onCancel();
  options.afterClose();
  assert.equal(await response, true);
});

test("cancel and external close resolve false and allow a fresh confirmation", async () => {
  const { api, dialogs } = mountDialogs();
  const cancelled = api.confirm("First");
  dialogs[0].options.onCancel();
  dialogs[0].options.onOk();
  assert.equal(await cancelled, false);
  const closed = api.confirm("Second");
  dialogs[1].options.afterClose();
  assert.equal(await closed, false);
  const accepted = api.confirm("Third");
  dialogs[2].options.onOk();
  assert.equal(await accepted, true);
});

test("a repeated confirmation is rejected without borrowing the first positive answer", async () => {
  const { api, dialogs } = mountDialogs();
  const first = api.confirm("First operation");
  const second = api.confirm("Different operation");
  assert.equal(await second, false);
  assert.equal(dialogs.length, 1);
  dialogs[0].options.onOk();
  assert.equal(await first, true);
  const third = api.confirm("Next operation");
  assert.equal(dialogs.length, 2);
  dialogs[1].options.onCancel();
  assert.equal(await third, false);
});

test("rerendering preserves the pending confirmation and its single-action guard", async () => {
  const fixture = mountDialogs();
  const first = fixture.api.confirm("Keep pending");
  const rerendered = fixture.render();
  assert.equal(rerendered.contextHolder, fixture.holder);
  assert.equal(await rerendered.confirm("Repeated click after rerender"), false);
  assert.equal(fixture.dialogs.length, 1);
  fixture.dialogs[0].options.onOk();
  assert.equal(await first, true);
});

test("cancelPending destroys confirmation and notifications once and unlocks later actions", async () => {
  const { api, dialogs } = mountDialogs();
  const response = api.confirm("Pending destructive operation");
  api.notify("Saved", "success");
  api.notify("Unavailable", "warning");
  api.cancelPending();
  assert.equal(await response, false);
  assert.deepEqual(dialogs.map(dialog => dialog.destroyCalls), [1, 1, 1]);
  dialogs[0].options.onOk();
  api.cancelPending();
  assert.deepEqual(dialogs.map(dialog => dialog.destroyCalls), [1, 1, 1]);
  const next = api.confirm("New operation after context change");
  dialogs[3].options.onOk();
  assert.equal(await next, true);
});

test("unmount cancels pending work, cleans notifications, and ignores late callbacks and new requests", async () => {
  const fixture = mountDialogs();
  const response = fixture.api.confirm("Pending on unmount");
  fixture.api.notify("Failure", "error");
  fixture.unmount();
  assert.equal(await response, false);
  assert.deepEqual(fixture.dialogs.map(dialog => dialog.destroyCalls), [1, 1]);
  fixture.dialogs[0].options.onOk();
  assert.equal(await fixture.api.confirm("Cannot open after unmount"), false);
  fixture.api.notify("Cannot notify after unmount");
  assert.equal(fixture.dialogs.length, 2);
  fixture.unmount();
  assert.deepEqual(fixture.dialogs.map(dialog => dialog.destroyCalls), [1, 1]);
});

test("StrictMode effect replay cancels old dialogs and leaves the mounted hook usable", async () => {
  const fixture = mountDialogs();
  const oldResponse = fixture.api.confirm("Old effect lifetime");
  fixture.api.notify("Old notification", "info");
  fixture.replayEffects();
  assert.equal(await oldResponse, false);
  assert.deepEqual(fixture.dialogs.map(dialog => dialog.destroyCalls), [1, 1]);
  const newResponse = fixture.api.confirm("New effect lifetime");
  fixture.dialogs[2].options.onOk();
  assert.equal(await newResponse, true);
  fixture.api.notify("Still mounted", "success");
  assert.equal(fixture.dialogs[3].kind, "success");
  fixture.unmount();
  assert.equal(fixture.dialogs[3].destroyCalls, 1);
});

test("notifications preserve severity and naturally closed handles are not destroyed again", () => {
  const { api, dialogs } = mountDialogs();
  api.notify("Default error");
  for (const kind of ["error", "info", "success", "warning"]) api.notify(kind, kind);
  assert.deepEqual(dialogs.map(dialog => dialog.kind), ["error", "error", "info", "success", "warning"]);
  for (const { options } of dialogs) {
    assert.equal(options.zIndex, 10000);
    assert.equal(options.okText, "Confirm");
    options.afterClose();
  }
  api.cancelPending();
  assert.ok(dialogs.every(dialog => dialog.destroyCalls === 0));
});
