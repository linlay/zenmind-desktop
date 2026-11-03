import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  WORK_PANEL_COLLAPSED_MAIN_GAP,
  WORK_PANEL_COLLAPSE_DRAG_BUFFER,
  WORK_PANEL_MAIN_MIN_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  clampWorkPanelWidth,
  normalizeStoredWorkPanelWidth,
  resolveDefaultWorkPanelWidth,
  resolveWorkPanelDragState,
  resolveWorkPanelMaxWidth,
  resolveWorkPanelWidthFromDrag,
} = require("../dist-electron/shared/work-panel-layout.js");

test("WorkPanel default width preserves the existing responsive clamp", () => {
  assert.equal(resolveDefaultWorkPanelWidth(800), WORK_PANEL_MIN_WIDTH);
  assert.equal(resolveDefaultWorkPanelWidth(1440), 605);
  assert.equal(resolveDefaultWorkPanelWidth(2000), 680);
});

test("WorkPanel width recovery rejects invalid values and enforces only its minimum", () => {
  assert.equal(normalizeStoredWorkPanelWidth("500", 540), 540);
  assert.equal(normalizeStoredWorkPanelWidth(Number.NaN, 540), 540);
  assert.equal(normalizeStoredWorkPanelWidth(200, 540), WORK_PANEL_MIN_WIDTH);
  assert.equal(normalizeStoredWorkPanelWidth(1200, 540), 1200);
});

test("WorkPanel snaps main chat from its minimum to the separator gap", () => {
  for (const availableWidth of [1000, 1400, 2200]) {
    const expandedMax = availableWidth - WORK_PANEL_MAIN_MIN_WIDTH;
    const collapsedMax = availableWidth - WORK_PANEL_COLLAPSED_MAIN_GAP;
    assert.equal(resolveWorkPanelMaxWidth(availableWidth), collapsedMax);
    assert.equal(clampWorkPanelWidth(expandedMax, availableWidth), expandedMax);
    assert.equal(clampWorkPanelWidth(expandedMax + 1, availableWidth), expandedMax);
    assert.equal(clampWorkPanelWidth(expandedMax + WORK_PANEL_COLLAPSE_DRAG_BUFFER - 1, availableWidth), expandedMax);
    assert.equal(clampWorkPanelWidth(expandedMax + WORK_PANEL_COLLAPSE_DRAG_BUFFER, availableWidth), collapsedMax);
    for (const extraDrag of [1, 48, 95, 96, 120]) {
      assert.equal(resolveWorkPanelWidthFromDrag({
        initialWidth: expandedMax - 20,
        startClientX: 500,
        currentClientX: 500 - 20 - extraDrag,
        availableWidth,
      }), extraDrag < WORK_PANEL_COLLAPSE_DRAG_BUFFER ? expandedMax : collapsedMax);
    }
    assert.equal(clampWorkPanelWidth(availableWidth + 100, availableWidth), collapsedMax);
    assert.equal(resolveWorkPanelWidthFromDrag({
      initialWidth: collapsedMax,
      startClientX: 0,
      currentClientX: 16,
      availableWidth,
    }), expandedMax);
  }
});

test("dragging the separator left grows WorkPanel and dragging right shrinks it", () => {
  assert.equal(resolveWorkPanelWidthFromDrag({
    initialWidth: 500,
    startClientX: 600,
    currentClientX: 550,
  }), 550);
  assert.equal(resolveWorkPanelWidthFromDrag({
    initialWidth: 500,
    startClientX: 600,
    currentClientX: 650,
  }), 450);
  assert.equal(resolveWorkPanelWidthFromDrag({
    initialWidth: 500,
    startClientX: 600,
    currentClientX: 0,
    availableWidth: 1000,
  }), 994);
  assert.equal(resolveWorkPanelWidthFromDrag({
    initialWidth: 500,
    startClientX: 600,
    currentClientX: 1000,
  }), WORK_PANEL_MIN_WIDTH);
});

test("Main Chat fades in four steps through the collapse buffer and recovers when dragging back", () => {
  for (const availableWidth of [1000, 1400, 2200]) {
    const expandedMax = availableWidth - WORK_PANEL_MAIN_MIN_WIDTH;
    const initialWidth = expandedMax - 20;
    const drag = (extra) => resolveWorkPanelDragState({
      initialWidth, startClientX: 500, currentClientX: 500 - 20 - extra, availableWidth,
    });
    assert.equal(drag(-20).mainChatOpacity, 1);
    for (const [extra, opacity] of [[0, 1], [1, 1], [23, 1], [24, 0.8], [47, 0.8], [48, 0.6], [71, 0.6], [72, 0.4], [95, 0.4], [96, 0.2], [120, 0.2], [48, 0.6], [0, 1], [-20, 1]]) {
      const state = drag(extra);
      const collapsedWidth = availableWidth - WORK_PANEL_COLLAPSED_MAIN_GAP;
      assert.equal(state.width, expandedMax + extra);
      assert.equal(state.mainChatOpacity, opacity);
      assert.equal(state.settledWidth, extra < WORK_PANEL_COLLAPSE_DRAG_BUFFER ? expandedMax + Math.min(0, extra) : collapsedWidth);
    }
  }
  for (const availableWidth of [undefined, 0, Number.NaN, 800]) {
    assert.equal(resolveWorkPanelDragState({
      initialWidth: 500, startClientX: 600, currentClientX: 0, availableWidth,
    }).mainChatOpacity, 1);
  }
});

test("a fully collapsed Main Chat restores through the same four steps before committing the split", () => {
  for (const availableWidth of [1000, 1400, 2200]) {
    const collapsedWidth = availableWidth - WORK_PANEL_COLLAPSED_MAIN_GAP;
    const expandedMax = availableWidth - WORK_PANEL_MAIN_MIN_WIDTH;
    const drag = distance => resolveWorkPanelDragState({
      initialWidth: collapsedWidth, startClientX: 10, currentClientX: 10 + distance, availableWidth,
    });
    for (const [distance, opacity] of [[-24, 0.2], [0, 0.2], [1, 0.2], [23, 0.2], [24, 0.4], [47, 0.4], [48, 0.6], [71, 0.6], [72, 0.8], [95, 0.8], [96, 1], [120, 1], [48, 0.6], [0, 0.2]]) {
      const result = drag(distance);
      assert.equal(result.mainChatOpacity, opacity);
      assert.equal(result.width, collapsedWidth - Math.max(0, distance));
      assert.equal(result.settledWidth, distance < 96 ? collapsedWidth : expandedMax);
    }
  }
});

test("the panel boundary follows pointer movement one-to-one throughout covering and uncovering", () => {
  for (const availableWidth of [1000, 1400, 2200]) {
    const expandedWidth = availableWidth - WORK_PANEL_MAIN_MIN_WIDTH;
    const collapsedWidth = availableWidth - WORK_PANEL_COLLAPSED_MAIN_GAP;
    const travel = collapsedWidth - expandedWidth;
    for (let distance = 0; distance <= travel; distance++) {
      const opening = resolveWorkPanelDragState({ initialWidth: collapsedWidth, startClientX: 10, currentClientX: 10 + distance, availableWidth });
      const closing = resolveWorkPanelDragState({ initialWidth: expandedWidth, startClientX: 10, currentClientX: 10 - distance, availableWidth });
      assert.equal(opening.width, collapsedWidth - distance);
      assert.equal(closing.width, expandedWidth + distance);
    }
  }
  for (const [distance, width] of [[1, 993], [24, 970], [48, 946], [72, 922], [96, 898]]) {
    assert.equal(resolveWorkPanelDragState({ initialWidth: 994, startClientX: 0, currentClientX: distance, availableWidth: 1000 }).width, width);
  }
});
