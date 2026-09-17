import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentRealtimeRecordingController } = require("../dist-electron/main/modules/agent-platform/realtime/runtime-recording-controller.js");
const workerPath = path.join(process.cwd(), "dist-electron/main/modules/agent-platform/realtime/runtime-recording-worker.js");

function runtimeSnapshot() {
  return {
    runtime: {
      surfaceCount: 1,
      webviewCount: 1,
      orphanWebviewCount: 0,
      totalWorkingSetBytes: 1024,
      processes: [{ pid: 42, type: "Tab", cpuPercent: 1, creationTime: Date.now(), workingSetBytes: 1024, peakWorkingSetBytes: 2048, targetCount: 1 }],
      targets: [{ targetId: "target", surfaceId: "main-chat", label: "Main", url: "https://example.test/", title: "Main", active: true, loading: false, crashed: false, devToolsOpened: false, backgroundThrottling: true, orphaned: false }],
    },
    connections: {
      primary: { source: "desktop-main", phase: "connected", generation: 1, physicalConnectionCount: 1, reconnectCount: 0, endpoint: "https://example.test" },
      btw: { source: "desktop-btw", phase: "idle", generation: 0, physicalConnectionCount: 0, reconnectCount: 0, endpoint: "" },
    },
  };
}

test("runtime recorder keeps multiple complete snapshots and records bursts beyond the legacy limit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-recording-test-"));
  const controller = new AgentRealtimeRecordingController({ tempRoot: root, workerPath, sampleSnapshot: runtimeSnapshot });
  t.after(async () => {
    await controller.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  controller.setLiveCaptureEnabled(true);
  for (let index = 0; index < 2_005; index += 1) {
    controller.append({
      layer: "platform-ws",
      direction: "platform-to-desktop",
      data: { type: "preview.event", token: "preview-secret", payload: `preview-${index}` },
    });
  }
  const previewPage = controller.queryLiveEvents({ limit: 2 });
  assert.equal(previewPage.total, 2_000);
  assert.deepEqual(previewPage.items.map((item) => item.sequence), [2_005, 2_004]);
  assert.equal(controller.getLiveEvent(2_005).data.token, "<REDACTED>");
  assert.equal((await controller.list()).length, 0);
  controller.setLiveCaptureEnabled(false);
  assert.equal(controller.queryLiveEvents().total, 0);

  const first = await controller.start();
  for (let index = 0; index < 750; index += 1) {
    controller.append({
      layer: "platform-ws",
      direction: "platform-to-desktop",
      data: { lane: "primary", frame: "stream", type: "run.event", runId: "run-1", token: "must-redact", payload: `event-${index}`, nested: { values: Array.from({ length: 300 }, (_, item) => item) } },
      surfaceId: "main-chat",
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  const livePage = await controller.queryEvents(first.id, { order: "desc", limit: 2 });
  assert.deepEqual(livePage.items.map((item) => item.sequence), [750, 749]);
  const completedFirst = await controller.stop();
  assert.equal(completedFirst.state, "completed");
  assert.equal(completedFirst.eventCount, 750);
  assert.equal((await controller.stop()).id, completedFirst.id);

  const second = await controller.start();
  controller.append({ layer: "surface-bridge", direction: "surface-to-desktop", data: { type: "frame", frame: { type: "query", requestId: "request-2" } } });
  await controller.stop();
  const recordings = await controller.list();
  assert.deepEqual(new Set(recordings.map((item) => item.id)), new Set([first.id, second.id]));

  const page = await controller.queryEvents(first.id, { cursor: 600, limit: 200, query: "run.event" });
  assert.equal(page.total, 750);
  const newestPage = await controller.queryEvents(first.id, { order: "desc", limit: 2 });
  assert.deepEqual(newestPage.items.map((item) => item.sequence), [750, 749]);
  const contentPage = await controller.queryEvents(first.id, { query: "event-749" });
  assert.equal(contentPage.total, 1);
  assert.equal(contentPage.items[0].sequence, 750);
  assert.equal((await controller.queryEvents(first.id, { query: "must-redact" })).total, 0);
  const detail = await controller.getEvent(first.id, page.items.at(-1).sequence);
  assert.equal(detail.data.token, "<REDACTED>");
  assert.equal(detail.data.payload, "event-749");
  assert.equal(detail.data.nested.values.length, 300);
  const raw = fs.readFileSync(await controller.exportSource(first.id), "utf8");
  assert.equal(raw.includes("must-redact"), false);
  assert.equal(raw.includes("event-749"), true);
  assert.equal((await controller.getSamples(first.id)).length >= 2, true);
});
