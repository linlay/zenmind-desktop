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
    throw new Error(`time_contract_violation: ${field} must be epoch_ms_int64`);
  }
  return timestamp;
}
