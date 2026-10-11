import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  LOCAL_MARKDOWN_MAX_BYTES,
  LOCAL_MARKDOWN_MAX_HTML_BYTES,
  LOCAL_MARKDOWN_RENDER_TIMEOUT_MS,
  type LocalMarkdownWorkerRequest,
  type LocalMarkdownWorkerResponse,
} from "./local-document-worker-contract";

type RenderErrorCode = "too_large" | "render_failed" | "timeout";

export class LocalMarkdownRenderError extends Error {
  constructor(readonly code: RenderErrorCode) {
    super(`Local Markdown render ${code}.`);
    this.name = "LocalMarkdownRenderError";
  }
}

function abortError() {
  return new DOMException("Local document rendering was cancelled.", "AbortError");
}

export function createLocalMarkdownRenderer(options: { workerPath?: string; timeoutMs?: number } = {}) {
  // tsc places the worker beside this module; the packaged Main bundle places
  // both this code and the separately bundled worker under the main directory.
  const workerPath = options.workerPath ?? path.join(__dirname, "local-document-worker.js");
  const timeoutMs = options.timeoutMs ?? LOCAL_MARKDOWN_RENDER_TIMEOUT_MS;
  const queue: Array<() => void> = [];
  let activeWorkers = 0;
  const drain = () => {
    while (activeWorkers < 2 && queue.length) queue.shift()!();
  };

  return function render(bytes: Uint8Array, fileName: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (bytes.byteLength > LOCAL_MARKDOWN_MAX_BYTES) return Promise.reject(new LocalMarkdownRenderError("too_large"));

    // Own the transferable allocation: detaching a caller's Buffer can corrupt
    // adjacent pooled data or another in-flight preview.
    const input = new Uint8Array(bytes);
    return new Promise<string>((resolve, reject) => {
      let worker: Worker | undefined;
      let settled = false;
      let started = false;
      const release = () => { activeWorkers -= 1; drain(); };
      const finish = (error: Error | undefined, html?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const queuedIndex = queue.indexOf(start);
        if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
        // Wait for termination before admitting another worker, keeping the
        // memory/concurrency bound valid even when a window closes mid-parse.
        if (worker) void worker.terminate().catch(() => undefined).then(release);
        else if (started) release();
        if (error) reject(error);
        else resolve(html!);
      };
      const onAbort = () => finish(abortError());
      const start = () => {
        if (settled) return;
        started = true;
        activeWorkers += 1;
        try {
          const request: LocalMarkdownWorkerRequest = { mode: "local-markdown-render", bytes: input, fileName };
          worker = new Worker(workerPath, {
            name: "local-document-markdown",
            workerData: request,
            transferList: [input.buffer as ArrayBuffer],
            resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
          });
          worker.on("message", (response: LocalMarkdownWorkerResponse) => {
            if (!response || typeof response !== "object") {
              finish(new LocalMarkdownRenderError("render_failed"));
            } else if (response.ok && typeof response.html === "string") {
              finish(Buffer.byteLength(response.html, "utf8") > LOCAL_MARKDOWN_MAX_HTML_BYTES
                ? new LocalMarkdownRenderError("too_large") : undefined, response.html);
            } else {
              finish(new LocalMarkdownRenderError(!response.ok && response.code === "too_large" ? "too_large" : "render_failed"));
            }
          });
          worker.on("error", (error) => finish(new LocalMarkdownRenderError(
            (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_large" : "render_failed",
          )));
          worker.on("exit", () => finish(new LocalMarkdownRenderError("render_failed")));
        } catch {
          finish(new LocalMarkdownRenderError("render_failed"));
        }
      };
      const timeout = setTimeout(() => finish(new LocalMarkdownRenderError("timeout")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      queue.push(start);
      drain();
    });
  };
}

export const renderLocalMarkdownAsync = createLocalMarkdownRenderer();
