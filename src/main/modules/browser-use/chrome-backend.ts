import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import type { ChromeWorkerMethod, ChromeWorkerReply, ChromeWorkerRequest } from "./chrome-worker-contract";

const QUEUE_WAIT_MS = 45_000;
const EXECUTION_WAIT_MS = 45_000;
const CONNECTION_WAIT_MS = 180_000;
const CONTROL_WAIT_MS = 5_000;
const HEALTH_INTERVAL_MS = 5_000;
const connectionControls = new Set<ChromeWorkerMethod>(["health", "cancel-request", "disconnect", "cancel"]);

type Pending = {
  method: ChromeWorkerMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
  sent: boolean;
  started: boolean;
  cancelled?: boolean;
  settled: Promise<void>;
  settle(): void;
};
export type ChromeBackendOptions = { onExit?: (code: number) => void; workerPath?: string };

/** Main owns this transport; no browser endpoint, launch arguments or model-authored code crosses it. */
export class ChromeBackend {
  private process?: UtilityProcess;
  private pending = new Map<string, Pending>();
  private released = false;
  private spawned = false;
  private exitReported = false;
  private outbox: ChromeWorkerRequest[] = [];
  private disconnecting?: Promise<void>;
  private healthTimer?: ReturnType<typeof setTimeout>;

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
      if (this.process !== child || this.released) return;
      this.spawned = true;
      for (const request of this.outbox.splice(0)) {
        const pending = this.pending.get(request.id);
        if (!pending) continue;
        pending.sent = true;
        child.postMessage(request);
      }
    });
    child.on("message", (reply: ChromeWorkerReply) => {
      if (this.process !== child || this.released || !reply || typeof reply.id !== "string") return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (reply.started === true) {
        if (pending.started) return;
        pending.started = true;
        if (!pending.cancelled && !connectionControls.has(pending.method)) {
          clearTimeout(pending.timer);
          const timeout = pending.method === "connect" ? CONNECTION_WAIT_MS : EXECUTION_WAIT_MS;
          pending.timer = setTimeout(() => this.timedOut(reply.id), timeout);
        }
        return;
      }
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (!pending.cancelled && reply.error) {
        pending.reject(Object.assign(new Error(reply.error.message), {
          code: reply.error.code,
          ...(typeof reply.error.statusCode === "number" ? { statusCode: reply.error.statusCode } : {}),
          ...(reply.error.details ? { details: reply.error.details } : {}),
        }));
      } else if (!pending.cancelled) {
        pending.resolve(reply.result);
      }
      pending.settle();
      this.watchAbandonedRequests();
    });
    child.once("exit", code => {
      if (this.process !== child) return;
      this.process = undefined;
      this.spawned = false;
      this.outbox = [];
      this.released = true;
      this.failAll(Object.assign(new Error("Chrome worker exited"), { code: "browser_disconnected" }));
      this.reportExit(code);
    });
    return child;
  }

  request<T = unknown>(method: ChromeWorkerMethod, params?: Record<string, unknown>, pageId?: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }));
    let child: UtilityProcess;
    try { child = this.start(); } catch (error) { return Promise.reject(error); }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.abandon(id, Object.assign(new Error("Browser operation cancelled"), { code: "cancelled" }));
      const timeout = connectionControls.has(method) ? CONTROL_WAIT_MS
        : method === "connect" ? CONNECTION_WAIT_MS : QUEUE_WAIT_MS;
      const timer = setTimeout(() => this.timedOut(id), timeout);
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      this.pending.set(id, {
        method, resolve: value => resolve(value as T), reject, timer,
        cleanup: () => signal?.removeEventListener("abort", abort),
        sent: this.spawned, started: false, settled, settle,
      });
      signal?.addEventListener("abort", abort, { once: true });
      const request: ChromeWorkerRequest = { id, method, params, pageId };
      if (this.spawned) child.postMessage(request);
      else this.outbox.push(request);
    });
  }

  private timedOut(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const connectionFailed = pending.method === "connect" || connectionControls.has(pending.method);
    const error = Object.assign(new Error(connectionFailed
      ? "The Chrome worker did not respond to its connection control deadline."
      : "The Chrome request timed out. Its execution is being reconciled; check the page before repeating an action."), {
      code: connectionFailed ? "browser_disconnected" : "browser_action_timeout",
      // Lack of a started message is not proof that input was never dispatched.
      details: { phase: pending.started ? "execution" : "queue", outcome: "unknown" },
    });
    this.abandon(id, error);
    // Caller cancellation cannot turn a sent control's transport deadline off.
    if (connectionFailed) void this.disconnect();
  }

  /** Reject the caller, but keep a sent request's real acknowledgement in the drain lease. */
  private abandon(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.cancelled) return;
    pending.cancelled = true;
    // Sent priority controls still need a bounded response after their caller leaves.
    // Ordinary operations instead keep their real drain and periodic health checks.
    if (!pending.sent || !connectionControls.has(pending.method)) clearTimeout(pending.timer);
    pending.cleanup();
    pending.reject(error);
    if (!pending.sent) {
      this.pending.delete(id);
      this.outbox = this.outbox.filter(request => request.id !== id);
      pending.settle();
    } else if (!connectionControls.has(pending.method)) {
      // This private control bypasses the action queue. The original reply, not
      // this control's result, releases the request. Running writes are never replayed.
      void this.request("cancel-request", { requestId: id }).catch(() => undefined);
    }
    this.watchAbandonedRequests();
  }

  private watchAbandonedRequests(): void {
    const waiting = [...this.pending.values()].some(pending => pending.cancelled && !connectionControls.has(pending.method));
    if (!waiting || this.released || this.disconnecting) {
      clearTimeout(this.healthTimer);
      this.healthTimer = undefined;
      return;
    }
    if (this.healthTimer || [...this.pending.values()].some(pending => connectionControls.has(pending.method))) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      // A responsive Worker may still be copying the original download response.
      // Never detach that copy just because it takes longer than an RPC deadline.
      void this.request<{ healthy: boolean }>("health").then(result => {
        if (result?.healthy !== true) void this.disconnect();
      }).catch(() => { void this.disconnect(); });
    }, HEALTH_INTERVAL_MS);
  }

  /** Wait for actual Worker acknowledgements, including replies whose caller cancelled. */
  async drain(): Promise<void> {
    await Promise.all([...this.pending.values()].map(pending => pending.settled));
  }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const child = this.process;
    if (!child) { this.released = true; return Promise.resolve(); }
    clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.disconnecting = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // UtilityProcess has no stdin. Give the relay a chance to detach first.
        await Promise.race([this.request("disconnect"), new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500); })]);
      } catch { /* Exit is a valid release acknowledgement. */ }
      finally { clearTimeout(timeout); this.kill(); }
    })();
    return this.disconnecting;
  }

  kill(): void {
    const child = this.process;
    this.released = true;
    this.process = undefined;
    this.outbox = [];
    this.spawned = false;
    this.failAll(Object.assign(new Error("Chrome connection was released"), { code: "browser_disconnected" }));
    // Electron owns platform termination. Never signal the user's Chrome process.
    try { child?.kill(); } catch { /* An already-exited process is released. */ }
    if (child) this.reportExit(-1);
  }

  private reportExit(code: number): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.options.onExit?.(code);
  }

  private failAll(error: Error): void {
    clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
      pending.settle();
    }
    this.pending.clear();
  }
}
