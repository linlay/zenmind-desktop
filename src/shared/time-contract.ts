/**
 * Boundary validation for agent-platform structured time points.
 *
 * The platform wire contract deliberately accepts only safe Unix epoch
 * milliseconds.  Do not broaden this parser with numeric strings, ISO text,
 * seconds, or Date.parse(): a malformed producer must be diagnosed instead
 * of silently changing local UI state.
 */
export const EPOCH_MILLIS_MIN = 1_000_000_000_000;
export const EPOCH_MILLIS_MAX = Number.MAX_SAFE_INTEGER;

export class TimeContractViolation extends Error {
  readonly code = "time_contract_violation";

  constructor(readonly field: string) {
    super(`time_contract_violation: ${field} must be epoch_ms_int64`);
    this.name = "TimeContractViolation";
  }
}

export function readEpochMillis(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= EPOCH_MILLIS_MIN &&
    value <= EPOCH_MILLIS_MAX
    ? value
    : undefined;
}

export function requireEpochMillis(value: unknown, field: string): number {
  const timestamp = readEpochMillis(value);
  if (timestamp === undefined) {
    throw new TimeContractViolation(field);
  }
  return timestamp;
}

export function isTimeContractViolation(error: unknown): error is TimeContractViolation {
  return error instanceof TimeContractViolation ||
    (error instanceof Error && error.message.startsWith("time_contract_violation:"));
}
