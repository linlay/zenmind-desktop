import {
  type AssistantAwaitingMode,
  type AssistantEvent,
  type AssistantRunEventType,
  type AssistantStartRunRequest
} from "../../../shared/contracts";
import { readString, readNumber } from "./bridge-values";
import { requireAgentPlatformEpochMillis, parseOptionalNullableAgentPlatformEpochMillis } from "../../../shared/time-contract";
import { readErrorPayloadText, readOutputTextFromRecord } from "./assistant-output-text";

export const STRUCTURED_PLATFORM_TIME_FIELDS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "resolvedAt",
  "timestamp",
  "expiresAt",
  "readAt",
  "lastAccessedAt",
] as const;

export function readAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = readString(value).trim().toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

export function readAwaitingPayloadMode(value: unknown): AssistantAwaitingMode | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const mode = readAwaitingPayloadMode(item);
      if (mode) {
        return mode;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return readAwaitingMode(record.mode) || readAwaitingPayloadMode(record.awaiting);
}

export function isPendingAwaitingPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(isPendingAwaitingPayload);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const type = readString(record.type).trim().toLowerCase();
  if (type === "awaiting.answered") {
    return false;
  }
  const status = readString(record.status).trim().toLowerCase();
  if (
    ["answered", "cancelled", "canceled", "completed", "done", "error", "failed", "resolved", "timeout"].includes(
      status
    )
  ) {
    return false;
  }
  if (record.hasPendingAwaiting === true || readNumber(record.awaitingCount) > 0) {
    return true;
  }
  if (record.hasPendingAwaiting === false) {
    return false;
  }
  return (
    type === "awaiting.asking" ||
    status === "awaiting" ||
    status === "pending" ||
    Boolean(readString(record.awaitingId)) ||
    isPendingAwaitingPayload(record.awaiting)
  );
}

export function readRequiredPlatformTimestamp(value: unknown, field: string) {
  return requireAgentPlatformEpochMillis(value, field);
}

export function readOptionalPlatformTimestamp(value: unknown, field: string) {
  return parseOptionalNullableAgentPlatformEpochMillis(value, field);
}

export function validatePresentPlatformTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PLATFORM_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      readOptionalPlatformTimestamp(record[field], `${path}.${field}`);
    }
  }
}

export function validateAwaitingPayloadTimes(value: unknown, path: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateAwaitingPayloadTimes(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  validatePresentPlatformTimes(record, path);
  if (record.awaiting !== undefined) {
    validateAwaitingPayloadTimes(record.awaiting, `${path}.awaiting`);
  }
}

export function normalizeAwaitingPayload(value: unknown, path: string): AssistantEvent["awaiting"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  validateAwaitingPayloadTimes(record, path);
  const createdAt = readOptionalPlatformTimestamp(record.createdAt, `${path}.createdAt`);
  return {
    ...(record as Omit<NonNullable<AssistantEvent["awaiting"]>, "createdAt">),
    ...(createdAt !== undefined ? { createdAt } : {})
  } as AssistantEvent["awaiting"];
}

export function isPlatformEventType(type: string): type is AssistantRunEventType {
  return Boolean(type);
}

export function normalizePlatformEvent(raw: Record<string, unknown>, fallback: {
  runId: string;
  chatId: string;
  source?: AssistantStartRunRequest["source"];
}, path: string): AssistantEvent | null {
  const type = readString(raw.type);
  if (!type) {
    return null;
  }
  validatePresentPlatformTimes(raw, path);
  const timestamp = readRequiredPlatformTimestamp(raw.timestamp, `${path}.timestamp`);
  const runId = readString(raw.runId) || fallback.runId;
  const chatId = readString(raw.chatId) || fallback.chatId;
  const errorText = readErrorPayloadText(raw.error);
  const outputText = readOutputTextFromRecord(raw);
  const message = outputText || readString(raw.message) || readString(raw.msg) || errorText;
  const delta = readString(raw.delta) || (type === "content.delta" ? outputText || readString(raw.message) : "");
  const awaitingMode = readAwaitingMode(raw.mode);
  const event: AssistantEvent = {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.seq === "number" ? { seq: raw.seq } : {}),
    runId,
    chatId,
    type: isPlatformEventType(type) ? type : "content.delta",
    createdAt: timestamp,
    ...(fallback.source ? { source: fallback.source } : {}),
    ...(typeof raw.status === "string" ? { status: raw.status as AssistantEvent["status"] } : {}),
    ...(delta ? { delta } : {}),
    ...(message ? { message } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
    ...(typeof raw.action === "string" ? { action: raw.action } : {}),
    ...(typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(typeof raw.awaitingId === "string" ? { awaitingId: raw.awaitingId } : {}),
    ...(awaitingMode ? { mode: awaitingMode } : {}),
    ...(typeof raw.viewportType === "string" ? { viewportType: raw.viewportType } : {}),
    ...(typeof raw.viewportKey === "string" ? { viewportKey: raw.viewportKey } : {}),
    ...(typeof raw.timeout === "number" || raw.timeout === null ? { timeout: raw.timeout } : {}),
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
    timestamp,
    ...(Array.isArray(raw.questions) ? { questions: raw.questions as AssistantEvent["questions"] } : {}),
    ...(Array.isArray(raw.approvals) ? { approvals: raw.approvals as AssistantEvent["approvals"] } : {}),
    ...(Array.isArray(raw.forms) ? { forms: raw.forms as AssistantEvent["forms"] } : {}),
    ...(typeof raw.artifactCount === "number" ? { artifactCount: raw.artifactCount } : {}),
    ...(Array.isArray(raw.artifacts) ? { artifacts: raw.artifacts } : {}),
    ...(raw.data !== undefined ? { data: raw.data } : {})
  };
  if (typeof raw.awaiting === "object" && raw.awaiting !== null) {
    const awaiting = normalizeAwaitingPayload(raw.awaiting, `${path}.awaiting`);
    if (awaiting) {
      event.awaiting = awaiting;
    }
  }
  return event;
}

export function isAssistantRunTerminalEvent(event: AssistantEvent) {
  return (
    event.type === "done" ||
    event.type === "run.complete" ||
    event.type === "error" ||
    event.type === "stopped" ||
    event.type === "run.error" ||
    event.type === "run.cancel" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.type === "run.expired"
  );
}
