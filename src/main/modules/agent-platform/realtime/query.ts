import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";
import { type AgentWebclientRunOwner } from "../../../../shared/contracts";
import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";
import { type SiteControlScope } from "../../web-surfaces";
import { AgentPlatformRealtimeClient, type AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import {
  BrokerRun,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  PendingClone,
  QueryTransaction,
  REQUEST_TIMEOUT_MS,
  RealtimeLane,
  RealtimeQueryAccepted,
  RealtimeQueryCompleted,
  RealtimeQueryHandle,
  RootObserverState,
  RunSubscription,
  brokerError,
  cloneBindingError,
  createDeferred,
  isObserverDetachReason,
  isRecord,
  isTerminalEvent,
  readText,
} from "./realtime-broker.shared";
import { type RunSiteControlGrants } from "./run-site-control-grants";

/** Dependencies limited to query; state remains owned by the Broker. */
export interface QueryPort {
  acceptingDelivery: boolean;
  prepareConnectionIdentity(baseUrl: string, token: string): void;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  findRootObserver(tokenValue: string): RootObserverState | null;
  queriesByRequestId: Map<string, QueryTransaction>;
  ensureConnected(baseUrl: string, token: string, lane?: RealtimeLane): Promise<void>;
  runChannels: Map<string, BrokerRun>;
  readonly options: { acceptanceTimeoutMs?: number; };
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  consumeRunEvent(run: BrokerRun, event: Record<string, unknown>, transaction: QueryTransaction | null): void;
  releaseRunObserver(run: BrokerRun, requestId: string, reason: string, lastSeq: unknown): void;
  completeRun(run: BrokerRun, result: RealtimeQueryCompleted, source: NonNullable<BrokerRun["terminalSource"]>): void;
  diagnostics: BrokerDiagnosticsCounters;
  appendReplay(run: BrokerRun, event: Record<string, unknown>, seq: number | null, path?: string): void;
  setRunChannel(run: BrokerRun): void;
  notifyPendingClones(run: BrokerRun): void;
  detachRunIfUnobserved(run: BrokerRun, reason: string): Promise<void>;
  runSubscriptions: Map<string, RunSubscription>;
  replayToSubscriber(run: BrokerRun, subscription: RunSubscription): void;
  siteControlGrants: RunSiteControlGrants;
  deleteRunChannel(run: BrokerRun): boolean;
  unsubscribe(subscriptionId: string): boolean;
  pendingClones: Map<string, PendingClone>;
}

export function createQuery(deps: QueryPort) {
  function query(options: {
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
    siteControlScope?: SiteControlScope;
  }): RealtimeQueryHandle {
    const accepted = createDeferred<RealtimeQueryAccepted>();
    const completed = createDeferred<RealtimeQueryCompleted>();
    const operationId = options.id.trim();
    const expectedRunId = options.runId?.trim() || "";
    const expectedChatId = options.chatId?.trim() || "";
    const lane = options.lane ?? (options.requestType === "/api/btw" ? "btw" : "primary");
    const requestType = options.requestType ?? (lane === "primary" ? "/api/query" : "/api/btw");
    if (lane === "selection-explain" && (requestType !== "/api/btw" || options.siteControlScope)) {
      const error = brokerError("invalid_request", "The selection explanation lane only accepts BTW queries without page-control authority");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (!deps.acceptingDelivery) {
      const error = brokerError("connection_unavailable", "Realtime Broker is shutting down");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    deps.prepareConnectionIdentity(options.baseUrl, options.token);
    const registeredLane = expectedRunId ? deps.getRunChannel(expectedRunId)?.lane : undefined;
    if (options.lane && registeredLane && options.lane !== registeredLane) {
      const error = brokerError("invalid_request", "runId belongs to a different Realtime lane");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (!operationId) {
      const error = brokerError("invalid_request", "query id is required");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    const observerToken = options.observerToken?.trim() || "";
    const observer = observerToken ? deps.findRootObserver(observerToken) : null;
    if (observerToken && !observer) {
      const error = brokerError("surface_generation_superseded", "Root Observer is no longer active");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (observer?.kind === "selection_explain" &&
      (lane !== "selection-explain" || observer.contextId !== expectedChatId)) {
      const error = brokerError("invalid_request", "The selection explanation observer must use its own Chat and lane");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    if (observer?.kind === "main_chat" &&
      observer.overviewLease?.state === "ready" &&
      expectedChatId && observer.overviewLease.chatId !== expectedChatId) {
      const error = brokerError("protocol_error", "query Chat does not match the active Main Chat context");
      options.siteControlScope?.release("The query was not accepted.");
      accepted.reject(error);
      completed.reject(error);
      return { accepted: accepted.promise, completed: completed.promise };
    }
    const upstreamRequestId = `desktop-query-${randomUUID()}`;
    const transaction: QueryTransaction = {
      siteControlScope: options.siteControlScope,
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
      rootObserverToken: observerToken || null,
      consumerId: options.consumerId?.trim() || `query:${operationId}`,
      subscriptionId: null,
      baseUrl: options.baseUrl,
      accessToken: options.token,
    };
    deps.queriesByRequestId.set(upstreamRequestId, transaction);
    if (options.signal) {
      transaction.abortListener = () => {
        failQuery(transaction, brokerError("connection_unavailable", "query aborted"));
      };
      options.signal.addEventListener("abort", transaction.abortListener, { once: true });
    }
    void deps.ensureConnected(options.baseUrl, options.token, lane)
      .then(async () => {
        if (observerToken && lane === "primary") {
          await Promise.all([...deps.runChannels.values()].filter((run) => run.lane === "primary").map((run) => run.detachInFlight));
          if (!deps.findRootObserver(observerToken)) {
            throw brokerError("surface_generation_superseded", "Root Observer changed before query delivery");
          }
        }
        if (options.signal?.aborted) {
          throw brokerError("connection_unavailable", "query aborted");
        }
        if (deps.queriesByRequestId.get(upstreamRequestId) !== transaction) return;
        transaction.acceptanceTimer = setTimeout(() => {
          failQuery(transaction, brokerError("connection_unavailable", "query acceptance timed out"));
        }, deps.options.acceptanceTimeoutMs ?? REQUEST_TIMEOUT_MS);
        deps.clients[lane].send({
          frame: "request",
          // Frame Port retains WebClient's BTW intent; Platform selects semantics by authenticated lane.
          type: "/api/query",
          id: upstreamRequestId,
          payload: options.payload,
        });
      })
      .catch((error: unknown) => failQuery(transaction, error));
    return { accepted: accepted.promise, completed: completed.promise };
  }

  function handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame): void {
    let run = transaction.runId ? deps.getRunChannel(transaction.runId, transaction.lane) : null;
    if (isRecord(frame.event)) {
      try {
        if (!run && readText(frame.event.type) !== "run.start") {
          bufferProvisionalQueryEvent(transaction, frame.event);
          return;
        }
        if (!run) {
          run = registerProvisionalRun(transaction, frame.event);
          commitProvisionalQueryEvents(run, transaction);
          bindQuerySubscription(run, transaction);
        }
        deps.consumeRunEvent(run, frame.event, transaction);
      }
      catch (error) {
        failQuery(transaction, error);
        return;
      }
    }
    const reason = readText(frame.reason);
    if (!reason)
      return;
    if (!transaction.acceptedValue) {
      failQuery(transaction, brokerError("protocol_error", "query ended before run.start"));
      return;
    }
    if (!run) {
      failQuery(transaction, brokerError("protocol_error", "accepted query Run registry entry is missing"));
      return;
    }
    if (isObserverDetachReason(reason)) {
      deps.releaseRunObserver(run, transaction.upstreamRequestId, reason, frame.lastSeq);
      return;
    }
    deps.completeRun(run, {
      reason,
      ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    }, "query_stream");
  }

  function bufferProvisionalQueryEvent(transaction: QueryTransaction, event: Record<string, unknown>): void {
    const type = readText(event.type);
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex++}]`;
    if (!type)
      throw brokerError("protocol_error", "stream event.type is required");
    if (isTerminalEvent(type)) {
      throw brokerError("protocol_error", "terminal event arrived before run.start");
    }
    requireAgentPlatformEpochMillis(event.timestamp, `${path}.timestamp`);
    const eventChatId = readText(event.chatId);
    if (transaction.expectedChatId && eventChatId && transaction.expectedChatId !== eventChatId) {
      throw brokerError("protocol_error", "bootstrap chatId conflicts with query chatId");
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (transaction.bufferedEvents.length >= MAX_REPLAY_EVENTS ||
      transaction.bufferedEventBytes + bytes > MAX_REPLAY_BYTES) {
      throw brokerError("backpressure", "too many query events arrived before run.start");
    }
    transaction.bufferedEvents.push({ event, path });
    transaction.bufferedEventBytes += bytes;
  }

  function commitProvisionalQueryEvents(run: BrokerRun, transaction: QueryTransaction): void {
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
          deps.diagnostics.seqRegressionCount += 1;
          continue;
        }
        if (run.lastSeq > 0 && seq > run.lastSeq + 1)
          deps.diagnostics.seqGapCount += 1;
        run.lastSeq = seq;
      }
      deps.appendReplay(run, event, seq, path);
    }
  }

  function registerProvisionalRun(transaction: QueryTransaction, event: Record<string, unknown>): BrokerRun {
    const path = `ws.query[${transaction.operationId}].events[${transaction.eventIndex}]`;
    if (readText(event.type) !== "run.start")
      throw brokerError("protocol_error", "run.start is required");
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
    if (expectedOwner && (owner.kind !== expectedOwner.kind ||
      (owner.kind === "agent" && expectedOwner.kind === "agent" && owner.agentKey !== expectedOwner.agentKey) ||
      (owner.kind === "team" && expectedOwner.kind === "team" && owner.teamId !== expectedOwner.teamId))) {
      throw brokerError("protocol_error", "run.start owner conflicts with query owner");
    }
    if (deps.getRunChannel(runId)) {
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
      upstreamSource: "query_stream",
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
    deps.setRunChannel(run);
    const observerToken = transaction.rootObserverToken;
    const observer = observerToken ? deps.findRootObserver(observerToken) : null;
    if (observerToken && observer) {
      run.operationGeneration += 1;
      run.rootObserverTokens.add(observerToken);
      observer.runIds.add(runId);
      observer.overviewLease?.runIds.add(runId);
      deps.notifyPendingClones(run);
    }
    else if (observerToken) {
      void deps.detachRunIfUnobserved(run, "surface_generation_superseded");
    }
    return run;
  }

  function bindQuerySubscription(run: BrokerRun, transaction: QueryTransaction): void {
    const observerToken = transaction.rootObserverToken;
    const role: RunSubscription["role"] = observerToken ? "root_observer" : "internal";
    if (observerToken && !deps.findRootObserver(observerToken)) {
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
        transaction.eventQueue = transaction.eventQueue.then(() => {
          if (!transaction.sourceDetached) return transaction.onEvent(event, path);
        });
        void transaction.eventQueue.catch((error) => failQuery(transaction, error));
      },
    };
    deps.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    transaction.subscriptionId = id;
    deps.replayToSubscriber(run, subscription);
    transaction.bufferedEvents = [];
    transaction.bufferedEventBytes = 0;
  }

  function failQuery(transaction: QueryTransaction, error: unknown): void {
    if (transaction.sourceDetached) return;
    transaction.siteControlScope?.release("The source query failed.");
    if (transaction.runId) deps.siteControlGrants.revoke(transaction.runId);
    deps.queriesByRequestId.delete(transaction.upstreamRequestId);
    const run = transaction.runId ? deps.getRunChannel(transaction.runId, transaction.lane) : null;
    if (run && !transaction.acceptedValue)
      deps.deleteRunChannel(run);
    if (transaction.subscriptionId)
      deps.unsubscribe(transaction.subscriptionId);
    if (run?.query === transaction)
      run.query = null;
    if (transaction.signal && transaction.abortListener) {
      transaction.signal.removeEventListener("abort", transaction.abortListener);
    }
    if (transaction.acceptanceTimer) {
      clearTimeout(transaction.acceptanceTimer);
      transaction.acceptanceTimer = null;
    }
    if (transaction.rootObserverToken && transaction.expectedRunId) {
      for (const pending of [...deps.pendingClones.values()]) {
        if (pending.observerToken === transaction.rootObserverToken &&
          pending.runId === transaction.expectedRunId) {
          pending.reject(cloneBindingError("run_not_registered", "the parent query ended before its RunChannel was registered"));
        }
      }
    }
    transaction.accepted.reject(error);
    transaction.completed.reject(error);
  }

  return { query, handleQueryStream, bufferProvisionalQueryEvent, commitProvisionalQueryEvents, registerProvisionalRun, bindQuerySubscription, failQuery };
}
