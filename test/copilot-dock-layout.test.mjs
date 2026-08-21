import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  COPILOT_DOCK_DEFAULT_WIDTH,
  COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH,
  COPILOT_DOCK_MAIN_MIN_WIDTH,
  COPILOT_DOCK_MAX_WIDTH,
  COPILOT_DOCK_MIN_WIDTH,
  clampCopilotDockWidth,
  normalizeStoredCopilotDockWidth,
  resolveCopilotDockMaxWidth,
  resolveCopilotDockWidthFromDrag,
  resolveRenderedCopilotDockWidth,
  shouldOverlayCopilotDock,
} = require("../dist-electron/shared/copilot-dock-layout.js");

test("Copilot Dock width recovery uses the default and hard bounds", () => {
  assert.equal(normalizeStoredCopilotDockWidth("500"), COPILOT_DOCK_DEFAULT_WIDTH);
  assert.equal(normalizeStoredCopilotDockWidth(Number.NaN), COPILOT_DOCK_DEFAULT_WIDTH);
  assert.equal(normalizeStoredCopilotDockWidth(120), COPILOT_DOCK_MIN_WIDTH);
  assert.equal(normalizeStoredCopilotDockWidth(900), COPILOT_DOCK_MAX_WIDTH);
});

test("Copilot Dock keeps at least 800px for main content while docked", () => {
  assert.equal(resolveCopilotDockMaxWidth(2000), COPILOT_DOCK_MAX_WIDTH);
  assert.equal(resolveCopilotDockMaxWidth(1400), 600);
  assert.equal(
    resolveCopilotDockMaxWidth(COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH),
    COPILOT_DOCK_MIN_WIDTH,
  );
  assert.equal(
    clampCopilotDockWidth(640, 1400) + COPILOT_DOCK_MAIN_MIN_WIDTH,
    1400,
  );
});

test("Copilot Dock switches to overlay mode below the docked minimum", () => {
  assert.equal(shouldOverlayCopilotDock(COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH), false);
  assert.equal(shouldOverlayCopilotDock(COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH - 1), true);
  assert.equal(shouldOverlayCopilotDock(undefined), false);
  assert.equal(
    resolveRenderedCopilotDockWidth(520, COPILOT_DOCK_DOCKED_MIN_AVAILABLE_WIDTH - 1),
    520,
  );
});

test("dragging left grows Copilot Dock and dragging right shrinks it", () => {
  assert.equal(resolveCopilotDockWidthFromDrag({
    initialWidth: 360,
    startClientX: 800,
    currentClientX: 720,
  }), 440);
  assert.equal(resolveCopilotDockWidthFromDrag({
    initialWidth: 360,
    startClientX: 800,
    currentClientX: 900,
  }), COPILOT_DOCK_MIN_WIDTH);
  assert.equal(resolveCopilotDockWidthFromDrag({
    initialWidth: 600,
    startClientX: 800,
    currentClientX: 600,
  }), COPILOT_DOCK_MAX_WIDTH);
  assert.equal(resolveCopilotDockWidthFromDrag({
    initialWidth: 520,
    startClientX: 800,
    currentClientX: 700,
    availableWidth: 1300,
  }), 500);
});
