import type { RealtimeBrokerMethodContext } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";

import type { App } from "electron";

import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../../../shared/contracts";

import { validateAgentPlatformPushTimeContract } from "../../../../shared/agent-platform-push-time-contract";

import { getDesktopActionDefinition } from "../../../../shared/desktop-actions";

import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";

import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";

import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

import { AGENT_PLATFORM_KNOWN_PUSH_TYPES, BrokerRun, ConnectionSubscription, DESKTOP_CDP_REQUEST_TYPE, DESKTOP_MAX_RESPONSE_BYTES, DESKTOP_RESPONSE_DELTA_EVENT_TYPE, DESKTOP_SCREENSHOT_CHUNK_CHARS, DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE, DESKTOP_STREAM_RAW_CHUNK_BYTES, Deferred, DesktopBridgeRequestProvider, MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS, MAX_RETAINED_TERMINAL_RUNS, OverviewCloneLeaseState, PendingClone, PendingRequest, PushSubscription, QueryTransaction, REQUEST_TIMEOUT_MS, RealtimeLane, RealtimeQueryAccepted, RealtimeQueryCompleted, RealtimeQueryHandle, ReplayEvent, RootObserverIdentity, RootObserverKind, RootObserverState, RunActionGrant, RunChannelKey, RunSubscription, brokerError, cloneBindingError, createDeferred, frameError, framePayload, isObserverDetachReason, isRecord, isTerminalEvent, pushIdentity, readText, runChannelMapKey, sameRunOwner, unrefTimer } from "./realtime-broker.shared";

export function RealtimeBroker_registerProvisionalRun_1(self: RealtimeBrokerMethodContext, transaction: QueryTransaction, event: Record<string, unknown>) {
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex}]`;
    if (readText(event.type) !== "run.start")
        throw brokerError("protocol_error", "run.start is required");
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const runId = readText(event.runId);
    const chatId = readText(event.chatId);
    if (!runId || !chatId) {
        throw brokerError("protocol_error", "run.start must include canonical chatId and runId");
    }
    if (transaction.expectedRunId && transaction.expectedRunId !== runId) {
        throw brokerError("protocol_error", "stream runId conflicts with registered Run");
    }
    if (transaction.expectedChatId && transaction.expectedChatId !== chatId) {
        throw brokerError("protocol_error", "run.start chatId conflicts with query chatId");
    }
    const agentKey = readText(event.agentKey);
    const teamId = readText(event.teamId);
    if (Boolean(agentKey) === Boolean(teamId)) {
        throw brokerError("protocol_error", "run.start must include exactly one Run owner");
    }
    const owner: AgentWebclientRunOwner = teamId
        ? { kind: "team", teamId }
        : { kind: "agent", agentKey };
    const expectedOwner = transaction.expectedOwner;
    if (expectedOwner && (owner.kind !== expectedOwner.kind ||
        (owner.kind === "agent" && expectedOwner.kind === "agent" && owner.agentKey !== expectedOwner.agentKey) ||
        (owner.kind === "team" && expectedOwner.kind === "team" && owner.teamId !== expectedOwner.teamId))) {
        throw brokerError("protocol_error", "run.start owner conflicts with query owner");
    }
    if (self.getRunChannel(runId)) {
        throw brokerError("duplicate_id", `runId ${runId} is already registered`);
    }
    const run: BrokerRun = {
        lane: transaction.lane,
        runId,
        chatId,
        owner,
        lastSeq: 0,
        terminal: false,
        terminalReason: "",
        terminalSource: null,
        suspended: false,
        restoreInFlight: false,
        restoreCount: 0,
        lastRestoreResult: "never",
        upstreamRequestId: transaction.upstreamRequestId,
        query: transaction,
        replay: [],
        replayBytes: 0,
        subscribers: new Set(),
        rootObserverTokens: new Set(),
        baseUrl: transaction.baseUrl,
        accessToken: transaction.accessToken,
        detachInFlight: null,
        operationGeneration: 0,
    };
    transaction.runId = runId;
    transaction.chatId = chatId;
    self.setRunChannel(run);
    const observerToken = transaction.rootObserverToken;
    const observer = observerToken ? self.findRootObserver(observerToken) : null;
    if (observerToken && observer) {
        run.operationGeneration += 1;
        run.rootObserverTokens.add(observerToken);
        observer.runIds.add(runId);
        observer.overviewLease?.runIds.add(runId);
        self.notifyPendingClones(run);
    }
    else if (observerToken) {
        void self.detachRunIfUnobserved(run, "surface_generation_superseded");
    }
    return run;
}

export function RealtimeBroker_bindQuerySubscription_2(self: RealtimeBrokerMethodContext, run: BrokerRun, transaction: QueryTransaction) {
    const observerToken = transaction.rootObserverToken;
    const role: RunSubscription["role"] = observerToken ? "root_observer" : "internal";
    if (observerToken && !self.findRootObserver(observerToken)) {
        transaction.bufferedEvents = [];
        transaction.bufferedEventBytes = 0;
        return;
    }
    const id = `query-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
        lane: run.lane,
        id,
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: 0,
        kind: role === "internal" ? "internal" : "surface",
        consumerId: transaction.consumerId,
        role,
        ...(observerToken ? { observerToken } : {}),
        onEvent: (event, eventPath) => {
            const path = eventPath || `broker.${run.lane}[${run.runId}].events`;
            transaction.eventQueue = transaction.eventQueue.then(() => transaction.onEvent(event, path));
            void transaction.eventQueue.catch((error) => self.failQuery(transaction, error));
        },
    };
    self.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    transaction.subscriptionId = id;
    self.replayToSubscriber(run, subscription);
    transaction.bufferedEvents = [];
    transaction.bufferedEventBytes = 0;
}

export function RealtimeBroker_handleRunStream_3(self: RealtimeBrokerMethodContext, run: BrokerRun, frame: AgentPlatformRealtimeFrame) {
    if (isRecord(frame.event)) {
        try {
            self.consumeRunEvent(run, frame.event, run.query);
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            for (const id of run.subscribers)
                self.runSubscriptions.get(id)?.onError?.(normalized);
            return;
        }
    }
    const reason = readText(frame.reason);
    if (!reason)
        return;
    if (isObserverDetachReason(reason)) {
        self.releaseRunObserver(run, readText(frame.id), reason, frame.lastSeq);
        return;
    }
    self.completeRun(run, {
        reason,
        ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, "attach_stream");
}

export function RealtimeBroker_releaseRunObserver_4(self: RealtimeBrokerMethodContext, run: BrokerRun, requestId: string, reason: string, lastSeq: unknown) {
    if (typeof lastSeq === "number" && Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
        run.lastSeq = Math.max(run.lastSeq, lastSeq);
    }
    const transaction = run.query && (!requestId || run.query.upstreamRequestId === requestId)
        ? run.query
        : null;
    if (requestId) {
        self.queriesByRequestId.delete(requestId);
        self.terminalRequestIds.add(requestId);
        if (self.terminalRequestIds.size > 2000) {
            self.terminalRequestIds.delete(self.terminalRequestIds.values().next().value as string);
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
            self.unsubscribe(transaction.subscriptionId);
        const result: RealtimeQueryCompleted = {
            reason: "detached",
            ...(typeof lastSeq === "number" ? { lastSeq } : {}),
        };
        void transaction.eventQueue.then(() => transaction.completed.resolve(result), (error) => transaction.completed.reject(error));
    }
    run.suspended = true;
    run.lastRestoreResult = `observer_released:${reason}`;
    self.diagnostics.observerReleaseCount += 1;
}

export function RealtimeBroker_consumeRunEvent_5(self: RealtimeBrokerMethodContext, run: BrokerRun, event: Record<string, unknown>, transaction: QueryTransaction | null) {
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
            self.diagnostics.seqRegressionCount += 1;
            return;
        }
        if (run.lastSeq > 0 && seq > run.lastSeq + 1)
            self.diagnostics.seqGapCount += 1;
        run.lastSeq = seq;
    }
    if (transaction && !transaction.acceptedValue) {
        if (type !== "run.start") {
            if (isTerminalEvent(type)) {
                throw brokerError("protocol_error", "terminal event arrived before run.start");
            }
            self.appendReplay(run, event, seq, path);
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
        if (transaction.siteCdpScope) self.siteCdpGrants.bind(transaction.acceptedValue, transaction.siteCdpScope);
        transaction.accepted.resolve(transaction.acceptedValue);
    }
    self.appendReplay(run, event, seq, path);
    for (const id of run.subscribers) {
        const subscription = self.runSubscriptions.get(id);
        if (!subscription || (seq !== null && seq <= subscription.lastSeq))
            continue;
        if (seq !== null)
            subscription.lastSeq = seq;
        subscription.onEvent(event, path);
    }
}

export function RealtimeBroker_appendReplay_6(self: RealtimeBrokerMethodContext, run: BrokerRun, event: Record<string, unknown>, seq: number | null, path?: string) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    run.replay.push({ event, bytes, seq, ...(path ? { path } : {}) });
    run.replayBytes += bytes;
    while (run.replay.length > MAX_REPLAY_EVENTS || run.replayBytes > MAX_REPLAY_BYTES) {
        const removed = run.replay.shift();
        if (!removed)
            break;
        run.replayBytes -= removed.bytes;
        self.diagnostics.replayEvictionCount += 1;
    }
}

export function RealtimeBroker_replayToSubscriber_7(self: RealtimeBrokerMethodContext, run: BrokerRun, subscription: RunSubscription) {
    const firstSeq = run.replay.find((entry) => entry.seq !== null)?.seq;
    if (firstSeq !== undefined && firstSeq !== null && subscription.lastSeq + 1 < firstSeq) {
        self.diagnostics.seqExpiredCount += 1;
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

export function RealtimeBroker_completeRun_8(self: RealtimeBrokerMethodContext, run: BrokerRun, result: RealtimeQueryCompleted, source: NonNullable<BrokerRun["terminalSource"]>) {
    if (run.terminal) {
        self.diagnostics.duplicateTerminalCount += 1;
        return;
    }
    run.terminal = true;
    run.terminalReason = result.reason;
    run.terminalSource = source;
    run.suspended = false;
    self.revokeRunActionGrant(run.runId);
    self.siteCdpGrants.revoke(run.runId);
    if (run.upstreamRequestId) {
        self.terminalRequestIds.add(run.upstreamRequestId);
        if (self.terminalRequestIds.size > 2000) {
            self.terminalRequestIds.delete(self.terminalRequestIds.values().next().value as string);
        }
        self.queriesByRequestId.delete(run.upstreamRequestId);
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
        const subscription = self.runSubscriptions.get(id);
        subscription?.onComplete?.(result);
        self.runSubscriptions.delete(id);
    }
    run.subscribers.clear();
    self.pruneRetainedTerminalRuns();
}

export function RealtimeBroker_failQuery_9(self: RealtimeBrokerMethodContext, transaction: QueryTransaction, error: unknown) {
    transaction.siteCdpScope?.release("The source query failed.");
    if (transaction.runId) self.siteCdpGrants.revoke(transaction.runId);
    self.queriesByRequestId.delete(transaction.upstreamRequestId);
    const run = transaction.runId ? self.getRunChannel(transaction.runId, transaction.lane) : null;
    if (run && !transaction.acceptedValue)
        self.deleteRunChannel(run);
    if (transaction.subscriptionId)
        self.unsubscribe(transaction.subscriptionId);
    if (run?.query === transaction)
        run.query = null;
    if (transaction.signal && transaction.abortListener) {
        transaction.signal.removeEventListener("abort", transaction.abortListener);
    }
    if (transaction.acceptanceTimer) {
        clearTimeout(transaction.acceptanceTimer);
        transaction.acceptanceTimer = null;
    }
    if (transaction.rootObserverToken && transaction.expectedRunId) {
        for (const pending of [...self.pendingClones.values()]) {
            if (pending.observerToken === transaction.rootObserverToken &&
                pending.runId === transaction.expectedRunId) {
                pending.reject(cloneBindingError("run_not_registered", "the parent query ended before its RunChannel was registered"));
            }
        }
    }
    transaction.accepted.reject(error);
    transaction.completed.reject(error);
}

export async function RealtimeBroker_startAttach_10(self: RealtimeBrokerMethodContext, run: BrokerRun, baseUrl: string, token: string) {
    if (run.upstreamRequestId || run.terminal)
        return;
    await self.ensureConnected(baseUrl, token, run.lane);
    if (run.upstreamRequestId || run.terminal)
        return;
    const id = `desktop-attach-${randomUUID()}`;
    run.upstreamRequestId = id;
    self.diagnostics.upstreamAttachCount += 1;
    self.clients[run.lane].send({
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

export async function RealtimeBroker_restoreRun_11(self: RealtimeBrokerMethodContext, run: BrokerRun) {
    const state = self.clients[run.lane].getState();
    if (state.phase !== "connected" || run.terminal || run.restoreInFlight ||
        Boolean(run.upstreamRequestId))
        return;
    run.restoreInFlight = true;
    run.restoreCount += 1;
    const id = `desktop-attach-${randomUUID()}`;
    try {
        run.upstreamRequestId = id;
        self.diagnostics.upstreamAttachCount += 1;
        self.clients[run.lane].send({
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
