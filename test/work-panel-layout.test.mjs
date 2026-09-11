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
    }), expandedMax - 16);
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
