import type { App, WebContents } from "electron";

import { randomUUID } from "node:crypto";

import {
  AGENT_WEBCLIENT_BRIDGE_VERSION,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL,
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL,
  AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL,
  isAgentWebclientBridgeVersion,
  isPlainBridgeRecord,
  type AgentPlatformRequestFrame,
  type AgentWebclientBridgeErrorCode,
  type AgentWebclientBridgeFailure,
  type AgentWebclientPlatformFramePortCloseInput,
  type AgentWebclientPlatformFramePortEvent,
  type AgentWebclientPlatformFramePortOpenInput,
  type AgentWebclientPlatformFramePortSendInput,
  type DesktopPlatformConnectionState,
  type DesktopPlatformSessionClose,
  type AgentWebclientRunOwner,
  type AgentWebclientSurfaceKind,
  type WorkPanelBridgeResult,
  type WorkPanelItemTargetInput,
  type WorkPanelOpenItemInput,
  type WorkPanelOpenDocumentInput,
  type WorkPanelOpenDocumentResult,
  type WorkPanelOpenResourceInput,
  type WorkPanelOpenResourceResult,
  type CanonicalChatSyncRequest,
  type CanonicalChatSyncResult,
} from "../../../shared/contracts";

import type { AgentAuthIssueResult, ServiceState } from "../../../shared/contracts";

import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../web-surfaces";

import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "./realtime/realtime-broker";

import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "../../../shared/surface-identity";

import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource,
} from "../../../shared/canonical-chat-sync";

import { readAgentWebclientAgentRouteKey } from "../../../shared/agent-webclient-routes";

import { requireAgentPlatformEpochMillis } from "../../../shared/time-contract";

import { isDesktopDevelopmentRuntime } from "../../infrastructure/electron/development-runtime";

import { reportDeprecatedCompatibilityUse } from "../../support/logging/deprecated-compatibility";

import type { RegisterAgentWebclientBridgeIpcHandlersContext } from "./ipc.shared";

import { AGENT_PLATFORM_SERVICE_ID, ClosedLogicalSessionDiagnostic, FrameErrorOptions, LIVE_CHAT_SURFACE_IDS, LIVE_REQUEST_TYPES, LogicalSession, MAX_SERIALIZED_FRAME_BYTES, PlatformFrameRecord, RootObserverContextSource, SURFACE_REGISTRATION_WAIT_MS, StreamBinding, SurfaceContext, authorizeSurface, bridgeErrorCode, bridgeErrorWithMetadata, createRootObserverToken, describeMainChatRouteIdentity, failure, frameError, frameErrorOptions, mainChatQueryRouteAgentKeys, mainChatQueryTargetIsReady, mainChatQueryTargetIsTransitional, mayAwaitSurfaceRegistration, normalizeDocumentWorkspacePath, parseRequestFrame, protocolError, readNormalizedStreamEvent, readOwner, readText, resolveNewChatQuerySource, rootObserverContextId, rootObserverKind, sameNewChatSource, sameOrigin, sameOwner, sessionKey, streamBindingDiagnostic, trustedKind, updateBindingFromFrame, validateMainChatQueryAgentIdentity, validateMainChatQuerySenderChatIdentity, validateMainChatQueryTargetAgentIdentity } from "./ipc.shared";

export function registerAgentWebclientBridgeIpcHandlers_reportChatLoadDiagnostic_1(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, stage: "request" | "response", session: LogicalSession, details: Record<string, unknown>): void {
    if (!factoryContext.developmentDiagnosticsEnabled)
        return;
    console.debug("[agent-webclient-chat-load]", {
        stage,
        sessionId: session.sessionId,
        logicalGeneration: session.logicalGeneration,
        physicalGeneration: session.physicalGeneration,
        surfaceId: session.surfaceId,
        webContentsId: session.sender.id,
        ...details,
    });
}

export async function registerAgentWebclientBridgeIpcHandlers_availability_2(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext): Promise<{ baseUrl: string; token: string; }> {
    const state = await factoryContext.options.getServiceState(factoryContext.options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = state.status === "running"
        ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
        : "";
    if (!baseUrl)
        throw new Error("Agent Platform is unavailable");
    const tokenResult = await factoryContext.options.issueAccessToken(factoryContext.options.app, "missing");
    const token = tokenResult.ok ? tokenResult.token.trim() : "";
    if (!token)
        throw new Error(tokenResult.message || "Agent Platform token is unavailable");
    return { baseUrl, token };
}

export function registerAgentWebclientBridgeIpcHandlers_sendEvent_3(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, event: AgentWebclientPlatformFramePortEvent): void {
    if (session.closed || session.sender.isDestroyed())
        return;
    session.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, event);
    const target = factoryContext.options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
    factoryContext.options.realtimeBroker.appendDebugTrace({
        layer: "surface-bridge",
        direction: "desktop-to-surface",
        data: event,
        surfaceId: target?.surfaceId,
        webContentsId: session.sender.id,
        surfaceKind: target?.surfaceType,
        surfaceRole: target?.surfaceRole,
        surfaceLevel: target?.surfaceLevel,
        parentSurfaceId: target?.parentSurfaceId,
        interaction: target?.interaction,
        route: target?.pageRoute || session.sender.getURL(),
    });
}

export function registerAgentWebclientBridgeIpcHandlers_sendFrame_4(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, frame: PlatformFrameRecord): void {
    const requestId = readText(frame.id);
    const chatLoad = requestId ? session.chatLoadRequests.get(requestId) : null;
    if (chatLoad) {
        const data = isPlainBridgeRecord(frame.data) ? frame.data : {};
        const nestedData = isPlainBridgeRecord(data.data) ? data.data : {};
        const responseChatId = readText(data.chatId) || readText(nestedData.chatId);
        factoryContext.reportChatLoadDiagnostic("response", session, {
            requestId,
            requestedChatId: chatLoad.chatId,
            responseChatId,
            frame: readText(frame.frame),
            type: readText(frame.type),
            code: typeof frame.code === "number" ? frame.code : undefined,
            elapsedMs: Date.now() - chatLoad.startedAt,
        });
        if (readText(frame.frame) === "response" || readText(frame.frame) === "error") {
            session.chatLoadRequests.delete(requestId);
        }
    }
    factoryContext.sendEvent(session, {
        sessionId: session.sessionId,
        type: "frame",
        frame: frame as Exclude<import("../../../shared/contracts").AgentPlatformRealtimeFrame, AgentPlatformRequestFrame>,
    });
}

export function registerAgentWebclientBridgeIpcHandlers_sendRunEvent_5(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, binding: StreamBinding, runEvent: Record<string, unknown>): void {
    const seq = Number(runEvent.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) {
        binding.lastSeq = Math.max(binding.lastSeq, seq);
    }
    factoryContext.sendFrame(session, {
        frame: "stream",
        id: binding.localId,
        event: runEvent,
    });
}

export function registerAgentWebclientBridgeIpcHandlers_framePortState_6(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, state: ReturnType<RealtimeBroker["getConnectionState"]>): DesktopPlatformConnectionState {
    const phase = state.phase === "connected" ? "connected"
        : state.phase === "reconnecting" || state.phase === "error" ? "reconnecting"
            : state.phase === "closed" || state.phase === "closing" ? "closed"
                : "connecting";
    session.phase = phase;
    session.physicalGeneration = state.generation;
    session.reconnectCount = state.reconnectCount;
    return {
        phase,
        logicalGeneration: session.logicalGeneration,
        physicalGeneration: state.generation,
        reconnectCount: state.reconnectCount,
        retryable: phase === "connecting" || phase === "reconnecting",
        ...(state.physicalSessionId ? { physicalSessionId: state.physicalSessionId } : {}),
        ...(state.lastInboundAt ? { lastInboundAt: state.lastInboundAt } : {}),
        ...(state.lastHeartbeatAt ? { lastHeartbeatAt: state.lastHeartbeatAt } : {}),
        ...(state.lastError ? {
            error: {
                code: phase === "reconnecting" ? "PLATFORM_CONNECTION_UNAVAILABLE" : "DESKTOP_FRAME_PORT_CLOSED",
                message: state.lastError,
            },
        } : {}),
    };
}

export function registerAgentWebclientBridgeIpcHandlers_closeSession_7(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, reason: DesktopPlatformSessionClose["reason"], error?: DesktopPlatformSessionClose["error"]): void {
    if (session.closed)
        return;
    const target = factoryContext.options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
    factoryContext.closedLogicalSessions.push({
        logicalSessionId: session.sessionId,
        surfaceId: target?.surfaceId || session.surfaceId,
        webContentsId: session.sender.id,
        phase: "closed",
        logicalGeneration: session.logicalGeneration,
        physicalGeneration: session.physicalGeneration,
        reconnectCount: session.reconnectCount,
        openedAt: session.openedAt,
        closedAt: Date.now(),
        closeReason: reason,
        pendingRequestCount: session.requestIds.size,
        activeStreamCount: session.streams.size,
        streams: [...session.streams.values()].map(streamBindingDiagnostic),
    });
    if (factoryContext.closedLogicalSessions.length > 200)
        factoryContext.closedLogicalSessions.splice(0, factoryContext.closedLogicalSessions.length - 200);
    session.closed = true;
    session.unsubscribePush?.();
    session.unsubscribePush = null;
    session.unsubscribeConnection?.();
    session.unsubscribeConnection = null;
    for (const binding of session.streams.values()) {
        binding.unsubscribe?.();
        binding.unsubscribe = null;
    }
    // Root Observer ownership follows the trusted Surface Registry lifecycle,
    // not the shorter-lived FramePort session. Retiring a page port therefore
    // releases only its stream consumers; the Main Chat bundle stays intact.
    session.rootObserverToken = null;
    factoryContext.options.realtimeBroker.cleanupConsumer(session.consumerId);
    factoryContext.sessions.delete(session.key);
    const keys = factoryContext.senderSessionKeys.get(session.sender.id);
    keys?.delete(session.key);
    if (keys?.size === 0)
        factoryContext.senderSessionKeys.delete(session.sender.id);
    if (!session.sender.isDestroyed()) {
        const event: AgentWebclientPlatformFramePortEvent = {
            sessionId: session.sessionId,
            type: "close",
            event: { reason, ...(error ? { error } : {}) },
        };
        session.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, event);
        factoryContext.options.realtimeBroker.appendDebugTrace({
            layer: "surface-bridge",
            direction: "desktop-to-surface",
            data: event,
            surfaceId: target?.surfaceId,
            webContentsId: session.sender.id,
            surfaceKind: target?.surfaceType,
            surfaceRole: target?.surfaceRole,
            surfaceLevel: target?.surfaceLevel,
            parentSurfaceId: target?.parentSurfaceId,
            interaction: target?.interaction,
            route: target?.pageRoute || session.sender.getURL(),
        });
    }
}

export function registerAgentWebclientBridgeIpcHandlers_releaseSessionRootObserver_8(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, observerToken: string): void {
    if (session.rootObserverToken !== observerToken)
        return;
    session.rootObserverToken = null;
    for (const binding of [...session.streams.values()]) {
        if (binding.observerToken !== observerToken)
            continue;
        binding.suppressed = true;
        binding.detachSent = true;
        binding.unsubscribe?.();
        binding.unsubscribe = null;
        session.requestIds.delete(binding.localId);
        session.streams.delete(binding.localId);
        factoryContext.sendFrame(session, {
            frame: "stream",
            id: binding.localId,
            reason: "detached",
            ...(binding.lastSeq > 0 ? { lastSeq: binding.lastSeq } : {}),
        });
    }
}

export async function registerAgentWebclientBridgeIpcHandlers_detachBinding_9(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession, binding: StreamBinding): Promise<void> {
    if (binding.detachSent)
        return;
    binding.detachSent = true;
    binding.unsubscribe?.();
    binding.unsubscribe = null;
    if (!binding.virtual && binding.observerToken && binding.runId) {
        factoryContext.options.realtimeBroker.releaseObservedRun(binding.observerToken, binding.runId, "surface_inactive");
    }
}

export function registerAgentWebclientBridgeIpcHandlers_cleanupSender_10(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, senderId: number): void {
    for (const key of [...(factoryContext.senderSessionKeys.get(senderId) ?? [])]) {
        const session = factoryContext.sessions.get(key);
        if (session)
            factoryContext.closeSession(session, "surface_inactive");
    }
    factoryContext.installedCleanup.delete(senderId);
}

export function registerAgentWebclientBridgeIpcHandlers_installSenderCleanup_11(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, sender: WebContents): void {
    if (factoryContext.installedCleanup.has(sender.id))
        return;
    factoryContext.installedCleanup.add(sender.id);
    sender.once("destroyed", () => factoryContext.cleanupSender(sender.id));
    sender.once("render-process-gone", () => factoryContext.cleanupSender(sender.id));
}

export function registerAgentWebclientBridgeIpcHandlers_finishRetiringSession_12(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession): void {
    if (!session.retiring || session.streams.size > 0)
        return;
    factoryContext.closeSession(session, "surface_inactive");
}

export async function registerAgentWebclientBridgeIpcHandlers_retireSession_13(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, session: LogicalSession): Promise<void> {
    if (session.closed)
        return;
    session.retiring = true;
    session.unsubscribePush?.();
    session.unsubscribePush = null;
    await session.detachBarrier;
    const detachable = [...session.streams.values()].filter((binding) => {
        binding.suppressed = true;
        return Boolean(binding.runId && binding.owner);
    });
    await Promise.all(detachable.map(async (binding) => {
        await factoryContext.detachBinding(session, binding).catch(() => undefined);
        session.requestIds.delete(binding.localId);
        session.streams.delete(binding.localId);
    }));
    factoryContext.finishRetiringSession(session);
}

export function registerAgentWebclientBridgeIpcHandlers_establishCanonicalChatIdentity_14(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, binding: StreamBinding, chatIdValue: string): void {
    const chatId = chatIdValue.trim();
    if (!chatId)
        throw protocolError("canonical Chat identity is empty");
    if (binding.runStarted)
        throw protocolError("canonical Chat identity arrived after run.start");
    if (binding.canonicalChatId && binding.canonicalChatId !== chatId) {
        throw protocolError("canonical Chat identity conflicts with the current query");
    }
    if (binding.chatId && binding.chatId !== chatId) {
        throw protocolError("canonical Chat identity conflicts with the query source");
    }
    if (binding.suppressed || binding.detachSent) {
        throw protocolError("canonical Chat identity belongs to a stale Main Chat query source");
    }
    binding.canonicalChatId = chatId;
    binding.chatId = chatId;
    const promoteMainChatBundle = () => {
        if (binding.observerToken &&
            factoryContext.options.realtimeBroker.getMainChatRootObserver()?.token === binding.observerToken) {
            factoryContext.options.realtimeBroker.promoteMainChatRootObserver(binding.observerToken, chatId);
        }
    };
    if (!binding.newChatSource || binding.canonicalChatReady) {
        promoteMainChatBundle();
        return;
    }
    const request = {
        sourceId: binding.sourceId,
        surfaceId: MAIN_CHAT_SURFACE_ID,
        registrationId: binding.newChatSource.registrationId,
        guestWebContentsId: binding.newChatSource.guestWebContentsId,
        agentKey: binding.newChatSource.agentKey,
        newChat: binding.newChatSource.newChat,
        chatId,
    } satisfies Omit<CanonicalChatSyncRequest, "requestId">;
    // The outer Desktop identity owns the canonical Chat as soon as
    // chat.start arrives. Guest navigation remains protected separately until
    // WebClient promotes its own live-query URL.
    promoteMainChatBundle();
    const traceCanonicalSync = (state: "ready" | "failed", reason: string) => {
        const target = factoryContext.options.browserSurfaces.resolveWebviewSurfaceTarget(binding.newChatSource!.guestWebContentsId);
        factoryContext.options.realtimeBroker.appendDebugTrace({
            layer: "surface-bridge",
            direction: "desktop-to-surface",
            data: {
                event: "main-chat-canonical-sync",
                state,
                reason,
                generation: binding.newChatSource!.registrationId,
                ownerPresent: Boolean(target?.ownerChatId?.trim()),
                routeKind: target?.ownerChatId?.trim() ? "canonical" : "new-chat",
            },
            surfaceId: MAIN_CHAT_SURFACE_ID,
            webContentsId: binding.newChatSource!.guestWebContentsId,
            surfaceKind: target?.surfaceType,
            surfaceRole: target?.surfaceRole,
            surfaceLevel: target?.surfaceLevel,
            interaction: target?.interaction,
            route: target?.pageRoute,
        });
    };
    const ready = factoryContext.options.syncCanonicalChat(binding.newChatSource.ownerWebContentsId, request).then((result) => {
        if (!result.ok) {
            traceCanonicalSync("failed", result.code);
            throw Object.assign(new Error(result.message), { name: result.code });
        }
        traceCanonicalSync("ready", "canonical_promotion_guard_installed");
    });
    void ready.catch(() => undefined);
    binding.canonicalChatReady = ready;
}
