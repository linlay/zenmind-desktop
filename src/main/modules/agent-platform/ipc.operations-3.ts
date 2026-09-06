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

export async function registerAgentWebclientBridgeIpcHandlers_handleSend_1(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, event: any, input: AgentWebclientPlatformFramePortSendInput): Promise<void> {
    const session = factoryContext.resolveSession(event.sender, readText(input?.sessionId));
    if (!session || session.closed)
        return;
    const frame = parseRequestFrame(input?.frame);
    const fallbackId = isPlainBridgeRecord(input?.frame) ? readText(input.frame.id) : "";
    if (!frame) {
        factoryContext.sendFrame(session, frameError(fallbackId, "invalid_request", "Platform request frame is invalid"));
        return;
    }
    if (session.requestIds.has(frame.id)) {
        factoryContext.sendFrame(session, frameError(frame.id, "duplicate_id", "request id is already active on this logical session"));
        return;
    }
    let context = authorizeSurface(event.sender, factoryContext.options.browserSurfaces, factoryContext.options.isTrustedAgentWebclientSession);
    if ("ok" in context) {
        factoryContext.sendFrame(session, frameError(frame.id, "surface_unavailable", context.error.message));
        return;
    }
    if (frame.type === "/api/chat") {
        const chatId = readText(isPlainBridgeRecord(frame.payload) ? frame.payload.chatId : "");
        session.chatLoadRequests.set(frame.id, { chatId, startedAt: Date.now() });
        factoryContext.reportChatLoadDiagnostic("request", session, {
            requestId: frame.id,
            requestedChatId: chatId,
            registeredOwnerChatId: context.target.ownerChatId?.trim() || "",
            registeredRoute: context.target.pageRouteIdentity || context.target.pageRoute,
            guestUrl: event.sender.getURL(),
            active: context.target.active,
        });
    }
    // Trusted one-shot Platform requests share the broker without acquiring the live Run lease.
    // Only query/attach/BTW streams require the additional active-surface authorization below.
    const isLive = LIVE_REQUEST_TYPES.has(frame.type);
    let payload: Record<string, unknown> = isPlainBridgeRecord(frame.payload) ? frame.payload : {};
    let newChatSource: StreamBinding["newChatSource"] = null;
    if (frame.type === "/api/query") {
        try {
            const authorization = await factoryContext.resolveMainChatQueryAuthorization({
                session,
                context,
                payload,
            });
            context = authorization.context;
            newChatSource = authorization.newChatSource;
            const committedChatId = context.target.ownerChatId?.trim() || "";
            if (committedChatId) {
                payload = { ...payload, chatId: committedChatId };
            }
        }
        catch (error) {
            factoryContext.sendFrame(session, frameError(frame.id, "protocol_error", error instanceof Error ? error.message : String(error)));
            return;
        }
    }
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    const isReadonlyVirtualAttach = frame.type === "/api/attach" &&
        (context.kind === "agent-overview" || context.kind === "agent-debug") &&
        context.target.surfaceRole === (context.kind === "agent-overview" ? "overview" : "debug") &&
        context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
        Boolean(ownerChatId);
    let observerToken: string | null = null;
    if (isLive) {
        const isLiveChat = LIVE_CHAT_SURFACE_IDS.has(context.target.surfaceId);
        const isBTW = context.kind === "agent-btw" &&
            context.target.surfaceRole === "btw" &&
            context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
            Boolean(context.target.ownerChatId);
        const allowedSurface = frame.type === "/api/query"
            ? isLiveChat
            : frame.type === "/api/btw" || frame.type === "/api/attach"
                ? isLiveChat || isBTW || isReadonlyVirtualAttach
                : false;
        if (!allowedSurface || !context.target.active) {
            factoryContext.sendFrame(session, frameError(frame.id, "surface_unavailable", "only the active Chat or BTW surface may open this live Run stream"));
            return;
        }
        const rootKind = rootObserverKind(context.target);
        if (rootKind) {
            const contextId = rootObserverContextId(context.target, readText(payload.chatId));
            if (rootKind === "main_chat") {
                const activeMain = factoryContext.options.realtimeBroker.getMainChatRootObserver();
                const contextMatches = activeMain && (activeMain.contextId === contextId ||
                    activeMain.contextId === `${context.target.surfaceId}:${context.target.registrationId}`);
                if (!activeMain ||
                    activeMain.surfaceId !== context.target.surfaceId ||
                    activeMain.generation !== context.target.registrationId ||
                    activeMain.webContentsId !== event.sender.id ||
                    !contextMatches) {
                    factoryContext.sendFrame(session, frameError(frame.id, "target_unavailable", "active Main Chat Broker bundle is unavailable", { retryable: false, details: { reason: "surface_generation_superseded" } }));
                    return;
                }
                observerToken = activeMain.token;
            }
            else {
                observerToken = createRootObserverToken(context.target, contextId);
                if (session.rootObserverToken && session.rootObserverToken !== observerToken) {
                    factoryContext.options.realtimeBroker.releaseRootObserver(session.rootObserverToken, "surface_generation_superseded");
                }
                factoryContext.options.realtimeBroker.activateRootObserver({
                    token: observerToken,
                    kind: rootKind,
                    surfaceId: context.target.surfaceId,
                    generation: context.target.registrationId,
                    contextId,
                    webContentsId: event.sender.id,
                });
            }
            session.rootObserverToken = observerToken;
        }
        else if (isBTW || isReadonlyVirtualAttach) {
            const activeRoot = factoryContext.options.realtimeBroker.getMainChatRootObserver();
            if (!activeRoot || activeRoot.kind !== "main_chat" ||
                activeRoot.contextId !== ownerChatId) {
                factoryContext.sendFrame(session, frameError(frame.id, "target_unavailable", "parent_observer_closed: active Main Chat observer is unavailable", { retryable: false, details: { reason: "parent_observer_closed" } }));
                return;
            }
            observerToken = activeRoot.token;
        }
    }
    if (frame.type === "/api/detach" && (context.kind === "agent-overview" || context.kind === "agent-debug")) {
        const runId = readText(payload.runId);
        const virtualBindings = [...session.streams.values()].filter((candidate) => candidate.virtual && candidate.runId === runId);
        for (const candidate of virtualBindings) {
            candidate.detachSent = true;
            candidate.unsubscribe?.();
            candidate.unsubscribe = null;
            session.requestIds.delete(candidate.localId);
            session.streams.delete(candidate.localId);
        }
        factoryContext.sendFrame(session, {
            frame: "response",
            id: frame.id,
            type: frame.type,
            code: 0,
            data: {},
        });
        return;
    }
    if (frame.type === "/api/detach") {
        const runId = readText(payload.runId);
        const rootToken = session.rootObserverToken || (context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID
            ? factoryContext.options.realtimeBroker.getMainChatRootObserver()?.token || null
            : null);
        if (rootToken && runId) {
            factoryContext.options.realtimeBroker.releaseObservedRun(rootToken, runId, "surface_inactive");
            for (const candidate of [...session.streams.values()]) {
                if (candidate.runId !== runId)
                    continue;
                candidate.detachSent = true;
                candidate.unsubscribe?.();
                session.requestIds.delete(candidate.localId);
                session.streams.delete(candidate.localId);
            }
            factoryContext.sendFrame(session, {
                frame: "response",
                id: frame.id,
                type: frame.type,
                code: 0,
                data: { accepted: true, status: "detached", runId },
            });
            return;
        }
    }
    const explicitDetachBindings = frame.type === "/api/detach"
        ? [...session.streams.values()].filter((candidate) => !candidate.detachSent &&
            Boolean(readText(payload.runId)) &&
            candidate.runId === readText(payload.runId))
        : [];
    let releaseDetachBarrier: (() => void) | null = null;
    if (explicitDetachBindings.length > 0) {
        const pendingWrite = new Promise<void>((resolve) => {
            releaseDetachBarrier = resolve;
        });
        session.detachBarrier = session.detachBarrier.then(() => pendingWrite);
        for (const candidate of explicitDetachBindings) {
            candidate.suppressed = true;
            candidate.detachSent = true;
        }
    }
    const finishExplicitDetachWrite = (written: boolean) => {
        if (!written) {
            for (const candidate of explicitDetachBindings) {
                candidate.detachSent = false;
            }
        }
        releaseDetachBarrier?.();
        releaseDetachBarrier = null;
    };
    let connection: {
        baseUrl: string;
        token: string;
    };
    try {
        connection = await factoryContext.availability();
    }
    catch (error) {
        finishExplicitDetachWrite(false);
        factoryContext.sendFrame(session, frameError(frame.id, "connection_unavailable", error instanceof Error ? error.message : String(error)));
        return;
    }
    const { baseUrl, token } = connection;
    session.requestIds.add(frame.id);
    const binding: StreamBinding | null = isLive
        ? {
            localId: frame.id,
            type: frame.type as "/api/query" | "/api/attach" | "/api/btw",
            chatId: readText(payload.chatId) || ownerChatId,
            runId: readText(payload.runId),
            owner: readOwner(payload),
            lastSeq: Math.max(0, Number(payload.lastSeq) || 0),
            suppressed: false,
            detachSent: false,
            virtual: isReadonlyVirtualAttach,
            sourceId: `${session.key}:${frame.id}`,
            unsubscribe: null,
            expectedOwner: readOwner(payload),
            newChatSource,
            canonicalChatId: "",
            expectedQueryRequestId: readText(payload.requestId),
            preboundChatId: frame.type === "/api/query" ? readText(payload.chatId) : "",
            canonicalChatReady: frame.type === "/api/query" && !newChatSource
                ? Promise.resolve()
                : null,
            runStarted: frame.type !== "/api/query",
            observerToken,
        }
        : null;
    if (binding)
        session.streams.set(frame.id, binding);
    factoryContext.options.realtimeBroker.appendDebugTrace({
        layer: "surface-bridge",
        direction: "surface-to-desktop",
        data: frame,
        surfaceId: context.target.surfaceId,
        webContentsId: event.sender.id,
        surfaceKind: context.kind,
        surfaceRole: context.target.surfaceRole,
        surfaceLevel: context.target.surfaceLevel,
        parentSurfaceId: context.target.parentSurfaceId,
        interaction: context.target.interaction,
        route: context.target.pageRoute || event.sender.getURL(),
    });
    if (binding?.virtual) {
        try {
            if (!binding.runId || !binding.chatId || !binding.owner) {
                throw Object.assign(new Error("visible Run identity is incomplete"), { name: "invalid_request" });
            }
            const subscription = await factoryContext.options.realtimeBroker.subscribeClone({
                kind: context.kind === "agent-overview" ? "overview" : "debug",
                runId: binding.runId,
                chatId: binding.chatId,
                lastSeq: binding.lastSeq,
                owner: binding.owner,
                consumerId: session.consumerId,
                onEvent: (runEvent) => factoryContext.sendRunEvent(session, binding, runEvent),
                onComplete: (completed) => {
                    binding.unsubscribe?.();
                    binding.unsubscribe = null;
                    factoryContext.sendFrame(session, {
                        frame: "stream",
                        id: binding.localId,
                        reason: completed.reason,
                        ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
                    });
                    session.requestIds.delete(binding.localId);
                    session.streams.delete(binding.localId);
                },
                onError: (error) => {
                    binding.unsubscribe?.();
                    binding.unsubscribe = null;
                    factoryContext.sendFrame(session, frameError(binding.localId, bridgeErrorCode(error), error.message, frameErrorOptions(error)));
                    session.requestIds.delete(binding.localId);
                    session.streams.delete(binding.localId);
                },
            });
            binding.unsubscribe = subscription.unsubscribe;
            await subscription.ready;
        }
        catch (error) {
            if (session.closed ||
                binding.detachSent ||
                session.streams.get(binding.localId) !== binding) {
                return;
            }
            session.requestIds.delete(frame.id);
            session.streams.delete(frame.id);
            factoryContext.sendFrame(session, frameError(frame.id, bridgeErrorCode(error), error instanceof Error ? error.message : String(error), frameErrorOptions(error)));
        }
        return;
    }
    if (binding?.type === "/api/attach" && observerToken &&
        binding.chatId && binding.runId && binding.owner) {
        try {
            if (context.target.surfaceId === MAIN_CHAT_SURFACE_ID) {
                factoryContext.options.realtimeBroker.registerRunActionGrant({
                    sourceId: observerToken,
                    chatId: binding.chatId,
                    runId: binding.runId,
                    owner: binding.owner,
                    ready: Promise.resolve(),
                });
            }
            const subscription = factoryContext.options.realtimeBroker.subscribeRun({
                baseUrl,
                token,
                lane: context.kind === "agent-btw" ? "btw" : "primary",
                runId: binding.runId,
                chatId: binding.chatId,
                lastSeq: binding.lastSeq,
                owner: binding.owner,
                kind: "surface",
                role: "root_observer",
                observerToken,
                consumerId: session.consumerId,
                onEvent: (runEvent) => factoryContext.sendRunEvent(session, binding, runEvent),
                onComplete: (completed) => {
                    binding.unsubscribe?.();
                    binding.unsubscribe = null;
                    factoryContext.sendFrame(session, {
                        frame: "stream",
                        id: binding.localId,
                        reason: completed.reason,
                        ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
                    });
                    session.requestIds.delete(binding.localId);
                    session.streams.delete(binding.localId);
                },
                onError: (error) => {
                    binding.unsubscribe?.();
                    binding.unsubscribe = null;
                    factoryContext.sendFrame(session, frameError(binding.localId, bridgeErrorCode(error), error.message, frameErrorOptions(error)));
                    session.requestIds.delete(binding.localId);
                    session.streams.delete(binding.localId);
                },
            });
            binding.unsubscribe = subscription.unsubscribe;
            await subscription.ready;
        }
        catch (error) {
            session.requestIds.delete(binding.localId);
            session.streams.delete(binding.localId);
            factoryContext.sendFrame(session, frameError(binding.localId, bridgeErrorCode(error), error instanceof Error ? error.message : String(error), frameErrorOptions(error)));
        }
        return;
    }
    if (binding && (binding.type === "/api/query" || binding.type === "/api/btw")) {
        try {
            const handle = factoryContext.options.realtimeBroker.query({
                baseUrl,
                token,
                lane: binding.type === "/api/btw" ? "btw" : "primary",
                requestType: binding.type,
                id: frame.id,
                payload,
                runId: binding.runId || undefined,
                chatId: binding.chatId || undefined,
                owner: binding.expectedOwner || undefined,
                observerToken: observerToken || undefined,
                consumerId: session.consumerId,
                onEvent: async (runEvent) => {
                    const upstreamFrame: PlatformFrameRecord = {
                        frame: "stream",
                        id: binding.localId,
                        event: runEvent,
                    };
                    factoryContext.processQueryBootstrapFrame(binding, upstreamFrame);
                    updateBindingFromFrame(binding, upstreamFrame);
                    if (binding.canonicalChatReady)
                        await binding.canonicalChatReady;
                    if (!binding.suppressed)
                        factoryContext.sendFrame(session, upstreamFrame);
                },
            });
            void handle.accepted.then((accepted) => {
                binding.chatId = accepted.chatId;
                binding.runId = accepted.runId;
                binding.owner = accepted.owner;
                binding.runStarted = true;
            }).catch(() => undefined);
            void handle.completed.then((completed) => {
                if (!binding.suppressed || completed.reason !== "detached") {
                    factoryContext.sendFrame(session, {
                        frame: "stream",
                        id: binding.localId,
                        reason: completed.reason,
                        ...(completed.lastSeq === undefined ? {} : { lastSeq: completed.lastSeq }),
                    });
                }
                session.requestIds.delete(binding.localId);
                session.streams.delete(binding.localId);
                factoryContext.finishRetiringSession(session);
            }).catch((error) => {
                session.requestIds.delete(binding.localId);
                session.streams.delete(binding.localId);
                factoryContext.sendFrame(session, frameError(binding.localId, bridgeErrorCode(error), error instanceof Error ? error.message : String(error), frameErrorOptions(error)));
                factoryContext.finishRetiringSession(session);
            });
        }
        catch (error) {
            session.requestIds.delete(binding.localId);
            session.streams.delete(binding.localId);
            factoryContext.sendFrame(session, frameError(binding.localId, bridgeErrorCode(error), error instanceof Error ? error.message : String(error), frameErrorOptions(error)));
        }
        return;
    }
    try {
        await factoryContext.options.realtimeBroker.forwardRequest({
            baseUrl,
            token,
            localId: frame.id,
            consumerId: session.consumerId,
            type: frame.type,
            payload,
            stream: false,
            onFrame: (upstreamFrame) => {
                factoryContext.sendFrame(session, upstreamFrame);
                session.requestIds.delete(frame.id);
                factoryContext.finishRetiringSession(session);
            },
            onError: (error) => {
                session.requestIds.delete(frame.id);
                factoryContext.sendFrame(session, frameError(frame.id, "connection_unavailable", error.message));
                factoryContext.finishRetiringSession(session);
            },
        });
        finishExplicitDetachWrite(true);
    }
    catch (error) {
        finishExplicitDetachWrite(false);
        session.requestIds.delete(frame.id);
        session.streams.delete(frame.id);
        factoryContext.sendFrame(session, frameError(frame.id, "connection_unavailable", error instanceof Error ? error.message : String(error)));
        factoryContext.finishRetiringSession(session);
    }
}
