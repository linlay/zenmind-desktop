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

export function RealtimeBroker_getDiagnostics_1(self: RealtimeBrokerMethodContext) {
    return {
        connection: self.clients.primary.getState(),
        connections: self.getConnectionStates(),
        pendingRequestCount: self.pendingRequests.size,
        pendingQueryCount: self.queriesByRequestId.size,
        activeStreamCount: [...self.runChannels.values()].filter((run) => Boolean(run.upstreamRequestId && !run.terminal)).length,
        runCount: self.runChannels.size,
        localRunSubscriberCount: self.runSubscriptions.size,
        pushSubscriberCount: self.pushSubscriptions.size,
        connectionSubscriberCount: self.connectionSubscriptions.size,
        rootObserver: self.getActiveRootObserver(),
        overviewLease: self.mainChatRootObserver?.overviewLease
            ? {
                state: self.mainChatRootObserver.overviewLease.state,
                parentGeneration: self.mainChatRootObserver.overviewLease.parentGeneration,
                contextEpoch: self.mainChatRootObserver.overviewLease.contextEpoch,
                chatId: self.mainChatRootObserver.overviewLease.chatId ?? undefined,
                runCount: self.mainChatRootObserver.overviewLease.runIds.size,
                runIds: [...self.mainChatRootObserver.overviewLease.runIds].sort(),
                pendingSubscriberCount: self.mainChatRootObserver.overviewLease.pendingCloneIds.size,
                uiSubscriberCount: self.mainChatRootObserver.overviewLease.subscriberIds.size,
                subscribers: [...self.mainChatRootObserver.overviewLease.subscriberIds]
                    .flatMap((subscriptionId) => {
                    const subscription = self.runSubscriptions.get(subscriptionId);
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
        pendingClones: [...self.pendingClones.values()].map((pending) => ({
            observerToken: pending.observerToken,
            parentGeneration: pending.parentGeneration,
            runId: pending.runId,
            chatId: pending.chatId,
            waitReason: pending.waitReason,
        })),
        lastCloneCancellationReason: self.lastCloneCancellationReason || undefined,
        replay: [...self.runChannels.values()].map((run) => {
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
                        : run.rootObserverTokens.size > 0 || self.hasSystemRunLease(run)
                            ? "observed"
                            : "dormant",
                terminalReason: run.terminalReason || undefined,
                terminalSource: run.terminalSource ?? undefined,
                rootObserverCount: run.rootObserverTokens.size,
                cloneCount: [...run.subscribers].filter((id) => self.runSubscriptions.get(id)?.role === "clone").length,
                upstreamState: run.detachInFlight
                    ? "detaching"
                    : run.upstreamRequestId
                        ? "attached"
                        : "detached",
                restoreCount: run.restoreCount,
                lastRestoreResult: run.lastRestoreResult,
            };
        }),
        ...self.diagnostics,
    };
}

export function RealtimeBroker_appendDebugTrace_2(self: RealtimeBrokerMethodContext, input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]) {
    return self.debugTrace.append(input);
}

export function RealtimeBroker_getDebugTraceEntries_3(self: RealtimeBrokerMethodContext) {
    return self.debugTrace.snapshot();
}

export function RealtimeBroker_clearDebugTrace_4(self: RealtimeBrokerMethodContext) {
    self.debugTrace.clear();
}

export function RealtimeBroker_rotateIdentity_5(self: RealtimeBrokerMethodContext, reason: RealtimeIdentityRotationReason = "explicit_identity_invalidation") {
    self.options.onDiagnostic?.(`realtime_identity_rotation:${reason}`);
    self.diagnostics.laneRotationCount += 2;
    const error = brokerError("connection_unavailable", "realtime identity was invalidated");
    for (const pending of [...self.pendingRequests.values()]) {
        self.cleanupPending(pending.upstreamId);
        pending.onError(error);
    }
    for (const transaction of [...self.queriesByRequestId.values()]) {
        self.failQuery(transaction, error);
    }
    for (const subscription of self.runSubscriptions.values()) {
        subscription.onError?.(error);
    }
    self.queriesByRequestId.clear();
    self.runSubscriptions.clear();
    self.runChannels.clear();
    for (const pending of [...self.pendingClones.values()])
        pending.reject(error);
    self.pendingClones.clear();
    self.activeRootObserver = null;
    self.mainChatRootObserver = null;
    self.terminalRequestIds.clear();
    self.clearRunActionGrants();
    self.clients.primary.rotateIdentity();
    self.clients.btw.rotateIdentity();
}

export function RealtimeBroker_beginShutdown_6(self: RealtimeBrokerMethodContext) {
    self.acceptingDelivery = false;
    for (const controller of self.inboundDesktopRequests.values())
        controller.abort();
    self.inboundDesktopRequests.clear();
    self.seenInboundDesktopRequestIds.clear();
}

export function RealtimeBroker_dispose_7(self: RealtimeBrokerMethodContext) {
    if (self.disposed)
        return;
    self.disposed = true;
    const error = brokerError("connection_unavailable", "Realtime Broker disposed");
    for (const pending of self.pendingRequests.values())
        pending.onError(error);
    for (const transaction of self.queriesByRequestId.values())
        self.failQuery(transaction, error);
    self.pendingRequests.clear();
    self.queriesByRequestId.clear();
    self.runSubscriptions.clear();
    self.pushSubscriptions.clear();
    self.connectionSubscriptions.clear();
    self.runChannels.clear();
    for (const pending of [...self.pendingClones.values()])
        pending.reject(error);
    self.pendingClones.clear();
    self.activeRootObserver = null;
    self.mainChatRootObserver = null;
    self.terminalRequestIds.clear();
    self.clearRunActionGrants();
    for (const controller of self.inboundDesktopRequests.values())
        controller.abort();
    self.inboundDesktopRequests.clear();
    self.seenInboundDesktopRequestIds.clear();
    self.desktopBridgeProvider = null;
    self.clients.primary.dispose();
    self.clients.btw.dispose();
}

export function RealtimeBroker_handleConnectionState_8(self: RealtimeBrokerMethodContext, lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState) {
    const previous = self.connectionStates[lane].phase;
    self.connectionStates[lane] = state;
    if (lane === "primary")
        self.options.onConnectionState?.(state);
    for (const subscription of self.connectionSubscriptions.values()) {
        if (subscription.lane !== lane)
            continue;
        subscription.onState({ ...state, key: state.key ? { ...state.key } : null });
    }
    if (state.phase === "connected" && previous !== "connected") {
        for (const run of self.runChannels.values()) {
            if (run.lane === lane && run.suspended && !run.terminal &&
                (run.rootObserverTokens.size > 0 || self.hasSystemRunLease(run))) {
                void self.restoreRun(run);
            }
        }
        return;
    }
    if (state.phase !== "reconnecting" && state.phase !== "error")
        return;
    const disconnectError = brokerError("connection_lost_before_acceptance", state.lastError || "Agent Platform realtime connection lost");
    const requestError = brokerError("connection_unavailable", state.lastError || "Agent Platform realtime connection lost", { retryable: true });
    for (const pending of [...self.pendingRequests.values()]) {
        if (pending.lane !== lane)
            continue;
        self.cleanupPending(pending.upstreamId);
        pending.onError(requestError);
    }
    for (const transaction of [...self.queriesByRequestId.values()]) {
        if (transaction.lane !== lane)
            continue;
        if (!transaction.acceptedValue) {
            self.failQuery(transaction, disconnectError);
            continue;
        }
        const run = transaction.runId ? self.getRunChannel(transaction.runId, transaction.lane) : null;
        if (run) {
            run.suspended = true;
            run.upstreamRequestId = null;
        }
        self.queriesByRequestId.delete(transaction.upstreamRequestId);
    }
}

export function RealtimeBroker_handleFrame_9(self: RealtimeBrokerMethodContext, lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number) {
    if (!self.acceptingDelivery)
        return;
    if (generation !== self.connectionStates[lane].generation) {
        self.diagnostics.staleFrameCount += 1;
        return;
    }
    const kind = readText(frame.frame);
    if (kind === "push") {
        if (lane === "primary")
            self.handlePush(frame);
        return;
    }
    if (kind === "request") {
        self.handleInboundRequest(lane, frame);
        return;
    }
    if (!kind || !["response", "error", "stream"].includes(kind)) {
        self.diagnostics.unknownFrameCount += 1;
        return;
    }
    const id = readText(frame.id);
    if (!id) {
        self.diagnostics.unknownRequestIdCount += 1;
        return;
    }
    const query = self.queriesByRequestId.get(id);
    if (query) {
        if (query.lane !== lane) {
            self.diagnostics.staleFrameCount += 1;
            return;
        }
        if (kind === "error") {
            const message = readText(frame.msg) || readText(frame.message);
            const error = query.requestType === "/api/btw" &&
                readText(frame.type) === "invalid_request" &&
                message.includes("unknown type")
                ? brokerError("btw_ws_unsupported", "Agent Platform does not support BTW over WebSocket")
                : frameError(frame);
            self.failQuery(query, error);
        }
        else if (kind === "stream")
            self.handleQueryStream(query, frame);
        return;
    }
    const run = [...self.runChannels.values()].find((candidate) => candidate.lane === lane && candidate.upstreamRequestId === id);
    if (run && kind === "stream") {
        self.handleRunStream(run, frame);
        return;
    }
    const pending = self.pendingRequests.get(id);
    if (pending) {
        if (pending.lane !== lane) {
            self.diagnostics.staleFrameCount += 1;
            return;
        }
        const outbound = { ...frame, id: pending.localId };
        pending.onFrame(outbound);
        const terminalStream = kind === "stream" && Boolean(readText(frame.reason));
        if (kind === "response" || kind === "error" || terminalStream) {
            self.cleanupPending(id);
        }
        return;
    }
    if (kind === "stream" && self.terminalRequestIds.has(id)) {
        self.diagnostics.duplicateTerminalCount += 1;
        return;
    }
    self.diagnostics.unknownRequestIdCount += 1;
}

export function RealtimeBroker_handleQueryStream_10(self: RealtimeBrokerMethodContext, transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame) {
    let run = transaction.runId ? self.getRunChannel(transaction.runId, transaction.lane) : null;
    if (isRecord(frame.event)) {
        try {
            if (!run && readText(frame.event.type) !== "run.start") {
                self.bufferProvisionalQueryEvent(transaction, frame.event);
                return;
            }
            if (!run) {
                run = self.registerProvisionalRun(transaction, frame.event);
                self.commitProvisionalQueryEvents(run, transaction);
                self.bindQuerySubscription(run, transaction);
            }
            self.consumeRunEvent(run, frame.event, transaction);
        }
        catch (error) {
            self.failQuery(transaction, error);
            return;
        }
    }
    const reason = readText(frame.reason);
    if (!reason)
        return;
    if (!transaction.acceptedValue) {
        self.failQuery(transaction, brokerError("protocol_error", "query ended before run.start"));
        return;
    }
    if (!run) {
        self.failQuery(transaction, brokerError("protocol_error", "accepted query Run registry entry is missing"));
        return;
    }
    if (isObserverDetachReason(reason)) {
        self.releaseRunObserver(run, transaction.upstreamRequestId, reason, frame.lastSeq);
        return;
    }
    self.completeRun(run, {
        reason,
        ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, "query_stream");
}

export function RealtimeBroker_bufferProvisionalQueryEvent_11(self: RealtimeBrokerMethodContext, transaction: QueryTransaction, event: Record<string, unknown>) {
    const type = readText(event.type);
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex++}]`;
    if (!type)
        throw brokerError("protocol_error", "stream event.type is required");
    if (isTerminalEvent(type)) {
        throw brokerError("protocol_error", "terminal event arrived before run.start");
    }
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventChatId = readText(event.chatId);
    if (transaction.expectedChatId && eventChatId && transaction.expectedChatId !== eventChatId) {
        throw brokerError("protocol_error", "bootstrap chatId conflicts with query chatId");
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (transaction.bufferedEvents.length >= MAX_REPLAY_EVENTS ||
        transaction.bufferedEventBytes + bytes > MAX_REPLAY_BYTES) {
        throw brokerError("backpressure", "too many query events arrived before run.start");
    }
    transaction.bufferedEvents.push({ event, path });
    transaction.bufferedEventBytes += bytes;
}

export function RealtimeBroker_commitProvisionalQueryEvents_12(self: RealtimeBrokerMethodContext, run: BrokerRun, transaction: QueryTransaction) {
    for (const { event, path } of transaction.bufferedEvents) {
        const eventRunId = readText(event.runId);
        const eventChatId = readText(event.chatId);
        if (eventRunId && eventRunId !== run.runId) {
            throw brokerError("protocol_error", "bootstrap runId conflicts with canonical Run");
        }
        if (eventChatId && eventChatId !== run.chatId) {
            throw brokerError("protocol_error", "bootstrap chatId conflicts with canonical Run");
        }
        const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq)
            ? event.seq
            : null;
        if (seq !== null) {
            if (seq <= run.lastSeq) {
                self.diagnostics.seqRegressionCount += 1;
                continue;
            }
            if (run.lastSeq > 0 && seq > run.lastSeq + 1)
                self.diagnostics.seqGapCount += 1;
            run.lastSeq = seq;
        }
        self.appendReplay(run, event, seq, path);
    }
}
