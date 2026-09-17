import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import type {
  AgentRealtimeDebugSnapshot,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeRecordingEventFilter,
  AgentRealtimeRecordingEventPage,
  AgentRealtimeRecordingEventSummary,
  AgentRealtimeRecordingSample,
  AgentRealtimeRecordingSummary,
} from "../../../../shared/contracts";
import { APP_BRAND } from "../../../../shared/brand";
import { requireEpochMillis } from "../../../../shared/time-contract";
import {
  sanitizeAgentRealtimeDebugTraceEntry,
  type AgentRealtimeDebugTraceInput,
} from "./realtime-debug-trace";
import {
  agentRealtimeEventSearchText,
  eventDataIncludesQuery,
  matchesAgentRealtimeEventFilter,
  summarizeAgentRealtimeEvent,
} from "./runtime-event-query";
import type { RuntimeRecordingWorkerRequest, RuntimeRecordingWorkerResponse } from "./runtime-recording-protocol";

const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_ENTRIES = 1_024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORDING_DURATION_MS = 30 * 60 * 1_000;
const SAMPLE_INTERVAL_MS = 1_000;
const FLUSH_INTERVAL_MS = 20;
const FLUSH_BATCH_SIZE = 64;
const MAX_LIVE_EVENT_ENTRIES = 2_000;
const MAX_LIVE_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_LIVE_EVENT_PAGE_SIZE = 200;
const SESSION_OWNER_FILE = ".runtime-recording-owner.json";
const SESSION_OWNER = "zenmind-runtime-recording-v1";

function processIsRunning(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type WorkerRequestInput = RuntimeRecordingWorkerRequest extends infer Request
  ? Request extends { requestId: number } ? Omit<Request, "requestId"> : never
  : never;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type LiveEventEntry = {
  event: AgentRealtimeDebugTraceEntry;
  summary: AgentRealtimeRecordingEventSummary;
  searchText: string;
  bytes: number;
};

function createTraceEntry(
  input: AgentRealtimeDebugTraceInput,
  sequence: number,
  recordedAt: AgentRealtimeDebugTraceEntry["recordedAt"],
): AgentRealtimeDebugTraceEntry {
  return {
    sequence,
    recordedAt,
    layer: input.layer,
    direction: input.direction,
    data: input.data,
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.webContentsId ? { webContentsId: input.webContentsId } : {}),
    ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
    ...(input.surfaceRole ? { surfaceRole: input.surfaceRole } : {}),
    ...(input.surfaceLevel ? { surfaceLevel: input.surfaceLevel } : {}),
    ...(input.parentSurfaceId ? { parentSurfaceId: input.parentSurfaceId } : {}),
    ...(input.interaction ? { interaction: input.interaction } : {}),
    ...(input.route ? { route: input.route } : {}),
  };
}

export class AgentRealtimeRecordingController {
  private readonly sessionRoot: string;
  private staleSessionRoots: string[] = [];
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private activeId: string | null = null;
  private acceptingEvents = false;
  private sequence = 0;
  private liveCaptureEnabled = false;
  private liveSequence = 0;
  private liveEventBytes = 0;
  private liveEvents: LiveEventEntry[] = [];
  private queuedBytes = 0;
  private queuedEntries = 0;
  private peakQueuedBytes = 0;
  private peakQueuedEntries = 0;
  private eventQueue: Array<{ event: AgentRealtimeDebugTraceEntry; bytes: number }> = [];
  private readonly appendRequests = new Set<Promise<unknown>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  private finalizing: Promise<AgentRealtimeRecordingSummary> | null = null;
  private lastStoppedSummary: AgentRealtimeRecordingSummary | null = null;
  private lastRuntimeSnapshot: Pick<AgentRealtimeDebugSnapshot, "runtime" | "connections"> | null = null;
  private lastSampleAt = 0;
  private disposed = false;

  constructor(private readonly options: {
    tempRoot: string;
    workerPath: string;
    sampleSnapshot: () => Pick<AgentRealtimeDebugSnapshot, "runtime" | "connections">;
  }) {
    const root = path.join(options.tempRoot, APP_BRAND.packageName, "runtime-recordings");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("session-")) {
        const staleRoot = path.join(root, entry.name);
        let owner: { owner?: unknown; pid?: unknown };
        try {
          owner = JSON.parse(fs.readFileSync(path.join(staleRoot, SESSION_OWNER_FILE), "utf8")) as { owner?: unknown; pid?: unknown };
        } catch {
          continue;
        }
        if (owner.owner !== SESSION_OWNER || processIsRunning(Number(owner.pid))) continue;
        try {
          fs.rmSync(staleRoot, { recursive: true, force: true });
        } catch {
          this.staleSessionRoots.push(staleRoot);
        }
      }
    }
    this.sessionRoot = fs.mkdtempSync(path.join(root, "session-"));
    fs.writeFileSync(path.join(this.sessionRoot, SESSION_OWNER_FILE), JSON.stringify({
      owner: SESSION_OWNER,
      pid: process.pid,
      createdAt: Date.now(),
    }), { encoding: "utf8", mode: 0o600 });
  }

  async start() {
    if (this.disposed) throw new Error("recording_controller_disposed");
    if (this.activeId || this.finalizing) throw new Error("recording_already_active");
    const worker = this.ensureWorker();
    if (!worker) throw new Error("recording_worker_unavailable");
    const id = crypto.randomUUID();
    const startedAt = requireEpochMillis(Date.now(), "agentRealtimeRecording.startedAt");
    const existing = await this.list();
    const name = `Recording ${existing.length + 1}`;
    const summary = await this.request<AgentRealtimeRecordingSummary>({ action: "start", recordingId: id, name, startedAt: Number(startedAt) });
    this.lastStoppedSummary = null;
    this.activeId = id;
    this.acceptingEvents = true;
    this.sequence = 0;
    this.peakQueuedBytes = 0;
    this.peakQueuedEntries = 0;
    this.lastRuntimeSnapshot = null;
    this.lastSampleAt = 0;
    this.durationTimer = setTimeout(() => void this.failActive("duration_limit"), MAX_RECORDING_DURATION_MS);
    this.sampleTimer = setInterval(() => {
      void this.captureSample().catch((error) => this.failActive(`sample_failed:${error.message}`));
    }, SAMPLE_INTERVAL_MS);
    try {
      await this.captureSample();
    } catch (error) {
      await this.failActive(`sample_failed:${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return summary;
  }

  append(input: AgentRealtimeDebugTraceInput) {
    if (!this.liveCaptureEnabled && (!this.activeId || !this.acceptingEvents)) return;
    const recordedAt = requireEpochMillis(Date.now(), "agentRealtimeRecording.event.recordedAt");
    if (this.liveCaptureEnabled) this.appendLiveEvent(input, recordedAt);
    if (!this.activeId || !this.acceptingEvents) return;
    const sequence = this.sequence + 1;
    const event = createTraceEntry(input, sequence, recordedAt);
    let bytes = 0;
    try {
      bytes = v8.serialize(event).byteLength;
    } catch {
      void this.failActive("event_serialization_failed");
      return;
    }
    if (bytes > MAX_RECORD_BYTES) {
      void this.failActive("record_too_large");
      return;
    }
    if (this.queuedEntries + 1 > MAX_QUEUE_ENTRIES || this.queuedBytes + bytes > MAX_QUEUE_BYTES) {
      void this.failActive("write_queue_limit");
      return;
    }
    this.sequence = sequence;
    this.queuedEntries += 1;
    this.queuedBytes += bytes;
    this.peakQueuedEntries = Math.max(this.peakQueuedEntries, this.queuedEntries);
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
    this.eventQueue.push({ event, bytes });
    if (this.eventQueue.length >= FLUSH_BATCH_SIZE) this.flushEvents();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushEvents(), FLUSH_INTERVAL_MS);
  }

  setLiveCaptureEnabled(enabled: boolean) {
    if (enabled === this.liveCaptureEnabled) return { ok: true };
    this.liveCaptureEnabled = enabled;
    this.liveSequence = 0;
    this.liveEventBytes = 0;
    this.liveEvents = [];
    return { ok: true };
  }

  queryLiveEvents(filter: AgentRealtimeRecordingEventFilter = {}): AgentRealtimeRecordingEventPage {
    const query = filter.query?.trim().toLocaleLowerCase();
    const filtered = this.liveEvents.filter((item) =>
      matchesAgentRealtimeEventFilter(item.summary, filter) &&
      (!query || item.searchText.includes(query) || eventDataIncludesQuery(item.event, query)));
    const ordered = filter.order === "asc" ? filtered : [...filtered].reverse();
    const cursor = Math.max(0, filter.cursor || 0);
    const limit = Math.min(MAX_LIVE_EVENT_PAGE_SIZE, Math.max(1, filter.limit || MAX_LIVE_EVENT_PAGE_SIZE));
    const items = ordered.slice(cursor, cursor + limit).map((item) => item.summary);
    return {
      items,
      total: ordered.length,
      ...(cursor + items.length < ordered.length ? { nextCursor: cursor + items.length } : {}),
    };
  }

  getLiveEvent(sequence: number) {
    return this.liveEvents.find((item) => item.event.sequence === sequence)?.event || null;
  }

  async stop() {
    if (this.finalizing) return this.finalizing;
    if (!this.activeId) {
      if (this.lastStoppedSummary) return this.lastStoppedSummary;
      throw new Error("recording_not_active");
    }
    this.acceptingEvents = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    try {
      await this.captureSample(true);
    } catch (error) {
      return this.finalize(`sample_failed:${error instanceof Error ? error.message : String(error)}`);
    }
    return this.finalize();
  }

  async list() {
    this.retryStaleSessionCleanup();
    const recordings = await this.request<AgentRealtimeRecordingSummary[]>({ action: "list" });
    return recordings.map((recording) => this.finalizing && recording.id === this.activeId
      ? { ...recording, state: "finalizing" as const }
      : recording);
  }

  queryEvents(recordingId: string, filter: AgentRealtimeRecordingEventFilter = {}) {
    return this.request<AgentRealtimeRecordingEventPage>({ action: "query-events", recordingId, filter });
  }

  getEvent(recordingId: string, sequence: number) {
    return this.request<AgentRealtimeDebugTraceEntry | null>({ action: "get-event", recordingId, sequence });
  }

  getSamples(recordingId: string, from?: number, to?: number) {
    return this.request<AgentRealtimeRecordingSample[]>({ action: "get-samples", recordingId, from, to });
  }

  delete(recordingId: string) {
    return this.request<{ ok: true }>({ action: "delete", recordingId });
  }

  async exportSource(recordingId: string) {
    const result = await this.request<{ filePath: string }>({ action: "export-source", recordingId });
    return result.filePath;
  }

  getPerformanceCounters() {
    return {
      queuedEntries: this.queuedEntries,
      queuedBytes: this.queuedBytes,
      peakQueuedEntries: this.peakQueuedEntries,
      peakQueuedBytes: this.peakQueuedBytes,
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.acceptingEvents = false;
    this.liveCaptureEnabled = false;
    this.liveEvents = [];
    this.liveEventBytes = 0;
    this.clearTimers();
    for (const pending of this.pendingRequests.values()) pending.reject(new Error("recording_controller_disposed"));
    this.pendingRequests.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    fs.rmSync(this.sessionRoot, { recursive: true, force: true });
  }

  private appendLiveEvent(
    input: AgentRealtimeDebugTraceInput,
    recordedAt: AgentRealtimeDebugTraceEntry["recordedAt"],
  ) {
    try {
      const event = sanitizeAgentRealtimeDebugTraceEntry(
        createTraceEntry(input, this.liveSequence + 1, recordedAt),
      );
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes > MAX_RECORD_BYTES || bytes > MAX_LIVE_EVENT_BYTES) return;
      const summary = summarizeAgentRealtimeEvent(event, bytes);
      this.liveSequence = event.sequence;
      this.liveEvents.push({
        event,
        summary,
        searchText: agentRealtimeEventSearchText(summary),
        bytes,
      });
      this.liveEventBytes += bytes;
      while (
        this.liveEvents.length > MAX_LIVE_EVENT_ENTRIES ||
        this.liveEventBytes > MAX_LIVE_EVENT_BYTES
      ) {
        const removed = this.liveEvents.shift();
        if (!removed) break;
        this.liveEventBytes -= removed.bytes;
      }
    } catch {
      // Live preview is best-effort and must never interrupt business traffic or an active recording.
    }
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath, { workerData: { root: this.sessionRoot } });
    worker.on("message", (response: RuntimeRecordingWorkerResponse) => {
      const pending = this.pendingRequests.get(response.requestId);
      if (!pending) return;
      this.pendingRequests.delete(response.requestId);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error || "recording_worker_failed"));
    });
    worker.on("error", (error) => {
      for (const pending of this.pendingRequests.values()) pending.reject(error);
      this.pendingRequests.clear();
      this.worker = null;
      if (!this.disposed) void this.failActive(`worker_error:${error.message}`);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0 && !this.disposed) void this.failActive(`worker_exit:${code}`);
    });
    this.worker = worker;
    return worker;
  }

  private request<T>(input: WorkerRequestInput): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("recording_controller_disposed"));
    const worker = this.ensureWorker();
    const requestId = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.postMessage({ ...input, requestId } satisfies RuntimeRecordingWorkerRequest);
    });
  }

  private flushEvents() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const recordingId = this.activeId;
    if (!recordingId || this.eventQueue.length === 0) return;
    const queued = this.eventQueue;
    this.eventQueue = [];
    const events = queued.map((item) => item.event);
    const bytes = queued.reduce((total, item) => total + item.bytes, 0);
    const request = this.request({ action: "append-events", recordingId, events });
    this.appendRequests.add(request);
    void request.catch((error: Error) => this.failActive(error.message)).finally(() => {
      this.appendRequests.delete(request);
      this.queuedEntries -= events.length;
      this.queuedBytes -= bytes;
    });
  }

  private async captureSample(force = false) {
    const recordingId = this.activeId;
    if (!recordingId || (!this.acceptingEvents && !force)) return;
    const requestedAt = Date.now();
    try {
      let snapshot: Pick<AgentRealtimeDebugSnapshot, "runtime" | "connections">;
      let error: string | undefined;
      try {
        snapshot = this.options.sampleSnapshot();
        this.lastRuntimeSnapshot = snapshot;
      } catch {
        if (!this.lastRuntimeSnapshot) throw new Error("runtime_sample_failed");
        snapshot = this.lastRuntimeSnapshot;
        error = "runtime_sample_failed";
      }
      const sampledAt = Date.now();
      const sample: AgentRealtimeRecordingSample = {
        sampledAt: requireEpochMillis(sampledAt, "agentRealtimeRecording.sample.sampledAt"),
        runtime: snapshot.runtime,
        connections: snapshot.connections,
        delayedByMs: force || this.lastSampleAt === 0
          ? Math.max(0, sampledAt - requestedAt)
          : Math.max(0, sampledAt - this.lastSampleAt - SAMPLE_INTERVAL_MS),
        ...(error ? { error } : {}),
      };
      await this.request({ action: "append-sample", recordingId, sample });
      this.lastSampleAt = sampledAt;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async failActive(reason: string) {
    if (!this.activeId || this.finalizing) return;
    await this.finalize(reason);
  }

  private finalize(incompleteReason?: string) {
    const recordingId = this.activeId;
    if (!recordingId) return Promise.reject(new Error("recording_not_active"));
    this.acceptingEvents = false;
    this.clearTimers();
    this.flushEvents();
    this.finalizing = (async () => {
      try {
        await Promise.allSettled([...this.appendRequests]);
        const summary = await this.request<AgentRealtimeRecordingSummary>({
          action: "stop",
          recordingId,
          endedAt: Date.now(),
          ...(incompleteReason ? { incompleteReason } : {}),
        });
        this.lastStoppedSummary = summary;
        return summary;
      } finally {
        this.activeId = null;
        this.finalizing = null;
      }
    })();
    return this.finalizing;
  }

  private clearTimers() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.flushTimer = null;
    this.sampleTimer = null;
    this.durationTimer = null;
  }

  private retryStaleSessionCleanup() {
    if (this.staleSessionRoots.length === 0) return;
    this.staleSessionRoots = this.staleSessionRoots.filter((staleRoot) => {
      try {
        fs.rmSync(staleRoot, { recursive: true, force: true });
        return false;
      } catch {
        return true;
      }
    });
    if (this.staleSessionRoots.length > 0) {
      throw new Error(`stale_recording_cleanup_failed:${this.staleSessionRoots.length}`);
    }
  }
}
