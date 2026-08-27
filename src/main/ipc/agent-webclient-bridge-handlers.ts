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
  type WorkPanelOpenResourceInput,
  type WorkPanelOpenResourceResult,
  type CanonicalChatSyncRequest,
  type CanonicalChatSyncResult,
} from "../../shared/contracts";
import type { AgentAuthIssueResult, ServiceState } from "../../shared/contracts";
import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../browser-surface-registry";
import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../realtime/realtime-broker";
import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "../../shared/surface-identity";
import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource,
} from "../../shared/canonical-chat-sync";
import { readAgentWebclientAgentRouteKey } from "../../shared/agent-webclient-routes";
import { requireAgentPlatformEpochMillis } from "../../shared/time-contract";
import { normalizeChatWorkPanelOpenLocalResourceRequest } from "../chat-work-panel-resource-open";

const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const MAX_SERIALIZED_FRAME_BYTES = 8 * 1024 * 1024;
const SURFACE_REGISTRATION_WAIT_MS = 1_500;
const VISIBLE_RUN_BIND_WAIT_MS = 1_500;
const VISIBLE_RUN_BIND_RETRY_MS = 25;

const LIVE_CHAT_SURFACE_IDS = new Set([
  MAIN_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
]);

const LIVE_REQUEST_TYPES = new Set([
  "/api/query",
  "/api/attach",
  "/api/btw",
]);

type SurfaceContext = {
  sender: WebContents;
  target: RegisteredWebviewSurfaceTarget;
  kind: AgentWebclientSurfaceKind;
};

type StreamBinding = {
  localId: string;
  type: "/api/query" | "/api/attach" | "/api/btw";
  chatId: string;
  runId: string;
  owner: AgentWebclientRunOwner | null;
  lastSeq: number;
  suppressed: boolean;
  detachSent: boolean;
  virtual: boolean;
  visibleRegistered: boolean;
  sourceId: string;
  unsubscribe: (() => void) | null;
  expectedOwner: AgentWebclientRunOwner | null;
  newChatSource: {
    registrationId: string;
    ownerWebContentsId: number;
    guestWebContentsId: number;
    agentKey: string;
    newChat: string;
  } | null;
  canonicalChatId: string;
  expectedQueryRequestId: string;
  preboundChatId: string;
  canonicalChatReady: Promise<void> | null;
  runStarted: boolean;
  protocolFailed: boolean;
};

type LogicalSession = {
  key: string;
  sessionId: string;
  sender: WebContents;
  surfaceId: string;
  consumerId: string;
  requestIds: Set<string>;
  streams: Map<string, StreamBinding>;
  detachBarrier: Promise<void>;
  unsubscribePush: (() => void) | null;
  unsubscribeConnection: (() => void) | null;
  logicalGeneration: number;
  openedAt: number;
  phase: DesktopPlatformConnectionState["phase"];
  physicalGeneration: number;
  reconnectCount: number;
  retiring: boolean;
  closed: boolean;
};

type ClosedLogicalSessionDiagnostic = {
  logicalSessionId: string;
  surfaceId: string;
  webContentsId: number;
  phase: "closed";
  logicalGeneration: number;
  physicalGeneration: number;
  reconnectCount: number;
  openedAt: number;
  closedAt: number;
  closeReason: DesktopPlatformSessionClose["reason"];
  pendingRequestCount: number;
  activeStreamCount: number;
};

type VisibleRunBindReason =
  | "primary_surface_transitioning"
  | "primary_stream_not_ready"
  | "primary_run_identity_pending"
  | "primary_run_mismatch"
  | "forwarded_source_transitioning";

type VisibleRunBindSnapshot = {
  stage: "visible_run_bind";
  reason: VisibleRunBindReason;
  visibleBindingPresent: boolean;
  primarySessionCount: number;
  activePrimarySessionCount: number;
  matchingPrimarySessionCount: number;
  matchingStreamCount: number;
  pendingRunIdentityCount: number;
  matchingRunStreamCount: number;
  logicalGeneration?: number;
  physicalGeneration?: number;
};

type PrimaryVisibleRunProbe =
  | { state: "ready" }
  | { state: "waiting"; snapshot: VisibleRunBindSnapshot };

function failure(code: AgentWebclientBridgeErrorCode, message: string): AgentWebclientBridgeFailure {
  return { ok: false, error: { code, message } };
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isObserverDetachReason(reason: string) {
  return reason.trim().toLowerCase() === "detached";
}

function trustedKind(value: unknown): AgentWebclientSurfaceKind | null {
  return value === "agent-chat" ||
    value === "agent-copilot" ||
    value === "agent-overview" ||
    value === "agent-debug" ||
    value === "agent-btw" ||
    value === "agent-project" ||
    value === "agent-management"
    ? value
    : null;
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function mayAwaitSurfaceRegistration(
  sender: WebContents,
  isTrustedSession: (sender: WebContents) => boolean,
) {
  return !sender.isDestroyed() &&
    sender.getType() === "webview" &&
    isTrustedSession(sender);
}

function authorizeSurface(
  sender: WebContents,
  browserSurfaces: BrowserSurfaceRegistry,
  isTrustedSession: (sender: WebContents) => boolean,
): SurfaceContext | AgentWebclientBridgeFailure {
  const target = browserSurfaces.resolveWebviewSurfaceTarget(sender.id);
  const kind = trustedKind(target?.surfaceType);
  if (
    !target ||
    target.webContentsId !== sender.id ||
    !kind ||
    target.serviceId !== "agent-webclient" ||
    !isTrustedSession(sender) ||
    sender.isDestroyed() ||
    sender.getType() !== "webview" ||
    !sameOrigin(sender.getURL(), target.currentUrl)
  ) {
    return failure("surface_unavailable", "sender is not a trusted Agent WebClient surface");
  }
  return { sender, target, kind };
}

function sessionKey(senderId: number, sessionId: string) {
  return `${senderId}:${sessionId}`;
}

type PlatformFrameRecord = Record<string, unknown>;

type FrameErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
};

function frameError(
  id: string,
  code: AgentWebclientBridgeErrorCode,
  message: string,
  options: FrameErrorOptions = {},
): PlatformFrameRecord {
  const status = code === "capability_denied" ? 403
    : code === "duplicate_id" ? 409
      : code === "connection_unavailable" ? 503
        : 400;
  const structuredError = {
    code,
    message,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.details ? { details: options.details } : {}),
  };
  const hasMetadata = options.retryable !== undefined || Boolean(options.details);
  return {
    frame: "error",
    id,
    type: code,
    code: status,
    status,
    msg: message,
    data: hasMetadata
      ? { ...structuredError, error: structuredError }
      : structuredError,
  };
}

function frameErrorOptions(error: unknown): FrameErrorOptions {
  if (!isPlainBridgeRecord(error)) return {};
  return {
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(isPlainBridgeRecord(error.details) ? { details: error.details } : {}),
  };
}

function bridgeErrorCode(error: unknown): AgentWebclientBridgeErrorCode {
  const candidate = error instanceof Error ? error.name : "protocol_error";
  return [
    "bridge_unavailable", "version_mismatch", "invalid_request", "duplicate_id",
    "connection_unavailable", "connection_lost_before_acceptance", "capability_denied",
    "surface_unavailable", "target_unavailable",
    "unsupported_in_current_view", "unsupported_native_surface", "unsupported_native_type", "seq_expired",
    "replay_required", "protocol_error", "backpressure",
  ].includes(candidate) ? candidate as AgentWebclientBridgeErrorCode : "protocol_error";
}

function bridgeErrorWithMetadata(
  code: AgentWebclientBridgeErrorCode,
  message: string,
  options: FrameErrorOptions,
) {
  const error = new Error(message);
  error.name = code;
  return Object.assign(error, options);
}

function parseRequestFrame(value: unknown): AgentPlatformRequestFrame | null {
  if (!isPlainBridgeRecord(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_SERIALIZED_FRAME_BYTES) return null;
    const frame = value;
    if (
      frame.frame !== "request" ||
      !readText(frame.id) ||
      !readText(frame.type) ||
      (frame.payload !== undefined && !isPlainBridgeRecord(frame.payload))
    ) {
      return null;
    }
    return {
      frame: "request",
      id: readText(frame.id),
      type: readText(frame.type),
      ...(frame.payload === undefined ? {} : { payload: frame.payload }),
    };
  } catch {
    return null;
  }
}

function readOwner(value: unknown): AgentWebclientRunOwner | null {
  if (!isPlainBridgeRecord(value)) return null;
  const agentKey = readText(value.agentKey);
  const teamId = readText(value.teamId);
  if (Boolean(agentKey) === Boolean(teamId)) return null;
  return agentKey ? { kind: "agent", agentKey } : { kind: "team", teamId };
}

function sameOwner(left: AgentWebclientRunOwner | null, right: AgentWebclientRunOwner | null) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === "agent" && right.kind === "agent"
    ? left.agentKey === right.agentKey
    : left.kind === "team" && right.kind === "team" && left.teamId === right.teamId;
}

function readNormalizedStreamEvent(frame: PlatformFrameRecord): Record<string, unknown> | null {
  if (!isPlainBridgeRecord(frame.event)) return null;
  const rawEvent = frame.event as Record<string, unknown>;
  const { payload, ...eventFields } = rawEvent;
  const payloadFields: Record<string, unknown> = isPlainBridgeRecord(payload) ? payload : {};
  const type = readText(eventFields.type) || readText(payloadFields.type);
  const rawSeq = typeof eventFields.seq === "number" ? eventFields.seq : payloadFields.seq;
  return {
    ...payloadFields,
    ...eventFields,
    ...(type ? { type } : {}),
    ...(typeof rawSeq === "number" ? { seq: rawSeq } : {}),
  };
}

function updateBindingFromFrame(binding: StreamBinding, frame: PlatformFrameRecord) {
  const event = readNormalizedStreamEvent(frame);
  if (event) {
    binding.chatId = readText(event.chatId) || binding.chatId;
    binding.runId = readText(event.runId) || binding.runId;
    binding.owner = readOwner(event) || binding.owner;
    const seq = Number(event.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) binding.lastSeq = Math.max(binding.lastSeq, seq);
  }
  const lastSeq = Number(frame.lastSeq);
  if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
    binding.lastSeq = Math.max(binding.lastSeq, lastSeq);
  }
}

function protocolError(message: string) {
  return Object.assign(new Error(message), { name: "protocol_error" });
}

function sameNewChatSource(
  left: ReturnType<typeof readAgentWebclientNewChatSource>,
  right: ReturnType<typeof readAgentWebclientNewChatSource>,
) {
  return Boolean(
    left &&
    right &&
    left.agentKey === right.agentKey &&
    left.newChat === right.newChat
  );
}

function describeMainChatRouteIdentity(value: string | undefined) {
  if (readAgentWebclientNewChatSource(value ?? "")) return "new-chat";
  if (readAgentWebclientCanonicalChatSource(value ?? "")) return "canonical";
  if (readAgentWebclientAgentRouteKey(value ?? "")) return "agent-route";
  return "invalid";
}

function mainChatQueryRouteAgentKeys(target: RegisteredWebviewSurfaceTarget) {
  return [
    readAgentWebclientAgentRouteKey(target.currentUrl),
    readAgentWebclientAgentRouteKey(target.pageRouteIdentity ?? ""),
    readAgentWebclientAgentRouteKey(target.pageRoute ?? ""),
  ];
}

function validateMainChatQueryTargetAgentIdentity(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  if (
    target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  const owner = readOwner(payload);
  const routeAgentKeys = mainChatQueryRouteAgentKeys(target);
  if (
    !owner ||
    owner.kind !== "agent" ||
    routeAgentKeys.some((agentKey) => !agentKey || agentKey !== owner.agentKey)
  ) {
    throw protocolError("query Agent owner does not match its active Main Chat route");
  }
}

function validateMainChatQueryAgentIdentity(
  context: SurfaceContext,
  payload: Record<string, unknown>,
) {
  if (
    context.target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    context.target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  validateMainChatQueryTargetAgentIdentity(context.target, payload);
  const owner = readOwner(payload);
  if (
    !owner ||
    owner.kind !== "agent" ||
    readAgentWebclientAgentRouteKey(context.sender.getURL()) !== owner.agentKey
  ) {
    throw protocolError("query Agent owner does not match its active Main Chat route");
  }
}

function resolveNewChatQuerySource(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  if (target.surfaceId !== MAIN_CHAT_SURFACE_ID || target.surfaceType !== "agent-chat") return null;
  const ownerChatId = target.ownerChatId?.trim() || "";
  const guestSource = readAgentWebclientNewChatSource(target.currentUrl);
  const pageSource = readAgentWebclientNewChatSource(target.pageRouteIdentity ?? "");
  if (ownerChatId) {
    const payloadChatId = readText(payload.chatId);
    const pageCanonical = readAgentWebclientCanonicalChatSource(
      target.pageRouteIdentity ?? "",
    );
    if (!pageCanonical || pageCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its Desktop route");
    }
    if (guestSource) {
      if (payloadChatId === ownerChatId) return null;
      throw protocolError("new Chat query source does not match its active Main Chat route");
    }
    const guestCanonical = readAgentWebclientCanonicalChatSource(target.currentUrl);
    if (!guestCanonical || guestCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its guest route");
    }
    if (payloadChatId && payloadChatId !== ownerChatId) {
      throw protocolError("canonical Chat query does not match its active Main Chat owner");
    }
    return null;
  }
  if (!sameNewChatSource(guestSource, pageSource)) {
    throw protocolError("new Chat query requires an exact agentKey and newChat route source");
  }
  const expectedOwner = readOwner(payload);
  if (
    !expectedOwner ||
    expectedOwner.kind !== "agent" ||
    expectedOwner.agentKey !== guestSource!.agentKey
  ) {
    throw protocolError("new Chat query source does not match its active Main Chat route");
  }
  return {
    registrationId: target.registrationId,
    ownerWebContentsId: target.ownerWebContentsId,
    guestWebContentsId: target.webContentsId,
    agentKey: guestSource!.agentKey,
    newChat: guestSource!.newChat,
  };
}

function validateMainChatQuerySenderChatIdentity(
  context: SurfaceContext,
  payload: Record<string, unknown>,
  newChatSource: StreamBinding["newChatSource"],
) {
  if (
    context.target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    context.target.surfaceType !== "agent-chat"
  ) {
    return;
  }
  const senderUrl = context.sender.getURL();
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  if (ownerChatId) {
    const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
    if (senderNewChat) {
      if (readText(payload.chatId) === ownerChatId) return;
      throw protocolError("new Chat query source does not match its active Main Chat route");
    }
    const senderCanonical = readAgentWebclientCanonicalChatSource(senderUrl);
    if (!senderCanonical || senderCanonical.chatId !== ownerChatId) {
      throw protocolError("canonical Chat owner does not match its sender route");
    }
    return;
  }
  const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
  if (
    !newChatSource ||
    !senderNewChat ||
    senderNewChat.agentKey !== newChatSource.agentKey ||
    senderNewChat.newChat !== newChatSource.newChat
  ) {
    throw protocolError("new Chat query requires an exact agentKey and newChat sender route");
  }
}

function mainChatQueryTargetIsReady(
  target: RegisteredWebviewSurfaceTarget,
  payload: Record<string, unknown>,
) {
  try {
    validateMainChatQueryTargetAgentIdentity(target, payload);
    resolveNewChatQuerySource(target, payload);
    return true;
  } catch {
    return false;
  }
}

function mainChatQueryTargetIsTransitional(
  context: SurfaceContext,
  payload: Record<string, unknown>,
) {
  const target = context.target;
  if (
    target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    target.surfaceType !== "agent-chat" ||
    !target.active ||
    target.ownerChatId?.trim()
  ) {
    return false;
  }
  try {
    validateMainChatQueryAgentIdentity(context, payload);
  } catch {
    return false;
  }
  const pageNewChat = readAgentWebclientNewChatSource(target.pageRouteIdentity ?? "");
  const pageCanonical = readAgentWebclientCanonicalChatSource(target.pageRouteIdentity ?? "");
  const guestNewChat = readAgentWebclientNewChatSource(target.currentUrl);
  const senderNewChat = readAgentWebclientNewChatSource(context.sender.getURL());
  if (
    pageNewChat &&
    sameNewChatSource(pageNewChat, guestNewChat) &&
    sameNewChatSource(pageNewChat, senderNewChat)
  ) {
    return false;
  }

  const payloadChatId = readText(payload.chatId);
  const guestCanonical = readAgentWebclientCanonicalChatSource(target.currentUrl);
  const senderCanonical = readAgentWebclientCanonicalChatSource(context.sender.getURL());
  for (const canonical of [guestCanonical, senderCanonical]) {
    if (canonical && payloadChatId && canonical.chatId !== payloadChatId) return false;
  }
  if (pageCanonical) {
    return Boolean(payloadChatId && pageCanonical.chatId === payloadChatId);
  }
  return Boolean(pageNewChat);
}

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
}) {
  const sessions = new Map<string, LogicalSession>();
  const senderSessionKeys = new Map<number, Set<string>>();
  const closedLogicalSessions: ClosedLogicalSessionDiagnostic[] = [];
  const installedCleanup = new Set<number>();
  let activeLiveSessionKey: string | null = null;
  let nextLogicalGeneration = 0;

  const availability = async () => {
    const state = await options.getServiceState(options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = state.status === "running"
      ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
      : "";
    if (!baseUrl) throw new Error("Agent Platform is unavailable");
    const tokenResult = await options.issueAccessToken(options.app, "missing");
    const token = tokenResult.ok ? tokenResult.token.trim() : "";
    if (!token) throw new Error(tokenResult.message || "Agent Platform token is unavailable");
    return { baseUrl, token };
  };

  const sendEvent = (session: LogicalSession, event: AgentWebclientPlatformFramePortEvent) => {
    if (session.closed || session.sender.isDestroyed()) return;
    session.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, event);
    const target = options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
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
  };

  const sendFrame = (session: LogicalSession, frame: PlatformFrameRecord) => {
    sendEvent(session, {
      sessionId: session.sessionId,
      type: "frame",
      frame: frame as Exclude<import("../../shared/contracts").AgentPlatformRealtimeFrame, AgentPlatformRequestFrame>,
    });
  };

  const framePortState = (
    session: LogicalSession,
    state: ReturnType<RealtimeBroker["getConnectionState"]>,
  ): DesktopPlatformConnectionState => {
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
  };

  const closeSession = (
    session: LogicalSession,
    reason: DesktopPlatformSessionClose["reason"] = "disposed",
    error?: DesktopPlatformSessionClose["error"],
  ) => {
    if (session.closed) return;
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
    });
    if (closedLogicalSessions.length > 200) closedLogicalSessions.splice(0, closedLogicalSessions.length - 200);
    session.closed = true;
    session.unsubscribePush?.();
    session.unsubscribePush = null;
    session.unsubscribeConnection?.();
    session.unsubscribeConnection = null;
    for (const binding of session.streams.values()) {
      binding.unsubscribe?.();
      binding.unsubscribe = null;
      if (binding.visibleRegistered) options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
    }
    options.realtimeBroker.cleanupConsumer(session.consumerId);
    sessions.delete(session.key);
    const keys = senderSessionKeys.get(session.sender.id);
    keys?.delete(session.key);
    if (keys?.size === 0) senderSessionKeys.delete(session.sender.id);
    if (activeLiveSessionKey === session.key) activeLiveSessionKey = null;
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
  };

  const detachBinding = async (session: LogicalSession, binding: StreamBinding) => {
    if (binding.detachSent) return;
    binding.detachSent = true;
    if (binding.virtual) {
      binding.unsubscribe?.();
      binding.unsubscribe = null;
      return;
    }
    if (binding.visibleRegistered) {
      options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
      binding.visibleRegistered = false;
    }
    if (!binding.runId || !binding.owner) return;
    const { baseUrl, token } = await availability();
    await options.realtimeBroker.forwardRequest({
      baseUrl,
      token,
      localId: `surface-detach-${randomUUID()}`,
      consumerId: `${session.consumerId}:lease-detach`,
      type: "/api/detach",
      payload: {
        runId: binding.runId,
        ...(binding.owner.kind === "agent"
          ? { agentKey: binding.owner.agentKey }
          : { teamId: binding.owner.teamId }),
        reason: "surface_inactive",
      },
      onFrame: () => undefined,
      onError: () => undefined,
    });
  };

  const activateLiveSession = async (session: LogicalSession) => {
    if (activeLiveSessionKey === session.key) {
      await session.detachBarrier;
      const pending = [...session.streams.values()]
        .filter((binding) => binding.suppressed && !binding.detachSent && binding.runId && binding.owner)
        .map((binding) => detachBinding(session, binding).catch(() => undefined));
      await Promise.all(pending);
      return;
    }
    const previous = activeLiveSessionKey ? sessions.get(activeLiveSessionKey) : null;
    activeLiveSessionKey = session.key;
    if (!previous) return;
    await previous.detachBarrier;
    const pending: Promise<void>[] = [];
    for (const binding of previous.streams.values()) {
      binding.suppressed = true;
      if (binding.runId && binding.owner) {
        pending.push(detachBinding(previous, binding).catch(() => undefined));
      }
    }
    await Promise.all(pending);
  };

  const cleanupSender = (senderId: number) => {
    for (const key of [...(senderSessionKeys.get(senderId) ?? [])]) {
      const session = sessions.get(key);
      if (session) closeSession(session, "surface_inactive");
    }
    installedCleanup.delete(senderId);
  };

  const installSenderCleanup = (sender: WebContents) => {
    if (installedCleanup.has(sender.id)) return;
    installedCleanup.add(sender.id);
    sender.once("destroyed", () => cleanupSender(sender.id));
    sender.once("render-process-gone", () => cleanupSender(sender.id));
  };

  const finishRetiringSession = (session: LogicalSession) => {
    if (!session.retiring || session.streams.size > 0) return;
    closeSession(session, "surface_inactive");
  };

  const retireSession = async (session: LogicalSession) => {
    if (session.closed) return;
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
  };

  const resolveSession = (sender: WebContents, sessionId: string) =>
    sessions.get(sessionKey(sender.id, sessionId)) ?? null;

  const registerRejectedRunGrant = (
    binding: StreamBinding,
    event: Record<string, unknown>,
    error: unknown,
  ) => {
    const runId = readText(event.runId);
    const chatId = readText(event.chatId);
    const owner = readOwner(event);
    if (!runId || !chatId || !owner || binding.type !== "/api/query") return;
    const rejected = Promise.reject(error);
    void rejected.catch(() => undefined);
    try {
      options.realtimeBroker.registerForwardedRunActionGrant({
        sourceId: binding.sourceId,
        chatId,
        runId,
        owner,
        ready: rejected,
        replaceExisting: false,
      });
    } catch {
      // Preserve the first canonical grant identity registered for this Run.
    }
  };

  const establishCanonicalChatIdentity = (binding: StreamBinding, chatIdValue: string) => {
    const chatId = chatIdValue.trim();
    if (!chatId) throw protocolError("canonical Chat identity is empty");
    if (binding.runStarted) throw protocolError("canonical Chat identity arrived after run.start");
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
    if (!binding.newChatSource || binding.canonicalChatReady) return;
    const request = {
      sourceId: binding.sourceId,
      surfaceId: MAIN_CHAT_SURFACE_ID,
      registrationId: binding.newChatSource.registrationId,
      guestWebContentsId: binding.newChatSource.guestWebContentsId,
      agentKey: binding.newChatSource.agentKey,
      newChat: binding.newChatSource.newChat,
      chatId,
    } satisfies Omit<CanonicalChatSyncRequest, "requestId">;
    const traceCanonicalSync = (state: "ready" | "failed", reason: string) => {
      const target = options.browserSurfaces.resolveWebviewSurfaceTarget(
        binding.newChatSource!.guestWebContentsId,
      );
      options.realtimeBroker.appendDebugTrace({
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
    const ready = options.syncCanonicalChat(
      binding.newChatSource.ownerWebContentsId,
      request,
    ).then((result) => {
      if (!result.ok) {
        traceCanonicalSync("failed", result.code);
        throw Object.assign(new Error(result.message), { name: result.code });
      }
      traceCanonicalSync("ready", "canonical_owner_registered");
    });
    void ready.catch(() => undefined);
    binding.canonicalChatReady = ready;
  };

  const processQueryBootstrapFrame = (
    binding: StreamBinding,
    upstreamFrame: PlatformFrameRecord,
  ) => {
    if (binding.type !== "/api/query") return;
    const event = readNormalizedStreamEvent(upstreamFrame);
    if (!event) return;
    const type = readText(event.type);
    if (type !== "chat.start" && type !== "request.query" && type !== "run.start") return;
    requireAgentPlatformEpochMillis(
      event.timestamp,
      `agentWebclient.query[${binding.sourceId}].${type}.timestamp`,
    );
    const chatId = readText(event.chatId);
    if (!chatId) throw protocolError(`${type} must include canonical chatId`);

    if (type === "chat.start") {
      const eventOwner = readOwner(event);
      if (eventOwner && binding.expectedOwner && !sameOwner(binding.expectedOwner, eventOwner)) {
        throw protocolError("chat.start owner conflicts with the query owner");
      }
      establishCanonicalChatIdentity(binding, chatId);
      return;
    }

    if (type === "request.query") {
      if (!binding.newChatSource) return;
      if (binding.canonicalChatId) {
        if (binding.canonicalChatId !== chatId) {
          throw protocolError("request.query chatId conflicts with the canonical Chat identity");
        }
        return;
      }
      if (!binding.preboundChatId) return;
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
      establishCanonicalChatIdentity(binding, chatId);
      return;
    }

    const runId = readText(event.runId);
    const owner = readOwner(event);
    if (!runId) throw protocolError("run.start must include canonical runId");
    if (!owner) throw protocolError("run.start must include exactly one Run owner");
    if (binding.expectedOwner && !sameOwner(binding.expectedOwner, owner)) {
      throw protocolError("run.start owner conflicts with the query owner");
    }
    if (binding.newChatSource && !binding.canonicalChatId) {
      throw protocolError(
        "new Chat query requires chat.start or a matching canonical request.query before run.start",
      );
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
    options.realtimeBroker.registerForwardedRunActionGrant({
      sourceId: binding.sourceId,
      chatId,
      runId,
      owner,
      ready,
    });
    binding.chatId = chatId;
    binding.runId = runId;
    binding.owner = owner;
    binding.runStarted = true;
  };

  const ensurePrimaryVisibleRun = (input: {
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
  }): PrimaryVisibleRunProbe => {
    const visible = options.realtimeBroker.getVisibleBinding();
    if (visible?.chatId === input.chatId && visible.runId === input.runId) {
      return { state: "ready" };
    }

    let primarySessionCount = 0;
    let activePrimarySessionCount = 0;
    let matchingPrimarySessionCount = 0;
    let matchingStreamCount = 0;
    let pendingRunIdentityCount = 0;
    let matchingRunStreamCount = 0;
    let forwardedSourceTransitioning = false;
    let diagnosticSession: LogicalSession | null = null;
    for (const primarySession of sessions.values()) {
      if (primarySession.closed || primarySession.retiring) continue;
      const target = options.browserSurfaces.resolveWebviewSurfaceTarget(primarySession.sender.id);
      if (target?.surfaceId !== MAIN_CHAT_SURFACE_ID) continue;
      primarySessionCount += 1;
      diagnosticSession ??= primarySession;
      if (target.active) activePrimarySessionCount += 1;
      if (
        target.ownerChatId?.trim() !== input.chatId ||
        !target.active
      ) {
        continue;
      }
      matchingPrimarySessionCount += 1;
      diagnosticSession = primarySession;
      for (const candidate of primarySession.streams.values()) {
        if (
          candidate.virtual ||
          candidate.suppressed ||
          candidate.detachSent ||
          (candidate.type !== "/api/query" && candidate.type !== "/api/attach") ||
          candidate.chatId !== input.chatId ||
          !sameOwner(candidate.owner, input.owner)
        ) {
          continue;
        }
        matchingStreamCount += 1;
        if (!candidate.runId) {
          pendingRunIdentityCount += 1;
          continue;
        }
        if (candidate.runId !== input.runId) continue;
        matchingRunStreamCount += 1;
        try {
          options.realtimeBroker.beginForwardedVisibleRun({
            sourceId: candidate.sourceId,
            chatId: candidate.chatId,
            runId: candidate.runId,
            owner: candidate.owner!,
            lastSeq: candidate.lastSeq,
            primarySurfaceId: `surface:${primarySession.sender.id}`,
          });
          candidate.visibleRegistered = true;
          return { state: "ready" };
        } catch (error) {
          if (bridgeErrorCode(error) === "duplicate_id") {
            forwardedSourceTransitioning = true;
            continue;
          }
          const existingDetails = isPlainBridgeRecord(error) && isPlainBridgeRecord(error.details)
            ? error.details
            : {};
          throw bridgeErrorWithMetadata(
            bridgeErrorCode(error),
            error instanceof Error ? error.message : String(error),
            {
              ...(isPlainBridgeRecord(error) && typeof error.retryable === "boolean"
                ? { retryable: error.retryable }
                : {}),
              details: {
                ...existingDetails,
                stage: "visible_run_bind",
                reason: "primary_registration_failed",
                visibleBindingPresent: Boolean(visible),
                primarySessionCount,
                activePrimarySessionCount,
                matchingPrimarySessionCount,
                matchingStreamCount,
                pendingRunIdentityCount,
                matchingRunStreamCount,
                logicalGeneration: primarySession.logicalGeneration,
                physicalGeneration: primarySession.physicalGeneration,
              },
            },
          );
        }
      }
    }
    const reason: VisibleRunBindReason = forwardedSourceTransitioning
      ? "forwarded_source_transitioning"
      : matchingStreamCount === 0
        ? matchingPrimarySessionCount === 0
          ? "primary_surface_transitioning"
          : "primary_stream_not_ready"
        : pendingRunIdentityCount > 0
          ? "primary_run_identity_pending"
          : "primary_run_mismatch";
    return {
      state: "waiting",
      snapshot: {
        stage: "visible_run_bind",
        reason,
        visibleBindingPresent: Boolean(visible),
        primarySessionCount,
        activePrimarySessionCount,
        matchingPrimarySessionCount,
        matchingStreamCount,
        pendingRunIdentityCount,
        matchingRunStreamCount,
        ...(diagnosticSession
          ? {
              logicalGeneration: diagnosticSession.logicalGeneration,
              physicalGeneration: diagnosticSession.physicalGeneration,
            }
          : {}),
      },
    };
  };

  const waitForPrimaryVisibleRun = async (input: {
    session: LogicalSession;
    binding: StreamBinding;
    sender: WebContents;
    surfaceId: string;
    kind: "agent-overview" | "agent-debug";
  }) => {
    const startedAt = Date.now();
    const deadline = startedAt + VISIBLE_RUN_BIND_WAIT_MS;
    let attemptCount = 0;
    let lastSnapshot: VisibleRunBindSnapshot | null = null;
    while (true) {
      const { session, binding } = input;
      if (
        session.closed ||
        session.retiring ||
        binding.suppressed ||
        binding.detachSent ||
        session.streams.get(binding.localId) !== binding
      ) {
        return false;
      }
      const currentContext = authorizeSurface(
        input.sender,
        options.browserSurfaces,
        options.isTrustedAgentWebclientSession,
      );
      const expectedRole = input.kind === "agent-overview" ? "overview" : "debug";
      if (
        "ok" in currentContext ||
        currentContext.kind !== input.kind ||
        currentContext.target.surfaceId !== input.surfaceId ||
        currentContext.target.surfaceRole !== expectedRole ||
        currentContext.target.parentSurfaceId !== MAIN_CHAT_SURFACE_ID ||
        currentContext.target.ownerChatId?.trim() !== binding.chatId ||
        !currentContext.target.active
      ) {
        throw bridgeErrorWithMetadata(
          "surface_unavailable",
          "read-only Run surface changed while waiting for the Main Chat mirror",
          {
            retryable: false,
            details: {
              ...(lastSnapshot ?? {
                stage: "visible_run_bind",
                visibleBindingPresent: Boolean(options.realtimeBroker.getVisibleBinding()),
                primarySessionCount: 0,
                activePrimarySessionCount: 0,
                matchingPrimarySessionCount: 0,
                matchingStreamCount: 0,
                pendingRunIdentityCount: 0,
                matchingRunStreamCount: 0,
              }),
              reason: "virtual_surface_changed",
              waitedMs: Date.now() - startedAt,
              attemptCount,
            },
          },
        );
      }
      attemptCount += 1;
      const probe = ensurePrimaryVisibleRun({
        chatId: binding.chatId,
        runId: binding.runId,
        owner: binding.owner!,
      });
      if (probe.state === "ready") return true;
      lastSnapshot = probe.snapshot;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw bridgeErrorWithMetadata(
          "target_unavailable",
          `Main Chat visible Run mirror was not ready within ${VISIBLE_RUN_BIND_WAIT_MS}ms (${probe.snapshot.reason})`,
          {
            retryable: true,
            details: {
              ...probe.snapshot,
              waitedMs: Date.now() - startedAt,
              attemptCount,
            },
          },
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(VISIBLE_RUN_BIND_RETRY_MS, remainingMs));
      });
    }
  };

  const resolveMainChatQueryAuthorization = async (input: {
    session: LogicalSession;
    context: SurfaceContext;
    payload: Record<string, unknown>;
  }) => {
    try {
      validateMainChatQueryAgentIdentity(input.context, input.payload);
      const newChatSource = resolveNewChatQuerySource(input.context.target, input.payload);
      validateMainChatQuerySenderChatIdentity(
        input.context,
        input.payload,
        newChatSource,
      );
      return {
        context: input.context,
        newChatSource,
      };
    } catch (error) {
      if (!mainChatQueryTargetIsTransitional(input.context, input.payload)) throw error;
    }

    const initialTarget = input.context.target;
    const startedAt = Date.now();
    const trace = (state: "started" | "ready" | "failed", reason: string) => {
      options.realtimeBroker.appendDebugTrace({
        layer: "surface-bridge",
        direction: "surface-to-desktop",
        data: {
          event: "main-chat-query-identity-convergence",
          state,
          reason,
          waitedMs: Date.now() - startedAt,
          generation: initialTarget.registrationId,
          ownerPresent: Boolean(
            options.browserSurfaces
              .resolveWebviewSurfaceTarget(input.context.sender.id)
              ?.ownerChatId?.trim(),
          ),
          routeKind: describeMainChatRouteIdentity(initialTarget.pageRouteIdentity),
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
      matchedTarget = await options.browserSurfaces.waitForWebviewSurfaceTargetMatching(
        input.context.sender.id,
        (candidate) =>
          candidate.registrationId === initialTarget.registrationId &&
          candidate.ownerWebContentsId === initialTarget.ownerWebContentsId &&
          candidate.surfaceId === MAIN_CHAT_SURFACE_ID &&
          candidate.active &&
          mainChatQueryTargetIsReady(candidate, input.payload),
        SURFACE_REGISTRATION_WAIT_MS,
        abortController.signal,
      );
    } finally {
      input.context.sender.removeListener("destroyed", abortWait);
      input.context.sender.removeListener("render-process-gone", abortWait);
    }
    if (!matchedTarget || input.session.closed || input.context.sender.isDestroyed()) {
      trace("failed", matchedTarget ? "logical_session_changed" : "registration_wait_expired");
      throw protocolError("Main Chat identity did not converge before query authorization");
    }

    const nextContext = authorizeSurface(
      input.context.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if (
      "ok" in nextContext ||
      nextContext.target.registrationId !== initialTarget.registrationId ||
      nextContext.target.ownerWebContentsId !== initialTarget.ownerWebContentsId ||
      !nextContext.target.active
    ) {
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
    } catch (error) {
      trace("failed", "identity_changed_after_registration_match");
      throw error;
    }
  };

  const handleOpen = async (event: any, input: AgentWebclientPlatformFramePortOpenInput) => {
    const sessionId = readText(input?.sessionId);
    if (!sessionId) return;
    const initialTarget = options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id);
    let context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if (
      "ok" in context &&
      !initialTarget &&
      mayAwaitSurfaceRegistration(event.sender, options.isTrustedAgentWebclientSession)
    ) {
      const abortController = new AbortController();
      const abortWait = () => abortController.abort();
      event.sender.once("destroyed", abortWait);
      event.sender.once("render-process-gone", abortWait);
      try {
        await options.browserSurfaces.waitForWebviewSurfaceTarget(
          event.sender.id,
          SURFACE_REGISTRATION_WAIT_MS,
          abortController.signal,
        );
      } finally {
        event.sender.removeListener("destroyed", abortWait);
        event.sender.removeListener("render-process-gone", abortWait);
      }
      context = authorizeSurface(
        event.sender,
        options.browserSurfaces,
        options.isTrustedAgentWebclientSession,
      );
    }
    if ("ok" in context) {
      if (event.sender.isDestroyed()) return;
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
    const previousSessions = [...(senderSessionKeys.get(event.sender.id) ?? [])]
      .map((previousKey) => sessions.get(previousKey))
      .filter((previous): previous is LogicalSession => Boolean(previous));
    await Promise.all(previousSessions.map(retireSession));
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
    };
    sessions.set(key, session);
    const keys = senderSessionKeys.get(event.sender.id) ?? new Set<string>();
    keys.add(key);
    senderSessionKeys.set(event.sender.id, keys);
    installSenderCleanup(event.sender);
    try {
      const unsubscribeConnection = options.realtimeBroker.subscribeConnection({
        consumerId: session.consumerId,
        onState: (state) => {
          if (
            state.phase === "closed" &&
            state.lastError?.startsWith("PLATFORM_WS_PROTOCOL_MISMATCH")
          ) {
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
      session.unsubscribePush = options.realtimeBroker.subscribePush({
        types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES],
        kind: "surface",
        consumerId: session.consumerId,
        onPush: (frame) => sendFrame(session, frame),
      });
      const { baseUrl, token } = await availability();
      await options.realtimeBroker.ensureConnected(baseUrl, token);
    } catch (error) {
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
  };

  const handleSend = async (event: any, input: AgentWebclientPlatformFramePortSendInput) => {
    const session = resolveSession(event.sender, readText(input?.sessionId));
    if (!session || session.closed) return;
    const frame = parseRequestFrame(input?.frame);
    const fallbackId = isPlainBridgeRecord(input?.frame) ? readText(input.frame.id) : "";
    if (!frame) {
      sendFrame(session, frameError(fallbackId, "invalid_request", "Platform request frame is invalid"));
      return;
    }
    if (session.requestIds.has(frame.id)) {
      sendFrame(session, frameError(frame.id, "duplicate_id", "request id is already active on this logical session"));
      return;
    }
    let context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) {
      sendFrame(session, frameError(frame.id, "surface_unavailable", context.error.message));
      return;
    }
    // Trusted one-shot Platform requests share the broker without acquiring the live Run lease.
    // Only query/attach/BTW streams require the additional active-surface authorization below.
    const isLive = LIVE_REQUEST_TYPES.has(frame.type);
    const payload = isPlainBridgeRecord(frame.payload) ? frame.payload : {};
    let newChatSource: StreamBinding["newChatSource"] = null;
    if (frame.type === "/api/query") {
      try {
        const authorization = await resolveMainChatQueryAuthorization({
          session,
          context,
          payload,
        });
        context = authorization.context;
        newChatSource = authorization.newChatSource;
      } catch (error) {
        sendFrame(session, frameError(
          frame.id,
          "protocol_error",
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }
    }
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    const isReadonlyVirtualAttach = frame.type === "/api/attach" &&
      (context.kind === "agent-overview" || context.kind === "agent-debug") &&
      context.target.surfaceRole === (context.kind === "agent-overview" ? "overview" : "debug") &&
      context.target.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
      Boolean(ownerChatId);
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
        sendFrame(session, frameError(frame.id, "surface_unavailable", "only the active Chat or BTW surface may open this live Run stream"));
        return;
      }
      if (!isReadonlyVirtualAttach) await activateLiveSession(session);
    }
    if (frame.type === "/api/detach" && (context.kind === "agent-overview" || context.kind === "agent-debug")) {
      const runId = readText(payload.runId);
      const virtualBindings = [...session.streams.values()].filter((candidate) =>
        candidate.virtual && candidate.runId === runId,
      );
      for (const candidate of virtualBindings) {
        candidate.detachSent = true;
        candidate.unsubscribe?.();
        candidate.unsubscribe = null;
        session.requestIds.delete(candidate.localId);
        session.streams.delete(candidate.localId);
      }
      sendFrame(session, {
        frame: "response",
        id: frame.id,
        type: frame.type,
        code: 0,
        data: {},
      });
      return;
    }
    const explicitDetachBindings = frame.type === "/api/detach"
      ? [...session.streams.values()].filter((candidate) =>
          !candidate.detachSent &&
          Boolean(readText(payload.runId)) &&
          candidate.runId === readText(payload.runId)
        )
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
        if (candidate.visibleRegistered) {
          options.realtimeBroker.releaseForwardedVisibleRun(candidate.sourceId);
          candidate.visibleRegistered = false;
        }
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
    let connection: { baseUrl: string; token: string };
    try {
      connection = await availability();
    } catch (error) {
      finishExplicitDetachWrite(false);
      sendFrame(session, frameError(
        frame.id,
        "connection_unavailable",
        error instanceof Error ? error.message : String(error),
      ));
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
          visibleRegistered: false,
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
          protocolFailed: false,
        }
      : null;
    if (binding) session.streams.set(frame.id, binding);
    options.realtimeBroker.appendDebugTrace({
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
        const ready = await waitForPrimaryVisibleRun({
          session,
          binding,
          sender: event.sender,
          surfaceId: context.target.surfaceId,
          kind: context.kind as "agent-overview" | "agent-debug",
        });
        if (!ready) return;
        const subscription = options.realtimeBroker.subscribeVisibleRun({
          runId: binding.runId,
          chatId: binding.chatId,
          lastSeq: binding.lastSeq,
          owner: binding.owner,
          kind: "surface",
          consumerId: session.consumerId,
          surfaceId: `surface:${event.sender.id}`,
          onEvent: (runEvent) => sendFrame(session, {
            frame: "stream",
            id: binding.localId,
            event: runEvent,
          }),
          onComplete: (completed) => {
            binding.unsubscribe?.();
            binding.unsubscribe = null;
            sendFrame(session, {
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
            sendFrame(session, frameError(
              binding.localId,
              bridgeErrorCode(error),
              error.message,
              frameErrorOptions(error),
            ));
            session.requestIds.delete(binding.localId);
            session.streams.delete(binding.localId);
          },
        });
        binding.unsubscribe = subscription.unsubscribe;
        await subscription.ready;
      } catch (error) {
        if (
          session.closed ||
          binding.detachSent ||
          session.streams.get(binding.localId) !== binding
        ) {
          return;
        }
        session.requestIds.delete(frame.id);
        session.streams.delete(frame.id);
        sendFrame(session, frameError(
          frame.id,
          bridgeErrorCode(error),
          error instanceof Error ? error.message : String(error),
          frameErrorOptions(error),
        ));
      }
      return;
    }
    if (
      binding?.type === "/api/attach" &&
      context.target.surfaceId === MAIN_CHAT_SURFACE_ID &&
      binding.chatId && binding.runId && binding.owner
    ) {
      try {
        await options.realtimeBroker.prepareForwardedVisibleRun({
          baseUrl,
          token,
          chatId: binding.chatId,
          runId: binding.runId,
          owner: binding.owner,
        });
        options.realtimeBroker.registerForwardedRunActionGrant({
          sourceId: binding.sourceId,
          chatId: binding.chatId,
          runId: binding.runId,
          owner: binding.owner,
          ready: Promise.resolve(),
        });
        options.realtimeBroker.beginForwardedVisibleRun({
          sourceId: binding.sourceId,
          chatId: binding.chatId,
          runId: binding.runId,
          owner: binding.owner,
          lastSeq: binding.lastSeq,
          primarySurfaceId: `surface:${event.sender.id}`,
        });
        binding.visibleRegistered = true;
      } catch {
        // Main Chat remains authoritative even when its read-only mirror cannot bind.
      }
    }
    try {
      await options.realtimeBroker.forwardRequest({
        baseUrl,
        token,
        localId: frame.id,
        consumerId: session.consumerId,
        type: frame.type,
        payload,
        stream: isLive,
        onFrame: (upstreamFrame) => {
          const frameKind = readText(upstreamFrame.frame);
          const terminal = frameKind === "error" ||
            frameKind === "response" ||
            (frameKind === "stream" && Boolean(readText(upstreamFrame.reason)));
          if (binding?.protocolFailed) {
            if (terminal) {
              session.requestIds.delete(frame.id);
              session.streams.delete(frame.id);
              finishRetiringSession(session);
            }
            return;
          }
          if (binding) {
            const previousLastSeq = binding.lastSeq;
            try {
              processQueryBootstrapFrame(binding, upstreamFrame);
              updateBindingFromFrame(binding, upstreamFrame);
            } catch (error) {
              const normalizedEvent = readNormalizedStreamEvent(upstreamFrame);
              if (normalizedEvent) {
                registerRejectedRunGrant(binding, normalizedEvent, error);
              }
              binding.protocolFailed = true;
              binding.suppressed = true;
              if (binding.visibleRegistered) {
                options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
                binding.visibleRegistered = false;
              }
              session.requestIds.delete(frame.id);
              session.streams.delete(frame.id);
              sendFrame(session, frameError(
                frame.id,
                "protocol_error",
                error instanceof Error ? error.message : String(error),
              ));
              finishRetiringSession(session);
              return;
            }
            const shouldMirrorVisibleRun =
              context.target.surfaceId === MAIN_CHAT_SURFACE_ID &&
              (binding.type === "/api/query" || binding.type === "/api/attach") &&
              (binding.type !== "/api/query" || binding.runStarted) &&
              Boolean(binding.chatId && binding.runId && binding.owner);
            if (shouldMirrorVisibleRun && !binding.visibleRegistered) {
              try {
                options.realtimeBroker.beginForwardedVisibleRun({
                  sourceId: binding.sourceId,
                  chatId: binding.chatId,
                  runId: binding.runId,
                  owner: binding.owner!,
                  lastSeq: previousLastSeq,
                  primarySurfaceId: `surface:${event.sender.id}`,
                });
                binding.visibleRegistered = true;
              } catch {
                // Main Chat remains authoritative even when its read-only mirror cannot bind.
              }
            }
            const normalizedEvent = readNormalizedStreamEvent(upstreamFrame);
            if (binding.visibleRegistered && normalizedEvent) {
              try {
                options.realtimeBroker.appendForwardedVisibleRunEvent({
                  sourceId: binding.sourceId,
                  runId: binding.runId,
                  event: normalizedEvent,
                });
              } catch {
                options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
                binding.visibleRegistered = false;
              }
            }
            if (binding.suppressed && !binding.detachSent && binding.runId && binding.owner) {
              void detachBinding(session, binding).catch(() => undefined).finally(() => {
                if (!session.retiring) return;
                session.requestIds.delete(binding.localId);
                session.streams.delete(binding.localId);
                finishRetiringSession(session);
              });
            }
          }
          if (binding?.visibleRegistered && terminal) {
            const streamReason = readText(upstreamFrame.reason);
            if (frameKind === "stream" && streamReason && !isObserverDetachReason(streamReason)) {
              options.realtimeBroker.completeForwardedVisibleRun({
                sourceId: binding.sourceId,
                runId: binding.runId,
                reason: streamReason,
                ...(typeof upstreamFrame.lastSeq === "number" ? { lastSeq: upstreamFrame.lastSeq } : {}),
              });
            } else {
              options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
            }
            binding.visibleRegistered = false;
          }
          if (!binding?.suppressed || terminal) sendFrame(session, upstreamFrame);
          if (terminal) {
            session.requestIds.delete(frame.id);
            session.streams.delete(frame.id);
            finishRetiringSession(session);
          }
        },
        onError: (error) => {
          if (binding?.visibleRegistered) {
            options.realtimeBroker.releaseForwardedVisibleRun(binding.sourceId);
            binding.visibleRegistered = false;
          }
          session.requestIds.delete(frame.id);
          session.streams.delete(frame.id);
          sendFrame(session, frameError(frame.id, "connection_unavailable", error.message));
          finishRetiringSession(session);
        },
      });
      finishExplicitDetachWrite(true);
    } catch (error) {
      finishExplicitDetachWrite(false);
      session.requestIds.delete(frame.id);
      session.streams.delete(frame.id);
      sendFrame(session, frameError(
        frame.id,
        "connection_unavailable",
        error instanceof Error ? error.message : String(error),
      ));
      finishRetiringSession(session);
    }
  };

  const handleClose = (event: any, input: AgentWebclientPlatformFramePortCloseInput) => {
    const session = resolveSession(event.sender, readText(input?.sessionId));
    if (!session) return;
    for (const binding of session.streams.values()) {
      binding.suppressed = true;
      void detachBinding(session, binding).catch(() => undefined);
    }
    closeSession(session, input?.reason === "surface_inactive" ? "surface_inactive" : "disposed");
  };

  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_OPEN_CHANNEL, (event: any, input: AgentWebclientPlatformFramePortOpenInput) => {
    void handleOpen(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_SEND_CHANNEL, (event: any, input: AgentWebclientPlatformFramePortSendInput) => {
    void handleSend(event, input);
  });
  ipcMain.on?.(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_CLOSE_CHANNEL, handleClose);

  const handleWorkPanelInvoke = async (event: any, call: unknown) => {
    const context = authorizeSurface(
      event.sender,
      options.browserSurfaces,
      options.isTrustedAgentWebclientSession,
    );
    if ("ok" in context) return context;
    const ownerChatId = context.target.ownerChatId?.trim() || "";
    if (!ownerChatId) return failure("target_unavailable", "trusted WorkPanel owner chat is unavailable");
    const record = isPlainBridgeRecord(call) ? call : {};
    const method = typeof record.method === "string" ? record.method : "";
    const capabilities = [
      ...(context.kind === "agent-chat" || context.kind === "agent-copilot" || context.kind === "agent-overview"
        ? ["workpanel.open" as const]
        : []),
      "workpanel.activate" as const,
      "workpanel.close" as const,
    ];
    if (method === "getCapabilities") return { ok: true, capabilities };
    const capabilityAllowed = method === "openItem" || method === "openResource"
      ? capabilities.includes("workpanel.open")
      : method === "activateItem" || method === "closeItem";
    if (!capabilityAllowed) return failure("capability_denied", `${context.kind} cannot call ${method}`);
    const input = record.input as WorkPanelOpenItemInput | WorkPanelOpenResourceInput | WorkPanelItemTargetInput;
    const compatibleVersion = isPlainBridgeRecord(input) && (
      isAgentWebclientBridgeVersion(input.version) ||
      (input.version === 4 && method !== "openResource")
    );
    if (!compatibleVersion) {
      return failure("version_mismatch", `Desktop host bridge requires version ${AGENT_WEBCLIENT_BRIDGE_VERSION}`);
    }
    if (method === "openResource") {
      const resourceInput = input as WorkPanelOpenResourceInput;
      const allowedKeys = new Set([
        "version", "profile", "agentKey", "chatId", "resourceId", "relativePath", "title",
      ]);
      if (
        Object.keys(resourceInput).some((key) => !allowedKeys.has(key)) ||
        (resourceInput.profile !== "artifact" && resourceInput.profile !== "reference") ||
        !readText(resourceInput.agentKey) ||
        !readText(resourceInput.chatId) ||
        !readText(resourceInput.resourceId) ||
        !readText(resourceInput.relativePath) ||
        (resourceInput.title !== undefined && !readText(resourceInput.title))
      ) return failure("invalid_request", "Invalid native image resource request");
      if (resourceInput.chatId.trim() !== ownerChatId) {
        return failure("capability_denied", "Resource chat does not match the trusted owner Chat");
      }
      const normalizedResource = normalizeChatWorkPanelOpenLocalResourceRequest({
        ownerChatId,
        profile: resourceInput.profile,
        relativePath: resourceInput.relativePath,
      });
      if (!normalizedResource) {
        return failure("invalid_request", "Invalid native image resource path");
      }
      return options.openResource({
        ownerChatId,
        resource: {
          profile: resourceInput.profile,
          agentKey: resourceInput.agentKey.trim(),
          chatId: resourceInput.chatId.trim(),
          resourceId: resourceInput.resourceId.trim(),
          relativePath: normalizedResource.relativePath,
          ...(resourceInput.title ? { title: resourceInput.title.trim() } : {}),
        },
      });
    }
    if (
      method === "openItem" &&
      isPlainBridgeRecord((input as WorkPanelOpenItemInput).descriptor) &&
      (input as WorkPanelOpenItemInput).descriptor.kind === "native"
    ) return failure("capability_denied", "Native WorkPanel descriptors are host-only");
    const args = method === "openItem"
      ? { descriptor: (input as WorkPanelOpenItemInput).descriptor }
      : { itemId: (input as WorkPanelItemTargetInput).itemId };
    return options.dispatchWorkPanel({
      action: method as "openItem" | "activateItem" | "closeItem",
      ownerChatId,
      args,
    });
  };

  ipcMain.handle(AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL, handleWorkPanelInvoke);

  return {
    cleanupSender,
    getDiagnostics: () => ({
      registeredSenderCount: senderSessionKeys.size,
      logicalSessionCount: sessions.size,
      pendingRequestCount: [...sessions.values()].reduce((sum, session) => sum + session.requestIds.size, 0),
      activeStreamCount: [...sessions.values()].reduce((sum, session) => sum + session.streams.size, 0),
      activeLiveSurfaceCount: activeLiveSessionKey ? 1 : 0,
      activeLiveSessionKey,
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
