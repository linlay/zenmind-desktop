const AGENT_PLATFORM_EPOCH_MILLIS_MIN = 1_000_000_000_000;
const AGENT_PLATFORM_EPOCH_MILLIS_MAX = Number.MAX_SAFE_INTEGER;

// This is the public field classifier used by agent-platform's JSON time
// contract. Keep it narrow: date/time text under unrelated field names is
// business data and must not be rewritten by the Desktop action bridge.
function isAgentPlatformTimePointField(field: string) {
  return (field.endsWith("At") && field !== "triggeredAt") ||
    field.endsWith("UnixMs") ||
    field === "timestamp" ||
    field === "ts" ||
    field === "mtimeMs";
}

function isAgentPlatformEpochMilliseconds(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= AGENT_PLATFORM_EPOCH_MILLIS_MIN &&
    value <= AGENT_PLATFORM_EPOCH_MILLIS_MAX;
}

function parseAgentPlatformIsoTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  // Date.parse accepts many locale-dependent formats. The bridge must only
  // convert the RFC3339/ISO instants it can represent without ambiguity.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
  if (!parts) {
    return undefined;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    month < 1 || month > 12 ||
    day < 1 || day > maxDay ||
    hour > 23 || minute > 59 || second > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
  ) {
    return undefined;
  }
  const timestamp = Date.parse(text);
  return isAgentPlatformEpochMilliseconds(timestamp) ? timestamp : undefined;
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Normalizes a Desktop action response for the agent-platform tool contract.
 * The operation is non-mutating and intentionally converts only valid ISO
 * strings in agent-platform semantic time fields. Invalid strings, numeric
 * strings and second-based values remain untouched so the consumer can report
 * its normal time-contract violation instead of Desktop guessing a value.
 */
export function normalizeActionBridgeTimePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeActionBridgeTimePayload);
  }
  if (!value || typeof value !== "object" || !isPlainJsonObject(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    const timestamp = isAgentPlatformTimePointField(field)
      ? parseAgentPlatformIsoTimestamp(item)
      : undefined;
    normalized[field] = timestamp === undefined
      ? normalizeActionBridgeTimePayload(item)
      : timestamp;
  }
  return normalized;
}
