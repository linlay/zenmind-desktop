import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { AgentRealtimeRecordingController } = require("../dist-electron/main/modules/agent-platform/realtime/runtime-recording-controller.js");
const workerPath = path.join(process.cwd(), "dist-electron/main/modules/agent-platform/realtime/runtime-recording-worker.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-recording-benchmark-"));
const durationSeconds = Number(process.env.RUNTIME_RECORDING_BENCHMARK_SECONDS || 60);
const eventsPerSecond = 1_000;
const payload = "x".repeat(900);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
const memoryBefore = process.memoryUsage().rss;
let maximumAppendBatchMs = 0;

const controller = new AgentRealtimeRecordingController({
  tempRoot,
  workerPath,
  sampleSnapshot: () => ({
    runtime: {
      surfaceCount: 1,
      webviewCount: 1,
      orphanWebviewCount: 0,
      totalWorkingSetBytes: process.memoryUsage().rss,
      processes: [],
      targets: [],
    },
    connections: {
      primary: { source: "desktop-main", phase: "connected", generation: 1, physicalConnectionCount: 1, reconnectCount: 0, endpoint: "benchmark" },
      btw: { source: "desktop-btw", phase: "idle", generation: 0, physicalConnectionCount: 0, reconnectCount: 0, endpoint: "" },
    },
  }),
});

try {
  eventLoopDelay.enable();
  const recording = await controller.start();
  const startedAt = performance.now();
  for (let second = 0; second < durationSeconds; second += 1) {
    const batchStartedAt = performance.now();
    for (let index = 0; index < eventsPerSecond; index += 1) {
      controller.append({
        layer: "platform-ws",
        direction: "platform-to-desktop",
        surfaceId: "main-chat",
        data: { type: "benchmark.event", runId: "benchmark-run", second, index, payload },
      });
    }
    maximumAppendBatchMs = Math.max(maximumAppendBatchMs, performance.now() - batchStartedAt);
    const nextSecondAt = startedAt + (second + 1) * 1_000;
    const waitMs = nextSecondAt - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const summary = await controller.stop();
  const expectedEvents = durationSeconds * eventsPerSecond;
  assert.equal(summary.state, "completed");
  assert.equal(summary.eventCount, expectedEvents);
  assert.equal(summary.lastSequence, expectedEvents);
  const firstPage = await controller.queryEvents(recording.id, { limit: 200 });
  const lastPage = await controller.queryEvents(recording.id, { cursor: Math.max(0, expectedEvents - 200), limit: 200 });
  assert.equal(firstPage.total, expectedEvents);
  assert.equal(firstPage.items[0]?.sequence, 1);
  assert.equal(lastPage.items.at(-1)?.sequence, expectedEvents);

  eventLoopDelay.disable();
  const counters = controller.getPerformanceCounters();
  const result = {
    durationSeconds,
    eventsPerSecond,
    eventCount: summary.eventCount,
    fileBytes: summary.bytes,
    peakQueuedEntries: counters.peakQueuedEntries,
    peakQueuedBytes: counters.peakQueuedBytes,
    maximumAppendBatchMs: Number(maximumAppendBatchMs.toFixed(2)),
    eventLoopDelayMeanMs: Number((eventLoopDelay.mean / 1e6).toFixed(2)),
    eventLoopDelayMaxMs: Number((eventLoopDelay.max / 1e6).toFixed(2)),
    additionalRssBytes: process.memoryUsage().rss - memoryBefore,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  eventLoopDelay.disable();
  await controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
