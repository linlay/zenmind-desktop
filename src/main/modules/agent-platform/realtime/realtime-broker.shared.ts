import type {
  AgentWebclientRunOwner
} from "../../../../shared/contracts";
import type { SiteControlScope } from "../../web-surfaces";
import {
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame
} from "./agent-platform-realtime-client";

export const MAX_REPLAY_EVENTS = 2_000;

export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

export const MAX_RETAINED_TERMINAL_RUNS = 2_000;

export const REQUEST_TIMEOUT_MS = 30_000;

export const DESKTOP_CDP_REQUEST_TYPE = "desktop.cdp.call";

export const DESKTOP_AWCP_MANUAL_TYPE = "desktop.awcp.manual";

export const DESKTOP_AWCP_INVOKE_TYPE = "desktop.awcp.invoke";

export const DESKTOP_RESPONSE_DELTA_EVENT_TYPE = "desktop.bridge.response.delta";

export const DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE = "desktop.cdp.screenshot.delta";

export const DESKTOP_STREAM_RAW_CHUNK_BYTES = 192 * 1024;

export const DESKTOP_SCREENSHOT_CHUNK_CHARS = 256 * 1024;

export const DESKTOP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type RealtimeLane = "primary" | "btw" | "selection-explain";

export type RealtimeConnectionStates = Record<RealtimeLane, AgentPlatformRealtimeConnectionState>;

export type RunChannelKey = { lane: RealtimeLane; runId: string };

export type RootObserverKind = "main_chat" | "copilot_dock" | "kanban_chat" | "selection_explain";

export type RootObserverIdentity = {
  token: string;
  kind: RootObserverKind;
  surfaceId: string;
  generation: string;
  contextId: string;
  /** Trusted new-chat route identity, retained through canonical promotion. */
  newChatSourceKey?: string;
  webContentsId: number;
};

export function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  (timer as T & { unref?: () => void }).unref?.();
  return timer;
}

export const AGENT_PLATFORM_KNOWN_PUSH_TYPES = new Set([
  "connected",
  "heartbeat",
  "live.connected",
  "run.started",
  "run.start",
  "run.finished",
  "run.complete",
  "chat.created",
  "chats.order.changed",
  "chat.updated",
  "chat.deleted",
  "chat.archived",
  "chat.unread",
  "chat.read",
  "chat.read_all",
  "catalog.updated",
  "archive.restored",
  "awaiting.asking",
  "awaiting.answered",
  "resource.pushed",
  "artifact.published",
]);

export type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
};

export type ReplayEvent = {
  event: Record<string, unknown>;
  bytes: number;
  seq: number | null;
  path?: string;
};

export type BrokerRun = {
  lane: RealtimeLane;
  runId: string;
  chatId: string;
  owner: AgentWebclientRunOwner | null;
  lastSeq: number;
  terminal: boolean;
  terminalReason: string;
  terminalSource: "query_stream" | "attach_stream" | "push" | null;
  suspended: boolean;
  restoreInFlight: boolean;
  restoreCount: number;
  lastRestoreResult: string;
  upstreamRequestId: string | null;
  upstreamSource: "query_stream" | "attach_stream";
  query: QueryTransaction | null;
  replay: ReplayEvent[];
  replayBytes: number;
  subscribers: Set<string>;
  rootObserverTokens: Set<string>;
  baseUrl: string;
  accessToken: string;
  detachInFlight: Promise<void> | null;
  operationGeneration: number;
};

export type QueryTransaction = {
  siteControlScope?: SiteControlScope;
  /** The auxiliary explanation observer has taken over this query's stream. */
  sourceDetached?: boolean;
  lane: RealtimeLane;
  requestType: "/api/query" | "/api/btw";
  operationId: string;
  upstreamRequestId: string;
  runId: string | null;
  chatId: string | null;
  expectedRunId: string;
  expectedChatId: string;
  expectedOwner: AgentWebclientRunOwner | null;
  accepted: Deferred<RealtimeQueryAccepted>;
  completed: Deferred<RealtimeQueryCompleted>;
  onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
  eventIndex: number;
  acceptedValue: RealtimeQueryAccepted | null;
  bufferedEvents: Array<{ event: Record<string, unknown>; path: string }>;
  bufferedEventBytes: number;
  eventQueue: Promise<void>;
  acceptanceTimer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  abortListener?: () => void;
  rootObserverToken: string | null;
  consumerId: string;
  subscriptionId: string | null;
  baseUrl: string;
  accessToken: string;
};

export type PendingRequest = {
  lane: RealtimeLane;
  consumerId: string;
  localId: string;
  upstreamId: string;
  type: string;
  stream: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onFrame(frame: AgentPlatformRealtimeFrame): void;
  onError(error: Error): void;
};

export type RunSubscription = {
  lane: RealtimeLane;
  id: string;
  runId: string;
  chatId: string;
  lastSeq: number;
  kind: "surface" | "internal";
  consumerId: string;
  onEvent(event: Record<string, unknown>, path?: string): void;
  onComplete?(result: RealtimeQueryCompleted): void;
  onError?(error: Error): void;
  role: "root_observer" | "clone" | "internal";
  observerToken?: string;
};

export type RootObserverState = RootObserverIdentity & {
  contextEpoch: string;
  runIds: Set<string>;
  overviewLease: OverviewCloneLeaseState | null;
};

export type OverviewCloneLeaseState = {
  state: "pending_chat_identity" | "ready";
  parentToken: string;
  parentGeneration: string;
  contextEpoch: string;
  chatId: string | null;
  runIds: Set<string>;
  pendingCloneIds: Set<string>;
  subscriberIds: Set<string>;
};

export type PendingClone = {
  id: string;
  kind: "overview" | "debug";
  consumerId: string;
  observerToken: string;
  parentGeneration: string;
  runId: string;
  chatId: string;
  owner: AgentWebclientRunOwner;
  waitReason: "awaiting_run_start";
  resolve(outcome: "ready" | "detached"): void;
  reject(error: Error): void;
};

export type PushSubscription = {
  id: string;
  types: Set<string>;
  filter?: { chatId?: string; runId?: string; resourceId?: string };
  kind: "surface" | "internal" | "desktop-ws";
  consumerId: string;
  onPush(frame: AgentPlatformRealtimeFrame): void;
};

export type ConnectionSubscription = {
  id: string;
  lane: RealtimeLane;
  consumerId: string;
  onState(state: AgentPlatformRealtimeConnectionState): void;
};

export type RunActionGrant = {
  sourceId: string;
  chatId: string;
  runId: string;
  owner: AgentWebclientRunOwner;
  generation: number;
  state: "pending" | "ready" | "failed";
  failureMessage: string;
  ready: Promise<void>;
  superseded: Promise<void>;
  supersede(): void;
};

export type DesktopBridgeRequestProvider = {
  acquireWorkPanelAwcpScope(surfaceId: string, chatId: string): SiteControlScope;
  action(request: Record<string, unknown>, scope?: SiteControlScope): Promise<unknown>;
  cdp(request: Record<string, unknown>, scope?: SiteControlScope, signal?: AbortSignal): Promise<unknown>;
  awcpManual(requestId: string, request: Record<string, unknown>, scope: SiteControlScope, signal: AbortSignal, surfaceId?: string): Promise<unknown>;
  awcpInvoke(requestId: string, request: Record<string, unknown>, scope: SiteControlScope, signal: AbortSignal, surfaceId?: string): Promise<unknown>;
};

export type RealtimeQueryAccepted = {
  chatId: string;
  runId: string;
  owner: AgentWebclientRunOwner;
};

export type RealtimeQueryCompleted = { reason: string; lastSeq?: number };

export type RealtimeQueryHandle = {
  accepted: Promise<RealtimeQueryAccepted>;
  completed: Promise<RealtimeQueryCompleted>;
};

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  void deferred.promise.catch(() => undefined);
  return deferred;
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sameRunOwner(first: AgentWebclientRunOwner, second: AgentWebclientRunOwner) {
  return first.kind === second.kind && (
    first.kind === "agent" && second.kind === "agent"
      ? first.agentKey === second.agentKey
      : first.kind === "team" && second.kind === "team" && first.teamId === second.teamId
  );
}

export function isTerminalEvent(type: string) {
  return [
    "done",
    "error",
    "stopped",
    "run.complete",
    "run.error",
    "run.cancel",
    "run.stopped",
    "run.interrupt",
    "run.expired",
  ].includes(type);
}

export function isObserverDetachReason(reason: string) {
  return reason.trim().toLowerCase() === "detached";
}

export function brokerError(
  code: string,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
) {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  return Object.assign(error, {
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.details ? { details: options.details } : {}),
  });
}

export function cloneBindingError(
  reason: "parent_observer_closed" | "visible_run_changed" | "run_not_registered" | "surface_generation_superseded",
  message: string,
) {
  return brokerError("target_unavailable", message, {
    retryable: false,
    details: { reason },
  });
}

export function frameError(frame: AgentPlatformRealtimeFrame) {
  const error = brokerError(
    readText(frame.type) || "protocol_error",
    readText(frame.msg) || readText(frame.message) || "Agent Platform request failed",
  );
  // Keep the upstream error envelope across the Error-based Broker boundary.
  // The Frame Port must not recategorize a Platform rejection as a host error.
  return Object.assign(error, { platformErrorFrame: frame });
}

export function framePayload(frame: AgentPlatformRealtimeFrame) {
  return isRecord(frame.data)
    ? frame.data
    : isRecord(frame.payload)
      ? frame.payload
      : frame;
}

export function pushIdentity(frame: AgentPlatformRealtimeFrame, key: "chatId" | "runId" | "resourceId") {
  return readText(frame[key]) || readText(framePayload(frame)[key]);
}

export function runChannelMapKey({ lane, runId }: RunChannelKey) {
  return `${lane}\u0000${runId}`;
}

/** Stable observer projection; callers never receive mutable lease internals. */
export type RootObserverSnapshot = RootObserverIdentity & Pick<RootObserverState, "contextEpoch" | "runIds">;

export type BrokerDiagnosticsCounters = {
  unknownFrameCount: number;
  unknownRequestIdCount: number;
  seqGapCount: number;
  staleFrameCount: number;
  seqRegressionCount: number;
  duplicateTerminalCount: number;
  observerReleaseCount: number;
  replayEvictionCount: number;
  seqExpiredCount: number;
  upstreamAttachCount: number;
  upstreamDetachCount: number;
  cloneCreatedCount: number;
  cloneRevokedCount: number;
  laneRotationCount: number;
};
