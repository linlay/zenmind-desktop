import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
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

test("WorkPanel has no fixed maximum and always leaves the main chat minimum", () => {
  const availableWidth = 1000;
  const maxWidth = resolveWorkPanelMaxWidth(availableWidth);
  assert.equal(maxWidth, availableWidth - WORK_PANEL_MAIN_MIN_WIDTH);
  assert.equal(clampWorkPanelWidth(720, availableWidth), maxWidth);
  assert.equal(resolveWorkPanelMaxWidth(1400), 1400 - WORK_PANEL_MAIN_MIN_WIDTH);
  assert.equal(resolveWorkPanelMaxWidth(2200), 2200 - WORK_PANEL_MAIN_MIN_WIDTH);
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
  }), 580);
  assert.equal(resolveWorkPanelWidthFromDrag({
    initialWidth: 500,
    startClientX: 600,
    currentClientX: 1000,
  }), WORK_PANEL_MIN_WIDTH);
});
