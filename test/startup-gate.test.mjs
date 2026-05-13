import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getStartupBlockingService,
  isStartupServiceWaiting,
  resolveStartupRootPath,
  shouldAutoOpenAssistant,
  shouldShowStartupProgressCard
} = require("../dist-electron/shared/startup-gate.js");

test("startup gate treats only not-installed and stopped as waiting states", () => {
  assert.equal(isStartupServiceWaiting(null), true);
  assert.equal(isStartupServiceWaiting({ status: "not-installed" }), true);
  assert.equal(isStartupServiceWaiting({ status: "stopped" }), true);
  assert.equal(isStartupServiceWaiting({ status: "initialization-required" }), false);
  assert.equal(isStartupServiceWaiting({ status: "config-required" }), false);
  assert.equal(isStartupServiceWaiting({ status: "dependency-missing" }), false);
  assert.equal(isStartupServiceWaiting({ status: "error" }), false);
});

test("startup gate redirects to control center when a startup service is blocked", () => {
  const blocked = getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "dependency-missing" },
    { id: "agent-webclient", status: "stopped" }
  ], false);

  assert.ok(blocked);
  assert.equal(blocked.id, "agent-platform");
});

test("startup gate keeps waiting while services are still loading or starting", () => {
  assert.equal(getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "stopped" }
  ], true), null);

  assert.equal(getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "not-installed" },
    null
  ], false), null);
});

test("startup gate shows the bootstrap progress card until the bootstrap flow is truly done", () => {
  assert.equal(shouldShowStartupProgressCard(null, false), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "restore", phase: "running" }, false), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "running" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "failed" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "succeeded" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "succeeded" }, true), false);
});

test("startup gate routes root traffic to control center during bootstrap and agent webclient otherwise", () => {
  assert.equal(resolveStartupRootPath(null, false), null);
  assert.equal(resolveStartupRootPath({ mode: "bootstrap", phase: "running" }, false), "/control-center");
  assert.equal(resolveStartupRootPath({ mode: "bootstrap", phase: "succeeded" }, true), "/plugin/agent-webclient");
  assert.equal(resolveStartupRootPath({ mode: "restore", phase: "running" }, false), "/plugin/agent-webclient");
});

test("startup gate only auto-opens the assistant after bootstrap succeeds", () => {
  assert.equal(shouldAutoOpenAssistant(null, false), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "restore", phase: "succeeded" }, true), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "running" }, true), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "succeeded" }, true), true);
});
