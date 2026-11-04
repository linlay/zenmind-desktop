import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { ChromeWorkerEngine } = require("../dist-electron/main/modules/browser-use/chrome-worker-engine.js");
const metricKeys = ["snapshotMs", "stateMs", "viewportMs", "metadataMs", "projectionMs", "totalMs",
  "referenceCount", "fieldCount", "fieldReadCount", "fieldResolvedCount", "completed"].sort();

function fixture(t, nodes, onMetrics) {
  const page = new EventEmitter();
  Object.assign(page, { isClosed: () => false, mainFrame: () => ({ evaluate: async () => ({ width: 800, height: 600 }) }) });
  const tab = { desktopPageId: "owned-metric-page", page, modalStates: () => [],
    captureSnapshot: async () => ({ ariaSnapshotJSON: nodes }),
    targetLocator: async ({ target }) => ({ locator: { evaluate: async () => target === "e2"
      ? { tag: "input", sensitive: true, secretValue: "SYNTHETIC_PRIVATE_FIELD" }
      : { tag: "input", sensitive: false, value: "public value" } } }),
  };
  const controller = {
    run: async (_pageId, operation) => operation(tab),
    describe: async () => ({ pageId: tab.desktopPageId, url: "https://fixture.test/private-path", title: "Private title", active: true }),
  };
  const engine = new ChromeWorkerEngine(undefined, { onObservationMetrics: onMetrics });
  t.after(() => engine.disconnect());
  return { engine, tab, controller };
}

test("internal observation metrics contain numeric phase costs and counts without page data, and cannot fail the action", async t => {
  const metrics = [];
  const f = fixture(t, [
    { role: "heading", name: "SYNTHETIC_PRIVATE_FIELD", ref: "e0" },
    { role: "textbox", name: "Visible", ref: "e1" },
    { role: "textbox", name: "Secret", ref: "e2" },
  ], value => { metrics.push(value); throw new Error("Synthetic diagnostic consumer failure"); });
  const observation = await f.engine.observe(f.controller, f.tab.desktopPageId, {});
  assert.equal(observation.text.includes("SYNTHETIC_PRIVATE_FIELD"), false);
  assert.equal(metrics.length, 1);
  const result = metrics[0];
  assert.deepEqual(Object.keys(result).sort(), metricKeys);
  assert.ok(Object.values(result).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0));
  assert.equal(result.completed, 1);
  assert.equal(result.referenceCount, 3);
  assert.equal(result.fieldCount, 2);
  assert.equal(result.fieldReadCount, 2);
  assert.equal(result.fieldResolvedCount, 2);
  assert.equal(Object.isFrozen(result), true);
  assert.equal("metrics" in observation, false, "measurement never becomes part of the public tool result");
});

test("metrics distinguish scanned candidates from the bounded metadata reads", async t => {
  const metrics = [];
  const nodes = Array.from({ length: 300 }, (_, index) => ({ role: "button", name: `Action ${index}`, ref: `e${index}` }));
  const f = fixture(t, nodes, value => metrics.push(value));
  await f.engine.observe(f.controller, f.tab.desktopPageId, {});
  assert.equal(metrics[0].referenceCount, 300);
  assert.equal(metrics[0].fieldCount, 300);
  assert.equal(metrics[0].fieldReadCount, 256);
  assert.equal(metrics[0].fieldResolvedCount, 256);
});

test("a timed-out observation publishes one failed measurement immediately and late completion cannot rewrite it", async t => {
  const metrics = [];
  const f = fixture(t, [], value => metrics.push(value));
  let release;
  f.tab.captureSnapshot = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(f.engine.captureTimed(f.controller, f.tab, {}, 20), { code: "observation_timeout" });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].completed, 0);
  assert.ok(metrics[0].totalMs > 0);
  assert.ok(metrics[0].snapshotMs > 0);
  const frozen = JSON.stringify(metrics[0]);
  release({ ariaSnapshotJSON: [] });
  await delay(10);
  assert.equal(metrics.length, 1);
  assert.equal(JSON.stringify(metrics[0]), frozen);
});
