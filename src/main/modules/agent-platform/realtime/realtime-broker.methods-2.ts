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

export async function RealtimeBroker_subscribeClone_1(self: RealtimeBrokerMethodContext, options: {
    kind?: "overview" | "debug";
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner: AgentWebclientRunOwner;
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }) {
    const kind = options.kind ?? "debug";
    const observer = self.mainChatRootObserver;
    const chatId = options.chatId.trim();
    const overviewLease = kind === "overview" ? observer?.overviewLease ?? null : null;
    if (!observer || observer.kind !== "main_chat" ||
        (kind === "overview"
            ? !overviewLease || overviewLease.state !== "ready" || overviewLease.chatId !== chatId
            : observer.contextId !== chatId)) {
        throw cloneBindingError("parent_observer_closed", "active Main Chat observer does not match the clone");
    }
    const waitOutcome = await self.waitForCloneRun(kind, observer.token, options.runId, options.chatId, options.owner, options.consumerId);
    if (waitOutcome === "detached") {
        const id = `clone-sub-${randomUUID()}`;
        queueMicrotask(() => options.onComplete?.({ reason: "detached" }));
        return {
            subscriptionId: id,
            unsubscribe: () => false,
            ready: Promise.resolve(),
        };
    }
    const current = self.mainChatRootObserver;
    const run = self.getRunChannel(options.runId);
    if (!current || current.token !== observer.token || !run || !run.rootObserverTokens.has(observer.token)) {
        throw cloneBindingError("surface_generation_superseded", "Main Chat observer changed before clone binding");
    }
    if (run.chatId !== options.chatId.trim() || (run.owner && !sameRunOwner(run.owner, options.owner))) {
        throw cloneBindingError("visible_run_changed", "clone Run identity no longer matches Main Chat");
    }
    const id = `clone-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
        id,
        lane: run.lane,
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: Math.max(0, options.lastSeq ?? 0),
        kind: "surface",
        consumerId: options.consumerId,
        role: "clone",
        observerToken: observer.token,
        onEvent: options.onEvent,
        onComplete: options.onComplete,
        onError: options.onError,
    };
    self.replayToSubscriber(run, subscription);
    if (run.terminal) {
        queueMicrotask(() => options.onComplete?.({
            reason: run.terminalReason || "done",
            lastSeq: run.lastSeq,
        }));
        return {
            subscriptionId: id,
            unsubscribe: () => false,
            ready: Promise.resolve(),
        };
    }
    self.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    if (kind === "overview")
        overviewLease!.subscriberIds.add(id);
    self.diagnostics.cloneCreatedCount += 1;
    return {
        subscriptionId: id,
        unsubscribe: () => self.unsubscribe(id),
        ready: Promise.resolve(),
    };
}

export function RealtimeBroker_subscribePush_2(self: RealtimeBrokerMethodContext, options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }) {
    if (!self.acceptingDelivery) {
        throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    const types = new Set(options.types.map((type) => type.trim()).filter((type) => AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)));
    if (types.size === 0) {
        throw brokerError("invalid_request", "at least one known push type is required");
    }
    const id = `push-sub-${randomUUID()}`;
    self.pushSubscriptions.set(id, { id, ...options, types });
    return () => self.unsubscribe(id);
}

export function RealtimeBroker_subscribeConnection_3(self: RealtimeBrokerMethodContext, options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }) {
    const lane = options.lane ?? "primary";
    const id = `connection-sub-${randomUUID()}`;
    self.connectionSubscriptions.set(id, { id, ...options, lane });
    options.onState(self.clients[lane].getState());
    return () => self.connectionSubscriptions.delete(id);
}

export function RealtimeBroker_subscribeRun_4(self: RealtimeBrokerMethodContext, options: {
    baseUrl: string;
    token: string;
    runId: string;
    chatId: string;
    lastSeq?: number;
    agentKey?: string;
    owner?: AgentWebclientRunOwner;
    kind: "surface" | "internal";
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
    lane?: RealtimeLane;
    role?: "root_observer" | "clone" | "internal";
    observerToken?: string;
  }) {
    if (!self.acceptingDelivery) {
        throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    self.prepareConnectionIdentity(options.baseUrl, options.token);
    const runId = options.runId.trim();
    const chatId = options.chatId.trim();
    const lane = options.lane ?? "primary";
    if (!runId || !chatId) {
        throw brokerError("invalid_request", "runId and chatId are required");
    }
    const id = `run-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
        lane,
        id,
        runId,
        chatId,
        lastSeq: Math.max(0, options.lastSeq ?? 0),
        kind: options.kind,
        consumerId: options.consumerId,
        onEvent: options.onEvent,
        onComplete: options.onComplete,
        onError: options.onError,
        role: options.role ?? (options.kind === "internal" ? "internal" : "root_observer"),
        ...(options.observerToken ? { observerToken: options.observerToken } : {}),
    };
    let run = self.getRunChannel(runId, lane);
    if (!run) {
        if (self.getRunChannel(runId)) {
            throw brokerError("invalid_request", "runId belongs to a different Realtime lane");
        }
        run = {
            lane,
            runId,
            chatId,
            owner: options.owner ?? (options.agentKey?.trim()
                ? { kind: "agent", agentKey: options.agentKey.trim() }
                : null),
            lastSeq: Math.max(0, options.lastSeq ?? 0),
            terminal: false,
            terminalReason: "",
            terminalSource: null,
            suspended: false,
            restoreInFlight: false,
            restoreCount: 0,
            lastRestoreResult: "never",
            upstreamRequestId: null,
            query: null,
            replay: [],
            replayBytes: 0,
            subscribers: new Set(),
            rootObserverTokens: new Set(),
            baseUrl: options.baseUrl,
            accessToken: options.token,
            detachInFlight: null,
            operationGeneration: 0,
        };
        self.setRunChannel(run);
    }
    else if (run.chatId !== chatId) {
        throw brokerError("invalid_request", "runId belongs to a different chat");
    }
    else if (options.owner && run.owner && !sameRunOwner(run.owner, options.owner)) {
        throw brokerError("invalid_request", "runId belongs to a different Run owner");
    }
    if (subscription.role === "root_observer") {
        const observerToken = subscription.observerToken?.trim() || "";
        const observer = observerToken ? self.findRootObserver(observerToken) : null;
        if (!observerToken || !observer) {
            throw brokerError("surface_generation_superseded", "Root Observer is no longer active");
        }
        if (observer.kind === "main_chat" &&
            observer.overviewLease?.state === "ready" &&
            observer.overviewLease.chatId !== chatId) {
            throw brokerError("protocol_error", "Run Chat does not match the active Main Chat context");
        }
    }
    self.replayToSubscriber(run, subscription);
    if (run.terminal) {
        queueMicrotask(() => options.onComplete?.({
            reason: run.terminalReason || "done",
            lastSeq: run.lastSeq,
        }));
        return {
            subscriptionId: id,
            unsubscribe: () => false,
            ready: Promise.resolve(),
        };
    }
    self.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    if (subscription.role === "root_observer") {
        const observerToken = subscription.observerToken!.trim();
        const observer = self.findRootObserver(observerToken)!;
        run.operationGeneration += 1;
        run.rootObserverTokens.add(observerToken);
        observer.runIds.add(run.runId);
        observer.overviewLease?.runIds.add(run.runId);
        self.notifyPendingClones(run);
    }
    run.baseUrl = options.baseUrl;
    run.accessToken = options.token;
    const ready = !run.terminal && !run.upstreamRequestId
        ? Promise.resolve(run.detachInFlight).then(() => self.startAttach(run, options.baseUrl, options.token)).catch((error) => {
            subscription.onError?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
        })
        : Promise.resolve();
    return {
        subscriptionId: id,
        unsubscribe: () => self.unsubscribe(id),
        ready,
    };
}

export function RealtimeBroker_unsubscribe_5(self: RealtimeBrokerMethodContext, subscriptionId: string) {
    const push = self.pushSubscriptions.get(subscriptionId);
    if (push) {
        self.pushSubscriptions.delete(subscriptionId);
        return true;
    }
    const runSubscription = self.runSubscriptions.get(subscriptionId);
    if (!runSubscription)
        return false;
    self.runSubscriptions.delete(subscriptionId);
    if (runSubscription.role === "clone")
        self.diagnostics.cloneRevokedCount += 1;
    self.mainChatRootObserver?.overviewLease?.subscriberIds.delete(subscriptionId);
    const subscribedRun = self.getRunChannel(runSubscription.runId, runSubscription.lane);
    subscribedRun?.subscribers.delete(subscriptionId);
    if (subscribedRun && runSubscription.role === "root_observer" && runSubscription.observerToken) {
        const stillObserved = [...self.runSubscriptions.values()].some((candidate) => candidate.role === "root_observer" &&
            candidate.runId === runSubscription.runId &&
            candidate.observerToken === runSubscription.observerToken);
        if (!stillObserved && subscribedRun.rootObserverTokens.delete(runSubscription.observerToken)) {
            const observer = self.findRootObserver(runSubscription.observerToken);
            observer?.runIds.delete(subscribedRun.runId);
            observer?.overviewLease?.runIds.delete(subscribedRun.runId);
            void self.detachRunIfUnobserved(subscribedRun, "surface_inactive");
        }
    }
    return true;
}

export function RealtimeBroker_registerRunActionGrant_6(self: RealtimeBrokerMethodContext, input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }) {
    const sourceId = input.sourceId.trim();
    const chatId = input.chatId.trim();
    const runId = input.runId.trim();
    if (!sourceId || !chatId || !runId) {
        throw brokerError("invalid_request", "canonical Run WorkPanel grant identity is incomplete");
    }
    const existing = self.runActionGrants.get(runId);
    if (existing && (existing.chatId !== chatId ||
        !sameRunOwner(existing.owner, input.owner))) {
        throw brokerError("duplicate_id", "canonical Run WorkPanel grant identity conflicts");
    }
    if (existing && input.replaceExisting === false)
        return;
    const generation = (existing?.generation ?? 0) + 1;
    let supersede: () => void = () => undefined;
    const superseded = new Promise<void>((resolve) => {
        supersede = resolve;
    });
    const grant: RunActionGrant = {
        sourceId,
        chatId,
        runId,
        owner: input.owner,
        generation,
        state: "pending",
        failureMessage: "",
        ready: Promise.resolve(),
        superseded,
        supersede,
    };
    grant.ready = input.ready.then(() => {
        const current = self.runActionGrants.get(runId);
        if (current !== grant || current.generation !== generation)
            return;
        current.state = "ready";
        current.failureMessage = "";
    }, (error) => {
        const current = self.runActionGrants.get(runId);
        if (current === grant && current.generation === generation) {
            current.state = "failed";
            current.failureMessage = error instanceof Error ? error.message : String(error);
        }
        throw error;
    });
    void grant.ready.catch(() => undefined);
    existing?.supersede();
    self.runActionGrants.set(runId, grant);
    while (self.runActionGrants.size > 2000) {
        const oldest = self.runActionGrants.keys().next().value as string | undefined;
        if (!oldest)
            break;
        self.revokeRunActionGrant(oldest);
    }
}

export function RealtimeBroker_revokeRunActionGrant_7(self: RealtimeBrokerMethodContext, runIdValue: string) {
    const runId = runIdValue.trim();
    if (!runId)
        return false;
    const grant = self.runActionGrants.get(runId);
    if (!grant)
        return false;
    self.runActionGrants.delete(runId);
    grant.supersede();
    return true;
}

export function RealtimeBroker_clearRunActionGrants_8(self: RealtimeBrokerMethodContext) {
    self.siteCdpGrants.revokeAll();
    for (const grant of self.runActionGrants.values())
        grant.supersede();
    self.runActionGrants.clear();
}

export function RealtimeBroker_cleanupConsumer_9(self: RealtimeBrokerMethodContext, consumerId: string) {
    const error = brokerError("target_unavailable", "realtime consumer was destroyed");
    for (const pending of [...self.pendingRequests.values()]) {
        if (pending.consumerId !== consumerId)
            continue;
        self.cleanupPending(pending.upstreamId);
        pending.onError(error);
    }
    for (const subscription of [...self.pushSubscriptions.values()]) {
        if (subscription.consumerId === consumerId)
            self.unsubscribe(subscription.id);
    }
    for (const subscription of [...self.runSubscriptions.values()]) {
        if (subscription.consumerId === consumerId)
            self.unsubscribe(subscription.id);
    }
    for (const subscription of [...self.connectionSubscriptions.values()]) {
        if (subscription.consumerId === consumerId)
            self.connectionSubscriptions.delete(subscription.id);
    }
    for (const pending of [...self.pendingClones.values()]) {
        if (pending.consumerId === consumerId)
            pending.reject(error);
    }
}
