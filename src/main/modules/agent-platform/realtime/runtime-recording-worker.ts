import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type {
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeRecordingEventFilter,
  AgentRealtimeRecordingEventSummary,
  AgentRealtimeRecordingSample,
  AgentRealtimeRecordingSummary,
} from "../../../../shared/contracts";
import type { RuntimeRecordingWorkerRequest, RuntimeRecordingWorkerResponse } from "./runtime-recording-protocol";
import {
  agentRealtimeEventSearchText,
  eventDataIncludesQuery,
  matchesAgentRealtimeEventFilter,
  summarizeAgentRealtimeEvent,
} from "./runtime-event-query";
import { sanitizeAgentRealtimeDebugTraceEntry } from "./realtime-debug-trace";

const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_SIZE = 200;

type EventIndex = AgentRealtimeRecordingEventSummary & { offset: number; length: number; searchText: string };
type Recording = {
  summary: AgentRealtimeRecordingSummary;
  filePath: string;
  events: EventIndex[];
  eventBySequence: Map<number, EventIndex>;
  samples: AgentRealtimeRecordingSample[];
};

const root = String((workerData as { root: string }).root);
const recordings = new Map<string, Recording>();
fs.mkdirSync(root, { recursive: true, mode: 0o700 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function appendLine(recording: Recording, value: unknown, options: { allowLimitFooter?: boolean } = {}) {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_RECORD_BYTES) throw new Error("record_too_large");
  if (!options.allowLimitFooter) {
    if (recording.summary.bytes + bytes > MAX_RECORDING_BYTES) throw new Error("recording_size_limit");
    const totalBytes = [...recordings.values()].reduce((total, item) => total + item.summary.bytes, 0);
    if (totalBytes + bytes > MAX_TOTAL_BYTES) throw new Error("session_size_limit");
  }
  const offset = recording.summary.bytes;
  fs.appendFileSync(recording.filePath, line, { encoding: "utf8", mode: 0o600 });
  recording.summary.bytes += bytes;
  return { offset, length: bytes };
}

function requireRecording(id: string) {
  const recording = recordings.get(id);
  if (!recording) throw new Error("recording_not_found");
  return recording;
}

function requireMutableRecording(id: string) {
  const recording = requireRecording(id);
  if (recording.summary.state !== "recording") throw new Error("recording_not_active");
  return recording;
}

function finalizeIncomplete(recording: Recording, reason: string) {
  if (recording.summary.state !== "recording") return;
  recording.summary.state = "incomplete";
  recording.summary.endedAt = Date.now() as AgentRealtimeRecordingSummary["endedAt"];
  recording.summary.incompleteReason = reason;
  try {
    appendLine(recording, { kind: "end", endedAt: recording.summary.endedAt, state: "incomplete", reason }, { allowLimitFooter: true });
  } catch {
    // Preserve the readable prefix when the storage failure also prevents a footer.
  }
}

function readEvent(recording: Recording, index: EventIndex) {
  const descriptor = fs.openSync(recording.filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(index.length);
    fs.readSync(descriptor, buffer, 0, index.length, index.offset);
    const parsed = JSON.parse(buffer.toString("utf8")) as { event?: AgentRealtimeDebugTraceEntry };
    return parsed.event ?? null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function eventContentIncludes(recording: Recording, index: EventIndex, search: string) {
  const event = readEvent(recording, index);
  return event ? eventDataIncludesQuery(event, search) : false;
}

async function queryEvents(recording: Recording, filter: AgentRealtimeRecordingEventFilter) {
  const candidates = recording.events.filter((item) => matchesAgentRealtimeEventFilter(item, filter));
  const query = filter.query?.trim().toLocaleLowerCase();
  const filtered: EventIndex[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!query || candidate.searchText.includes(query) || eventContentIncludes(recording, candidate, query)) {
      filtered.push(candidate);
    }
    if (query && index > 0 && index % 64 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const cursor = Math.max(0, filter.cursor || 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, filter.limit || MAX_PAGE_SIZE));
  const ordered = filter.order === "desc" ? filtered.reverse() : filtered;
  const items = ordered.slice(cursor, cursor + limit)
    .map(({ offset: _offset, length: _length, searchText: _searchText, ...item }) => item);
  return {
    items,
    total: ordered.length,
    ...(cursor + items.length < ordered.length ? { nextCursor: cursor + items.length } : {}),
  };
}

function loadExistingRecordings() {
  for (const fileName of fs.readdirSync(root).filter((name) => name.endsWith(".jsonl"))) {
    const filePath = path.join(root, fileName);
    const buffer = fs.readFileSync(filePath);
    let offset = 0;
    let recording: Recording | null = null;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset);
      const end = newline === -1 ? buffer.length : newline + 1;
      const length = end - offset;
      try {
        const record = JSON.parse(buffer.subarray(offset, newline === -1 ? end : newline).toString("utf8")) as Record<string, unknown>;
        if (record.kind === "header") {
          const id = readString(record.id);
          recording = {
            summary: {
              id,
              name: readString(record.name) || "Recording",
              state: "recording",
              startedAt: Number(record.startedAt) as AgentRealtimeRecordingSummary["startedAt"],
              eventCount: 0,
              sampleCount: 0,
              bytes: buffer.length,
              errorCount: 0,
              lastSequence: 0,
              layerCounts: {},
              directionCounts: {},
              eventTypeCounts: {},
            },
            filePath,
            events: [],
            eventBySequence: new Map(),
            samples: [],
          };
          recordings.set(id, recording);
        } else if (recording && record.kind === "event" && isRecord(record.event)) {
          const event = record.event as unknown as AgentRealtimeDebugTraceEntry;
          const summary = summarizeAgentRealtimeEvent(event, length);
          const index = {
            ...summary,
            offset,
            length,
            searchText: agentRealtimeEventSearchText(summary),
          };
          recording.events.push(index);
          recording.eventBySequence.set(event.sequence, index);
          recording.summary.eventCount += 1;
          recording.summary.lastSequence = event.sequence;
          if (summary.isError) recording.summary.errorCount += 1;
          recording.summary.layerCounts[summary.layer] = (recording.summary.layerCounts[summary.layer] || 0) + 1;
          recording.summary.directionCounts[summary.direction] = (recording.summary.directionCounts[summary.direction] || 0) + 1;
          recording.summary.eventTypeCounts[summary.name] = (recording.summary.eventTypeCounts[summary.name] || 0) + 1;
        } else if (recording && record.kind === "sample" && isRecord(record.sample)) {
          recording.samples.push(record.sample as unknown as AgentRealtimeRecordingSample);
          recording.summary.sampleCount += 1;
        } else if (recording && record.kind === "end") {
          recording.summary.state = record.state === "completed" ? "completed" : "incomplete";
          recording.summary.endedAt = Number(record.endedAt) as AgentRealtimeRecordingSummary["endedAt"];
          const reason = readString(record.reason);
          if (reason) recording.summary.incompleteReason = reason;
        }
      } catch {
        if (recording) {
          recording.summary.state = "incomplete";
          recording.summary.incompleteReason = "recording_file_corrupted";
        }
      }
      offset = end;
    }
    if (recording?.summary.state === "recording") {
      recording.summary.incompleteReason = "worker_restarted";
    }
  }
}

function handle(request: RuntimeRecordingWorkerRequest): unknown {
  if (request.action === "start") {
    if ([...recordings.values()].some((item) => item.summary.state === "recording")) {
      throw new Error("recording_already_active");
    }
    const filePath = path.join(root, `${request.recordingId}.jsonl`);
    const recording: Recording = {
      summary: {
        id: request.recordingId,
        name: request.name,
        state: "recording",
        startedAt: request.startedAt as AgentRealtimeRecordingSummary["startedAt"],
        eventCount: 0,
        sampleCount: 0,
        bytes: 0,
        errorCount: 0,
        lastSequence: 0,
        layerCounts: {},
        directionCounts: {},
        eventTypeCounts: {},
      },
      filePath,
      events: [],
      eventBySequence: new Map(),
      samples: [],
    };
    recordings.set(request.recordingId, recording);
    appendLine(recording, { kind: "header", schemaVersion: 1, id: request.recordingId, name: request.name, startedAt: request.startedAt });
    return recording.summary;
  }
  if (request.action === "append-events") {
    const recording = requireMutableRecording(request.recordingId);
    try {
      for (const rawEvent of request.events) {
        const event = sanitizeAgentRealtimeDebugTraceEntry(rawEvent);
        if (event.sequence !== recording.summary.lastSequence + 1) throw new Error("non_contiguous_sequence");
        const json = JSON.stringify({ kind: "event", event });
        const size = Buffer.byteLength(json) + 1;
        const summary = summarizeAgentRealtimeEvent(event, size);
        const location = appendLine(recording, { kind: "event", event });
        const searchText = agentRealtimeEventSearchText(summary);
        const index = { ...summary, ...location, searchText };
        recording.events.push(index);
        recording.eventBySequence.set(event.sequence, index);
        recording.summary.eventCount += 1;
        recording.summary.lastSequence = event.sequence;
        if (summary.isError) recording.summary.errorCount += 1;
        recording.summary.layerCounts[summary.layer] = (recording.summary.layerCounts[summary.layer] || 0) + 1;
        recording.summary.directionCounts[summary.direction] = (recording.summary.directionCounts[summary.direction] || 0) + 1;
        recording.summary.eventTypeCounts[summary.name] = (recording.summary.eventTypeCounts[summary.name] || 0) + 1;
      }
    } catch (error) {
      finalizeIncomplete(recording, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return recording.summary;
  }
  if (request.action === "append-sample") {
    const recording = requireMutableRecording(request.recordingId);
    try {
      appendLine(recording, { kind: "sample", sample: request.sample });
      recording.samples.push(request.sample);
      recording.summary.sampleCount += 1;
    } catch (error) {
      finalizeIncomplete(recording, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return recording.summary;
  }
  if (request.action === "stop") {
    const recording = requireRecording(request.recordingId);
    if (recording.summary.state === "completed" || recording.summary.state === "incomplete") return recording.summary;
    recording.summary.state = request.incompleteReason ? "incomplete" : "completed";
    recording.summary.endedAt = request.endedAt as AgentRealtimeRecordingSummary["endedAt"];
    if (request.incompleteReason) recording.summary.incompleteReason = request.incompleteReason;
    appendLine(recording, {
      kind: "end",
      endedAt: request.endedAt,
      state: recording.summary.state,
      ...(request.incompleteReason ? { reason: request.incompleteReason } : {}),
    }, { allowLimitFooter: true });
    return recording.summary;
  }
  if (request.action === "list") {
    return [...recordings.values()].map((item) => item.summary).sort((a, b) => Number(b.startedAt) - Number(a.startedAt));
  }
  if (request.action === "query-events") {
    const recording = requireRecording(request.recordingId);
    return queryEvents(recording, request.filter);
  }
  if (request.action === "get-event") {
    const recording = requireRecording(request.recordingId);
    const index = recording.eventBySequence.get(request.sequence);
    return index ? readEvent(recording, index) : null;
  }
  if (request.action === "get-samples") {
    const recording = requireRecording(request.recordingId);
    return recording.samples.filter((sample) =>
      (!request.from || Number(sample.sampledAt) >= request.from) &&
      (!request.to || Number(sample.sampledAt) <= request.to));
  }
  if (request.action === "delete") {
    const recording = requireRecording(request.recordingId);
    if (recording.summary.state === "recording" || recording.summary.state === "finalizing") throw new Error("recording_is_active");
    fs.unlinkSync(recording.filePath);
    recordings.delete(request.recordingId);
    return { ok: true };
  }
  const recording = requireRecording(request.recordingId);
  if (recording.summary.state === "recording" || recording.summary.state === "finalizing") throw new Error("recording_is_active");
  return { filePath: recording.filePath };
}

loadExistingRecordings();
if (!parentPort) throw new Error("runtime recording worker requires a parent port");
parentPort.on("message", async (request: RuntimeRecordingWorkerRequest) => {
  let response: RuntimeRecordingWorkerResponse;
  try {
    response = { requestId: request.requestId, ok: true, value: await handle(request) };
  } catch (error) {
    response = { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(response);
});
