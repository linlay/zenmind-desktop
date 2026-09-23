import type { BrokerDiagnosticsCounters } from "./realtime-broker.shared";
import { randomUUID } from "node:crypto";
import { type AgentWebclientRunOwner } from "../../../../shared/contracts";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
} from "./agent-platform-realtime-client";
import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  BrokerRun,
  ConnectionSubscription,
  PendingClone,
  PendingRequest,
  PushSubscription,
  QueryTransaction,
  RealtimeLane,
  RealtimeQueryCompleted,
  RootObserverState,
  RunSubscription,
  brokerError,
  cloneBindingError,
  isRecord,
  readText,
  sameRunOwner,
} from "./realtime-broker.shared";

/** Dependencies limited to subscriptions; state remains owned by the Broker. */
export interface SubscriptionsPort {
  findRootObserver(tokenValue: string): RootObserverState | null;
  runSubscriptions: Map<string, RunSubscription>;
  pendingClones: Map<string, PendingClone>;
  queriesByRequestId: Map<string, QueryTransaction>;
  mainChatRootObserver: RootObserverState | null;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  replayToSubscriber(run: BrokerRun, subscription: RunSubscription): void;
  diagnostics: BrokerDiagnosticsCounters;
  acceptingDelivery: boolean;
  pushSubscriptions: Map<string, PushSubscription>;
  connectionSubscriptions: Map<string, ConnectionSubscription>;
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  prepareConnectionIdentity(baseUrl: string, token: string): void;
  setRunChannel(run: BrokerRun): void;
  startAttach(run: BrokerRun, baseUrl: string, token: string): Promise<void>;
  detachRunIfUnobserved(run: BrokerRun, reason: string): Promise<void>;
  pendingRequests: Map<string, PendingRequest>;
  cleanupPending(upstreamId: string): void;
  lastCloneCancellationReason: string;
}

export function createSubscriptions(deps: SubscriptionsPort) {
  function handoffSelectionExplanation(
    run: BrokerRun,
    observerToken: string,
  ) {
    if (run.lane !== "selection-explain" || deps.findRootObserver(observerToken)?.kind !== "selection_explain") return;
    const detached = { reason: "detached", lastSeq: run.lastSeq };
    const sourceTokens = new Set<string>();
    for (const token of [...run.rootObserverTokens]) {
      const source = deps.findRootObserver(token);
      if (token === observerToken || source?.kind === "selection_explain") continue;
      sourceTokens.add(token);
      run.rootObserverTokens.delete(token);
      source?.runIds.delete(run.runId);
      source?.overviewLease?.runIds.delete(run.runId);
    }
    // The new observer is already subscribed before the source is released,
    // so the same upstream query stream stays attached throughout the handoff.
    for (const subscription of [...deps.runSubscriptions.values()]) {
      if (subscription.lane !== run.lane || subscription.runId !== run.runId ||
        !subscription.observerToken || !sourceTokens.has(subscription.observerToken)) continue;
      unsubscribe(subscription.id);
      subscription.onComplete?.(detached);
    }
    for (const pending of [...deps.pendingClones.values()]) {
      if (pending.runId === run.runId && sourceTokens.has(pending.observerToken)) pending.resolve("detached");
    }
    const query = run.query;
    if (!query || (query.rootObserverToken && deps.findRootObserver(query.rootObserverToken)?.kind === "selection_explain")) return;
    query.sourceDetached = true;
    deps.queriesByRequestId.delete(query.upstreamRequestId);
    run.query = null;
    if (query.subscriptionId) unsubscribe(query.subscriptionId);
    query.subscriptionId = null;
    if (query.signal && query.abortListener) query.signal.removeEventListener("abort", query.abortListener);
    query.abortListener = undefined;
    query.signal = undefined;
    if (query.acceptanceTimer) clearTimeout(query.acceptanceTimer);
    query.acceptanceTimer = null;
    query.onEvent = () => undefined;
    void query.eventQueue.then(
      () => query.completed.resolve(detached),
      () => query.completed.resolve(detached),
    );
  }
  async function subscribeClone(options: {
    kind?: "overview" | "debug";
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner: AgentWebclientRunOwner;
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }): Promise<{ subscriptionId: string; unsubscribe: () => boolean; ready: Promise<void>; }> {
    const kind = options.kind ?? "debug";
    const observer = deps.mainChatRootObserver;
    const chatId = options.chatId.trim();
    const overviewLease = kind === "overview" ? observer?.overviewLease ?? null : null;
    if (!observer || observer.kind !== "main_chat" ||
      (kind === "overview"
        ? !overviewLease || overviewLease.state !== "ready" || overviewLease.chatId !== chatId
        : observer.contextId !== chatId)) {
      throw cloneBindingError("parent_observer_closed", "active Main Chat observer does not match the clone");
    }
    const waitOutcome = await waitForCloneRun(kind, observer.token, options.runId, options.chatId, options.owner, options.consumerId);
    if (waitOutcome === "detached") {
      const id = `clone-sub-${randomUUID()}`;
      queueMicrotask(() => options.onComplete?.({ reason: "detached" }));
      return {
        subscriptionId: id,
        unsubscribe: () => false,
        ready: Promise.resolve(),
      };
    }
    const current = deps.mainChatRootObserver;
    const run = deps.getRunChannel(options.runId);
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
    deps.replayToSubscriber(run, subscription);
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
    deps.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    if (kind === "overview")
      overviewLease!.subscriberIds.add(id);
    deps.diagnostics.cloneCreatedCount += 1;
    return {
      subscriptionId: id,
      unsubscribe: () => unsubscribe(id),
      ready: Promise.resolve(),
    };
  }

  function subscribePush(options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }): () => boolean {
    if (!deps.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    const types = new Set(options.types.map((type) => type.trim()).filter((type) => AGENT_PLATFORM_KNOWN_PUSH_TYPES.has(type)));
    if (types.size === 0) {
      throw brokerError("invalid_request", "at least one known push type is required");
    }
    const id = `push-sub-${randomUUID()}`;
    deps.pushSubscriptions.set(id, { id, ...options, types });
    return () => unsubscribe(id);
  }

  function subscribeConnection(options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }): () => boolean {
    const lane = options.lane ?? "primary";
    const id = `connection-sub-${randomUUID()}`;
    deps.connectionSubscriptions.set(id, { id, ...options, lane });
    options.onState(deps.clients[lane].getState());
    return () => deps.connectionSubscriptions.delete(id);
  }

  function subscribeRun(options: {
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
  }): { subscriptionId: string; unsubscribe: () => boolean; ready: Promise<void>; } {
    if (!deps.acceptingDelivery) {
      throw brokerError("connection_unavailable", "Realtime Broker is shutting down");
    }
    deps.prepareConnectionIdentity(options.baseUrl, options.token);
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
    if (subscription.role === "root_observer") {
      const observerToken = subscription.observerToken?.trim() || "";
      const observer = observerToken ? deps.findRootObserver(observerToken) : null;
      if (!observerToken || !observer) {
        throw brokerError("surface_generation_superseded", "Root Observer is no longer active");
      }
      if (observer.kind === "selection_explain" &&
        (lane !== "selection-explain" || observer.contextId !== chatId)) {
        throw brokerError("invalid_request", "The selection explanation observer must use its own Chat and lane");
      }
      if (observer.kind === "main_chat" &&
        observer.overviewLease?.state === "ready" &&
        observer.overviewLease.chatId !== chatId) {
        throw brokerError("protocol_error", "Run Chat does not match the active Main Chat context");
      }
    }
    let run = deps.getRunChannel(runId, lane);
    if (!run) {
      if (deps.getRunChannel(runId)) {
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
        upstreamSource: "attach_stream",
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
      deps.setRunChannel(run);
    }
    else if (run.chatId !== chatId) {
      throw brokerError("invalid_request", "runId belongs to a different chat");
    }
    else if (options.owner && run.owner && !sameRunOwner(run.owner, options.owner)) {
      throw brokerError("invalid_request", "runId belongs to a different Run owner");
    }
    deps.replayToSubscriber(run, subscription);
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
    deps.runSubscriptions.set(id, subscription);
    run.subscribers.add(id);
    if (subscription.role === "root_observer") {
      const observerToken = subscription.observerToken!.trim();
      const observer = deps.findRootObserver(observerToken)!;
      run.operationGeneration += 1;
      run.rootObserverTokens.add(observerToken);
      observer.runIds.add(run.runId);
      observer.overviewLease?.runIds.add(run.runId);
      handoffSelectionExplanation(run, observerToken);
      notifyPendingClones(run);
    }
    run.baseUrl = options.baseUrl;
    run.accessToken = options.token;
    const ready = !run.terminal && !run.upstreamRequestId
      ? Promise.resolve(run.detachInFlight).then(() => deps.startAttach(run, options.baseUrl, options.token)).catch((error) => {
        subscription.onError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      : Promise.resolve();
    return {
      subscriptionId: id,
      unsubscribe: () => unsubscribe(id),
      ready,
    };
  }

  function unsubscribe(subscriptionId: string): boolean {
    const push = deps.pushSubscriptions.get(subscriptionId);
    if (push) {
      deps.pushSubscriptions.delete(subscriptionId);
      return true;
    }
    const runSubscription = deps.runSubscriptions.get(subscriptionId);
    if (!runSubscription)
      return false;
    deps.runSubscriptions.delete(subscriptionId);
    if (runSubscription.role === "clone")
      deps.diagnostics.cloneRevokedCount += 1;
    deps.mainChatRootObserver?.overviewLease?.subscriberIds.delete(subscriptionId);
    const subscribedRun = deps.getRunChannel(runSubscription.runId, runSubscription.lane);
    subscribedRun?.subscribers.delete(subscriptionId);
    if (subscribedRun && runSubscription.role === "root_observer" && runSubscription.observerToken) {
      const stillObserved = [...deps.runSubscriptions.values()].some((candidate) => candidate.role === "root_observer" &&
        candidate.runId === runSubscription.runId &&
        candidate.observerToken === runSubscription.observerToken);
      if (!stillObserved && subscribedRun.rootObserverTokens.delete(runSubscription.observerToken)) {
        const observer = deps.findRootObserver(runSubscription.observerToken);
        observer?.runIds.delete(subscribedRun.runId);
        observer?.overviewLease?.runIds.delete(subscribedRun.runId);
        void deps.detachRunIfUnobserved(subscribedRun, "surface_inactive");
      }
    }
    return true;
  }

  function cleanupConsumer(consumerId: string): void {
    const error = brokerError("target_unavailable", "realtime consumer was destroyed");
    for (const pending of [...deps.pendingRequests.values()]) {
      if (pending.consumerId !== consumerId)
        continue;
      deps.cleanupPending(pending.upstreamId);
      pending.onError(error);
    }
    for (const subscription of [...deps.pushSubscriptions.values()]) {
      if (subscription.consumerId === consumerId)
        unsubscribe(subscription.id);
    }
    for (const subscription of [...deps.runSubscriptions.values()]) {
      if (subscription.consumerId === consumerId)
        unsubscribe(subscription.id);
    }
    for (const subscription of [...deps.connectionSubscriptions.values()]) {
      if (subscription.consumerId === consumerId)
        deps.connectionSubscriptions.delete(subscription.id);
    }
    for (const pending of [...deps.pendingClones.values()]) {
      if (pending.consumerId === consumerId)
        pending.reject(error);
    }
  }

  function waitForCloneRun(kind: "overview" | "debug", observerToken: string, runIdValue: string, chatIdValue: string, owner: AgentWebclientRunOwner, consumerId: string): Promise<"ready" | "detached"> {
    const runId = runIdValue.trim();
    const chatId = chatIdValue.trim();
    const run = deps.getRunChannel(runId);
    if (run && run.chatId === chatId && run.rootObserverTokens.has(observerToken) &&
      (!run.owner || sameRunOwner(run.owner, owner)))
      return Promise.resolve("ready" as const);
    if (run && (run.chatId !== chatId || (run.owner && !sameRunOwner(run.owner, owner)))) {
      return Promise.reject(cloneBindingError("visible_run_changed", "requested Run identity does not match the active Main Chat lease"));
    }
    const pendingQuery = [...deps.queriesByRequestId.values()].some((transaction) => transaction.rootObserverToken === observerToken &&
      transaction.runId === null &&
      transaction.expectedRunId === runId &&
      (!transaction.expectedChatId || transaction.expectedChatId === chatId));
    if (!pendingQuery && kind !== "overview") {
      return Promise.reject(cloneBindingError("run_not_registered", "requested Run is not registered for the active Main Chat observer"));
    }
    return new Promise<"ready" | "detached">((resolve, reject) => {
      const id = `pending-clone-${randomUUID()}`;
      const parent = deps.findRootObserver(observerToken);
      const parentGeneration = parent
        ? parent.generation
        : "";
      deps.pendingClones.set(id, {
        id,
        kind,
        consumerId,
        observerToken,
        parentGeneration,
        runId,
        chatId,
        owner,
        waitReason: "awaiting_run_start",
        resolve: (outcome: "ready" | "detached") => {
          deps.pendingClones.delete(id);
          if (kind === "overview")
            parent?.overviewLease?.pendingCloneIds.delete(id);
          resolve(outcome);
        },
        reject: (error: Error) => {
          deps.pendingClones.delete(id);
          if (kind === "overview")
            parent?.overviewLease?.pendingCloneIds.delete(id);
          const details = (error as Error & {
            details?: unknown;
          }).details;
          const reason = isRecord(details) ? readText(details.reason) : "";
          deps.lastCloneCancellationReason = reason || error.name || "clone_cancelled";
          reject(error);
        },
      });
      if (kind === "overview")
        parent?.overviewLease?.pendingCloneIds.add(id);
    });
  }

  function notifyPendingClones(run: BrokerRun): void {
    for (const pending of [...deps.pendingClones.values()]) {
      if (pending.runId !== run.runId || pending.chatId !== run.chatId)
        continue;
      if (!run.rootObserverTokens.has(pending.observerToken))
        continue;
      if (run.owner && !sameRunOwner(run.owner, pending.owner)) {
        pending.reject(cloneBindingError("visible_run_changed", "clone Run owner changed"));
        continue;
      }
      pending.resolve("ready");
    }
  }

  function rejectPendingClones(observerToken: string, error: Error): void {
    for (const pending of [...deps.pendingClones.values()]) {
      if (pending.observerToken === observerToken)
        pending.reject(error);
    }
  }

  function detachPendingClones(observerToken: string): void {
    for (const pending of [...deps.pendingClones.values()]) {
      if (pending.observerToken === observerToken)
        pending.resolve("detached");
    }
  }

  return { subscribeClone, subscribePush, subscribeConnection, subscribeRun, unsubscribe, cleanupConsumer, waitForCloneRun, notifyPendingClones, rejectPendingClones, detachPendingClones };
}
