import type { AIAwaitSubmitPayloadData } from "@/app/state/types";

export const AWAITING_EXPIRED_MESSAGE =
  "该确认已过期，请重新发起或继续当前对话";

export function isAwaitingIdentityMismatch(
  activeAwaiting: { runId: string; awaitingId: string },
  payload: AIAwaitSubmitPayloadData,
): boolean {
  return (
    payload.runId !== activeAwaiting.runId ||
    payload.awaitingId !== activeAwaiting.awaitingId
  );
}

export function buildActiveAwaitingSubmitPayload(
  activeAwaiting: { runId: string; awaitingId: string },
  payload: AIAwaitSubmitPayloadData,
): AIAwaitSubmitPayloadData {
  return {
    ...payload,
    runId: activeAwaiting.runId,
    awaitingId: activeAwaiting.awaitingId,
  };
}

export function isExpiredAwaitingFailure(status: string, detail: string): boolean {
  const normalized = `${status} ${detail}`.toLowerCase();
  return (
    normalized.includes("unknown awaitingid") ||
    normalized.includes("unknown awaiting id") ||
    normalized.includes("awaiting not found") ||
    normalized.includes("runid does not match awaiting") ||
    normalized.includes("unmatched awaiting") ||
    status === "not_found" ||
    status === "already_resolved"
  );
}

export function getSubmitErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "");
}

/**
 * Extract `status` and `detail` from an ApiError's `.data` payload so
 * that `isExpiredAwaitingFailure` can match relay-side envelope fields
 * like `{ ok: false, status: "not_found", detail: "awaiting not found" }`
 * which would otherwise be lost because `ApiError.message` only carries
 * the top-level `msg` field (often just "error").
 */
export function extractSubmitErrorFields(error: unknown): {
  status: string;
  detail: string;
} {
  const fallback = { status: "", detail: getSubmitErrorText(error) };
  if (
    error != null &&
    typeof error === "object" &&
    "data" in error &&
    error.data != null &&
    typeof error.data === "object"
  ) {
    const data = error.data as Record<string, unknown>;
    return {
      status: typeof data.status === "string" ? data.status : fallback.status,
      detail:
        typeof data.detail === "string" && data.detail
          ? data.detail
          : typeof data.msg === "string" && data.msg
            ? data.msg
            : fallback.detail,
    };
  }
  return fallback;
}
