import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/renderer/app-shell/windowDragClickTracker.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { createWindowDragClickTracker } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const origin = { screenX: 1920, screenY: 100 };
const offset = (x, y = 0) => ({ screenX: origin.screenX + x, screenY: origin.screenY + y });
const lane = {};

function click(tracker, count, { target = lane, moves = [], release = origin } = {}) {
  tracker.begin(target, origin);
  for (const point of moves) tracker.move(point);
  tracker.release(release);
  return tracker.click(target, count);
}

test("two native clicks toggle once; a third click does not toggle again", () => {
  const tracker = createWindowDragClickTracker();
  assert.equal(click(tracker, 1), false);
  assert.equal(click(tracker, 2), true);
  assert.equal(click(tracker, 3), false);
  assert.equal(click(tracker, 1), false);
  assert.equal(click(tracker, 2), true);
});

test("separate native single clicks and keyboard/programmatic clicks do not maximize", () => {
  const tracker = createWindowDragClickTracker();
  assert.equal(click(tracker, 1), false);
  assert.equal(click(tracker, 1), false);
  assert.equal(click(tracker, 0), false);
  assert.equal(tracker.click(lane, 2), false);
});

test("a drag in either press invalidates the double click, even after moving back", () => {
  for (const draggedClick of [1, 2]) {
    const tracker = createWindowDragClickTracker();
    for (const count of [1, 2]) {
      assert.equal(click(tracker, count, {
        moves: count === draggedClick ? [offset(24), origin] : [],
      }), false);
    }
  }
});

test("release coordinates catch movement without an intervening pointermove", () => {
  const tracker = createWindowDragClickTracker();
  click(tracker, 1);
  assert.equal(click(tracker, 2, { release: offset(20) }), false);
});

test("small hand jitter is allowed in both clicks", () => {
  const tracker = createWindowDragClickTracker();
  assert.equal(click(tracker, 1, { moves: [offset(1, 1)], release: offset(2, 1) }), false);
  assert.equal(click(tracker, 2, { moves: [offset(-2, -1)], release: offset(-1, -1) }), true);
});

test("clicks on different drag regions cannot combine into a maximize gesture", () => {
  const tracker = createWindowDragClickTracker();
  click(tracker, 1);
  assert.equal(click(tracker, 2, { target: {} }), false);
});

test("cancel, blur, blocked controls and touch reset the previous click", () => {
  const tracker = createWindowDragClickTracker();
  click(tracker, 1);
  tracker.reset();
  assert.equal(click(tracker, 2), false);
  click(tracker, 1);
  tracker.begin(lane, origin);
  tracker.reset();
  tracker.release(origin);
  assert.equal(tracker.click(lane, 2), false);
});

test("a press must finish on the same region before it can count as a click", () => {
  const tracker = createWindowDragClickTracker();
  click(tracker, 1);
  tracker.begin(lane, origin);
  assert.equal(tracker.click(lane, 2), false);
  click(tracker, 1);
  tracker.begin(lane, origin);
  tracker.release(origin);
  assert.equal(tracker.click({}, 2), false);
});
