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

export function RealtimeBroker_handlePush_1(self: RealtimeBrokerMethodContext, frame: AgentPlatformRealtimeFrame) {
    const type = readText(frame.type);
    if (type === "desktop.bridge.cancel") {
        const requestId = readText(framePayload(frame).requestId);
        const controller = self.inboundDesktopRequests.get(requestId);
        controller?.abort();
        self.inboundDesktopRequests.delete(requestId);
        return;
    }
    if (!AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)) {
        self.diagnostics.unknownFrameCount += 1;
        return;
    }
    if (type === "connected" || type === "heartbeat" || type === "live.connected")
        return;
    const invalidTime = validateAgentPlatformPushTimeContract(type, framePayload(frame));
    if (invalidTime) {
        self.options.onDiagnostic?.(`time_contract_violation: push.${type}.${invalidTime}`);
        return;
    }
    if (type === "run.finished" || type === "run.complete") {
        const runId = pushIdentity(frame, "runId");
        self.revokeRunActionGrant(runId);
        const run = self.getRunChannel(runId);
        if (run && !run.terminal) {
            const payload = framePayload(frame);
            self.completeRun(run, {
                reason: readText(payload.finishReason) || readText(payload.status) || "finished",
                ...(typeof payload.lastSeq === "number" ? { lastSeq: payload.lastSeq } : {}),
            }, "push");
        }
    }
    for (const subscription of self.pushSubscriptions.values()) {
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

export function RealtimeBroker_handleInboundRequest_2(self: RealtimeBrokerMethodContext, lane: RealtimeLane, frame: AgentPlatformRealtimeFrame) {
    const id = readText(frame.id);
    if (!id)
        return;
    const type = readText(frame.type);
    if (lane === "primary" && (getDesktopActionDefinition(type) || type === DESKTOP_CDP_REQUEST_TYPE)) {
        void self.handleDesktopBridgeRequest(id, type, frame);
        return;
    }
    const errorType = lane === "primary" ? "unsupported_in_current_view" : "unknown_request_type";
    try {
        self.clients[lane].send({
            frame: "error",
            type: errorType,
            id,
            code: 409,
            msg: lane === "primary"
                ? "Desktop cannot handle this request in the current view"
                : "Desktop BTW lane does not support inbound requests",
            data: {
                code: errorType,
                message: lane === "primary"
                    ? "Inbound request is unsupported in the current view"
                    : "Inbound request type is unknown",
            },
        });
    }
    catch {
        // The connection is already unavailable.
    }
}

export async function RealtimeBroker_handleDesktopBridgeRequest_3(self: RealtimeBrokerMethodContext, id: string, type: string, frame: AgentPlatformRealtimeFrame) {
    if (self.inboundDesktopRequests.has(id) || self.seenInboundDesktopRequestIds.has(id)) {
        self.sendDesktopBridgeError(id, "duplicate_id", 409, "Desktop bridge request id was already used");
        return;
    }
    self.seenInboundDesktopRequestIds.add(id);
    if (self.seenInboundDesktopRequestIds.size > 2000) {
        self.seenInboundDesktopRequestIds.delete(self.seenInboundDesktopRequestIds.values().next().value as string);
    }
    const provider = self.desktopBridgeProvider;
    if (!provider) {
        self.sendDesktopBridgeError(id, "desktop_provider_unavailable", 503, "Desktop bridge provider is unavailable");
        return;
    }
    if (!isRecord(frame.payload)) {
        self.sendDesktopBridgeError(id, "invalid_request", 400, "Desktop bridge payload must be an object");
        return;
    }
    const controller = new AbortController();
    self.inboundDesktopRequests.set(id, controller);
    try {
        const isDesktopAction = type !== DESKTOP_CDP_REQUEST_TYPE;
        let actionRequest: Record<string, unknown> | null = null;
        if (isDesktopAction) {
            const source = isRecord(frame.source) ? frame.source : {};
            const runId = readText(source.runId);
            const chatId = readText(source.chatId);
            const agentKey = readText(source.agentKey);
            const teamId = readText(source.teamId);
            if (!runId || !chatId || (agentKey && teamId)) {
                throw brokerError("protocol_error", "Desktop Action source must include runId and chatId and at most one Run owner");
            }
            await self.awaitRunActionReadiness(type, source, controller.signal);
            if (controller.signal.aborted)
                return;
            actionRequest = {
                requestId: id,
                action: type,
                args: frame.payload,
                source,
            };
        }
        const result = isDesktopAction
            ? await provider.action(actionRequest as Record<string, unknown>)
            : await provider.cdp(frame.payload);
        if (controller.signal.aborted)
            return;
        if (!isRecord(result)) {
            self.sendDesktopBridgeError(id, "invalid_desktop_response", 502, "Desktop bridge response must be an object");
            return;
        }
        if (result.ok !== true) {
            const error = isRecord(result.error) ? result.error : {};
            self.sendDesktopBridgeError(id, readText(error.code) || "desktop_request_failed", 400, readText(error.message) || "Desktop rejected the request", result);
            return;
        }
        await self.sendDesktopBridgeSuccess(id, type, result, controller.signal);
    }
    catch (error) {
        if (!controller.signal.aborted) {
            const errorCode = error instanceof Error ? error.name : "";
            if (errorCode === "source_chat_not_ready" || errorCode === "protocol_error") {
                const brokerFailure = error as Error & {
                    retryable?: boolean;
                    details?: Record<string, unknown>;
                };
                const failureData = {
                    ...(typeof brokerFailure.retryable === "boolean"
                        ? { retryable: brokerFailure.retryable }
                        : {}),
                    ...(brokerFailure.details ? { details: brokerFailure.details } : {}),
                };
                self.sendDesktopBridgeError(id, errorCode, 409, error instanceof Error ? error.message : String(error), Object.keys(failureData).length > 0 ? failureData : undefined);
                return;
            }
            self.sendDesktopBridgeError(id, "desktop_request_failed", 500, error instanceof Error ? error.message : String(error));
        }
    }
    finally {
        self.inboundDesktopRequests.delete(id);
    }
}

export async function RealtimeBroker_awaitRunActionReadiness_4(self: RealtimeBrokerMethodContext, action: string, source: Record<string, unknown>, signal: AbortSignal) {
    if (!action.startsWith("desktop.workpanel."))
        return;
    const runId = readText(source.runId);
    const chatId = readText(source.chatId);
    if (!runId || !chatId) {
        throw brokerError("protocol_error", "WorkPanel source must include canonical Chat and Run identity");
    }
    const grant = self.runActionGrants.get(runId);
    if (!grant) {
        const run = self.getRunChannel(runId);
        if (!run || run.chatId !== chatId || run.terminal) {
            throw brokerError("source_chat_not_ready", "WorkPanel source Run does not have a canonical Chat grant", {
                retryable: false,
                details: { recovery: "reattach_source_chat" },
            });
        }
        if (!run.owner) {
            throw brokerError("protocol_error", "WorkPanel source Run owner is unavailable");
        }
        if (run.owner.kind !== "agent") {
            throw brokerError("source_chat_not_ready", "WorkPanel is unavailable for a Team-owned Run", { retryable: false, details: { recovery: "unsupported_run_owner" } });
        }
        if (readText(source.agentKey) !== run.owner.agentKey) {
            throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its Run owner");
        }
        return;
    }
    if (grant.chatId !== chatId) {
        throw brokerError("protocol_error", "WorkPanel source Chat conflicts with its canonical Run");
    }
    if (grant.owner.kind !== "agent") {
        throw brokerError("source_chat_not_ready", "WorkPanel is unavailable for a Team-owned Run", { retryable: false, details: { recovery: "unsupported_run_owner" } });
    }
    if (readText(source.agentKey) !== grant.owner.agentKey) {
        throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its canonical Run");
    }
    if (grant.state === "failed") {
        throw brokerError("source_chat_not_ready", grant.failureMessage || "canonical Chat synchronization failed", { retryable: false, details: { recovery: "reattach_source_chat" } });
    }
    await Promise.race([
        grant.ready,
        grant.superseded,
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ]).catch((error) => {
        const current = self.runActionGrants.get(runId);
        if (current && current.generation !== grant.generation)
            return;
        throw brokerError("source_chat_not_ready", error instanceof Error ? error.message : String(error), { retryable: false, details: { recovery: "reattach_source_chat" } });
    });
    if (signal.aborted)
        return;
    const current = self.runActionGrants.get(runId);
    if (!current) {
        throw brokerError("source_chat_not_ready", "WorkPanel source Run grant ended before the action was dispatched", { retryable: false, details: { recovery: "run_finished" } });
    }
    if (current.generation !== grant.generation) {
        await self.awaitRunActionReadiness(action, source, signal);
    }
}

export async function RealtimeBroker_sendDesktopBridgeSuccess_5(self: RealtimeBrokerMethodContext, id: string, type: string, result: Record<string, unknown>, signal: AbortSignal) {
    const resultNode = isRecord(result.result) ? result.result : null;
    const screenshot = type === DESKTOP_CDP_REQUEST_TYPE &&
        readText(result.method) === "Page.captureScreenshot" &&
        resultNode && typeof resultNode.data === "string"
        ? resultNode.data.trim()
        : "";
    if (screenshot) {
        const paddingBytes = screenshot.endsWith("==") ? 2 : screenshot.endsWith("=") ? 1 : 0;
        const screenshotBytes = Math.floor((screenshot.length * 3) / 4) - paddingBytes;
        if (screenshotBytes > DESKTOP_MAX_RESPONSE_BYTES) {
            self.sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop screenshot exceeds 64 MiB");
            return;
        }
        const streamId = `desktop-bridge-${randomUUID()}`;
        let seq = 0;
        for (let offset = 0; offset < screenshot.length; offset += DESKTOP_SCREENSHOT_CHUNK_CHARS) {
            if (signal.aborted)
                return;
            seq += 1;
            self.sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE, screenshot.slice(offset, offset + DESKTOP_SCREENSHOT_CHUNK_CHARS));
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (signal.aborted)
            return;
        self.clients.primary.send({
            frame: "response",
            type,
            id,
            code: 0,
            msg: "success",
            data: {
                ...result,
                result: {
                    ...resultNode,
                    data: {
                        streamed: true,
                        streamId,
                        encoding: "base64",
                        chunkCount: seq,
                        totalBytes: screenshotBytes,
                    },
                },
            },
        });
        return;
    }
    const serialized = Buffer.from(JSON.stringify(result), "utf8");
    if (serialized.byteLength > DESKTOP_MAX_RESPONSE_BYTES) {
        self.sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop response exceeds 64 MiB");
        return;
    }
    if (serialized.byteLength <= DESKTOP_STREAM_RAW_CHUNK_BYTES) {
        self.clients.primary.send({ frame: "response", type, id, code: 0, msg: "success", data: result });
        return;
    }
    const streamId = `desktop-bridge-${randomUUID()}`;
    let seq = 0;
    for (let offset = 0; offset < serialized.byteLength; offset += DESKTOP_STREAM_RAW_CHUNK_BYTES) {
        if (signal.aborted)
            return;
        seq += 1;
        const chunk = serialized.subarray(offset, Math.min(offset + DESKTOP_STREAM_RAW_CHUNK_BYTES, serialized.byteLength));
        self.sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_RESPONSE_DELTA_EVENT_TYPE, chunk.toString("base64"));
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal.aborted)
        return;
    self.clients.primary.send({
        frame: "response",
        type,
        id,
        code: 0,
        msg: "success",
        data: {
            streamed: true,
            streamId,
            encoding: "base64",
            contentType: "application/json",
            chunkCount: seq,
            totalBytes: serialized.byteLength,
        },
    });
}

export function RealtimeBroker_sendDesktopBridgeChunk_6(self: RealtimeBrokerMethodContext, id: string, streamId: string, seq: number, type: string, chunk: string) {
    self.clients.primary.send({
        frame: "stream",
        id,
        streamId,
        event: {
            seq,
            type,
            timestamp: Date.now(),
            encoding: "base64",
            chunk,
        },
    });
}

export function RealtimeBroker_sendDesktopBridgeError_7(self: RealtimeBrokerMethodContext, id: string, type: string, code: number, msg: string, data?: unknown) {
    try {
        self.clients.primary.send({
            frame: "error",
            type,
            id,
            code,
            msg,
            ...(data === undefined ? {} : { data }),
        });
    }
    catch {
        // The connection is already unavailable.
    }
}
