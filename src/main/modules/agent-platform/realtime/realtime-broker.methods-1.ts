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

export function RealtimeBroker_getConnectionPhase_1(self: RealtimeBrokerMethodContext): AgentWebclientConnectionPhase {
    return self.connectionStates.primary.phase;
}

export function RealtimeBroker_getConnectionState_2(self: RealtimeBrokerMethodContext, lane: RealtimeLane = "primary") {
    return self.clients[lane].getState();
}

export function RealtimeBroker_getConnectionStates_3(self: RealtimeBrokerMethodContext) {
    return {
        primary: self.clients.primary.getState(),
        btw: self.clients.btw.getState(),
    };
}

export function RealtimeBroker_setDesktopBridgeProvider_4(self: RealtimeBrokerMethodContext, provider: DesktopBridgeRequestProvider | null) {
    self.desktopBridgeProvider = provider;
}

export function RealtimeBroker_getRunChannel_5(self: RealtimeBrokerMethodContext, runIdValue: string, lane?: RealtimeLane) {
    const runId = runIdValue.trim();
    if (!runId)
        return undefined;
    if (lane)
        return self.runChannels.get(runChannelMapKey({ lane, runId }));
    return [...self.runChannels.values()].find((run) => run.runId === runId);
}

export function RealtimeBroker_setRunChannel_6(self: RealtimeBrokerMethodContext, run: BrokerRun) {
    self.runChannels.set(runChannelMapKey(run), run);
}

export function RealtimeBroker_deleteRunChannel_7(self: RealtimeBrokerMethodContext, run: BrokerRun) {
    return self.runChannels.delete(runChannelMapKey(run));
}

export function RealtimeBroker_findRootObserver_8(self: RealtimeBrokerMethodContext, tokenValue: string) {
    const token = tokenValue.trim();
    if (!token)
        return null;
    if (self.mainChatRootObserver?.token === token)
        return self.mainChatRootObserver;
    if (self.activeRootObserver?.token === token)
        return self.activeRootObserver;
    return null;
}

export function RealtimeBroker_snapshotRootObserver_9(self: RealtimeBrokerMethodContext, observer: RootObserverState | null) {
    return observer
        ? {
            token: observer.token,
            kind: observer.kind,
            surfaceId: observer.surfaceId,
            generation: observer.generation,
            contextId: observer.contextId,
            contextEpoch: observer.contextEpoch,
            webContentsId: observer.webContentsId,
            runIds: new Set(observer.runIds),
        }
        : null;
}

export async function RealtimeBroker_ensureConnected_10(self: RealtimeBrokerMethodContext, baseUrl: string, token: string, lane: RealtimeLane = "primary") {
    if (self.disposed || !self.acceptingDelivery) {
        throw brokerError("connection_unavailable", "Realtime Broker is disposed");
    }
    self.prepareConnectionIdentity(baseUrl, token);
    await self.clients[lane].ensureConnected(baseUrl, token);
}

export function RealtimeBroker_query_11(self: RealtimeBrokerMethodContext, options: {
    baseUrl: string;
    token: string;
    id: string;
    payload: Record<string, unknown>;
    runId?: string;
    chatId?: string;
    owner?: AgentWebclientRunOwner;
    signal?: AbortSignal;
    onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
    consumerId?: string;
    lane?: RealtimeLane;
    requestType?: "/api/query" | "/api/btw";
    observerToken?: string;
  }): RealtimeQueryHandle {
    const accepted = createDeferred<RealtimeQueryAccepted>();
    const completed = createDeferred<RealtimeQueryCompleted>();
    const operationId = options.id.trim();
    const expectedRunId = options.runId?.trim() || "";
    const expectedChatId = options.chatId?.trim() || "";
    const lane = options.lane ?? (options.requestType === "/api/btw" ? "btw" : "primary");
    const requestType = options.requestType ?? (lane === "btw" ? "/api/btw" : "/api/query");
    if (!self.acceptingDelivery) {
        const error = brokerError("connection_unavailable", "Realtime Broker is shutting down");
        accepted.reject(error);
        completed.reject(error);
        return { accepted: accepted.promise, completed: completed.promise };
    }
    self.prepareConnectionIdentity(options.baseUrl, options.token);
    if (!operationId) {
        const error = brokerError("invalid_request", "query id is required");
        accepted.reject(error);
        completed.reject(error);
        return { accepted: accepted.promise, completed: completed.promise };
    }
    const observerToken = options.observerToken?.trim() || "";
    const observer = observerToken ? self.findRootObserver(observerToken) : null;
    if (observerToken && !observer) {
        const error = brokerError("surface_generation_superseded", "Root Observer is no longer active");
        accepted.reject(error);
        completed.reject(error);
        return { accepted: accepted.promise, completed: completed.promise };
    }
    if (observer?.kind === "main_chat" &&
        observer.overviewLease?.state === "ready" &&
        expectedChatId && observer.overviewLease.chatId !== expectedChatId) {
        const error = brokerError("protocol_error", "query Chat does not match the active Main Chat context");
        accepted.reject(error);
        completed.reject(error);
        return { accepted: accepted.promise, completed: completed.promise };
    }
    const upstreamRequestId = `desktop-query-${randomUUID()}`;
    const transaction: QueryTransaction = {
        lane,
        requestType,
        operationId,
        upstreamRequestId,
        runId: null,
        chatId: null,
        expectedRunId,
        expectedChatId,
        expectedOwner: options.owner ?? null,
        accepted,
        completed,
        onEvent: options.onEvent,
        eventIndex: 0,
        acceptedValue: null,
        bufferedEvents: [],
        bufferedEventBytes: 0,
        eventQueue: Promise.resolve(),
        acceptanceTimer: null,
        signal: options.signal,
        rootObserverToken: observerToken || null,
        consumerId: options.consumerId?.trim() || `query:${operationId}`,
        subscriptionId: null,
        baseUrl: options.baseUrl,
        accessToken: options.token,
    };
    self.queriesByRequestId.set(upstreamRequestId, transaction);
    transaction.acceptanceTimer = setTimeout(() => {
        self.failQuery(transaction, brokerError("connection_unavailable", "query acceptance timed out"));
    }, self.options.acceptanceTimeoutMs ?? REQUEST_TIMEOUT_MS);
    if (options.signal) {
        transaction.abortListener = () => {
            self.failQuery(transaction, brokerError("connection_unavailable", "query aborted"));
        };
        options.signal.addEventListener("abort", transaction.abortListener, { once: true });
    }
    void self.ensureConnected(options.baseUrl, options.token, lane)
        .then(() => {
        if (options.signal?.aborted) {
            throw brokerError("connection_unavailable", "query aborted");
        }
        self.clients[lane].send({
            frame: "request",
            type: requestType,
            id: upstreamRequestId,
            payload: options.payload,
        });
    })
        .catch((error: unknown) => self.failQuery(transaction, error));
    return { accepted: accepted.promise, completed: completed.promise };
}

export async function RealtimeBroker_forwardRequest_12(self: RealtimeBrokerMethodContext, options: {
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
  }) {
    if (!self.acceptingDelivery) {
        throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    self.prepareConnectionIdentity(options.baseUrl, options.token);
    const localId = options.localId.trim();
    const type = options.type.trim();
    const payloadRunId = readText(options.payload?.runId);
    const registeredLane = payloadRunId ? self.getRunChannel(payloadRunId)?.lane : undefined;
    const lane = options.lane ?? registeredLane ?? (type === "/api/btw" ? "btw" : "primary");
    if (!localId || !type) {
        throw brokerError("invalid_request", "request id and type are required");
    }
    const upstreamId = `desktop-forward-${randomUUID()}`;
    const timer = options.stream
        ? null
        : unrefTimer(setTimeout(() => {
            const pending = self.pendingRequests.get(upstreamId);
            if (!pending)
                return;
            self.pendingRequests.delete(upstreamId);
            pending.onError(brokerError("connection_unavailable", `${type} timed out`));
        }, REQUEST_TIMEOUT_MS));
    self.pendingRequests.set(upstreamId, {
        lane,
        consumerId: options.consumerId,
        localId,
        upstreamId,
        type,
        stream: Boolean(options.stream),
        timer,
        onFrame: options.onFrame,
        onError: options.onError,
    });
    try {
        await self.ensureConnected(options.baseUrl, options.token, lane);
        self.clients[lane].send({
            frame: "request",
            type,
            id: upstreamId,
            payload: options.payload ?? {},
        });
    }
    catch (error) {
        self.cleanupPending(upstreamId);
        throw error;
    }
    return upstreamId;
}

export function RealtimeBroker_activateRootObserver_13(self: RealtimeBrokerMethodContext, input: RootObserverIdentity) {
    const token = input.token.trim();
    const surfaceId = input.surfaceId.trim();
    const generation = input.generation.trim();
    const contextId = input.contextId.trim();
    if (!token || !surfaceId || !generation || !contextId || !Number.isSafeInteger(input.webContentsId)) {
        throw brokerError("invalid_request", "Root Observer identity is incomplete");
    }
    const current = input.kind === "main_chat"
        ? self.mainChatRootObserver
        : self.activeRootObserver?.kind === input.kind
            ? self.activeRootObserver
            : null;
    if (current?.token === token) {
        if (input.kind === "main_chat" &&
            current.overviewLease?.state === "pending_chat_identity" &&
            contextId !== current.contextId) {
            self.promoteMainChatRootObserver(token, contextId);
        }
        return input.kind === "main_chat"
            ? self.getMainChatRootObserver()
            : self.getActiveRootObserver();
    }
    const contextEpoch = `root-context-${randomUUID()}`;
    const next: RootObserverState = {
        ...input,
        token,
        surfaceId,
        generation,
        contextId,
        contextEpoch,
        runIds: new Set(),
        overviewLease: input.kind === "main_chat"
            ? {
                state: contextId === `${surfaceId}:${generation}` ? "pending_chat_identity" : "ready",
                parentToken: token,
                parentGeneration: generation,
                contextEpoch,
                chatId: contextId === `${surfaceId}:${generation}` ? null : contextId,
                runIds: new Set(),
                pendingCloneIds: new Set(),
                subscriberIds: new Set(),
            }
            : null,
    };
    if (input.kind === "main_chat") {
        self.mainChatRootObserver = next;
        if (!self.activeRootObserver || self.activeRootObserver.kind === "main_chat") {
            self.activeRootObserver = next;
        }
    }
    else {
        const previousActive = self.activeRootObserver;
        self.activeRootObserver = next;
        if (previousActive && previousActive.kind !== "main_chat" && previousActive !== current) {
            self.retireRootObserver(previousActive, "surface_generation_superseded");
        }
    }
    if (current)
        self.retireRootObserver(current, "surface_generation_superseded");
    return input.kind === "main_chat"
        ? self.getMainChatRootObserver()
        : self.getActiveRootObserver();
}

export function RealtimeBroker_getActiveRootObserver_14(self: RealtimeBrokerMethodContext) {
    return self.snapshotRootObserver(self.activeRootObserver);
}

export function RealtimeBroker_getMainChatRootObserver_15(self: RealtimeBrokerMethodContext) {
    return self.snapshotRootObserver(self.mainChatRootObserver);
}

export function RealtimeBroker_promoteMainChatRootObserver_16(self: RealtimeBrokerMethodContext, tokenValue: string, chatIdValue: string) {
    const token = tokenValue.trim();
    const chatId = chatIdValue.trim();
    const observer = self.mainChatRootObserver;
    if (!token || !chatId || !observer || observer.token !== token || !observer.overviewLease) {
        throw brokerError("surface_generation_superseded", "Main Chat Root Observer is no longer active");
    }
    const lease = observer.overviewLease;
    if (lease.state === "ready" && lease.chatId !== chatId) {
        throw brokerError("protocol_error", "canonical Chat identity conflicts with the Main Chat context");
    }
    observer.contextId = chatId;
    lease.state = "ready";
    lease.chatId = chatId;
    return self.getMainChatRootObserver();
}

export function RealtimeBroker_releaseRootObserver_17(self: RealtimeBrokerMethodContext, tokenValue: string, reason = "parent_observer_closed") {
    const token = tokenValue.trim();
    if (!token)
        return false;
    const observer = self.findRootObserver(token);
    if (!observer)
        return false;
    if (self.mainChatRootObserver === observer)
        self.mainChatRootObserver = null;
    if (self.activeRootObserver === observer) {
        self.activeRootObserver = self.mainChatRootObserver;
    }
    self.retireRootObserver(observer, reason);
    return true;
}

export function RealtimeBroker_retireRootObserver_18(self: RealtimeBrokerMethodContext, observer: RootObserverState, reason: string) {
    const token = observer.token;
    self.detachPendingClones(token);
    for (const subscription of [...self.runSubscriptions.values()]) {
        if (subscription.observerToken !== token)
            continue;
        self.unsubscribe(subscription.id);
        if (subscription.role === "clone") {
            const run = self.getRunChannel(subscription.runId, subscription.lane);
            subscription.onComplete?.({
                reason: "detached",
                ...(run ? { lastSeq: run.lastSeq } : {}),
            });
        }
    }
    for (const run of self.runChannels.values()) {
        if (!run.rootObserverTokens.delete(token))
            continue;
        void self.detachRunIfUnobserved(run, reason);
    }
    self.pruneRetainedTerminalRuns();
}

export function RealtimeBroker_releaseObservedRun_19(self: RealtimeBrokerMethodContext, observerTokenValue: string, runIdValue: string, reason = "surface_inactive") {
    const observerToken = observerTokenValue.trim();
    const runId = runIdValue.trim();
    const run = self.getRunChannel(runId);
    if (!observerToken || !run || !run.rootObserverTokens.delete(observerToken))
        return false;
    const observer = self.findRootObserver(observerToken);
    observer?.runIds.delete(runId);
    observer?.overviewLease?.runIds.delete(runId);
    for (const subscription of [...self.runSubscriptions.values()]) {
        if (subscription.runId !== runId || subscription.observerToken !== observerToken)
            continue;
        self.unsubscribe(subscription.id);
        if (subscription.role === "clone") {
            subscription.onComplete?.({ reason: "detached", lastSeq: run.lastSeq });
        }
    }
    void self.detachRunIfUnobserved(run, reason);
    self.pruneRetainedTerminalRuns();
    return true;
}
