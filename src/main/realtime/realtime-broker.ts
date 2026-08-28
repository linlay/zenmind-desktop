import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../shared/contracts";
import { validateAgentPlatformPushTimeContract } from "../../shared/agent-platform-push-time-contract";
import { getDesktopActionDefinition } from "../../shared/desktop-actions";
import { requireAgentPlatformEpochMillis } from "../../shared/time-contract";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";
import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

const MAX_REPLAY_EVENTS = 2_000;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_TERMINAL_RUNS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DESKTOP_CDP_REQUEST_TYPE = "desktop.cdp.call";
const DESKTOP_RESPONSE_DELTA_EVENT_TYPE = "desktop.bridge.response.delta";
const DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE = "desktop.cdp.screenshot.delta";
const DESKTOP_STREAM_RAW_CHUNK_BYTES = 192 * 1024;
const DESKTOP_SCREENSHOT_CHUNK_CHARS = 256 * 1024;
const DESKTOP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

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

function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
};

type ReplayEvent = {
  event: Record<string, unknown>;
  bytes: number;
  seq: number | null;
  path?: string;
};

type BrokerRun = {
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

type QueryTransaction = {
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

type PendingRequest = {
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

type RunSubscription = {
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

type RootObserverState = RootObserverIdentity & {
  runIds: Set<string>;
};

type PendingClone = {
  id: string;
  observerToken: string;
  parentGeneration: string;
  runId: string;
  chatId: string;
  owner: AgentWebclientRunOwner;
  waitReason: "awaiting_run_start";
  resolve(): void;
  reject(error: Error): void;
};

type PushSubscription = {
  id: string;
  types: Set<string>;
  filter?: { chatId?: string; runId?: string; resourceId?: string };
  kind: "surface" | "internal" | "desktop-ws";
  consumerId: string;
  onPush(frame: AgentPlatformRealtimeFrame): void;
};

type ConnectionSubscription = {
  id: string;
  lane: RealtimeLane;
  consumerId: string;
  onState(state: AgentPlatformRealtimeConnectionState): void;
};

type RunActionGrant = {
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
  cdp(request: Record<string, unknown>): Promise<unknown>;
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

function createDeferred<T>(): Deferred<T> {
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

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameRunOwner(first: AgentWebclientRunOwner, second: AgentWebclientRunOwner) {
  return first.kind === second.kind && (
    first.kind === "agent" && second.kind === "agent"
      ? first.agentKey === second.agentKey
      : first.kind === "team" && second.kind === "team" && first.teamId === second.teamId
  );
}

function isTerminalEvent(type: string) {
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

function isObserverDetachReason(reason: string) {
  return reason.trim().toLowerCase() === "detached";
}

function brokerError(
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

function cloneBindingError(
  reason: "parent_observer_closed" | "visible_run_changed" | "run_not_registered" | "surface_generation_superseded",
  message: string,
) {
  return brokerError("target_unavailable", message, {
    retryable: false,
    details: { reason },
  });
}

function frameError(frame: AgentPlatformRealtimeFrame) {
  return brokerError(
    readText(frame.type) || "protocol_error",
    readText(frame.msg) || readText(frame.message) || "Agent Platform request failed",
  );
}

function framePayload(frame: AgentPlatformRealtimeFrame) {
  return isRecord(frame.data)
    ? frame.data
    : isRecord(frame.payload)
      ? frame.payload
      : frame;
}

function pushIdentity(frame: AgentPlatformRealtimeFrame, key: "chatId" | "runId" | "resourceId") {
  return readText(frame[key]) || readText(framePayload(frame)[key]);
}

function runChannelMapKey({ lane, runId }: RunChannelKey) {
  return `${lane}\u0000${runId}`;
}

export class RealtimeBroker {
  private readonly clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  private readonly connectionStates: Record<RealtimeLane, AgentPlatformRealtimeConnectionState>;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly queriesByRequestId = new Map<string, QueryTransaction>();
  private readonly runChannels = new Map<string, BrokerRun>();
  private readonly runSubscriptions = new Map<string, RunSubscription>();
  private readonly pushSubscriptions = new Map<string, PushSubscription>();
  private readonly connectionSubscriptions = new Map<string, ConnectionSubscription>();
  private readonly terminalRequestIds = new Set<string>();
  private readonly inboundDesktopRequests = new Map<string, AbortController>();
  private readonly seenInboundDesktopRequestIds = new Set<string>();
  private readonly runActionGrants = new Map<string, RunActionGrant>();
  private activeRootObserver: RootObserverState | null = null;
  private readonly pendingClones = new Map<string, PendingClone>();
  private lastCloneCancellationReason = "";
  private desktopBridgeProvider: DesktopBridgeRequestProvider | null = null;
  private disposed = false;
  private acceptingDelivery = true;
  private readonly debugTrace = new RealtimeDebugTraceBuffer();
  private diagnostics = {
    unknownFrameCount: 0,
    unknownRequestIdCount: 0,
    seqGapCount: 0,
    staleFrameCount: 0,
    seqRegressionCount: 0,
    duplicateTerminalCount: 0,
    observerReleaseCount: 0,
    replayEvictionCount: 0,
    seqExpiredCount: 0,
    upstreamAttachCount: 0,
    upstreamDetachCount: 0,
    cloneCreatedCount: 0,
    cloneRevokedCount: 0,
    laneRotationCount: 0,
  };

  constructor(private readonly options: {
    app: App;
    issueAccessToken: (
      app: App,
      reason: "missing" | "unauthorized",
    ) => Promise<AgentAuthIssueResult>;
    createWebSocket?: AgentPlatformRealtimeSocketFactory;
    connectTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    acceptanceTimeoutMs?: number;
    onDiagnostic?(message: string): void;
    onConnectionState?(state: AgentPlatformRealtimeConnectionState): void;
  }) {
    const idleState = (): AgentPlatformRealtimeConnectionState => ({
      phase: "idle",
      generation: 0,
      physicalConnectionCount: 0,
      reconnectCount: 0,
      key: null,
    });
    this.connectionStates = { primary: idleState(), btw: idleState() };
    const createClient = (lane: RealtimeLane) => new AgentPlatformRealtimeClient({
        app: options.app,
        issueAccessToken: options.issueAccessToken,
        createWebSocket: options.createWebSocket,
        connectTimeoutMs: options.connectTimeoutMs,
        heartbeatTimeoutMs: options.heartbeatTimeoutMs,
        source: lane === "primary" ? "desktop-main" : "desktop-btw",
        surfaceId: lane === "btw" ? "desktop-btw" : undefined,
        onFrame: (frame, generation) => this.handleFrame(lane, frame, generation),
        onStaleFrame: () => {
          this.diagnostics.staleFrameCount += 1;
        },
        onState: (state) => this.handleConnectionState(lane, state),
        onDiagnostic: (message) => options.onDiagnostic?.(`${lane}:${message}`),
        onTrace: (direction, frame) => this.debugTrace.append({
          layer: "platform-ws",
          direction: direction === "in" ? "platform-to-desktop" : "desktop-to-platform",
          data: { lane, ...frame },
        }),
      });
    this.clients = { primary: createClient("primary"), btw: createClient("btw") };
  }

  getConnectionPhase(): AgentWebclientConnectionPhase {
    return this.connectionStates.primary.phase;
  }

  getConnectionState(lane: RealtimeLane = "primary") {
    return this.clients[lane].getState();
  }

  getConnectionStates() {
    return {
      primary: this.clients.primary.getState(),
      btw: this.clients.btw.getState(),
    };
  }

  setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null) {
    this.desktopBridgeProvider = provider;
  }

  private getRunChannel(runIdValue: string, lane?: RealtimeLane) {
    const runId = runIdValue.trim();
    if (!runId) return undefined;
    if (lane) return this.runChannels.get(runChannelMapKey({ lane, runId }));
    return [...this.runChannels.values()].find((run) => run.runId === runId);
  }

  private setRunChannel(run: BrokerRun) {
    this.runChannels.set(runChannelMapKey(run), run);
  }

  private deleteRunChannel(run: BrokerRun) {
    return this.runChannels.delete(runChannelMapKey(run));
  }

  async ensureConnected(baseUrl: string, token: string, lane: RealtimeLane = "primary") {
    if (this.disposed || !this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is disposed");
    }
    this.prepareConnectionIdentity(baseUrl, token);
    await this.clients[lane].ensureConnected(baseUrl, token);
  }

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
  }): RealtimeQueryHandle {
    const accepted = createDeferred<RealtimeQueryAccepted>();
    const completed = createDeferred<RealtimeQueryCompleted>();
    const operationId = options.id.trim();
    const expectedRunId = options.runId?.trim() || "";
    const expectedChatId = options.chatId?.trim() || "";
    const lane = options.lane ?? (options.requestType === "/api/btw" ? "btw" : "primary");
    const requestType = options.requestType ?? (lane === "btw" ? "/api/btw" : "/api/query");
    if (!this.acceptingDelivery) {
      const error = brokerError("connection_unavailable", "Realtime Broker is shutting down");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    if (!operationId) {
      const error = brokerError("invalid_request", "query id is required");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    const upstreamRequestId = `desktop-query-${randomUUID()}`;
    const transaction: QueryTransaction = {
      lane,
      requestType,
      operationId,
      upstreamRequestId,
      runId: null,
      chatId: null,
      expectedRunId,
      expectedChatId,
      expectedOwner: options.owner ?? null,
      accepted,
      completed,
      onEvent: options.onEvent,
      eventIndex: 0,
      acceptedValue: null,
      bufferedEvents: [],
      bufferedEventBytes: 0,
      eventQueue: Promise.resolve(),
      acceptanceTimer: null,
      signal: options.signal,
      rootObserverToken: options.observerToken?.trim() || null,
      consumerId: options.consumerId?.trim() || `query:${operationId}`,
      subscriptionId: null,
      baseUrl: options.baseUrl,
      accessToken: options.token,
    };
    this.queriesByRequestId.set(upstreamRequestId, transaction);
    transaction.acceptanceTimer = setTimeout(() => {
      this.failQuery(
        transaction,
        brokerError("connection_unavailable", "query acceptance timed out"),
      );
    }, this.options.acceptanceTimeoutMs ?? REQUEST_TIMEOUT_MS);
    if (options.signal) {
      transaction.abortListener = () => {
        this.failQuery(transaction, brokerError("connection_unavailable", "query aborted"));
      };
      options.signal.addEventListener("abort", transaction.abortListener, { once: true });
    }
    void this.ensureConnected(options.baseUrl, options.token, lane)
      .then(() => {
        if (options.signal?.aborted) {
          throw brokerError("connection_unavailable", "query aborted");
        }
        this.clients[lane].send({
          frame: "request",
          type: requestType,
          id: upstreamRequestId,
          payload: options.payload,
        });
      })
      .catch((error) => this.failQuery(transaction, error));
    return { accepted: accepted.promise, completed: completed.promise };
  }

  async forwardRequest(options: {
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
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    const localId = options.localId.trim();
    const type = options.type.trim();
    const payloadRunId = readText(options.payload?.runId);
    const registeredLane = payloadRunId ? this.getRunChannel(payloadRunId)?.lane : undefined;
    const lane = options.lane ?? registeredLane ?? (type === "/api/btw" ? "btw" : "primary");
    if (!localId || !type) {
      throw brokerError("invalid_request", "request id and type are required");
    }
    const upstreamId = `desktop-forward-${randomUUID()}`;
    const timer = options.stream
      ? null
      : unrefTimer(setTimeout(() => {
          const pending = this.pendingRequests.get(upstreamId);
          if (!pending) return;
          this.pendingRequests.delete(upstreamId);
          pending.onError(brokerError("connection_unavailable", `${type} timed out`));
        }, REQUEST_TIMEOUT_MS));
    this.pendingRequests.set(upstreamId, {
      lane,
      consumerId: options.consumerId,
      localId,
      upstreamId,
      type,
      stream: Boolean(options.stream),
      timer,
      onFrame: options.onFrame,
      onError: options.onError,
    });
    try {
      await this.ensureConnected(options.baseUrl, options.token, lane);
      this.clients[lane].send({
        frame: "request",
        type,
        id: upstreamId,
        payload: options.payload ?? {},
      });
    } catch (error) {
      this.cleanupPending(upstreamId);
      throw error;
    }
    return upstreamId;
  }

  activateRootObserver(input: RootObserverIdentity) {
    const token = input.token.trim();
    const surfaceId = input.surfaceId.trim();
    const generation = input.generation.trim();
    const contextId = input.contextId.trim();
    if (!token || !surfaceId || !generation || !contextId || !Number.isSafeInteger(input.webContentsId)) {
      throw brokerError("invalid_request", "Root Observer identity is incomplete");
    }
    const current = this.activeRootObserver;
    if (current?.token === token && current.contextId === contextId) {
      return this.getActiveRootObserver();
    }
    if (current) this.releaseRootObserver(current.token, "surface_generation_superseded");
    this.activeRootObserver = {
      ...input,
      token,
      surfaceId,
      generation,
      contextId,
      runIds: new Set(),
    };
    return this.getActiveRootObserver();
  }

  getActiveRootObserver() {
    const observer = this.activeRootObserver;
    return observer
      ? { ...observer, runIds: new Set(observer.runIds) }
      : null;
  }

  releaseRootObserver(tokenValue: string, reason = "parent_observer_closed") {
    const token = tokenValue.trim();
    if (!token) return false;
    const observer = this.activeRootObserver?.token === token ? this.activeRootObserver : null;
    if (observer) this.activeRootObserver = null;
    const cloneReason = reason === "surface_generation_superseded"
      ? "surface_generation_superseded"
      : "parent_observer_closed";
    this.rejectPendingClones(token, cloneBindingError(cloneReason, "Main Chat observer is no longer active"));
    for (const subscription of [...this.runSubscriptions.values()]) {
      if (subscription.observerToken !== token) continue;
      this.unsubscribe(subscription.id);
      if (subscription.role === "clone") {
        subscription.onError?.(cloneBindingError(cloneReason, "Main Chat clone parent was released"));
      }
    }
    for (const run of this.runChannels.values()) {
      if (!run.rootObserverTokens.delete(token)) continue;
      void this.detachRunIfUnobserved(run, reason);
    }
    this.pruneRetainedTerminalRuns();
    return Boolean(observer);
  }

  releaseObservedRun(observerTokenValue: string, runIdValue: string, reason = "surface_inactive") {
    const observerToken = observerTokenValue.trim();
    const runId = runIdValue.trim();
    const run = this.getRunChannel(runId);
    if (!observerToken || !run || !run.rootObserverTokens.delete(observerToken)) return false;
    this.activeRootObserver?.runIds.delete(runId);
    for (const subscription of [...this.runSubscriptions.values()]) {
      if (subscription.runId !== runId || subscription.observerToken !== observerToken) continue;
      this.unsubscribe(subscription.id);
    }
    void this.detachRunIfUnobserved(run, reason);
    this.pruneRetainedTerminalRuns();
    return true;
  }

  async subscribeClone(options: {
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner: AgentWebclientRunOwner;
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }) {
    const observer = this.activeRootObserver;
    if (!observer || observer.kind !== "main_chat" || observer.contextId !== options.chatId.trim()) {
      throw cloneBindingError("parent_observer_closed", "active Main Chat observer does not match the clone");
    }
    await this.waitForCloneRun(observer.token, options.runId, options.chatId, options.owner);
    const current = this.activeRootObserver;
    const run = this.getRunChannel(options.runId);
    if (!current || current.token !== observer.token || !run || !run.rootObserverTokens.has(observer.token)) {
      throw cloneBindingError("surface_generation_superseded", "Main Chat observer changed before clone binding");
    }
    if (run.chatId !== options.chatId.trim() || (run.owner && !sameRunOwner(run.owner, options.owner))) {
      throw cloneBindingError("visible_run_changed", "clone Run identity no longer matches Main Chat");
    }
    const id = `clone-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
      id,
      lane: run.lane,
      runId: run.runId,
      chatId: run.chatId,
      lastSeq: Math.max(0, options.lastSeq ?? 0),
      kind: "surface",
      consumerId: options.consumerId,
      role: "clone",
      observerToken: observer.token,
      onEvent: options.onEvent,
      onComplete: options.onComplete,
      onError: options.onError,
    };
    this.replayToSubscriber(run, subscription);
    if (run.terminal) {
      queueMicrotask(() => options.onComplete?.({
        reason: run.terminalReason || "done",
        lastSeq: run.lastSeq,
      }));
      return {
        subscriptionId: id,
        unsubscribe: () => false,
        ready: Promise.resolve(),
      };
    }
    this.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    this.diagnostics.cloneCreatedCount += 1;
    return {
      subscriptionId: id,
      unsubscribe: () => this.unsubscribe(id),
      ready: Promise.resolve(),
    };
  }

  subscribePush(options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    const types = new Set(options.types.map((type) => type.trim()).filter((type) =>
      AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type),
    ));
    if (types.size === 0) {
      throw brokerError("invalid_request", "at least one known push type is required");
    }
    const id = `push-sub-${randomUUID()}`;
    this.pushSubscriptions.set(id, { id, ...options, types });
    return () => this.unsubscribe(id);
  }

  subscribeConnection(options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }) {
    const lane = options.lane ?? "primary";
    const id = `connection-sub-${randomUUID()}`;
    this.connectionSubscriptions.set(id, { id, ...options, lane });
    options.onState(this.clients[lane].getState());
    return () => this.connectionSubscriptions.delete(id);
  }

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
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    const runId = options.runId.trim();
    const chatId = options.chatId.trim();
    const lane = options.lane ?? "primary";
    if (!runId || !chatId) {
      throw brokerError("invalid_request", "runId and chatId are required");
    }
    const id = `run-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
      lane,
      id,
      runId,
      chatId,
      lastSeq: Math.max(0, options.lastSeq ?? 0),
      kind: options.kind,
      consumerId: options.consumerId,
      onEvent: options.onEvent,
      onComplete: options.onComplete,
      onError: options.onError,
      role: options.role ?? (options.kind === "internal" ? "internal" : "root_observer"),
      ...(options.observerToken ? { observerToken: options.observerToken } : {}),
    };
    let run = this.getRunChannel(runId, lane);
    if (!run) {
      if (this.getRunChannel(runId)) {
        throw brokerError("invalid_request", "runId belongs to a different Realtime lane");
      }
      run = {
        lane,
        runId,
        chatId,
        owner: options.owner ?? (options.agentKey?.trim()
          ? { kind: "agent", agentKey: options.agentKey.trim() }
          : null),
        lastSeq: Math.max(0, options.lastSeq ?? 0),
        terminal: false,
        terminalReason: "",
        terminalSource: null,
        suspended: false,
        restoreInFlight: false,
        restoreCount: 0,
        lastRestoreResult: "never",
        upstreamRequestId: null,
        query: null,
        replay: [],
        replayBytes: 0,
        subscribers: new Set(),
        rootObserverTokens: new Set(),
        baseUrl: options.baseUrl,
        accessToken: options.token,
        detachInFlight: null,
        operationGeneration: 0,
      };
      this.setRunChannel(run);
    } else if (run.chatId !== chatId) {
      throw brokerError("invalid_request", "runId belongs to a different chat");
    } else if (options.owner && run.owner && !sameRunOwner(run.owner, options.owner)) {
      throw brokerError("invalid_request", "runId belongs to a different Run owner");
    }
    if (subscription.role === "root_observer") {
      const observerToken = subscription.observerToken?.trim() || "";
      if (!observerToken || this.activeRootObserver?.token !== observerToken) {
        throw brokerError("surface_generation_superseded", "Root Observer is no longer active");
      }
    }
    this.replayToSubscriber(run, subscription);
    if (run.terminal) {
      queueMicrotask(() => options.onComplete?.({
        reason: run.terminalReason || "done",
        lastSeq: run.lastSeq,
      }));
      return {
        subscriptionId: id,
        unsubscribe: () => false,
        ready: Promise.resolve(),
      };
    }
    this.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    if (subscription.role === "root_observer") {
      const observerToken = subscription.observerToken!.trim();
      run.operationGeneration += 1;
      run.rootObserverTokens.add(observerToken);
      this.activeRootObserver!.runIds.add(run.runId);
      this.notifyPendingClones(run);
    }
    run.baseUrl = options.baseUrl;
    run.accessToken = options.token;
    const ready = !run.terminal && !run.upstreamRequestId
      ? Promise.resolve(run.detachInFlight).then(() => this.startAttach(run, options.baseUrl, options.token)).catch((error) => {
        subscription.onError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      : Promise.resolve();
    return {
      subscriptionId: id,
      unsubscribe: () => this.unsubscribe(id),
      ready,
    };
  }

  unsubscribe(subscriptionId: string) {
    const push = this.pushSubscriptions.get(subscriptionId);
    if (push) {
      this.pushSubscriptions.delete(subscriptionId);
      return true;
    }
    const runSubscription = this.runSubscriptions.get(subscriptionId);
    if (!runSubscription) return false;
    this.runSubscriptions.delete(subscriptionId);
    if (runSubscription.role === "clone") this.diagnostics.cloneRevokedCount += 1;
    const subscribedRun = this.getRunChannel(runSubscription.runId, runSubscription.lane);
    subscribedRun?.subscribers.delete(subscriptionId);
    if (subscribedRun && runSubscription.role === "root_observer" && runSubscription.observerToken) {
      const stillObserved = [...this.runSubscriptions.values()].some((candidate) =>
        candidate.role === "root_observer" &&
        candidate.runId === runSubscription.runId &&
        candidate.observerToken === runSubscription.observerToken
      );
      if (!stillObserved && subscribedRun.rootObserverTokens.delete(runSubscription.observerToken)) {
        this.activeRootObserver?.runIds.delete(subscribedRun.runId);
        void this.detachRunIfUnobserved(subscribedRun, "surface_inactive");
      }
    }
    return true;
  }

  registerRunActionGrant(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }) {
    const sourceId = input.sourceId.trim();
    const chatId = input.chatId.trim();
    const runId = input.runId.trim();
    if (!sourceId || !chatId || !runId) {
      throw brokerError("invalid_request", "canonical Run WorkPanel grant identity is incomplete");
    }
    const existing = this.runActionGrants.get(runId);
    if (existing && (
      existing.chatId !== chatId ||
      !sameRunOwner(existing.owner, input.owner)
    )) {
      throw brokerError("duplicate_id", "canonical Run WorkPanel grant identity conflicts");
    }
    if (existing && input.replaceExisting === false) return;
    const generation = (existing?.generation ?? 0) + 1;
    let supersede: () => void = () => undefined;
    const superseded = new Promise<void>((resolve) => {
      supersede = resolve;
    });
    const grant: RunActionGrant = {
      sourceId,
      chatId,
      runId,
      owner: input.owner,
      generation,
      state: "pending",
      failureMessage: "",
      ready: Promise.resolve(),
      superseded,
      supersede,
    };
    grant.ready = input.ready.then(
      () => {
        const current = this.runActionGrants.get(runId);
        if (current !== grant || current.generation !== generation) return;
        current.state = "ready";
        current.failureMessage = "";
      },
      (error) => {
        const current = this.runActionGrants.get(runId);
        if (current === grant && current.generation === generation) {
          current.state = "failed";
          current.failureMessage = error instanceof Error ? error.message : String(error);
        }
        throw error;
      },
    );
    void grant.ready.catch(() => undefined);
    existing?.supersede();
    this.runActionGrants.set(runId, grant);
    while (this.runActionGrants.size > 2_000) {
      const oldest = this.runActionGrants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.revokeRunActionGrant(oldest);
    }
  }

  revokeRunActionGrant(runIdValue: string) {
    const runId = runIdValue.trim();
    if (!runId) return false;
    const grant = this.runActionGrants.get(runId);
    if (!grant) return false;
    this.runActionGrants.delete(runId);
    grant.supersede();
    return true;
  }

  private clearRunActionGrants() {
    for (const grant of this.runActionGrants.values()) grant.supersede();
    this.runActionGrants.clear();
  }

  cleanupConsumer(consumerId: string) {
    const error = brokerError("target_unavailable", "realtime consumer was destroyed");
    for (const pending of [...this.pendingRequests.values()]) {
      if (pending.consumerId !== consumerId) continue;
      this.cleanupPending(pending.upstreamId);
      pending.onError(error);
    }
    for (const subscription of [...this.pushSubscriptions.values()]) {
      if (subscription.consumerId === consumerId) this.unsubscribe(subscription.id);
    }
    for (const subscription of [...this.runSubscriptions.values()]) {
      if (subscription.consumerId === consumerId) this.unsubscribe(subscription.id);
    }
    for (const subscription of [...this.connectionSubscriptions.values()]) {
      if (subscription.consumerId === consumerId) this.connectionSubscriptions.delete(subscription.id);
    }
  }

  getDiagnostics() {
    return {
      connection: this.clients.primary.getState(),
      connections: this.getConnectionStates(),
      pendingRequestCount: this.pendingRequests.size,
      pendingQueryCount: this.queriesByRequestId.size,
      activeStreamCount: [...this.runChannels.values()].filter((run) =>
        Boolean(run.upstreamRequestId && !run.terminal),
      ).length,
      runCount: this.runChannels.size,
      localRunSubscriberCount: this.runSubscriptions.size,
      pushSubscriberCount: this.pushSubscriptions.size,
      connectionSubscriberCount: this.connectionSubscriptions.size,
      rootObserver: this.getActiveRootObserver(),
      pendingClones: [...this.pendingClones.values()].map((pending) => ({
        observerToken: pending.observerToken,
        parentGeneration: pending.parentGeneration,
        runId: pending.runId,
        chatId: pending.chatId,
        waitReason: pending.waitReason,
      })),
      lastCloneCancellationReason: this.lastCloneCancellationReason || undefined,
      replay: [...this.runChannels.values()].map((run) => ({
        lane: run.lane,
        runId: run.runId,
        chatId: run.chatId,
        eventCount: run.replay.length,
        bytes: run.replayBytes,
        lastSeq: run.lastSeq,
        state: run.terminal
          ? "terminal"
          : run.detachInFlight
            ? "detaching"
            : run.rootObserverTokens.size > 0 || this.hasSystemRunLease(run)
              ? "observed"
              : "dormant",
        terminalReason: run.terminalReason || undefined,
        terminalSource: run.terminalSource ?? undefined,
        rootObserverCount: run.rootObserverTokens.size,
        cloneCount: [...run.subscribers].filter((id) =>
          this.runSubscriptions.get(id)?.role === "clone"
        ).length,
        upstreamState: run.detachInFlight
          ? "detaching"
          : run.upstreamRequestId
            ? "attached"
            : "detached",
        restoreCount: run.restoreCount,
        lastRestoreResult: run.lastRestoreResult,
      })),
      ...this.diagnostics,
    };
  }

  appendDebugTrace(input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]) {
    return this.debugTrace.append(input);
  }

  getDebugTraceEntries() {
    return this.debugTrace.snapshot();
  }

  clearDebugTrace() {
    this.debugTrace.clear();
  }

  rotateIdentity(reason: RealtimeIdentityRotationReason = "explicit_identity_invalidation") {
    this.options.onDiagnostic?.(`realtime_identity_rotation:${reason}`);
    this.diagnostics.laneRotationCount += 2;
    const error = brokerError("connection_unavailable", "realtime identity was invalidated");
    for (const pending of [...this.pendingRequests.values()]) {
      this.cleanupPending(pending.upstreamId);
      pending.onError(error);
    }
    for (const transaction of [...this.queriesByRequestId.values()]) {
      this.failQuery(transaction, error);
    }
    for (const subscription of this.runSubscriptions.values()) {
      subscription.onError?.(error);
    }
    this.queriesByRequestId.clear();
    this.runSubscriptions.clear();
    this.runChannels.clear();
    for (const pending of [...this.pendingClones.values()]) pending.reject(error);
    this.pendingClones.clear();
    this.activeRootObserver = null;
    this.terminalRequestIds.clear();
    this.clearRunActionGrants();
    this.clients.primary.rotateIdentity();
    this.clients.btw.rotateIdentity();
  }

  beginShutdown() {
    this.acceptingDelivery = false;
    for (const controller of this.inboundDesktopRequests.values()) controller.abort();
    this.inboundDesktopRequests.clear();
    this.seenInboundDesktopRequestIds.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = brokerError("connection_unavailable", "Realtime Broker disposed");
    for (const pending of this.pendingRequests.values()) pending.onError(error);
    for (const transaction of this.queriesByRequestId.values()) this.failQuery(transaction, error);
    this.pendingRequests.clear();
    this.queriesByRequestId.clear();
    this.runSubscriptions.clear();
    this.pushSubscriptions.clear();
    this.connectionSubscriptions.clear();
    this.runChannels.clear();
    for (const pending of [...this.pendingClones.values()]) pending.reject(error);
    this.pendingClones.clear();
    this.activeRootObserver = null;
    this.terminalRequestIds.clear();
    this.clearRunActionGrants();
    for (const controller of this.inboundDesktopRequests.values()) controller.abort();
    this.inboundDesktopRequests.clear();
    this.seenInboundDesktopRequestIds.clear();
    this.desktopBridgeProvider = null;
    this.clients.primary.dispose();
    this.clients.btw.dispose();
  }

  private handleConnectionState(lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState) {
    const previous = this.connectionStates[lane].phase;
    this.connectionStates[lane] = state;
    if (lane === "primary") this.options.onConnectionState?.(state);
    for (const subscription of this.connectionSubscriptions.values()) {
      if (subscription.lane !== lane) continue;
      subscription.onState({ ...state, key: state.key ? { ...state.key } : null });
    }
    if (state.phase === "connected" && previous !== "connected") {
      for (const run of this.runChannels.values()) {
        if (
          run.lane === lane && run.suspended && !run.terminal &&
          (run.rootObserverTokens.size > 0 || this.hasSystemRunLease(run))
        ) {
          void this.restoreRun(run);
        }
      }
      return;
    }
    if (state.phase !== "reconnecting" && state.phase !== "error") return;
    const disconnectError = brokerError(
      "connection_lost_before_acceptance",
      state.lastError || "Agent Platform realtime connection lost",
    );
    const requestError = brokerError(
      "connection_unavailable",
      state.lastError || "Agent Platform realtime connection lost",
      { retryable: true },
    );
    for (const pending of [...this.pendingRequests.values()]) {
      if (pending.lane !== lane) continue;
      this.cleanupPending(pending.upstreamId);
      pending.onError(requestError);
    }
    for (const transaction of [...this.queriesByRequestId.values()]) {
      if (transaction.lane !== lane) continue;
      if (!transaction.acceptedValue) {
        this.failQuery(transaction, disconnectError);
        continue;
      }
      const run = transaction.runId ? this.getRunChannel(transaction.runId, transaction.lane) : null;
      if (run) {
        run.suspended = true;
        run.upstreamRequestId = null;
      }
      this.queriesByRequestId.delete(transaction.upstreamRequestId);
    }
  }

  private handleFrame(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number) {
    if (!this.acceptingDelivery) return;
    if (generation !== this.connectionStates[lane].generation) {
      this.diagnostics.staleFrameCount += 1;
      return;
    }
    const kind = readText(frame.frame);
    if (kind === "push") {
      if (lane === "primary") this.handlePush(frame);
      return;
    }
    if (kind === "request") {
      this.handleInboundRequest(lane, frame);
      return;
    }
    if (!kind || !["response", "error", "stream"].includes(kind)) {
      this.diagnostics.unknownFrameCount += 1;
      return;
    }
    const id = readText(frame.id);
    if (!id) {
      this.diagnostics.unknownRequestIdCount += 1;
      return;
    }
    const query = this.queriesByRequestId.get(id);
    if (query) {
      if (query.lane !== lane) {
        this.diagnostics.staleFrameCount += 1;
        return;
      }
      if (kind === "error") {
        const message = readText(frame.msg) || readText(frame.message);
        const error = query.requestType === "/api/btw" &&
          readText(frame.type) === "invalid_request" &&
          message.includes("unknown type")
          ? brokerError("btw_ws_unsupported", "Agent Platform does not support BTW over WebSocket")
          : frameError(frame);
        this.failQuery(query, error);
      }
      else if (kind === "stream") this.handleQueryStream(query, frame);
      return;
    }
    const run = [...this.runChannels.values()].find((candidate) =>
      candidate.lane === lane && candidate.upstreamRequestId === id,
    );
    if (run && kind === "stream") {
      this.handleRunStream(run, frame);
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (pending) {
      if (pending.lane !== lane) {
        this.diagnostics.staleFrameCount += 1;
        return;
      }
      const outbound = { ...frame, id: pending.localId };
      pending.onFrame(outbound);
      const terminalStream = kind === "stream" && Boolean(readText(frame.reason));
      if (kind === "response" || kind === "error" || terminalStream) {
        this.cleanupPending(id);
      }
      return;
    }
    if (kind === "stream" && this.terminalRequestIds.has(id)) {
      this.diagnostics.duplicateTerminalCount += 1;
      return;
    }
    this.diagnostics.unknownRequestIdCount += 1;
  }

  private handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame) {
    let run = transaction.runId ? this.getRunChannel(transaction.runId, transaction.lane) : null;
    if (isRecord(frame.event)) {
      try {
        if (!run && readText(frame.event.type) !== "run.start") {
          this.bufferProvisionalQueryEvent(transaction, frame.event);
          return;
        }
        if (!run) {
          run = this.registerProvisionalRun(transaction, frame.event);
          this.commitProvisionalQueryEvents(run, transaction);
          this.bindQuerySubscription(run, transaction);
        }
        this.consumeRunEvent(run, frame.event, transaction);
      } catch (error) {
        this.failQuery(transaction, error);
        return;
      }
    }
    const reason = readText(frame.reason);
    if (!reason) return;
    if (!transaction.acceptedValue) {
      this.failQuery(transaction, brokerError("protocol_error", "query ended before run.start"));
      return;
    }
    if (!run) {
      this.failQuery(transaction, brokerError("protocol_error", "accepted query Run registry entry is missing"));
      return;
    }
    if (isObserverDetachReason(reason)) {
      this.releaseRunObserver(run, transaction.upstreamRequestId, reason, frame.lastSeq);
      return;
    }
    this.completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, "query_stream");
  }

  private bufferProvisionalQueryEvent(
    transaction: QueryTransaction,
    event: Record<string, unknown>,
  ) {
    const type = readText(event.type);
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex++}]`;
    if (!type) throw brokerError("protocol_error", "stream event.type is required");
    if (isTerminalEvent(type)) {
      throw brokerError("protocol_error", "terminal event arrived before run.start");
    }
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventChatId = readText(event.chatId);
    if (transaction.expectedChatId && eventChatId && transaction.expectedChatId !== eventChatId) {
      throw brokerError("protocol_error", "bootstrap chatId conflicts with query chatId");
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      transaction.bufferedEvents.length >= MAX_REPLAY_EVENTS ||
      transaction.bufferedEventBytes + bytes > MAX_REPLAY_BYTES
    ) {
      throw brokerError("backpressure", "too many query events arrived before run.start");
    }
    transaction.bufferedEvents.push({ event, path });
    transaction.bufferedEventBytes += bytes;
  }

  private commitProvisionalQueryEvents(run: BrokerRun, transaction: QueryTransaction) {
    for (const { event, path } of transaction.bufferedEvents) {
      const eventRunId = readText(event.runId);
      const eventChatId = readText(event.chatId);
      if (eventRunId && eventRunId !== run.runId) {
        throw brokerError("protocol_error", "bootstrap runId conflicts with canonical Run");
      }
      if (eventChatId && eventChatId !== run.chatId) {
        throw brokerError("protocol_error", "bootstrap chatId conflicts with canonical Run");
      }
      const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq)
        ? event.seq
        : null;
      if (seq !== null) {
        if (seq <= run.lastSeq) {
          this.diagnostics.seqRegressionCount += 1;
          continue;
        }
        if (run.lastSeq > 0 && seq > run.lastSeq + 1) this.diagnostics.seqGapCount += 1;
        run.lastSeq = seq;
      }
      this.appendReplay(run, event, seq, path);
    }
  }

  private registerProvisionalRun(
    transaction: QueryTransaction,
    event: Record<string, unknown>,
  ) {
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex}]`;
    if (readText(event.type) !== "run.start") throw brokerError("protocol_error", "run.start is required");
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const runId = readText(event.runId);
    const chatId = readText(event.chatId);
    if (!runId || !chatId) {
      throw brokerError("protocol_error", "run.start must include canonical chatId and runId");
    }
    if (transaction.expectedRunId && transaction.expectedRunId !== runId) {
      throw brokerError("protocol_error", "stream runId conflicts with registered Run");
    }
    if (transaction.expectedChatId && transaction.expectedChatId !== chatId) {
      throw brokerError("protocol_error", "run.start chatId conflicts with query chatId");
    }
    const agentKey = readText(event.agentKey);
    const teamId = readText(event.teamId);
    if (Boolean(agentKey) === Boolean(teamId)) {
      throw brokerError("protocol_error", "run.start must include exactly one Run owner");
    }
    const owner: AgentWebclientRunOwner = teamId
      ? { kind: "team", teamId }
      : { kind: "agent", agentKey };
    const expectedOwner = transaction.expectedOwner;
    if (expectedOwner && (
      owner.kind !== expectedOwner.kind ||
      (owner.kind === "agent" && expectedOwner.kind === "agent" && owner.agentKey !== expectedOwner.agentKey) ||
      (owner.kind === "team" && expectedOwner.kind === "team" && owner.teamId !== expectedOwner.teamId)
    )) {
      throw brokerError("protocol_error", "run.start owner conflicts with query owner");
    }
    if (this.getRunChannel(runId)) {
      throw brokerError("duplicate_id", `runId ${runId} is already registered`);
    }
    const run: BrokerRun = {
      lane: transaction.lane,
      runId,
      chatId,
      owner,
      lastSeq: 0,
      terminal: false,
      terminalReason: "",
      terminalSource: null,
      suspended: false,
      restoreInFlight: false,
      restoreCount: 0,
      lastRestoreResult: "never",
      upstreamRequestId: transaction.upstreamRequestId,
      query: transaction,
      replay: [],
      replayBytes: 0,
      subscribers: new Set(),
      rootObserverTokens: new Set(),
      baseUrl: transaction.baseUrl,
      accessToken: transaction.accessToken,
      detachInFlight: null,
      operationGeneration: 0,
    };
    transaction.runId = runId;
    transaction.chatId = chatId;
    this.setRunChannel(run);
    const observerToken = transaction.rootObserverToken;
    if (observerToken && this.activeRootObserver?.token === observerToken) {
      run.operationGeneration += 1;
      run.rootObserverTokens.add(observerToken);
      this.activeRootObserver.runIds.add(runId);
      this.notifyPendingClones(run);
    } else if (observerToken) {
      void this.detachRunIfUnobserved(run, "surface_generation_superseded");
    }
    return run;
  }

  private bindQuerySubscription(run: BrokerRun, transaction: QueryTransaction) {
    const observerToken = transaction.rootObserverToken;
    const role: RunSubscription["role"] = observerToken ? "root_observer" : "internal";
    if (observerToken && this.activeRootObserver?.token !== observerToken) {
      transaction.bufferedEvents = [];
      transaction.bufferedEventBytes = 0;
      return;
    }
    const id = `query-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
      lane: run.lane,
      id,
      runId: run.runId,
      chatId: run.chatId,
      lastSeq: 0,
      kind: role === "internal" ? "internal" : "surface",
      consumerId: transaction.consumerId,
      role,
      ...(observerToken ? { observerToken } : {}),
      onEvent: (event, eventPath) => {
        const path = eventPath || `broker.${run.lane}[${run.runId}].events`;
        transaction.eventQueue = transaction.eventQueue.then(() => transaction.onEvent(event, path));
        void transaction.eventQueue.catch((error) => this.failQuery(transaction, error));
      },
    };
    this.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    transaction.subscriptionId = id;
    this.replayToSubscriber(run, subscription);
    transaction.bufferedEvents = [];
    transaction.bufferedEventBytes = 0;
  }

  private handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame) {
    if (isRecord(frame.event)) {
      try {
        this.consumeRunEvent(run, frame.event, run.query);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        for (const id of run.subscribers) this.runSubscriptions.get(id)?.onError?.(normalized);
        return;
      }
    }
    const reason = readText(frame.reason);
    if (!reason) return;
    if (isObserverDetachReason(reason)) {
      this.releaseRunObserver(run, readText(frame.id), reason, frame.lastSeq);
      return;
    }
    this.completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, "attach_stream");
  }

  private releaseRunObserver(
    run: BrokerRun,
    requestId: string,
    reason: string,
    lastSeq: unknown,
  ) {
    if (typeof lastSeq === "number" && Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
      run.lastSeq = Math.max(run.lastSeq, lastSeq);
    }
    const transaction = run.query && (!requestId || run.query.upstreamRequestId === requestId)
      ? run.query
      : null;
    if (requestId) {
      this.queriesByRequestId.delete(requestId);
      this.terminalRequestIds.add(requestId);
      if (this.terminalRequestIds.size > 2_000) {
        this.terminalRequestIds.delete(this.terminalRequestIds.values().next().value as string);
      }
    }
    if (!requestId || run.upstreamRequestId === requestId) run.upstreamRequestId = null;
    if (transaction) {
      run.query = null;
      if (transaction.signal && transaction.abortListener) {
        transaction.signal.removeEventListener("abort", transaction.abortListener);
      }
      if (transaction.subscriptionId) this.unsubscribe(transaction.subscriptionId);
      const result: RealtimeQueryCompleted = {
        reason: "detached",
        ...(typeof lastSeq === "number" ? { lastSeq } : {}),
      };
      void transaction.eventQueue.then(
        () => transaction.completed.resolve(result),
        (error) => transaction.completed.reject(error),
      );
    }
    run.suspended = true;
    run.lastRestoreResult = `observer_released:${reason}`;
    this.diagnostics.observerReleaseCount += 1;
  }

  private consumeRunEvent(
    run: BrokerRun,
    event: Record<string, unknown>,
    transaction: QueryTransaction | null,
  ) {
    const type = readText(event.type);
    if (!type) throw brokerError("protocol_error", "stream event.type is required");
    const path = transaction
      ? `ws.query[${transaction.operationId}].events[${transaction.eventIndex++}]`
      : `ws.attach[${run.runId}].events`;
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventRunId = readText(event.runId);
    const eventChatId = readText(event.chatId);
    if (eventRunId && eventRunId !== run.runId) {
      throw brokerError("protocol_error", "stream runId conflicts with registered Run");
    }
    if (eventChatId && eventChatId !== run.chatId) {
      throw brokerError("protocol_error", "stream chatId conflicts with registered Run");
    }
    const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq)
      ? event.seq
      : null;
    if (seq !== null) {
      if (seq <= run.lastSeq) {
        this.diagnostics.seqRegressionCount += 1;
        return;
      }
      if (run.lastSeq > 0 && seq > run.lastSeq + 1) this.diagnostics.seqGapCount += 1;
      run.lastSeq = seq;
    }
    if (transaction && !transaction.acceptedValue) {
      if (type !== "run.start") {
        if (isTerminalEvent(type)) {
          throw brokerError("protocol_error", "terminal event arrived before run.start");
        }
        this.appendReplay(run, event, seq, path);
        transaction.bufferedEvents.push({ event, path });
        return;
      }
      transaction.acceptedValue = {
        chatId: run.chatId,
        runId: run.runId,
        owner: run.owner!,
      };
      if (transaction.acceptanceTimer) {
        clearTimeout(transaction.acceptanceTimer);
        transaction.acceptanceTimer = null;
      }
      transaction.accepted.resolve(transaction.acceptedValue);
    }
    this.appendReplay(run, event, seq, path);
    for (const id of run.subscribers) {
      const subscription = this.runSubscriptions.get(id);
      if (!subscription || (seq !== null && seq <= subscription.lastSeq)) continue;
      if (seq !== null) subscription.lastSeq = seq;
      subscription.onEvent(event, path);
    }
  }

  private appendReplay(
    run: BrokerRun,
    event: Record<string, unknown>,
    seq: number | null,
    path?: string,
  ) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    run.replay.push({ event, bytes, seq, ...(path ? { path } : {}) });
    run.replayBytes += bytes;
    while (run.replay.length > MAX_REPLAY_EVENTS || run.replayBytes > MAX_REPLAY_BYTES) {
      const removed = run.replay.shift();
      if (!removed) break;
      run.replayBytes -= removed.bytes;
      this.diagnostics.replayEvictionCount += 1;
    }
  }

  private replayToSubscriber(run: BrokerRun, subscription: RunSubscription) {
    const firstSeq = run.replay.find((entry) => entry.seq !== null)?.seq;
    if (firstSeq !== undefined && firstSeq !== null && subscription.lastSeq + 1 < firstSeq) {
      this.diagnostics.seqExpiredCount += 1;
      throw brokerError(
        "seq_expired",
        "requested Run cursor is outside the local replay window",
        {
          retryable: true,
          details: {
            requestedLastSeq: subscription.lastSeq,
            firstAvailableSeq: firstSeq,
            latestSeq: run.lastSeq,
            replayEventCount: run.replay.length,
            replayBytes: run.replayBytes,
          },
        },
      );
    }
    for (const entry of run.replay) {
      if (entry.seq !== null && entry.seq <= subscription.lastSeq) continue;
      if (entry.seq !== null) subscription.lastSeq = entry.seq;
      subscription.onEvent(entry.event, entry.path);
    }
  }

  private completeRun(
    run: BrokerRun,
    result: RealtimeQueryCompleted,
    source: NonNullable<BrokerRun["terminalSource"]>,
  ) {
    if (run.terminal) {
      this.diagnostics.duplicateTerminalCount += 1;
      return;
    }
    run.terminal = true;
    run.terminalReason = result.reason;
    run.terminalSource = source;
    run.suspended = false;
    this.revokeRunActionGrant(run.runId);
    if (run.upstreamRequestId) {
      this.terminalRequestIds.add(run.upstreamRequestId);
      if (this.terminalRequestIds.size > 2_000) {
        this.terminalRequestIds.delete(this.terminalRequestIds.values().next().value as string);
      }
      this.queriesByRequestId.delete(run.upstreamRequestId);
    }
    run.upstreamRequestId = null;
    const transaction = run.query;
    run.query = null;
    if (transaction) {
      if (transaction.signal && transaction.abortListener) {
        transaction.signal.removeEventListener("abort", transaction.abortListener);
      }
      void transaction.eventQueue.then(
        () => transaction.completed.resolve(result),
        (error) => transaction.completed.reject(error),
      );
    }
    for (const id of [...run.subscribers]) {
      const subscription = this.runSubscriptions.get(id);
      subscription?.onComplete?.(result);
      this.runSubscriptions.delete(id);
    }
    run.subscribers.clear();
    this.pruneRetainedTerminalRuns();
  }

  private failQuery(transaction: QueryTransaction, error: unknown) {
    this.queriesByRequestId.delete(transaction.upstreamRequestId);
    const run = transaction.runId ? this.getRunChannel(transaction.runId, transaction.lane) : null;
    if (run && !transaction.acceptedValue) this.deleteRunChannel(run);
    if (transaction.subscriptionId) this.unsubscribe(transaction.subscriptionId);
    if (run?.query === transaction) run.query = null;
    if (transaction.signal && transaction.abortListener) {
      transaction.signal.removeEventListener("abort", transaction.abortListener);
    }
    if (transaction.acceptanceTimer) {
      clearTimeout(transaction.acceptanceTimer);
      transaction.acceptanceTimer = null;
    }
    if (transaction.rootObserverToken && transaction.expectedRunId) {
      for (const pending of [...this.pendingClones.values()]) {
        if (
          pending.observerToken === transaction.rootObserverToken &&
          pending.runId === transaction.expectedRunId
        ) {
          pending.reject(cloneBindingError(
            "run_not_registered",
            "the parent query ended before its RunChannel was registered",
          ));
        }
      }
    }
    transaction.accepted.reject(error);
    transaction.completed.reject(error);
  }

  private async startAttach(run: BrokerRun, baseUrl: string, token: string) {
    if (run.upstreamRequestId || run.terminal) return;
    await this.ensureConnected(baseUrl, token, run.lane);
    if (run.upstreamRequestId || run.terminal) return;
    const id = `desktop-attach-${randomUUID()}`;
    run.upstreamRequestId = id;
    this.diagnostics.upstreamAttachCount += 1;
    this.clients[run.lane].send({
      frame: "request",
      type: "/api/attach",
      id,
      payload: {
        runId: run.runId,
        chatId: run.chatId,
        lastSeq: run.lastSeq,
        ...(run.owner?.kind === "agent"
          ? { agentKey: run.owner.agentKey }
          : run.owner?.kind === "team"
            ? { teamId: run.owner.teamId }
            : {}),
      },
    });
  }

  private async restoreRun(run: BrokerRun) {
    const state = this.clients[run.lane].getState();
    if (
      state.phase !== "connected" || run.terminal || run.restoreInFlight ||
      Boolean(run.upstreamRequestId)
    ) return;
    run.restoreInFlight = true;
    run.restoreCount += 1;
    const id = `desktop-attach-${randomUUID()}`;
    try {
      run.upstreamRequestId = id;
      this.diagnostics.upstreamAttachCount += 1;
      this.clients[run.lane].send({
        frame: "request",
        type: "/api/attach",
        id,
        payload: {
          runId: run.runId,
          chatId: run.chatId,
          lastSeq: run.lastSeq,
          ...(run.owner?.kind === "agent"
            ? { agentKey: run.owner.agentKey }
            : run.owner?.kind === "team"
              ? { teamId: run.owner.teamId }
              : {}),
        },
      });
      run.suspended = false;
      run.lastRestoreResult = `attached:${state.generation}:${run.lastSeq}`;
    } catch (error) {
      run.upstreamRequestId = null;
      run.suspended = true;
      run.lastRestoreResult = `failed:${error instanceof Error ? error.message : String(error)}`;
    } finally {
      run.restoreInFlight = false;
    }
  }

  private handlePush(frame: AgentPlatformRealtimeFrame) {
    const type = readText(frame.type);
    if (type === "desktop.bridge.cancel") {
      const requestId = readText(framePayload(frame).requestId);
      const controller = this.inboundDesktopRequests.get(requestId);
      controller?.abort();
      this.inboundDesktopRequests.delete(requestId);
      return;
    }
    if (!AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)) {
      this.diagnostics.unknownFrameCount += 1;
      return;
    }
    if (type === "connected" || type === "heartbeat" || type === "live.connected") return;
    const invalidTime = validateAgentPlatformPushTimeContract(type, framePayload(frame));
    if (invalidTime) {
      this.options.onDiagnostic?.(`time_contract_violation: push.${type}.${invalidTime}`);
      return;
    }
    if (type === "run.finished" || type === "run.complete") {
      const runId = pushIdentity(frame, "runId");
      this.revokeRunActionGrant(runId);
      const run = this.getRunChannel(runId);
      if (run && !run.terminal) {
        const payload = framePayload(frame);
        this.completeRun(run, {
          reason: readText(payload.finishReason) || readText(payload.status) || "finished",
          ...(typeof payload.lastSeq === "number" ? { lastSeq: payload.lastSeq } : {}),
        }, "push");
      }
    }
    for (const subscription of this.pushSubscriptions.values()) {
      if (!subscription.types.has(type)) continue;
      const filter = subscription.filter;
      if (filter?.chatId && pushIdentity(frame, "chatId") !== filter.chatId) continue;
      if (filter?.runId && pushIdentity(frame, "runId") !== filter.runId) continue;
      if (filter?.resourceId && pushIdentity(frame, "resourceId") !== filter.resourceId) continue;
      subscription.onPush(frame);
    }
  }

  private handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame) {
    const id = readText(frame.id);
    if (!id) return;
    const type = readText(frame.type);
    if (lane === "primary" && (getDesktopActionDefinition(type) || type === DESKTOP_CDP_REQUEST_TYPE)) {
      void this.handleDesktopBridgeRequest(id, type, frame);
      return;
    }
    const errorType = lane === "primary" ? "unsupported_in_current_view" : "unknown_request_type";
    try {
      this.clients[lane].send({
        frame: "error",
        type: errorType,
        id,
        code: 409,
        msg: lane === "primary"
          ? "Desktop cannot handle this request in the current view"
          : "Desktop BTW lane does not support inbound requests",
        data: {
          code: errorType,
          message: lane === "primary"
            ? "Inbound request is unsupported in the current view"
            : "Inbound request type is unknown",
        },
      });
    } catch {
      // The connection is already unavailable.
    }
  }

  private async handleDesktopBridgeRequest(
    id: string,
    type: string,
    frame: AgentPlatformRealtimeFrame,
  ) {
    if (this.inboundDesktopRequests.has(id) || this.seenInboundDesktopRequestIds.has(id)) {
      this.sendDesktopBridgeError(id, "duplicate_id", 409, "Desktop bridge request id was already used");
      return;
    }
    this.seenInboundDesktopRequestIds.add(id);
    if (this.seenInboundDesktopRequestIds.size > 2_000) {
      this.seenInboundDesktopRequestIds.delete(this.seenInboundDesktopRequestIds.values().next().value as string);
    }
    const provider = this.desktopBridgeProvider;
    if (!provider) {
      this.sendDesktopBridgeError(id, "desktop_provider_unavailable", 503, "Desktop bridge provider is unavailable");
      return;
    }
    if (!isRecord(frame.payload)) {
      this.sendDesktopBridgeError(id, "invalid_request", 400, "Desktop bridge payload must be an object");
      return;
    }
    const controller = new AbortController();
    this.inboundDesktopRequests.set(id, controller);
    try {
      const isDesktopAction = type !== DESKTOP_CDP_REQUEST_TYPE;
      let actionRequest: Record<string, unknown> | null = null;
      if (isDesktopAction) {
        const source = isRecord(frame.source) ? frame.source : {};
        const runId = readText(source.runId);
        const chatId = readText(source.chatId);
        const agentKey = readText(source.agentKey);
        const teamId = readText(source.teamId);
        if (!runId || !chatId || (agentKey && teamId)) {
          throw brokerError(
            "protocol_error",
            "Desktop Action source must include runId and chatId and at most one Run owner",
          );
        }
        await this.awaitRunActionReadiness(type, source, controller.signal);
        if (controller.signal.aborted) return;
        actionRequest = {
          requestId: id,
          action: type,
          args: frame.payload,
          source,
        };
      }
      const result = isDesktopAction
        ? await provider.action(actionRequest as Record<string, unknown>)
        : await provider.cdp(frame.payload);
      if (controller.signal.aborted) return;
      if (!isRecord(result)) {
        this.sendDesktopBridgeError(id, "invalid_desktop_response", 502, "Desktop bridge response must be an object");
        return;
      }
      if (result.ok !== true) {
        const error = isRecord(result.error) ? result.error : {};
        this.sendDesktopBridgeError(
          id,
          readText(error.code) || "desktop_request_failed",
          400,
          readText(error.message) || "Desktop rejected the request",
          result,
        );
        return;
      }
      await this.sendDesktopBridgeSuccess(id, type, result, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const errorCode = error instanceof Error ? error.name : "";
        if (errorCode === "source_chat_not_ready" || errorCode === "protocol_error") {
          const brokerFailure = error as Error & {
            retryable?: boolean;
            details?: Record<string, unknown>;
          };
          const failureData = {
            ...(typeof brokerFailure.retryable === "boolean"
              ? { retryable: brokerFailure.retryable }
              : {}),
            ...(brokerFailure.details ? { details: brokerFailure.details } : {}),
          };
          this.sendDesktopBridgeError(
            id,
            errorCode,
            409,
            error instanceof Error ? error.message : String(error),
            Object.keys(failureData).length > 0 ? failureData : undefined,
          );
          return;
        }
        this.sendDesktopBridgeError(
          id,
          "desktop_request_failed",
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      this.inboundDesktopRequests.delete(id);
    }
  }

  private async awaitRunActionReadiness(
    action: string,
    source: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    if (!action.startsWith("desktop.workpanel.")) return;
    const runId = readText(source.runId);
    const chatId = readText(source.chatId);
    if (!runId || !chatId) {
      throw brokerError("protocol_error", "WorkPanel source must include canonical Chat and Run identity");
    }
    const grant = this.runActionGrants.get(runId);
    if (!grant) {
      const run = this.getRunChannel(runId);
      if (!run || run.chatId !== chatId || run.terminal) {
        throw brokerError(
          "source_chat_not_ready",
          "WorkPanel source Run does not have a canonical Chat grant",
          {
            retryable: false,
            details: { recovery: "reattach_source_chat" },
          },
        );
      }
      if (!run.owner) {
        throw brokerError("protocol_error", "WorkPanel source Run owner is unavailable");
      }
      if (run.owner.kind !== "agent") {
        throw brokerError(
          "source_chat_not_ready",
          "WorkPanel is unavailable for a Team-owned Run",
          { retryable: false, details: { recovery: "unsupported_run_owner" } },
        );
      }
      if (readText(source.agentKey) !== run.owner.agentKey) {
        throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its Run owner");
      }
      return;
    }
    if (grant.chatId !== chatId) {
      throw brokerError("protocol_error", "WorkPanel source Chat conflicts with its canonical Run");
    }
    if (grant.owner.kind !== "agent") {
      throw brokerError(
        "source_chat_not_ready",
        "WorkPanel is unavailable for a Team-owned Run",
        { retryable: false, details: { recovery: "unsupported_run_owner" } },
      );
    }
    if (readText(source.agentKey) !== grant.owner.agentKey) {
      throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its canonical Run");
    }
    if (grant.state === "failed") {
      throw brokerError(
        "source_chat_not_ready",
        grant.failureMessage || "canonical Chat synchronization failed",
        { retryable: false, details: { recovery: "reattach_source_chat" } },
      );
    }
    await Promise.race([
      grant.ready,
      grant.superseded,
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ]).catch((error) => {
      const current = this.runActionGrants.get(runId);
      if (current && current.generation !== grant.generation) return;
      throw brokerError(
        "source_chat_not_ready",
        error instanceof Error ? error.message : String(error),
        { retryable: false, details: { recovery: "reattach_source_chat" } },
      );
    });
    if (signal.aborted) return;
    const current = this.runActionGrants.get(runId);
    if (!current) {
      throw brokerError(
        "source_chat_not_ready",
        "WorkPanel source Run grant ended before the action was dispatched",
        { retryable: false, details: { recovery: "run_finished" } },
      );
    }
    if (current.generation !== grant.generation) {
      await this.awaitRunActionReadiness(action, source, signal);
    }
  }

  private async sendDesktopBridgeSuccess(
    id: string,
    type: string,
    result: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const resultNode = isRecord(result.result) ? result.result : null;
    const screenshot = type === DESKTOP_CDP_REQUEST_TYPE &&
      readText(result.method) === "Page.captureScreenshot" &&
      resultNode && typeof resultNode.data === "string"
      ? resultNode.data.trim()
      : "";
    if (screenshot) {
      const paddingBytes = screenshot.endsWith("==") ? 2 : screenshot.endsWith("=") ? 1 : 0;
      const screenshotBytes = Math.floor((screenshot.length * 3) / 4) - paddingBytes;
      if (screenshotBytes > DESKTOP_MAX_RESPONSE_BYTES) {
        this.sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop screenshot exceeds 64 MiB");
        return;
      }
      const streamId = `desktop-bridge-${randomUUID()}`;
      let seq = 0;
      for (let offset = 0; offset < screenshot.length; offset += DESKTOP_SCREENSHOT_CHUNK_CHARS) {
        if (signal.aborted) return;
        seq += 1;
        this.sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE, screenshot.slice(offset, offset + DESKTOP_SCREENSHOT_CHUNK_CHARS));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (signal.aborted) return;
      this.clients.primary.send({
        frame: "response",
        type,
        id,
        code: 0,
        msg: "success",
        data: {
          ...result,
          result: {
            ...resultNode,
            data: {
              streamed: true,
              streamId,
              encoding: "base64",
              chunkCount: seq,
              totalBytes: screenshotBytes,
            },
          },
        },
      });
      return;
    }

    const serialized = Buffer.from(JSON.stringify(result), "utf8");
    if (serialized.byteLength > DESKTOP_MAX_RESPONSE_BYTES) {
      this.sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop response exceeds 64 MiB");
      return;
    }
    if (serialized.byteLength <= DESKTOP_STREAM_RAW_CHUNK_BYTES) {
      this.clients.primary.send({ frame: "response", type, id, code: 0, msg: "success", data: result });
      return;
    }
    const streamId = `desktop-bridge-${randomUUID()}`;
    let seq = 0;
    for (let offset = 0; offset < serialized.byteLength; offset += DESKTOP_STREAM_RAW_CHUNK_BYTES) {
      if (signal.aborted) return;
      seq += 1;
      const chunk = serialized.subarray(offset, Math.min(offset + DESKTOP_STREAM_RAW_CHUNK_BYTES, serialized.byteLength));
      this.sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_RESPONSE_DELTA_EVENT_TYPE, chunk.toString("base64"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal.aborted) return;
    this.clients.primary.send({
      frame: "response",
      type,
      id,
      code: 0,
      msg: "success",
      data: {
        streamed: true,
        streamId,
        encoding: "base64",
        contentType: "application/json",
        chunkCount: seq,
        totalBytes: serialized.byteLength,
      },
    });
  }

  private sendDesktopBridgeChunk(id: string, streamId: string, seq: number, type: string, chunk: string) {
    this.clients.primary.send({
      frame: "stream",
      id,
      streamId,
      event: {
        seq,
        type,
        timestamp: Date.now(),
        encoding: "base64",
        chunk,
      },
    });
  }

  private sendDesktopBridgeError(id: string, type: string, code: number, msg: string, data?: unknown) {
    try {
      this.clients.primary.send({
        frame: "error",
        type,
        id,
        code,
        msg,
        ...(data === undefined ? {} : { data }),
      });
    } catch {
      // The connection is already unavailable.
    }
  }

  private waitForCloneRun(
    observerToken: string,
    runIdValue: string,
    chatIdValue: string,
    owner: AgentWebclientRunOwner,
  ) {
    const runId = runIdValue.trim();
    const chatId = chatIdValue.trim();
    const run = this.getRunChannel(runId);
    if (
      run && run.chatId === chatId && run.rootObserverTokens.has(observerToken) &&
      (!run.owner || sameRunOwner(run.owner, owner))
    ) return Promise.resolve();
    const pendingQuery = [...this.queriesByRequestId.values()].some((transaction) =>
      transaction.rootObserverToken === observerToken &&
      transaction.runId === null &&
      transaction.expectedRunId === runId &&
      (!transaction.expectedChatId || transaction.expectedChatId === chatId)
    );
    if (!pendingQuery) {
      return Promise.reject(cloneBindingError(
        "run_not_registered",
        "requested Run is not registered for the active Main Chat observer",
      ));
    }
    return new Promise<void>((resolve, reject) => {
      const id = `pending-clone-${randomUUID()}`;
      const parentGeneration = this.activeRootObserver?.token === observerToken
        ? this.activeRootObserver.generation
        : "";
      this.pendingClones.set(id, {
        id,
        observerToken,
        parentGeneration,
        runId,
        chatId,
        owner,
        waitReason: "awaiting_run_start",
        resolve: () => {
          this.pendingClones.delete(id);
          resolve();
        },
        reject: (error) => {
          this.pendingClones.delete(id);
          const details = (error as Error & { details?: unknown }).details;
          const reason = isRecord(details) ? readText(details.reason) : "";
          this.lastCloneCancellationReason = reason || error.name || "clone_cancelled";
          reject(error);
        },
      });
    });
  }

  private notifyPendingClones(run: BrokerRun) {
    for (const pending of [...this.pendingClones.values()]) {
      if (pending.runId !== run.runId || pending.chatId !== run.chatId) continue;
      if (!run.rootObserverTokens.has(pending.observerToken)) continue;
      if (run.owner && !sameRunOwner(run.owner, pending.owner)) {
        pending.reject(cloneBindingError("visible_run_changed", "clone Run owner changed"));
        continue;
      }
      pending.resolve();
    }
  }

  private rejectPendingClones(observerToken: string, error: Error) {
    for (const pending of [...this.pendingClones.values()]) {
      if (pending.observerToken === observerToken) pending.reject(error);
    }
  }

  private pruneRetainedTerminalRuns() {
    const removable = [...this.runChannels.values()].filter((run) =>
      run.terminal &&
      run.rootObserverTokens.size === 0 &&
      run.subscribers.size === 0 &&
      !run.query &&
      !run.upstreamRequestId
    );
    while (removable.length > MAX_RETAINED_TERMINAL_RUNS) {
      const run = removable.shift();
      if (!run) break;
      this.deleteRunChannel(run);
    }
  }

  private hasSystemRunLease(run: BrokerRun) {
    return [...run.subscribers].some((id) =>
      this.runSubscriptions.get(id)?.role === "internal"
    );
  }

  private detachRunIfUnobserved(run: BrokerRun, reason: string) {
    if (
      run.terminal || run.rootObserverTokens.size > 0 || this.hasSystemRunLease(run) ||
      !run.upstreamRequestId || !run.baseUrl || !run.accessToken
    ) return Promise.resolve();
    if (run.detachInFlight) return run.detachInFlight;
    run.suspended = true;
    const operationGeneration = ++run.operationGeneration;
    const detach = new Promise<void>((resolve) => {
      void this.ensureConnected(run.baseUrl, run.accessToken, run.lane).then(() => {
        if (
          run.operationGeneration !== operationGeneration ||
          run.rootObserverTokens.size > 0 ||
          this.hasSystemRunLease(run)
        ) {
          run.suspended = false;
          resolve();
          return;
        }
        void this.forwardRequest({
          baseUrl: run.baseUrl,
          token: run.accessToken,
          lane: run.lane,
          localId: `observer-detach-${randomUUID()}`,
          consumerId: `realtime-broker:${run.lane}:${run.runId}:detach`,
          type: "/api/detach",
          payload: {
            runId: run.runId,
            ...(run.owner?.kind === "agent"
              ? { agentKey: run.owner.agentKey }
              : run.owner?.kind === "team"
                ? { teamId: run.owner.teamId }
                : {}),
            reason,
          },
          onFrame: (frame) => {
            const payload = framePayload(frame);
            const detachedRequestId = readText(payload.streamRequestId) ||
              (payload.accepted === false ? run.upstreamRequestId || "" : "");
            if (detachedRequestId) {
              this.releaseRunObserver(run, detachedRequestId, "detached", payload.lastSeq);
            }
            resolve();
          },
          onError: () => resolve(),
        }).catch(() => resolve());
        this.diagnostics.upstreamDetachCount += 1;
      }).catch(() => resolve());
    }).finally(() => {
      if (run.detachInFlight === detach) run.detachInFlight = null;
      if (
        (run.rootObserverTokens.size > 0 || this.hasSystemRunLease(run)) &&
        !run.terminal && !run.upstreamRequestId
      ) {
        void this.startAttach(run, run.baseUrl, run.accessToken);
      }
    });
    run.detachInFlight = detach;
    return detach;
  }

  private cleanupPending(upstreamId: string) {
    const pending = this.pendingRequests.get(upstreamId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingRequests.delete(upstreamId);
  }

  private prepareConnectionIdentity(baseUrl: string, token: string) {
    const reason = this.clients.primary.getRotationReason(baseUrl, token) ??
      this.clients.btw.getRotationReason(baseUrl, token);
    if (reason) {
      this.rotateIdentity(reason);
    }
  }
}
