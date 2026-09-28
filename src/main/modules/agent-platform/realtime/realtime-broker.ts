import type { App } from "electron";
import type {
  AgentAuthIssueResult,
  AgentWebclientConnectionPhase,
  AgentWebclientRunOwner,
} from "../../../../shared/contracts";
import type { SiteControlScope } from "../../web-surfaces";
import {
  AgentPlatformRealtimeClient,
  type AgentPlatformRealtimeConnectionState,
  type AgentPlatformRealtimeFrame,
  type AgentPlatformRealtimeSocketFactory,
  type RealtimeIdentityRotationReason,
} from "./agent-platform-realtime-client";
import { createConnection } from "./connection";
import { createDesktopRequests } from "./desktop-requests";
import { createDiagnostics } from "./diagnostics";
import { createQuery } from "./query";
import {
  BrokerRun,
  ConnectionSubscription,
  DesktopBridgeRequestProvider,
  PendingClone,
  PendingRequest,
  PushSubscription,
  QueryTransaction,
  RealtimeLane,
  RealtimeQueryCompleted,
  RealtimeQueryHandle,
  RootObserverIdentity,
  RootObserverState,
  RunActionGrant,
  RunSubscription,
} from "./realtime-broker.shared";
import { RealtimeDebugTraceBuffer } from "./realtime-debug-trace";
import { createRootObservers } from "./root-observers";
import { createRunAttachment } from "./run-attachment";
import { createRunChannels } from "./run-channels";
import { RunSiteControlGrants } from "./run-site-control-grants";
import { createSubscriptions } from "./subscriptions";

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
  private readonly siteControlGrants = new RunSiteControlGrants();
  private readonly runActionGrants = new Map<string, RunActionGrant>();
  private activeRootObserver: RootObserverState | null = null;
  private mainChatRootObserver: RootObserverState | null = null;
  private readonly auxiliaryRootObservers = new Map<string, RootObserverState>();
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

  private readonly connectionController: ReturnType<typeof createConnection>;
  private readonly rootObserversController: ReturnType<typeof createRootObservers>;
  private readonly queryController: ReturnType<typeof createQuery>;
  private readonly runChannelsController: ReturnType<typeof createRunChannels>;
  private readonly runAttachmentController: ReturnType<typeof createRunAttachment>;
  private readonly subscriptionsController: ReturnType<typeof createSubscriptions>;
  private readonly desktopRequestsController: ReturnType<typeof createDesktopRequests>;
  private readonly diagnosticsController: ReturnType<typeof createDiagnostics>;

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
    onArtifactPublished?(event: Record<string, unknown>): void;
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
    this.connectionStates = { primary: idleState(), btw: idleState(), "selection-explain": idleState() };
    const laneSources = {
      primary: "desktop-main",
      btw: "desktop-btw",
      "selection-explain": "desktop-explain",
    } as const;
    const createClient = (lane: RealtimeLane) => new AgentPlatformRealtimeClient({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      getDesktopDeviceId: options.getDesktopDeviceId,
      createWebSocket: options.createWebSocket,
      connectTimeoutMs: options.connectTimeoutMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      source: laneSources[lane],
      surfaceId: lane === "primary" ? undefined : laneSources[lane],
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
    // Constructing a client does not open a socket. All Desktop platforms open
    // the explanation connection only when its first consumer requests it.
    this.clients = {
      primary: createClient("primary"),
      btw: createClient("btw"),
      "selection-explain": createClient("selection-explain"),
    };
    const broker = this;
    this.connectionController = createConnection({
      get connectionStates() { return broker.connectionStates; },
      get clients() { return broker.clients; },
      get disposed() { return broker.disposed; },
      set disposed(value) { broker.disposed = value; },
      get acceptingDelivery() { return broker.acceptingDelivery; },
      set acceptingDelivery(value) { broker.acceptingDelivery = value; },
      getRunChannel: (...args) => this.getRunChannel(...args),
      get pendingRequests() { return broker.pendingRequests; },
      get options() { return broker.options; },
      get diagnostics() { return broker.diagnostics; },
      get runChannels() { return broker.runChannels; },
      get queriesByRequestId() { return broker.queriesByRequestId; },
      failQuery: (...args) => this.failQuery(...args),
      get runSubscriptions() { return broker.runSubscriptions; },
      get pendingClones() { return broker.pendingClones; },
      get activeRootObserver() { return broker.activeRootObserver; },
      set activeRootObserver(value) { broker.activeRootObserver = value; },
      get mainChatRootObserver() { return broker.mainChatRootObserver; },
      set mainChatRootObserver(value) { broker.mainChatRootObserver = value; },
      get auxiliaryRootObservers() { return broker.auxiliaryRootObservers; },
      get terminalRequestIds() { return broker.terminalRequestIds; },
      clearRunActionGrants: (...args) => this.clearRunActionGrants(...args),
      get inboundDesktopRequests() { return broker.inboundDesktopRequests; },
      get seenInboundDesktopRequestIds() { return broker.seenInboundDesktopRequestIds; },
      get pushSubscriptions() { return broker.pushSubscriptions; },
      get connectionSubscriptions() { return broker.connectionSubscriptions; },
      get desktopBridgeProvider() { return broker.desktopBridgeProvider; },
      set desktopBridgeProvider(value) { broker.desktopBridgeProvider = value; },
      hasSystemRunLease: (...args) => this.hasSystemRunLease(...args),
      restoreRun: (...args) => this.restoreRun(...args),
      handlePush: (...args) => this.handlePush(...args),
      handleInboundRequest: (...args) => this.handleInboundRequest(...args),
      handleQueryStream: (...args) => this.handleQueryStream(...args),
      handleRunStream: (...args) => this.handleRunStream(...args),
      completeRun: (...args) => this.completeRun(...args),
    });
    this.rootObserversController = createRootObservers({
      get mainChatRootObserver() { return broker.mainChatRootObserver; },
      set mainChatRootObserver(value) { broker.mainChatRootObserver = value; },
      get activeRootObserver() { return broker.activeRootObserver; },
      set activeRootObserver(value) { broker.activeRootObserver = value; },
      get auxiliaryRootObservers() { return broker.auxiliaryRootObservers; },
      detachPendingClones: (...args) => this.detachPendingClones(...args),
      get runSubscriptions() { return broker.runSubscriptions; },
      unsubscribe: (...args) => this.unsubscribe(...args),
      getRunChannel: (...args) => this.getRunChannel(...args),
      get runChannels() { return broker.runChannels; },
      detachRunIfUnobserved: (...args) => this.detachRunIfUnobserved(...args),
      pruneRetainedTerminalRuns: (...args) => this.pruneRetainedTerminalRuns(...args),
    });
    this.queryController = createQuery({
      get acceptingDelivery() { return broker.acceptingDelivery; },
      set acceptingDelivery(value) { broker.acceptingDelivery = value; },
      prepareConnectionIdentity: (...args) => this.prepareConnectionIdentity(...args),
      getRunChannel: (...args) => this.getRunChannel(...args),
      findRootObserver: (...args) => this.findRootObserver(...args),
      get queriesByRequestId() { return broker.queriesByRequestId; },
      ensureConnected: (...args) => this.ensureConnected(...args),
      get runChannels() { return broker.runChannels; },
      get options() { return broker.options; },
      get clients() { return broker.clients; },
      consumeRunEvent: (...args) => this.consumeRunEvent(...args),
      releaseRunObserver: (...args) => this.releaseRunObserver(...args),
      completeRun: (...args) => this.completeRun(...args),
      get diagnostics() { return broker.diagnostics; },
      appendReplay: (...args) => this.appendReplay(...args),
      setRunChannel: (...args) => this.setRunChannel(...args),
      notifyPendingClones: (...args) => this.notifyPendingClones(...args),
      detachRunIfUnobserved: (...args) => this.detachRunIfUnobserved(...args),
      get runSubscriptions() { return broker.runSubscriptions; },
      replayToSubscriber: (...args) => this.replayToSubscriber(...args),
      get siteControlGrants() { return broker.siteControlGrants; },
      deleteRunChannel: (...args) => this.deleteRunChannel(...args),
      unsubscribe: (...args) => this.unsubscribe(...args),
      get pendingClones() { return broker.pendingClones; },
    });
    this.runChannelsController = createRunChannels({
      get runChannels() { return broker.runChannels; },
      get runSubscriptions() { return broker.runSubscriptions; },
      releaseRunObserver: (...args) => this.releaseRunObserver(...args),
      get diagnostics() { return broker.diagnostics; },
      get siteControlGrants() { return broker.siteControlGrants; },
      get options() { return broker.options; },
      revokeRunActionGrant: (...args) => this.revokeRunActionGrant(...args),
      get terminalRequestIds() { return broker.terminalRequestIds; },
      get queriesByRequestId() { return broker.queriesByRequestId; },
      get inboundDesktopRequests() { return broker.inboundDesktopRequests; },
      get pushSubscriptions() { return broker.pushSubscriptions; },
    });
    this.runAttachmentController = createRunAttachment({
      get queriesByRequestId() { return broker.queriesByRequestId; },
      get terminalRequestIds() { return broker.terminalRequestIds; },
      unsubscribe: (...args) => this.unsubscribe(...args),
      get diagnostics() { return broker.diagnostics; },
      getRunChannel: (...args) => this.getRunChannel(...args),
      ensureConnected: (...args) => this.ensureConnected(...args),
      get runChannels() { return broker.runChannels; },
      hasSystemRunLease: (...args) => this.hasSystemRunLease(...args),
      get clients() { return broker.clients; },
      forwardRequest: (...args) => this.forwardRequest(...args),
    });
    this.subscriptionsController = createSubscriptions({
      findRootObserver: (...args) => this.findRootObserver(...args),
      get runSubscriptions() { return broker.runSubscriptions; },
      get pendingClones() { return broker.pendingClones; },
      get queriesByRequestId() { return broker.queriesByRequestId; },
      get mainChatRootObserver() { return broker.mainChatRootObserver; },
      set mainChatRootObserver(value) { broker.mainChatRootObserver = value; },
      getRunChannel: (...args) => this.getRunChannel(...args),
      replayToSubscriber: (...args) => this.replayToSubscriber(...args),
      get diagnostics() { return broker.diagnostics; },
      get acceptingDelivery() { return broker.acceptingDelivery; },
      set acceptingDelivery(value) { broker.acceptingDelivery = value; },
      get pushSubscriptions() { return broker.pushSubscriptions; },
      get connectionSubscriptions() { return broker.connectionSubscriptions; },
      get clients() { return broker.clients; },
      prepareConnectionIdentity: (...args) => this.prepareConnectionIdentity(...args),
      setRunChannel: (...args) => this.setRunChannel(...args),
      startAttach: (...args) => this.startAttach(...args),
      detachRunIfUnobserved: (...args) => this.detachRunIfUnobserved(...args),
      get pendingRequests() { return broker.pendingRequests; },
      cleanupPending: (...args) => this.cleanupPending(...args),
      get lastCloneCancellationReason() { return broker.lastCloneCancellationReason; },
      set lastCloneCancellationReason(value) { broker.lastCloneCancellationReason = value; },
    });
    this.desktopRequestsController = createDesktopRequests({
      get desktopBridgeProvider() { return broker.desktopBridgeProvider; },
      set desktopBridgeProvider(value) { broker.desktopBridgeProvider = value; },
      get runActionGrants() { return broker.runActionGrants; },
      get siteControlGrants() { return broker.siteControlGrants; },
      get clients() { return broker.clients; },
      get inboundDesktopRequests() { return broker.inboundDesktopRequests; },
      get seenInboundDesktopRequestIds() { return broker.seenInboundDesktopRequestIds; },
      getRunChannel: (...args) => this.getRunChannel(...args),
    });
    this.diagnosticsController = createDiagnostics({
      get clients() { return broker.clients; },
      getConnectionStates: (...args) => this.getConnectionStates(...args),
      get pendingRequests() { return broker.pendingRequests; },
      get queriesByRequestId() { return broker.queriesByRequestId; },
      get runChannels() { return broker.runChannels; },
      get runSubscriptions() { return broker.runSubscriptions; },
      get pushSubscriptions() { return broker.pushSubscriptions; },
      get connectionSubscriptions() { return broker.connectionSubscriptions; },
      getActiveRootObserver: (...args) => this.getActiveRootObserver(...args),
      get auxiliaryRootObservers() { return broker.auxiliaryRootObservers; },
      snapshotRootObserver: (...args) => this.snapshotRootObserver(...args),
      get mainChatRootObserver() { return broker.mainChatRootObserver; },
      set mainChatRootObserver(value) { broker.mainChatRootObserver = value; },
      get pendingClones() { return broker.pendingClones; },
      get lastCloneCancellationReason() { return broker.lastCloneCancellationReason; },
      set lastCloneCancellationReason(value) { broker.lastCloneCancellationReason = value; },
      hasSystemRunLease: (...args) => this.hasSystemRunLease(...args),
      get diagnostics() { return broker.diagnostics; },
      get debugTrace() { return broker.debugTrace; },
    });
  }

  getConnectionPhase(): AgentWebclientConnectionPhase { return this.connectionController.getConnectionPhase(); }

  getConnectionState(lane: RealtimeLane = "primary") { return this.connectionController.getConnectionState(lane); }

  getConnectionStates() { return this.connectionController.getConnectionStates(); }

  setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null) { return this.desktopRequestsController.setDesktopBridgeProvider(provider); }

  private getRunChannel(runIdValue: string, lane?: RealtimeLane) { return this.runChannelsController.getRunChannel(runIdValue, lane); }

  private setRunChannel(run: BrokerRun) { return this.runChannelsController.setRunChannel(run); }

  private deleteRunChannel(run: BrokerRun) { return this.runChannelsController.deleteRunChannel(run); }

  private findRootObserver(tokenValue: string) { return this.rootObserversController.findRootObserver(tokenValue); }

  private snapshotRootObserver(observer: RootObserverState | null) { return this.rootObserversController.snapshotRootObserver(observer); }

  async ensureConnected(baseUrl: string, token: string, lane: RealtimeLane = "primary") { return this.connectionController.ensureConnected(baseUrl, token, lane); }

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
    siteControlScope?: SiteControlScope;
  }): RealtimeQueryHandle { return this.queryController.query(options); }

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
  }) { return this.connectionController.forwardRequest(options); }

  activateRootObserver(input: RootObserverIdentity) { return this.rootObserversController.activateRootObserver(input); }

  getActiveRootObserver() { return this.rootObserversController.getActiveRootObserver(); }

  getMainChatRootObserver() { return this.rootObserversController.getMainChatRootObserver(); }

  promoteMainChatRootObserver(tokenValue: string, chatIdValue: string) { return this.rootObserversController.promoteMainChatRootObserver(tokenValue, chatIdValue); }

  releaseRootObserver(tokenValue: string, reason = "parent_observer_closed") { return this.rootObserversController.releaseRootObserver(tokenValue, reason); }

  releaseObservedRun(observerTokenValue: string, runIdValue: string, reason = "surface_inactive") { return this.rootObserversController.releaseObservedRun(observerTokenValue, runIdValue, reason); }

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
  }) { return this.subscriptionsController.subscribeClone(options); }

  subscribePush(options: {
    types: string[];
    filter?: { chatId?: string; runId?: string; resourceId?: string };
    kind: "surface" | "internal" | "desktop-ws";
    consumerId: string;
    onPush(frame: AgentPlatformRealtimeFrame): void;
  }) { return this.subscriptionsController.subscribePush(options); }

  subscribeConnection(options: {
    consumerId: string;
    onState(state: AgentPlatformRealtimeConnectionState): void;
    lane?: RealtimeLane;
  }) { return this.subscriptionsController.subscribeConnection(options); }

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
  }) { return this.subscriptionsController.subscribeRun(options); }

  unsubscribe(subscriptionId: string) { return this.subscriptionsController.unsubscribe(subscriptionId); }

  registerRunActionGrant(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }) { return this.desktopRequestsController.registerRunActionGrant(input); }

  revokeRunActionGrant(runIdValue: string) { return this.desktopRequestsController.revokeRunActionGrant(runIdValue); }

  private clearRunActionGrants() { return this.desktopRequestsController.clearRunActionGrants(); }

  cleanupConsumer(consumerId: string) { return this.subscriptionsController.cleanupConsumer(consumerId); }

  getDiagnostics() { return this.diagnosticsController.getDiagnostics(); }

  appendDebugTrace(input: Parameters<RealtimeDebugTraceBuffer["append"]>[0]) { return this.diagnosticsController.appendDebugTrace(input); }

  getDebugTraceEntries() { return this.diagnosticsController.getDebugTraceEntries(); }

  clearDebugTrace() { return this.diagnosticsController.clearDebugTrace(); }

  rotateIdentity(reason: RealtimeIdentityRotationReason = "explicit_identity_invalidation") { return this.connectionController.rotateIdentity(reason); }

  beginShutdown() { return this.connectionController.beginShutdown(); }

  dispose() { return this.connectionController.dispose(); }

  private handleConnectionState(lane: RealtimeLane, state: AgentPlatformRealtimeConnectionState) { return this.connectionController.handleConnectionState(lane, state); }

  private handleFrame(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame, generation: number) { return this.connectionController.handleFrame(lane, frame, generation); }

  private handleQueryStream(transaction: QueryTransaction, frame: AgentPlatformRealtimeFrame) { return this.queryController.handleQueryStream(transaction, frame); }

  private handleRunStream(run: BrokerRun, frame: AgentPlatformRealtimeFrame) { return this.runChannelsController.handleRunStream(run, frame); }

  private releaseRunObserver(
    run: BrokerRun,
    requestId: string,
    reason: string,
    lastSeq: unknown,
  ) { return this.runAttachmentController.releaseRunObserver(run, requestId, reason, lastSeq); }

  private consumeRunEvent(
    run: BrokerRun,
    event: Record<string, unknown>,
    transaction: QueryTransaction | null,
  ) { return this.runChannelsController.consumeRunEvent(run, event, transaction); }

  private appendReplay(
    run: BrokerRun,
    event: Record<string, unknown>,
    seq: number | null,
    path?: string,
  ) { return this.runChannelsController.appendReplay(run, event, seq, path); }

  private replayToSubscriber(run: BrokerRun, subscription: RunSubscription) { return this.runChannelsController.replayToSubscriber(run, subscription); }

  private completeRun(
    run: BrokerRun,
    result: RealtimeQueryCompleted,
    source: NonNullable<BrokerRun["terminalSource"]>,
  ) { return this.runChannelsController.completeRun(run, result, source); }

  private failQuery(transaction: QueryTransaction, error: unknown) { return this.queryController.failQuery(transaction, error); }

  private async startAttach(run: BrokerRun, baseUrl: string, token: string) { return this.runAttachmentController.startAttach(run, baseUrl, token); }

  private async restoreRun(run: BrokerRun) { return this.runAttachmentController.restoreRun(run); }

  private handlePush(frame: AgentPlatformRealtimeFrame) { return this.runChannelsController.handlePush(frame); }

  private handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame) { return this.desktopRequestsController.handleInboundRequest(lane, frame); }

  private notifyPendingClones(run: BrokerRun) { return this.subscriptionsController.notifyPendingClones(run); }

  private detachPendingClones(observerToken: string) { return this.subscriptionsController.detachPendingClones(observerToken); }

  private pruneRetainedTerminalRuns() { return this.runChannelsController.pruneRetainedTerminalRuns(); }

  private hasSystemRunLease(run: BrokerRun) { return this.rootObserversController.hasSystemRunLease(run); }

  private detachRunIfUnobserved(run: BrokerRun, reason: string) { return this.runAttachmentController.detachRunIfUnobserved(run, reason); }

  private cleanupPending(upstreamId: string) { return this.connectionController.cleanupPending(upstreamId); }

  private prepareConnectionIdentity(baseUrl: string, token: string) { return this.connectionController.prepareConnectionIdentity(baseUrl, token); }
}

export * from "./realtime-broker.shared";
