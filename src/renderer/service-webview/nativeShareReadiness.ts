export type NativeShareSurfaceState = "waiting" | "ready" | "stale";

/** A matching guest may mount before its Main Chat registration commits. */
export async function waitForNativeShareSurfaceCommit(
  readState: () => NativeShareSurfaceState,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const state = readState();
    if (state !== "waiting") return state === "ready";
    if (performance.now() >= deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}
