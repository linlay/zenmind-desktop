import { type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL,
  isPlainBridgeRecord,
  type AgentWebclientPlatformFramePortCloseInput,
  type AgentWebclientPlatformFramePortEvent,
  type AgentWebclientPlatformFramePortOpenInput,
  type DesktopPlatformSessionClose,
} from "../../../../shared/contracts";
import { MAIN_CHAT_SURFACE_ID, SELECTION_EXPLAIN_SURFACE_ID } from "../../../../shared/surface-identity";
import { isDesktopDevelopmentRuntime } from "../../../infrastructure/electron/development-runtime";
import type { FramePortOptions } from "../ipc.shared";
import {
  AGENT_PLATFORM_SERVICE_ID,
  ClosedLogicalSessionDiagnostic,
  LogicalSession,
  SURFACE_REGISTRATION_WAIT_MS,
  StreamBinding,
  SurfaceContext,
  readText,
  sessionKey,
  streamBindingDiagnostic,
} from "../ipc.shared";
import { beginPlatformLoadDiagnostic } from "../load-diagnostic";
import { AGENT_PLATFORM_KNOWN_PUSH_TYPES } from "../realtime/realtime-broker";
import { createFrameDelivery } from "./frame-delivery";
import { createQueryBinding } from "./query-binding";
import { createRequestDispatch } from "./request-dispatch";
import {
  authorizeSurface,
  createSurfaceAuthorization,
  mayAwaitSurfaceRegistration,
  rootObserverContextId,
  rootObserverNewChatSourceKey,
  trustedKind,
} from "./surface-authorization";
import { createWorkpanelInvoke } from "./workpanel-invoke";

/** Owns logical sessions and assembles purpose-specific Frame Port dependencies. */
export function createSessionController(options: FramePortOptions) {
  async function availability(revalidate?: () => void): Promise<{ baseUrl: string; token: string; }> {
    const diagnostic = beginPlatformLoadDiagnostic("availability");
    try {
      diagnostic.next("service-state");
      const connectionState = options.realtimeBroker.getConnectionState();
      const connectedBaseUrl = connectionState.phase === "connected"
        ? connectionState.key?.endpoint.trim() || ""
        : "";
      let baseUrl = connectedBaseUrl;
      if (baseUrl) {
        // A protocol-ready Broker connection is stronger availability evidence than
        // a cold Windows process-identity probe, which may be temporarily inconclusive.
        diagnostic.serviceState("running");
      }
      else {
        const state = await options.getServiceState(options.app, AGENT_PLATFORM_SERVICE_ID);
        diagnostic.serviceState(state.status);
        baseUrl = state.status === "running"
          ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
          : "";
      }
      if (!baseUrl)
        throw new Error("Agent Platform is unavailable");
      revalidate?.();
      diagnostic.next("access-token");
      const tokenResult = await options.issueAccessToken(options.app, "missing");
      const token = tokenResult.ok ? tokenResult.token.trim() : "";
      if (!token)
        throw new Error(tokenResult.message || "Agent Platform token is unavailable");
      diagnostic.end("succeeded");
      return { baseUrl, token };
    } catch (error) {
      diagnostic.end("failed");
      throw error;
    }
  }

  function closeSession(session: LogicalSession, reason: DesktopPlatformSessionClose["reason"], error?: DesktopPlatformSessionClose["error"]): void {
    if (session.closed)
      return;
    const target = options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
    closedLogicalSessions.push({
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
    if (closedLogicalSessions.length > 200)
      closedLogicalSessions.splice(0, closedLogicalSessions.length - 200);
    session.closed = true;
    for (const diagnostic of session.loadDiagnostics.values()) diagnostic.end("cancelled");
    session.loadDiagnostics.clear();
    session.chatLoadRequests.clear();
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
    options.realtimeBroker.cleanupConsumer(session.consumerId);
    sessions.delete(session.key);
    const keys = senderSessionKeys.get(session.sender.id);
    keys?.delete(session.key);
    if (keys?.size === 0)
      senderSessionKeys.delete(session.sender.id);
    if (!session.sender.isDestroyed()) {
      const event: AgentWebclientPlatformFramePortEvent = {
        sessionId: session.sessionId,
        type: "close",
        event: { reason, ...(error ? { error } : {}) },
      };
      session.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, event);
      options.realtimeBroker.appendDebugTrace({
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

  function releaseSessionRootObserver(session: LogicalSession, observerToken: string): void {
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
      sendFrame(session, {
        frame: "stream",
        id: binding.localId,
        reason: "detached",
        ...(binding.lastSeq > 0 ? { lastSeq: binding.lastSeq } : {}),
      });
    }
  }

  async function detachBinding(session: LogicalSession, binding: StreamBinding): Promise<void> {
    if (binding.detachSent)
      return;
    binding.detachSent = true;
    binding.unsubscribe?.();
    binding.unsubscribe = null;
    if (!binding.virtual && binding.observerToken && binding.runId) {
      options.realtimeBroker.releaseObservedRun(binding.observerToken, binding.runId, "surface_inactive");
    }
  }

  function cleanupSender(senderId: number): void {
    for (const key of [...(senderSessionKeys.get(senderId) ?? [])]) {
      const session = sessions.get(key);
      if (session)
        closeSession(session, "surface_inactive");
    }
    installedCleanup.delete(senderId);
  }

  function installSenderCleanup(sender: WebContents): void {
    if (installedCleanup.has(sender.id))
      return;
    installedCleanup.add(sender.id);
    sender.once("destroyed", () => cleanupSender(sender.id));
    sender.once("render-process-gone", () => cleanupSender(sender.id));
  }

  function finishRetiringSession(session: LogicalSession): void {
    if (!session.retiring || session.streams.size > 0)
      return;
    closeSession(session, "surface_inactive");
  }

  async function retireSession(session: LogicalSession): Promise<void> {
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
      await detachBinding(session, binding).catch(() => undefined);
      session.requestIds.delete(binding.localId);
      session.streams.delete(binding.localId);
    }));
    finishRetiringSession(session);
  }

  async function handleOpen(event: { sender: WebContents }, input: AgentWebclientPlatformFramePortOpenInput): Promise<void> {
    const sessionId = readText(input?.sessionId);
    if (!sessionId)
      return;
    const initialTarget = options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id);
    let context = authorizeSurface(event.sender, options.browserSurfaces, options.isTrustedAgentWebclientSession);
    if ("ok" in context &&
      !initialTarget &&
      mayAwaitSurfaceRegistration(event.sender, options.isTrustedAgentWebclientSession)) {
      const abortController = new AbortController();
      const abortWait = () => abortController.abort();
      event.sender.once("destroyed", abortWait);
      event.sender.once("render-process-gone", abortWait);
      try {
        await options.browserSurfaces.waitForWebviewSurfaceTarget(event.sender.id, SURFACE_REGISTRATION_WAIT_MS, abortController.signal);
      }
      finally {
        event.sender.removeListener("destroyed", abortWait);
        event.sender.removeListener("render-process-gone", abortWait);
      }
      context = authorizeSurface(event.sender, options.browserSurfaces, options.isTrustedAgentWebclientSession);
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
    const revalidate = surfaceAuthorization.captureSurfaceAuthorization(context);
    const key = sessionKey(event.sender.id, sessionId);
    const previousSessions = [...(senderSessionKeys.get(event.sender.id) ?? [])]
      .map((previousKey) => sessions.get(previousKey))
      .filter((previous): previous is LogicalSession => Boolean(previous));
    await Promise.all(previousSessions.map(retireSession));
    try {
      context = revalidate();
    } catch {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, {
          sessionId, type: "close", event: { reason: "surface_inactive" },
        } satisfies AgentWebclientPlatformFramePortEvent);
      }
      return;
    }
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
      logicalGeneration: ++nextLogicalGeneration,
      openedAt: Date.now(),
      phase: "connecting",
      physicalGeneration: 0,
      reconnectCount: 0,
      retiring: false,
      closed: false,
      rootObserverToken: null,
      chatLoadRequests: new Map(),
      loadDiagnostics: new Map(),
    };
    sessions.set(key, session);
    const keys = senderSessionKeys.get(event.sender.id) ?? new Set<string>();
    keys.add(key);
    senderSessionKeys.set(event.sender.id, keys);
    installSenderCleanup(event.sender);
    try {
      const connectionLane = context.kind === "agent-selection-explain" ? "selection-explain" : "primary";
      const unsubscribeConnection = options.realtimeBroker.subscribeConnection({
        consumerId: session.consumerId,
        lane: connectionLane,
        onState: (state) => {
          if (state.phase === "closed" &&
            state.lastError?.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH")) {
            closeSession(session, "protocol_mismatch", {
              code: "PLATFORM_WS_PROTOCOL_MISMATCH",
              message: state.lastError,
            });
            return;
          }
          sendEvent(session, {
            sessionId,
            type: "state",
            state: framePortState(session, state),
          });
        },
      });
      if (session.closed) {
        unsubscribeConnection();
        return;
      }
      session.unsubscribeConnection = unsubscribeConnection;
      if (context.kind !== "agent-selection-explain") {
        session.unsubscribePush = options.realtimeBroker.subscribePush({
          types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES],
          kind: "surface",
          consumerId: session.consumerId,
          onPush: (frame) => {
            const current = authorizeSurface(session.sender, options.browserSurfaces, options.isTrustedAgentWebclientSession);
            if ("ok" in current) return;
            if (current.target.surfaceRole === "kanban-chat") {
              const chatId = current.target.ownerChatId?.trim();
              if (!current.target.active || !chatId || (!isPlainBridgeRecord(frame.data) || frame.data.chatId !== chatId)) return;
            }
            sendFrame(session, frame);
          },
        });
      }
      const { baseUrl, token } = await availability(() => {
        if (session.closed) throw new Error("Frame Port session closed");
        revalidate();
      });
      if (session.closed || session.sender.isDestroyed()) return;
      revalidate();
      await options.realtimeBroker.ensureConnected(baseUrl, token, connectionLane);
      if (!session.closed) revalidate();
    }
    catch (error) {
      // Authorization failures are permanent for this logical Session; transient
      // physical connection failures continue to be retried by the Broker.
      try { revalidate(); } catch {
        closeSession(session, "surface_inactive");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH")) {
        closeSession(session, "protocol_mismatch", {
          code: "PLATFORM_WS_PROTOCOL_MISMATCH",
          message,
        });
      }
      // Transient connection failures are owned by the physical client retry
      // loop. The logical Frame Port remains open and observes reconnecting.
    }
  }

  function handleClose(event: { sender: WebContents }, input: AgentWebclientPlatformFramePortCloseInput): void {
    const session = resolveSession(event.sender, readText(input?.sessionId));
    if (!session)
      return;
    for (const binding of session.streams.values()) {
      binding.suppressed = true;
      void detachBinding(session, binding).catch(() => undefined);
    }
    closeSession(session, input?.reason === "surface_inactive" ? "surface_inactive" : "disposed");
  }

  const surfaceAuthorization = createSurfaceAuthorization({
    get options() { return options; },
  });
  const requestDispatch = createRequestDispatch({
    get resolveSession() { return resolveSession; },
    get sendFrame() { return sendFrame; },
    get options() { return options; },
    get reportChatLoadDiagnostic() { return reportChatLoadDiagnostic; },
    get resolveMainChatQueryAuthorization() { return resolveMainChatQueryAuthorization; },
    get developmentDiagnosticsEnabled() { return developmentDiagnosticsEnabled; },
    get availability() { return availability; },
    get sendRunEvent() { return sendRunEvent; },
    get processQueryBootstrapFrame() { return processQueryBootstrapFrame; },
    get finishRetiringSession() { return finishRetiringSession; },
  });
  const queryBinding = createQueryBinding({
    get options() { return options; },
  });
  const frameDelivery = createFrameDelivery({
    get developmentDiagnosticsEnabled() { return developmentDiagnosticsEnabled; },
    get options() { return options; },
  });
  const workpanelInvoke = createWorkpanelInvoke({
    get options() { return options; },
  });
  const handleWorkPanelInvoke = workpanelInvoke.handleWorkPanelInvoke;
  const sessions = new Map<string, LogicalSession>();
  const senderSessionKeys = new Map<number, Set<string>>();
  const closedLogicalSessions: ClosedLogicalSessionDiagnostic[] = [];
  const installedCleanup = new Set<number>();
  let nextLogicalGeneration = 0;
  const developmentDiagnosticsEnabled = isDesktopDevelopmentRuntime(options.app);

  const reportChatLoadDiagnostic = frameDelivery.reportChatLoadDiagnostic;

  const sendEvent = frameDelivery.sendEvent;

  const sendFrame = frameDelivery.sendFrame;

  const sendRunEvent = frameDelivery.sendRunEvent;

  const framePortState = frameDelivery.framePortState;

  options.browserSurfaces.subscribeLifecycle?.((event) => {
    if (
      event.surface.surfaceId === SELECTION_EXPLAIN_SURFACE_ID &&
      event.surface.surfaceRole === "selection-explain"
    ) {
      if (event.type === "unregistered") {
        const guestWebContentsId = event.surface.guestWebContentsIds[0];
        if (Number.isSafeInteger(guestWebContentsId)) {
          const contextId = rootObserverContextId(event.surface);
          options.realtimeBroker.releaseRootObserver([
            event.surface.surfaceId,
            event.surface.registrationId,
            event.surface.ownerWebContentsId,
            guestWebContentsId,
            contextId,
          ].join(":"), "surface_inactive");
        }
      }
      return;
    }
    if (
      event.surface.surfaceId !== MAIN_CHAT_SURFACE_ID ||
      event.surface.surfaceRole !== "main-chat"
    ) return;

    const active = options.realtimeBroker.getMainChatRootObserver();
    const guestWebContentsId = event.surface.guestWebContentsIds[0];
    const sameGeneration = Boolean(
      active &&
      event.surface.registrationId === active.generation &&
      guestWebContentsId === active.webContentsId,
    );

    if (
      event.type === "registered" &&
      event.surface.active &&
      Number.isSafeInteger(guestWebContentsId)
    ) {
      const registeredChatId = event.surface.ownerChatId.trim();
      const newChatSourceKey = rootObserverNewChatSourceKey(event.surface);
      if (sameGeneration && active) {
        // Bootstrap promotes the bundle before canonical Registry acknowledgement.
        // Repeated snapshots of that same new-chat source must not undo promotion.
        if ((registeredChatId && registeredChatId === active.contextId) ||
          (!registeredChatId && newChatSourceKey && newChatSourceKey === active.newChatSourceKey)) {
          return;
        }
      }

      if (active) {
        for (const session of [...sessions.values()]) {
          if (session.rootObserverToken === active.token) {
            releaseSessionRootObserver(session, active.token);
          }
        }
      }
      const contextId = rootObserverContextId(event.surface);
      options.realtimeBroker.activateRootObserver({
        token: [
          event.surface.surfaceId,
          event.surface.registrationId,
          event.surface.ownerWebContentsId,
          guestWebContentsId,
          randomUUID(),
        ].join(":"),
        kind: "main_chat",
        surfaceId: event.surface.surfaceId,
        generation: event.surface.registrationId,
        contextId,
        newChatSourceKey,
        webContentsId: guestWebContentsId!,
      });
      return;
    }

    if (!active || !sameGeneration) return;
    for (const session of [...sessions.values()]) {
      if (session.rootObserverToken === active.token) {
        releaseSessionRootObserver(session, active.token);
      }
    }
    options.realtimeBroker.releaseRootObserver(active.token, "parent_observer_closed");
  });

  const resolveSession = (sender: WebContents, sessionId: string) =>
    sessions.get(sessionKey(sender.id, sessionId)) ?? null;

  const establishCanonicalChatIdentity = queryBinding.establishCanonicalChatIdentity;

  const processQueryBootstrapFrame = queryBinding.processQueryBootstrapFrame;

  const resolveMainChatQueryAuthorization = async (input: {
    session: LogicalSession;
    context: SurfaceContext;
    payload: Record<string, unknown>;
  }) => { return surfaceAuthorization.resolveMainChatQueryAuthorization(input); };

  const handleSend = requestDispatch.handleSend;

  return {
    handleOpen, handleSend, handleClose, handleWorkPanelInvoke, availability,
    cleanupSender,
    getDiagnostics: () => ({
      registeredSenderCount: senderSessionKeys.size,
      logicalSessionCount: sessions.size,
      pendingRequestCount: [...sessions.values()].reduce((sum, session) => sum + session.requestIds.size, 0),
      activeStreamCount: [...sessions.values()].reduce((sum, session) => sum + session.streams.size, 0),
      activeRootObserver: options.realtimeBroker.getActiveRootObserver(),
      logicalSessions: [
        ...closedLogicalSessions,
        ...[...sessions.values()].flatMap((session) => {
          const target = options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
          return [{
            logicalSessionId: session.sessionId,
            surfaceId: target?.surfaceId || session.surfaceId,
            webContentsId: session.sender.id,
            phase: session.phase,
            logicalGeneration: session.logicalGeneration,
            physicalGeneration: session.physicalGeneration,
            reconnectCount: session.reconnectCount,
            openedAt: session.openedAt,
            pendingRequestCount: session.requestIds.size,
            activeStreamCount: session.streams.size,
            streams: [...session.streams.values()].map(streamBindingDiagnostic),
          }];
        }),
      ],
      surfaces: [...sessions.values()].flatMap((session) => {
        const target = options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
        if (!target) return [];
        return [{
          surfaceId: target.surfaceId,
          webContentsId: session.sender.id,
          kind: trustedKind(target.surfaceType) || "agent-chat",
          surfaceRole: target.surfaceRole,
          surfaceLevel: target.surfaceLevel,
          parentSurfaceId: target.parentSurfaceId,
          interaction: target.interaction,
          active: Boolean(target.active),
          ownerChatId: target.ownerChatId,
          route: target.pageRoute || session.sender.getURL(),
          logicalSessionId: session.sessionId,
          pendingRequestCount: session.requestIds.size,
          activeStreamCount: session.streams.size,
        }];
      }),
    }),
  };

}
