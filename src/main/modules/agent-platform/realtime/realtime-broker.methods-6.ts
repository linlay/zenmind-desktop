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

export function RealtimeBroker_waitForCloneRun_1(self: RealtimeBrokerMethodContext, kind: "overview" | "debug", observerToken: string, runIdValue: string, chatIdValue: string, owner: AgentWebclientRunOwner, consumerId: string) {
    const runId = runIdValue.trim();
    const chatId = chatIdValue.trim();
    const run = self.getRunChannel(runId);
    if (run && run.chatId === chatId && run.rootObserverTokens.has(observerToken) &&
        (!run.owner || sameRunOwner(run.owner, owner)))
        return Promise.resolve("ready" as const);
    if (run && (run.chatId !== chatId || (run.owner && !sameRunOwner(run.owner, owner)))) {
        return Promise.reject(cloneBindingError("visible_run_changed", "requested Run identity does not match the active Main Chat lease"));
    }
    const pendingQuery = [...self.queriesByRequestId.values()].some((transaction) => transaction.rootObserverToken === observerToken &&
        transaction.runId === null &&
        transaction.expectedRunId === runId &&
        (!transaction.expectedChatId || transaction.expectedChatId === chatId));
    if (!pendingQuery && kind !== "overview") {
        return Promise.reject(cloneBindingError("run_not_registered", "requested Run is not registered for the active Main Chat observer"));
    }
    return new Promise<"ready" | "detached">((resolve, reject) => {
        const id = `pending-clone-${randomUUID()}`;
        const parent = self.findRootObserver(observerToken);
        const parentGeneration = parent
            ? parent.generation
            : "";
        self.pendingClones.set(id, {
            id,
            kind,
            consumerId,
            observerToken,
            parentGeneration,
            runId,
            chatId,
            owner,
            waitReason: "awaiting_run_start",
            resolve: (outcome: "ready" | "detached") => {
                self.pendingClones.delete(id);
                if (kind === "overview")
                    parent?.overviewLease?.pendingCloneIds.delete(id);
                resolve(outcome);
            },
            reject: (error: Error) => {
                self.pendingClones.delete(id);
                if (kind === "overview")
                    parent?.overviewLease?.pendingCloneIds.delete(id);
                const details = (error as Error & {
                    details?: unknown;
                }).details;
                const reason = isRecord(details) ? readText(details.reason) : "";
                self.lastCloneCancellationReason = reason || error.name || "clone_cancelled";
                reject(error);
            },
        });
        if (kind === "overview")
            parent?.overviewLease?.pendingCloneIds.add(id);
    });
}

export function RealtimeBroker_notifyPendingClones_2(self: RealtimeBrokerMethodContext, run: BrokerRun) {
    for (const pending of [...self.pendingClones.values()]) {
        if (pending.runId !== run.runId || pending.chatId !== run.chatId)
            continue;
        if (!run.rootObserverTokens.has(pending.observerToken))
            continue;
        if (run.owner && !sameRunOwner(run.owner, pending.owner)) {
            pending.reject(cloneBindingError("visible_run_changed", "clone Run owner changed"));
            continue;
        }
        pending.resolve("ready");
    }
}

export function RealtimeBroker_rejectPendingClones_3(self: RealtimeBrokerMethodContext, observerToken: string, error: Error) {
    for (const pending of [...self.pendingClones.values()]) {
        if (pending.observerToken === observerToken)
            pending.reject(error);
    }
}

export function RealtimeBroker_detachPendingClones_4(self: RealtimeBrokerMethodContext, observerToken: string) {
    for (const pending of [...self.pendingClones.values()]) {
        if (pending.observerToken === observerToken)
            pending.resolve("detached");
    }
}

export function RealtimeBroker_pruneRetainedTerminalRuns_5(self: RealtimeBrokerMethodContext) {
    const removable = [...self.runChannels.values()].filter((run) => run.terminal &&
        run.rootObserverTokens.size === 0 &&
        run.subscribers.size === 0 &&
        !run.query &&
        !run.upstreamRequestId);
    while (removable.length > MAX_RETAINED_TERMINAL_RUNS) {
        const run = removable.shift();
        if (!run)
            break;
        self.deleteRunChannel(run);
    }
}

export function RealtimeBroker_hasSystemRunLease_6(self: RealtimeBrokerMethodContext, run: BrokerRun) {
    return [...run.subscribers].some((id) => self.runSubscriptions.get(id)?.role === "internal");
}

export function RealtimeBroker_detachRunIfUnobserved_7(self: RealtimeBrokerMethodContext, run: BrokerRun, reason: string) {
    if (run.terminal || run.rootObserverTokens.size > 0 || self.hasSystemRunLease(run) ||
        !run.upstreamRequestId || !run.baseUrl || !run.accessToken)
        return Promise.resolve();
    if (run.detachInFlight)
        return run.detachInFlight;
    run.suspended = true;
    const operationGeneration = ++run.operationGeneration;
    const detach = new Promise<void>((resolve) => {
        void self.ensureConnected(run.baseUrl, run.accessToken, run.lane).then(() => {
            if (run.operationGeneration !== operationGeneration ||
                run.rootObserverTokens.size > 0 ||
                self.hasSystemRunLease(run)) {
                run.suspended = false;
                resolve();
                return;
            }
            void self.forwardRequest({
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
                        self.releaseRunObserver(run, detachedRequestId, "detached", payload.lastSeq);
                    }
                    resolve();
                },
                onError: () => resolve(),
            }).catch(() => resolve());
            self.diagnostics.upstreamDetachCount += 1;
        }).catch(() => resolve());
    }).finally(() => {
        if (run.detachInFlight === detach)
            run.detachInFlight = null;
        if ((run.rootObserverTokens.size > 0 || self.hasSystemRunLease(run)) &&
            !run.terminal && !run.upstreamRequestId) {
            void self.startAttach(run, run.baseUrl, run.accessToken);
        }
    });
    run.detachInFlight = detach;
    return detach;
}

export function RealtimeBroker_cleanupPending_8(self: RealtimeBrokerMethodContext, upstreamId: string) {
    const pending = self.pendingRequests.get(upstreamId);
    if (!pending)
        return;
    if (pending.timer)
        clearTimeout(pending.timer);
    self.pendingRequests.delete(upstreamId);
}

export function RealtimeBroker_prepareConnectionIdentity_9(self: RealtimeBrokerMethodContext, baseUrl: string, token: string) {
    const reason = self.clients.primary.getRotationReason(baseUrl, token) ??
        self.clients.btw.getRotationReason(baseUrl, token);
    if (reason) {
        self.rotateIdentity(reason);
    }
}
