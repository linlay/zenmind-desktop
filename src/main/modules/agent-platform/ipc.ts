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

import { registerAgentWebclientBridgeIpcHandlers_reportChatLoadDiagnostic_1, registerAgentWebclientBridgeIpcHandlers_availability_2, registerAgentWebclientBridgeIpcHandlers_sendEvent_3, registerAgentWebclientBridgeIpcHandlers_sendFrame_4, registerAgentWebclientBridgeIpcHandlers_sendRunEvent_5, registerAgentWebclientBridgeIpcHandlers_framePortState_6, registerAgentWebclientBridgeIpcHandlers_closeSession_7, registerAgentWebclientBridgeIpcHandlers_releaseSessionRootObserver_8, registerAgentWebclientBridgeIpcHandlers_detachBinding_9, registerAgentWebclientBridgeIpcHandlers_cleanupSender_10, registerAgentWebclientBridgeIpcHandlers_installSenderCleanup_11, registerAgentWebclientBridgeIpcHandlers_finishRetiringSession_12, registerAgentWebclientBridgeIpcHandlers_retireSession_13, registerAgentWebclientBridgeIpcHandlers_establishCanonicalChatIdentity_14 } from "./ipc.operations-1";

import { registerAgentWebclientBridgeIpcHandlers_processQueryBootstrapFrame_1, registerAgentWebclientBridgeIpcHandlers_resolveMainChatQueryAuthorization_2, registerAgentWebclientBridgeIpcHandlers_handleOpen_3 } from "./ipc.operations-2";

import { registerAgentWebclientBridgeIpcHandlers_handleSend_1 } from "./ipc.operations-3";

import { registerAgentWebclientBridgeIpcHandlers_handleClose_1, registerAgentWebclientBridgeIpcHandlers_handleWorkPanelInvoke_2 } from "./ipc.operations-4";

export function registerAgentWebclientBridgeIpcHandlers(ipcMain: any, options: {
  app: App;
  browserSurfaces: BrowserSurfaceRegistry;
  isTrustedAgentWebclientSession(sender: WebContents): boolean;
  realtimeBroker: RealtimeBroker;
  getServiceState(app: App, serviceId: string): Promise<ServiceState>;
  issueAccessToken(app: App, reason: "missing" | "unauthorized"): Promise<AgentAuthIssueResult>;
  syncCanonicalChat(
    ownerWebContentsId: number,
    input: Omit<CanonicalChatSyncRequest, "requestId">,
  ): Promise<CanonicalChatSyncResult>;
  dispatchWorkPanel(input: {
    action: "openItem" | "activateItem" | "closeItem";
    ownerChatId: string;
    args: Record<string, unknown>;
  }): Promise<WorkPanelBridgeResult>;
  openResource(input: {
    ownerChatId: string;
    resource: Omit<WorkPanelOpenResourceInput, "version">;
  }): Promise<WorkPanelOpenResourceResult>;
  openDocument(input: {
    ownerChatId: string;
    document: Omit<WorkPanelOpenDocumentInput, "version">;
  }): Promise<WorkPanelOpenDocumentResult>;
  normalizeWorkPanelOpenLocalResourceRequest(value: unknown): any;
}) {
  const factoryContext: RegisterAgentWebclientBridgeIpcHandlersContext = {
    get ipcMain() { return ipcMain; },
    get options() { return options; },
    get sessions() { return sessions; },
    get senderSessionKeys() { return senderSessionKeys; },
    get closedLogicalSessions() { return closedLogicalSessions; },
    get installedCleanup() { return installedCleanup; },
    get nextLogicalGeneration() { return nextLogicalGeneration; }, set nextLogicalGeneration(value) { nextLogicalGeneration = value; },
    get developmentDiagnosticsEnabled() { return developmentDiagnosticsEnabled; },
    get reportChatLoadDiagnostic() { return reportChatLoadDiagnostic; },
    get availability() { return availability; },
    get sendEvent() { return sendEvent; },
    get sendFrame() { return sendFrame; },
    get sendRunEvent() { return sendRunEvent; },
    get framePortState() { return framePortState; },
    get closeSession() { return closeSession; },
    get releaseSessionRootObserver() { return releaseSessionRootObserver; },
    get detachBinding() { return detachBinding; },
    get cleanupSender() { return cleanupSender; },
    get installSenderCleanup() { return installSenderCleanup; },
    get finishRetiringSession() { return finishRetiringSession; },
    get retireSession() { return retireSession; },
    get resolveSession() { return resolveSession; },
    get establishCanonicalChatIdentity() { return establishCanonicalChatIdentity; },
    get processQueryBootstrapFrame() { return processQueryBootstrapFrame; },
    get resolveMainChatQueryAuthorization() { return resolveMainChatQueryAuthorization; },
    get handleOpen() { return handleOpen; },
    get handleSend() { return handleSend; },
    get handleClose() { return handleClose; },
    get handleWorkPanelInvoke() { return handleWorkPanelInvoke; }
  };
  const sessions = new Map<string, LogicalSession>();
  const senderSessionKeys = new Map<number, Set<string>>();
  const closedLogicalSessions: ClosedLogicalSessionDiagnostic[] = [];
  const installedCleanup = new Set<number>();
  let nextLogicalGeneration = 0;
  const developmentDiagnosticsEnabled = isDesktopDevelopmentRuntime(options.app);

  const reportChatLoadDiagnostic = (
    stage: "request" | "response",
    session: LogicalSession,
    details: Record<string, unknown>,
  ) => { return registerAgentWebclientBridgeIpcHandlers_reportChatLoadDiagnostic_1(factoryContext, stage, session, details); };

  const availability = async () => { return registerAgentWebclientBridgeIpcHandlers_availability_2(factoryContext); };

  const sendEvent = (session: LogicalSession, event: AgentWebclientPlatformFramePortEvent) => { return registerAgentWebclientBridgeIpcHandlers_sendEvent_3(factoryContext, session, event); };

  const sendFrame = (session: LogicalSession, frame: PlatformFrameRecord) => { return registerAgentWebclientBridgeIpcHandlers_sendFrame_4(factoryContext, session, frame); };

  const sendRunEvent = (
    session: LogicalSession,
    binding: StreamBinding,
    runEvent: Record<string, unknown>,
  ) => { return registerAgentWebclientBridgeIpcHandlers_sendRunEvent_5(factoryContext, session, binding, runEvent); };

  const framePortState = (
    session: LogicalSession,
    state: ReturnType<RealtimeBroker["getConnectionState"]>,
  ): DesktopPlatformConnectionState => { return registerAgentWebclientBridgeIpcHandlers_framePortState_6(factoryContext, session, state); };

  const closeSession = (
    session: LogicalSession,
    reason: DesktopPlatformSessionClose["reason"] = "disposed",
    error?: DesktopPlatformSessionClose["error"],
  ) => { return registerAgentWebclientBridgeIpcHandlers_closeSession_7(factoryContext, session, reason, error); };

  const releaseSessionRootObserver = (
    session: LogicalSession,
    observerToken: string,
  ) => { return registerAgentWebclientBridgeIpcHandlers_releaseSessionRootObserver_8(factoryContext, session, observerToken); };

  options.browserSurfaces.subscribeLifecycle?.((event) => {
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
      if (sameGeneration && active) {
        if (registeredChatId && active.contextId !== registeredChatId) {
          try {
            options.realtimeBroker.promoteMainChatRootObserver(active.token, registeredChatId);
            return;
          } catch {
            // A ready context changing under the same WebView generation is a
            // real Chat switch and must replace the complete bundle below.
          }
        } else if (
          registeredChatId === active.contextId ||
          (!registeredChatId && active.contextId === `${event.surface.surfaceId}:${event.surface.registrationId}`)
        ) {
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
          contextId,
        ].join(":"),
        kind: "main_chat",
        surfaceId: event.surface.surfaceId,
        generation: event.surface.registrationId,
        contextId,
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

  const detachBinding = async (session: LogicalSession, binding: StreamBinding) => { return registerAgentWebclientBridgeIpcHandlers_detachBinding_9(factoryContext, session, binding); };

  const cleanupSender = (senderId: number) => { return registerAgentWebclientBridgeIpcHandlers_cleanupSender_10(factoryContext, senderId); };

  const installSenderCleanup = (sender: WebContents) => { return registerAgentWebclientBridgeIpcHandlers_installSenderCleanup_11(factoryContext, sender); };

  const finishRetiringSession = (session: LogicalSession) => { return registerAgentWebclientBridgeIpcHandlers_finishRetiringSession_12(factoryContext, session); };

  const retireSession = async (session: LogicalSession) => { return registerAgentWebclientBridgeIpcHandlers_retireSession_13(factoryContext, session); };

  const resolveSession = (sender: WebContents, sessionId: string) =>
    sessions.get(sessionKey(sender.id, sessionId)) ?? null;

  const establishCanonicalChatIdentity = (binding: StreamBinding, chatIdValue: string) => { return registerAgentWebclientBridgeIpcHandlers_establishCanonicalChatIdentity_14(factoryContext, binding, chatIdValue); };

  const processQueryBootstrapFrame = (
    binding: StreamBinding,
    upstreamFrame: PlatformFrameRecord,
  ) => { return registerAgentWebclientBridgeIpcHandlers_processQueryBootstrapFrame_1(factoryContext, binding, upstreamFrame); };

  const resolveMainChatQueryAuthorization = async (input: {
    session: LogicalSession;
    context: SurfaceContext;
    payload: Record<string, unknown>;
  }) => { return registerAgentWebclientBridgeIpcHandlers_resolveMainChatQueryAuthorization_2(factoryContext, input); };

  const handleOpen = async (event: any, input: AgentWebclientPlatformFramePortOpenInput) => { return registerAgentWebclientBridgeIpcHandlers_handleOpen_3(factoryContext, event, input); };

  const handleSend = async (event: any, input: AgentWebclientPlatformFramePortSendInput) => { return registerAgentWebclientBridgeIpcHandlers_handleSend_1(factoryContext, event, input); };

  const handleClose = (event: any, input: AgentWebclientPlatformFramePortCloseInput) => { return registerAgentWebclientBridgeIpcHandlers_handleClose_1(factoryContext, event, input); };

  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL, (event: any, input: AgentWebclientPlatformFramePortOpenInput) => {
    void handleOpen(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL, (event: any, input: AgentWebclientPlatformFramePortSendInput) => {
    void handleSend(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL, handleClose);

  const handleWorkPanelInvoke = async (event: any, call: unknown) => { return registerAgentWebclientBridgeIpcHandlers_handleWorkPanelInvoke_2(factoryContext, event, call); };

  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, handleWorkPanelInvoke);

  return {
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

export * from "./ipc.shared";
