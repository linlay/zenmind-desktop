import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  createProjectAgentOrderPlan,
  validateProjectAgentOrderRequestKeys,
} = require("../dist-electron/main/assistant/core/project-agent-order.js");

test("project order replaces only current Project slots in the valid Agent catalog", () => {
  const plan = createProjectAgentOrderPlan({
    requestedProjectAgentKeys: ["kbase-b", "coder-a"],
    currentProjectAgentKeys: ["coder-a", "kbase-b"],
    fullAgentKeys: ["chat-a", "coder-a", "hidden-agent", "kbase-b"],
  });

  assert.deepEqual(plan.projectAgentKeys, ["kbase-b", "coder-a"]);
  assert.deepEqual(plan.fullAgentKeys, [
    "chat-a",
    "kbase-b",
    "hidden-agent",
    "coder-a",
  ]);
});

test("project order appends concurrently created Projects omitted by the renderer", () => {
  const plan = createProjectAgentOrderPlan({
    requestedProjectAgentKeys: ["kbase-b", "coder-a"],
    currentProjectAgentKeys: ["coder-a", "coder-new", "kbase-b"],
    fullAgentKeys: ["coder-a", "chat-a", "coder-new", "kbase-b"],
  });

  assert.deepEqual(plan.projectAgentKeys, ["kbase-b", "coder-a", "coder-new"]);
  assert.deepEqual(plan.fullAgentKeys, ["kbase-b", "chat-a", "coder-a", "coder-new"]);
});

test("project order rejects duplicate, stale, non-Project, and missing catalog keys", () => {
  assert.throws(
    () => validateProjectAgentOrderRequestKeys(["coder-a", "coder-a"]),
    /duplicate agent keys/u,
  );
  assert.throws(
    () => createProjectAgentOrderPlan({
      requestedProjectAgentKeys: ["chat-a"],
      currentProjectAgentKeys: ["coder-a"],
      fullAgentKeys: ["chat-a", "coder-a"],
    }),
    /no longer available: chat-a/u,
  );
  assert.throws(
    () => createProjectAgentOrderPlan({
      requestedProjectAgentKeys: ["deleted-project"],
      currentProjectAgentKeys: ["coder-a"],
      fullAgentKeys: ["coder-a"],
    }),
    /no longer available: deleted-project/u,
  );
  assert.throws(
    () => createProjectAgentOrderPlan({
      requestedProjectAgentKeys: ["coder-a"],
      currentProjectAgentKeys: ["coder-a", "missing-project"],
      fullAgentKeys: ["coder-a"],
    }),
    /missing from the valid Agent catalog: missing-project/u,
  );
});

test("project order validates non-empty bounded request keys", () => {
  assert.throws(() => validateProjectAgentOrderRequestKeys([]), /must not be empty/u);
  assert.throws(
    () => validateProjectAgentOrderRequestKeys(
      Array.from(
        { length: __testInternals.MAX_PROJECT_ORDER_ITEMS + 1 },
        (_item, index) => `project-${index}`,
      ),
    ),
    /supported item limit/u,
  );
});
