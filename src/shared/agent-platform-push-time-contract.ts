import type { EpochMilliseconds } from "./time-contract";
import { isAgentPlatformEpochMilliseconds } from "./time-contract";

type ObjectRecord = Record<string, unknown>;

const REQUIRED_PUSH_TIME_FIELDS: Readonly<Record<string, string>> = {
  heartbeat: "timestamp",
  "auth.expiring": "expiresAt",
  "run.started": "startedAt",
  "run.start": "startedAt",
  "run.finished": "finishedAt",
  "run.complete": "finishedAt",
  "chat.created": "createdAt",
  "chat.updated": "updatedAt",
  "chat.unread": "createdAt",
  "chat.read": "readAt",
  "catalog.updated": "updatedAt",
  "awaiting.asking": "createdAt",
  "awaiting.answered": "answeredAt",
  "resource.pushed": "pushedAt",
};

const STRUCTURED_PUSH_TIME_FIELDS = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "completedAt",
  "lastRunAt",
  "archivedAt",
  "answeredAt",
  "resolvedAt",
  "timestamp",
  "expiresAt",
  "readAt",
  "pushedAt",
] as const;

const ARCHIVE_RESTORED_REQUIRED_SUMMARY_FIELDS = [
  "createdAt",
  "updatedAt",
  "lastRunAt",
  "archivedAt",
] as const;

function isObjectRecord(value: unknown): value is ObjectRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findInvalidStructuredPushTime(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const invalid = findInvalidStructuredPushTime(item, `${path}[${index}]`);
      if (invalid) {
        return invalid;
      }
    }
    return undefined;
  }
  if (!isObjectRecord(value)) {
    return undefined;
  }

  for (const field of STRUCTURED_PUSH_TIME_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && fieldValue !== null && !isAgentPlatformEpochMilliseconds(fieldValue)) {
      return path ? `${path}.${field}` : field;
    }
  }

  for (const field of ["awaiting", "summary"] as const) {
    if (value[field] !== undefined) {
      const invalid = findInvalidStructuredPushTime(value[field], path ? `${path}.${field}` : field);
      if (invalid) {
        return invalid;
      }
    }
  }
  return undefined;
}

export function getAgentPlatformPushTimeField(type: string): string | undefined {
  return REQUIRED_PUSH_TIME_FIELDS[type];
}

export function readAgentPlatformPushEpochMillis(
  type: string,
  data: unknown,
): EpochMilliseconds | undefined {
  const field = getAgentPlatformPushTimeField(type);
  if (!field || !isObjectRecord(data)) {
    return undefined;
  }
  const value = data[field];
  return isAgentPlatformEpochMilliseconds(value) ? value : undefined;
}

/**
 * Validates only agent-platform WebSocket `frame: "push"` payloads. Stream
 * events deliberately keep their independent `event.timestamp` contract.
 */
export function validateAgentPlatformPushTimeContract(type: string, data: unknown): string | undefined {
  const payload = isObjectRecord(data) ? data : {};
  if (type !== "heartbeat" && Object.hasOwn(payload, "timestamp")) {
    return "timestamp";
  }

  const invalidPresentField = findInvalidStructuredPushTime(payload);
  if (invalidPresentField) {
    return invalidPresentField;
  }

  const requiredField = getAgentPlatformPushTimeField(type);
  if (requiredField && !isAgentPlatformEpochMilliseconds(payload[requiredField])) {
    return requiredField;
  }

  if (type !== "archive.restored") {
    return undefined;
  }
  const summary = payload.summary;
  if (!isObjectRecord(summary)) {
    return "summary";
  }
  for (const field of ARCHIVE_RESTORED_REQUIRED_SUMMARY_FIELDS) {
    if (!isAgentPlatformEpochMilliseconds(summary[field])) {
      return `summary.${field}`;
    }
  }
  return undefined;
}
