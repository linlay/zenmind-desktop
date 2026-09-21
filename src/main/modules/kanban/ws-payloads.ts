import type { KanbanEnvelope, KanbanDesktopSyncCursor, KanbanDesktopDelivery, KanbanDesktopIssueEvent } from "./ws-model";
import type { KanbanCloudSnapshot } from "./store-model";
import { isRecord, readText, readNonNegativeInteger } from "./ws-values";
import { envelopeBusinessType, ISSUE_EVENT_TYPES } from "./ws-protocol";
import type { AssistantStartRunRequest } from "../../../shared/contracts";

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
  return [];
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
