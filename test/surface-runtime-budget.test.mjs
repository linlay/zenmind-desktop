import assert from "node:assert/strict";
import test from "node:test";

const {
  SURFACE_RUNTIME_INACTIVE_TTL_MS,
  createSurfaceRuntimeBudgetState,
  reconcileSurfaceRuntimeBudget,
} = await import("../dist-electron/shared/surface-runtime-budget.js");

function reconcile(state, candidates, now, options) {
  return reconcileSurfaceRuntimeBudget(state, candidates, now, options);
}

test("surface runtime budget keeps active and protected guests awake", () => {
  let state = createSurfaceRuntimeBudgetState();
  ({ state } = reconcile(state, [
    { key: "active", active: true },
    { key: "protected", active: false, protectedFromSleep: true },
  ], 0));

  const result = reconcile(state, [
    { key: "active", active: true },
    { key: "protected", active: false, protectedFromSleep: true },
  ], SURFACE_RUNTIME_INACTIVE_TTL_MS * 2);

  assert.deepEqual(result.sleepKeys, []);
  assert.deepEqual(Object.keys(result.state.entries).sort(), ["active", "protected"]);
});

test("surface runtime budget sleeps inactive guests after five minutes", () => {
  let state = createSurfaceRuntimeBudgetState();
  ({ state } = reconcile(state, [{ key: "old", active: true }], 1_000));
  ({ state } = reconcile(state, [{ key: "old", active: false }], 2_000));

  const beforeTtl = reconcile(
    state,
    [{ key: "old", active: false }],
    2_000 + SURFACE_RUNTIME_INACTIVE_TTL_MS - 1,
  );
  assert.deepEqual(beforeTtl.sleepKeys, []);

  const atTtl = reconcile(
    beforeTtl.state,
    [{ key: "old", active: false }],
    2_000 + SURFACE_RUNTIME_INACTIVE_TTL_MS,
  );
  assert.deepEqual(atTtl.sleepKeys, ["old"]);
});

test("surface runtime budget enforces six inactive guests with LRU eviction", () => {
  let state = createSurfaceRuntimeBudgetState();
  for (let index = 0; index < 7; index += 1) {
    const key = `guest-${index}`;
    ({ state } = reconcile(
      state,
      [
        ...Object.keys(state.entries).map((entryKey) => ({ key: entryKey, active: false })),
        { key, active: true },
      ],
      1_000 + index,
      { maxInactiveGuests: 100 },
    ));
    ({ state } = reconcile(
      state,
      Object.keys(state.entries).map((entryKey) => ({ key: entryKey, active: false })),
      2_000 + index,
      { maxInactiveGuests: 100 },
    ));
  }

  const result = reconcile(
    state,
    Object.keys(state.entries).map((key) => ({ key, active: false })),
    3_000,
  );
  assert.deepEqual(result.sleepKeys, ["guest-0"]);
  assert.equal(Object.keys(result.state.entries).length, 6);
});

test("surface runtime budget re-enters LRU after protection is released", () => {
  let state = createSurfaceRuntimeBudgetState();
  ({ state } = reconcile(
    state,
    [{ key: "media", active: false, protectedFromSleep: true }],
    0,
  ));
  ({ state } = reconcile(
    state,
    [{ key: "media", active: false, protectedFromSleep: true }],
    SURFACE_RUNTIME_INACTIVE_TTL_MS,
  ));

  const released = reconcile(
    state,
    [{ key: "media", active: false, protectedFromSleep: false }],
    SURFACE_RUNTIME_INACTIVE_TTL_MS + 1,
  );
  assert.deepEqual(released.sleepKeys, ["media"]);
});
