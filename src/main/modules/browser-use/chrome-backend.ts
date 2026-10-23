import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import type { ChromeWorkerMethod, ChromeWorkerReply, ChromeWorkerRequest } from "./chrome-worker-contract";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void;
  sent: boolean; cancelled?: boolean; settled: Promise<void>; settle(): void };
export type ChromeBackendOptions = { onExit?: (code: number) => void; workerPath?: string };

/** Main owns this transport; no browser endpoint, launch arguments or model-authored code crosses it. */
export class ChromeBackend {
  private process?: UtilityProcess;
  private pending = new Map<string, Pending>();
  private released = false;
  private spawned = false;
  private outbox: ChromeWorkerRequest[] = [];
  private disconnecting?: Promise<void>;

  constructor(private readonly options: ChromeBackendOptions = {}) {}

  private start(): UtilityProcess {
    if (this.released) throw Object.assign(new Error("Chrome connection was released"), { code: "browser_disconnected" });
    if (this.process) return this.process;
    const workerPath = this.options.workerPath ?? path.join(app.getAppPath(), "dist-electron", "main", "chrome-worker.js");
    if (!fs.statSync(workerPath, { throwIfNoEntry: false })?.isFile()) {
      throw Object.assign(new Error("Chrome worker bundle is missing. Build Desktop before connecting Chrome."), { code: "browser_runtime_unavailable" });
    }
    const child = utilityProcess.fork(workerPath, [], { serviceName: "Desktop Chrome", stdio: "ignore" });
    this.process = child;
    child.once("spawn", () => {
      this.spawned = true;
      for (const request of this.outbox.splice(0)) {
        const pending = this.pending.get(request.id);
        if (pending) { pending.sent = true; child.postMessage(request); }
      }
    });
    child.on("message", (reply: ChromeWorkerReply) => {
      if (!reply || typeof reply.id !== "string") return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (!pending.cancelled && reply.error) pending.reject(Object.assign(new Error(reply.error.message), {
        code: reply.error.code,
        ...(typeof reply.error.statusCode === "number" ? { statusCode: reply.error.statusCode } : {}),
        ...(reply.error.details ? { details: reply.error.details } : {}),
      }));
      else if (!pending.cancelled) pending.resolve(reply.result);
      pending.settle();
    });
    child.once("exit", code => {
      this.process = undefined;
      this.spawned = false;
      this.outbox = [];
      this.released = true;
      this.failAll(Object.assign(new Error("Chrome worker exited"), { code: "browser_disconnected" }));
      this.options.onExit?.(code);
    });
    return child;
  }

  request<T = unknown>(method: ChromeWorkerMethod, params?: Record<string, unknown>, pageId?: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }));
    let child: UtilityProcess;
    try { child = this.start(); } catch (error) { return Promise.reject(error); }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (pending) {
          pending.cancelled = true;
          pending.cleanup();
          reject(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }));
          if (!pending.sent) {
            this.pending.delete(id); clearTimeout(pending.timer);
            this.outbox = this.outbox.filter(request => request.id !== id); pending.settle();
          } else if (method !== "cancel-request") {
            // The original request remains pending until its own acknowledgement.
            // This private control bypasses the Worker's action queue and only
            // skips that exact request if it has not started page execution.
            void this.request("cancel-request", { requestId: id }).catch(() => undefined);
          }
        }
        // Sent operations retain their real reply/drain lease. Stopping one Run
        // must not detach the shared extension group or deliver a late result.
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          pending.cleanup();
          reject(Object.assign(new Error("Chrome operation timed out; the connection has been released"), { code: "browser_action_timeout" }));
        }
        void this.disconnect();
      }, method === "connect" ? 180_000 : 45_000);
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, cleanup: () => signal?.removeEventListener("abort", abort), sent: this.spawned, settled, settle });
      signal?.addEventListener("abort", abort, { once: true });
      const request: ChromeWorkerRequest = { id, method, params, pageId };
      if (this.spawned) child.postMessage(request);
      else this.outbox.push(request);
    });
  }

  /** Wait for actual Worker acknowledgements, including replies whose caller cancelled. */
  async drain(): Promise<void> { await Promise.all([...this.pending.values()].map(pending => pending.settled)); }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const child = this.process;
    if (!child) { this.released = true; return Promise.resolve(); }
    this.disconnecting = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // UtilityProcess has no stdin. A private parentPort request gives the relay a chance to detach first.
        await Promise.race([this.request("disconnect"), new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500); })]);
      } catch { /* Exit is a valid release acknowledgement. */ }
      finally { clearTimeout(timeout); this.kill(); }
    })();
    return this.disconnecting;
  }

  kill(): void {
    this.released = true;
    // Electron owns the platform-specific process termination. Never signal a user Chrome process or PID tree.
    try { this.process?.kill(); } catch { /* A process that already exited is released. */ }
    this.process = undefined;
    this.outbox = [];
    this.spawned = false;
    this.failAll(Object.assign(new Error("Chrome connection was released"), { code: "browser_disconnected" }));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
      pending.settle();
    }
    this.pending.clear();
  }
}
