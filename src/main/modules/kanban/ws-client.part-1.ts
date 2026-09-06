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

export type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

export type KanbanEnvelope = {
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

export type PendingRequest = {
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

export const PROTOCOL_VERSION = 1;

export const CONTRACT_VERSION = "1.0";

export const REQUEST_TIMEOUT_MS = 30_000;

export const RECONNECT_MS = 5_000;

export const WS_OPEN_STATE = 1;

export class KanbanDesktopRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KanbanDesktopRequestError";
  }
}

export const ISSUE_EVENT_TYPES = new Set([
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.moved",
  "issue.claimed"
]);

export function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function createWsUrl(config: KanbanDesktopWsConfig) {
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

export function createWsLogUrl(config: KanbanDesktopWsConfig) {
  const url = new URL(createWsUrl(config));
  if (url.searchParams.has("token")) {
    url.searchParams.set("token", "***");
  }
  return url.toString();
}

export function createRequestId() {
  return `desktop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function assertCloudPayloadPrivacy(env: KanbanEnvelope) {
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

export function wsEventDetail(event: unknown) {
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

export async function decodeMessageData(data: unknown) {
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

export function normalizeSnapshot(payload: unknown, env: KanbanEnvelope): KanbanCloudSnapshot {
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

export function snapshotProjectScopeIds(snapshot: KanbanCloudSnapshot) {
  const explicit = (snapshot.projectIds ?? []).map(readText).filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];
  const projectRecords = (snapshot.projects ?? [])
    .map((project) => isRecord(project) ? readText(project.id) : "")
    .filter(Boolean);
  if (projectRecords.length > 0) return [...new Set(projectRecords)];
  const legacyProjectId = readText(snapshot.projectId);
  return legacyProjectId ? [legacyProjectId] : [];
}

export function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeSyncCursor(value: unknown): KanbanDesktopSyncCursor {
  const record = isRecord(value) ? value : {};
  const cacheSchemaVersion = readNonNegativeInteger(record.cacheSchemaVersion);
  return {
    lastAckedDeliverySeq: readNonNegativeInteger(record.lastAckedDeliverySeq),
    lastAppliedRevision: readNonNegativeInteger(record.lastAppliedRevision),
    cacheSchemaVersion: cacheSchemaVersion > 0 ? cacheSchemaVersion : 1
  };
}

export function normalizeDelivery(value: unknown): KanbanDesktopDelivery | null {
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

export function normalizeDeliveries(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const rawItems = Array.isArray(record.items) ? record.items : Array.isArray(payload) ? payload : [];
  return rawItems
    .map((item) => normalizeDelivery(item))
    .filter((item): item is KanbanDesktopDelivery => Boolean(item))
    .sort((a, b) => a.deliverySeq - b.deliverySeq);
}

export function normalizeIssueEvent(value: unknown, env?: KanbanEnvelope): KanbanDesktopIssueEvent | null {
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

export function normalizeIssueEvents(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const rawEvents = Array.isArray(record.events) ? record.events : Array.isArray(payload) ? payload : [];
  return rawEvents
    .map((event) => normalizeIssueEvent(event))
    .filter((event): event is KanbanDesktopIssueEvent => Boolean(event))
    .sort((a, b) => a.seq - b.seq);
}

export function normalizeStartRunPayload(payload: unknown, env: KanbanEnvelope): AssistantStartRunRequest {
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

export function normalizeAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

export function normalizeMessageType(messageType: string) {
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

export function isV1Envelope(env: KanbanEnvelope) {
  return env.v === PROTOCOL_VERSION && readText(env.frame) !== "" && readText(env.type) !== "";
}

export function envelopeBusinessType(env: KanbanEnvelope) {
  return readText(env.type);
}

export function isResponseEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "response";
}

export function isRequestEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "request";
}

export function isSnapshotPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "snapshot.updated";
}

export function isProjectEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && [
    "project.created",
    "project.updated",
    "project.deleted",
    "project.restored",
    "project.accessRevoked"
  ].includes(envelopeBusinessType(env));
}

export function isSyncDeliverPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "sync.deliver";
}

export function isIssueEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && ISSUE_EVENT_TYPES.has(envelopeBusinessType(env));
}
