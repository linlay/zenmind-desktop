import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function harness() {
  const effects = [];
  const observers = [];
  const events = new Map();
  const requests = [];
  const refs = [];
  let cursor = 0;
  let onRead = 0;
  let onError = 0;
  let succeed = true;
  const document = { visibilityState: "visible", addEventListener: (key, fn) => events.set(key, fn), removeEventListener: (key) => events.delete(key) };
  const react = { useRef: (initial) => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }), useEffect: (fn) => effects.push(fn) };
  const source = fs.readFileSync("src/renderer/pages/kanban/useKanbanResultRead.ts", "utf8");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    module, exports: module.exports, require: () => react, document,
    IntersectionObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    window: { electronAPI: { kanban: { markResultRead: async (input) => { requests.push(input); return { ok: succeed }; } } } }
  });
  const input = { issueId: "i", scope: "account-a", key: "chat:run-1", ready: true, isRead: false, onRead: () => onRead++, onError: () => onError++ };
  function render(patch = {}) {
    cursor = 0;
    const ref = module.exports.useKanbanResultRead({ ...input, ...patch });
    ref.current = {};
    return effects.pop()();
  }
  return { requests, render, document, events, refs, stats: () => ({ onRead, onError }), fail: () => { succeed = false; }, intersect: (visible) => observers.at(-1)?.callback([{ isIntersecting: visible, intersectionRect: { width: visible ? 100 : 0, height: visible ? 100 : 0 } }]) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("only visible, successfully rendered results trigger reading", async () => {
  const h = harness();
  h.render({ ready: false });
  h.intersect(true);
  assert.equal(h.requests.length, 0);
  const cleanup = h.render();
  h.intersect(false);
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = "hidden";
  h.intersect(true);
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = "visible";
  h.events.get("visibilitychange")();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.stats().onRead, 1);
  h.intersect(true);
  await flush();
  assert.equal(h.requests.length, 1);
  cleanup();
  h.render({ key: "chat:run-2" });
  h.intersect(true);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].key, "chat:run-2");
});

test("failed requests remain retryable and report failure without marking success", async () => {
  const h = harness();
  h.fail();
  const cleanup = h.render();
  h.intersect(true);
  await flush();
  assert.equal(h.stats().onRead, 0);
  assert.equal(h.stats().onError, 1);
  cleanup();
  h.render();
  h.intersect(true);
  await flush();
  assert.equal(h.requests.length, 2);
});

test("already read results and a closed detail do not send requests", () => {
  const h = harness();
  h.render({ isRead: true });
  h.intersect(true);
  assert.equal(h.requests.length, 0);
  const cleanup = h.render();
  cleanup();
  h.intersect(true);
  assert.equal(h.requests.length, 0);
});
