import {
  buildActiveAwaitingSubmitPayload,
  extractSubmitErrorFields,
  getSubmitErrorText,
  isAwaitingIdentityMismatch,
  isExpiredAwaitingFailure,
} from "@/features/tools/lib/awaitingSubmit";

describe("awaiting submit helpers", () => {
  it("detects stale awaiting identities before submit", () => {
    expect(
      isAwaitingIdentityMismatch(
        { runId: "run_1", awaitingId: "await_1" },
        { runId: "run_1", awaitingId: "await_1", params: [] },
      ),
    ).toBe(false);

    expect(
      isAwaitingIdentityMismatch(
        { runId: "run_1", awaitingId: "await_1" },
        { runId: "run_2", awaitingId: "await_1", params: [] },
      ),
    ).toBe(true);

    expect(
      isAwaitingIdentityMismatch(
        { runId: "run_1", awaitingId: "await_1" },
        { runId: "run_1", awaitingId: "await_2", params: [] },
      ),
    ).toBe(true);
  });

  it("repairs stale form identity with the active awaiting identity", () => {
    expect(
      buildActiveAwaitingSubmitPayload(
        { runId: "run_current", awaitingId: "await_current" },
        {
          runId: "run_stale",
          awaitingId: "await_stale",
          params: [{ id: "topic", answer: "周边游" }],
        },
      ),
    ).toEqual({
      runId: "run_current",
      awaitingId: "await_current",
      params: [{ id: "topic", answer: "周边游" }],
    });
  });

  it("treats known stale awaiting failures as recoverable", () => {
    expect(isExpiredAwaitingFailure("already_resolved", "")).toBe(true);
    expect(isExpiredAwaitingFailure("not_found", "awaiting not found")).toBe(true);
    expect(isExpiredAwaitingFailure("not_found", "runId does not match awaiting")).toBe(true);
    expect(isExpiredAwaitingFailure("unmatched", "unknown awaitingId")).toBe(true);
    expect(isExpiredAwaitingFailure("", "unmatched awaiting id")).toBe(true);
    expect(isExpiredAwaitingFailure("unmatched", "missing answer")).toBe(false);
  });

  it("normalizes thrown submit errors", () => {
    expect(getSubmitErrorText("unknown awaitingId")).toBe("unknown awaitingId");
    expect(getSubmitErrorText(new Error("boom"))).toBe("boom");
    expect(getSubmitErrorText(null)).toBe("");
  });

  it("extracts status and detail from ApiError-like objects", () => {
    // Relay-style error: ApiError.data contains the actual diagnostics
    const relayError = Object.assign(new Error("error"), {
      data: { ok: false, accepted: false, status: "not_found", detail: "awaiting not found" },
    });
    const { status, detail } = extractSubmitErrorFields(relayError);
    expect(status).toBe("not_found");
    expect(detail).toBe("awaiting not found");
    // And isExpiredAwaitingFailure should match
    expect(isExpiredAwaitingFailure(status, detail)).toBe(true);
  });

  it("falls back to error.message when data has no status/detail", () => {
    const plainError = new Error("unknown awaitingId");
    const { status, detail } = extractSubmitErrorFields(plainError);
    expect(status).toBe("");
    expect(detail).toBe("unknown awaitingId");
    expect(isExpiredAwaitingFailure(status, detail)).toBe(true);
  });

  it("handles non-Error objects gracefully", () => {
    const { status, detail } = extractSubmitErrorFields("some string error");
    expect(status).toBe("");
    expect(detail).toBe("some string error");
  });

  it("handles ApiError with data.msg instead of detail", () => {
    const wsError = Object.assign(new Error("error"), {
      data: { status: "not_found", msg: "awaiting not found" },
    });
    const { status, detail } = extractSubmitErrorFields(wsError);
    expect(status).toBe("not_found");
    expect(detail).toBe("awaiting not found");
  });
});

