import type {
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeRecordingEventFilter,
  AgentRealtimeRecordingEventSummary,
} from "../../../../shared/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function unwrapEventData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.type === "frame" && isRecord(value.frame)) return unwrapEventData(value.frame);
  return value;
}

function deepFindString(value: unknown, keys: Set<string>, depth = 0): string {
  if (!isRecord(value) || depth > 5) return "";
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const text = readString(item);
      if (text) return text;
    }
  }
  for (const item of Object.values(value)) {
    const found = deepFindString(item, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function eventName(entry: AgentRealtimeDebugTraceEntry) {
  const data = unwrapEventData(entry.data);
  const nestedEvent = isRecord(data.event) ? data.event : {};
  return [nestedEvent.type, data.event, data.method, data.kind, data.type, data.frame]
    .map(readString)
    .find(Boolean) || "event";
}

export function summarizeAgentRealtimeEvent(
  entry: AgentRealtimeDebugTraceEntry,
  size: number,
): AgentRealtimeRecordingEventSummary {
  const data = unwrapEventData(entry.data);
  const name = eventName(entry);
  const requestId = readString(data.requestId) || deepFindString(data, new Set(["requestid", "id"]));
  const upstreamRequestId = readString(data.upstreamRequestId) || deepFindString(data, new Set(["upstreamid", "upstreamrequestid"]));
  const runId = deepFindString(data, new Set(["runid"]));
  const chatId = deepFindString(data, new Set(["chatid"]));
  const laneValue = readString(data.lane);
  const lane = laneValue === "primary" || laneValue === "btw" ? laneValue : undefined;
  const code = typeof data.code === "number" ? data.code : 0;
  const isError = entry.direction.includes("error") || code >= 400 || /error|fail|reject|crash/iu.test(name);
  const associations = [requestId, upstreamRequestId, runId, chatId].filter(Boolean);
  return {
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    layer: entry.layer,
    direction: entry.direction,
    name,
    summary: associations.length ? `${name} · ${associations.join(" · ")}` : name,
    size,
    isError,
    ...(lane ? { lane } : {}),
    ...(entry.surfaceId ? { surfaceId: entry.surfaceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(runId ? { runId } : {}),
    ...(chatId ? { chatId } : {}),
  };
}

export function agentRealtimeEventSearchText(summary: AgentRealtimeRecordingEventSummary) {
  return [summary.name, summary.summary, summary.surfaceId, summary.layer, summary.direction]
    .join(" ").toLocaleLowerCase();
}

export function matchesAgentRealtimeEventFilter(
  summary: AgentRealtimeRecordingEventSummary,
  filter: AgentRealtimeRecordingEventFilter,
) {
  if (filter.layer && summary.layer !== filter.layer) return false;
  if (filter.direction && summary.direction !== filter.direction) return false;
  if (filter.lane && summary.lane !== filter.lane) return false;
  if (filter.surfaceId && summary.surfaceId !== filter.surfaceId) return false;
  if (filter.eventName && summary.name !== filter.eventName) return false;
  if (filter.errorsOnly && !summary.isError) return false;
  if (filter.from && Number(summary.recordedAt) < Number(filter.from)) return false;
  if (filter.to && Number(summary.recordedAt) > Number(filter.to)) return false;
  const association = filter.associationId?.trim().toLocaleLowerCase();
  return !association || [summary.requestId, summary.upstreamRequestId, summary.runId, summary.chatId]
    .some((value) => value?.toLocaleLowerCase().includes(association));
}

export function eventDataIncludesQuery(entry: AgentRealtimeDebugTraceEntry, query: string) {
  return JSON.stringify(entry.data).toLocaleLowerCase().includes(query);
}
