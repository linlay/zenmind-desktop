import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { beginPlatformLoadDiagnostic } = require("../dist-electron/main/modules/agent-platform/load-diagnostic.js");
const { createSessionController } = require("../dist-electron/main/modules/agent-platform/frame-port/session-controller.js");

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: slow load logs current stage and recovery once, without connection secrets`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    t.after(() => Object.defineProperty(process, "platform", descriptor));
    const logs = [];
    t.mock.method(console, "warn", (...args) => logs.push(args));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const diagnostic = beginPlatformLoadDiagnostic("/api/chat", () => ({
      phase: "reconnecting", generation: 2, reconnectCount: 1, token: "SECRET", key: { endpoint: "SECRET" },
    }));
    diagnostic.next("availability");
    t.mock.timers.tick(5000);
    assert.equal(logs[0][1].stage, "availability");
    assert.equal(logs[0][1].platform, platform);
    assert.equal(logs[0][1].connectionPhase, "reconnecting");
    diagnostic.next("broker-response");
    t.mock.timers.tick(20000);
    assert.equal(logs.length, 1);
    diagnostic.end("succeeded");
    diagnostic.end("failed");
    assert.equal(logs.length, 2);
    assert.equal(logs[1][1].status, "succeeded");
    assert.equal(logs[1][1].id, logs[0][1].id);
    assert.ok(!JSON.stringify(logs).includes("SECRET"));
  });
}

test("fast completion and cancellation clear watchdogs", (t) => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  beginPlatformLoadDiagnostic("/api/agents").end("succeeded");
  beginPlatformLoadDiagnostic("/api/chat").end("cancelled");
  t.mock.timers.tick(10000);
  assert.deepEqual(logs, []);
});

test("availability logs the failing stage without changing errors or exposing credentials", async (t) => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const error = new Error("SECRET token and path");
  const options = {
    app: {},
    browserSurfaces: {},
    realtimeBroker: {
      getConnectionState: () => ({ phase: "closed", key: null }),
    },
    getServiceState: async () => ({ status: "running", healthMeta: { webUrl: "http://127.0.0.1:7078" } }),
    issueAccessToken: async () => { throw error; },
  };
  await assert.rejects(createSessionController(options).availability(), (actual) => actual === error);
  assert.equal(logs[0][1].stage, "access-token");
  assert.equal(logs[0][1].serviceStatus, "running");
  assert.ok(!JSON.stringify(logs).includes("SECRET"));
  t.mock.timers.tick(10000);
  assert.equal(logs.length, 1);
});

test("locked PID reads remain read-only and emit bounded safe diagnostics", async (t) => {
  const fs = require("node:fs/promises");
  const { readBridgeManagedPid } = require("../dist-electron/main/modules/services/manager/bridge-pid-reader.js");
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  t.mock.method(fs, "stat", async () => { throw Object.assign(new Error("SECRET path"), { code: "EBUSY" }); });
  t.mock.method(fs, "unlink", () => { throw new Error("must not remove PID files"); });
  for (let n = 0; n < 10; n++) assert.equal(await readBridgeManagedPid(["SECRET"], "SECRET"), null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].code, "EBUSY");
  assert.ok(!JSON.stringify(logs).includes("SECRET"));
});
