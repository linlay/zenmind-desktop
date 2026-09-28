import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";
import { AgentPlatformRealtimeClient, type AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import {
  BrokerRun,
  QueryTransaction,
  RealtimeLane,
  RealtimeQueryCompleted,
  framePayload,
  readText,
} from "./realtime-broker.shared";

/** Dependencies limited to run attachment; state remains owned by the Broker. */
export interface RunAttachmentPort {
  queriesByRequestId: Map<string, QueryTransaction>;
  terminalRequestIds: Set<string>;
  unsubscribe(subscriptionId: string): boolean;
  diagnostics: BrokerDiagnosticsCounters;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  ensureConnected(baseUrl: string, token: string, lane?: RealtimeLane): Promise<void>;
  runChannels: Map<string, BrokerRun>;
  hasSystemRunLease(run: BrokerRun): boolean;
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
  function releaseRunObserver(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void {
    if (typeof lastSeq === "number" && Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
      run.lastSeq = Math.max(run.lastSeq, lastSeq);
    }
    const transaction = run.query && (!requestId || run.query.upstreamRequestId === requestId)
      ? run.query
      : null;
    if (requestId) {
      deps.queriesByRequestId.delete(requestId);
      deps.terminalRequestIds.add(requestId);
      if (deps.terminalRequestIds.size > 2000) {
        deps.terminalRequestIds.delete(deps.terminalRequestIds.values().next().value as string);
      }
    }
    if (!requestId || run.upstreamRequestId === requestId)
      run.upstreamRequestId = null;
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
    run.lastRestoreResult = `observer_released:${reason}`;
    deps.diagnostics.observerReleaseCount += 1;
  }

  async function startAttach(run: BrokerRun, baseUrl: string, token: string): Promise<void> {
    if (deps.getRunChannel(run.runId, run.lane) !== run || run.upstreamRequestId || run.terminal)
      return;
    await deps.ensureConnected(baseUrl, token, run.lane);
    if (run.lane === "primary" && run.rootObserverTokens.size > 0) {
      await Promise.all([...deps.runChannels.values()].filter((other) => other !== run && other.lane === "primary").map((other) => other.detachInFlight));
    }
    if (run.rootObserverTokens.size === 0 && !deps.hasSystemRunLease(run)) return;
    if (deps.getRunChannel(run.runId, run.lane) !== run || run.upstreamRequestId || run.terminal)
      return;
    const id = `desktop-attach-${randomUUID()}`;
    run.upstreamRequestId = id;
    run.upstreamSource = "attach_stream";
    deps.diagnostics.upstreamAttachCount += 1;
    deps.clients[run.lane].send({
      frame: "request",
      type: "/api/attach",
      id,
      payload: {
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: run.lastSeq,
        ...(run.owner?.kind === "agent"
          ? { agentKey: run.owner.agentKey }
          : run.owner?.kind === "team"
            ? { teamId: run.owner.teamId }
            : {}),
      },
    });
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
      deps.clients[run.lane].send({
        frame: "request",
        type: "/api/attach",
        id,
        payload: {
          runId: run.runId,
          chatId: run.chatId,
          lastSeq: run.lastSeq,
          ...(run.owner?.kind === "agent"
            ? { agentKey: run.owner.agentKey }
            : run.owner?.kind === "team"
              ? { teamId: run.owner.teamId }
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
    const detach = new Promise<void>((resolve) => {
      void deps.ensureConnected(run.baseUrl, run.accessToken, run.lane).then(() => {
        if (deps.getRunChannel(run.runId, run.lane) !== run || run.operationGeneration !== operationGeneration ||
          run.rootObserverTokens.size > 0 ||
          deps.hasSystemRunLease(run)) {
          run.suspended = false;
          resolve();
          return;
        }
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
              : run.owner?.kind === "team"
                ? { teamId: run.owner.teamId }
                : {}),
            reason,
          },
          onFrame: (frame: AgentPlatformRealtimeFrame) => {
            const payload = framePayload(frame);
            const detachedRequestId = readText(payload.streamRequestId) ||
              (payload.accepted === false ? run.upstreamRequestId || "" : "");
            if (detachedRequestId) {
              releaseRunObserver(run, detachedRequestId, "detached", payload.lastSeq);
            }
            resolve();
          },
          onError: () => resolve(),
        }).catch(() => resolve());
        deps.diagnostics.upstreamDetachCount += 1;
      }).catch(() => resolve());
    }).finally(() => {
      if (run.detachInFlight === detach)
        run.detachInFlight = null;
      if (deps.getRunChannel(run.runId, run.lane) === run &&
        (run.rootObserverTokens.size > 0 || deps.hasSystemRunLease(run)) &&
        !run.terminal && !run.upstreamRequestId) {
        void startAttach(run, run.baseUrl, run.accessToken);
      }
    });
    run.detachInFlight = detach;
    return detach;
  }

  return { releaseRunObserver, startAttach, restoreRun, detachRunIfUnobserved };
}
