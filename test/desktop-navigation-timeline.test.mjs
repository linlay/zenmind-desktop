import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  "src",
  "renderer",
  "app-shell",
  "navigation",
  "desktopNavigationTimeline.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
});
const mod = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", outputText)(
  mod.exports,
  require,
  mod,
  sourcePath,
  path.dirname(sourcePath),
);

const {
  createDesktopNavigationTimeline,
  findDesktopNavigationEntry,
  recordDesktopNavigation,
  recordDesktopNavigationSidebarMode,
  resolveDesktopNavigationStep,
} = mod.exports;

// position null exercises the fallback used when the router history does not expose its index.
function entry(key, route, sidebarMode = "primary", position = null) {
  return { key, route, sidebarMode, position };
}

function visit(timeline, steps) {
  return steps.reduce(
    (current, [type, key, route, sidebarMode, position]) =>
      recordDesktopNavigation(current, type, entry(key, route, sidebarMode, position)),
    timeline,
  );
}

test("a push and a replace committed in one batch still count as one new visit", () => {
  // The router history is [/kanban, /market, /webs/demo]; only the final REPLACE was observed.
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban", "primary", 0)), [
    ["PUSH", "k1", "/market", "capabilities", 1],
    ["REPLACE", "k3", "/webs/demo", "primary", 2],
  ]);

  assert.deepEqual(timeline.entries.map((item) => item.route), ["/kanban", "/market", "/webs/demo"]);
  const back = resolveDesktopNavigationStep(timeline, "back");
  assert.equal(back.delta, -1);
  assert.equal(back.entry.key, "k1");

  const returned = visit(timeline, [["POP", "k1", "/market", "capabilities", 1]]);
  assert.equal(returned.index, 1);
  assert.equal(resolveDesktopNavigationStep(returned, "back").entry.route, "/kanban");
  assert.equal(resolveDesktopNavigationStep(returned, "forward").entry.route, "/webs/demo");
});

test("unobserved history entries are stepped over by router position and stale forward records are dropped", () => {
  let timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban", "primary", 0)), [
    ["PUSH", "k1", "/market", "capabilities", 1],
    ["PUSH", "k2", "/help", "capabilities", 2],
    ["POP", "default", "/kanban", "primary", 0],
  ]);
  // Two pushes in one batch: position 1 was replaced by an entry that was never observed.
  timeline = visit(timeline, [["PUSH", "k4", "/settings/general", "settings", 2]]);

  assert.deepEqual(timeline.entries.map((item) => item.key), ["default", "k4"]);
  assert.equal(resolveDesktopNavigationStep(timeline, "back").delta, -2);
  assert.equal(resolveDesktopNavigationStep(timeline, "forward"), null);
});

test("a replace at the current position keeps the forward branch", () => {
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban", "primary", 0)), [
    ["PUSH", "k1", "/settings/webapps?webappId=a", "settings", 1],
    ["PUSH", "k2", "/help", "capabilities", 2],
    ["POP", "k1", "/settings/webapps?webappId=a", "settings", 1],
    ["REPLACE", "k5", "/settings/webapps?webappId=b", "settings", 1],
  ]);

  assert.deepEqual(timeline.entries.map((item) => item.key), ["default", "k5", "k2"]);
  assert.equal(timeline.index, 1);
  assert.equal(resolveDesktopNavigationStep(timeline, "forward").delta, 1);
});

test("every pushed location is recorded in visit order, whichever entry point navigated", () => {
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/market", "capabilities"],
    ["PUSH", "k2", "/agents?agentKey=demo", "capabilities"],
  ]);

  assert.deepEqual(timeline.entries.map((item) => item.route), ["/kanban", "/market", "/agents?agentKey=demo"]);
  const back = resolveDesktopNavigationStep(timeline, "back");
  assert.equal(back.delta, -1);
  assert.equal(back.entry.route, "/market");
  assert.equal(resolveDesktopNavigationStep(timeline, "forward"), null);
});

test("a new visit after going back drops the old forward branch", () => {
  let timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/market"],
    ["PUSH", "k2", "/help"],
    ["POP", "k1", "/market"],
  ]);
  assert.equal(resolveDesktopNavigationStep(timeline, "forward").entry.route, "/help");

  timeline = visit(timeline, [["PUSH", "k3", "/settings/general", "settings"]]);
  assert.deepEqual(timeline.entries.map((item) => item.key), ["default", "k1", "k3"]);
  assert.equal(resolveDesktopNavigationStep(timeline, "forward"), null);
});

test("history moves made by a page's own back button keep the controls in sync", () => {
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/service/demo"],
    ["POP", "default", "/kanban"],
  ]);

  assert.equal(timeline.index, 0);
  assert.equal(resolveDesktopNavigationStep(timeline, "back"), null);
  assert.equal(resolveDesktopNavigationStep(timeline, "forward").entry.route, "/service/demo");
});

test("replace merges into the current record", () => {
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/agent/demo?newChat=1700000000000"],
    ["REPLACE", "k2", "/agent/demo?chatId=chat-1"],
  ]);

  assert.deepEqual(timeline.entries.map((item) => item.route), ["/kanban", "/agent/demo?chatId=chat-1"]);
  assert.equal(timeline.index, 1);
});

test("the sidebar mode in use is kept per record and survives back and forward", () => {
  let timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/agents", "primary"],
  ]);
  timeline = recordDesktopNavigationSidebarMode(timeline, "k1", "capabilities");
  timeline = visit(timeline, [
    ["PUSH", "k2", "/kanban", "primary"],
    ["POP", "k1", "/agents", "primary"],
  ]);

  assert.equal(findDesktopNavigationEntry(timeline, "k1").sidebarMode, "capabilities");
  assert.equal(recordDesktopNavigationSidebarMode(timeline, "other", "settings"), timeline);
});

test("adjacent records of the same route are skipped instead of producing a dead click", () => {
  const timeline = visit(createDesktopNavigationTimeline(entry("default", "/kanban")), [
    ["PUSH", "k1", "/settings/about", "settings"],
    ["PUSH", "k2", "/settings/debug", "settings"],
    ["REPLACE", "k3", "/settings/about", "settings"],
  ]);

  const back = resolveDesktopNavigationStep(timeline, "back");
  assert.equal(back.delta, -2);
  assert.equal(back.entry.route, "/kanban");
});

test("unobserved router history starts a new timeline and repeated keys are ignored", () => {
  const timeline = createDesktopNavigationTimeline(entry("default", "/kanban"));
  assert.equal(recordDesktopNavigation(timeline, "PUSH", entry("default", "/kanban")), timeline);

  const reset = recordDesktopNavigation(timeline, "POP", entry("unknown", "/market"));
  assert.deepEqual(reset.entries.map((item) => item.key), ["unknown"]);
  assert.equal(resolveDesktopNavigationStep(reset, "back"), null);
});
