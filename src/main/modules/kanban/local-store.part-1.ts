import fs from "node:fs";

import path from "node:path";

import { createHash, randomUUID } from "node:crypto";

import { DatabaseSync } from "node:sqlite";

import type { App } from "electron";

import type {
  AssistantAttachment,
  KanbanCloudDetailData,
  KanbanCurrentUser,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanOrigin,
  KanbanPriority,
  KanbanProject,
  KanbanProjectBinding,
  KanbanRunState,
  KanbanStatus,
  KanbanSyncMode,
  KanbanSyncState
} from "../../../shared/contracts";

import {
  KANBAN_RUN_STATES,
  KANBAN_STATUSES,
  parseKanbanPriority
} from "../../../shared/contracts";

import { getRuntimeDataRoot } from "../../infrastructure/filesystem/user-paths";

import { t } from "../../support/i18n/main-i18n";

export type AppPathProvider = {
  getPath(name: Parameters<App["getPath"]>[0]): string;
};

export type KanbanIssueRow = {
  id: string;
  remote_issue_id: string | null;
  board_id: string;
  project_id: string;
  workflow_id: string;
  type_id: string | null;
  stage_id: string | null;
  stage_name: string | null;
  status_id: string | null;
  status_name: string | null;
  title: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority | null;
  severity: KanbanIssue["severity"];
  assignee_agent_key: string | null;
  assignee_id: string | null;
  worker_type: KanbanIssue["workerType"];
  worker_id: string | null;
  worker_agent: string | null;
  active_review_id: string | null;
  active_run_id: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
  run_state: KanbanRunState | null;
  dispatch_state: KanbanIssue["dispatchState"];
  dispatch_device_id: string | null;
  dispatch_command_id: string | null;
  dispatch_updated_at: string | null;
  automation_id: string | null;
  automation_enabled: number;
  automation_cron: string | null;
  automation_message: string | null;
  automation_timezone: string | null;
  attachment_chat_id: string | null;
  attachments_json: string;
  detail_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  sync_mode: KanbanSyncMode;
  sync_state: KanbanSyncState;
  origin: KanbanOrigin;
  owner_user_id: string;
  last_remote_revision: number;
  last_synced_at: string | null;
  sync_error: string | null;
};

export type KanbanProjectRow = {
  id: string;
  parent_id: string | null;
  slug: string;
  key: string;
  name: string;
  description: string;
  versions_json: string;
  components_json: string;
  path: string;
  depth: number;
  position: number;
  revision: number;
  visibility: string;
  default_workflow_id: string;
  created_at: string;
  updated_at: string;
};

export type KanbanProjectBindingRow = {
  id: string;
  project_id: string;
  device_id: string;
  current_user_id: string;
  local_project_id: string;
  local_display_name: string;
  sync_policy: KanbanProjectBinding["syncPolicy"];
  control_mode: KanbanProjectBinding["controlMode"];
  status: KanbanProjectBinding["status"];
  last_remote_revision: number;
  created_at: string;
  updated_at: string;
};

export type KanbanCloudSnapshot = {
  boardId?: string;
  projectId?: string;
  projectIds?: string[];
  revision?: number;
  lastSeq?: number;
  complete?: boolean;
  scope?: string;
  projects?: unknown[];
  projectBindings?: unknown[];
  issues?: unknown[];
  users?: unknown[];
  issueTypes?: unknown[];
  issueFieldDefs?: unknown[];
  issueFieldContexts?: unknown[];
  issueFieldOptions?: unknown[];
  workflows?: unknown[];
  workflowStageDefs?: unknown[];
  workflowStatusDefs?: unknown[];
  workflowStages?: unknown[];
  workflowStatuses?: unknown[];
  workflowTransitions?: unknown[];
  workflowDecomposeRules?: unknown[];
  teams?: unknown[];
  teamMembers?: unknown[];
  projectPermissions?: unknown[];
  issueLabels?: unknown[];
  issueLabelLinks?: unknown[];
  issueDependencies?: unknown[];
  reviews?: unknown[];
  issueStageWorkers?: unknown[];
  issueChats?: unknown[];
  issueRuns?: unknown[];
  issueComments?: unknown[];
  recentEvents?: unknown[];
};

export type KanbanDesktopSyncCursor = {
  lastAckedDeliverySeq: number;
  lastAppliedRevision: number;
  cacheSchemaVersion: number;
};

export type KanbanCommandReceiptState = "received" | "starting" | "started" | "completed" | "failed";

export type KanbanCommandReceipt = {
  commandId: string;
  deliverySeq: number;
  projectId: string;
  issueId: string;
  issueRunId: string;
  commandType: "run" | "review";
  payload: Record<string, unknown>;
  payloadHash: string;
  chatId: string;
  runId: string;
  requestId: string;
  state: KanbanCommandReceiptState;
  attemptCount: number;
  lastError: string | null;
  terminalReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KanbanCloudMutationOutboxItem = {
  id: string;
  requestType: "issue.claim";
  projectId: string;
  issueId: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
};

export type KanbanRunEventOutboxItem = {
  clientEventId: string;
  projectId: string;
  issueId: string;
  issueRunId: string;
  externalRunId: string;
  runId: string;
  chatId: string;
  eventType: string;
  sourceDeliverySeq: number;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
};

export type KanbanManualRunReceiptState = "starting" | "started" | "completed" | "failed" | "cancelled";

export type KanbanManualRunReceipt = {
  issueRunId: string;
  runId: string;
  chatId: string;
  issueId: string;
  projectId: string;
  agentKey: string;
  state: KanbanManualRunReceiptState;
  lastError: string | null;
};

export const BOARD_ID = "default";

export const PROJECT_ID = "default";

export const WORKFLOW_ID = "workflow-standard-requirement";

export const ISSUE_TYPE_ID = "issue-type-standard-requirement";

export const DATABASE_DIRECTORY = "desktop-kanban";

export const DATABASE_FILENAME = "kanban.db";

export const DATABASE_SCHEMA_VERSION = 2;

export const SYNC_CACHE_SCHEMA_VERSION = 1;

export function nowIso() {
  return new Date().toISOString();
}

export function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function nullableTrimmedText(value: unknown) {
  const text = trimText(value);
  return text ? text : null;
}

export function normalizeKanbanStatus(value: unknown): KanbanStatus {
  const raw = trimText(value).toLowerCase();
  return KANBAN_STATUSES.includes(raw as KanbanStatus) ? raw as KanbanStatus : "backlog";
}

export function normalizeKanbanPriority(value: unknown): KanbanPriority | null {
  return parseKanbanPriority(value);
}

export function normalizeKanbanSeverity(value: unknown): KanbanIssue["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null;
}

export function normalizeKanbanRunState(value: unknown): KanbanRunState | null {
  return typeof value === "string" && KANBAN_RUN_STATES.includes(value as KanbanRunState)
    ? value as KanbanRunState
    : null;
}

export function normalizeWorkerType(value: unknown): KanbanIssue["workerType"] {
  return value === "human" || value === "agent" ? value : null;
}

export function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(trimText).filter(Boolean))];
}

export function normalizeEffortSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  const seconds = Math.trunc(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

export function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function parseAttachmentsJson(value: string | null | undefined): AssistantAttachment[] {
  if (!value) return [];
  try {
    return normalizeAttachments(JSON.parse(value));
  } catch {
    return [];
  }
}

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function normalizeCustomFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeDueDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= maxDay
    ? `${yearText}-${monthText}-${dayText}`
    : undefined;
}

export function readLegacyDueDate(dueTime: unknown, dueAt: unknown): string | null | undefined {
  if (dueTime === null || dueAt === null) return null;
  if (typeof dueTime === "string") {
    const datePrefix = /^(\d{4}-\d{2}-\d{2})T/u.exec(dueTime.trim())?.[1];
    if (datePrefix) return normalizeDueDate(datePrefix);
  }
  if (typeof dueAt === "number" && Number.isSafeInteger(dueAt) && dueAt >= 0) {
    const date = new Date(dueAt);
    if (!Number.isNaN(date.getTime())) {
      const pad = (part: number) => String(part).padStart(2, "0");
      return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
  }
  return undefined;
}

export function readStoredDueDate(detail: Record<string, unknown>): KanbanIssue["dueDate"] {
  const canonical = normalizeDueDate(detail.dueDate);
  return canonical !== undefined ? canonical : readLegacyDueDate(detail.dueTime, detail.dueAt);
}

export function buildIssueDetailJson(issue: KanbanIssue) {
  return JSON.stringify({
    projectPath: issue.projectPath ?? "",
    projectName: issue.projectName ?? "",
    projectVersion: issue.projectVersion ?? null,
    dueDate: issue.dueDate ?? null,
    dueRisk: issue.dueRisk ?? null,
    resolution: issue.resolution ?? null,
    securityLevelKey: issue.securityLevelKey ?? null,
    reporterId: issue.reporterId ?? null,
    componentKeys: normalizeStringList(issue.componentKeys),
    originalEstimate: Math.max(0, Math.trunc(issue.originalEstimate || 0)),
    remainingEstimate: Math.max(0, Math.trunc(issue.remainingEstimate || 0)),
    timeSpent: Math.max(0, Math.trunc(issue.timeSpent || 0)),
    parentIssueId: issue.parentIssueId ?? null,
    issueTypeKey: issue.issueTypeKey ?? issue.typeId ?? "",
    stageKey: issue.stageKey ?? "",
    statusKey: issue.statusKey ?? "",
    columnKey: issue.columnKey ?? "",
    customFields: issue.customFields ?? {},
    activeIssueRunId: issue.activeIssueRunId ?? null,
    runAgentKey: issue.runAgentKey ?? null,
    runCommandId: issue.runCommandId ?? null,
    runStartedAt: issue.runStartedAt ?? null,
    runFinishedAt: issue.runFinishedAt ?? null,
    runResultMessage: issue.runResultMessage ?? null,
    runErrorMessage: issue.runErrorMessage ?? null,
    createdBy: issue.createdBy ?? null,
    updatedBy: issue.updatedBy ?? null,
    createdByAgent: issue.createdByAgent ?? null,
    updatedByAgent: issue.updatedByAgent ?? null
  });
}

export function emptyCloudDetailData(): KanbanCloudDetailData {
  return {
    users: [],
    issueTypes: [],
    issueFieldDefs: [],
    issueFieldContexts: [],
    issueFieldOptions: [],
    workflows: [],
    workflowStageDefs: [],
    workflowStatusDefs: [],
    workflowStages: [],
    workflowStatuses: [],
    workflowTransitions: [],
    workflowDecomposeRules: [],
    teams: [],
    teamMembers: [],
    projectPermissions: [],
    issueLabels: [],
    issueLabelLinks: [],
    issueDependencies: [],
    reviews: [],
    issueStageWorkers: [],
    issueChats: [],
    issueRuns: [],
    issueComments: [],
    recentEvents: []
  };
}

export const CLOUD_DETAIL_KEYS = [
  "users",
  "issueTypes",
  "issueFieldDefs",
  "issueFieldContexts",
  "issueFieldOptions",
  "workflows",
  "workflowStageDefs",
  "workflowStatusDefs",
  "workflowStages",
  "workflowStatuses",
  "workflowTransitions",
  "workflowDecomposeRules",
  "teams",
  "teamMembers",
  "projectPermissions",
  "issueLabels",
  "issueLabelLinks",
  "issueDependencies",
  "reviews",
  "issueStageWorkers",
  "issueChats",
  "issueRuns",
  "issueComments",
  "recentEvents"
] as const satisfies ReadonlyArray<keyof KanbanCloudDetailData>;

export function parseCloudDetailData(value: string | null | undefined): KanbanCloudDetailData {
  const record = parseJsonRecord(value);
  const detail = emptyCloudDetailData();
  for (const key of CLOUD_DETAIL_KEYS) {
    if (Array.isArray(record[key])) {
      (detail[key] as unknown[]) = record[key] as unknown[];
    }
  }
  return detail;
}

export function detailItemKey(key: keyof KanbanCloudDetailData, item: unknown, index: number) {
  const record = parseCloudIssue(item);
  if (!record) return `${key}:${index}`;
  if (key === "issueTypes") return trimText(record.key) || `${key}:${index}`;
  if (key === "teamMembers") return `${trimText(record.teamId)}:${trimText(record.userId)}`;
  if (key === "issueLabelLinks") return `${trimText(record.issueId)}:${trimText(record.labelId)}`;
  return String(record.id ?? `${key}:${index}`);
}

export function mergeCloudDetailArray(key: keyof KanbanCloudDetailData, current: unknown[], incoming: unknown[]) {
  const merged = new Map(current.map((item, index) => [detailItemKey(key, item, index), item]));
  incoming.forEach((item, index) => merged.set(detailItemKey(key, item, index), item));
  return [...merged.values()];
}

export function selectCloudDetailData(db: DatabaseSync, currentUser: KanbanCurrentUser): KanbanCloudDetailData {
  const row = db.prepare(`
    SELECT PAYLOAD_JSON_ AS payloadJson
    FROM kanban_cloud_detail_cache
    WHERE OWNER_USER_ID_ = ?
  `).get(currentUser.id) as { payloadJson?: string } | undefined;
  return parseCloudDetailData(row?.payloadJson);
}

export function storeCloudDetailData(
  db: DatabaseSync,
  currentUser: KanbanCurrentUser,
  snapshot: KanbanCloudSnapshot,
  revision: number
) {
  const replace = snapshot.complete === true && snapshot.scope === "project_set";
  const current = replace ? emptyCloudDetailData() : selectCloudDetailData(db, currentUser);
  for (const key of CLOUD_DETAIL_KEYS) {
    const incoming = snapshot[key];
    if (replace) {
      (current[key] as unknown[]) = Array.isArray(incoming) ? incoming : [];
    } else if (Array.isArray(incoming)) {
      (current[key] as unknown[]) = mergeCloudDetailArray(key, current[key] as unknown[], incoming);
    }
  }
  db.prepare(`
    INSERT INTO kanban_cloud_detail_cache (OWNER_USER_ID_, REVISION_, PAYLOAD_JSON_, UPDATED_AT_)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(OWNER_USER_ID_) DO UPDATE SET
      REVISION_ = excluded.REVISION_,
      PAYLOAD_JSON_ = excluded.PAYLOAD_JSON_,
      UPDATED_AT_ = excluded.UPDATED_AT_
  `).run(currentUser.id, revision, JSON.stringify(current), nowIso());
}

export function parseCloudIssue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createLocalIssueId(db: DatabaseSync) {
  let tick = Math.floor(Date.now() / 100);
  const exists = db.prepare("SELECT 1 FROM issue WHERE ID_ = ? LIMIT 1");
  while (true) {
    const id = `local-${tick.toString(36).toUpperCase()}`;
    if (!exists.get(id)) return id;
    tick += 1;
  }
}

export function createCloudCacheIssueId() {
  return `cloud_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function getDesktopKanbanDatabasePath(app: AppPathProvider) {
  return path.join(getRuntimeDataRoot(app as App), DATABASE_DIRECTORY, DATABASE_FILENAME);
}
