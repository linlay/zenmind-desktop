export const DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 120;
export const MAX_CONFIRMATION_TIMEOUT_SECONDS = 600;

export function normalizeConfirmationTimeoutSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CONFIRMATION_TIMEOUT_SECONDS, Math.max(1, Math.trunc(value)))
    : DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
}
