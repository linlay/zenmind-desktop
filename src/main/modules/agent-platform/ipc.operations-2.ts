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

export function registerAgentWebclientBridgeIpcHandlers_processQueryBootstrapFrame_1(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, binding: StreamBinding, upstreamFrame: PlatformFrameRecord): void {
    if (binding.type !== "/api/query")
        return;
    const event = readNormalizedStreamEvent(upstreamFrame);
    if (!event)
        return;
    const type = readText(event.type);
    if (type !== "chat.start" && type !== "request.query" && type !== "run.start")
        return;
    requireAgentPlatformEpochMillis(event.timestamp, `agentWebclient.query[${binding.sourceId}].${type}.timestamp`);
    const chatId = readText(event.chatId);
    if (!chatId)
        throw protocolError(`${type} must include canonical chatId`);
    if (type === "chat.start") {
        const eventOwner = readOwner(event);
        if (eventOwner && binding.expectedOwner && !sameOwner(binding.expectedOwner, eventOwner)) {
            throw protocolError("chat.start owner conflicts with the query owner");
        }
        factoryContext.establishCanonicalChatIdentity(binding, chatId);
        return;
    }
    if (type === "request.query") {
        if (!binding.newChatSource)
            return;
        if (binding.canonicalChatId) {
            if (binding.canonicalChatId !== chatId) {
                throw protocolError("request.query chatId conflicts with the canonical Chat identity");
            }
            return;
        }
        if (!binding.preboundChatId)
            return;
        const requestId = readText(event.requestId);
        const owner = readOwner(event);
        if (!requestId || requestId !== binding.expectedQueryRequestId) {
            throw protocolError("request.query does not match the submitted query requestId");
        }
        if (chatId !== binding.preboundChatId) {
            throw protocolError("request.query chatId conflicts with the submitted canonical Chat");
        }
        if (!owner || (binding.expectedOwner && !sameOwner(binding.expectedOwner, owner))) {
            throw protocolError("request.query owner conflicts with the query owner");
        }
        factoryContext.establishCanonicalChatIdentity(binding, chatId);
        return;
    }
    const runId = readText(event.runId);
    const owner = readOwner(event);
    if (!runId)
        throw protocolError("run.start must include canonical runId");
    if (!owner)
        throw protocolError("run.start must include exactly one Run owner");
    if (binding.expectedOwner && !sameOwner(binding.expectedOwner, owner)) {
        throw protocolError("run.start owner conflicts with the query owner");
    }
    if (binding.newChatSource && !binding.canonicalChatId) {
        throw protocolError("new Chat query requires chat.start or a matching canonical request.query before run.start");
    }
    if (binding.canonicalChatId && binding.canonicalChatId !== chatId) {
        throw protocolError("run.start chatId conflicts with the canonical Chat identity");
    }
    if (binding.chatId && binding.chatId !== chatId) {
        throw protocolError("run.start chatId conflicts with the query source");
    }
    if (binding.suppressed || binding.detachSent) {
        throw protocolError("run.start belongs to a stale Main Chat query source");
    }
    if (binding.runStarted) {
        if (binding.runId !== runId || !sameOwner(binding.owner, owner)) {
            throw protocolError("run.start conflicts with the registered Run");
        }
        return;
    }
    const ready = binding.canonicalChatReady ?? Promise.resolve();
    factoryContext.options.realtimeBroker.registerRunActionGrant({
        sourceId: binding.observerToken || binding.sourceId,
        chatId,
        runId,
        owner,
        ready,
    });
    binding.chatId = chatId;
    binding.runId = runId;
    binding.owner = owner;
    binding.runStarted = true;
}

export async function registerAgentWebclientBridgeIpcHandlers_resolveMainChatQueryAuthorization_2(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, input: {
    session: LogicalSession;
    context: SurfaceContext;
    payload: Record<string, unknown>;
  }): Promise<{ context: SurfaceContext; newChatSource: { registrationId: string; ownerWebContentsId: number; guestWebContentsId: number; agentKey: string; newChat: string; } | null; }> {
    try {
        validateMainChatQueryAgentIdentity(input.context, input.payload);
        const newChatSource = resolveNewChatQuerySource(input.context.target, input.payload);
        validateMainChatQuerySenderChatIdentity(input.context, input.payload, newChatSource);
        return {
            context: input.context,
            newChatSource,
        };
    }
    catch (error) {
        if (!mainChatQueryTargetIsTransitional(input.context, input.payload))
            throw error;
    }
    const initialTarget = input.context.target;
    const startedAt = Date.now();
    const trace = (state: "started" | "ready" | "failed", reason: string) => {
        const observedTarget = factoryContext.options.browserSurfaces
            .resolveWebviewSurfaceTarget(input.context.sender.id);
        let senderRouteKind = "unavailable";
        try {
            senderRouteKind = describeMainChatRouteIdentity(input.context.sender.getURL());
        }
        catch {
            // A destroyed guest is reported as unavailable without changing failure handling.
        }
        factoryContext.options.realtimeBroker.appendDebugTrace({
            layer: "surface-bridge",
            direction: "surface-to-desktop",
            data: {
                event: "main-chat-query-identity-convergence",
                state,
                reason,
                waitedMs: Date.now() - startedAt,
                generation: initialTarget.registrationId,
                observedGeneration: observedTarget?.registrationId || "",
                sameGeneration: observedTarget?.registrationId === initialTarget.registrationId,
                observedActive: observedTarget?.active === true,
                ownerPresent: Boolean(observedTarget?.ownerChatId?.trim()),
                routeKind: describeMainChatRouteIdentity(initialTarget.pageRouteIdentity),
                observedPageRouteKind: describeMainChatRouteIdentity(observedTarget?.pageRouteIdentity),
                observedGuestRouteKind: describeMainChatRouteIdentity(observedTarget?.currentUrl),
                senderRouteKind,
            },
            surfaceId: initialTarget.surfaceId,
            webContentsId: input.context.sender.id,
            surfaceKind: input.context.kind,
            surfaceRole: initialTarget.surfaceRole,
            surfaceLevel: initialTarget.surfaceLevel,
            interaction: initialTarget.interaction,
            route: initialTarget.pageRoute,
        });
    };
    trace("started", "registered_surface_identity_is_transitional");
    const abortController = new AbortController();
    const abortWait = () => abortController.abort();
    input.context.sender.once("destroyed", abortWait);
    input.context.sender.once("render-process-gone", abortWait);
    let matchedTarget: RegisteredWebviewSurfaceTarget | null = null;
    try {
        matchedTarget = await factoryContext.options.browserSurfaces.waitForWebviewSurfaceTargetMatching(input.context.sender.id, (candidate) => candidate.registrationId === initialTarget.registrationId &&
            candidate.ownerWebContentsId === initialTarget.ownerWebContentsId &&
            candidate.surfaceId === MAIN_CHAT_SURFACE_ID &&
            candidate.active &&
            mainChatQueryTargetIsReady(candidate, input.payload), SURFACE_REGISTRATION_WAIT_MS, abortController.signal);
    }
    finally {
        input.context.sender.removeListener("destroyed", abortWait);
        input.context.sender.removeListener("render-process-gone", abortWait);
    }
    if (!matchedTarget || input.session.closed || input.context.sender.isDestroyed()) {
        trace("failed", matchedTarget ? "logical_session_changed" : "registration_wait_expired");
        throw protocolError("Main Chat identity did not converge before query authorization");
    }
    const nextContext = authorizeSurface(input.context.sender, factoryContext.options.browserSurfaces, factoryContext.options.isTrustedAgentWebclientSession);
    if ("ok" in nextContext ||
        nextContext.target.registrationId !== initialTarget.registrationId ||
        nextContext.target.ownerWebContentsId !== initialTarget.ownerWebContentsId ||
        !nextContext.target.active) {
        trace("failed", "surface_generation_changed");
        throw protocolError("Main Chat surface changed before query authorization completed");
    }
    try {
        validateMainChatQueryAgentIdentity(nextContext, input.payload);
        const newChatSource = resolveNewChatQuerySource(nextContext.target, input.payload);
        validateMainChatQuerySenderChatIdentity(nextContext, input.payload, newChatSource);
        trace("ready", nextContext.target.ownerChatId?.trim()
            ? "canonical_owner_registered"
            : "new_chat_source_registered");
        return { context: nextContext, newChatSource };
    }
    catch (error) {
        trace("failed", "identity_changed_after_registration_match");
        throw error;
    }
}

export async function registerAgentWebclientBridgeIpcHandlers_handleOpen_3(factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext, event: any, input: AgentWebclientPlatformFramePortOpenInput): Promise<void> {
    const sessionId = readText(input?.sessionId);
    if (!sessionId)
        return;
    const initialTarget = factoryContext.options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id);
    let context = authorizeSurface(event.sender, factoryContext.options.browserSurfaces, factoryContext.options.isTrustedAgentWebclientSession);
    if ("ok" in context &&
        !initialTarget &&
        mayAwaitSurfaceRegistration(event.sender, factoryContext.options.isTrustedAgentWebclientSession)) {
        const abortController = new AbortController();
        const abortWait = () => abortController.abort();
        event.sender.once("destroyed", abortWait);
        event.sender.once("render-process-gone", abortWait);
        try {
            await factoryContext.options.browserSurfaces.waitForWebviewSurfaceTarget(event.sender.id, SURFACE_REGISTRATION_WAIT_MS, abortController.signal);
        }
        finally {
            event.sender.removeListener("destroyed", abortWait);
            event.sender.removeListener("render-process-gone", abortWait);
        }
        context = authorizeSurface(event.sender, factoryContext.options.browserSurfaces, factoryContext.options.isTrustedAgentWebclientSession);
    }
    if ("ok" in context) {
        if (event.sender.isDestroyed())
            return;
        event.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, {
            sessionId,
            type: "close",
            event: {
                reason: "protocol_mismatch",
                error: { code: "DESKTOP_BRIDGE_INCOMPATIBLE", message: context.error.message },
            },
        } satisfies AgentWebclientPlatformFramePortEvent);
        return;
    }
    const key = sessionKey(event.sender.id, sessionId);
    const previousSessions = [...(factoryContext.senderSessionKeys.get(event.sender.id) ?? [])]
        .map((previousKey) => factoryContext.sessions.get(previousKey))
        .filter((previous): previous is LogicalSession => Boolean(previous));
    await Promise.all(previousSessions.map(factoryContext.retireSession));
    const session: LogicalSession = {
        key,
        sessionId: sessionId,
        sender: event.sender,
        surfaceId: context.target.surfaceId,
        consumerId: `agent-webclient-frame-port:${key}`,
        requestIds: new Set(),
        streams: new Map(),
        detachBarrier: Promise.resolve(),
        unsubscribePush: null,
        unsubscribeConnection: null,
        logicalGeneration: ++factoryContext.nextLogicalGeneration,
        openedAt: Date.now(),
        phase: "connecting",
        physicalGeneration: 0,
        reconnectCount: 0,
        retiring: false,
        closed: false,
        rootObserverToken: null,
        chatLoadRequests: new Map(),
    };
    factoryContext.sessions.set(key, session);
    const keys = factoryContext.senderSessionKeys.get(event.sender.id) ?? new Set<string>();
    keys.add(key);
    factoryContext.senderSessionKeys.set(event.sender.id, keys);
    factoryContext.installSenderCleanup(event.sender);
    try {
        const unsubscribeConnection = factoryContext.options.realtimeBroker.subscribeConnection({
            consumerId: session.consumerId,
            onState: (state) => {
                if (state.phase === "closed" &&
                    state.lastError?.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH")) {
                    factoryContext.closeSession(session, "protocol_mismatch", {
                        code: "PLATFORM_WS_PROTOCOL_MISMATCH",
                        message: state.lastError,
                    });
                    return;
                }
                factoryContext.sendEvent(session, {
                    sessionId,
                    type: "state",
                    state: factoryContext.framePortState(session, state),
                });
            },
        });
        if (session.closed) {
            unsubscribeConnection();
            return;
        }
        session.unsubscribeConnection = unsubscribeConnection;
        session.unsubscribePush = factoryContext.options.realtimeBroker.subscribePush({
            types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES],
            kind: "surface",
            consumerId: session.consumerId,
            onPush: (frame) => factoryContext.sendFrame(session, frame),
        });
        const { baseUrl, token } = await factoryContext.availability();
        await factoryContext.options.realtimeBroker.ensureConnected(baseUrl, token);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH")) {
            factoryContext.closeSession(session, "protocol_mismatch", {
                code: "PLATFORM_WS_PROTOCOL_MISMATCH",
                message,
            });
        }
        // Transient connection failures are owned by the physical client retry
        // loop. The logical Frame Port remains open and observes reconnecting.
    }
}
