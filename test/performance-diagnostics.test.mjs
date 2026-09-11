import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { sanitizePerformanceEvent } = require("../dist-electron/shared/performance-diagnostics.js");
const { createPerformanceWriter, isPerformanceDiagnosticsEnabled } = require("../dist-electron/main/support/logging/performance.js");

test("performance payload drops URLs, chat contents, arbitrary strings and invalid measurements", () => {
  const result = sanitizePerformanceEvent({ stage: "dom-ready", webContentsId: 17, active: false,
    hostRoute: "/agent/private?chatId=secret", url: "https://secret", token: "secret", body: "secret",
    surfaceId: "bad/url", elapsedMs: Infinity, hostMonoMs: -1, transitionId: NaN,
    nested: { token: "secret" } });
  assert.deepEqual(result, { stage: "dom-ready", webContentsId: 17, active: false });
});

test("performance collection requires explicit launch opt-in", () => {
  const old = process.env.ZENMIND_PERF;
  try {
    delete process.env.ZENMIND_PERF;
    assert.equal(isPerformanceDiagnosticsEnabled(), false);
    process.env.ZENMIND_PERF = "true";
    assert.equal(isPerformanceDiagnosticsEnabled(), false);
    process.env.ZENMIND_PERF = "1";
    assert.equal(isPerformanceDiagnosticsEnabled(), true);
  } finally {
    if (old === undefined) delete process.env.ZENMIND_PERF;
    else process.env.ZENMIND_PERF = old;
  }
});

test("writer rotates bounded JSONL files and reports dropped events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-perf-test-"));
  try {
    const writer = createPerformanceWriter(root, 500);
    writer.write({ stage: "too-large", payload: "x".repeat(1000) });
    writer.write({ stage: "first", payload: "x".repeat(220) });
    await writer.flush();
    writer.write({ stage: "second", payload: "x".repeat(220) });
    await writer.close();
    const previous = JSON.parse(await fs.readFile(path.join(root, "performance.jsonl.1"), "utf8"));
    const current = JSON.parse(await fs.readFile(path.join(root, "performance.jsonl"), "utf8"));
    assert.equal(previous.stage, "first");
    assert.equal(previous.dropped, 1);
    assert.equal(current.stage, "second");
    for (const file of await fs.readdir(root)) assert.ok((await fs.stat(path.join(root, file))).size <= 500);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("writer serializes concurrent flushes and drains events queued during a write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zenmind-perf-test-"));
  try {
    const writer = createPerformanceWriter(root);
    writer.write({ stage: "first" });
    const flushing = writer.flush();
    writer.write({ stage: "second" });
    await Promise.all([flushing, writer.close()]);
    const lines = (await fs.readFile(path.join(root, "performance.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.stage), ["first", "second"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rapid navigation uses matching route identity and monotonic time, never the next switch", async () => {
  const source = await fs.readFile(new URL("../src/renderer/services/performanceDiagnostics.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const reports = [];
  let now = 100, sequence = 0;
  const context = { exports: {}, require: () => ({ sanitizePerformanceEvent }), URLSearchParams,
    crypto: { randomUUID: () => `id-${++sequence}` }, performance: { now: () => now },
    window: { electronAPI: { diagnostics: { performanceEnabled: true, reportRendererError: (report) => reports.push(report.details) } } } };
  vm.runInNewContext(compiled, context);
  const api = context.exports;
  const trace = api.createSurfacePerformanceTrace();
  api.beginChatPerformanceNavigation("/agent/a?chatId=private-a");
  now = 125;
  trace("main-chat-router-waiting-ready", { transitionId: 1, hostRoute: "/agent/a?chatId=private-a" });
  const firstId = reports.at(-1).switchId;
  assert.equal(reports.at(-1).elapsedMs, 25);
  now = 150;
  api.beginChatPerformanceNavigation("/agent/a?chatId=private-b");
  trace("main-chat-route-transition-replaced", { transitionId: 1 });
  assert.equal(reports.at(-1).switchId, firstId);
  assert.equal(reports.at(-1).elapsedMs, 50);
  trace("main-chat-router-waiting-ready", { transitionId: 2, hostRoute: "/agent/a?chatId=private-b" });
  const secondId = reports.at(-1).switchId;
  assert.notEqual(secondId, firstId);
  now = 220;
  trace("main-chat-router-applied-accepted", { transitionId: 2, completionScope: "router-only" });
  assert.equal(reports.at(-1).elapsedMs, 70);
  assert.equal(reports.at(-1).switchId, secondId);
  assert.ok(!JSON.stringify(reports).includes("private-"));
  context.window.electronAPI.diagnostics.performanceEnabled = false;
  const count = reports.length;
  trace("dom-ready", {});
  assert.equal(reports.length, count);
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform} sampler preserves process accounting, strips target content and cleans up`, async () => {
    const source = await fs.readFile(new URL("../src/main/app/performance-diagnostics.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const app = Object.assign(new EventEmitter(), { getVersion: () => "test", getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }) });
    const guest = Object.assign(new EventEmitter(), { id: 10, getType: () => "webview", isDestroyed: () => false, getOSProcessId: () => 100 });
    const records = [];
    let tick, stopped = false, loopDisabled = false, bytes = 1000;
    const imports = {
      electron: { app, screen: { getAllDisplays: () => [] }, webContents: { getAllWebContents: () => [guest] } },
      "node:os": { release: () => "test", cpus: () => [{ model: "test" }], totalmem: () => 8192 },
      "node:perf_hooks": { monitorEventLoopDelay: () => ({ enable() {}, disable() { loopDisabled = true; }, reset() {}, max: 1000000, percentile: () => 1000000 }) },
      "./module-registry.part-1": { createAgentRealtimeRuntimeDiagnostics: () => ({
        processes: [{ pid: 100, type: "Tab", creationTime: 1, workingSetBytes: bytes, privateBytes: 500, cpuPercent: 1 }],
        targets: [{ webContentsId: 10, pid: 100, surfaceId: "main-chat", title: "PRIVATE_TITLE", url: "PRIVATE_URL", active: true }],
        surfaceCount: 1, webviewCount: 1, orphanWebviewCount: 0, totalWorkingSetBytes: bytes,
      }) },
      "../support/logging/desktop": { getDesktopLogRoot: () => "unused" },
      "../support/logging/performance": { isPerformanceDiagnosticsEnabled: () => true,
        startPerformanceWriter: () => () => { stopped = true; }, writePerformanceEvent: (record) => records.push(record) },
    };
    const context = { exports: {}, require: (name) => { assert.ok(name in imports, name); return imports[name]; },
      process: { platform, arch: "test", pid: 1, versions: {} },
      setInterval: (callback) => { tick = callback; return { unref() {} }; }, clearInterval() {},
    };
    vm.runInNewContext(compiled, context);
    context.exports.startPerformanceDiagnostics({});
    tick();
    const first = records.at(-1).processes[0];
    assert.equal(first.deltaBytes, null);
    assert.equal("privateBytes" in first, platform === "win32");
    bytes = 1200;
    tick();
    assert.equal(records.at(-1).processes[0].deltaBytes, 200);
    assert.ok(!JSON.stringify(records).includes("PRIVATE_"));
    guest.emit("dom-ready");
    assert.equal(records.at(-1).stage, "contents-dom-ready");
    assert.equal(records.at(-1).pid, 100);
    app.emit("will-quit");
    assert.equal(stopped, true);
    assert.equal(loopDisabled, true);
    assert.equal(guest.listenerCount("dom-ready"), 0);
    assert.equal(app.listenerCount("web-contents-created"), 0);
  });
}
