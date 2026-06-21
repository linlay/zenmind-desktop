import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  TaskBoardCurrentUser,
  TaskBoardIssueResult,
  TaskBoardListResult,
  TaskBoardProject
} from "../shared/contracts";
import type { TaskBoardCloudSnapshot } from "./task-board-local-store";
import { t } from "./i18n/main-i18n";

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

type KanbanEnvelope = {
  v?: number;
  frame?: "request" | "response" | "push" | "stream" | string;
  type?: string;
  id?: string;
  role?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  payload?: unknown;
  ok?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
};

type PendingRequest = {
  messageType: string;
  resolve: (payload: KanbanEnvelope) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type KanbanDesktopConnectionState = NonNullable<TaskBoardListResult["connectionState"]>;

export type KanbanDesktopWsConfig = {
  serverUrl: string;
  token?: string;
  selectedProjectId?: string;
};

export type KanbanDesktopDeviceInfo = {
  deviceName: string;
  deviceAlias?: string;
  hostname?: string;
  username?: string;
};

export type KanbanDesktopSyncCursor = {
  lastAckedDeliverySeq: number;
  lastAppliedRevision: number;
  cacheSchemaVersion?: number;
};

export type KanbanDesktopSyncLocalProject = {
  projectId: string;
  localProjectId: string;
  localDisplayName: string;
  controlMode?: string;
};

export type KanbanDesktopDelivery = {
  deliveryId?: number;
  deviceId?: string;
  deliverySeq: number;
  projectId?: string | null;
  localProjectId?: string | null;
  kind: string;
  sourceRevision?: number | null;
  commandId?: string | null;
  eventType: string;
  payload?: unknown;
  status?: string;
};

export type KanbanDesktopDeliveryApplyResult = {
  ok: boolean;
  lastAppliedRevision?: number;
  message?: string;
};

export type KanbanDesktopWsClientOptions = {
  capabilities: string[];
  getCurrentUser: () => TaskBoardCurrentUser;
  getDeviceId: () => string;
  getDeviceInfo?: () => KanbanDesktopDeviceInfo;
  getSyncCursor?: () => KanbanDesktopSyncCursor;
  onSyncCursor?: (cursor: KanbanDesktopSyncCursor) => void;
  onSnapshot: (snapshot: TaskBoardCloudSnapshot) => void;
  onDelivery?: (delivery: KanbanDesktopDelivery) => Promise<KanbanDesktopDeliveryApplyResult>;
  onDispatchIssue: (
    issue: unknown,
    revision: number
  ) => TaskBoardIssueResult;
  onListAgents: () => Promise<DesktopPetAgentOption[]>;
  onStartRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  onAutomationSync: (payload: unknown) => Promise<unknown>;
  onListLocalProjects: () => Promise<{ ok: boolean; projects: TaskBoardProject[]; message?: string }>;
  onListSyncLocalProjects?: () => Promise<KanbanDesktopSyncLocalProject[]>;
  onCreateLocalProject: (payload: unknown) => Promise<unknown>;
  onBindProject: (payload: unknown) => Promise<unknown>;
  onUnbindProject: (payload: unknown) => Promise<unknown>;
  onConnected?: () => void;
  onStateChanged?: (state: KanbanDesktopConnectionState) => void;
  onDebug?: (message: string) => void;
};

const PROTOCOL_VERSION = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 5_000;
const WS_OPEN_STATE = 1;

function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function createWsUrl(config: KanbanDesktopWsConfig) {
  const url = new URL("/ws", config.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "desktop");
  url.searchParams.set("v", String(PROTOCOL_VERSION));
  if (config.token?.trim()) {
    url.searchParams.set("token", config.token.trim());
  }
  return url.toString();
}

function createWsLogUrl(config: KanbanDesktopWsConfig) {
  const url = new URL(createWsUrl(config));
  if (url.searchParams.has("token")) {
    url.searchParams.set("token", "***");
  }
  return url.toString();
}

function createRequestId() {
  return `desktop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wsEventDetail(event: unknown) {
  if (!isRecord(event)) {
    return "";
  }
  const parts: string[] = [];
  if (typeof event.type === "string" && event.type) {
    parts.push(`type=${event.type}`);
  }
  if (typeof event.code === "number") {
    parts.push(`code=${event.code}`);
  }
  if (typeof event.reason === "string" && event.reason) {
    parts.push(`reason=${event.reason}`);
  }
  if (typeof event.message === "string" && event.message) {
    parts.push(`message=${event.message}`);
  }
  return parts.join(" ");
}

async function decodeMessageData(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (isRecord(data) && typeof data.text === "function") {
    const text = await (data as { text: () => Promise<unknown> }).text();
    return typeof text === "string" ? text : String(text ?? "");
  }
  if (isRecord(data) && typeof data.arrayBuffer === "function") {
    const buffer = await (data as { arrayBuffer: () => Promise<unknown> }).arrayBuffer();
    if (buffer instanceof ArrayBuffer) {
      return Buffer.from(buffer).toString("utf8");
    }
  }
  return String(data ?? "");
}

function normalizeSnapshot(payload: unknown, env: KanbanEnvelope): TaskBoardCloudSnapshot {
  const record = isRecord(payload) ? payload : {};
  return {
    boardId: readText(record.boardId) || readText(env.boardId),
    projectId: readText(record.projectId) || readText(env.projectId),
    revision: typeof record.revision === "number" ? record.revision : env.revision,
    complete: record.complete === true,
    scope: readText(record.scope),
    projects: Array.isArray(record.projects) ? record.projects : [],
    projectBindings: Array.isArray(record.projectBindings) ? record.projectBindings : [],
    issues: Array.isArray(record.issues) ? record.issues : []
  };
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeSyncCursor(value: unknown): KanbanDesktopSyncCursor {
  const record = isRecord(value) ? value : {};
  const cacheSchemaVersion = readNonNegativeInteger(record.cacheSchemaVersion);
  return {
    lastAckedDeliverySeq: readNonNegativeInteger(record.lastAckedDeliverySeq),
    lastAppliedRevision: readNonNegativeInteger(record.lastAppliedRevision),
    cacheSchemaVersion: cacheSchemaVersion > 0 ? cacheSchemaVersion : 1
  };
}

function normalizeDelivery(value: unknown): KanbanDesktopDelivery | null {
  const record = isRecord(value) ? value : null;
  if (!record) {
    return null;
  }
  const deliverySeq = readNonNegativeInteger(record.deliverySeq);
  const kind = readText(record.kind);
  const eventType = readText(record.eventType);
  if (deliverySeq <= 0 || !kind || !eventType) {
    return null;
  }
  const sourceRevision = readNonNegativeInteger(record.sourceRevision);
  return {
    deliveryId: readNonNegativeInteger(record.deliveryId) || undefined,
    deviceId: readText(record.deviceId) || undefined,
    deliverySeq,
    projectId: readText(record.projectId) || null,
    localProjectId: readText(record.localProjectId) || null,
    kind,
    sourceRevision: sourceRevision > 0 ? sourceRevision : null,
    commandId: readText(record.commandId) || null,
    eventType,
    payload: record.payload,
    status: readText(record.status) || undefined
  };
}

function normalizeDeliveries(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const rawItems = Array.isArray(record.items) ? record.items : Array.isArray(payload) ? payload : [];
  return rawItems
    .map((item) => normalizeDelivery(item))
    .filter((item): item is KanbanDesktopDelivery => Boolean(item))
    .sort((a, b) => a.deliverySeq - b.deliverySeq);
}

function normalizeStartRunPayload(payload: unknown, env: KanbanEnvelope): AssistantStartRunRequest {
  const record = isRecord(payload) ? payload : {};
  const request: AssistantStartRunRequest = {
    message: readText(record.message),
    agentKey: readText(record.agentKey) || undefined,
    accessLevel: normalizeAccessLevel(record.accessLevel),
    chatId: readText(record.chatId) || null,
    source: "sidebar"
  };
  if ("issue" in record) {
    request.issue = record.issue;
  }
  if (typeof env.revision === "number") {
    request.revision = env.revision;
  }
  return request;
}

function normalizeAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

function normalizeMessageType(messageType: string) {
  const trimmed = messageType.trim();
  if (!trimmed) {
    throw new Error(t("taskBoard.ws.messageTypeRequired"));
  }
  const blockedKanbanPrefix = `kanban${"."}`;
  const blockedDesktopHello = `desktop${"."}hello`;
  const blockedDesktopKanbanPrefix = `desktop${"."}kanban${"."}`;
  if (trimmed.startsWith(blockedKanbanPrefix) || trimmed === blockedDesktopHello || trimmed.startsWith(blockedDesktopKanbanPrefix)) {
    throw new Error(t("taskBoard.ws.legacyDisabled", { type: trimmed }));
  }
  return trimmed;
}

function isV2Envelope(env: KanbanEnvelope) {
  return env.v === PROTOCOL_VERSION && readText(env.frame) !== "" && readText(env.type) !== "";
}

function envelopeBusinessType(env: KanbanEnvelope) {
  return readText(env.type);
}

function isResponseEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) && env.frame === "response";
}

function isRequestEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) && env.frame === "request";
}

function isSnapshotPushEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "snapshot.updated";
}

function isSyncDeliverPushEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "sync.deliver";
}

export class KanbanDesktopWsClient {
  private ws: MinimalWebSocket | null = null;
  private config: KanbanDesktopWsConfig | null = null;
  private state: KanbanDesktopConnectionState = "disabled";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();
  private snapshotReady = false;
  private queuedDeliveries: KanbanDesktopDelivery[] = [];

  constructor(private readonly options: KanbanDesktopWsClientOptions) {}

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
      this.options.onDebug?.(t("taskBoard.ws.projectSelected", { projectId: selectedProjectId }));
    } catch (error) {
      this.options.onDebug?.(t("taskBoard.ws.projectSelectFailed", { message: errorMessage(error) }));
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
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
    if (!this.ws || this.state !== "open" || !this.config) {
      throw new Error(t("taskBoard.cloudSync.notConnected"));
    }
    const wasSnapshotReady = this.snapshotReady;
    this.snapshotReady = false;
    try {
      const snapshot = await this.request<TaskBoardCloudSnapshot>("snapshot.get", {
        projectId: this.config.selectedProjectId ?? "default",
        deviceId: this.options.getDeviceId()
      });
      this.options.onSnapshot(snapshot);
      this.snapshotReady = true;
      await this.flushQueuedDeliveries();
      await this.pullDeliveries(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAckedDeliverySeq);
      this.options.onConnected?.();
    } catch (error) {
      this.snapshotReady = wasSnapshotReady;
      throw error;
    }
  }

  async request<TPayload = unknown>(messageType: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TPayload> {
    if (!this.ws || this.state !== "open") {
      throw new Error(t("taskBoard.cloudSync.notConnected"));
    }
    const id = createRequestId();
    const response = await new Promise<KanbanEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(t("taskBoard.ws.requestTimeout", { type: messageType })));
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
        projectId: this.config?.selectedProjectId ?? "default",
        payload
      });
      if (!sent) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(t("taskBoard.cloudSync.notConnected")));
      }
    });
    if (response.ok === false) {
      throw new Error(response.error?.message || t("taskBoard.ws.operationFailed", { type: messageType }));
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
      this.options.onDebug?.(t("taskBoard.ws.unsupportedRuntime"));
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.clearReconnectTimer();
    this.closeWebSocket("kanban desktop ws reconnect");
    this.snapshotReady = false;
    this.queuedDeliveries = [];
    this.setState("connecting");
    try {
      const wsUrl = createWsUrl(config);
      this.options.onDebug?.(t("taskBoard.ws.connecting", { url: createWsLogUrl(config) }));
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
        this.options.onDebug?.(detail ? t("taskBoard.ws.errorWithDetail", { detail }) : t("taskBoard.ws.error"));
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
    this.options.onDebug?.(t("taskBoard.ws.opened"));
    this.setState("open");
    this.snapshotReady = false;
    try {
      const agents = await this.options.onListAgents().catch((error) => {
        this.options.onDebug?.(t("taskBoard.ws.helloAgentsFailed", { message: errorMessage(error) }));
        return [];
      });
      let localProjects: KanbanDesktopSyncLocalProject[] = [];
      if (this.options.onListSyncLocalProjects) {
        localProjects = await this.options.onListSyncLocalProjects().catch((error) => {
          this.options.onDebug?.(t("taskBoard.ws.projectSelectFailed", { message: errorMessage(error) }));
          return [];
        });
      }
      const currentUser = this.options.getCurrentUser();
      const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
      const hello = await this.request<{ cursor?: unknown }>("sync.hello", {
        capabilities: this.options.capabilities,
        deviceId: this.options.getDeviceId(),
        ownerUserId: currentUser.id,
        ...this.options.getDeviceInfo?.(),
        selectedProjectId: this.config?.selectedProjectId ?? "default",
        lastAckedDeliverySeq: cursor.lastAckedDeliverySeq,
        lastAppliedRevision: cursor.lastAppliedRevision,
        cacheSchemaVersion: cursor.cacheSchemaVersion ?? 1,
        localProjects,
        agents
      });
      if (isRecord(hello) && hello.cursor) {
        this.options.onSyncCursor?.(normalizeSyncCursor(hello.cursor));
      }
      const snapshot = await this.request<TaskBoardCloudSnapshot>("snapshot.get", {
        projectId: this.config?.selectedProjectId ?? "default",
        deviceId: this.options.getDeviceId()
      });
      this.options.onSnapshot(snapshot);
      this.snapshotReady = true;
      await this.flushQueuedDeliveries();
      await this.pullDeliveries(normalizeSyncCursor(this.options.getSyncCursor?.()).lastAckedDeliverySeq);
      this.options.onConnected?.();
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
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
      this.options.onDebug?.(t("taskBoard.ws.messageReadFailed", { message: errorMessage(error) }));
      return;
    }
    let env: KanbanEnvelope;
    try {
      env = JSON.parse(raw) as KanbanEnvelope;
    } catch (error) {
      this.options.onDebug?.(t("taskBoard.ws.messageParseFailed", { message: errorMessage(error) }));
      return;
    }
    if (!isV2Envelope(env) || !["request", "response", "push"].includes(readText(env.frame))) {
      this.closeProtocolError("kanban v3 envelope required");
      return;
    }
    if (isResponseEnvelope(env) && env.id) {
      this.options.onDebug?.(t("taskBoard.ws.receivedResponse", { type: envelopeBusinessType(env) || "unknown", id: env.id }));
      this.resolvePending(env);
      return;
    }
    if (isRequestEnvelope(env)) {
      this.options.onDebug?.(t("taskBoard.ws.receivedRequest", { type: envelopeBusinessType(env) || "unknown", id: env.id || "" }));
      void this.handleServerRequest(env);
      return;
    }
    if (isSnapshotPushEnvelope(env)) {
      this.options.onSnapshot(normalizeSnapshot(env.payload, env));
      return;
    }
    if (isSyncDeliverPushEnvelope(env)) {
      void this.handleDeliveryPush(env);
    }
  }

  private async handleDeliveryPush(env: KanbanEnvelope) {
    const deliveries = normalizeDeliveries(env.payload);
    if (deliveries.length === 0) {
      return;
    }
    if (!this.snapshotReady) {
      this.queuedDeliveries.push(...deliveries);
      this.queuedDeliveries.sort((a, b) => a.deliverySeq - b.deliverySeq);
      return;
    }
    try {
      await this.applyAndAckDeliveries(deliveries);
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
    }
  }

  private async flushQueuedDeliveries() {
    if (this.queuedDeliveries.length === 0) {
      return;
    }
    const deliveries = this.queuedDeliveries;
    this.queuedDeliveries = [];
    await this.applyAndAckDeliveries(deliveries);
  }

  private async pullDeliveries(afterDeliverySeq: number) {
    let nextAfter = Math.max(0, Math.floor(afterDeliverySeq));
    for (;;) {
      const result = await this.request<{ items?: unknown[]; hasMore?: boolean; nextDeliverySeq?: number }>("sync.pull", {
        deviceId: this.options.getDeviceId(),
        afterDeliverySeq: nextAfter,
        limit: 100
      });
      const deliveries = normalizeDeliveries(result);
      if (deliveries.length === 0) {
        return;
      }
      await this.applyAndAckDeliveries(deliveries);
      nextAfter = deliveries[deliveries.length - 1].deliverySeq;
      if (!result.hasMore) {
        return;
      }
    }
  }

  private async applyAndAckDeliveries(deliveries: KanbanDesktopDelivery[]) {
    for (const delivery of deliveries.sort((a, b) => a.deliverySeq - b.deliverySeq)) {
      const cursor = normalizeSyncCursor(this.options.getSyncCursor?.());
      if (delivery.deliverySeq <= cursor.lastAckedDeliverySeq) {
        continue;
      }
      const expectedDeliverySeq = cursor.lastAckedDeliverySeq + 1;
      if (delivery.deliverySeq !== expectedDeliverySeq) {
        this.options.onDebug?.(t("taskBoard.ws.deliverySeqGap", {
          expected: expectedDeliverySeq,
          actual: delivery.deliverySeq
        }));
        return;
      }
      const result = this.options.onDelivery
        ? await this.options.onDelivery(delivery)
        : { ok: true, lastAppliedRevision: cursor.lastAppliedRevision };
      if (!result.ok) {
        this.options.onDebug?.(result.message || t("taskBoard.ws.operationFailed", { type: delivery.eventType }));
        return;
      }
      const sourceRevision = typeof delivery.sourceRevision === "number" ? delivery.sourceRevision : 0;
      const lastAppliedRevision = Math.max(
        cursor.lastAppliedRevision,
        result.lastAppliedRevision ?? 0,
        sourceRevision
      );
      const ack = await this.request<{ cursor?: unknown }>("sync.ack", {
        deviceId: this.options.getDeviceId(),
        ackedDeliverySeq: delivery.deliverySeq,
        lastAppliedRevision
      });
      if (isRecord(ack) && ack.cursor) {
        this.options.onSyncCursor?.(normalizeSyncCursor(ack.cursor));
      } else {
        this.options.onSyncCursor?.({
          ...cursor,
          lastAckedDeliverySeq: delivery.deliverySeq,
          lastAppliedRevision
        });
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
        throw new Error(t("taskBoard.ws.unsupportedBusiness", { type: businessType || "unknown" }));
      }
      this.options.onDebug?.(t("taskBoard.ws.repliedRequest", { type: businessType || "unknown", id: env.id || "" }));
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
      pending.reject(new Error(env.error?.message || t("taskBoard.ws.operationFailed", { type: pending.messageType })));
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
      error: ok ? undefined : { code: "desktop_error", message: message || t("taskBoard.ws.desktopFailed") },
      payload
    });
  }

  private closeProtocolError(reason: string) {
    this.options.onDebug?.(t("taskBoard.ws.protocolError", { reason }));
    this.rejectAllPending(new Error(reason));
    this.closeWebSocket(reason, 1002);
    this.setState("error");
    this.scheduleReconnect();
  }

  private sendEnvelope(env: KanbanEnvelope) {
    const socket = this.ws;
    if (!socket || !this.isSocketReady(socket)) {
      this.options.onDebug?.(t("taskBoard.ws.sendNotReady", { readyState: socket?.readyState ?? "none" }));
      this.handleClosed("error");
      return false;
    }
    try {
      socket.send(JSON.stringify(env));
      if (isResponseEnvelope(env)) {
        this.options.onDebug?.(t("taskBoard.ws.sentResponse", { type: envelopeBusinessType(env) || "unknown", id: env.id || "" }));
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
    this.options.onDebug?.(detail ? t("taskBoard.ws.closedWithDetail", { detail }) : t("taskBoard.ws.closed"));
    this.rejectAllPending(new Error(t("taskBoard.ws.disconnected")));
    this.closeWebSocket(`kanban desktop ws ${nextState}`);
    this.setState(nextState);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || !this.config || this.reconnectTimer) {
      return;
    }
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
    this.options.onStateChanged?.(state);
  }
}
