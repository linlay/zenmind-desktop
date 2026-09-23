import type { beginPlatformLoadDiagnostic } from "./load-diagnostic";

import type { App, WebContents } from "electron";

import {
  isPlainBridgeRecord,
  type AgentPlatformRequestFrame,
  type AgentWebclientBridgeErrorCode,
  type AgentWebclientBridgeFailure,
  type AgentWebclientRunOwner,
  type AgentWebclientSurfaceKind,
  type CanonicalChatSyncRequest,
  type CanonicalChatSyncResult,
  type DesktopPlatformConnectionState,
  type DesktopPlatformSessionClose,
  type WorkPanelBridgeResult,
  type WorkPanelOpenDocumentInput,
  type WorkPanelOpenDocumentResult,
  type WorkPanelOpenResourceInput,
  type WorkPanelOpenResourceResult
} from "../../../shared/contracts";

import type { AgentAuthIssueResult, ServiceState } from "../../../shared/contracts";

import type { BrowserSurfaceRegistry, RegisteredWebviewSurfaceTarget } from "../web-surfaces";

import {
  RealtimeBroker
} from "./realtime/realtime-broker";

import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID
} from "../../../shared/surface-identity";




export const AGENT_PLATFORM_SERVICE_ID = "agent-platform";

export const MAX_SERIALIZED_FRAME_BYTES = 8 * 1024 * 1024;

export const SURFACE_REGISTRATION_WAIT_MS = 1_500;

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
  loadDiagnostics: Map<string, ReturnType<typeof beginPlatformLoadDiagnostic>>;
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

export function sessionKey(senderId: number, sessionId: string) {
  return `${senderId}:${sessionId}`;
}

export type PlatformFrameRecord = Record<string, unknown>;

export function redactSelectionReferencesForTrace(value: unknown) {
  if (!isPlainBridgeRecord(value)) return value;
  const payload = isPlainBridgeRecord(value.payload) ? value.payload : null;
  const references = Array.isArray(payload?.references) ? payload.references : null;
  if (!payload || !references) return value;
  let changed = false;
  const nextReferences = references.map((reference) => {
    if (!isPlainBridgeRecord(reference) || reference.type !== "selection") return reference;
    changed = true;
    return {
      ...reference,
      ...(typeof reference.text === "string" ? { text: "<REDACTED_SELECTION>" } : {}),
      ...(typeof reference.annotation === "string" ? { annotation: "<REDACTED_SELECTION>" } : {}),
    };
  });
  return changed
    ? { ...value, payload: { ...payload, references: nextReferences } }
    : value;
}

export type FrameErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
  platformErrorFrame?: Record<string, unknown>;
};

export function frameError(
  id: string,
  code: AgentWebclientBridgeErrorCode,
  message: string,
  options: FrameErrorOptions = {},
): PlatformFrameRecord {
  if (options.platformErrorFrame) {
    return { ...options.platformErrorFrame, frame: "error", id };
  }
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
    ...(isPlainBridgeRecord(error.platformErrorFrame) && error.platformErrorFrame.frame === "error"
      ? { platformErrorFrame: error.platformErrorFrame } : {}),
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

export function protocolError(message: string) {
  return Object.assign(new Error(message), { name: "protocol_error" });
}

export type FramePortOptions = {
  app: App;
  getMainWebContents?(): WebContents | null;
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
  normalizeWorkPanelOpenLocalResourceRequest(value: unknown): { relativePath: string } | null;
};
