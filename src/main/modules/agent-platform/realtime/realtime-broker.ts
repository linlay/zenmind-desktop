import { RunSiteCdpGrants } from "./run-site-cdp-grants";
import type { SiteCdpScope } from "../../web-surfaces";
import { randomUUID } from "node:crypto";

import type { App } from "electron";

import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../../../shared/contracts";

import { validateAgentPlatformPushTimeContract } from "../../../../shared/agent-platform-push-time-contract";

import { getDesktopActionDefinition } from "../../../../shared/desktop-actions";

import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";

import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";

import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";

import { AGENT_PLATFORM_KNOWN_PUSH_TYPES, BrokerRun, ConnectionSubscription, DESKTOP_CDP_REQUEST_TYPE, DESKTOP_MAX_RESPONSE_BYTES, DESKTOP_RESPONSE_DELTA_EVENT_TYPE, DESKTOP_SCREENSHOT_CHUNK_CHARS, DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE, DESKTOP_STREAM_RAW_CHUNK_BYTES, Deferred, DesktopBridgeRequestProvider, MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS, MAX_RETAINED_TERMINAL_RUNS, OverviewCloneLeaseState, PendingClone, PendingRequest, PushSubscription, QueryTransaction, REQUEST_TIMEOUT_MS, RealtimeLane, RealtimeQueryAccepted, RealtimeQueryCompleted, RealtimeQueryHandle, ReplayEvent, RootObserverIdentity, RootObserverKind, RootObserverState, RunActionGrant, RunChannelKey, RunSubscription, brokerError, cloneBindingError, createDeferred, frameError, framePayload, isObserverDetachReason, isRecord, isTerminalEvent, pushIdentity, readText, runChannelMapKey, sameRunOwner, unrefTimer } from "./realtime-broker.shared";

import { RealtimeBroker_getConnectionPhase_1, RealtimeBroker_getConnectionState_2, RealtimeBroker_getConnectionStates_3, RealtimeBroker_setDesktopBridgeProvider_4, RealtimeBroker_getRunChannel_5, RealtimeBroker_setRunChannel_6, RealtimeBroker_deleteRunChannel_7, RealtimeBroker_findRootObserver_8, RealtimeBroker_snapshotRootObserver_9, RealtimeBroker_ensureConnected_10, RealtimeBroker_query_11, RealtimeBroker_forwardRequest_12, RealtimeBroker_activateRootObserver_13, RealtimeBroker_getActiveRootObserver_14, RealtimeBroker_getMainChatRootObserver_15, RealtimeBroker_promoteMainChatRootObserver_16, RealtimeBroker_releaseRootObserver_17, RealtimeBroker_retireRootObserver_18, RealtimeBroker_releaseObservedRun_19 } from "./realtime-broker.methods-1";

import { RealtimeBroker_subscribeClone_1, RealtimeBroker_subscribePush_2, RealtimeBroker_subscribeConnection_3, RealtimeBroker_subscribeRun_4, RealtimeBroker_unsubscribe_5, RealtimeBroker_registerRunActionGrant_6, RealtimeBroker_revokeRunActionGrant_7, RealtimeBroker_clearRunActionGrants_8, RealtimeBroker_cleanupConsumer_9 } from "./realtime-broker.methods-2";

import { RealtimeBroker_getDiagnostics_1, RealtimeBroker_appendDebugTrace_2, RealtimeBroker_getDebugTraceEntries_3, RealtimeBroker_clearDebugTrace_4, RealtimeBroker_rotateIdentity_5, RealtimeBroker_beginShutdown_6, RealtimeBroker_dispose_7, RealtimeBroker_handleConnectionState_8, RealtimeBroker_handleFrame_9, RealtimeBroker_handleQueryStream_10, RealtimeBroker_bufferProvisionalQueryEvent_11, RealtimeBroker_commitProvisionalQueryEvents_12 } from "./realtime-broker.methods-3";

import { RealtimeBroker_registerProvisionalRun_1, RealtimeBroker_bindQuerySubscription_2, RealtimeBroker_handleRunStream_3, RealtimeBroker_releaseRunObserver_4, RealtimeBroker_consumeRunEvent_5, RealtimeBroker_appendReplay_6, RealtimeBroker_replayToSubscriber_7, RealtimeBroker_completeRun_8, RealtimeBroker_failQuery_9, RealtimeBroker_startAttach_10, RealtimeBroker_restoreRun_11 } from "./realtime-broker.methods-4";

import { RealtimeBroker_handlePush_1, RealtimeBroker_handleInboundRequest_2, RealtimeBroker_handleDesktopBridgeRequest_3, RealtimeBroker_awaitRunActionReadiness_4, RealtimeBroker_sendDesktopBridgeSuccess_5, RealtimeBroker_sendDesktopBridgeChunk_6, RealtimeBroker_sendDesktopBridgeError_7 } from "./realtime-broker.methods-5";

import { RealtimeBroker_waitForCloneRun_1, RealtimeBroker_notifyPendingClones_2, RealtimeBroker_rejectPendingClones_3, RealtimeBroker_detachPendingClones_4, RealtimeBroker_pruneRetainedTerminalRuns_5, RealtimeBroker_hasSystemRunLease_6, RealtimeBroker_detachRunIfUnobserved_7, RealtimeBroker_cleanupPending_8, RealtimeBroker_prepareConnectionIdentity_9 } from "./realtime-broker.methods-6";

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
  private readonly siteCdpGrants = new RunSiteCdpGrants();
  private readonly runActionGrants = new Map<string, RunActionGrant>();
  private activeRootObserver: RootObserverState | null = null;
  private mainChatRootObserver: RootObserverState | null = null;
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
    getDesktopDeviceId: (app: App) => string;
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
        getDesktopDeviceId: options.getDesktopDeviceId,
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

  getConnectionPhase(): AgentWebclientConnectionPhase { return RealtimeBroker_getConnectionPhase_1(this as any); }

  getConnectionState(lane: RealtimeLane = "primary") { return RealtimeBroker_getConnectionState_2(this as any, lane); }

  getConnectionStates() { return RealtimeBroker_getConnectionStates_3(this as any); }

  setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null) { return RealtimeBroker_setDesktopBridgeProvider_4(this as any, provider); }

  private getRunChannel(runIdValue: string, lane?: RealtimeLane) { return RealtimeBroker_getRunChannel_5(this as any, runIdValue, lane); }

  private setRunChannel(run: BrokerRun) { return RealtimeBroker_setRunChannel_6(this as any, run); }

  private deleteRunChannel(run: BrokerRun) { return RealtimeBroker_deleteRunChannel_7(this as any, run); }

  private findRootObserver(tokenValue: string) { return RealtimeBroker_findRootObserver_8(this as any, tokenValue); }

  private snapshotRootObserver(observer: RootObserverState | null) { return RealtimeBroker_snapshotRootObserver_9(this as any, observer); }

  async ensureConnected(baseUrl: string, token: string, lane: RealtimeLane = "primary") { return RealtimeBroker_ensureConnected_10(this as any, baseUrl, token, lane); }

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
  }): RealtimeQueryHandle { return RealtimeBroker_query_11(this as any, options); }

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
  }) { return RealtimeBroker_forwardRequest_12(this as any, options); }

  activateRootObserver(input: RootObserverIdentity) { return RealtimeBroker_activateRootObserver_13(this as any, input); }

  getActiveRootObserver() { return RealtimeBroker_getActiveRootObserver_14(this as any); }

  getMainChatRootObserver() { return RealtimeBroker_getMainChatRootObserver_15(this as any); }

  promoteMainChatRootObserver(tokenValue: string, chatIdValue: string) { return RealtimeBroker_promoteMainChatRootObserver_16(this as any, tokenValue, chatIdValue); }

  releaseRootObserver(tokenValue: string, reason = "parent_observer_closed") { return RealtimeBroker_releaseRootObserver_17(this as any, tokenValue, reason); }

  private retireRootObserver(observer: RootObserverState, reason: string) { return RealtimeBroker_retireRootObserver_18(this as any, observer, reason); }

  releaseObservedRun(observerTokenValue: string, runIdValue: string, reason = "surface_inactive") { return RealtimeBroker_releaseObservedRun_19(this as any, observerTokenValue, runIdValue, reason); }

  async subscribeClone(options: {
    kind?: "overview" | "debug";
    runId: string;
    chatId: string;
    lastSeq?: number;
    owner: AgentWebclientRunOwner;
    consumerId: string;
    onEvent(event: Record<string, unknown>): void;
    onComplete?(result: RealtimeQueryCompleted): void;
    onError?(error: Error): void;
  }) { return RealtimeBroker_subscribeClone_1(this as any, options); }

  subscribePush(options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }) { return RealtimeBroker_subscribePush_2(this as any, options); }

  subscribeConnection(options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }) { return RealtimeBroker_subscribeConnection_3(this as any, options); }

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
  }) { return RealtimeBroker_subscribeRun_4(this as any, options); }

  unsubscribe(subscriptionId: string) { return RealtimeBroker_unsubscribe_5(this as any, subscriptionId); }

  registerRunActionGrant(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }) { return RealtimeBroker_registerRunActionGrant_6(this as any, input); }

  revokeRunActionGrant(runIdValue: string) { return RealtimeBroker_revokeRunActionGrant_7(this as any, runIdValue); }

  private clearRunActionGrants() { return RealtimeBroker_clearRunActionGrants_8(this as any); }

  cleanupConsumer(consumerId: string) { return RealtimeBroker_cleanupConsumer_9(this as any, consumerId); }

  getDiagnostics() { return RealtimeBroker_getDiagnostics_1(this as any); }

  appendDebugTrace(input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]) { return RealtimeBroker_appendDebugTrace_2(this as any, input); }

  getDebugTraceEntries() { return RealtimeBroker_getDebugTraceEntries_3(this as any); }

  clearDebugTrace() { return RealtimeBroker_clearDebugTrace_4(this as any); }

  rotateIdentity(reason: RealtimeIdentityRotationReason = "explicit_identity_invalidation") { return RealtimeBroker_rotateIdentity_5(this as any, reason); }

  beginShutdown() { return RealtimeBroker_beginShutdown_6(this as any); }

  dispose() { return RealtimeBroker_dispose_7(this as any); }

  private handleConnectionState(lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState) { return RealtimeBroker_handleConnectionState_8(this as any, lane, state); }

  private handleFrame(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number) { return RealtimeBroker_handleFrame_9(this as any, lane, frame, generation); }

  private handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame) { return RealtimeBroker_handleQueryStream_10(this as any, transaction, frame); }

  private bufferProvisionalQueryEvent(
    transaction: QueryTransaction,
    event: Record<string, unknown>,
  ) { return RealtimeBroker_bufferProvisionalQueryEvent_11(this as any, transaction, event); }

  private commitProvisionalQueryEvents(run: BrokerRun, transaction: QueryTransaction) { return RealtimeBroker_commitProvisionalQueryEvents_12(this as any, run, transaction); }

  private registerProvisionalRun(
    transaction: QueryTransaction,
    event: Record<string, unknown>,
  ) { return RealtimeBroker_registerProvisionalRun_1(this as any, transaction, event); }

  private bindQuerySubscription(run: BrokerRun, transaction: QueryTransaction) { return RealtimeBroker_bindQuerySubscription_2(this as any, run, transaction); }

  private handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame) { return RealtimeBroker_handleRunStream_3(this as any, run, frame); }

  private releaseRunObserver(
    run: BrokerRun,
    requestId: string,
    reason: string,
    lastSeq: unknown,
  ) { return RealtimeBroker_releaseRunObserver_4(this as any, run, requestId, reason, lastSeq); }

  private consumeRunEvent(
    run: BrokerRun,
    event: Record<string, unknown>,
    transaction: QueryTransaction | null,
  ) { return RealtimeBroker_consumeRunEvent_5(this as any, run, event, transaction); }

  private appendReplay(
    run: BrokerRun,
    event: Record<string, unknown>,
    seq: number | null,
    path?: string,
  ) { return RealtimeBroker_appendReplay_6(this as any, run, event, seq, path); }

  private replayToSubscriber(run: BrokerRun, subscription: RunSubscription) { return RealtimeBroker_replayToSubscriber_7(this as any, run, subscription); }

  private completeRun(
    run: BrokerRun,
    result: RealtimeQueryCompleted,
    source: NonNullable<BrokerRun["terminalSource"]>,
  ) { return RealtimeBroker_completeRun_8(this as any, run, result, source); }

  private failQuery(transaction: QueryTransaction, error: unknown) { return RealtimeBroker_failQuery_9(this as any, transaction, error); }

  private async startAttach(run: BrokerRun, baseUrl: string, token: string) { return RealtimeBroker_startAttach_10(this as any, run, baseUrl, token); }

  private async restoreRun(run: BrokerRun) { return RealtimeBroker_restoreRun_11(this as any, run); }

  private handlePush(frame: AgentPlatformRealtimeFrame) { return RealtimeBroker_handlePush_1(this as any, frame); }

  private handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame) { return RealtimeBroker_handleInboundRequest_2(this as any, lane, frame); }

  private async handleDesktopBridgeRequest(
    id: string,
    type: string,
    frame: AgentPlatformRealtimeFrame,
  ) { return RealtimeBroker_handleDesktopBridgeRequest_3(this as any, id, type, frame); }

  private async awaitRunActionReadiness(
    action: string,
    source: Record<string, unknown>,
    signal: AbortSignal,
  ) { return RealtimeBroker_awaitRunActionReadiness_4(this as any, action, source, signal); }

  private async sendDesktopBridgeSuccess(
    id: string,
    type: string,
    result: Record<string, unknown>,
    signal: AbortSignal,
  ) { return RealtimeBroker_sendDesktopBridgeSuccess_5(this as any, id, type, result, signal); }

  private sendDesktopBridgeChunk(id: string, streamId: string, seq: number, type: string, chunk: string) { return RealtimeBroker_sendDesktopBridgeChunk_6(this as any, id, streamId, seq, type, chunk); }

  private sendDesktopBridgeError(id: string, type: string, code: number, msg: string, data?: unknown) { return RealtimeBroker_sendDesktopBridgeError_7(this as any, id, type, code, msg, data); }

  private waitForCloneRun(
    kind: "overview" | "debug",
    observerToken: string,
    runIdValue: string,
    chatIdValue: string,
    owner: AgentWebclientRunOwner,
    consumerId: string,
  ) { return RealtimeBroker_waitForCloneRun_1(this as any, kind, observerToken, runIdValue, chatIdValue, owner, consumerId); }

  private notifyPendingClones(run: BrokerRun) { return RealtimeBroker_notifyPendingClones_2(this as any, run); }

  private rejectPendingClones(observerToken: string, error: Error) { return RealtimeBroker_rejectPendingClones_3(this as any, observerToken, error); }

  private detachPendingClones(observerToken: string) { return RealtimeBroker_detachPendingClones_4(this as any, observerToken); }

  private pruneRetainedTerminalRuns() { return RealtimeBroker_pruneRetainedTerminalRuns_5(this as any); }

  private hasSystemRunLease(run: BrokerRun) { return RealtimeBroker_hasSystemRunLease_6(this as any, run); }

  private detachRunIfUnobserved(run: BrokerRun, reason: string) { return RealtimeBroker_detachRunIfUnobserved_7(this as any, run, reason); }

  private cleanupPending(upstreamId: string) { return RealtimeBroker_cleanupPending_8(this as any, upstreamId); }

  private prepareConnectionIdentity(baseUrl: string, token: string) { return RealtimeBroker_prepareConnectionIdentity_9(this as any, baseUrl, token); }
}

export * from "./realtime-broker.shared";
