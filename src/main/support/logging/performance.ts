import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const isPerformanceDiagnosticsEnabled = () => process.env.ZENMIND_PERF === "1";

// Bound both disk use and the producer queue; slow disks must not retain unbounded events.
export function createPerformanceWriter(root: string, maxBytes = 10 * 1024 * 1024) {
  const filename = path.join(root, "performance.jsonl");
  const sessionId = randomUUID();
  let queue: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let writing: Promise<void> | undefined;
  let size: number | undefined;
  const flush = (): Promise<void> => {
    if (writing) return writing;
    if (!queue.length) return Promise.resolve();
    const batch = queue.join("");
    queue = [];
    queuedBytes = 0;
    writing = (async () => {
      size ??= await fs.stat(filename).then((s) => s.size, () => 0);
      const bytes = Buffer.byteLength(batch);
      if (size + bytes > maxBytes) {
        await fs.rm(`${filename}.1`, { force: true });
        await fs.rename(filename, `${filename}.1`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        size = 0;
      }
      await fs.appendFile(filename, batch, "utf8");
      size += bytes;
    })().catch(() => { dropped += batch.split("\n").length - 1; })
      .finally(() => { writing = undefined; });
    return writing;
  };
  return {
    write(event: Record<string, unknown>) {
      const line = JSON.stringify({ at: Date.now(), ...event, sessionId, dropped }) + "\n";
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes || queuedBytes + bytes > Math.min(maxBytes, 256 * 1024)) { dropped++; return; }
      queue.push(line);
      queuedBytes += bytes;
      dropped = 0;
    },
    flush,
    async close() { await flush(); await flush(); },
  };
}

let writer: ReturnType<typeof createPerformanceWriter> | undefined;
export function writePerformanceEvent(event: Record<string, unknown>) { writer?.write(event); }
export function startPerformanceWriter(root: string) {
  writer = createPerformanceWriter(root);
  const timer = setInterval(() => { void writer?.flush(); }, 1000);
  timer.unref();
  return async () => { clearInterval(timer); const current = writer; writer = undefined; await current?.close(); };
}
