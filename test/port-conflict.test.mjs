import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  detectPortConflict,
  extractPortFromError,
  isPortConflictError,
  showPortConflictDialog
} = require("../dist-electron/main/port-conflict.js");

test("isPortConflictError recognizes common port conflict errors", () => {
  assert.equal(isPortConflictError("listen tcp :11949: bind: address already in use"), true);
  assert.equal(isPortConflictError("Error: listen EADDRINUSE: address already in use :::3000"), true);
  assert.equal(isPortConflictError("connect ECONNREFUSED 127.0.0.1:11949"), false);
});

test("extractPortFromError parses ports from multiple conflict formats", () => {
  assert.equal(extractPortFromError("listen tcp :11949: bind: address already in use"), 11949);
  assert.equal(extractPortFromError("Error: listen EADDRINUSE: address already in use :::3000"), 3000);
  assert.equal(extractPortFromError("bind failed: address already in use 127.0.0.1:8080"), 8080);
  assert.equal(extractPortFromError("address already in use"), null);
});

test("buildPortConflictDialogOptions includes process details and recovery copy", () => {
  const options = __testInternals.buildPortConflictDialogOptions(11949, {
    pid: 12345,
    name: "agent-platform"
  });

  assert.deepEqual(options, {
    type: "warning",
    buttons: ["取消", "终止进程并重启"],
    defaultId: 0,
    cancelId: 0,
    title: "端口被占用",
    message: "端口 11949 已被进程 agent-platform (PID 12345)占用。是否终止该进程并重新启动？",
    detail: "确认后会先终止占用进程，再自动重试启动服务。"
  });
});

test("showPortConflictDialog uses owner window when provided", async () => {
  const ownerWindow = { id: "main-window" };
  const calls = [];

  const confirmed = await showPortConflictDialog(ownerWindow, 11949, { pid: 12345, name: "agent-platform" }, {
    showMessageBox: async (windowRef, options) => {
      calls.push({ windowRef, options });
      return { response: 1, checkboxChecked: false };
    }
  });

  assert.equal(confirmed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowRef, ownerWindow);
  assert.deepEqual(
    calls[0].options,
    __testInternals.buildPortConflictDialogOptions(11949, {
      pid: 12345,
      name: "agent-platform"
    })
  );
});

test("detectPortConflict prefers extracted port over fallback and default port", async () => {
  const inspectedPorts = [];
  const result = await detectPortConflict(
    "listen tcp :11949: bind: address already in use",
    { web: { defaultPort: 13000 } },
    {
      fallbackPort: 12000,
      findProcessOnPort: async (port) => {
        inspectedPorts.push(port);
        return { pid: 23456, name: "test-service" };
      }
    }
  );

  assert.deepEqual(inspectedPorts, [11949]);
  assert.deepEqual(result, {
    port: 11949,
    processInfo: {
      pid: 23456,
      name: "test-service"
    }
  });
});
