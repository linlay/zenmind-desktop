import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { validateAgentPlatformPushTimeContract } from "../../../../shared/agent-platform-push-time-contract";
import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";
import { type AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  BrokerRun,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  MAX_RETAINED_TERMINAL_RUNS,
  PushSubscription,
  QueryTransaction,
  RealtimeLane,
  RealtimeQueryCompleted,
  RunSubscription,
  brokerError,
  framePayload,
  isObserverDetachReason,
  isRecord,
  isTerminalEvent,
  pushIdentity,
  readText,
  runChannelMapKey,
} from "./realtime-broker.shared";
import { type RunSiteControlGrants } from "./run-site-control-grants";

/** Dependencies limited to run channels; state remains owned by the Broker. */
export interface RunChannelsPort {
  runChannels: Map<string, BrokerRun>;
  runSubscriptions: Map<string, RunSubscription>;
  releaseRunObserver(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void;
  diagnostics: BrokerDiagnosticsCounters;
  siteControlGrants: RunSiteControlGrants;
  readonly options: { onArtifactPublished?(event: Record<string, unknown>): void; onDiagnostic?(message: string): void; };
  revokeRunActionGrant(runIdValue: string): boolean;
  terminalRequestIds: Set<string>;
  queriesByRequestId: Map<string, QueryTransaction>;
  inboundDesktopRequests: Map<string, AbortController>;
  pushSubscriptions: Map<string, PushSubscription>;
}

export function createRunChannels(deps: RunChannelsPort) {
  function getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined {
    const runId = runIdValue.trim();
    if (!runId)
      return undefined;
    if (lane)
      return deps.runChannels.get(runChannelMapKey({ lane, runId }));
    return [...deps.runChannels.values()].find((run) => run.runId === runId);
  }

  function setRunChannel(run: BrokerRun): void {
    deps.runChannels.set(runChannelMapKey(run), run);
  }

  function deleteRunChannel(run: BrokerRun): boolean {
    return deps.runChannels.delete(runChannelMapKey(run));
  }

  function handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame): void {
    if (isRecord(frame.event)) {
      try {
        consumeRunEvent(run, frame.event, run.query);
      }
      catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        for (const id of run.subscribers)
          deps.runSubscriptions.get(id)?.onError?.(normalized);
        return;
      }
    }
    const reason = readText(frame.reason);
    if (!reason)
      return;
    if (isObserverDetachReason(reason)) {
      deps.releaseRunObserver(run, readText(frame.id), reason, frame.lastSeq);
      return;
    }
    completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, run.upstreamSource);
  }

  function consumeRunEvent(run: BrokerRun, event: Record<string, unknown>, transaction: QueryTransaction | null): void {
    const type = readText(event.type);
    if (!type)
      throw brokerError("protocol_error", "stream event.type is required");
    const path = transaction
      ? `ws.query[${transaction.operationId}].events[${transaction.eventIndex++}]`
      : `ws.attach[${run.runId}].events`;
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventRunId = readText(event.runId);
    const eventChatId = readText(event.chatId);
    if (eventRunId && eventRunId !== run.runId) {
      throw brokerError("protocol_error", "stream runId conflicts with registered Run");
    }
    if (eventChatId && eventChatId !== run.chatId) {
      throw brokerError("protocol_error", "stream chatId conflicts with registered Run");
    }
    const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq)
      ? event.seq
      : null;
    if (seq !== null) {
      if (seq <= run.lastSeq) {
        deps.diagnostics.seqRegressionCount += 1;
        return;
      }
      if (run.lastSeq > 0 && seq > run.lastSeq + 1)
        deps.diagnostics.seqGapCount += 1;
      run.lastSeq = seq;
    }
    if (transaction && !transaction.acceptedValue) {
      if (type !== "run.start") {
        if (isTerminalEvent(type)) {
          throw brokerError("protocol_error", "terminal event arrived before run.start");
        }
        appendReplay(run, event, seq, path);
        transaction.bufferedEvents.push({ event, path });
        return;
      }
      transaction.acceptedValue = {
        chatId: run.chatId,
        runId: run.runId,
        owner: run.owner!,
      };
      if (transaction.acceptanceTimer) {
        clearTimeout(transaction.acceptanceTimer);
        transaction.acceptanceTimer = null;
      }
      if (transaction.siteControlScope) deps.siteControlGrants.bind(transaction.acceptedValue, transaction.siteControlScope);
      transaction.accepted.resolve(transaction.acceptedValue);
    }
    if (run.lane === "primary" && type === "artifact.publish") {
      // Observe only validated canonical events; this does not create a Run subscription.
      try {
        deps.options.onArtifactPublished?.({ ...event, chatId: run.chatId, runId: run.runId });
      } catch {
        deps.options.onDiagnostic?.("artifact_index_delivery_failed");
      }
    }
    appendReplay(run, event, seq, path);
    for (const id of run.subscribers) {
      const subscription = deps.runSubscriptions.get(id);
      if (!subscription || (seq !== null && seq <= subscription.lastSeq))
        continue;
      if (seq !== null)
        subscription.lastSeq = seq;
      subscription.onEvent(event, path);
    }
  }

  function appendReplay(run: BrokerRun, event: Record<string, unknown>, seq: number | null, path?: string): void {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    run.replay.push({ event, bytes, seq, ...(path ? { path } : {}) });
    run.replayBytes += bytes;
    while (run.replay.length > MAX_REPLAY_EVENTS || run.replayBytes > MAX_REPLAY_BYTES) {
      const removed = run.replay.shift();
      if (!removed)
        break;
      run.replayBytes -= removed.bytes;
      deps.diagnostics.replayEvictionCount += 1;
    }
  }

  function replayToSubscriber(run: BrokerRun, subscription: RunSubscription): void {
    const firstSeq = run.replay.find((entry) => entry.seq !== null)?.seq;
    if (firstSeq !== undefined && firstSeq !== null && subscription.lastSeq + 1 < firstSeq) {
      deps.diagnostics.seqExpiredCount += 1;
      throw brokerError("seq_expired", "requested Run cursor is outside the local replay window", {
        retryable: true,
        details: {
          requestedLastSeq: subscription.lastSeq,
          firstAvailableSeq: firstSeq,
          latestSeq: run.lastSeq,
          replayEventCount: run.replay.length,
          replayBytes: run.replayBytes,
        },
      });
    }
    for (const entry of run.replay) {
      if (entry.seq !== null && entry.seq <= subscription.lastSeq)
        continue;
      if (entry.seq !== null)
        subscription.lastSeq = entry.seq;
      subscription.onEvent(entry.event, entry.path);
    }
  }

  function completeRun(run: BrokerRun, result: RealtimeQueryCompleted, source: NonNullable<BrokerRun["terminalSource"]>): void {
    if (run.terminal) {
      deps.diagnostics.duplicateTerminalCount += 1;
      return;
    }
    run.terminal = true;
    run.terminalReason = result.reason;
    run.terminalSource = source;
    run.suspended = false;
    deps.revokeRunActionGrant(run.runId);
    deps.siteControlGrants.revoke(run.runId);
    if (run.upstreamRequestId) {
      deps.terminalRequestIds.add(run.upstreamRequestId);
      if (deps.terminalRequestIds.size > 2000) {
        deps.terminalRequestIds.delete(deps.terminalRequestIds.values().next().value as string);
      }
      deps.queriesByRequestId.delete(run.upstreamRequestId);
    }
    run.upstreamRequestId = null;
    const transaction = run.query;
    run.query = null;
    if (transaction) {
      if (transaction.signal && transaction.abortListener) {
        transaction.signal.removeEventListener("abort", transaction.abortListener);
      }
      void transaction.eventQueue.then(() => transaction.completed.resolve(result), (error) => transaction.completed.reject(error));
    }
    for (const id of [...run.subscribers]) {
      const subscription = deps.runSubscriptions.get(id);
      subscription?.onComplete?.(result);
      deps.runSubscriptions.delete(id);
    }
    run.subscribers.clear();
    pruneRetainedTerminalRuns();
  }

  function pruneRetainedTerminalRuns(): void {
    const removable = [...deps.runChannels.values()].filter((run) => run.terminal &&
      run.rootObserverTokens.size === 0 &&
      run.subscribers.size === 0 &&
      !run.query &&
      !run.upstreamRequestId);
    while (removable.length > MAX_RETAINED_TERMINAL_RUNS) {
      const run = removable.shift();
      if (!run)
        break;
      deleteRunChannel(run);
    }
  }

  function handlePush(frame: AgentPlatformRealtimeFrame): void {
    const type = readText(frame.type);
    if (type === "desktop.bridge.cancel") {
      const requestId = readText(framePayload(frame).requestId);
      const controller = deps.inboundDesktopRequests.get(requestId);
      controller?.abort();
      deps.inboundDesktopRequests.delete(requestId);
      return;
    }
    if (!AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)) {
      deps.diagnostics.unknownFrameCount += 1;
      return;
    }
    if (type === "connected" || type === "heartbeat" || type === "live.connected")
      return;
    const invalidTime = validateAgentPlatformPushTimeContract(type, framePayload(frame));
    if (invalidTime) {
      deps.options.onDiagnostic?.(`time_contract_violation: push.${type}.${invalidTime}`);
      return;
    }
    if (type === "run.finished" || type === "run.complete") {
      const runId = pushIdentity(frame, "runId");
      deps.revokeRunActionGrant(runId);
      deps.siteControlGrants.revoke(runId);
      const run = getRunChannel(runId);
      if (run && !run.terminal) {
        const payload = framePayload(frame);
        completeRun(run, {
          reason: readText(payload.finishReason) || readText(payload.status) || "finished",
          ...(typeof payload.lastSeq === "number" ? { lastSeq: payload.lastSeq } : {}),
        }, "push");
      }
    }
    for (const subscription of deps.pushSubscriptions.values()) {
      if (!subscription.types.has(type))
        continue;
      const filter = subscription.filter;
      if (filter?.chatId && pushIdentity(frame, "chatId") !== filter.chatId)
        continue;
      if (filter?.runId && pushIdentity(frame, "runId") !== filter.runId)
        continue;
      if (filter?.resourceId && pushIdentity(frame, "resourceId") !== filter.resourceId)
        continue;
      subscription.onPush(frame);
    }
  }

  return { getRunChannel, setRunChannel, deleteRunChannel, handleRunStream, consumeRunEvent, appendReplay, replayToSubscriber, completeRun, pruneRetainedTerminalRuns, handlePush };
}
