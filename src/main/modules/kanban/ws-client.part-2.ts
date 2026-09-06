import { randomUUID } from "node:crypto";

import { Buffer } from "node:buffer";

import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanIssueResult,
  KanbanListResult,
  KanbanProject
} from "../../../shared/contracts";

import type { KanbanCloudSnapshot } from "./local-store";

import { t } from "../../support/i18n/main-i18n";

import { CONTRACT_VERSION, KanbanDesktopConnectionState, KanbanDesktopDelivery, KanbanDesktopIssueEvent, KanbanDesktopRequestError, KanbanDesktopSyncLocalProject, KanbanDesktopWsClientOptions, KanbanDesktopWsConfig, KanbanEnvelope, MinimalWebSocket, PROTOCOL_VERSION, PendingRequest, RECONNECT_MS, REQUEST_TIMEOUT_MS, WS_OPEN_STATE, assertCloudPayloadPrivacy, createRequestId, createWsLogUrl, createWsUrl, decodeMessageData, envelopeBusinessType, errorMessage, getWebSocketConstructor, isIssueEventPushEnvelope, isProjectEventPushEnvelope, isRecord, isRequestEnvelope, isResponseEnvelope, isSnapshotPushEnvelope, isSyncDeliverPushEnvelope, isV1Envelope, normalizeDeliveries, normalizeIssueEvent, normalizeIssueEvents, normalizeMessageType, normalizeSnapshot, normalizeStartRunPayload, normalizeSyncCursor, readNonNegativeInteger, readText, snapshotProjectScopeIds, wsEventDetail } from "./ws-client.part-1";

export class KanbanDesktopWsClient {
  private ws: MinimalWebSocket | null = null;
  private config: KanbanDesktopWsConfig | null = null;
  private state: KanbanDesktopConnectionState = "disabled";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();
  private snapshotReady = false;
  private issueEventsReady = false;
  private queuedDeliveries: KanbanDesktopDelivery[] = [];
  private queuedIssueEvents: KanbanDesktopIssueEvent[] = [];
  private projectScopeIds: string[] = [];
  private desktopLinks: unknown[] = [];
  private resyncPromise: Promise<void> | null = null;
  private queuedProjectResync = false;
  private projectResyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: KanbanDesktopWsClientOptions) {}

  private logFrame(direction: "send" | "recv", envelope: KanbanEnvelope, bytes: number) {
    this.options.onWsLog?.({
      event: "frame",
      direction,
      bytes,
      envelope
    });
  }

  start(config: KanbanDesktopWsConfig | null, options: { forceReconnect?: boolean } = {}) {
    const normalizedConfig = config && config.serverUrl.trim()
      ? {
        serverUrl: config.serverUrl.trim(),
        token: config.token?.trim() ?? "",
        selectedProjectId: config.selectedProjectId?.trim() ?? "default"
      }
      : null;
    this.stopped = false;
    if (!normalizedConfig) {
      this.config = null;
      this.closeWebSocket("kanban desktop ws disabled");
      this.setState("disabled");
      return;
    }
    const previousUrl = this.config ? createWsUrl(this.config) : "";
    const nextUrl = createWsUrl(normalizedConfig);
    const previousProjectId = this.config?.selectedProjectId ?? "";
    this.config = normalizedConfig;
    if (this.ws && previousUrl === nextUrl && previousProjectId === normalizedConfig.selectedProjectId) {
      if (options.forceReconnect) {
        this.connect();
      }
      return;
    }
    if (
      this.ws &&
      previousUrl === nextUrl &&
      previousProjectId !== normalizedConfig.selectedProjectId &&
      this.state === "open"
    ) {
      if (options.forceReconnect) {
        this.connect();
        return;
      }
      // 仅项目变化且连接已打开:走轻量 desktop.project.select,避免整条 WS 重连。
      void this.selectProject(normalizedConfig.selectedProjectId);
      return;
    }
    this.connect();
  }

  private async selectProject(selectedProjectId: string) {
    try {
      await this.request("desktop.project.select", { selectedProjectId });
      this.options.onDebug?.(t("kanban.ws.projectSelected", { projectId: selectedProjectId }));
    } catch (error) {
      this.options.onDebug?.(t("kanban.ws.projectSelectFailed", { message: errorMessage(error) }));
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.projectResyncTimer) {
      clearTimeout(this.projectResyncTimer);
      this.projectResyncTimer = null;
    }
    this.rejectAllPending(new Error("kanban desktop ws stopped"));
    this.closeWebSocket("kanban desktop ws stopped");
    this.setState("disabled");
  }

  getState() {
    return this.state;
  }

  isOpen() {
    return this.state === "open" && Boolean(this.ws);
  }

  async resyncFromCloud() {
    if (this.resyncPromise) {
      return this.resyncPromise;
    }
    this.resyncPromise = this.performCloudResync();
    try {
      await this.resyncPromise;
    } finally {
      this.resyncPromise = null;
      this.scheduleProjectResync();
    }
  }

  private async performCloudResync() {
    if (!this.ws || this.state !== "open" || !this.config) {
      throw new Error(t("kanban.cloudSync.notConnected"));
    }
    const wasSnapshotReady = this.snapshotReady;
    const wasIssueEventsReady = this.issueEventsReady;
    this.snapshotReady = false;
    this.issueEventsReady = false;
    try {
      const snapshot = await this.request<KanbanCloudSnapshot>("snapshot.get", {
        scope: "project_set",
        deviceId: this.options.getDeviceId()
      });
      snapshot.projectBindings = this.desktopLinks;
      this.projectScopeIds = snapshotProjectScopeIds(snapshot);
      this.options.onSnapshot(snapshot);
      this.snapshotReady = true;
      await this.pullIssueEvents(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAppliedRevision);
      this.issueEventsReady = true;
      await this.flushQueuedIssueEvents();
      await this.flushQueuedDeliveries();
      await this.pullDeliveries(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAckedDeliverySeq);
      this.options.onConnected?.();
      this.scheduleProjectResync();
    } catch (error) {
      this.snapshotReady = wasSnapshotReady;
      this.issueEventsReady = wasIssueEventsReady;
      throw error;
    }
  }

  async request<TPayload = unknown>(messageType: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TPayload> {
    return this.requestWithId(messageType, payload, createRequestId(), timeoutMs);
  }

  async requestWithId<TPayload = unknown>(
    messageType: string,
    payload: unknown,
    requestId: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    projectId?: string
  ): Promise<TPayload> {
    return this.requestInternal(messageType, payload, requestId, timeoutMs, projectId, false);
  }

  private async requestInternal<TPayload = unknown>(
    messageType: string,
    payload: unknown,
    requestId: string,
    timeoutMs: number,
    projectId: string | undefined,
    allowConnecting: boolean
  ): Promise<TPayload> {
    if (!this.ws || (!allowConnecting && this.state !== "open") || (allowConnecting && this.state !== "connecting" && this.state !== "open")) {
      throw new Error(t("kanban.cloudSync.notConnected"));
    }
    assertCloudPayloadPrivacy({ frame: "request", payload });
    const id = readText(requestId);
    if (!id) {
      throw new Error(t("kanban.ws.messageTypeRequired"));
    }
    const response = await new Promise<KanbanEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(t("kanban.ws.requestTimeout", { type: messageType })));
          this.handleClosed("error");
        }
      }, timeoutMs);
      this.pending.set(id, { messageType, resolve, reject, timeout });
      const sent = this.sendEnvelope({
        v: PROTOCOL_VERSION,
        frame: "request",
        type: normalizeMessageType(messageType),
        id,
        role: "desktop",
        boardId: "default",
        projectId: readText(projectId) || this.config?.selectedProjectId || "default",
        payload
      });
      if (!sent) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(t("kanban.cloudSync.notConnected")));
      }
    });
    if (response.ok === false) {
      throw new KanbanDesktopRequestError(
        readText(response.error?.code) || "request_rejected",
        response.error?.message || t("kanban.ws.operationFailed", { type: messageType })
      );
    }
    return response.payload as TPayload;
  }

  private connect() {
    const config = this.config;
    if (!config || this.stopped) {
      return;
    }
    const WebSocketConstructor = getWebSocketConstructor();
    if (!WebSocketConstructor) {
      this.options.onDebug?.(t("kanban.ws.unsupportedRuntime"));
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.clearReconnectTimer();
    this.closeWebSocket("kanban desktop ws reconnect");
    this.snapshotReady = false;
    this.issueEventsReady = false;
    this.queuedDeliveries = [];
    this.queuedIssueEvents = [];
    this.projectScopeIds = [];
    this.desktopLinks = [];
    this.queuedProjectResync = false;
    if (this.projectResyncTimer) {
      clearTimeout(this.projectResyncTimer);
      this.projectResyncTimer = null;
    }
    this.setState("connecting");
    try {
      const wsUrl = createWsUrl(config);
      this.options.onDebug?.(t("kanban.ws.connecting", { url: createWsLogUrl(config) }));
      const socket = new WebSocketConstructor(wsUrl);
      this.ws = socket;
      const onOpen = () => {
        void this.handleOpen();
      };
      const onMessage = (event?: unknown) => {
        const data = isRecord(event) && "data" in event ? event.data : undefined;
        void this.handleMessage(data);
      };
      const onClose = (event?: unknown) => this.handleClosed("closed", wsEventDetail(event));
      const onError = (event?: unknown) => {
        const detail = wsEventDetail(event);
        this.options.onDebug?.(detail ? t("kanban.ws.errorWithDetail", { detail }) : t("kanban.ws.error"));
        this.handleClosed("error", detail);
      };
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = (event) => {
          void this.handleMessage(event.data);
        };
        socket.onclose = onClose;
        socket.onerror = onError;
      }
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  private async handleOpen() {
    if (this.stopped) {
      return;
    }
    this.options.onDebug?.(t("kanban.ws.opened"));
    this.snapshotReady = false;
    this.issueEventsReady = false;
    try {
      const agents = await this.options.onListAgents().catch((error) => {
        this.options.onDebug?.(t("kanban.ws.helloAgentsFailed", { message: errorMessage(error) }));
        return [];
      });
      let localProjects: KanbanDesktopSyncLocalProject[] = [];
      if (this.options.onListSyncLocalProjects) {
        localProjects = await this.options.onListSyncLocalProjects().catch((error) => {
          this.options.onDebug?.(t("kanban.ws.projectSelectFailed", { message: errorMessage(error) }));
          return [];
        });
      }
      const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
      const hello = await this.requestInternal<{
        cursor?: unknown;
        links?: unknown[];
        accessibleProjects?: unknown[];
        contractVersion?: string;
        capabilities?: unknown[];
      }>("sync.hello", {
        contractVersion: CONTRACT_VERSION,
        capabilities: this.options.capabilities,
        deviceId: this.options.getDeviceId(),
        ...this.options.getDeviceInfo?.(),
        selectedProjectId: this.config?.selectedProjectId ?? "default",
        lastAckedDeliverySeq: cursor.lastAckedDeliverySeq,
        lastAppliedRevision: cursor.lastAppliedRevision,
        cacheSchemaVersion: cursor.cacheSchemaVersion ?? 1,
        localProjects,
        agents
      }, createRequestId(), REQUEST_TIMEOUT_MS, undefined, true);
      if (readText(hello.contractVersion) !== CONTRACT_VERSION) {
        throw new Error(`kanban contract ${CONTRACT_VERSION} is required`);
      }
      if (isRecord(hello) && hello.cursor) {
        this.options.onSyncCursor?.(normalizeSyncCursor(hello.cursor));
      }
      this.options.onContractNegotiated?.(
        readText(hello.contractVersion),
        Array.isArray(hello.capabilities) ? hello.capabilities.map(readText).filter(Boolean) : []
      );
      this.desktopLinks = Array.isArray(hello.links) ? hello.links : [];
      const snapshot = await this.requestInternal<KanbanCloudSnapshot>("snapshot.get", {
        scope: "project_set",
        projectIds: localProjects.map((project) => project.projectId),
        deviceId: this.options.getDeviceId()
      }, createRequestId(), REQUEST_TIMEOUT_MS, undefined, true);
      if (
        Array.isArray(hello.accessibleProjects) &&
        hello.accessibleProjects.length > 0 &&
        (!Array.isArray(snapshot.projects) || snapshot.projects.length === 0)
      ) {
        throw new Error("kanban project_set snapshot unexpectedly contains no accessible projects");
      }
      snapshot.projectBindings = this.desktopLinks;
      this.projectScopeIds = snapshotProjectScopeIds(snapshot);
      this.options.onSnapshot(snapshot);
      this.snapshotReady = true;
      await this.pullIssueEvents(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAppliedRevision, true);
      this.issueEventsReady = true;
      await this.flushQueuedIssueEvents();
      await this.flushQueuedDeliveries(true);
      await this.pullDeliveries(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAckedDeliverySeq, true);
      this.setState("open");
      this.options.onConnected?.();
      this.scheduleProjectResync();
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
      this.handleClosed("error", errorMessage(error));
    }
  }

  private async handleMessage(data: unknown) {
    if (this.stopped) {
      return;
    }
    let raw: string;
    try {
      raw = await decodeMessageData(data);
    } catch (error) {
      this.options.onDebug?.(t("kanban.ws.messageReadFailed", { message: errorMessage(error) }));
      return;
    }
    let env: KanbanEnvelope;
    try {
      env = JSON.parse(raw) as KanbanEnvelope;
    } catch (error) {
      this.options.onDebug?.(t("kanban.ws.messageParseFailed", { message: errorMessage(error) }));
      return;
    }
    this.logFrame("recv", env, Buffer.byteLength(raw));
    if (!isV1Envelope(env) || !["request", "response", "push"].includes(readText(env.frame))) {
      this.closeProtocolError("kanban v1 envelope required");
      return;
    }
    if (isResponseEnvelope(env) && env.id) {
      this.options.onDebug?.(t("kanban.ws.receivedResponse", { type: envelopeBusinessType(env) || "unknown", id: env.id }));
      this.resolvePending(env);
      return;
    }
    if (isRequestEnvelope(env)) {
      this.options.onDebug?.(t("kanban.ws.receivedRequest", { type: envelopeBusinessType(env) || "unknown", id: env.id || "" }));
      void this.handleServerRequest(env);
      return;
    }
    if (isSnapshotPushEnvelope(env)) {
      const snapshot = normalizeSnapshot(env.payload, env);
      this.options.onSnapshot(snapshot);
      if (snapshot.scope !== "project_set" || snapshot.complete !== true) {
        this.queuedProjectResync = true;
        this.scheduleProjectResync();
      }
      return;
    }
    if (isIssueEventPushEnvelope(env)) {
      void this.handleIssueEventPush(env);
      return;
    }
    if (isProjectEventPushEnvelope(env)) {
      this.queuedProjectResync = true;
      this.scheduleProjectResync();
      return;
    }
    if (isSyncDeliverPushEnvelope(env)) {
      void this.handleDeliveryPush(env);
    }
  }

  private async handleIssueEventPush(env: KanbanEnvelope) {
    const event = normalizeIssueEvent(env.payload, env);
    if (!event) {
      return;
    }
    if (!this.snapshotReady || !this.issueEventsReady) {
      this.queuedIssueEvents.push(event);
      this.queuedIssueEvents.sort((a, b) => a.seq - b.seq);
      return;
    }
    try {
      await this.applyIssueEvents([event]);
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
    }
  }

  private async handleDeliveryPush(env: KanbanEnvelope) {
    const deliveries = normalizeDeliveries(env.payload);
    if (deliveries.length === 0) {
      return;
    }
    if (!this.snapshotReady || !this.issueEventsReady) {
      this.queuedDeliveries.push(...deliveries);
      this.queuedDeliveries.sort((a, b) => a.deliverySeq - b.deliverySeq);
      return;
    }
    try {
      await this.applyAndAckDeliveries(deliveries, this.state === "connecting");
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
    }
  }

  private async flushQueuedDeliveries(allowConnecting = false) {
    if (this.queuedDeliveries.length === 0) {
      return;
    }
    const deliveries = this.queuedDeliveries;
    this.queuedDeliveries = [];
    await this.applyAndAckDeliveries(deliveries, allowConnecting);
  }

  private async flushQueuedIssueEvents() {
    if (this.queuedIssueEvents.length === 0) {
      return;
    }
    const events = this.queuedIssueEvents;
    this.queuedIssueEvents = [];
    await this.applyIssueEvents(events);
  }

  private async pullIssueEvents(afterSeq: number, allowConnecting = false) {
    if (this.projectScopeIds.length === 0) {
      return;
    }
    let nextAfter = Math.max(0, Math.floor(afterSeq));
    for (;;) {
      const result = await this.requestInternal<{ events?: unknown[]; hasMore?: boolean; nextAfterSeq?: number; lastSeq?: number }>("event.pull", {
        projectIds: this.projectScopeIds,
        afterSeq: nextAfter,
        limit: 100
      }, createRequestId(), REQUEST_TIMEOUT_MS, undefined, allowConnecting);
      const events = normalizeIssueEvents(result);
      if (events.length > 0) {
        const applied = await this.applyIssueEvents(events);
        if (!applied) {
          return;
        }
        nextAfter = Math.max(nextAfter, events[events.length - 1].seq);
      }
      if (!result.hasMore) {
        const lastSeq = readNonNegativeInteger(result.lastSeq);
        if (lastSeq > 0) {
          this.advanceIssueCursor(lastSeq);
        }
        return;
      }
      const responseNextAfter = readNonNegativeInteger(result.nextAfterSeq);
      if (responseNextAfter > nextAfter) {
        nextAfter = responseNextAfter;
      } else if (events.length === 0) {
        return;
      }
    }
  }

  private scheduleProjectResync() {
    if (!this.queuedProjectResync || !this.snapshotReady || !this.issueEventsReady || this.resyncPromise || this.projectResyncTimer) {
      return;
    }
    this.projectResyncTimer = setTimeout(() => {
      this.projectResyncTimer = null;
      if (!this.queuedProjectResync) return;
      this.queuedProjectResync = false;
      void this.resyncFromCloud().catch((error) => this.options.onDebug?.(errorMessage(error)));
    }, 0);
  }

  private async applyIssueEvents(events: KanbanDesktopIssueEvent[]) {
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
      if (event.seq <= cursor.lastAppliedRevision) {
        continue;
      }
      const result = this.options.onIssueEvent
        ? await this.options.onIssueEvent(event)
        : { ok: true, lastAppliedRevision: event.seq };
      if (!result.ok) {
        this.options.onDebug?.(result.message || t("kanban.ws.operationFailed", { type: event.eventType }));
        return false;
      }
      this.advanceIssueCursor(Math.max(cursor.lastAppliedRevision, result.lastAppliedRevision ?? 0, event.seq));
    }
    return true;
  }

  private advanceIssueCursor(lastAppliedRevision: number) {
    const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
    const revision = Math.max(cursor.lastAppliedRevision, Math.max(0, Math.floor(lastAppliedRevision)));
    if (revision <= cursor.lastAppliedRevision) {
      return;
    }
    this.options.onSyncCursor?.({
      ...cursor,
      lastAppliedRevision: revision
    });
  }

  private async pullDeliveries(afterDeliverySeq: number, allowConnecting = false) {
    let nextAfter = Math.max(0, Math.floor(afterDeliverySeq));
    for (;;) {
      const result = await this.requestInternal<{ items?: unknown[]; hasMore?: boolean; nextDeliverySeq?: number }>("sync.pull", {
        deviceId: this.options.getDeviceId(),
        afterDeliverySeq: nextAfter,
        limit: 100
      }, createRequestId(), REQUEST_TIMEOUT_MS, undefined, allowConnecting);
      const deliveries = normalizeDeliveries(result);
      if (deliveries.length === 0) {
        return;
      }
      await this.applyAndAckDeliveries(deliveries, allowConnecting);
      nextAfter = deliveries[deliveries.length - 1].deliverySeq;
      if (!result.hasMore) {
        return;
      }
    }
  }

  private async applyAndAckDeliveries(deliveries: KanbanDesktopDelivery[], allowConnecting = false) {
    for (const delivery of deliveries.sort((a, b) => a.deliverySeq - b.deliverySeq)) {
      const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
      if (delivery.deliverySeq <= cursor.lastAckedDeliverySeq) {
        continue;
      }
      const expectedDeliverySeq = cursor.lastAckedDeliverySeq + 1;
      if (delivery.deliverySeq !== expectedDeliverySeq) {
        this.options.onDebug?.(t("kanban.ws.deliverySeqGap", {
          expected: expectedDeliverySeq,
          actual: delivery.deliverySeq
        }));
        return;
      }
      const result = this.options.onDelivery
        ? await this.options.onDelivery(delivery)
        : { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
      if (!result.ok) {
        this.options.onDebug?.(result.message || t("kanban.ws.operationFailed", { type: delivery.eventType }));
        return;
      }
      const sourceRevision = typeof delivery.sourceRevision === "number" ? delivery.sourceRevision : 0;
      const lastAppliedRevision = Math.max(
        cursor.lastAppliedRevision,
        result.lastAppliedRevision ?? 0,
        sourceRevision
      );
      const ack = await this.requestInternal<{ cursor?: unknown }>("sync.ack", {
        deviceId: this.options.getDeviceId(),
        ackedDeliverySeq: delivery.deliverySeq,
        lastAppliedRevision
      }, createRequestId(), REQUEST_TIMEOUT_MS, undefined, allowConnecting);
      if (isRecord(ack) && ack.cursor) {
        this.options.onSyncCursor?.(normalizeSyncCursor(ack.cursor));
      } else {
        this.options.onSyncCursor?.({
          ...cursor,
          lastAckedDeliverySeq: delivery.deliverySeq,
          lastAppliedRevision
        });
      }
      try {
        await this.options.onDeliveryAcked?.(delivery);
      } catch (error) {
        this.options.onDebug?.(errorMessage(error));
      }
    }
  }

  private async handleServerRequest(env: KanbanEnvelope) {
    try {
      let payload: unknown;
      const businessType = envelopeBusinessType(env);
      if (businessType === "desktop.issue.dispatch") {
        const record = isRecord(env.payload) ? env.payload : {};
        const issue = "issue" in record ? record.issue : env.payload;
        payload = this.options.onDispatchIssue(issue, env.revision ?? 0);
      } else if (businessType === "agent.listDesktop") {
        const agents = await this.options.onListAgents();
        payload = { ok: true, items: agents, agents };
      } else if (businessType === "desktop.assistant.startRun") {
        payload = await this.options.onStartRun(normalizeStartRunPayload(env.payload, env));
      } else if (businessType === "automation.sync") {
        payload = await this.options.onAutomationSync(env.payload);
      } else if (businessType === "desktop.project.listLocal") {
        payload = await this.options.onListLocalProjects();
      } else if (businessType === "desktop.project.createLocal") {
        payload = await this.options.onCreateLocalProject(env.payload);
      } else if (businessType === "desktop.project.bind") {
        payload = await this.options.onBindProject(env.payload);
      } else if (businessType === "desktop.project.unbind") {
        payload = await this.options.onUnbindProject(env.payload);
      } else {
        throw new Error(t("kanban.ws.unsupportedBusiness", { type: businessType || "unknown" }));
      }
      this.options.onDebug?.(t("kanban.ws.repliedRequest", { type: businessType || "unknown", id: env.id || "" }));
      this.respond(env, true, payload);
    } catch (error) {
      this.respond(env, false, {
        ok: false,
        message: errorMessage(error)
      }, errorMessage(error));
    }
  }

  private resolvePending(env: KanbanEnvelope) {
    const pending = env.id ? this.pending.get(env.id) : undefined;
    if (!pending || !env.id) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(env.id);
    if (env.ok === false) {
      pending.reject(new Error(env.error?.message || t("kanban.ws.operationFailed", { type: pending.messageType })));
      return;
    }
    pending.resolve(env);
  }

  private respond(env: KanbanEnvelope, ok: boolean, payload: unknown, message = "") {
    return this.sendEnvelope({
      v: PROTOCOL_VERSION,
      frame: "response",
      type: envelopeBusinessType(env),
      id: env.id,
      role: "desktop",
      boardId: env.boardId ?? "default",
      projectId: env.projectId ?? this.config?.selectedProjectId ?? "default",
      revision: env.revision,
      ok,
      error: ok ? undefined : { code: "desktop_error", message: message || t("kanban.ws.desktopFailed") },
      payload
    });
  }

  private closeProtocolError(reason: string) {
    this.options.onDebug?.(t("kanban.ws.protocolError", { reason }));
    this.rejectAllPending(new Error(reason));
    this.closeWebSocket(reason, 1002);
    this.setState("error");
    this.scheduleReconnect();
  }

  private sendEnvelope(env: KanbanEnvelope) {
    const socket = this.ws;
    if (!socket || !this.isSocketReady(socket)) {
      this.options.onDebug?.(t("kanban.ws.sendNotReady", { readyState: socket?.readyState ?? "none" }));
      this.handleClosed("error");
      return false;
    }
    try {
      const serialized = JSON.stringify(env);
      socket.send(serialized);
      this.logFrame("send", env, Buffer.byteLength(serialized));
      if (isResponseEnvelope(env)) {
        this.options.onDebug?.(t("kanban.ws.sentResponse", { type: envelopeBusinessType(env) || "unknown", id: env.id || "" }));
      }
      return true;
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
      this.handleClosed("error");
      return false;
    }
  }

  private isSocketReady(socket: MinimalWebSocket) {
    return typeof socket.readyState !== "number" || socket.readyState === WS_OPEN_STATE;
  }

  private handleClosed(nextState: "closed" | "error", detail = "") {
    if (this.stopped) {
      return;
    }
    this.options.onDebug?.(detail ? t("kanban.ws.closedWithDetail", { detail }) : t("kanban.ws.closed"));
    this.rejectAllPending(new Error(t("kanban.ws.disconnected")));
    this.closeWebSocket(`kanban desktop ws ${nextState}`);
    this.setState(nextState);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || !this.config || this.reconnectTimer) {
      return;
    }
    this.options.onDebug?.(`kanban websocket reconnect scheduled in ${RECONNECT_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private closeWebSocket(reason: string, code = 1000) {
    const socket = this.ws;
    this.ws = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close failures for sockets that are already closing.
    }
  }

  private rejectAllPending(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: KanbanDesktopConnectionState) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onDebug?.(`kanban websocket state=${state}`);
    this.options.onStateChanged?.(state);
  }
}
