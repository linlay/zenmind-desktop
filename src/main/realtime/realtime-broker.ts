import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../shared/contracts";
import { validateAgentPlatformPushTimeContract } from "../../shared/agent-platform-push-time-contract";
import { requireAgentPlatformEpochMillis } from "../../shared/time-contract";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
} from "./agent-platform-realtime-client";
import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

const MAX_REPLAY_EVENTS = 2_000;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DESKTOP_ACTION_REQUEST_TYPE = "desktop.action.call";
const DESKTOP_CDP_REQUEST_TYPE = "desktop.cdp.call";
const DESKTOP_RESPONSE_DELTA_EVENT_TYPE = "desktop.bridge.response.delta";
const DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE = "desktop.cdp.screenshot.delta";
const DESKTOP_STREAM_RAW_CHUNK_BYTES = 192 * 1024;
const DESKTOP_SCREENSHOT_CHUNK_CHARS = 256 * 1024;
const DESKTOP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

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
};

type BrokerRun = {
  runId: string;
  chatId: string;
  owner: AgentWebclientRunOwner | null;
  lastSeq: number;
  terminal: boolean;
  suspended: boolean;
  upstreamRequestId: string | null;
  forwardedSourceId: string | null;
  query: QueryTransaction | null;
  replay: ReplayEvent[];
  replayBytes: number;
  subscribers: Set<string>;
};

type QueryTransaction = {
  operationId: string;
  upstreamRequestId: string;
  runId: string | null;
  chatId: string | null;
  expectedRunId: string;
  expectedChatId: string;
  expectedOwner: AgentWebclientRunOwner;
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
};

type PendingRequest = {
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
  id: string;
  runId: string;
  chatId: string;
  lastSeq: number;
  kind: "surface" | "internal";
  consumerId: string;
  surfaceId?: string;
  onEvent(event: Record<string, unknown>): void;
  onComplete?(result: RealtimeQueryCompleted): void;
  onError?(error: Error): void;
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
  consumerId: string;
  onState(state: AgentPlatformRealtimeConnectionState): void;
};

type ForwardedRunActionGrant = {
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

export type VisibleRunBinding = {
  epoch: number;
  chatId: string;
  runId: string;
  upstreamRequestId: string;
  primarySurfaceId: string;
  consumerSurfaceIds: Set<string>;
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

export class RealtimeBroker {
  private readonly client: AgentPlatformRealtimeClient;
  private connectionState: AgentPlatformRealtimeConnectionState;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly queriesByRequestId = new Map<string, QueryTransaction>();
  private readonly runsById = new Map<string, BrokerRun>();
  private readonly runSubscriptions = new Map<string, RunSubscription>();
  private readonly pushSubscriptions = new Map<string, PushSubscription>();
  private readonly connectionSubscriptions = new Map<string, ConnectionSubscription>();
  private readonly terminalRequestIds = new Set<string>();
  private readonly inboundDesktopRequests = new Map<string, AbortController>();
  private readonly seenInboundDesktopRequestIds = new Set<string>();
  private readonly forwardedRunActionGrants = new Map<string, ForwardedRunActionGrant>();
  private desktopBridgeProvider: DesktopBridgeRequestProvider | null = null;
  private visibleBinding: VisibleRunBinding | null = null;
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
    replayEvictionCount: 0,
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
    this.connectionState = {
      phase: "idle",
      generation: 0,
      physicalConnectionCount: 0,
      reconnectCount: 0,
      key: null,
    };
    this.client = new AgentPlatformRealtimeClient({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      createWebSocket: options.createWebSocket,
      connectTimeoutMs: options.connectTimeoutMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      onFrame: (frame, generation) => this.handleFrame(frame, generation),
      onStaleFrame: () => {
        this.diagnostics.staleFrameCount += 1;
      },
      onState: (state) => this.handleConnectionState(state),
      onDiagnostic: options.onDiagnostic,
      onTrace: (direction, frame) => this.debugTrace.append({
        layer: "platform-ws",
        direction: direction === "in" ? "platform-to-desktop" : "desktop-to-platform",
        data: frame,
      }),
    });
  }

  getConnectionPhase(): AgentWebclientConnectionPhase {
    return this.connectionState.phase;
  }

  getConnectionState() {
    return this.client.getState();
  }

  setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null) {
    this.desktopBridgeProvider = provider;
  }

  async ensureConnected(baseUrl: string, token: string) {
    if (this.disposed || !this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is disposed");
    }
    this.prepareConnectionIdentity(baseUrl, token);
    await this.client.ensureConnected(baseUrl, token);
  }

  query(options: {
    baseUrl: string;
    token: string;
    id: string;
    payload: Record<string, unknown>;
    runId?: string;
    chatId?: string;
    owner: AgentWebclientRunOwner;
    signal?: AbortSignal;
    onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
  }): RealtimeQueryHandle {
    const accepted = createDeferred<RealtimeQueryAccepted>();
    const completed = createDeferred<RealtimeQueryCompleted>();
    const operationId = options.id.trim();
    const expectedRunId = options.runId?.trim() || "";
    const expectedChatId = options.chatId?.trim() || "";
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
      operationId,
      upstreamRequestId,
      runId: null,
      chatId: null,
      expectedRunId,
      expectedChatId,
      expectedOwner: options.owner,
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
    };
    this.queriesByRequestId.set(upstreamRequestId, transaction);
    transaction.acceptanceTimer = unrefTimer(setTimeout(() => {
      this.failQuery(
        transaction,
        brokerError("connection_unavailable", "query acceptance timed out"),
      );
    }, this.options.acceptanceTimeoutMs ?? REQUEST_TIMEOUT_MS));
    if (options.signal) {
      transaction.abortListener = () => {
        this.failQuery(transaction, brokerError("connection_unavailable", "query aborted"));
      };
      options.signal.addEventListener("abort", transaction.abortListener, { once: true });
    }
    void this.ensureConnected(options.baseUrl, options.token)
      .then(() => {
        if (options.signal?.aborted) {
          throw brokerError("connection_unavailable", "query aborted");
        }
        this.client.send({
          frame: "request",
          type: "/api/query",
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
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    const localId = options.localId.trim();
    const type = options.type.trim();
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
      await this.ensureConnected(options.baseUrl, options.token);
      this.client.send({
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
  }) {
    const id = `connection-sub-${randomUUID()}`;
    this.connectionSubscriptions.set(id, { id, ...options });
    options.onState(this.client.getState());
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
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    const runId = options.runId.trim();
    const chatId = options.chatId.trim();
    if (!runId || !chatId) {
      throw brokerError("invalid_request", "runId and chatId are required");
    }
    const id = `run-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
      id,
      runId,
      chatId,
      lastSeq: Math.max(0, options.lastSeq ?? 0),
      kind: options.kind,
      consumerId: options.consumerId,
      onEvent: options.onEvent,
      onComplete: options.onComplete,
      onError: options.onError,
    };
    let run = this.runsById.get(runId);
    if (!run) {
      run = {
        runId,
        chatId,
        owner: options.owner ?? (options.agentKey?.trim()
          ? { kind: "agent", agentKey: options.agentKey.trim() }
          : null),
        lastSeq: Math.max(0, options.lastSeq ?? 0),
        terminal: false,
        suspended: false,
        upstreamRequestId: null,
        forwardedSourceId: null,
        query: null,
        replay: [],
        replayBytes: 0,
        subscribers: new Set(),
      };
      this.runsById.set(runId, run);
    } else if (run.chatId !== chatId) {
      throw brokerError("invalid_request", "runId belongs to a different chat");
    }
    this.replayToSubscriber(run, subscription);
    this.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    const ready = !run.terminal && !run.upstreamRequestId
      ? this.startAttach(run, options.baseUrl, options.token).catch((error) => {
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
    this.runsById.get(runSubscription.runId)?.subscribers.delete(subscriptionId);
    if (runSubscription.surfaceId && this.visibleBinding) {
      const stillSubscribed = [...this.runSubscriptions.values()].some((candidate) =>
        candidate.surfaceId === runSubscription.surfaceId &&
        candidate.runId === this.visibleBinding?.runId
      );
      if (!stillSubscribed) this.visibleBinding.consumerSurfaceIds.delete(runSubscription.surfaceId);
    }
    return true;
  }

  beginForwardedVisibleRun(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    lastSeq?: number;
    primarySurfaceId: string;
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    const sourceId = input.sourceId.trim();
    const chatId = input.chatId.trim();
    const runId = input.runId.trim();
    const primarySurfaceId = input.primarySurfaceId.trim();
    if (!sourceId || !chatId || !runId || !primarySurfaceId) {
      throw brokerError("invalid_request", "forwarded visible Run identity is incomplete");
    }
    let run = this.runsById.get(runId);
    if (!run) {
      run = {
        runId,
        chatId,
        owner: input.owner,
        lastSeq: Math.max(0, input.lastSeq ?? 0),
        terminal: false,
        suspended: false,
        upstreamRequestId: null,
        forwardedSourceId: sourceId,
        query: null,
        replay: [],
        replayBytes: 0,
        subscribers: new Set(),
      };
      this.runsById.set(runId, run);
    } else {
      if (run.chatId !== chatId) {
        throw brokerError("invalid_request", "runId belongs to a different chat");
      }
      if (run.forwardedSourceId && run.forwardedSourceId !== sourceId) {
        throw brokerError("duplicate_id", "visible Run is already owned by another forwarded source");
      }
      if (run.terminal) {
        throw brokerError("target_unavailable", "completed Run cannot become visible again");
      }
      run.forwardedSourceId = sourceId;
      run.owner = input.owner;
    }
    this.visibleBinding = {
      epoch: (this.visibleBinding?.epoch ?? 0) + 1,
      chatId,
      runId,
      upstreamRequestId: sourceId,
      primarySurfaceId,
      consumerSurfaceIds: new Set([primarySurfaceId]),
    };
    return this.getVisibleBinding();
  }

  registerForwardedRunActionGrant(input: {
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
      throw brokerError("invalid_request", "forwarded Run WorkPanel grant identity is incomplete");
    }
    const existing = this.forwardedRunActionGrants.get(runId);
    if (existing && (
      existing.chatId !== chatId ||
      !sameRunOwner(existing.owner, input.owner)
    )) {
      throw brokerError("duplicate_id", "forwarded Run WorkPanel grant identity conflicts");
    }
    if (existing && input.replaceExisting === false) return;
    const generation = (existing?.generation ?? 0) + 1;
    let supersede: () => void = () => undefined;
    const superseded = new Promise<void>((resolve) => {
      supersede = resolve;
    });
    const grant: ForwardedRunActionGrant = {
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
        const current = this.forwardedRunActionGrants.get(runId);
        if (current !== grant || current.generation !== generation) return;
        current.state = "ready";
        current.failureMessage = "";
      },
      (error) => {
        const current = this.forwardedRunActionGrants.get(runId);
        if (current === grant && current.generation === generation) {
          current.state = "failed";
          current.failureMessage = error instanceof Error ? error.message : String(error);
        }
        throw error;
      },
    );
    void grant.ready.catch(() => undefined);
    existing?.supersede();
    this.forwardedRunActionGrants.set(runId, grant);
    while (this.forwardedRunActionGrants.size > 2_000) {
      const oldest = this.forwardedRunActionGrants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.revokeForwardedRunActionGrant(oldest);
    }
  }

  revokeForwardedRunActionGrant(runIdValue: string) {
    const runId = runIdValue.trim();
    if (!runId) return false;
    const grant = this.forwardedRunActionGrants.get(runId);
    if (!grant) return false;
    this.forwardedRunActionGrants.delete(runId);
    grant.supersede();
    return true;
  }

  private clearForwardedRunActionGrants() {
    for (const grant of this.forwardedRunActionGrants.values()) grant.supersede();
    this.forwardedRunActionGrants.clear();
  }

  appendForwardedVisibleRunEvent(input: {
    sourceId: string;
    runId: string;
    event: Record<string, unknown>;
  }) {
    const sourceId = input.sourceId.trim();
    const run = this.runsById.get(input.runId.trim());
    if (!run || run.forwardedSourceId !== sourceId || run.terminal) {
      throw brokerError("target_unavailable", "forwarded visible Run source is unavailable");
    }
    this.consumeRunEvent(run, input.event, null);
  }

  completeForwardedVisibleRun(input: {
    sourceId: string;
    runId: string;
    reason: string;
    lastSeq?: number;
  }) {
    const sourceId = input.sourceId.trim();
    const run = this.runsById.get(input.runId.trim());
    if (!run || run.forwardedSourceId !== sourceId) return false;
    run.forwardedSourceId = null;
    const result = {
      reason: input.reason.trim() || "done",
      ...(input.lastSeq === undefined ? {} : { lastSeq: input.lastSeq }),
    };
    if (run.upstreamRequestId) {
      for (const id of [...run.subscribers]) {
        const subscription = this.runSubscriptions.get(id);
        if (!subscription?.surfaceId) continue;
        this.unsubscribe(id);
        subscription.onComplete?.(result);
      }
    } else {
      this.completeRun(run, result);
    }
    if (this.visibleBinding?.upstreamRequestId === sourceId) this.visibleBinding = null;
    this.revokeForwardedRunActionGrant(run.runId);
    return true;
  }

  releaseForwardedVisibleRun(sourceIdValue: string) {
    const sourceId = sourceIdValue.trim();
    if (!sourceId) return false;
    const run = [...this.runsById.values()].find((candidate) =>
      candidate.forwardedSourceId === sourceId,
    );
    if (!run) return false;
    run.forwardedSourceId = null;
    if (this.visibleBinding?.upstreamRequestId === sourceId) this.visibleBinding = null;
    const error = brokerError("replay_required", "primary visible Run source was released");
    for (const id of [...run.subscribers]) {
      const subscription = this.runSubscriptions.get(id);
      if (!subscription?.surfaceId) continue;
      this.unsubscribe(id);
      subscription.onError?.(error);
    }
    return true;
  }

  subscribeVisibleRun(options: {
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner?: AgentWebclientRunOwner;
    kind: "surface" | "internal";
    consumerId: string;
    surfaceId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }) {
    if (!this.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    const runId = options.runId.trim();
    const chatId = options.chatId.trim();
    const surfaceId = options.surfaceId.trim();
    const binding = this.visibleBinding;
    const run = this.runsById.get(runId);
    if (
      !runId || !chatId || !surfaceId ||
      !binding || binding.runId !== runId || binding.chatId !== chatId ||
      !run || run.chatId !== chatId || run.forwardedSourceId !== binding.upstreamRequestId
    ) {
      throw brokerError("target_unavailable", "requested Run is not the primary visible Run");
    }
    if (options.owner && run.owner && (
      options.owner.kind !== run.owner.kind ||
      (options.owner.kind === "agent" && run.owner.kind === "agent" && options.owner.agentKey !== run.owner.agentKey) ||
      (options.owner.kind === "team" && run.owner.kind === "team" && options.owner.teamId !== run.owner.teamId)
    )) {
      throw brokerError("capability_denied", "requested Run owner does not match the visible Run");
    }
    const id = `visible-run-sub-${randomUUID()}`;
    const subscription: RunSubscription = {
      id,
      runId,
      chatId,
      lastSeq: Math.max(0, options.lastSeq ?? 0),
      kind: options.kind,
      consumerId: options.consumerId,
      surfaceId,
      onEvent: options.onEvent,
      onComplete: options.onComplete,
      onError: options.onError,
    };
    this.replayToSubscriber(run, subscription);
    this.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    binding.consumerSurfaceIds.add(surfaceId);
    return {
      subscriptionId: id,
      unsubscribe: () => this.unsubscribe(id),
      ready: Promise.resolve(),
    };
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

  setVisibleBinding(input: Omit<VisibleRunBinding, "epoch">) {
    const run = this.runsById.get(input.runId);
    if (
      !run ||
      run.chatId !== input.chatId ||
      (run.upstreamRequestId !== input.upstreamRequestId && run.forwardedSourceId !== input.upstreamRequestId)
    ) {
      throw brokerError("target_unavailable", "visible Run identity is not registered");
    }
    this.visibleBinding = {
      ...input,
      consumerSurfaceIds: new Set(input.consumerSurfaceIds),
      epoch: (this.visibleBinding?.epoch ?? 0) + 1,
    };
    return this.getVisibleBinding();
  }

  bindVisibleRun(input: {
    chatId: string;
    runId: string;
    primarySurfaceId: string;
    consumerSurfaceIds?: Iterable<string>;
  }) {
    const run = this.runsById.get(input.runId);
    if (!run || run.chatId !== input.chatId || !run.upstreamRequestId) {
      throw brokerError("target_unavailable", "visible Run identity is not registered");
    }
    return this.setVisibleBinding({
      chatId: input.chatId,
      runId: input.runId,
      upstreamRequestId: run.upstreamRequestId,
      primarySurfaceId: input.primarySurfaceId,
      consumerSurfaceIds: new Set(input.consumerSurfaceIds ?? [input.primarySurfaceId]),
    });
  }

  clearVisibleBinding(primarySurfaceId?: string) {
    if (primarySurfaceId && this.visibleBinding?.primarySurfaceId !== primarySurfaceId) {
      return false;
    }
    this.visibleBinding = null;
    return true;
  }

  getVisibleBinding() {
    return this.visibleBinding
      ? {
          ...this.visibleBinding,
          consumerSurfaceIds: new Set(this.visibleBinding.consumerSurfaceIds),
        }
      : null;
  }

  getDiagnostics() {
    return {
      connection: this.client.getState(),
      pendingRequestCount: this.pendingRequests.size,
      activeStreamCount: [...this.runsById.values()].filter((run) =>
        Boolean(run.upstreamRequestId && !run.terminal),
      ).length,
      runCount: this.runsById.size,
      localRunSubscriberCount: this.runSubscriptions.size,
      pushSubscriberCount: this.pushSubscriptions.size,
      connectionSubscriberCount: this.connectionSubscriptions.size,
      visibleBinding: this.visibleBinding
        ? {
            epoch: this.visibleBinding.epoch,
            consumerCount: this.visibleBinding.consumerSurfaceIds.size,
          }
        : null,
      replay: [...this.runsById.values()].map((run) => ({
        runId: run.runId,
        eventCount: run.replay.length,
        bytes: run.replayBytes,
        lastSeq: run.lastSeq,
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

  rotateIdentity() {
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
    this.runsById.clear();
    this.visibleBinding = null;
    this.terminalRequestIds.clear();
    this.clearForwardedRunActionGrants();
    this.client.rotateIdentity();
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
    this.runsById.clear();
    this.visibleBinding = null;
    this.terminalRequestIds.clear();
    this.clearForwardedRunActionGrants();
    for (const controller of this.inboundDesktopRequests.values()) controller.abort();
    this.inboundDesktopRequests.clear();
    this.seenInboundDesktopRequestIds.clear();
    this.desktopBridgeProvider = null;
    this.client.dispose();
  }

  private handleConnectionState(state: AgentPlatformRealtimeConnectionState) {
    const previous = this.connectionState.phase;
    this.connectionState = state;
    this.options.onConnectionState?.(state);
    for (const subscription of this.connectionSubscriptions.values()) {
      subscription.onState({ ...state, key: state.key ? { ...state.key } : null });
    }
    if (state.phase === "connected" && previous !== "connected") {
      for (const run of this.runsById.values()) {
        if (run.suspended && !run.terminal) {
          run.suspended = false;
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
    for (const pending of [...this.pendingRequests.values()]) {
      this.cleanupPending(pending.upstreamId);
      pending.onError(disconnectError);
    }
    for (const transaction of [...this.queriesByRequestId.values()]) {
      if (!transaction.acceptedValue) {
        this.failQuery(transaction, disconnectError);
        continue;
      }
      const run = transaction.runId ? this.runsById.get(transaction.runId) : null;
      if (run) {
        run.suspended = true;
        run.upstreamRequestId = null;
      }
      this.queriesByRequestId.delete(transaction.upstreamRequestId);
    }
  }

  private handleFrame(frame: AgentPlatformRealtimeFrame, generation: number) {
    if (!this.acceptingDelivery) return;
    if (generation !== this.connectionState.generation) {
      this.diagnostics.staleFrameCount += 1;
      return;
    }
    const kind = readText(frame.frame);
    if (kind === "push") {
      this.handlePush(frame);
      return;
    }
    if (kind === "request") {
      this.handleInboundRequest(frame);
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
      if (kind === "error") this.failQuery(query, frameError(frame));
      else if (kind === "stream") this.handleQueryStream(query, frame);
      return;
    }
    const run = [...this.runsById.values()].find((candidate) =>
      candidate.upstreamRequestId === id,
    );
    if (run && kind === "stream") {
      this.handleRunStream(run, frame);
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (pending) {
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
    let run = transaction.runId ? this.runsById.get(transaction.runId) : null;
    if (isRecord(frame.event)) {
      try {
        if (!run && readText(frame.event.type) !== "run.start") {
          this.bufferProvisionalQueryEvent(transaction, frame.event);
          return;
        }
        if (!run) {
          run = this.registerProvisionalRun(transaction, frame.event);
          this.commitProvisionalQueryEvents(run, transaction);
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
    this.completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    });
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
    for (const { event } of transaction.bufferedEvents) {
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
      this.appendReplay(run, event, seq);
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
      throw brokerError("protocol_error", "run.start runId conflicts with query runId");
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
    if (
      owner.kind !== expectedOwner.kind ||
      (owner.kind === "agent" && expectedOwner.kind === "agent" && owner.agentKey !== expectedOwner.agentKey) ||
      (owner.kind === "team" && expectedOwner.kind === "team" && owner.teamId !== expectedOwner.teamId)
    ) {
      throw brokerError("protocol_error", "run.start owner conflicts with query owner");
    }
    if (this.runsById.has(runId)) {
      throw brokerError("duplicate_id", `runId ${runId} is already registered`);
    }
    const run: BrokerRun = {
      runId,
      chatId,
      owner,
      lastSeq: 0,
      terminal: false,
      suspended: false,
      upstreamRequestId: transaction.upstreamRequestId,
      forwardedSourceId: null,
      query: transaction,
      replay: [],
      replayBytes: 0,
      subscribers: new Set(),
    };
    transaction.runId = runId;
    transaction.chatId = chatId;
    this.runsById.set(runId, run);
    return run;
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
    if (reason) {
      this.completeRun(run, {
        reason,
        ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
      });
    }
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
        this.appendReplay(run, event, seq);
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
    this.appendReplay(run, event, seq);
    if (transaction?.acceptedValue) {
      const queued = transaction.bufferedEvents.splice(0);
      transaction.bufferedEventBytes = 0;
      queued.push({ event, path });
      for (const item of queued) {
        transaction.eventQueue = transaction.eventQueue.then(() =>
          transaction.onEvent(item.event, item.path),
        );
      }
      void transaction.eventQueue.catch((error) => this.failQuery(transaction, error));
    }
    for (const id of run.subscribers) {
      const subscription = this.runSubscriptions.get(id);
      if (!subscription || (seq !== null && seq <= subscription.lastSeq)) continue;
      if (seq !== null) subscription.lastSeq = seq;
      subscription.onEvent(event);
    }
  }

  private appendReplay(run: BrokerRun, event: Record<string, unknown>, seq: number | null) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    run.replay.push({ event, bytes, seq });
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
      subscription.onEvent(entry.event);
    }
  }

  private completeRun(run: BrokerRun, result: RealtimeQueryCompleted) {
    if (run.terminal) {
      this.diagnostics.duplicateTerminalCount += 1;
      return;
    }
    run.terminal = true;
    run.suspended = false;
    this.revokeForwardedRunActionGrant(run.runId);
    if (run.upstreamRequestId) {
      this.terminalRequestIds.add(run.upstreamRequestId);
      if (this.terminalRequestIds.size > 2_000) {
        this.terminalRequestIds.delete(this.terminalRequestIds.values().next().value as string);
      }
      this.queriesByRequestId.delete(run.upstreamRequestId);
    }
    run.upstreamRequestId = null;
    if (run.query) {
      void run.query.eventQueue.then(
        () => run.query?.completed.resolve(result),
        (error) => run.query?.completed.reject(error),
      );
    }
    for (const id of run.subscribers) this.runSubscriptions.get(id)?.onComplete?.(result);
  }

  private failQuery(transaction: QueryTransaction, error: unknown) {
    this.queriesByRequestId.delete(transaction.upstreamRequestId);
    const run = transaction.runId ? this.runsById.get(transaction.runId) : null;
    if (run && !transaction.acceptedValue) this.runsById.delete(run.runId);
    if (transaction.signal && transaction.abortListener) {
      transaction.signal.removeEventListener("abort", transaction.abortListener);
    }
    if (transaction.acceptanceTimer) {
      clearTimeout(transaction.acceptanceTimer);
      transaction.acceptanceTimer = null;
    }
    transaction.accepted.reject(error);
    transaction.completed.reject(error);
  }

  private async startAttach(run: BrokerRun, baseUrl: string, token: string) {
    if (run.upstreamRequestId || run.terminal) return;
    await this.ensureConnected(baseUrl, token);
    if (run.upstreamRequestId || run.terminal) return;
    const id = `desktop-attach-${randomUUID()}`;
    run.upstreamRequestId = id;
    this.client.send({
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
    const state = this.client.getState();
    if (state.phase !== "connected") return;
    const id = `desktop-attach-${randomUUID()}`;
    run.upstreamRequestId = id;
    this.client.send({
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
      this.revokeForwardedRunActionGrant(runId);
      const run = this.runsById.get(runId);
      if (run && !run.terminal && run.query === null) {
        const payload = framePayload(frame);
        this.completeRun(run, {
          reason: readText(payload.finishReason) || readText(payload.status) || "finished",
          ...(typeof payload.lastSeq === "number" ? { lastSeq: payload.lastSeq } : {}),
        });
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

  private handleInboundRequest(frame: AgentPlatformRealtimeFrame) {
    const id = readText(frame.id);
    if (!id) return;
    const type = readText(frame.type);
    if (type === DESKTOP_ACTION_REQUEST_TYPE || type === DESKTOP_CDP_REQUEST_TYPE) {
      void this.handleDesktopBridgeRequest(id, type, frame);
      return;
    }
    const errorType = type.startsWith("webclient.")
      ? this.visibleBinding
        ? "unsupported_in_current_view"
        : "target_unavailable"
      : "unsupported_in_current_view";
    try {
      this.client.send({
        frame: "error",
        type: errorType,
        id,
        code: 409,
        msg: "Desktop could not prove a unique capable inbound request target",
        data: { code: errorType, message: "Inbound request target is unavailable" },
      });
    } catch {
      // The connection is already unavailable.
    }
  }

  private async handleDesktopBridgeRequest(
    id: string,
    type: typeof DESKTOP_ACTION_REQUEST_TYPE | typeof DESKTOP_CDP_REQUEST_TYPE,
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
      if (type === DESKTOP_ACTION_REQUEST_TYPE) {
        await this.awaitForwardedWorkPanelReadiness(frame.payload, controller.signal);
        if (controller.signal.aborted) return;
      }
      const result = type === DESKTOP_ACTION_REQUEST_TYPE
        ? await provider.action(frame.payload)
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

  private async awaitForwardedWorkPanelReadiness(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const action = readText(payload.action);
    if (!action.startsWith("desktop.workpanel.")) return;
    const source = isRecord(payload.source) ? payload.source : {};
    const runId = readText(source.runId);
    const chatId = readText(source.chatId);
    if (!runId || !chatId) {
      throw brokerError("protocol_error", "WorkPanel source must include canonical Chat and Run identity");
    }
    const grant = this.forwardedRunActionGrants.get(runId);
    if (!grant) {
      const run = this.runsById.get(runId);
      if (!run || run.chatId !== chatId || run.forwardedSourceId || run.terminal) {
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
      throw brokerError("protocol_error", "WorkPanel source Chat conflicts with its forwarded Run");
    }
    if (grant.owner.kind !== "agent") {
      throw brokerError(
        "source_chat_not_ready",
        "WorkPanel is unavailable for a Team-owned Run",
        { retryable: false, details: { recovery: "unsupported_run_owner" } },
      );
    }
    if (readText(source.agentKey) !== grant.owner.agentKey) {
      throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its forwarded Run");
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
      const current = this.forwardedRunActionGrants.get(runId);
      if (current && current.generation !== grant.generation) return;
      throw brokerError(
        "source_chat_not_ready",
        error instanceof Error ? error.message : String(error),
        { retryable: false, details: { recovery: "reattach_source_chat" } },
      );
    });
    if (signal.aborted) return;
    const current = this.forwardedRunActionGrants.get(runId);
    if (!current) {
      throw brokerError(
        "source_chat_not_ready",
        "WorkPanel source Run grant ended before the action was dispatched",
        { retryable: false, details: { recovery: "run_finished" } },
      );
    }
    if (current.generation !== grant.generation) {
      await this.awaitForwardedWorkPanelReadiness(payload, signal);
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
      this.client.send({
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
      this.client.send({ frame: "response", type, id, code: 0, msg: "success", data: result });
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
    this.client.send({
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
    this.client.send({
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
      this.client.send({
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

  private cleanupPending(upstreamId: string) {
    const pending = this.pendingRequests.get(upstreamId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingRequests.delete(upstreamId);
  }

  private prepareConnectionIdentity(baseUrl: string, token: string) {
    if (this.client.requiresRotation(baseUrl, token)) {
      this.rotateIdentity();
    }
  }
}
