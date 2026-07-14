/**
 * Desktop's canonical representation for a concrete point in time.
 *
 * Values are Unix epoch milliseconds within the range supported by Date and
 * Intl.  Do not broaden this parser with numeric strings, ISO text,
 * date-string parsing or a clock fallback: malformed producers must be
 * diagnosed instead of silently changing local state.
 */
declare const epochMillisecondsBrand: unique symbol;

export type EpochMilliseconds = number & {
  readonly [epochMillisecondsBrand]: "EpochMilliseconds";
};

export const EPOCH_MILLIS_MIN = 0;
export const EPOCH_MILLIS_MAX = 8_640_000_000_000_000;

/**
 * agent-platform emits operational timestamps for contemporary runs, chats,
 * navigation and memory records. A positive Unix-seconds value is otherwise
 * indistinguishable from an early-1970 epoch-ms value, so this stricter
 * boundary rule deliberately rejects the seconds-sized values produced by a
 * unit-mismatched platform service. Zero remains a valid epoch-ms sentinel.
 */
export const AGENT_PLATFORM_EPOCH_MILLIS_MIN = 1_000_000_000_000;

export type TimeContractViolationReason = "missing" | "invalid";

export class TimeContractViolation extends Error {
  readonly code = "time_contract_violation";

  constructor(
    readonly field: string,
    readonly reason: TimeContractViolationReason = "invalid",
  ) {
    super(
      reason === "missing"
        ? `time_contract_violation: ${field} is required`
        : `time_contract_violation: ${field} must be a non-negative safe epoch-milliseconds integer`,
    );
    this.name = "TimeContractViolation";
  }
}

export function isEpochMilliseconds(value: unknown): value is EpochMilliseconds {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= EPOCH_MILLIS_MIN &&
    value <= EPOCH_MILLIS_MAX;
}

/**
 * Non-throwing compatibility reader for callers that intentionally discard
 * invalid optional data. New boundary parsers should use
 * parseOptionalEpochMillis() so malformed present values are reported.
 */
export function readEpochMillis(value: unknown): EpochMilliseconds | undefined {
  return isEpochMilliseconds(value) ? value : undefined;
}

export function assertEpochMillis(
  value: unknown,
  field: string,
): asserts value is EpochMilliseconds {
  if (value === undefined || value === null) {
    throw new TimeContractViolation(field, "missing");
  }
  if (!isEpochMilliseconds(value)) {
    throw new TimeContractViolation(field, "invalid");
  }
}

export function requireEpochMillis(value: unknown, field: string): EpochMilliseconds {
  assertEpochMillis(value, field);
  return value;
}

export function isAgentPlatformEpochMilliseconds(value: unknown): value is EpochMilliseconds {
  return isEpochMilliseconds(value) && (
    value === EPOCH_MILLIS_MIN || value >= AGENT_PLATFORM_EPOCH_MILLIS_MIN
  );
}

export function requireAgentPlatformEpochMillis(
  value: unknown,
  field: string,
): EpochMilliseconds {
  assertEpochMillis(value, field);
  if (!isAgentPlatformEpochMilliseconds(value)) {
    throw new TimeContractViolation(field, "invalid");
  }
  return value;
}

/**
 * Parses an optional epoch-ms field. Only null and undefined represent a
 * missing optional value; strings (including an empty string) are invalid.
 */
export function parseOptionalEpochMillis(
  value: unknown,
  field: string,
): EpochMilliseconds | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireEpochMillis(value, field);
}

/**
 * Parses optional values without collapsing an explicit JSON null into a
 * missing TypeScript property. This is used for IPC DTOs whose public shape
 * distinguishes `undefined` from `null`.
 */
export function parseOptionalNullableEpochMillis(
  value: unknown,
  field: string,
): EpochMilliseconds | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requireEpochMillis(value, field);
}

export function parseOptionalNullableAgentPlatformEpochMillis(
  value: unknown,
  field: string,
): EpochMilliseconds | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requireAgentPlatformEpochMillis(value, field);
}

const DEFAULT_LOCAL_DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * Formats an already-validated epoch-ms value for display in the renderer.
 * Runtime validation remains intentional because bridge data is untrusted at
 * process boundaries despite the branded TypeScript type.
 */
export function formatEpochMillis(
  value: EpochMilliseconds,
  locale?: string | string[],
  options: Intl.DateTimeFormatOptions = DEFAULT_LOCAL_DATE_TIME_FORMAT,
): string {
  assertEpochMillis(value, "formatEpochMillis");
  return new Intl.DateTimeFormat(locale, options).format(value);
}

export function isTimeContractViolation(error: unknown): error is TimeContractViolation {
  return error instanceof TimeContractViolation ||
    (error instanceof Error && error.message.startsWith("time_contract_violation:"));
}
