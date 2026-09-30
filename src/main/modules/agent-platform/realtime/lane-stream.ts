import type { AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import { type BrokerRun, type QueryTransaction, type RealtimeLane, type RootObserverState, type RunSubscription, frameError, isRecord, isTerminalEvent, readText, REQUEST_TIMEOUT_MS } from "./realtime-broker.shared";

type LaneStream = {
  requestId: string;
  runId: string;
  chatId: string;
  consumerId: string;
  observerToken: string;
  surfaceId?: string;
  observerKind?: string;
  observerGeneration?: string;
  connectionGeneration: number;
  operation: string;
  since: number;
  state: "reserving" | "attached" | "ending" | "detaching" | "release_unconfirmed";
  lastDetachError?: string;
  releaseListeners: Set<() => void>;
};

/** The physical stream slot outlives local query cancellation and Run completion Push. */
export class LaneStreams {
  private readonly slots = new Map<RealtimeLane, LaneStream>();
  constructor(private readonly deps: {
    runs: Map<string, BrokerRun>;
    queries: Map<string, QueryTransaction>;
    subscriptions: Map<string, RunSubscription>;
    findObserver(token: string): RootObserverState | null;
    onDiagnostic?(message: string): void;
  }) {}

  snapshot(lane: RealtimeLane) {
    const slot = this.slots.get(lane);
    if (!slot) return null;
    const run = [...this.deps.runs.values()].find((run) => run.lane === lane && run.runId === slot.runId);
    const observers = [...(run?.rootObserverTokens ?? (slot.observerToken ? [slot.observerToken] : []))]
      .flatMap((token) => {
        const observer = this.deps.findObserver(token);
        return observer ? [{ kind: observer.kind, surfaceId: observer.surfaceId, generation: observer.generation }] : [];
      });
    const consumers = [...(run?.subscribers ?? [])].flatMap((id) => {
      const sub = this.deps.subscriptions.get(id);
      return sub ? [{ consumerId: sub.consumerId, role: sub.role }] : [];
    });
    const { observerToken: _token, releaseListeners: _listeners, ...identity } = slot;
    return { lane, ...identity, occupiedForMs: Math.max(0, Date.now() - slot.since), owner: run?.owner, observers, consumers };
  }

  reserve(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, connectionGeneration: number, consumerId = "") {
    const occupied = this.snapshot(lane);
    if (occupied) {
      const diagnostics = { lane, activeStream: occupied, requested: { requestId: frame.id, operation: frame.type } };
      this.deps.onDiagnostic?.(`active_stream_exists:${JSON.stringify(diagnostics)}`);
      throw frameError({ frame: "error", type: "active_stream_exists", code: 409,
        msg: "detach the current run stream before starting or attaching another",
        data: { error: { code: "active_stream_exists", status: 409, category: "system", scope: "system", retryable: false,
          message: "detach the current run stream before starting or attaching another", diagnostics } } });
    }
    const requestId = readText(frame.id);
    const query = this.deps.queries.get(requestId);
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const run = [...this.deps.runs.values()].find((run) => run.lane === lane && run.runId === readText(payload.runId));
    const observerToken = query?.rootObserverToken || [...(run?.rootObserverTokens ?? [])][0] || "";
    const observer = this.deps.findObserver(observerToken);
    const subscriber = [...(run?.subscribers ?? [])].map((id) => this.deps.subscriptions.get(id)).find(Boolean);
    this.slots.set(lane, {
      requestId, runId: readText(payload.runId), chatId: readText(payload.chatId),
      consumerId: query?.consumerId || consumerId || subscriber?.consumerId || "", observerToken,
      surfaceId: observer?.surfaceId, observerKind: observer?.kind, observerGeneration: observer?.generation,
      connectionGeneration,
      operation: readText(frame.type), since: Date.now(), state: "reserving", releaseListeners: new Set(),
    });
  }

  release(lane: RealtimeLane, requestId: string) {
    const slot = this.slots.get(lane);
    if (slot?.requestId !== requestId) return;
    this.slots.delete(lane);
    for (const listener of slot.releaseListeners) listener();
  }

  receive(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame) {
    const slot = this.slots.get(lane);
    if (!slot || slot.requestId !== readText(frame.id)) return;
    if (frame.frame === "error" || (frame.frame === "stream" && readText(frame.reason))) {
      this.release(lane, slot.requestId);
    } else if (frame.frame === "stream") {
      if (slot.state === "reserving") slot.state = "attached";
      if (isRecord(frame.event)) {
        if (isTerminalEvent(readText(frame.event.type))) slot.state = "ending";
        slot.runId ||= readText(frame.event.runId);
        slot.chatId ||= readText(frame.event.chatId);
      }
    }
  }

  detaching(lane: RealtimeLane, requestId: string) {
    const slot = this.slots.get(lane);
    if (slot?.requestId === requestId) slot.state = "detaching";
  }

  detachFailed(lane: RealtimeLane, requestId: string, error: unknown) {
    const slot = this.slots.get(lane);
    if (slot?.requestId !== requestId) return;
    slot.state = "release_unconfirmed";
    slot.lastDetachError = error instanceof Error ? error.message : String(error);
    this.deps.onDiagnostic?.(`run_stream_detach_failed:${JSON.stringify(this.snapshot(lane))}`);
  }

  async waitForEnding(lane: RealtimeLane): Promise<void> {
    const slot = this.slots.get(lane);
    if (!slot || (slot.state !== "ending" && ![...this.deps.runs.values()].some((run) => run.lane === lane && run.runId === slot.runId && run.terminal))) return;
    // A completion event/Push may precede the transport end. Bound the wait;
    // reservation still rejects with the occupant if no end confirmation arrives.
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); slot.releaseListeners.delete(finish); resolve(); };
      const timer = setTimeout(finish, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      slot.releaseListeners.add(finish);
    });
  }

  clear(lane?: RealtimeLane) {
    for (const [key, slot] of this.slots) if (!lane || lane === key) this.release(key, slot.requestId);
  }
}
