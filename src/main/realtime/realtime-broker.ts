import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
} from "../../shared/contracts";
import { validateAgentPlatformPushTimeContract } from "../../shared/agent-platform-push-time-contract";
import { requireAgentPlatformEpochMillis } from "../../shared/time-contract";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
} from "./agent-platform-realtime-client";

const MAX_REPLAY_EVENTS = 2_000;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

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
  agentKey: string;
  lastSeq: number;
  terminal: boolean;
  suspended: boolean;
  upstreamRequestId: string | null;
  query: QueryTransaction | null;
  replay: ReplayEvent[];
  replayBytes: number;
  subscribers: Set<string>;
};

type QueryTransaction = {
  operationId: string;
  upstreamRequestId: string;
  runId: string;
  chatId: string;
  expectedAgentKey: string;
  accepted: Deferred<RealtimeQueryAccepted>;
  completed: Deferred<RealtimeQueryCompleted>;
  onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
  eventIndex: number;
  acceptedValue: RealtimeQueryAccepted | null;
  bufferedEvents: Array<{ event: Record<string, unknown>; path: string }>;
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

export type RealtimeQueryAccepted = { agentKey: string };
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

function brokerError(code: string, message: string) {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  return error;
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
  private visibleBinding: VisibleRunBinding | null = null;
  private disposed = false;
  private acceptingDelivery = true;
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
    });
  }

  getConnectionPhase(): AgentWebclientConnectionPhase {
    return this.connectionState.phase;
  }

  getConnectionState() {
    return this.client.getState();
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
    runId: string;
    chatId: string;
    agentKey?: string;
    signal?: AbortSignal;
    onEvent(event: Record<string, unknown>, path: string): Promise<void> | void;
  }): RealtimeQueryHandle {
    const accepted = createDeferred<RealtimeQueryAccepted>();
    const completed = createDeferred<RealtimeQueryCompleted>();
    const operationId = options.id.trim();
    const runId = options.runId.trim();
    const chatId = options.chatId.trim();
    if (!this.acceptingDelivery) {
      const error = brokerError("connection_unavailable", "Realtime Broker is shutting down");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    this.prepareConnectionIdentity(options.baseUrl, options.token);
    if (!operationId || !runId || !chatId) {
      const error = brokerError("invalid_request", "query id, runId and chatId are required");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (this.runsById.has(runId)) {
      const error = brokerError("duplicate_id", `runId ${runId} is already registered`);
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    const upstreamRequestId = `desktop-query-${randomUUID()}`;
    const transaction: QueryTransaction = {
      operationId,
      upstreamRequestId,
      runId,
      chatId,
      expectedAgentKey: options.agentKey?.trim() || "",
      accepted,
      completed,
      onEvent: options.onEvent,
      eventIndex: 0,
      acceptedValue: null,
      bufferedEvents: [],
      eventQueue: Promise.resolve(),
      acceptanceTimer: null,
      signal: options.signal,
    };
    const run: BrokerRun = {
      runId,
      chatId,
      agentKey: options.agentKey?.trim() || "",
      lastSeq: 0,
      terminal: false,
      suspended: false,
      upstreamRequestId,
      query: transaction,
      replay: [],
      replayBytes: 0,
      subscribers: new Set(),
    };
    this.runsById.set(runId, run);
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
        agentKey: options.agentKey?.trim() || "",
        lastSeq: Math.max(0, options.lastSeq ?? 0),
        terminal: false,
        suspended: false,
        upstreamRequestId: null,
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
    return true;
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
    if (!run || run.chatId !== input.chatId || run.upstreamRequestId !== input.upstreamRequestId) {
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
    this.client.rotateIdentity();
  }

  beginShutdown() {
    this.acceptingDelivery = false;
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
      const run = this.runsById.get(transaction.runId);
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
    const run = this.runsById.get(transaction.runId);
    if (!run) {
      this.failQuery(transaction, brokerError("protocol_error", "query Run registry entry is missing"));
      return;
    }
    if (isRecord(frame.event)) {
      try {
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
    this.completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    });
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
      const agentKey = readText(event.agentKey);
      if (!agentKey) throw brokerError("protocol_error", "run.start must include agentKey");
      if (transaction.expectedAgentKey && transaction.expectedAgentKey !== agentKey) {
        throw brokerError("protocol_error", "run.start agentKey conflicts with query owner");
      }
      transaction.acceptedValue = { agentKey };
      run.agentKey = agentKey;
      if (transaction.acceptanceTimer) {
        clearTimeout(transaction.acceptanceTimer);
        transaction.acceptanceTimer = null;
      }
      transaction.accepted.resolve({ agentKey });
    }
    this.appendReplay(run, event, seq);
    if (transaction?.acceptedValue) {
      const queued = transaction.bufferedEvents.splice(0);
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
      throw brokerError("seq_expired", "requested Run cursor is outside the local replay window");
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
    const run = this.runsById.get(transaction.runId);
    if (run && !transaction.acceptedValue) this.runsById.delete(transaction.runId);
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
        ...(run.agentKey ? { agentKey: run.agentKey } : {}),
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
        ...(run.agentKey ? { agentKey: run.agentKey } : {}),
      },
    });
  }

  private handlePush(frame: AgentPlatformRealtimeFrame) {
    const type = readText(frame.type);
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
