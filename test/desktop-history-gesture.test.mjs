import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const preloadUrl = new URL("../dist-electron/preload/desktop-history-gesture.js", import.meta.url);
const source = readFileSync(preloadUrl, "utf8");
const require = createRequire(preloadUrl);
class Element {
  constructor({ editing = false, overflowX = "visible", scrollWidth = 100, clientWidth = 100 } = {}) {
    Object.assign(this, { editing, overflowX, scrollWidth, clientWidth });
  }
  matches() { return this.editing; }
}

function fixture({ platform = "darwin", isMainFrame = true } = {}) {
  const sent = [];
  const listeners = [];
  const exports = {};
  runInNewContext(source, {
    exports, Element, performance, document: { scrollingElement: null },
    process: { platform, isMainFrame },
    window: {
      getComputedStyle: node => ({ overflowX: node.overflowX }),
      addEventListener: (...args) => listeners.push(args),
    },
    require: name => name === "electron" ? { ipcRenderer: { send: (...args) => sent.push(args) } } : require(name),
  });
  exports.installDesktopHistoryGesture();
  const directions = [];
  const updates = [];
  const handler = exports.createDesktopHistoryWheelHandler(sample => {
    updates.push(sample ? JSON.parse(JSON.stringify(sample)) : null);
    if (sample?.committed) directions.push(sample.direction);
  });
  let clock = 1000;
  function wheel(deltaX, overrides = {}, gap = 16) {
    clock += gap;
    handler({
      deltaX, deltaY: 0, deltaMode: 0, isTrusted: true, cancelable: true,
      composedPath: () => [], ...overrides,
    }, clock);
  }
  return { wheel, directions, updates, listeners };
}

test("two-finger horizontal sequences navigate once, ignore inertia and restart after idle", () => {
  const { wheel, directions } = fixture();
  wheel(-65); wheel(-65);
  for (let index = 0; index < 12; index += 1) wheel(-20);
  assert.deepEqual(directions.filter(Boolean), ["back"]);
  wheel(65, {}, 321); wheel(65);
  assert.deepEqual(directions.filter(Boolean), ["back", "forward"]);
});

test("a small first sample previews immediately and navigation waits for the distance threshold", () => {
  const { wheel, directions, updates } = fixture();
  wheel(-2, { cancelable: false });
  assert.equal(updates[0].direction, "back");
  assert.ok(updates[0].progress > 0 && updates[0].progress < 0.1);
  assert.equal(updates[0].committed, false);
  wheel(-50, { cancelable: false });
  wheel(-50, { cancelable: false });
  assert.deepEqual(directions, []);
  assert.ok(updates.at(-1).progress < 1);
  wheel(-18, { cancelable: false });
  assert.deepEqual(directions, ["back"]);
  assert.equal(updates.at(-1).progress, 1);
  assert.equal(updates.at(-1).committed, true);
});

test("reversing or turning vertical cancels the preview without navigating", () => {
  for (const next of [{ deltaX: 20 }, { deltaX: 0, deltaY: 40 }]) {
    const { wheel, directions, updates } = fixture();
    wheel(-20);
    wheel(next.deltaX, next);
    assert.equal(updates.at(-1), null);
    assert.deepEqual(directions, []);
  }
});

test("vertical, diagonal, modified, synthetic and discrete wheel scrolling do not navigate", () => {
  for (const overrides of [
    { deltaY: 80 }, { deltaY: 35 }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { shiftKey: true }, { deltaMode: 1 }, { isTrusted: false },
    { deltaX: Number.NaN },
  ]) {
    const { wheel, directions } = fixture();
    wheel(45, overrides);
    wheel(45, overrides);
    assert.deepEqual(directions, []);
  }
});

test("horizontal scrolling containers and editing surfaces keep their wheel events", () => {
  for (const element of [
    new Element({ overflowX: "auto", scrollWidth: 1000 }),
    new Element({ editing: true }),
  ]) {
    const { wheel, directions } = fixture();
    for (let index = 0; index < 5; index += 1) {
      wheel(45, { composedPath: () => [new Element(), element] });
    }
    assert.deepEqual(directions, []);
  }
});

test("a vertical gesture cannot become navigation halfway through, and short/reversed swipes cancel", () => {
  const vertical = fixture();
  vertical.wheel(1, { deltaY: 20 });
  vertical.wheel(100);
  assert.deepEqual(vertical.directions, []);
  const cancelled = fixture();
  cancelled.wheel(-25); cancelled.wheel(25);
  assert.deepEqual(cancelled.directions.filter(Boolean), []);
});

test("small initial samples and non-cancelable wheel sequences still navigate once", () => {
  for (const firstCancelable of [true, false]) {
    const { wheel, directions } = fixture();
    wheel(-2, { cancelable: firstCancelable });
    for (let index = 0; index < 10; index += 1) wheel(-12, { cancelable: false });
    assert.deepEqual(directions.filter(Boolean), ["back"]);
  }
});

test("only macOS top-frame preloads install a passive capture listener", () => {
  assert.equal(fixture({ platform: "win32" }).listeners.length, 0);
  assert.equal(fixture({ isMainFrame: false }).listeners.length, 0);
  const { listeners } = fixture();
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], "wheel");
  assert.equal(listeners[0][2].capture, true);
  assert.equal(listeners[0][2].passive, true);
});
