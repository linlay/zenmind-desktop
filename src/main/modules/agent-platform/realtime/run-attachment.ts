import type { LaneStreams } from "./lane-stream";
import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";
import { AgentPlatformRealtimeClient, type AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import {
  BrokerRun,
  QueryTransaction,
  RealtimeLane,
  RealtimeQueryCompleted,
  RunSubscription,
  frameError,
  framePayload,
  readText,
} from "./realtime-broker.shared";

/** Dependencies limited to run attachment; state remains owned by the Broker. */
export interface RunAttachmentPort {
  laneStreams: LaneStreams;
  sendRunRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame): void;
  queriesByRequestId: Map<string, QueryTransaction>;
  terminalRequestIds: Set<string>;
  unsubscribe(subscriptionId: string): boolean;
  diagnostics: BrokerDiagnosticsCounters;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  ensureConnected(baseUrl: string, token: string, lane?: RealtimeLane): Promise<void>;
  runChannels: Map<string, BrokerRun>;
  hasSystemRunLease(run: BrokerRun): boolean;
  runSubscriptions: Map<string, RunSubscription>;
  onDiagnostic?(message: string): void;
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  forwardRequest(options: {
    baseUrl: string;
    token: string;
    localId: string;
    consumerId: string;
    type: string;
    payload?: Record<string, unknown>;
    stream?: boolean;
    onFrame(frame: AgentPlatformRealtimeFrame): void;
    onError(error: Error): void;
    lane?: RealtimeLane;
  }): Promise<string>;
}

export function createRunAttachment(deps: RunAttachmentPort) {
  function retireUpstreamRequest(run: BrokerRun, requestId: string): void {
    deps.laneStreams.release(run.lane, requestId);
    if (requestId) {
      deps.queriesByRequestId.delete(requestId);
      deps.terminalRequestIds.add(requestId);
      if (deps.terminalRequestIds.size > 2000) {
        deps.terminalRequestIds.delete(deps.terminalRequestIds.values().next().value as string);
      }
    }
    if (!requestId || run.upstreamRequestId === requestId)
      run.upstreamRequestId = null;
  }

  function releaseRunObserver(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void {
    if (typeof lastSeq === "number" && Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
      run.lastSeq = Math.max(run.lastSeq, lastSeq);
    }
    const transaction = run.query && (!requestId || run.query.upstreamRequestId === requestId)
      ? run.query
      : null;
    retireUpstreamRequest(run, requestId);
    if (transaction) {
      run.query = null;
      if (transaction.signal && transaction.abortListener) {
        transaction.signal.removeEventListener("abort", transaction.abortListener);
      }
      if (transaction.subscriptionId)
        deps.unsubscribe(transaction.subscriptionId);
      const result: RealtimeQueryCompleted = {
        reason: "detached",
        ...(typeof lastSeq === "number" ? { lastSeq } : {}),
      };
      void transaction.eventQueue.then(() => transaction.completed.resolve(result), (error) => transaction.completed.reject(error));
    }
    run.suspended = true;
    // Waits may finish while unobserved; only the next attach may reconfirm them.
    run.activeWaits.clear();
    run.lastRestoreResult = `observer_released:${reason}`;
    deps.diagnostics.observerReleaseCount += 1;
  }

  /** Routes an upstream `detached` stream end for a query or attach stream. */
  function handleUpstreamDetached(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void {
    if (run.detachInFlight || (run.rootObserverTokens.size === 0 && !deps.hasSystemRunLease(run)) ||
      run.upstreamLossSeq === run.lastSeq) {
      releaseRunObserver(run, requestId, reason, lastSeq);
      return;
    }
    // Desktop did not ask for this detach (e.g. Platform dropped a slow
    // observer) and the Run is still observed: resume from the last delivered
    // seq like a reconnect, keeping subscribers and any open query attached.
    retireUpstreamRequest(run, requestId);
    run.upstreamLossSeq = run.lastSeq;
    run.suspended = true;
    run.activeWaits.clear();
    deps.onDiagnostic?.(`upstream_stream_lost:${JSON.stringify({ lane: run.lane, runId: run.runId, requestId, reason, lastSeq: run.lastSeq })}`);
    void restoreRun(run);
  }

  /** Platform no longer retains the resume cursor; the Run itself keeps running. */
  function expireAttachStream(run: BrokerRun, requestId: string, error: Error): void {
    retireUpstreamRequest(run, requestId);
    run.suspended = true;
    run.activeWaits.clear();
    // The local replay can no longer continue contiguously, so the next
    // observer resumes from its own authoritative cursor instead.
    run.replay = [];
    run.replayBytes = 0;
    run.lastRestoreResult = `failed:${error.name}`;
    deps.onDiagnostic?.(`attach_cursor_expired:${JSON.stringify({ lane: run.lane, runId: run.runId, requestId, lastSeq: run.lastSeq })}`);
    const subscriptions = [...run.subscribers].flatMap((subscriptionId) => {
      const subscription = deps.runSubscriptions.get(subscriptionId);
      deps.runSubscriptions.delete(subscriptionId);
      return subscription ? [subscription] : [];
    });
    run.subscribers.clear();
    for (const subscription of subscriptions) {
      if (subscription.onError) subscription.onError(error);
      else subscription.onComplete?.({ reason: "error", lastSeq: run.lastSeq });
    }
  }

  async function startAttach(run: BrokerRun, baseUrl: string, token: string): Promise<void> {
    if (deps.getRunChannel(run.runId, run.lane) !== run || run.upstreamRequestId || run.terminal)
      return;
    await deps.ensureConnected(baseUrl, token, run.lane);
    await Promise.all([...deps.runChannels.values()].filter((other) => other.lane === run.lane).map((other) => other.detachInFlight));
    await deps.laneStreams.waitForEnding(run.lane);
    if (run.rootObserverTokens.size === 0 && !deps.hasSystemRunLease(run)) return;
    if (deps.getRunChannel(run.runId, run.lane) !== run || run.upstreamRequestId || run.terminal)
      return;
    const id = `desktop-attach-${randomUUID()}`;
    deps.sendRunRequest(run.lane, {
      frame: "request",
      type: "/api/attach",
      id,
      payload: {
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: run.lastSeq,
        ...(run.owner?.kind === "agent"
          ? { agentKey: run.owner.agentKey }
          : {}),
      },
    });
    run.upstreamRequestId = id;
    run.upstreamSource = "attach_stream";
    deps.diagnostics.upstreamAttachCount += 1;
  }

  async function restoreRun(run: BrokerRun): Promise<void> {
    const state = deps.clients[run.lane].getState();
    if (state.phase !== "connected" || run.terminal || run.restoreInFlight ||
      Boolean(run.upstreamRequestId))
      return;
    run.restoreInFlight = true;
    run.restoreCount += 1;
    const id = `desktop-attach-${randomUUID()}`;
    try {
      run.upstreamRequestId = id;
      run.upstreamSource = "attach_stream";
      deps.diagnostics.upstreamAttachCount += 1;
      deps.sendRunRequest(run.lane, {
        frame: "request",
        type: "/api/attach",
        id,
        payload: {
          runId: run.runId,
          chatId: run.chatId,
          lastSeq: run.lastSeq,
          ...(run.owner?.kind === "agent"
            ? { agentKey: run.owner.agentKey }
            : {}),
        },
      });
      run.suspended = false;
      run.lastRestoreResult = `attached:${state.generation}:${run.lastSeq}`;
    }
    catch (error) {
      run.upstreamRequestId = null;
      run.suspended = true;
      run.lastRestoreResult = `failed:${error instanceof Error ? error.message : String(error)}`;
    }
    finally {
      run.restoreInFlight = false;
    }
  }

  function detachRunIfUnobserved(run: BrokerRun, reason: string): Promise<void> {
    if (deps.getRunChannel(run.runId, run.lane) !== run || run.terminal || run.rootObserverTokens.size > 0 || deps.hasSystemRunLease(run) ||
      !run.upstreamRequestId || !run.baseUrl || !run.accessToken)
      return Promise.resolve();
    if (run.detachInFlight)
      return run.detachInFlight;
    run.suspended = true;
    const operationGeneration = ++run.operationGeneration;
    const streamRequestId = run.upstreamRequestId;
    const failed = (error: unknown) => {
      deps.laneStreams.detachFailed(run.lane, streamRequestId, error);
      if (run.upstreamRequestId === streamRequestId)
        run.lastRestoreResult = `detach_failed:${error instanceof Error ? error.message : String(error)}`;
    };
    const detach = new Promise<void>((resolve) => {
      void deps.ensureConnected(run.baseUrl, run.accessToken, run.lane).then(() => {
        if (deps.getRunChannel(run.runId, run.lane) !== run || run.operationGeneration !== operationGeneration ||
          run.rootObserverTokens.size > 0 ||
          deps.hasSystemRunLease(run)) {
          run.suspended = false;
          resolve();
          return;
        }
        deps.laneStreams.detaching(run.lane, streamRequestId);
        void deps.forwardRequest({
          baseUrl: run.baseUrl,
          token: run.accessToken,
          lane: run.lane,
          localId: `observer-detach-${randomUUID()}`,
          consumerId: `realtime-broker:${run.lane}:${run.runId}:detach`,
          type: "/api/detach",
          payload: {
            runId: run.runId,
            ...(run.owner?.kind === "agent"
              ? { agentKey: run.owner.agentKey }
              : {}),
            reason,
          },
          onFrame: (frame: AgentPlatformRealtimeFrame) => {
            if (frame.frame === "error") { failed(frameError(frame)); resolve(); return; }
            const payload = framePayload(frame);
            const detachedRequestId = readText(payload.streamRequestId) ||
              (payload.accepted === false ? streamRequestId : "");
            if (detachedRequestId === streamRequestId) {
              if (run.upstreamRequestId === streamRequestId)
                releaseRunObserver(run, streamRequestId, "detached", payload.lastSeq);
            } else {
              failed(new Error("detach response did not confirm stream release"));
            }
            resolve();
          },
          onError: (error) => { failed(error); resolve(); },
        }).catch((error) => { failed(error); resolve(); });
        deps.diagnostics.upstreamDetachCount += 1;
      }).catch((error) => { failed(error); resolve(); });
    }).finally(() => {
      if (run.detachInFlight === detach)
        run.detachInFlight = null;
      if (deps.getRunChannel(run.runId, run.lane) === run &&
        (run.rootObserverTokens.size > 0 || deps.hasSystemRunLease(run)) &&
        !run.terminal && !run.upstreamRequestId) {
        void startAttach(run, run.baseUrl, run.accessToken).catch((error) => failed(error));
      }
    });
    run.detachInFlight = detach;
    return detach;
  }

  return { releaseRunObserver, handleUpstreamDetached, expireAttachStream, startAttach, restoreRun, detachRunIfUnobserved };
}
