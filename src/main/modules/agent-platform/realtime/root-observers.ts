import { randomUUID } from "node:crypto";
import {
  BrokerRun,
  RealtimeLane,
  RootObserverIdentity,
  RootObserverState,
  RunSubscription,
  brokerError,
} from "./realtime-broker.shared";

/** Dependencies limited to root observers; state remains owned by the Broker. */
export interface RootObserversPort {
  mainChatRootObserver: RootObserverState | null;
  activeRootObserver: RootObserverState | null;
  auxiliaryRootObservers: Map<string, RootObserverState>;
  detachPendingClones(observerToken: string): void;
  runSubscriptions: Map<string, RunSubscription>;
  unsubscribe(subscriptionId: string): boolean;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
  runChannels: Map<string, BrokerRun>;
  detachRunIfUnobserved(run: BrokerRun, reason: string): Promise<void>;
  pruneRetainedTerminalRuns(): void;
}

export function createRootObservers(deps: RootObserversPort) {
  function findRootObserver(tokenValue: string): RootObserverState | null {
    const token = tokenValue.trim();
    if (!token)
      return null;
    if (deps.mainChatRootObserver?.token === token)
      return deps.mainChatRootObserver;
    if (deps.activeRootObserver?.token === token)
      return deps.activeRootObserver;
    return deps.auxiliaryRootObservers.get(token) || null;
  }

  function snapshotRootObserver(observer: RootObserverState | null) {
    return observer
      ? {
        token: observer.token,
        kind: observer.kind,
        surfaceId: observer.surfaceId,
        generation: observer.generation,
        contextId: observer.contextId,
        newChatSourceKey: observer.newChatSourceKey,
        contextEpoch: observer.contextEpoch,
        webContentsId: observer.webContentsId,
        runIds: new Set(observer.runIds),
      }
      : null;
  }

  function activateRootObserver(input: RootObserverIdentity) {
    const token = input.token.trim();
    const surfaceId = input.surfaceId.trim();
    const generation = input.generation.trim();
    const contextId = input.contextId.trim();
    if (!token || !surfaceId || !generation || !contextId || !Number.isSafeInteger(input.webContentsId)) {
      throw brokerError("invalid_request", "Root Observer identity is incomplete");
    }
    const current = input.kind === "main_chat"
      ? deps.mainChatRootObserver
      : input.kind === "selection_explain"
        ? [...deps.auxiliaryRootObservers.values()].find(
          (observer) => observer.surfaceId === surfaceId,
        ) || null
        : deps.activeRootObserver?.kind === input.kind
          ? deps.activeRootObserver
          : null;
    if (current?.token === token) {
      if (current.kind !== input.kind || current.surfaceId !== surfaceId ||
        current.generation !== generation || current.webContentsId !== input.webContentsId ||
        current.newChatSourceKey !== input.newChatSourceKey) {
        throw brokerError("protocol_error", "Root Observer token conflicts with its registered identity");
      }
      if (input.kind === "main_chat" &&
        current.overviewLease?.state === "pending_chat_identity" &&
        contextId !== current.contextId) {
        promoteMainChatRootObserver(token, contextId);
      } else if (contextId !== current.contextId) {
        throw brokerError("protocol_error", "Root Observer context changed without a new token");
      }
      return input.kind === "main_chat"
        ? getMainChatRootObserver()
        : input.kind === "selection_explain"
          ? snapshotRootObserver(current)
          : getActiveRootObserver();
    }
    const contextEpoch = `root-context-${randomUUID()}`;
    const next: RootObserverState = {
      ...input,
      token,
      surfaceId,
      generation,
      contextId,
      contextEpoch,
      runIds: new Set(),
      overviewLease: input.kind === "main_chat"
        ? {
          state: contextId === `${surfaceId}:${generation}` ? "pending_chat_identity" : "ready",
          parentToken: token,
          parentGeneration: generation,
          contextEpoch,
          chatId: contextId === `${surfaceId}:${generation}` ? null : contextId,
          runIds: new Set(),
          pendingCloneIds: new Set(),
          subscriberIds: new Set(),
        }
        : null,
    };
    if (input.kind === "selection_explain") {
      if (current) {
        deps.auxiliaryRootObservers.delete(current.token);
        retireRootObserver(current, "surface_generation_superseded");
      }
      deps.auxiliaryRootObservers.set(token, next);
    }
    else {
      // Main Chat, Copilot, and Kanban share one live observer; the
      // independent explanation observer keeps its own Run stream.
      const previous = deps.activeRootObserver;
      deps.activeRootObserver = next;
      deps.mainChatRootObserver = input.kind === "main_chat" ? next : null;
      if (previous) retireRootObserver(previous, "surface_generation_superseded");
    }
    return input.kind === "main_chat"
      ? getMainChatRootObserver()
      : input.kind === "selection_explain"
        ? snapshotRootObserver(next)
        : getActiveRootObserver();
  }

  function getActiveRootObserver() {
    return snapshotRootObserver(deps.activeRootObserver);
  }

  function getMainChatRootObserver() {
    return snapshotRootObserver(deps.mainChatRootObserver);
  }

  function promoteMainChatRootObserver(tokenValue: string, chatIdValue: string) {
    const token = tokenValue.trim();
    const chatId = chatIdValue.trim();
    const observer = deps.mainChatRootObserver;
    if (!token || !chatId || !observer || observer.token !== token || !observer.overviewLease) {
      throw brokerError("surface_generation_superseded", "Main Chat Root Observer is no longer active");
    }
    const lease = observer.overviewLease;
    if (lease.state === "ready" && lease.chatId !== chatId) {
      throw brokerError("protocol_error", "canonical Chat identity conflicts with the Main Chat context");
    }
    observer.contextId = chatId;
    lease.state = "ready";
    lease.chatId = chatId;
    return getMainChatRootObserver();
  }

  function releaseRootObserver(tokenValue: string, reason = "parent_observer_closed"): boolean {
    const token = tokenValue.trim();
    if (!token)
      return false;
    const observer = findRootObserver(token);
    if (!observer)
      return false;
    if (deps.mainChatRootObserver === observer)
      deps.mainChatRootObserver = null;
    if (deps.activeRootObserver === observer) {
      deps.activeRootObserver = deps.mainChatRootObserver;
    }
    deps.auxiliaryRootObservers.delete(observer.token);
    retireRootObserver(observer, reason);
    return true;
  }

  function retireRootObserver(observer: RootObserverState, reason: string): void {
    const token = observer.token;
    deps.detachPendingClones(token);
    for (const subscription of [...deps.runSubscriptions.values()]) {
      if (subscription.observerToken !== token)
        continue;
      deps.unsubscribe(subscription.id);
      if (subscription.role === "clone") {
        const run = deps.getRunChannel(subscription.runId, subscription.lane);
        subscription.onComplete?.({
          reason: "detached",
          ...(run ? { lastSeq: run.lastSeq } : {}),
        });
      }
    }
    for (const run of deps.runChannels.values()) {
      if (!run.rootObserverTokens.delete(token))
        continue;
      void deps.detachRunIfUnobserved(run, reason);
    }
    deps.pruneRetainedTerminalRuns();
  }

  function releaseObservedRun(observerTokenValue: string, runIdValue: string, reason = "surface_inactive"): boolean {
    const observerToken = observerTokenValue.trim();
    const runId = runIdValue.trim();
    const run = deps.getRunChannel(runId);
    if (!observerToken || !run || !run.rootObserverTokens.delete(observerToken))
      return false;
    const observer = findRootObserver(observerToken);
    observer?.runIds.delete(runId);
    observer?.overviewLease?.runIds.delete(runId);
    for (const subscription of [...deps.runSubscriptions.values()]) {
      if (subscription.runId !== runId || subscription.observerToken !== observerToken)
        continue;
      deps.unsubscribe(subscription.id);
      if (subscription.role === "clone") {
        subscription.onComplete?.({ reason: "detached", lastSeq: run.lastSeq });
      }
    }
    void deps.detachRunIfUnobserved(run, reason);
    deps.pruneRetainedTerminalRuns();
    return true;
  }

  function hasSystemRunLease(run: BrokerRun): boolean {
    return [...run.subscribers].some((id) => deps.runSubscriptions.get(id)?.role === "internal");
  }

  return { findRootObserver, snapshotRootObserver, activateRootObserver, getActiveRootObserver, getMainChatRootObserver, promoteMainChatRootObserver, releaseRootObserver, retireRootObserver, releaseObservedRun, hasSystemRunLease };
}
