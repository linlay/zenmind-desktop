import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SIDEBAR_AUTO_COLLAPSE_THRESHOLD,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_MAX_WIDTH,
  SIDEBAR_EXPANDED_MIN_WIDTH,
  clampSidebarExpandedWidth,
  normalizeSidebarLayoutState,
  resolveRenderedSidebarWidth,
  resolveSidebarLayoutStateFromDrag,
  toggleSidebarLayoutState
} = require("../dist-electron/shared/sidebar-layout.js");

test("sidebar layout normalizes legacy storage into the new state shape", () => {
  assert.equal(SIDEBAR_EXPANDED_MIN_WIDTH, 280);
  assert.deepEqual(normalizeSidebarLayoutState(null), {
    mode: "expanded",
    expandedWidth: SIDEBAR_EXPANDED_MIN_WIDTH
  });

  assert.deepEqual(normalizeSidebarLayoutState({
    collapsed: true,
    width: 120
  }), {
    mode: "collapsed",
    expandedWidth: SIDEBAR_EXPANDED_MIN_WIDTH
  });

  assert.deepEqual(normalizeSidebarLayoutState({
    mode: "expanded",
    expandedWidth: 999
  }), {
    mode: "expanded",
    expandedWidth: SIDEBAR_EXPANDED_MAX_WIDTH
  });
});

test("sidebar width clamps at the minimum before it auto-collapses", () => {
  const expandedState = {
    mode: "expanded",
    expandedWidth: SIDEBAR_EXPANDED_MIN_WIDTH
  };

  assert.equal(clampSidebarExpandedWidth(20), SIDEBAR_EXPANDED_MIN_WIDTH);
  assert.equal(clampSidebarExpandedWidth(999), SIDEBAR_EXPANDED_MAX_WIDTH);

  assert.deepEqual(resolveSidebarLayoutStateFromDrag({
    initialState: expandedState,
    deltaX: -(SIDEBAR_EXPANDED_MIN_WIDTH - SIDEBAR_AUTO_COLLAPSE_THRESHOLD - 1)
  }), expandedState);

  assert.deepEqual(resolveSidebarLayoutStateFromDrag({
    initialState: expandedState,
    deltaX: -SIDEBAR_AUTO_COLLAPSE_THRESHOLD
  }), {
    mode: "collapsed",
    expandedWidth: SIDEBAR_EXPANDED_MIN_WIDTH
  });
});

test("sidebar collapse preserves the last expanded width for button restore", () => {
  const collapsedState = {
    mode: "collapsed",
    expandedWidth: 240
  };

  assert.equal(resolveRenderedSidebarWidth(collapsedState), SIDEBAR_COLLAPSED_WIDTH);
  assert.deepEqual(toggleSidebarLayoutState(collapsedState), {
    mode: "expanded",
    expandedWidth: 240
  });
  assert.deepEqual(resolveSidebarLayoutStateFromDrag({
    initialState: collapsedState,
    deltaX: 24
  }), {
    mode: "expanded",
    expandedWidth: SIDEBAR_EXPANDED_MIN_WIDTH + 24
  });
});
