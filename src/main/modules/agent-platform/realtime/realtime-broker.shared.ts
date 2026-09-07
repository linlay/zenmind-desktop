import type { RunSiteCdpGrants } from "./run-site-cdp-grants";
import type { SiteCdpScope } from "../../web-surfaces";
import { randomUUID } from "node:crypto";

import type { App } from "electron";

import type {
  AgentAuthIssueResult,
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../../../shared/contracts";

import { validateAgentPlatformPushTimeContract } from "../../../../shared/agent-platform-push-time-contract";

import { getDesktopActionDefinition } from "../../../../shared/desktop-actions";

import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";
import type { EpochMilliseconds } from "../../../../shared/time-contract";
import type { SurfaceInteraction, SurfaceLevel, SurfaceRole } from "../../../../shared/surface-identity";

import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";

import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

export const MAX_REPLAY_EVENTS = 2_000;

export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

export const MAX_RETAINED_TERMINAL_RUNS = 2_000;

export const REQUEST_TIMEOUT_MS = 30_000;

export const DESKTOP_CDP_REQUEST_TYPE = "desktop.cdp.call";

export const DESKTOP_RESPONSE_DELTA_EVENT_TYPE = "desktop.bridge.response.delta";

export const DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE = "desktop.cdp.screenshot.delta";

export const DESKTOP_STREAM_RAW_CHUNK_BYTES = 192 * 1024;

export const DESKTOP_SCREENSHOT_CHUNK_CHARS = 256 * 1024;

export const DESKTOP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type RealtimeLane = "primary" | "btw";

export type RunChannelKey = { lane: RealtimeLane; runId: string };

export type RootObserverKind = "main_chat" | "copilot_dock" | "kanban_chat";

export type RootObserverIdentity = {
  token: string;
  kind: RootObserverKind;
  surfaceId: string;
  generation: string;
  contextId: string;
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
  siteCdpScope?: SiteCdpScope;
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
  action(request: Record<string, unknown>): Promise<unknown>;
  cdp(request: Record<string, unknown>, scope?: SiteCdpScope): Promise<unknown>;
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
  return brokerError(
    readText(frame.type) || "protocol_error",
    readText(frame.msg) || readText(frame.message) || "Agent Platform request failed",
  );
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

export interface RealtimeBrokerMethodContext {
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  connectionStates: Record<RealtimeLane, AgentPlatformRealtimeConnectionState>;
  pendingRequests: Map<string, PendingRequest>;
  queriesByRequestId: Map<string, QueryTransaction>;
  runChannels: Map<string, BrokerRun>;
  runSubscriptions: Map<string, RunSubscription>;
  pushSubscriptions: Map<string, PushSubscription>;
  connectionSubscriptions: Map<string, ConnectionSubscription>;
  terminalRequestIds: Set<string>;
  inboundDesktopRequests: Map<string, AbortController>;
  seenInboundDesktopRequestIds: Set<string>;
  runActionGrants: Map<string, RunActionGrant>;
  siteCdpGrants: RunSiteCdpGrants;
  activeRootObserver: RootObserverState | null;
  mainChatRootObserver: RootObserverState | null;
  pendingClones: Map<string, PendingClone>;
  lastCloneCancellationReason: string;
  desktopBridgeProvider: DesktopBridgeRequestProvider | null;
  disposed: boolean;
  acceptingDelivery: boolean;
  debugTrace: RealtimeDebugTraceBuffer;
  diagnostics: { unknownFrameCount: number; unknownRequestIdCount: number; seqGapCount: number; staleFrameCount: number; seqRegressionCount: number; duplicateTerminalCount: number; observerReleaseCount: number; replayEvictionCount: number; seqExpiredCount: number; upstreamAttachCount: number; upstreamDetachCount: number; cloneCreatedCount: number; cloneRevokedCount: number; laneRotationCount: number; };
  options: { app: App; issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>; getDesktopDeviceId: (app: App) => string; createWebSocket?: AgentPlatformRealtimeSocketFactory; connectTimeoutMs?: number; heartbeatTimeoutMs?: number; acceptanceTimeoutMs?: number; onDiagnostic?(message: string): void; onConnectionState?(state: AgentPlatformRealtimeConnectionState): void; };
  getConnectionPhase(): AgentWebclientConnectionPhase;
  getConnectionState(lane?: RealtimeLane): { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; };
  getConnectionStates(): { primary: { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; }; btw: { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; }; };
  setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null): void;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  setRunChannel(run: BrokerRun): void;
  deleteRunChannel(run: BrokerRun): boolean;
  findRootObserver(tokenValue: string): RootObserverState | null;
  snapshotRootObserver(observer: RootObserverState | null): { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null;
  ensureConnected(baseUrl: string, token: string, lane?: RealtimeLane): Promise<void>;
  query(options: {
    baseUrl: string;
    token: string;
    id: string;
    payload: Record<string, unknown>;
    runId?: string;
    chatId?: string;
    owner?: AgentWebclientRunOwner;
    signal?: AbortSignal;
    onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
    consumerId?: string;
    lane?: RealtimeLane;
    requestType?: "/api/query" | "/api/btw";
    observerToken?: string;
    siteCdpScope?: SiteCdpScope;
  }): RealtimeQueryHandle;
  forwardRequest(options: {
    baseUrl: string;
    token: string;
    localId: string;
    consumerId: string;
    type: string;
    payload?: Record<string, unknown>;
    stream?: boolean;
    onFrame(frame: AgentPlatformRealtimeFrame): void;
    onError(error: Error): void;
    lane?: RealtimeLane;
  }): Promise<string>;
  activateRootObserver(input: RootObserverIdentity): { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null;
  getActiveRootObserver(): { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null;
  getMainChatRootObserver(): { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null;
  promoteMainChatRootObserver(tokenValue: string, chatIdValue: string): { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null;
  releaseRootObserver(tokenValue: string, reason?: string): boolean;
  retireRootObserver(observer: RootObserverState, reason: string): void;
  releaseObservedRun(observerTokenValue: string, runIdValue: string, reason?: string): boolean;
  subscribeClone(options: {
    kind?: "overview" | "debug";
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner: AgentWebclientRunOwner;
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }): Promise<{ subscriptionId: string; unsubscribe: () => boolean; ready: Promise<void>; }>;
  subscribePush(options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }): () => boolean;
  subscribeConnection(options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }): () => boolean;
  subscribeRun(options: {
    baseUrl: string;
    token: string;
    runId: string;
    chatId: string;
    lastSeq?: number;
    agentKey?: string;
    owner?: AgentWebclientRunOwner;
    kind: "surface" | "internal";
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
    lane?: RealtimeLane;
    role?: "root_observer" | "clone" | "internal";
    observerToken?: string;
  }): { subscriptionId: string; unsubscribe: () => boolean; ready: Promise<void>; };
  unsubscribe(subscriptionId: string): boolean;
  registerRunActionGrant(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }): void;
  revokeRunActionGrant(runIdValue: string): boolean;
  clearRunActionGrants(): void;
  cleanupConsumer(consumerId: string): void;
  getDiagnostics(): { unknownFrameCount: number; unknownRequestIdCount: number; seqGapCount: number; staleFrameCount: number; seqRegressionCount: number; duplicateTerminalCount: number; observerReleaseCount: number; replayEvictionCount: number; seqExpiredCount: number; upstreamAttachCount: number; upstreamDetachCount: number; cloneCreatedCount: number; cloneRevokedCount: number; laneRotationCount: number; connection: { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; }; connections: { primary: { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; }; btw: { key: { endpoint: string; identitySessionId: string; } | null; phase: AgentWebclientConnectionPhase; generation: number; physicalConnectionCount: 0 | 1; reconnectCount: number; physicalSessionId?: string; lastInboundAt?: number; lastHeartbeatAt?: number; closeReason?: string; lastError?: string; }; }; pendingRequestCount: number; pendingQueryCount: number; activeStreamCount: number; runCount: number; localRunSubscriberCount: number; pushSubscriberCount: number; connectionSubscriberCount: number; rootObserver: { token: string; kind: RootObserverKind; surfaceId: string; generation: string; contextId: string; contextEpoch: string; webContentsId: number; runIds: Set<string>; } | null; overviewLease: { state: "pending_chat_identity" | "ready"; parentGeneration: string; contextEpoch: string; chatId: string | undefined; runCount: number; runIds: string[]; pendingSubscriberCount: number; uiSubscriberCount: number; subscribers: { runId: string; chatId: string; lastSeq: number; }[]; } | null; pendingClones: { observerToken: string; parentGeneration: string; runId: string; chatId: string; waitReason: "awaiting_run_start"; }[]; lastCloneCancellationReason: string | undefined; replay: { lane: RealtimeLane; runId: string; chatId: string; eventCount: number; bytes: number; lastSeq: number; lastEventType: string | undefined; lastEventSeq: number | undefined; lastPlanTaskEventType: string | undefined; lastPlanTaskEventSeq: number | undefined; state: string; terminalReason: string | undefined; terminalSource: "query_stream" | "attach_stream" | "push" | undefined; rootObserverCount: number; cloneCount: number; upstreamState: string; restoreCount: number; lastRestoreResult: string; }[]; };
  appendDebugTrace(input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]): AgentRealtimeDebugTraceEntry;
  getDebugTraceEntries(): { sequence: number; recordedAt: EpochMilliseconds; layer: AgentRealtimeDebugTraceLayer; direction: AgentRealtimeDebugTraceDirection; data: unknown; surfaceId?: string; webContentsId?: number; surfaceKind?: string; surfaceRole?: SurfaceRole; surfaceLevel?: SurfaceLevel; parentSurfaceId?: string; interaction?: SurfaceInteraction; route?: string; }[];
  clearDebugTrace(): void;
  rotateIdentity(reason?: RealtimeIdentityRotationReason): void;
  beginShutdown(): void;
  dispose(): void;
  handleConnectionState(lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState): void;
  handleFrame(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number): void;
  handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame): void;
  bufferProvisionalQueryEvent(transaction: QueryTransaction, event: Record<string, unknown>): void;
  commitProvisionalQueryEvents(run: BrokerRun, transaction: QueryTransaction): void;
  registerProvisionalRun(transaction: QueryTransaction, event: Record<string, unknown>): BrokerRun;
  bindQuerySubscription(run: BrokerRun, transaction: QueryTransaction): void;
  handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame): void;
  releaseRunObserver(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void;
  consumeRunEvent(run: BrokerRun, event: Record<string, unknown>, transaction: QueryTransaction | null): void;
  appendReplay(run: BrokerRun, event: Record<string, unknown>, seq: number | null, path?: string): void;
  replayToSubscriber(run: BrokerRun, subscription: RunSubscription): void;
  completeRun(run: BrokerRun, result: RealtimeQueryCompleted, source: NonNullable<BrokerRun["terminalSource"]>): void;
  failQuery(transaction: QueryTransaction, error: unknown): void;
  startAttach(run: BrokerRun, baseUrl: string, token: string): Promise<void>;
  restoreRun(run: BrokerRun): Promise<void>;
  handlePush(frame: AgentPlatformRealtimeFrame): void;
  handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame): void;
  handleDesktopBridgeRequest(id: string, type: string, frame: AgentPlatformRealtimeFrame): Promise<void>;
  awaitRunActionReadiness(action: string, source: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  sendDesktopBridgeSuccess(id: string, type: string, result: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  sendDesktopBridgeChunk(id: string, streamId: string, seq: number, type: string, chunk: string): void;
  sendDesktopBridgeError(id: string, type: string, code: number, msg: string, data?: unknown): void;
  waitForCloneRun(kind: "overview" | "debug", observerToken: string, runIdValue: string, chatIdValue: string, owner: AgentWebclientRunOwner, consumerId: string): Promise<"ready" | "detached">;
  notifyPendingClones(run: BrokerRun): void;
  rejectPendingClones(observerToken: string, error: Error): void;
  detachPendingClones(observerToken: string): void;
  pruneRetainedTerminalRuns(): void;
  hasSystemRunLease(run: BrokerRun): boolean;
  detachRunIfUnobserved(run: BrokerRun, reason: string): Promise<void>;
  cleanupPending(upstreamId: string): void;
  prepareConnectionIdentity(baseUrl: string, token: string): void;
}
