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
  type WorkPanelItem,
  type WorkPanelItemTargetInput,
  type WorkPanelWorkspace,
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

export const AGENT_PLATFORM_SERVICE_ID = "agent-platform";

export const MAX_SERIALIZED_FRAME_BYTES = 8 * 1024 * 1024;

export const SURFACE_REGISTRATION_WAIT_MS = 1_500;

export function normalizeDocumentWorkspacePath(value: unknown) {
  const requestedPath = typeof value === "string" ? value : "";
  return requestedPath.trim() && requestedPath.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(requestedPath)
    ? requestedPath.replace(/\\/gu, "/")
    : "";
}

export const LIVE_CHAT_SURFACE_IDS = new Set([
  MAIN_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
]);

export const LIVE_REQUEST_TYPES = new Set([
  "/api/query",
  "/api/attach",
  "/api/btw",
]);

export type SurfaceContext = {
  sender: WebContents;
  target: RegisteredWebviewSurfaceTarget;
  kind: AgentWebclientSurfaceKind;
};

export type StreamBinding = {
  localId: string;
  type: "/api/query" | "/api/attach" | "/api/btw";
  chatId: string;
  runId: string;
  owner: AgentWebclientRunOwner | null;
  lastSeq: number;
  suppressed: boolean;
  detachSent: boolean;
  virtual: boolean;
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
  observerToken: string | null;
};

export type LogicalSession = {
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
  rootObserverToken: string | null;
  chatLoadRequests: Map<string, { chatId: string; startedAt: number }>;
};

export type ClosedLogicalSessionDiagnostic = {
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
  streams: ReturnType<typeof streamBindingDiagnostic>[];
};

export function streamBindingDiagnostic(binding: StreamBinding) {
  return {
    requestId: binding.localId,
    type: binding.type,
    runId: binding.runId,
    chatId: binding.chatId,
    lastSeq: binding.lastSeq,
    virtual: binding.virtual,
  };
}

export function failure(code: AgentWebclientBridgeErrorCode, message: string): AgentWebclientBridgeFailure {
  return { ok: false, error: { code, message } };
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function trustedKind(value: unknown): AgentWebclientSurfaceKind | null {
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

export function rootObserverKind(target: RegisteredWebviewSurfaceTarget) {
  if (target.surfaceId === MAIN_CHAT_SURFACE_ID && target.surfaceRole === "main-chat") return "main_chat" as const;
  if (target.surfaceId === COPILOT_DOCK_SURFACE_ID && target.surfaceRole === "copilot-dock") return "copilot_dock" as const;
  if (target.surfaceId === KANBAN_CHAT_SURFACE_ID && target.surfaceRole === "kanban-chat") return "kanban_chat" as const;
  return null;
}

export type RootObserverContextSource = Pick<
  RegisteredWebviewSurfaceTarget,
  "surfaceId" | "registrationId" | "surfaceRole" | "surfaceIdentityKey" | "ownerChatId"
>;

export function rootObserverContextId(
  target: RootObserverContextSource,
  payloadChatId = "",
) {
  const chatId = target.ownerChatId?.trim() || payloadChatId.trim();
  const fallback = `${target.surfaceId}:${target.registrationId}`;
  if (target.surfaceRole !== "copilot-dock") return chatId || fallback;
  return [target.surfaceIdentityKey?.trim() || fallback, chatId].filter(Boolean).join(":");
}

export function createRootObserverToken(target: RegisteredWebviewSurfaceTarget, contextId: string) {
  return [
    target.surfaceId,
    target.registrationId,
    target.ownerWebContentsId,
    target.webContentsId,
    contextId,
  ].join(":");
}

export function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function mayAwaitSurfaceRegistration(
  sender: WebContents,
  isTrustedSession: (sender: WebContents) => boolean,
) {
  return !sender.isDestroyed() &&
    sender.getType() === "webview" &&
    isTrustedSession(sender);
}

export function authorizeSurface(
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

export function sessionKey(senderId: number, sessionId: string) {
  return `${senderId}:${sessionId}`;
}

export type PlatformFrameRecord = Record<string, unknown>;

export type FrameErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export function frameError(
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

export function frameErrorOptions(error: unknown): FrameErrorOptions {
  if (!isPlainBridgeRecord(error)) return {};
  return {
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(isPlainBridgeRecord(error.details) ? { details: error.details } : {}),
  };
}

export function bridgeErrorCode(error: unknown): AgentWebclientBridgeErrorCode {
  const candidate = error instanceof Error ? error.name : "protocol_error";
  return [
    "bridge_unavailable", "version_mismatch", "invalid_request", "duplicate_id",
    "connection_unavailable", "connection_lost_before_acceptance", "capability_denied",
    "surface_unavailable", "target_unavailable",
    "unsupported_in_current_view", "unsupported_native_surface", "unsupported_native_type", "seq_expired",
    "replay_required", "protocol_error", "backpressure",
  ].includes(candidate) ? candidate as AgentWebclientBridgeErrorCode : "protocol_error";
}

export function bridgeErrorWithMetadata(
  code: AgentWebclientBridgeErrorCode,
  message: string,
  options: FrameErrorOptions,
) {
  const error = new Error(message);
  error.name = code;
  return Object.assign(error, options);
}

export function parseRequestFrame(value: unknown): AgentPlatformRequestFrame | null {
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

export function readOwner(value: unknown): AgentWebclientRunOwner | null {
  if (!isPlainBridgeRecord(value)) return null;
  const agentKey = readText(value.agentKey);
  const teamId = readText(value.teamId);
  if (Boolean(agentKey) === Boolean(teamId)) return null;
  return agentKey ? { kind: "agent", agentKey } : { kind: "team", teamId };
}

export function sameOwner(left: AgentWebclientRunOwner | null, right: AgentWebclientRunOwner | null) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === "agent" && right.kind === "agent"
    ? left.agentKey === right.agentKey
    : left.kind === "team" && right.kind === "team" && left.teamId === right.teamId;
}

export function readNormalizedStreamEvent(frame: PlatformFrameRecord): Record<string, unknown> | null {
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

export function updateBindingFromFrame(binding: StreamBinding, frame: PlatformFrameRecord) {
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

export function protocolError(message: string) {
  return Object.assign(new Error(message), { name: "protocol_error" });
}

export function sameNewChatSource(
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

export function describeMainChatRouteIdentity(value: string | undefined) {
  if (readAgentWebclientNewChatSource(value ?? "")) return "new-chat";
  if (readAgentWebclientCanonicalChatSource(value ?? "")) return "canonical";
  if (readAgentWebclientAgentRouteKey(value ?? "")) return "agent-route";
  return "invalid";
}

export function mainChatQueryRouteAgentKeys(target: RegisteredWebviewSurfaceTarget) {
  return [
    readAgentWebclientAgentRouteKey(target.currentUrl),
    readAgentWebclientAgentRouteKey(target.pageRouteIdentity ?? ""),
    readAgentWebclientAgentRouteKey(target.pageRoute ?? ""),
  ];
}

export function validateMainChatQueryTargetAgentIdentity(
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

export function validateMainChatQueryAgentIdentity(
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

export function resolveNewChatQuerySource(
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

export function validateMainChatQuerySenderChatIdentity(
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

export function mainChatQueryTargetIsReady(
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

export function mainChatQueryTargetIsTransitional(
  context: SurfaceContext,
  payload: Record<string, unknown>,
) {
  const target = context.target;
  if (
    target.surfaceId !== MAIN_CHAT_SURFACE_ID ||
    target.surfaceType !== "agent-chat"
  ) {
    return false;
  }
  const owner = readOwner(payload);
  if (!owner || owner.kind !== "agent") {
    return false;
  }
  const senderUrl = context.sender.getURL();
  if (readAgentWebclientAgentRouteKey(senderUrl) !== owner.agentKey) {
    return false;
  }

  const payloadChatId = readText(payload.chatId);
  const senderCanonical = readAgentWebclientCanonicalChatSource(senderUrl);
  if (senderCanonical) {
    return Boolean(payloadChatId && senderCanonical.chatId === payloadChatId);
  }
  const senderNewChat = readAgentWebclientNewChatSource(senderUrl);
  return Boolean(senderNewChat && senderNewChat.agentKey === owner.agentKey);
}

export interface RegisterAgentWebclientBridgeIpcHandlersContext {
  ipcMain: any;
  options: { app: App; browserSurfaces: BrowserSurfaceRegistry; isTrustedAgentWebclientSession(sender: WebContents): boolean; realtimeBroker: RealtimeBroker; getServiceState(app: App, serviceId: string): Promise<ServiceState>; issueAccessToken(app: App, reason: "missing" | "unauthorized"): Promise<AgentAuthIssueResult>; syncCanonicalChat(ownerWebContentsId: number, input: Omit<CanonicalChatSyncRequest, "requestId">): Promise<CanonicalChatSyncResult>; dispatchWorkPanel(input: { action: "openItem" | "activateItem" | "closeItem"; ownerChatId: string; args: Record<string, unknown>; }): Promise<WorkPanelBridgeResult>; openResource(input: { ownerChatId: string; resource: Omit<WorkPanelOpenResourceInput, "version">; }): Promise<WorkPanelOpenResourceResult>; openDocument(input: { ownerChatId: string; document: Omit<WorkPanelOpenDocumentInput, "version">; }): Promise<WorkPanelOpenDocumentResult>; normalizeWorkPanelOpenLocalResourceRequest(value: unknown): any; };
  sessions: Map<string, LogicalSession>;
  senderSessionKeys: Map<number, Set<string>>;
  closedLogicalSessions: ClosedLogicalSessionDiagnostic[];
  installedCleanup: Set<number>;
  nextLogicalGeneration: number;
  developmentDiagnosticsEnabled: boolean;
  reportChatLoadDiagnostic: (stage: "request" | "response", session: LogicalSession, details: Record<string, unknown>) => void;
  availability: () => Promise<{ baseUrl: string; token: string; }>;
  sendEvent: (session: LogicalSession, event: AgentWebclientPlatformFramePortEvent) => void;
  sendFrame: (session: LogicalSession, frame: PlatformFrameRecord) => void;
  sendRunEvent: (session: LogicalSession, binding: StreamBinding, runEvent: Record<string, unknown>) => void;
  framePortState: (session: LogicalSession, state: ReturnType<RealtimeBroker["getConnectionState"]>) => DesktopPlatformConnectionState;
  closeSession: (session: LogicalSession, reason?: DesktopPlatformSessionClose["reason"], error?: DesktopPlatformSessionClose["error"]) => void;
  releaseSessionRootObserver: (session: LogicalSession, observerToken: string) => void;
  detachBinding: (session: LogicalSession, binding: StreamBinding) => Promise<void>;
  cleanupSender: (senderId: number) => void;
  installSenderCleanup: (sender: WebContents) => void;
  finishRetiringSession: (session: LogicalSession) => void;
  retireSession: (session: LogicalSession) => Promise<void>;
  resolveSession: (sender: WebContents, sessionId: string) => LogicalSession | null;
  establishCanonicalChatIdentity: (binding: StreamBinding, chatIdValue: string) => void;
  processQueryBootstrapFrame: (binding: StreamBinding, upstreamFrame: PlatformFrameRecord) => void;
  resolveMainChatQueryAuthorization: (input: { session: LogicalSession; context: SurfaceContext; payload: Record<string, unknown>; }) => Promise<{ context: SurfaceContext; newChatSource: { registrationId: string; ownerWebContentsId: number; guestWebContentsId: number; agentKey: string; newChat: string; } | null; }>;
  handleOpen: (event: any, input: AgentWebclientPlatformFramePortOpenInput) => Promise<void>;
  handleSend: (event: any, input: AgentWebclientPlatformFramePortSendInput) => Promise<void>;
  handleClose: (event: any, input: AgentWebclientPlatformFramePortCloseInput) => void;
  handleWorkPanelInvoke: (event: any, call: unknown) => Promise<AgentWebclientBridgeFailure | { ok: true; workspaceId: string; itemId: string; renderer: "native-html" | "native-image"; } | { ok: true; workspaceId: string; item?: WorkPanelItem; state?: WorkPanelWorkspace; } | { ok: boolean; capabilities: ("workpanel.open" | "workpanel.activate" | "workpanel.close")[]; }>;
}
