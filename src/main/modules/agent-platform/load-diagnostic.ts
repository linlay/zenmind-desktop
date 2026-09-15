// Production diagnostics deliberately accept no URL, payload, token or error message.
// A single slow warning also fires when an operation never settles.
let nextId = 0;
export function beginPlatformLoadDiagnostic(
  operation: "availability" | "/api/chat" | "/api/agents",
  connection?: () => { phase: string; generation: number; reconnectCount: number },
) {
  const id = ++nextId;
  const startedAt = performance.now();
  let stage = "started";
  let stageStartedAt = startedAt;
  let finished = false;
  let slow = false;
  let serviceStatus: string | undefined;
  const stages: Record<string, number> = {};
  const elapsed = (since: number) => Math.max(0, Math.round(performance.now() - since));
  const write = (status: string, code?: number) => {
    const state = connection?.();
    console.warn("[platform-load]", {
      id, operation, platform: process.platform,
      uptimeMs: Math.round(process.uptime() * 1000),
      stage, status, elapsedMs: elapsed(startedAt),
      stageElapsedMs: elapsed(stageStartedAt), stages: { ...stages },
      ...(serviceStatus ? { serviceStatus } : {}),
      ...(state ? { connectionPhase: state.phase, generation: state.generation, reconnectCount: state.reconnectCount } : {}),
      ...(code === undefined ? {} : { code }),
    });
  };
  const timer = setTimeout(() => { slow = true; write("waiting"); }, 5000);
  timer.unref();
  return {
    serviceState(status: import("../../../shared/contracts").ServiceState["status"]) { serviceStatus = status; },
    next(nextStage: "service-state" | "access-token" | "availability" | "broker-response") {
      if (finished) return;
      stages[stage] = elapsed(stageStartedAt);
      stage = nextStage;
      stageStartedAt = performance.now();
    },
    end(status: "succeeded" | "failed" | "cancelled", code?: number) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (slow || elapsed(startedAt) >= 5000 || status === "failed") write(status, code);
    },
  };
}
