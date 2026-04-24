import test from "node:test";
import assert from "node:assert/strict";
import {
  getStartupBlockingService,
  isStartupServiceWaiting
} from "../dist-electron/shared/startup-gate.js";

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
