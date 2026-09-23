import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";
import { type AgentWebclientConnectionPhase } from "../../../../shared/contracts";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";
import {
  BrokerRun,
  ConnectionSubscription,
  DesktopBridgeRequestProvider,
  PendingClone,
  PendingRequest,
  PushSubscription,
  QueryTransaction,
  REQUEST_TIMEOUT_MS,
  RealtimeConnectionStates,
  RealtimeLane,
  RealtimeQueryCompleted,
  RootObserverState,
  RunSubscription,
  brokerError,
  frameError,
  readText,
  unrefTimer,
} from "./realtime-broker.shared";

/** Dependencies limited to connection; state remains owned by the Broker. */
export interface ConnectionPort {
  connectionStates: Record<RealtimeLane, AgentPlatformRealtimeConnectionState>;
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  disposed: boolean;
  acceptingDelivery: boolean;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  pendingRequests: Map<string, PendingRequest>;
  readonly options: { onDiagnostic?(message: string): void; onConnectionState?(state: AgentPlatformRealtimeConnectionState): void; };
  diagnostics: BrokerDiagnosticsCounters;
  runChannels: Map<string, BrokerRun>;
  queriesByRequestId: Map<string, QueryTransaction>;
  failQuery(transaction: QueryTransaction, error: unknown): void;
  runSubscriptions: Map<string, RunSubscription>;
  pendingClones: Map<string, PendingClone>;
  activeRootObserver: RootObserverState | null;
  mainChatRootObserver: RootObserverState | null;
  auxiliaryRootObservers: Map<string, RootObserverState>;
  terminalRequestIds: Set<string>;
  clearRunActionGrants(): void;
  inboundDesktopRequests: Map<string, AbortController>;
  seenInboundDesktopRequestIds: Set<string>;
  pushSubscriptions: Map<string, PushSubscription>;
  connectionSubscriptions: Map<string, ConnectionSubscription>;
  desktopBridgeProvider: DesktopBridgeRequestProvider | null;
  hasSystemRunLease(run: BrokerRun): boolean;
  restoreRun(run: BrokerRun): Promise<void>;
  handlePush(frame: AgentPlatformRealtimeFrame): void;
  handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame): void;
  handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame): void;
  handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame): void;
  completeRun(run: BrokerRun, result: RealtimeQueryCompleted, source: NonNullable<BrokerRun["terminalSource"]>): void;
}

export function createConnection(deps: ConnectionPort) {
  function getConnectionPhase(): AgentWebclientConnectionPhase {
    return deps.connectionStates.primary.phase;
  }

  function getConnectionState(lane: RealtimeLane = "primary") {
    return deps.clients[lane].getState();
  }

  function getConnectionStates(): RealtimeConnectionStates {
    return {
      primary: deps.clients.primary.getState(),
      btw: deps.clients.btw.getState(),
      "selection-explain": deps.clients["selection-explain"].getState(),
    };
  }

  async function ensureConnected(baseUrl: string, token: string, lane: RealtimeLane = "primary"): Promise<void> {
    if (deps.disposed || !deps.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is disposed");
    }
    prepareConnectionIdentity(baseUrl, token);
    await deps.clients[lane].ensureConnected(baseUrl, token);
  }

  async function forwardRequest(options: {
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
  }): Promise<string> {
    if (!deps.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    prepareConnectionIdentity(options.baseUrl, options.token);
    const localId = options.localId.trim();
    const type = options.type.trim();
    const payloadRunId = readText(options.payload?.runId);
    const registeredLane = payloadRunId ? deps.getRunChannel(payloadRunId)?.lane : undefined;
    const lane = options.lane ?? registeredLane ?? (type === "/api/btw" ? "btw" : "primary");
    if (options.lane && registeredLane && options.lane !== registeredLane) {
      throw brokerError("invalid_request", "runId belongs to a different Realtime lane");
    }
    if (lane === "selection-explain" && type === "/api/query") {
      throw brokerError("invalid_request", "The selection explanation lane does not accept ordinary queries");
    }
    if (!localId || !type) {
      throw brokerError("invalid_request", "request id and type are required");
    }
    const upstreamId = `desktop-forward-${randomUUID()}`;
    const timer = options.stream
      ? null
      : unrefTimer(setTimeout(() => {
        const pending = deps.pendingRequests.get(upstreamId);
        if (!pending)
          return;
        deps.pendingRequests.delete(upstreamId);
        pending.onError(brokerError("connection_unavailable", `${type} timed out`));
      }, REQUEST_TIMEOUT_MS));
    deps.pendingRequests.set(upstreamId, {
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
      await ensureConnected(options.baseUrl, options.token, lane);
      deps.clients[lane].send({
        frame: "request",
        type: type === "/api/btw" ? "/api/query" : type,
        id: upstreamId,
        payload: options.payload ?? {},
      });
    }
    catch (error) {
      cleanupPending(upstreamId);
      throw error;
    }
    return upstreamId;
  }

  function rotateIdentity(reason: RealtimeIdentityRotationReason = "explicit_identity_invalidation"): void {
    deps.options.onDiagnostic?.(`realtime_identity_rotation:${reason}`);
    deps.diagnostics.laneRotationCount += Object.keys(deps.clients).length;
    const error = brokerError("connection_unavailable", "realtime identity was invalidated");
    // Revoke channels before notifying their former consumers. Unsubscribing
    // those consumers must not schedule a detach using the old identity.
    deps.runChannels.clear();
    for (const pending of [...deps.pendingRequests.values()]) {
      cleanupPending(pending.upstreamId);
      pending.onError(error);
    }
    for (const transaction of [...deps.queriesByRequestId.values()]) {
      deps.failQuery(transaction, error);
    }
    for (const subscription of deps.runSubscriptions.values()) {
      subscription.onError?.(error);
    }
    deps.queriesByRequestId.clear();
    deps.runSubscriptions.clear();
    for (const pending of [...deps.pendingClones.values()])
      pending.reject(error);
    deps.pendingClones.clear();
    deps.activeRootObserver = null;
    deps.mainChatRootObserver = null;
    deps.auxiliaryRootObservers.clear();
    deps.terminalRequestIds.clear();
    deps.clearRunActionGrants();
    for (const client of Object.values(deps.clients)) client.rotateIdentity();
  }

  function beginShutdown(): void {
    deps.acceptingDelivery = false;
    for (const controller of deps.inboundDesktopRequests.values())
      controller.abort();
    deps.inboundDesktopRequests.clear();
    deps.seenInboundDesktopRequestIds.clear();
  }

  function dispose(): void {
    if (deps.disposed)
      return;
    deps.disposed = true;
    const error = brokerError("connection_unavailable", "Realtime Broker disposed");
    for (const pending of deps.pendingRequests.values())
      pending.onError(error);
    for (const transaction of deps.queriesByRequestId.values())
      deps.failQuery(transaction, error);
    deps.pendingRequests.clear();
    deps.queriesByRequestId.clear();
    deps.runSubscriptions.clear();
    deps.pushSubscriptions.clear();
    deps.connectionSubscriptions.clear();
    deps.runChannels.clear();
    for (const pending of [...deps.pendingClones.values()])
      pending.reject(error);
    deps.pendingClones.clear();
    deps.activeRootObserver = null;
    deps.mainChatRootObserver = null;
    deps.auxiliaryRootObservers.clear();
    deps.terminalRequestIds.clear();
    deps.clearRunActionGrants();
    for (const controller of deps.inboundDesktopRequests.values())
      controller.abort();
    deps.inboundDesktopRequests.clear();
    deps.seenInboundDesktopRequestIds.clear();
    deps.desktopBridgeProvider = null;
    for (const client of Object.values(deps.clients)) client.dispose();
  }

  function handleConnectionState(lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState): void {
    const previous = deps.connectionStates[lane].phase;
    deps.connectionStates[lane] = state;
    if (lane === "primary")
      deps.options.onConnectionState?.(state);
    for (const subscription of deps.connectionSubscriptions.values()) {
      if (subscription.lane !== lane)
        continue;
      subscription.onState({ ...state, key: state.key ? { ...state.key } : null });
    }
    if (state.phase === "connected" && previous !== "connected") {
      for (const run of deps.runChannels.values()) {
        if (run.lane === lane && run.suspended && !run.terminal &&
          (run.rootObserverTokens.size > 0 || deps.hasSystemRunLease(run))) {
          void deps.restoreRun(run);
        }
      }
      return;
    }
    if (state.phase !== "reconnecting" && state.phase !== "error")
      return;
    const disconnectError = brokerError("connection_lost_before_acceptance", state.lastError || "Agent Platform realtime connection lost");
    const requestError = brokerError("connection_unavailable", state.lastError || "Agent Platform realtime connection lost", { retryable: true });
    for (const pending of [...deps.pendingRequests.values()]) {
      if (pending.lane !== lane)
        continue;
      cleanupPending(pending.upstreamId);
      pending.onError(requestError);
    }
    for (const transaction of [...deps.queriesByRequestId.values()]) {
      if (transaction.lane !== lane)
        continue;
      if (!transaction.acceptedValue) {
        deps.failQuery(transaction, disconnectError);
        continue;
      }
      const run = transaction.runId ? deps.getRunChannel(transaction.runId, transaction.lane) : null;
      if (run) {
        run.suspended = true;
        run.upstreamRequestId = null;
      }
      deps.queriesByRequestId.delete(transaction.upstreamRequestId);
    }
    // A channel remains Broker-owned after query-to-auxiliary handoff and
    // subsequent attaches. Those streams no longer have a pending query entry.
    for (const run of deps.runChannels.values()) {
      if (run.lane !== lane || run.terminal) continue;
      run.suspended = true;
      run.upstreamRequestId = null;
    }
  }

  function handleFrame(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number): void {
    if (!deps.acceptingDelivery)
      return;
    if (generation !== deps.connectionStates[lane].generation) {
      deps.diagnostics.staleFrameCount += 1;
      return;
    }
    const kind = readText(frame.frame);
    if (kind === "push") {
      if (lane === "primary")
        deps.handlePush(frame);
      return;
    }
    if (kind === "request") {
      deps.handleInboundRequest(lane, frame);
      return;
    }
    if (!kind || !["response", "error", "stream"].includes(kind)) {
      deps.diagnostics.unknownFrameCount += 1;
      return;
    }
    const id = readText(frame.id);
    if (!id) {
      deps.diagnostics.unknownRequestIdCount += 1;
      return;
    }
    const query = deps.queriesByRequestId.get(id);
    if (query) {
      if (query.lane !== lane) {
        deps.diagnostics.staleFrameCount += 1;
        return;
      }
      if (kind === "error") {
        deps.failQuery(query, frameError(frame));
      }
      else if (kind === "stream")
        deps.handleQueryStream(query, frame);
      return;
    }
    const run = [...deps.runChannels.values()].find((candidate) => candidate.lane === lane && candidate.upstreamRequestId === id);
    if (run && kind === "stream") {
      deps.handleRunStream(run, frame);
      return;
    }
    if (run && kind === "error") {
      const error = frameError(frame);
      const subscriptions = [...run.subscribers].flatMap((subscriptionId) => {
        const subscription = deps.runSubscriptions.get(subscriptionId);
        deps.runSubscriptions.delete(subscriptionId);
        return subscription ? [subscription] : [];
      });
      run.subscribers.clear();
      run.query?.completed.reject(error);
      deps.completeRun(run, { reason: "error", lastSeq: run.lastSeq }, run.upstreamSource);
      for (const subscription of subscriptions) {
        if (subscription.onError) subscription.onError(error);
        else subscription.onComplete?.({ reason: "error", lastSeq: run.lastSeq });
      }
      return;
    }
    const pending = deps.pendingRequests.get(id);
    if (pending) {
      if (pending.lane !== lane) {
        deps.diagnostics.staleFrameCount += 1;
        return;
      }
      const outbound = { ...frame, id: pending.localId };
      pending.onFrame(outbound);
      const terminalStream = kind === "stream" && Boolean(readText(frame.reason));
      if (kind === "response" || kind === "error" || terminalStream) {
        cleanupPending(id);
      }
      return;
    }
    if (kind === "stream" && deps.terminalRequestIds.has(id)) {
      deps.diagnostics.duplicateTerminalCount += 1;
      return;
    }
    deps.diagnostics.unknownRequestIdCount += 1;
  }

  function cleanupPending(upstreamId: string): void {
    const pending = deps.pendingRequests.get(upstreamId);
    if (!pending)
      return;
    if (pending.timer)
      clearTimeout(pending.timer);
    deps.pendingRequests.delete(upstreamId);
  }

  function prepareConnectionIdentity(baseUrl: string, token: string): void {
    const reason = Object.values(deps.clients)
      .map((client) => client.getRotationReason(baseUrl, token))
      .find((value) => value !== null);
    if (reason) {
      rotateIdentity(reason);
    }
  }

  return { getConnectionPhase, getConnectionState, getConnectionStates, ensureConnected, forwardRequest, rotateIdentity, beginShutdown, dispose, handleConnectionState, handleFrame, cleanupPending, prepareConnectionIdentity };
}
