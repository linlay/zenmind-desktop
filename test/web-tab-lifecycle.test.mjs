import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  closeWebTabFromOrder,
  selectSurvivingTabId
} = require("../dist-electron/shared/web-tab-lifecycle.js");

test("web tab close transition preserves inactive selection and prefers the left neighbor", () => {
  assert.deepEqual(closeWebTabFromOrder(
    ["one", "two", "three", "four"],
    "three",
    "one"
  ), {
    closingIndex: 0,
    remainingTabIds: ["two", "three", "four"],
    activeTabId: "three"
  });
  assert.deepEqual(closeWebTabFromOrder(
    ["one", "two", "three", "four"],
    "three",
    "three"
  ), {
    closingIndex: 2,
    remainingTabIds: ["one", "two", "four"],
    activeTabId: "two"
  });
  assert.equal(selectSurvivingTabId(["one", "two"], ["two"], "one"), "two");
  assert.equal(selectSurvivingTabId(["one"], [], "one"), null);
});

test("web tab close transition closes seven tabs without leaving a detached active id", () => {
  let tabIds = Array.from({ length: 7 }, (_value, index) => `coworker-${index + 1}`);
  let activeTabId = "coworker-4";
  const closeOrder = [
    "coworker-2",
    "coworker-4",
    "coworker-7",
    "coworker-1",
    "coworker-5",
    "coworker-3",
    "coworker-6"
  ];

  for (const closingTabId of closeOrder) {
    const transition = closeWebTabFromOrder(tabIds, activeTabId, closingTabId);
    assert.ok(transition);
    tabIds = transition.remainingTabIds;
    activeTabId = transition.activeTabId;
    assert.equal(activeTabId === null || tabIds.includes(activeTabId), true);
  }
  assert.deepEqual(tabIds, []);
  assert.equal(activeTabId, null);
});
