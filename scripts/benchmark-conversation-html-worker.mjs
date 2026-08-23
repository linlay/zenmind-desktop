import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from "node:worker_threads";

const ITERATIONS = 20;
const WARMUPS = 3;
const MAX_P95_WORKER_MS = 30;
const MAX_MAIN_TIMER_GAP_MS = 10;
const ASSET_ORIGIN = "http://127.0.0.1:11961";
const TEMPLATE = Buffer.from(
  '<link href="__CONVERSATION_EXPORT_ASSET_ORIGIN__/runtime.css"><script type="application/json">__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__</script><script src="__CONVERSATION_EXPORT_ASSET_ORIGIN__/runtime.js"></script>'
);

if (!isMainThread) {
  const require = createRequire(import.meta.url);
  const {
    assembleConversationHtml,
    parseConversationHtmlTemplate
  } = require("../dist-electron/main/assistant/core/conversation-html-worker.js");
  const {
    MAX_CONVERSATION_HTML_BYTES
  } = require("../dist-electron/main/assistant/core/conversation-export-contract.js");
  const parsed = parseConversationHtmlTemplate(Buffer.from(workerData.template));
  const snapshotSize = MAX_CONVERSATION_HTML_BYTES - parsed.staticBytes -
    parsed.assetOriginMarkers * Buffer.byteLength(ASSET_ORIGIN);
  const snapshot = Buffer.alloc(snapshotSize, 0x61);
  parentPort.on("message", (id) => {
    const started = performance.now();
    const html = assembleConversationHtml(parsed, snapshot, ASSET_ORIGIN);
    const workerMs = performance.now() - started;
    parentPort.postMessage({ id, html, workerMs }, [html]);
  });
} else {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { template: TEMPLATE }
  });
  const pending = new Map();
  worker.on("message", (message) => {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  });
  let nextId = 0;
  const run = () => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    worker.postMessage(id);
  });

  for (let index = 0; index < WARMUPS; index += 1) await run();
  let maximumTimerGap = 0;
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maximumTimerGap = Math.max(maximumTimerGap, now - previousTick);
    previousTick = now;
  }, 1);
  const results = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const result = await run();
    results.push({
      workerMs: result.workerMs,
      outputBytes: result.html.byteLength
    });
  }
  clearInterval(timer);
  await worker.terminate();

  const durations = results.map((result) => result.workerMs).sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  const outputBytes = results[0]?.outputBytes || 0;
  console.log(JSON.stringify({
    iterations: ITERATIONS,
    outputBytes,
    workerP95Ms: Number(p95.toFixed(3)),
    maximumMainTimerGapMs: Number(maximumTimerGap.toFixed(3)),
    limits: {
      workerP95Ms: MAX_P95_WORKER_MS,
      maximumMainTimerGapMs: MAX_MAIN_TIMER_GAP_MS
    }
  }, null, 2));
  if (p95 > MAX_P95_WORKER_MS || maximumTimerGap > MAX_MAIN_TIMER_GAP_MS) {
    process.exitCode = 1;
  }
}
