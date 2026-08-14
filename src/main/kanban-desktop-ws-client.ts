import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  KanbanIssueResult,
  KanbanListResult,
  KanbanProject
} from "../shared/contracts";
import type { KanbanCloudSnapshot } from "./kanban-local-store";
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

export type KanbanDesktopConnectionState = NonNullable<KanbanListResult["connectionState"]>;

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

export type KanbanDesktopIssueEvent = {
  seq: number;
  eventType: string;
  projectId?: string | null;
  issueId?: string;
  deletedIssueId?: string;
  issue?: unknown;
  reason?: string;
  fromProjectId?: string;
  toProjectId?: string;
  payload?: unknown;
  actor?: unknown;
  createdAt?: string;
};

export type KanbanDesktopDeliveryApplyResult = {
  ok: boolean;
  lastAppliedRevision?: number;
  message?: string;
};

export type KanbanDesktopIssueEventApplyResult = KanbanDesktopDeliveryApplyResult;

export type KanbanDesktopWsLogEntry = {
  event: "frame";
  direction: "send" | "recv";
  bytes: number;
  envelope: unknown;
};

export type KanbanDesktopWsClientOptions = {
  capabilities: string[];
  getDeviceId: () => string;
  getDeviceInfo?: () => KanbanDesktopDeviceInfo;
  getSyncCursor?: () => KanbanDesktopSyncCursor;
  onSyncCursor?: (cursor: KanbanDesktopSyncCursor) => void;
  onSnapshot: (snapshot: KanbanCloudSnapshot) => void;
  onDelivery?: (delivery: KanbanDesktopDelivery) => Promise<KanbanDesktopDeliveryApplyResult>;
  onDeliveryAcked?: (delivery: KanbanDesktopDelivery) => void | Promise<void>;
  onIssueEvent?: (event: KanbanDesktopIssueEvent) => Promise<KanbanDesktopIssueEventApplyResult>;
  onDispatchIssue: (
    issue: unknown,
    revision: number
  ) => KanbanIssueResult;
  onListAgents: () => Promise<DesktopPetAgentOption[]>;
  onStartRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  onAutomationSync: (payload: unknown) => Promise<unknown>;
  onListLocalProjects: () => Promise<{ ok: boolean; projects: KanbanProject[]; message?: string }>;
  onListSyncLocalProjects?: () => Promise<KanbanDesktopSyncLocalProject[]>;
  onCreateLocalProject: (payload: unknown) => Promise<unknown>;
  onBindProject: (payload: unknown) => Promise<unknown>;
  onUnbindProject: (payload: unknown) => Promise<unknown>;
  onConnected?: () => void;
  onContractNegotiated?: (contractVersion: string, capabilities: string[]) => void;
  onStateChanged?: (state: KanbanDesktopConnectionState) => void;
  onDebug?: (message: string) => void;
  onWsLog?: (entry: KanbanDesktopWsLogEntry) => void;
};

const PROTOCOL_VERSION = 1;
const CONTRACT_VERSION = "1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 5_000;
const WS_OPEN_STATE = 1;

export class KanbanDesktopRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KanbanDesktopRequestError";
  }
}
const ISSUE_EVENT_TYPES = new Set([
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.moved",
  "issue.claimed"
]);

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
  url.searchParams.set("contractVersion", CONTRACT_VERSION);
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

function assertCloudPayloadPrivacy(env: KanbanEnvelope) {
  if (env.frame !== "request") return;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    if ("syncMode" in value && value.syncMode !== "cloud") return true;
    if ("filePath" in value || "localFilePath" in value) return true;
    if (typeof value.path === "string" && (/^\//u.test(value.path) || /^[A-Za-z]:[\\/]/u.test(value.path))) return true;
    if (Array.isArray(value.attachments) && value.attachments.some((attachment) =>
      isRecord(attachment) && ("text" in attachment || "data" in attachment || "filePath" in attachment || "path" in attachment)
    )) return true;
    if (value.origin === "desktop" && ("title" in value || "attachments" in value || "filePath" in value || "path" in value)) return true;
    return Object.values(value).some(visit);
  };
  if (visit(env.payload)) {
    throw new Error("local kanban payload must never be sent to cloud");
  }
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

function normalizeSnapshot(payload: unknown, env: KanbanEnvelope): KanbanCloudSnapshot {
  const record = isRecord(payload) ? payload : {};
  return {
    boardId: readText(record.boardId) || readText(env.boardId),
    projectId: readText(record.projectId) || readText(env.projectId),
    projectIds: Array.isArray(record.projectIds) ? record.projectIds.map(readText).filter(Boolean) : [],
    revision: typeof record.revision === "number" ? record.revision : env.revision,
    lastSeq: typeof record.lastSeq === "number" ? record.lastSeq : undefined,
    complete: record.complete === true,
    scope: readText(record.scope),
    projects: Array.isArray(record.projects) ? record.projects : [],
    projectBindings: Array.isArray(record.projectBindings) ? record.projectBindings : [],
    issues: Array.isArray(record.issues) ? record.issues : [],
    users: Array.isArray(record.users) ? record.users : [],
    issueTypes: Array.isArray(record.issueTypes) ? record.issueTypes : [],
    issueFieldDefs: Array.isArray(record.issueFieldDefs) ? record.issueFieldDefs : [],
    issueFieldContexts: Array.isArray(record.issueFieldContexts) ? record.issueFieldContexts : [],
    issueFieldOptions: Array.isArray(record.issueFieldOptions) ? record.issueFieldOptions : [],
    workflows: Array.isArray(record.workflows) ? record.workflows : [],
    workflowStageDefs: Array.isArray(record.workflowStageDefs) ? record.workflowStageDefs : [],
    workflowStatusDefs: Array.isArray(record.workflowStatusDefs) ? record.workflowStatusDefs : [],
    workflowStages: Array.isArray(record.workflowStages) ? record.workflowStages : [],
    workflowStatuses: Array.isArray(record.workflowStatuses) ? record.workflowStatuses : [],
    workflowTransitions: Array.isArray(record.workflowTransitions) ? record.workflowTransitions : [],
    workflowDecomposeRules: Array.isArray(record.workflowDecomposeRules) ? record.workflowDecomposeRules : [],
    teams: Array.isArray(record.teams) ? record.teams : [],
    teamMembers: Array.isArray(record.teamMembers) ? record.teamMembers : [],
    projectPermissions: Array.isArray(record.projectPermissions) ? record.projectPermissions : [],
    issueLabels: Array.isArray(record.issueLabels) ? record.issueLabels : [],
    issueLabelLinks: Array.isArray(record.issueLabelLinks) ? record.issueLabelLinks : [],
    issueDependencies: Array.isArray(record.issueDependencies) ? record.issueDependencies : [],
    reviews: Array.isArray(record.reviews) ? record.reviews : [],
    issueStageWorkers: Array.isArray(record.issueStageWorkers) ? record.issueStageWorkers : [],
    issueChats: Array.isArray(record.issueChats) ? record.issueChats : [],
    issueRuns: Array.isArray(record.issueRuns) ? record.issueRuns : [],
    issueComments: Array.isArray(record.issueComments) ? record.issueComments : [],
    recentEvents: Array.isArray(record.recentEvents) ? record.recentEvents : []
  };
}

function snapshotProjectScopeIds(snapshot: KanbanCloudSnapshot) {
  const explicit = (snapshot.projectIds ?? []).map(readText).filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];
  const projectRecords = (snapshot.projects ?? [])
    .map((project) => isRecord(project) ? readText(project.id) : "")
    .filter(Boolean);
  if (projectRecords.length > 0) return [...new Set(projectRecords)];
  const legacyProjectId = readText(snapshot.projectId);
  return legacyProjectId ? [legacyProjectId] : [];
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

function normalizeIssueEvent(value: unknown, env?: KanbanEnvelope): KanbanDesktopIssueEvent | null {
  const record = isRecord(value) ? value : {};
  const eventType = readText(record.eventType) || (env ? envelopeBusinessType(env) : "");
  if (!ISSUE_EVENT_TYPES.has(eventType)) {
    return null;
  }
  const seq = readNonNegativeInteger(record.seq) ||
    readNonNegativeInteger(record.revision) ||
    (env ? readNonNegativeInteger(env.revision) : 0);
  if (seq <= 0) {
    return null;
  }
  const issue = "issue" in record ? record.issue : undefined;
  const issueRecord = isRecord(issue) ? issue : {};
  const issueId = readText(record.issueId) ||
    readText(record.deletedIssueId) ||
    readText(issueRecord.id);
  return {
    seq,
    eventType,
    projectId: readText(record.projectId) || (env ? readText(env.projectId) : "") || null,
    issueId: issueId || undefined,
    deletedIssueId: readText(record.deletedIssueId) || undefined,
    issue,
    payload: record,
    actor: record.actor,
    createdAt: readText(record.createdAt) || undefined,
    reason: readText(record.reason) || undefined,
    fromProjectId: readText(record.fromProjectId) || undefined,
    toProjectId: readText(record.toProjectId) || undefined
  };
}

function normalizeIssueEvents(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const rawEvents = Array.isArray(record.events) ? record.events : Array.isArray(payload) ? payload : [];
  return rawEvents
    .map((event) => normalizeIssueEvent(event))
    .filter((event): event is KanbanDesktopIssueEvent => Boolean(event))
    .sort((a, b) => a.seq - b.seq);
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
    throw new Error(t("kanban.ws.messageTypeRequired"));
  }
  const blockedKanbanPrefix = `kanban${"."}`;
  const blockedDesktopHello = `desktop${"."}hello`;
  const blockedDesktopKanbanPrefix = `desktop${"."}kanban${"."}`;
  if (trimmed.startsWith(blockedKanbanPrefix) || trimmed === blockedDesktopHello || trimmed.startsWith(blockedDesktopKanbanPrefix)) {
    throw new Error(t("kanban.ws.legacyDisabled", { type: trimmed }));
  }
  return trimmed;
}

function isV1Envelope(env: KanbanEnvelope) {
  return env.v === PROTOCOL_VERSION && readText(env.frame) !== "" && readText(env.type) !== "";
}

function envelopeBusinessType(env: KanbanEnvelope) {
  return readText(env.type);
}

function isResponseEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "response";
}

function isRequestEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "request";
}

function isSnapshotPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "snapshot.updated";
}

function isProjectEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && [
    "project.created",
    "project.updated",
    "project.deleted",
    "project.restored",
    "project.accessRevoked"
  ].includes(envelopeBusinessType(env));
}

function isSyncDeliverPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "sync.deliver";
}

function isIssueEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && ISSUE_EVENT_TYPES.has(envelopeBusinessType(env));
}

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
