import type { BrokerDiagnosticsCounters, RootObserverSnapshot } from "./realtime-broker.shared";
import { type AgentRealtimeDebugTraceEntry } from "../../../../shared/contracts";
import { AgentPlatformRealtimeClient } from "./agent-platform-realtime-client";
import {
  BrokerRun,
  ConnectionSubscription,
  PendingClone,
  PendingRequest,
  PushSubscription,
  QueryTransaction,
  RealtimeConnectionStates,
  RealtimeLane,
  RootObserverKind,
  RootObserverState,
  RunSubscription,
  readText,
} from "./realtime-broker.shared";
import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

/** Dependencies limited to diagnostics; state remains owned by the Broker. */
export interface DiagnosticsPort {
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  getConnectionStates(): RealtimeConnectionStates;
  pendingRequests: Map<string, PendingRequest>;
  queriesByRequestId: Map<string, QueryTransaction>;
  runChannels: Map<string, BrokerRun>;
  runSubscriptions: Map<string, RunSubscription>;
  pushSubscriptions: Map<string, PushSubscription>;
  connectionSubscriptions: Map<string, ConnectionSubscription>;
  getActiveRootObserver(): RootObserverSnapshot | null;
  auxiliaryRootObservers: Map<string, RootObserverState>;
  snapshotRootObserver(observer: RootObserverState | null): RootObserverSnapshot | null;
  mainChatRootObserver: RootObserverState | null;
  pendingClones: Map<string, PendingClone>;
  lastCloneCancellationReason: string;
  hasSystemRunLease(run: BrokerRun): boolean;
  diagnostics: BrokerDiagnosticsCounters;
  debugTrace: RealtimeDebugTraceBuffer;
}

export function createDiagnostics(deps: DiagnosticsPort) {
  function getDiagnostics() {
    return {
      connection: deps.clients.primary.getState(),
      connections: deps.getConnectionStates(),
      pendingRequestCount: deps.pendingRequests.size,
      pendingQueryCount: deps.queriesByRequestId.size,
      activeStreamCount: [...deps.runChannels.values()].filter((run) => Boolean(run.upstreamRequestId && !run.terminal)).length,
      runCount: deps.runChannels.size,
      localRunSubscriberCount: deps.runSubscriptions.size,
      pushSubscriberCount: deps.pushSubscriptions.size,
      connectionSubscriberCount: deps.connectionSubscriptions.size,
      rootObserver: deps.getActiveRootObserver(),
      auxiliaryRootObservers: [...deps.auxiliaryRootObservers.values()].map(
        (observer) => deps.snapshotRootObserver(observer),
      ),
      overviewLease: deps.mainChatRootObserver?.overviewLease
        ? {
          state: deps.mainChatRootObserver.overviewLease.state,
          parentGeneration: deps.mainChatRootObserver.overviewLease.parentGeneration,
          contextEpoch: deps.mainChatRootObserver.overviewLease.contextEpoch,
          chatId: deps.mainChatRootObserver.overviewLease.chatId ?? undefined,
          runCount: deps.mainChatRootObserver.overviewLease.runIds.size,
          runIds: [...deps.mainChatRootObserver.overviewLease.runIds].sort(),
          pendingSubscriberCount: deps.mainChatRootObserver.overviewLease.pendingCloneIds.size,
          uiSubscriberCount: deps.mainChatRootObserver.overviewLease.subscriberIds.size,
          subscribers: [...deps.mainChatRootObserver.overviewLease.subscriberIds]
            .flatMap((subscriptionId) => {
              const subscription = deps.runSubscriptions.get(subscriptionId);
              return subscription
                ? [{
                  runId: subscription.runId,
                  chatId: subscription.chatId,
                  lastSeq: subscription.lastSeq,
                }]
                : [];
            }),
        }
        : null,
      pendingClones: [...deps.pendingClones.values()].map((pending) => ({
        observerToken: pending.observerToken,
        parentGeneration: pending.parentGeneration,
        runId: pending.runId,
        chatId: pending.chatId,
        waitReason: pending.waitReason,
      })),
      lastCloneCancellationReason: deps.lastCloneCancellationReason || undefined,
      replay: [...deps.runChannels.values()].map((run) => {
        const lastEvent = run.replay.at(-1);
        let lastPlanTaskEvent: (typeof run.replay)[number] | undefined;
        for (let index = run.replay.length - 1; index >= 0; index -= 1) {
          const candidate = run.replay[index];
          const type = readText(candidate?.event.type);
          if (type.startsWith("plan.") || type.startsWith("task.")) {
            lastPlanTaskEvent = candidate;
            break;
          }
        }
        return {
          lane: run.lane,
          runId: run.runId,
          chatId: run.chatId,
          eventCount: run.replay.length,
          bytes: run.replayBytes,
          lastSeq: run.lastSeq,
          lastEventType: readText(lastEvent?.event.type) || undefined,
          lastEventSeq: lastEvent?.seq ?? undefined,
          lastPlanTaskEventType: readText(lastPlanTaskEvent?.event.type) || undefined,
          lastPlanTaskEventSeq: lastPlanTaskEvent?.seq ?? undefined,
          state: run.terminal
            ? "terminal"
            : run.detachInFlight
              ? "detaching"
              : run.rootObserverTokens.size > 0 || deps.hasSystemRunLease(run)
                ? "observed"
                : "dormant",
          terminalReason: run.terminalReason || undefined,
          terminalSource: run.terminalSource ?? undefined,
          rootObserverCount: run.rootObserverTokens.size,
          cloneCount: [...run.subscribers].filter((id) => deps.runSubscriptions.get(id)?.role === "clone").length,
          upstreamState: run.detachInFlight
            ? "detaching"
            : run.upstreamRequestId
              ? "attached"
              : "detached",
          restoreCount: run.restoreCount,
          lastRestoreResult: run.lastRestoreResult,
        };
      }),
      ...deps.diagnostics,
    };
  }

  function appendDebugTrace(input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]): AgentRealtimeDebugTraceEntry {
    return deps.debugTrace.append(input);
  }

  function getDebugTraceEntries() {
    return deps.debugTrace.snapshot();
  }

  function clearDebugTrace(): void {
    deps.debugTrace.clear();
  }

  return { getDiagnostics, appendDebugTrace, getDebugTraceEntries, clearDebugTrace };
}
