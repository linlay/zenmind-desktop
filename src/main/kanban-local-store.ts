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
} from "../shared/contracts";
import {
  isEpochMilliseconds,
  KANBAN_RUN_STATES,
  KANBAN_STATUSES,
  parseKanbanPriority
} from "../shared/contracts";
import { getRuntimeDataRoot } from "./user-paths";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath(name: Parameters<App["getPath"]>[0]): string;
};

type KanbanIssueRow = {
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
  priority: KanbanPriority;
  severity: NonNullable<KanbanIssue["severity"]>;
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

type KanbanProjectRow = {
  id: string;
  parent_id: string | null;
  slug: string;
  key: string;
  name: string;
  description: string;
  versions_json: string;
  path: string;
  depth: number;
  position: number;
  revision: number;
  visibility: string;
  default_workflow_id: string;
  created_at: string;
  updated_at: string;
};

type KanbanProjectBindingRow = {
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
  workflowStages?: unknown[];
  workflowStatuses?: unknown[];
  issueLabels?: unknown[];
  issueLabelLinks?: unknown[];
  issueDependencies?: unknown[];
  reviews?: unknown[];
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

const BOARD_ID = "default";
const PROJECT_ID = "default";
const WORKFLOW_ID = "workflow-standard-requirement";
const ISSUE_TYPE_ID = "issue-type-standard-requirement";
const DATABASE_DIRECTORY = "desktop-kanban";
const DATABASE_FILENAME = "kanban.db";
const SYNC_CACHE_SCHEMA_VERSION = 3;

function nowIso() {
  return new Date().toISOString();
}

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableTrimmedText(value: unknown) {
  const text = trimText(value);
  return text ? text : null;
}

function normalizeKanbanStatus(value: unknown): KanbanStatus {
  const raw = trimText(value).toLowerCase();
  return KANBAN_STATUSES.includes(raw as KanbanStatus) ? raw as KanbanStatus : "backlog";
}

function normalizeKanbanPriority(value: unknown): KanbanPriority {
  return parseKanbanPriority(value) ?? "P2";
}

function normalizeKanbanSeverity(value: unknown): NonNullable<KanbanIssue["severity"]> {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeKanbanRunState(value: unknown): KanbanRunState | null {
  return typeof value === "string" && KANBAN_RUN_STATES.includes(value as KanbanRunState)
    ? value as KanbanRunState
    : null;
}

function normalizeWorkerType(value: unknown): KanbanIssue["workerType"] {
  return value === "human" || value === "agent" ? value : null;
}

function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(trimText).filter(Boolean))];
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseAttachmentsJson(value: string | null | undefined): AssistantAttachment[] {
  if (!value) return [];
  try {
    return normalizeAttachments(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeCustomFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseCloudDueTime(value: unknown): KanbanIssue["dueAt"] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value.trim());
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetText === "Z" ? 0 : Number(offsetText.slice(1, 3));
  const offsetMinute = offsetText === "Z" ? 0 : Number(offsetText.slice(4, 6));
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    year < 1970 || month < 1 || month > 12 || day < 1 || day > maxDay ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59 ||
    (fraction.length > 3 && !/^0*$/u.test(fraction.slice(3)))
  ) {
    return undefined;
  }

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, "0")));
  const offsetSign = offsetText.startsWith("-") ? -1 : 1;
  const offsetMillis = offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000;
  const epochMillis = localDate.getTime() - offsetMillis;
  return isEpochMilliseconds(epochMillis) ? epochMillis : undefined;
}

function readStoredDueAt(value: unknown): KanbanIssue["dueAt"] {
  if (value === null) return null;
  return isEpochMilliseconds(value) ? value : undefined;
}

function buildIssueDetailJson(issue: KanbanIssue) {
  return JSON.stringify({
    projectPath: issue.projectPath ?? "",
    projectName: issue.projectName ?? "",
    version: issue.version ?? null,
    parentIssueId: issue.parentIssueId ?? null,
    issueTypeKey: issue.issueTypeKey ?? issue.typeId ?? "",
    stageKey: issue.stageKey ?? "",
    statusKey: issue.statusKey ?? "",
    columnKey: issue.columnKey ?? "",
    customFields: issue.customFields ?? {},
    dueAt: issue.dueAt ?? null,
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

function emptyCloudDetailData(): KanbanCloudDetailData {
  return {
    users: [],
    issueTypes: [],
    issueFieldDefs: [],
    issueFieldContexts: [],
    issueFieldOptions: [],
    workflows: [],
    workflowStages: [],
    workflowStatuses: [],
    issueLabels: [],
    issueLabelLinks: [],
    issueDependencies: [],
    reviews: [],
    issueComments: [],
    recentEvents: []
  };
}

const CLOUD_DETAIL_KEYS = [
  "users",
  "issueTypes",
  "issueFieldDefs",
  "issueFieldContexts",
  "issueFieldOptions",
  "workflows",
  "workflowStages",
  "workflowStatuses",
  "issueLabels",
  "issueLabelLinks",
  "issueDependencies",
  "reviews",
  "issueComments",
  "recentEvents"
] as const satisfies ReadonlyArray<keyof KanbanCloudDetailData>;

function parseCloudDetailData(value: string | null | undefined): KanbanCloudDetailData {
  const record = parseJsonRecord(value);
  const detail = emptyCloudDetailData();
  for (const key of CLOUD_DETAIL_KEYS) {
    if (Array.isArray(record[key])) {
      (detail[key] as unknown[]) = record[key] as unknown[];
    }
  }
  return detail;
}

function detailItemKey(key: keyof KanbanCloudDetailData, item: unknown, index: number) {
  const record = parseCloudIssue(item);
  if (!record) return `${key}:${index}`;
  if (key === "issueTypes") return trimText(record.key) || `${key}:${index}`;
  if (key === "issueLabelLinks") return `${trimText(record.issueId)}:${trimText(record.labelId)}`;
  return String(record.id ?? `${key}:${index}`);
}

function mergeCloudDetailArray(key: keyof KanbanCloudDetailData, current: unknown[], incoming: unknown[]) {
  const merged = new Map(current.map((item, index) => [detailItemKey(key, item, index), item]));
  incoming.forEach((item, index) => merged.set(detailItemKey(key, item, index), item));
  return [...merged.values()];
}

function selectCloudDetailData(db: DatabaseSync, currentUser: KanbanCurrentUser): KanbanCloudDetailData {
  const row = db.prepare(`
    SELECT PAYLOAD_JSON_ AS payloadJson
    FROM kanban_cloud_detail_cache
    WHERE OWNER_USER_ID_ = ?
  `).get(currentUser.id) as { payloadJson?: string } | undefined;
  return parseCloudDetailData(row?.payloadJson);
}

function storeCloudDetailData(
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

function parseCloudIssue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function createLocalIssueId(prefix = "local") {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function getDesktopKanbanDatabasePath(app: AppPathProvider) {
  return path.join(getRuntimeDataRoot(app as App), DATABASE_DIRECTORY, DATABASE_FILENAME);
}

function ensureDesktopKanbanSchema(db: DatabaseSync) {
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS board (
      ID_ TEXT PRIMARY KEY,
      PROJECT_ID_ TEXT NOT NULL,
      KEY_ TEXT NOT NULL,
      NAME_ TEXT NOT NULL,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS board_meta (
      BOARD_ID_ TEXT NOT NULL,
      KEY_ TEXT NOT NULL,
      VALUE_ TEXT NOT NULL,
      PRIMARY KEY (BOARD_ID_, KEY_)
    );

    CREATE TABLE IF NOT EXISTS project (
      ID_ TEXT PRIMARY KEY,
      PARENT_ID_ TEXT,
      SLUG_ TEXT NOT NULL,
      KEY_ TEXT NOT NULL DEFAULT '',
      NAME_ TEXT NOT NULL,
      DESCRIPTION_ TEXT NOT NULL DEFAULT '',
      VERSIONS_JSON_ TEXT NOT NULL DEFAULT '[]',
      PATH_ TEXT NOT NULL,
      DEPTH_ INTEGER NOT NULL DEFAULT 0,
      POSITION_ REAL NOT NULL DEFAULT 0,
      REVISION_ INTEGER NOT NULL DEFAULT 0,
      SYNC_MODE_ TEXT NOT NULL DEFAULT 'private' CHECK (SYNC_MODE_ IN ('private','cloud')),
      VISIBILITY_ TEXT NOT NULL DEFAULT 'workspace',
      DEFAULT_WORKFLOW_ID_ TEXT NOT NULL,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow (
      ID_ TEXT PRIMARY KEY,
      KEY_ TEXT NOT NULL UNIQUE,
      NAME_ TEXT NOT NULL,
      DESCRIPTION_ TEXT NOT NULL DEFAULT '',
      IS_DEFAULT_ INTEGER NOT NULL DEFAULT 0,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_stage (
      ID_ TEXT PRIMARY KEY,
      WORKFLOW_ID_ TEXT NOT NULL,
      KEY_ TEXT NOT NULL,
      NAME_ TEXT NOT NULL,
      POSITION_ INTEGER NOT NULL,
      IS_START_ INTEGER NOT NULL DEFAULT 0,
      IS_END_ INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workflow_status (
      ID_ TEXT PRIMARY KEY,
      WORKFLOW_ID_ TEXT NOT NULL,
      KEY_ TEXT NOT NULL,
      NAME_ TEXT NOT NULL,
      COLUMN_KEY_ TEXT NOT NULL CHECK (COLUMN_KEY_ IN ('backlog','todo','in_progress','in_review','completed')),
      POSITION_ INTEGER NOT NULL,
      IS_START_ INTEGER NOT NULL DEFAULT 0,
      IS_TERMINAL_ INTEGER NOT NULL DEFAULT 0,
      REVIEW_REQUIRED_ INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS issue (
      ID_ TEXT PRIMARY KEY,
      REMOTE_ISSUE_ID_ TEXT,
      BOARD_ID_ TEXT NOT NULL DEFAULT 'default',
      PROJECT_ID_ TEXT NOT NULL DEFAULT 'default',
      WORKFLOW_ID_ TEXT NOT NULL DEFAULT 'workflow-standard-requirement',
      TYPE_ID_ TEXT,
      STAGE_ID_ TEXT,
      STAGE_NAME_ TEXT,
      STATUS_ID_ TEXT,
      STATUS_NAME_ TEXT,
      TITLE_ TEXT NOT NULL CHECK (length(trim(TITLE_)) > 0),
      DESCRIPTION_ TEXT NOT NULL DEFAULT '',
      STATUS_ TEXT NOT NULL CHECK (STATUS_ IN ('backlog','todo','in_progress','in_review','completed')),
      PRIORITY_ TEXT NOT NULL CHECK (PRIORITY_ IN ('P0','P1','P2','P3')),
      SEVERITY_ TEXT NOT NULL DEFAULT 'medium' CHECK (SEVERITY_ IN ('critical','high','medium','low')),
      POSITION_ REAL NOT NULL,
      ASSIGNEE_AGENT_KEY_ TEXT,
      ASSIGNEE_ID_ TEXT,
      WORKER_TYPE_ TEXT CHECK (WORKER_TYPE_ IN ('human','agent') OR WORKER_TYPE_ IS NULL),
      WORKER_ID_ TEXT,
      WORKER_AGENT_ TEXT,
      ACTIVE_REVIEW_ID_ TEXT,
      ACTIVE_RUN_ID_ TEXT,
      CHAT_ID_ TEXT,
      RUN_ID_ TEXT,
      RUN_STATE_ TEXT CHECK (RUN_STATE_ IN ('running','completed','failed','cancelled') OR RUN_STATE_ IS NULL),
      DISPATCH_STATE_ TEXT,
      DISPATCH_DEVICE_ID_ TEXT,
      DISPATCH_COMMAND_ID_ TEXT,
      DISPATCH_UPDATED_AT_ TEXT,
      AUTOMATION_ID_ TEXT,
      AUTOMATION_ENABLED_ INTEGER NOT NULL DEFAULT 0,
      AUTOMATION_CRON_ TEXT,
      AUTOMATION_MESSAGE_ TEXT,
      AUTOMATION_TIMEZONE_ TEXT,
      ATTACHMENT_CHAT_ID_ TEXT,
      ATTACHMENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
      DETAIL_JSON_ TEXT NOT NULL DEFAULT '{}',
      REVISION_ INTEGER NOT NULL DEFAULT 0,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_attachment (
      ID_ TEXT PRIMARY KEY,
      ISSUE_ID_ TEXT NOT NULL,
      KIND_ TEXT NOT NULL DEFAULT '',
      NAME_ TEXT NOT NULL DEFAULT '',
      MIME_TYPE_ TEXT NOT NULL DEFAULT '',
      SIZE_BYTES_ INTEGER NOT NULL DEFAULT 0,
      URL_ TEXT,
      TEXT_ TEXT,
      METADATA_JSON_ TEXT NOT NULL DEFAULT '{}',
      CREATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_automation (
      ID_ TEXT PRIMARY KEY,
      ISSUE_ID_ TEXT NOT NULL,
      EXTERNAL_AUTOMATION_ID_ TEXT,
      ENABLED_ INTEGER NOT NULL DEFAULT 0,
      CRON_ TEXT,
      TIMEZONE_ TEXT,
      MESSAGE_ TEXT,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_run (
      ID_ TEXT PRIMARY KEY,
      ISSUE_ID_ TEXT NOT NULL,
      WORKER_AGENT_ TEXT,
      CHAT_ID_ TEXT,
      RUN_ID_ TEXT,
      STATUS_ TEXT NOT NULL,
      STARTED_AT_ TEXT,
      FINISHED_AT_ TEXT,
      ERROR_MESSAGE_ TEXT,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review (
      ID_ TEXT PRIMARY KEY,
      ISSUE_ID_ TEXT NOT NULL,
      STATUS_ TEXT NOT NULL DEFAULT 'pending',
      REVIEWER_ID_ TEXT,
      SUMMARY_ TEXT NOT NULL DEFAULT '',
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS event_log (
      ID_ INTEGER PRIMARY KEY AUTOINCREMENT,
      BOARD_ID_ TEXT NOT NULL,
      PROJECT_ID_ TEXT,
      ISSUE_ID_ TEXT,
      REVISION_ INTEGER NOT NULL,
      EVENT_TYPE_ TEXT NOT NULL,
      ACTOR_ID_ TEXT,
      PAYLOAD_JSON_ TEXT NOT NULL DEFAULT '{}',
      CREATED_AT_ TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_account (
      ID_ TEXT PRIMARY KEY,
      EMAIL_ TEXT NOT NULL DEFAULT '',
      DISPLAY_NAME_ TEXT NOT NULL DEFAULT '',
      STATUS_ TEXT NOT NULL DEFAULT 'active',
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS desktop_issue_sync (
      LOCAL_ISSUE_ID_ TEXT PRIMARY KEY REFERENCES issue(ID_) ON DELETE CASCADE,
      REMOTE_ISSUE_ID_ TEXT,
      SYNC_MODE_ TEXT NOT NULL CHECK (SYNC_MODE_ IN ('private','cloud')),
      SYNC_STATE_ TEXT NOT NULL CHECK (SYNC_STATE_ IN ('local','syncing','synced','error')),
      ORIGIN_ TEXT NOT NULL CHECK (ORIGIN_ IN ('desktop','cloud_dispatch')),
      OWNER_USER_ID_ TEXT NOT NULL,
      LAST_REMOTE_REVISION_ INTEGER NOT NULL DEFAULT 0,
      LAST_SYNCED_AT_ TEXT,
      SYNC_ERROR_ TEXT
    );

    CREATE TABLE IF NOT EXISTS project_desktop_binding (
      ID_ TEXT PRIMARY KEY,
      PROJECT_ID_ TEXT NOT NULL,
      DEVICE_ID_ TEXT NOT NULL,
      CURRENT_USER_ID_ TEXT NOT NULL DEFAULT '',
      LOCAL_PROJECT_ID_ TEXT NOT NULL,
      LOCAL_DISPLAY_NAME_ TEXT NOT NULL,
      SYNC_POLICY_ TEXT NOT NULL DEFAULT 'future' CHECK (SYNC_POLICY_ IN ('future','select','all')),
      CONTROL_MODE_ TEXT NOT NULL DEFAULT 'dispatch' CHECK (CONTROL_MODE_ IN ('dispatch','observe','disabled')),
      STATUS_ TEXT NOT NULL DEFAULT 'active' CHECK (STATUS_ IN ('active','paused','error')),
      LAST_REMOTE_REVISION_ INTEGER NOT NULL DEFAULT 0,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL,
      DELETED_AT_ TEXT
    );

    CREATE TABLE IF NOT EXISTS kanban_command_receipt (
      COMMAND_ID_ TEXT PRIMARY KEY,
      DELIVERY_SEQ_ INTEGER NOT NULL,
      PROJECT_ID_ TEXT,
      ISSUE_ID_ TEXT NOT NULL,
      PAYLOAD_JSON_ TEXT NOT NULL,
      PAYLOAD_HASH_ TEXT NOT NULL,
      CHAT_ID_ TEXT NOT NULL,
      RUN_ID_ TEXT NOT NULL,
      REQUEST_ID_ TEXT NOT NULL,
      STATE_ TEXT NOT NULL CHECK (STATE_ IN ('received','starting','started','completed','failed')),
      ATTEMPT_COUNT_ INTEGER NOT NULL DEFAULT 0,
      LAST_ERROR_ TEXT,
      TERMINAL_REPORTED_AT_ TEXT,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kanban_cloud_detail_cache (
      OWNER_USER_ID_ TEXT PRIMARY KEY,
      REVISION_ INTEGER NOT NULL DEFAULT 0,
      PAYLOAD_JSON_ TEXT NOT NULL DEFAULT '{}',
      UPDATED_AT_ TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_command_receipt_state
      ON kanban_command_receipt(STATE_, DELIVERY_SEQ_);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_issue_sync_remote
      ON desktop_issue_sync(REMOTE_ISSUE_ID_)
      WHERE REMOTE_ISSUE_ID_ IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_project_desktop_binding_project
      ON project_desktop_binding(PROJECT_ID_, STATUS_, UPDATED_AT_)
      WHERE DELETED_AT_ IS NULL;

    CREATE INDEX IF NOT EXISTS idx_issue_status_position
      ON issue(STATUS_, POSITION_, ID_)
      WHERE DELETED_AT_ IS NULL;
  `);
  ensureDesktopKanbanIssueColumns(db);
  ensureDesktopKanbanPriorityConstraint(db);
}

function ensureDesktopKanbanIssueColumns(db: DatabaseSync) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(issue)").all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (!columns.has("STAGE_NAME_")) {
    db.exec("ALTER TABLE issue ADD COLUMN STAGE_NAME_ TEXT");
  }
  if (!columns.has("STATUS_NAME_")) {
    db.exec("ALTER TABLE issue ADD COLUMN STATUS_NAME_ TEXT");
  }
  if (!columns.has("DETAIL_JSON_")) {
    db.exec("ALTER TABLE issue ADD COLUMN DETAIL_JSON_ TEXT NOT NULL DEFAULT '{}'");
  }
  for (const [name, definition] of [
    ["DISPATCH_STATE_", "TEXT"],
    ["DISPATCH_DEVICE_ID_", "TEXT"],
    ["DISPATCH_COMMAND_ID_", "TEXT"],
    ["DISPATCH_UPDATED_AT_", "TEXT"]
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE issue ADD COLUMN ${name} ${definition}`);
  }
  const projectColumns = new Set((db.prepare("PRAGMA table_info(project)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!projectColumns.has("REVISION_")) db.exec("ALTER TABLE project ADD COLUMN REVISION_ INTEGER NOT NULL DEFAULT 0");
  if (!projectColumns.has("VERSIONS_JSON_")) db.exec("ALTER TABLE project ADD COLUMN VERSIONS_JSON_ TEXT NOT NULL DEFAULT '[]'");
  if (!projectColumns.has("SYNC_MODE_")) {
    db.exec("ALTER TABLE project ADD COLUMN SYNC_MODE_ TEXT NOT NULL DEFAULT 'private'");
    db.exec(`UPDATE project SET SYNC_MODE_ = 'cloud' WHERE ID_ IN (SELECT DISTINCT PROJECT_ID_ FROM issue JOIN desktop_issue_sync ON desktop_issue_sync.LOCAL_ISSUE_ID_ = issue.ID_ WHERE desktop_issue_sync.SYNC_MODE_ = 'cloud')`);
  }
  const receiptColumns = new Set((db.prepare("PRAGMA table_info(kanban_command_receipt)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!receiptColumns.has("TERMINAL_REPORTED_AT_")) db.exec("ALTER TABLE kanban_command_receipt ADD COLUMN TERMINAL_REPORTED_AT_ TEXT");
}

function ensureDesktopKanbanPriorityConstraint(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'issue'
  `).get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'P0'") && row.sql.includes("'P3'")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE issue_priority_migration (
        ID_ TEXT PRIMARY KEY,
        REMOTE_ISSUE_ID_ TEXT,
        BOARD_ID_ TEXT NOT NULL DEFAULT 'default',
        PROJECT_ID_ TEXT NOT NULL DEFAULT 'default',
        WORKFLOW_ID_ TEXT NOT NULL DEFAULT 'workflow-standard-requirement',
        TYPE_ID_ TEXT,
        STAGE_ID_ TEXT,
        STAGE_NAME_ TEXT,
        STATUS_ID_ TEXT,
        STATUS_NAME_ TEXT,
        TITLE_ TEXT NOT NULL CHECK (length(trim(TITLE_)) > 0),
        DESCRIPTION_ TEXT NOT NULL DEFAULT '',
        STATUS_ TEXT NOT NULL CHECK (STATUS_ IN ('backlog','todo','in_progress','in_review','completed')),
        PRIORITY_ TEXT NOT NULL CHECK (PRIORITY_ IN ('P0','P1','P2','P3')),
        SEVERITY_ TEXT NOT NULL DEFAULT 'medium' CHECK (SEVERITY_ IN ('critical','high','medium','low')),
        POSITION_ REAL NOT NULL,
        ASSIGNEE_AGENT_KEY_ TEXT,
        ASSIGNEE_ID_ TEXT,
        WORKER_TYPE_ TEXT CHECK (WORKER_TYPE_ IN ('human','agent') OR WORKER_TYPE_ IS NULL),
        WORKER_ID_ TEXT,
        WORKER_AGENT_ TEXT,
        ACTIVE_REVIEW_ID_ TEXT,
        ACTIVE_RUN_ID_ TEXT,
        CHAT_ID_ TEXT,
        RUN_ID_ TEXT,
        RUN_STATE_ TEXT CHECK (RUN_STATE_ IN ('running','completed','failed','cancelled') OR RUN_STATE_ IS NULL),
        DISPATCH_STATE_ TEXT,
        DISPATCH_DEVICE_ID_ TEXT,
        DISPATCH_COMMAND_ID_ TEXT,
        DISPATCH_UPDATED_AT_ TEXT,
        AUTOMATION_ID_ TEXT,
        AUTOMATION_ENABLED_ INTEGER NOT NULL DEFAULT 0,
        AUTOMATION_CRON_ TEXT,
        AUTOMATION_MESSAGE_ TEXT,
        AUTOMATION_TIMEZONE_ TEXT,
        ATTACHMENT_CHAT_ID_ TEXT,
        ATTACHMENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
        DETAIL_JSON_ TEXT NOT NULL DEFAULT '{}',
        REVISION_ INTEGER NOT NULL DEFAULT 0,
        CREATED_AT_ TEXT NOT NULL,
        UPDATED_AT_ TEXT NOT NULL,
        DELETED_AT_ TEXT
      );

      INSERT INTO issue_priority_migration (
        ID_, REMOTE_ISSUE_ID_, BOARD_ID_, PROJECT_ID_, WORKFLOW_ID_, TYPE_ID_, STAGE_ID_, STAGE_NAME_, STATUS_ID_, STATUS_NAME_,
        TITLE_, DESCRIPTION_, STATUS_, PRIORITY_, SEVERITY_, POSITION_, ASSIGNEE_AGENT_KEY_, ASSIGNEE_ID_,
        WORKER_TYPE_, WORKER_ID_, WORKER_AGENT_, ACTIVE_REVIEW_ID_, ACTIVE_RUN_ID_,
        CHAT_ID_, RUN_ID_, RUN_STATE_, DISPATCH_STATE_, DISPATCH_DEVICE_ID_, DISPATCH_COMMAND_ID_, DISPATCH_UPDATED_AT_,
        AUTOMATION_ID_, AUTOMATION_ENABLED_, AUTOMATION_CRON_, AUTOMATION_MESSAGE_, AUTOMATION_TIMEZONE_,
        ATTACHMENT_CHAT_ID_, ATTACHMENTS_JSON_, DETAIL_JSON_, REVISION_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
      )
      SELECT
        ID_, REMOTE_ISSUE_ID_, BOARD_ID_, PROJECT_ID_, WORKFLOW_ID_, TYPE_ID_, STAGE_ID_, STAGE_NAME_, STATUS_ID_, STATUS_NAME_,
        TITLE_, DESCRIPTION_, STATUS_,
        CASE PRIORITY_
          WHEN 'P0' THEN 'P0'
          WHEN 'P1' THEN 'P1'
          WHEN 'P2' THEN 'P2'
          WHEN 'P3' THEN 'P3'
          WHEN 'high' THEN 'P1'
          WHEN 'medium' THEN 'P2'
          WHEN 'low' THEN 'P3'
          ELSE 'P2'
        END,
        SEVERITY_, POSITION_, ASSIGNEE_AGENT_KEY_, ASSIGNEE_ID_,
        WORKER_TYPE_, WORKER_ID_, WORKER_AGENT_, ACTIVE_REVIEW_ID_, ACTIVE_RUN_ID_,
        CHAT_ID_, RUN_ID_, RUN_STATE_, DISPATCH_STATE_, DISPATCH_DEVICE_ID_, DISPATCH_COMMAND_ID_, DISPATCH_UPDATED_AT_,
        AUTOMATION_ID_, AUTOMATION_ENABLED_, AUTOMATION_CRON_, AUTOMATION_MESSAGE_, AUTOMATION_TIMEZONE_,
        ATTACHMENT_CHAT_ID_, ATTACHMENTS_JSON_, DETAIL_JSON_, REVISION_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
      FROM issue;

      DROP TABLE issue;
      ALTER TABLE issue_priority_migration RENAME TO issue;
      CREATE INDEX IF NOT EXISTS idx_issue_status_position
        ON issue(STATUS_, POSITION_, ID_)
        WHERE DELETED_AT_ IS NULL;

      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function seedDesktopKanban(db: DatabaseSync, currentUser: KanbanCurrentUser) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO board (ID_, PROJECT_ID_, KEY_, NAME_, CREATED_AT_, UPDATED_AT_)
    VALUES (?, ?, 'default', 'Default Board', ?, ?)
    ON CONFLICT(ID_) DO NOTHING
  `).run(BOARD_ID, PROJECT_ID, timestamp, timestamp);
  db.prepare(`
    INSERT INTO project (
      ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, PATH_, DEPTH_, POSITION_,
      VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_
    )
    VALUES (?, NULL, 'default', 'DEFAULT', 'All Projects', '', 'default', 0, 0, 'workspace', ?, ?, ?)
    ON CONFLICT(ID_) DO NOTHING
  `).run(PROJECT_ID, WORKFLOW_ID, timestamp, timestamp);
  db.prepare(`
    INSERT INTO workflow (ID_, KEY_, NAME_, DESCRIPTION_, IS_DEFAULT_, CREATED_AT_, UPDATED_AT_)
    VALUES (?, 'standard_requirement', ?, '', 1, ?, ?)
    ON CONFLICT(ID_) DO UPDATE SET NAME_ = excluded.NAME_
  `).run(WORKFLOW_ID, t("kanban.workflow.standardRequirement"), timestamp, timestamp);
  const statuses: Array<{ id: string; key: KanbanStatus; name: string; position: number; terminal: number; review: number }> = [
    { id: "workflow-status-backlog", key: "backlog", name: t("kanban.status.backlog"), position: 1, terminal: 0, review: 0 },
    { id: "workflow-status-todo", key: "todo", name: t("kanban.status.todo"), position: 2, terminal: 0, review: 0 },
    { id: "workflow-status-in-progress", key: "in_progress", name: t("kanban.status.inProgress"), position: 3, terminal: 0, review: 0 },
    { id: "workflow-status-in-review", key: "in_review", name: t("kanban.status.inReview"), position: 4, terminal: 0, review: 1 },
    { id: "workflow-status-completed", key: "completed", name: t("kanban.status.completed"), position: 5, terminal: 1, review: 0 }
  ];
  const insertStatus = db.prepare(`
    INSERT INTO workflow_status (
      ID_, WORKFLOW_ID_, KEY_, NAME_, COLUMN_KEY_, POSITION_, IS_START_, IS_TERMINAL_, REVIEW_REQUIRED_
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ID_) DO UPDATE SET NAME_ = excluded.NAME_, COLUMN_KEY_ = excluded.COLUMN_KEY_
  `);
  for (const status of statuses) {
    insertStatus.run(status.id, WORKFLOW_ID, status.key, status.name, status.key, status.position, status.key === "backlog" ? 1 : 0, status.terminal, status.review);
  }
  db.prepare(`
    INSERT INTO user_account (ID_, EMAIL_, DISPLAY_NAME_, STATUS_, CREATED_AT_, UPDATED_AT_)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(ID_) DO UPDATE SET
      EMAIL_ = excluded.EMAIL_,
      DISPLAY_NAME_ = excluded.DISPLAY_NAME_,
      UPDATED_AT_ = excluded.UPDATED_AT_
  `).run(currentUser.id, currentUser.email, currentUser.name || currentUser.id, timestamp, timestamp);
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, 'schema_version', '1')
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID);
}

export function withDesktopKanbanDatabase<T>(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  callback: (db: DatabaseSync) => T
): T {
  const databasePath = getDesktopKanbanDatabasePath(app);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    ensureDesktopKanbanSchema(db);
    seedDesktopKanban(db, currentUser);
    return callback(db);
  } finally {
    db.close();
  }
}

function issueFromRow(row: KanbanIssueRow): KanbanIssue {
  const detail = parseJsonRecord(row.detail_json);
  return {
    id: row.id,
    localIssueId: row.id,
    remoteIssueId: row.remote_issue_id,
    boardId: row.board_id,
    projectId: row.project_id,
    projectPath: trimText(detail.projectPath) || undefined,
    projectName: trimText(detail.projectName) || undefined,
    version: nullableTrimmedText(detail.version),
    parentIssueId: nullableTrimmedText(detail.parentIssueId),
    workflowId: row.workflow_id,
    typeId: row.type_id ?? undefined,
    issueTypeKey: trimText(detail.issueTypeKey) || row.type_id || undefined,
    stageId: row.stage_id ?? undefined,
    stageKey: trimText(detail.stageKey) || undefined,
    stageName: row.stage_name ?? undefined,
    statusId: row.status_id ?? undefined,
    statusName: row.status_name ?? undefined,
    statusKey: trimText(detail.statusKey) || undefined,
    columnKey: trimText(detail.columnKey) || undefined,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    severity: row.severity,
    assigneeAgentKey: row.assignee_agent_key,
    assigneeId: row.assignee_id,
    workerType: row.worker_type,
    workerId: row.worker_id,
    workerAgent: row.worker_agent,
    activeReviewId: row.active_review_id,
    activeRunId: row.active_run_id,
    position: row.position,
    chatId: row.chat_id,
    runId: row.run_id,
    runState: row.run_state,
    runAgentKey: nullableTrimmedText(detail.runAgentKey),
    runCommandId: nullableTrimmedText(detail.runCommandId),
    runStartedAt: nullableTrimmedText(detail.runStartedAt),
    runFinishedAt: nullableTrimmedText(detail.runFinishedAt),
    runResultMessage: nullableTrimmedText(detail.runResultMessage),
    runErrorMessage: nullableTrimmedText(detail.runErrorMessage),
    dispatchState: row.dispatch_state,
    dispatchDeviceId: row.dispatch_device_id,
    dispatchCommandId: row.dispatch_command_id,
    dispatchUpdatedAt: row.dispatch_updated_at,
    automationId: row.automation_id,
    automationEnabled: row.automation_enabled === 1,
    automationCron: row.automation_cron,
    automationMessage: row.automation_message,
    automationTimezone: row.automation_timezone,
    attachmentChatId: row.attachment_chat_id,
    attachments: parseAttachmentsJson(row.attachments_json),
    customFields: normalizeCustomFields(detail.customFields),
    dueAt: readStoredDueAt(detail.dueAt),
    createdBy: nullableTrimmedText(detail.createdBy),
    updatedBy: nullableTrimmedText(detail.updatedBy),
    createdByAgent: nullableTrimmedText(detail.createdByAgent),
    updatedByAgent: nullableTrimmedText(detail.updatedByAgent),
    syncMode: row.sync_mode,
    syncState: row.sync_state,
    origin: row.origin,
    ownerUserId: row.owner_user_id,
    lastRemoteRevision: row.last_remote_revision,
    lastSyncedAt: row.last_synced_at,
    syncError: row.sync_error,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectFromRow(row: KanbanProjectRow): KanbanProject {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    key: row.key || undefined,
    name: row.name,
    description: row.description || undefined,
    versions: parseStringList(row.versions_json),
    path: row.path,
    depth: row.depth,
    position: row.position,
    revision: row.revision,
    visibility: row.visibility || undefined,
    defaultWorkflowId: row.default_workflow_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectBindingFromRow(row: KanbanProjectBindingRow): KanbanProjectBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    deviceId: row.device_id,
    currentUserId: row.current_user_id || undefined,
    localProjectId: row.local_project_id,
    localDisplayName: row.local_display_name,
    syncPolicy: row.sync_policy,
    controlMode: row.control_mode,
    status: row.status,
    lastRemoteRevision: row.last_remote_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseCloudProject(value: unknown): KanbanProject | null {
  const record = parseCloudIssue(value);
  if (!record) return null;
  const id = trimText(record.id);
  const name = trimText(record.name) || id;
  if (!id || !name) return null;
  const timestamp = trimText(record.updatedAt) || nowIso();
  return {
    id,
    parentId: nullableTrimmedText(record.parentId),
    slug: trimText(record.slug) || id.toLowerCase(),
    key: trimText(record.key) || undefined,
    name,
    description: trimText(record.description) || undefined,
    versions: normalizeStringList(record.versions),
    path: trimText(record.path) || id,
    depth: typeof record.depth === "number" && Number.isFinite(record.depth) ? record.depth : 0,
    position: typeof record.position === "number" && Number.isFinite(record.position) ? record.position : 0,
    revision: typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0,
    visibility: trimText(record.visibility) || undefined,
    defaultWorkflowId: trimText(record.defaultWorkflowId) || WORKFLOW_ID,
    createdAt: trimText(record.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

function parseCloudProjectBinding(value: unknown): KanbanProjectBinding | null {
  const record = parseCloudIssue(value);
  if (!record) return null;
  const id = trimText(record.id);
  const projectId = trimText(record.projectId);
  const deviceId = trimText(record.deviceId);
  const localProjectId = trimText(record.localProjectId);
  const localDisplayName = trimText(record.localDisplayName) || localProjectId;
  if (!id || !projectId || !deviceId || !localProjectId || !localDisplayName) return null;
  const timestamp = trimText(record.updatedAt) || nowIso();
  const syncPolicy = record.syncPolicy === "select" || record.syncPolicy === "all" ? record.syncPolicy : "future";
  const controlMode = record.controlMode === "observe" || record.controlMode === "readonly"
    ? "observe"
    : record.controlMode === "disabled" ? "disabled" : "dispatch";
  const status = record.status === "paused" || record.status === "error" ? record.status : "active";
  return {
    id,
    projectId,
    deviceId,
    currentUserId: trimText(record.currentUserId) || undefined,
    localProjectId,
    localDisplayName,
    syncPolicy,
    controlMode,
    status,
    lastRemoteRevision: typeof record.lastRemoteRevision === "number" && Number.isFinite(record.lastRemoteRevision)
      ? record.lastRemoteRevision
      : 0,
    createdAt: trimText(record.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

function readDesktopKanbanRevision(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = 'revision'
  `).get(BOARD_ID) as { value?: string } | undefined;
  const revision = Number.parseInt(row?.value ?? "0", 10);
  return Number.isFinite(revision) ? revision : 0;
}

function readBoardMetaInteger(db: DatabaseSync, key: string, fallback = 0) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = ?
  `).get(BOARD_ID, key) as { value?: string } | undefined;
  const value = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function writeBoardMetaInteger(db: DatabaseSync, key: string, value: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, ?, ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, key, String(Math.max(0, Math.floor(value))));
}

function writeDesktopKanbanRevision(db: DatabaseSync, revision: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, 'revision', ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, String(Math.max(0, Math.floor(revision))));
}

function readDesktopKanbanSyncCursorFromDb(db: DatabaseSync): KanbanDesktopSyncCursor {
  return {
    lastAckedDeliverySeq: readBoardMetaInteger(db, "sync.lastAckedDeliverySeq"),
    lastAppliedRevision: Math.max(
      readBoardMetaInteger(db, "sync.lastAppliedRevision"),
      readDesktopKanbanRevision(db)
    ),
    cacheSchemaVersion: readBoardMetaInteger(db, "sync.cacheSchemaVersion", SYNC_CACHE_SCHEMA_VERSION) || SYNC_CACHE_SCHEMA_VERSION
  };
}

function writeDesktopKanbanSyncCursorInDb(db: DatabaseSync, cursor: Partial<KanbanDesktopSyncCursor>) {
  if (cursor.lastAckedDeliverySeq !== undefined) {
    writeBoardMetaInteger(db, "sync.lastAckedDeliverySeq", cursor.lastAckedDeliverySeq);
  }
  if (cursor.lastAppliedRevision !== undefined) {
    const revision = Math.max(readDesktopKanbanRevision(db), cursor.lastAppliedRevision);
    writeBoardMetaInteger(db, "sync.lastAppliedRevision", revision);
    writeDesktopKanbanRevision(db, revision);
  }
  writeBoardMetaInteger(db, "sync.cacheSchemaVersion", cursor.cacheSchemaVersion ?? SYNC_CACHE_SCHEMA_VERSION);
}

export function readDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => readDesktopKanbanSyncCursorFromDb(db));
}

export function writeDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  cursor: Partial<KanbanDesktopSyncCursor>
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const current = readDesktopKanbanSyncCursorFromDb(db);
    writeDesktopKanbanSyncCursorInDb(db, {
      lastAckedDeliverySeq: Math.max(current.lastAckedDeliverySeq, cursor.lastAckedDeliverySeq ?? 0),
      lastAppliedRevision: Math.max(current.lastAppliedRevision, cursor.lastAppliedRevision ?? 0),
      cacheSchemaVersion: cursor.cacheSchemaVersion ?? current.cacheSchemaVersion
    });
    return readDesktopKanbanSyncCursorFromDb(db);
  });
}

function selectIssues(db: DatabaseSync, currentUser: KanbanCurrentUser): KanbanIssue[] {
  const rows = db.prepare(`
    SELECT
      issue.ID_ AS id,
      issue.REMOTE_ISSUE_ID_ AS remote_issue_id,
      issue.BOARD_ID_ AS board_id,
      issue.PROJECT_ID_ AS project_id,
      issue.WORKFLOW_ID_ AS workflow_id,
      issue.TYPE_ID_ AS type_id,
      issue.STAGE_ID_ AS stage_id,
      issue.STAGE_NAME_ AS stage_name,
      issue.STATUS_ID_ AS status_id,
      issue.STATUS_NAME_ AS status_name,
      issue.TITLE_ AS title,
      issue.DESCRIPTION_ AS description,
      issue.STATUS_ AS status,
      issue.PRIORITY_ AS priority,
      issue.SEVERITY_ AS severity,
      issue.ASSIGNEE_AGENT_KEY_ AS assignee_agent_key,
      issue.ASSIGNEE_ID_ AS assignee_id,
      issue.WORKER_TYPE_ AS worker_type,
      issue.WORKER_ID_ AS worker_id,
      issue.WORKER_AGENT_ AS worker_agent,
      issue.ACTIVE_REVIEW_ID_ AS active_review_id,
      issue.ACTIVE_RUN_ID_ AS active_run_id,
      issue.POSITION_ AS position,
      issue.CHAT_ID_ AS chat_id,
      issue.RUN_ID_ AS run_id,
      issue.RUN_STATE_ AS run_state,
      issue.DISPATCH_STATE_ AS dispatch_state,
      issue.DISPATCH_DEVICE_ID_ AS dispatch_device_id,
      issue.DISPATCH_COMMAND_ID_ AS dispatch_command_id,
      issue.DISPATCH_UPDATED_AT_ AS dispatch_updated_at,
      issue.AUTOMATION_ID_ AS automation_id,
      issue.AUTOMATION_ENABLED_ AS automation_enabled,
      issue.AUTOMATION_CRON_ AS automation_cron,
      issue.AUTOMATION_MESSAGE_ AS automation_message,
      issue.AUTOMATION_TIMEZONE_ AS automation_timezone,
      issue.ATTACHMENT_CHAT_ID_ AS attachment_chat_id,
      issue.ATTACHMENTS_JSON_ AS attachments_json,
      issue.DETAIL_JSON_ AS detail_json,
      issue.REVISION_ AS revision,
      issue.CREATED_AT_ AS created_at,
      issue.UPDATED_AT_ AS updated_at,
      sync.SYNC_MODE_ AS sync_mode,
      sync.SYNC_STATE_ AS sync_state,
      sync.ORIGIN_ AS origin,
      sync.OWNER_USER_ID_ AS owner_user_id,
      sync.LAST_REMOTE_REVISION_ AS last_remote_revision,
      sync.LAST_SYNCED_AT_ AS last_synced_at,
      sync.SYNC_ERROR_ AS sync_error
    FROM issue
    JOIN desktop_issue_sync sync ON sync.LOCAL_ISSUE_ID_ = issue.ID_
    WHERE issue.DELETED_AT_ IS NULL
      AND (sync.OWNER_USER_ID_ = ? OR sync.SYNC_MODE_ = 'cloud')
    ORDER BY
      CASE issue.STATUS_
        WHEN 'backlog' THEN 0
        WHEN 'todo' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'in_review' THEN 3
        WHEN 'completed' THEN 4
        ELSE 99
      END,
      issue.POSITION_ ASC,
      issue.UPDATED_AT_ DESC,
      issue.ID_ ASC
  `).all(currentUser.id) as KanbanIssueRow[];
  return rows.map(issueFromRow);
}

function selectProjects(db: DatabaseSync): KanbanProject[] {
  const rows = db.prepare(`
    SELECT
      ID_ AS id,
      PARENT_ID_ AS parent_id,
      SLUG_ AS slug,
      KEY_ AS key,
      NAME_ AS name,
      DESCRIPTION_ AS description,
      VERSIONS_JSON_ AS versions_json,
      PATH_ AS path,
      DEPTH_ AS depth,
      POSITION_ AS position,
      REVISION_ AS revision,
      VISIBILITY_ AS visibility,
      DEFAULT_WORKFLOW_ID_ AS default_workflow_id,
      CREATED_AT_ AS created_at,
      UPDATED_AT_ AS updated_at
    FROM project
    WHERE DELETED_AT_ IS NULL
    ORDER BY DEPTH_ ASC, POSITION_ ASC, NAME_ ASC, ID_ ASC
  `).all() as KanbanProjectRow[];
  return rows.map(projectFromRow);
}

function selectProjectBindings(db: DatabaseSync): KanbanProjectBinding[] {
  const rows = db.prepare(`
    SELECT
      ID_ AS id,
      PROJECT_ID_ AS project_id,
      DEVICE_ID_ AS device_id,
      CURRENT_USER_ID_ AS current_user_id,
      LOCAL_PROJECT_ID_ AS local_project_id,
      LOCAL_DISPLAY_NAME_ AS local_display_name,
      SYNC_POLICY_ AS sync_policy,
      CONTROL_MODE_ AS control_mode,
      STATUS_ AS status,
      LAST_REMOTE_REVISION_ AS last_remote_revision,
      CREATED_AT_ AS created_at,
      UPDATED_AT_ AS updated_at
    FROM project_desktop_binding
    WHERE DELETED_AT_ IS NULL
    ORDER BY UPDATED_AT_ DESC, ID_ ASC
  `).all() as KanbanProjectBindingRow[];
  return rows.map(projectBindingFromRow);
}

function nextIssuePosition(db: DatabaseSync, status: KanbanStatus) {
  const row = db.prepare(`
    SELECT MAX(POSITION_) AS maxPosition FROM issue
    WHERE STATUS_ = ? AND DELETED_AT_ IS NULL
  `).get(status) as { maxPosition?: number | null } | undefined;
  return typeof row?.maxPosition === "number" && Number.isFinite(row.maxPosition) ? row.maxPosition + 1 : 1;
}

function insertOrReplaceProject(db: DatabaseSync, project: KanbanProject, syncMode: KanbanSyncMode = "cloud") {
  db.prepare(`
    INSERT INTO project (
      ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, VERSIONS_JSON_, PATH_, DEPTH_, POSITION_,
      REVISION_, SYNC_MODE_, VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      PARENT_ID_ = excluded.PARENT_ID_,
      SLUG_ = excluded.SLUG_,
      KEY_ = excluded.KEY_,
      NAME_ = excluded.NAME_,
      DESCRIPTION_ = excluded.DESCRIPTION_,
      VERSIONS_JSON_ = excluded.VERSIONS_JSON_,
      PATH_ = excluded.PATH_,
      DEPTH_ = excluded.DEPTH_,
      POSITION_ = excluded.POSITION_,
      REVISION_ = excluded.REVISION_,
      SYNC_MODE_ = excluded.SYNC_MODE_,
      VISIBILITY_ = excluded.VISIBILITY_,
      DEFAULT_WORKFLOW_ID_ = excluded.DEFAULT_WORKFLOW_ID_,
      UPDATED_AT_ = excluded.UPDATED_AT_,
      DELETED_AT_ = NULL
  `).run(
    project.id,
    project.parentId,
    project.slug,
    project.key ?? project.slug.toUpperCase(),
    project.name,
    project.description ?? "",
    JSON.stringify(project.versions ?? []),
    project.path,
    project.depth,
    project.position,
    project.revision ?? 0,
    syncMode,
    project.visibility ?? "workspace",
    project.defaultWorkflowId ?? WORKFLOW_ID,
    project.createdAt,
    project.updatedAt
  );
}

function insertOrReplaceProjectBinding(db: DatabaseSync, binding: KanbanProjectBinding) {
  db.prepare(`
    UPDATE project_desktop_binding
    SET DELETED_AT_ = ?, UPDATED_AT_ = ?
    WHERE DEVICE_ID_ = ? AND PROJECT_ID_ = ? AND LOCAL_PROJECT_ID_ = ? AND ID_ != ? AND DELETED_AT_ IS NULL
  `).run(binding.updatedAt, binding.updatedAt, binding.deviceId, binding.projectId, binding.localProjectId, binding.id);
  db.prepare(`
    INSERT INTO project_desktop_binding (
      ID_, PROJECT_ID_, DEVICE_ID_, CURRENT_USER_ID_, LOCAL_PROJECT_ID_, LOCAL_DISPLAY_NAME_,
      SYNC_POLICY_, CONTROL_MODE_, STATUS_, LAST_REMOTE_REVISION_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      PROJECT_ID_ = excluded.PROJECT_ID_,
      DEVICE_ID_ = excluded.DEVICE_ID_,
      CURRENT_USER_ID_ = excluded.CURRENT_USER_ID_,
      LOCAL_PROJECT_ID_ = excluded.LOCAL_PROJECT_ID_,
      LOCAL_DISPLAY_NAME_ = excluded.LOCAL_DISPLAY_NAME_,
      SYNC_POLICY_ = excluded.SYNC_POLICY_,
      CONTROL_MODE_ = excluded.CONTROL_MODE_,
      STATUS_ = excluded.STATUS_,
      LAST_REMOTE_REVISION_ = excluded.LAST_REMOTE_REVISION_,
      UPDATED_AT_ = excluded.UPDATED_AT_,
      DELETED_AT_ = NULL
  `).run(
    binding.id,
    binding.projectId,
    binding.deviceId,
    binding.currentUserId ?? "",
    binding.localProjectId,
    binding.localDisplayName,
    binding.syncPolicy,
    binding.controlMode,
    binding.status,
    binding.lastRemoteRevision,
    binding.createdAt,
    binding.updatedAt
  );
}

function insertOrReplaceIssue(db: DatabaseSync, issue: KanbanIssue, sync: {
  syncMode: KanbanSyncMode;
  syncState: KanbanSyncState;
  origin: KanbanOrigin;
  ownerUserId: string;
  lastRemoteRevision?: number;
  lastSyncedAt?: string | null;
  syncError?: string | null;
}) {
  db.prepare(`
    INSERT INTO issue (
      ID_, REMOTE_ISSUE_ID_, BOARD_ID_, PROJECT_ID_, WORKFLOW_ID_, TYPE_ID_, STAGE_ID_, STAGE_NAME_, STATUS_ID_, STATUS_NAME_,
      TITLE_, DESCRIPTION_, STATUS_, PRIORITY_, SEVERITY_, POSITION_, ASSIGNEE_AGENT_KEY_, ASSIGNEE_ID_,
      WORKER_TYPE_, WORKER_ID_, WORKER_AGENT_, ACTIVE_REVIEW_ID_, ACTIVE_RUN_ID_,
      CHAT_ID_, RUN_ID_, RUN_STATE_, DISPATCH_STATE_, DISPATCH_DEVICE_ID_, DISPATCH_COMMAND_ID_, DISPATCH_UPDATED_AT_,
      AUTOMATION_ID_, AUTOMATION_ENABLED_, AUTOMATION_CRON_, AUTOMATION_MESSAGE_,
      AUTOMATION_TIMEZONE_, ATTACHMENT_CHAT_ID_, ATTACHMENTS_JSON_, DETAIL_JSON_, REVISION_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      REMOTE_ISSUE_ID_ = excluded.REMOTE_ISSUE_ID_,
      BOARD_ID_ = excluded.BOARD_ID_,
      PROJECT_ID_ = excluded.PROJECT_ID_,
      WORKFLOW_ID_ = excluded.WORKFLOW_ID_,
      TYPE_ID_ = excluded.TYPE_ID_,
      STAGE_ID_ = excluded.STAGE_ID_,
      STAGE_NAME_ = excluded.STAGE_NAME_,
      STATUS_ID_ = excluded.STATUS_ID_,
      STATUS_NAME_ = excluded.STATUS_NAME_,
      TITLE_ = excluded.TITLE_,
      DESCRIPTION_ = excluded.DESCRIPTION_,
      STATUS_ = excluded.STATUS_,
      PRIORITY_ = excluded.PRIORITY_,
      SEVERITY_ = excluded.SEVERITY_,
      POSITION_ = excluded.POSITION_,
      ASSIGNEE_AGENT_KEY_ = excluded.ASSIGNEE_AGENT_KEY_,
      ASSIGNEE_ID_ = excluded.ASSIGNEE_ID_,
      WORKER_TYPE_ = excluded.WORKER_TYPE_,
      WORKER_ID_ = excluded.WORKER_ID_,
      WORKER_AGENT_ = excluded.WORKER_AGENT_,
      ACTIVE_REVIEW_ID_ = excluded.ACTIVE_REVIEW_ID_,
      ACTIVE_RUN_ID_ = excluded.ACTIVE_RUN_ID_,
      CHAT_ID_ = excluded.CHAT_ID_,
      RUN_ID_ = excluded.RUN_ID_,
      RUN_STATE_ = excluded.RUN_STATE_,
      DISPATCH_STATE_ = excluded.DISPATCH_STATE_,
      DISPATCH_DEVICE_ID_ = excluded.DISPATCH_DEVICE_ID_,
      DISPATCH_COMMAND_ID_ = excluded.DISPATCH_COMMAND_ID_,
      DISPATCH_UPDATED_AT_ = excluded.DISPATCH_UPDATED_AT_,
      AUTOMATION_ID_ = excluded.AUTOMATION_ID_,
      AUTOMATION_ENABLED_ = excluded.AUTOMATION_ENABLED_,
      AUTOMATION_CRON_ = excluded.AUTOMATION_CRON_,
      AUTOMATION_MESSAGE_ = excluded.AUTOMATION_MESSAGE_,
      AUTOMATION_TIMEZONE_ = excluded.AUTOMATION_TIMEZONE_,
      ATTACHMENT_CHAT_ID_ = excluded.ATTACHMENT_CHAT_ID_,
      ATTACHMENTS_JSON_ = excluded.ATTACHMENTS_JSON_,
      DETAIL_JSON_ = excluded.DETAIL_JSON_,
      REVISION_ = excluded.REVISION_,
      UPDATED_AT_ = excluded.UPDATED_AT_,
      DELETED_AT_ = NULL
  `).run(
    issue.localIssueId ?? issue.id,
    issue.remoteIssueId ?? null,
    issue.boardId ?? BOARD_ID,
    issue.projectId ?? PROJECT_ID,
    issue.workflowId ?? WORKFLOW_ID,
    issue.typeId ?? ISSUE_TYPE_ID,
    issue.stageId ?? null,
    issue.stageName ?? null,
    issue.statusId ?? null,
    issue.statusName ?? null,
    issue.title.trim(),
    issue.description,
    issue.status,
    issue.priority,
    issue.severity ?? "medium",
    issue.position,
    issue.assigneeAgentKey,
    issue.assigneeId ?? null,
    issue.workerType ?? null,
    issue.workerId ?? null,
    issue.workerAgent ?? issue.assigneeAgentKey ?? null,
    issue.activeReviewId ?? null,
    issue.activeRunId ?? issue.runId ?? null,
    issue.chatId,
    issue.runId,
    issue.runState,
    issue.dispatchState ?? null,
    issue.dispatchDeviceId ?? null,
    issue.dispatchCommandId ?? null,
    issue.dispatchUpdatedAt ?? null,
    issue.automationId,
    issue.automationEnabled ? 1 : 0,
    issue.automationCron,
    issue.automationMessage,
    issue.automationTimezone,
    issue.attachmentChatId,
    JSON.stringify(issue.attachments ?? []),
    buildIssueDetailJson(issue),
    issue.revision ?? 0,
    issue.createdAt,
    issue.updatedAt
  );
  db.prepare(`
    INSERT INTO desktop_issue_sync (
      LOCAL_ISSUE_ID_, REMOTE_ISSUE_ID_, SYNC_MODE_, SYNC_STATE_, ORIGIN_, OWNER_USER_ID_,
      LAST_REMOTE_REVISION_, LAST_SYNCED_AT_, SYNC_ERROR_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(LOCAL_ISSUE_ID_) DO UPDATE SET
      REMOTE_ISSUE_ID_ = excluded.REMOTE_ISSUE_ID_,
      SYNC_MODE_ = excluded.SYNC_MODE_,
      SYNC_STATE_ = excluded.SYNC_STATE_,
      ORIGIN_ = excluded.ORIGIN_,
      OWNER_USER_ID_ = excluded.OWNER_USER_ID_,
      LAST_REMOTE_REVISION_ = excluded.LAST_REMOTE_REVISION_,
      LAST_SYNCED_AT_ = excluded.LAST_SYNCED_AT_,
      SYNC_ERROR_ = excluded.SYNC_ERROR_
  `).run(
    issue.localIssueId ?? issue.id,
    issue.remoteIssueId ?? null,
    sync.syncMode,
    sync.syncState,
    sync.origin,
    sync.ownerUserId,
    sync.lastRemoteRevision ?? issue.revision ?? 0,
    sync.lastSyncedAt ?? null,
    sync.syncError ?? null
  );
}

function buildLocalIssue(
  db: DatabaseSync,
  input: KanbanIssueInput,
  currentUser: KanbanCurrentUser
): KanbanIssue | null {
  const title = trimText(input.title);
  if (!title) return null;
  const timestamp = nowIso();
  const status = normalizeKanbanStatus(input.status);
  const assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  return {
    id: createLocalIssueId("local"),
    localIssueId: "",
    remoteIssueId: null,
    boardId: BOARD_ID,
    projectId: nullableTrimmedText(input.projectId) ?? PROJECT_ID,
    version: nullableTrimmedText(input.version),
    workflowId: WORKFLOW_ID,
    typeId: ISSUE_TYPE_ID,
    title,
    description: typeof input.description === "string" ? input.description.trim() : "",
    status,
    priority: normalizeKanbanPriority(input.priority),
    severity: normalizeKanbanSeverity(input.severity),
    assigneeAgentKey,
    assigneeId: nullableTrimmedText(input.assigneeId),
    workerType: normalizeWorkerType(input.workerType) ?? (assigneeAgentKey ? "agent" : null),
    workerId: nullableTrimmedText(input.workerId),
    workerAgent: nullableTrimmedText(input.workerAgent) ?? assigneeAgentKey,
    activeReviewId: null,
    activeRunId: null,
    position: nextIssuePosition(db, status),
    chatId: null,
    runId: null,
    runState: normalizeKanbanRunState(input.runState),
    automationId: nullableTrimmedText(input.automationId),
    automationEnabled: input.automationEnabled === true,
    automationCron: nullableTrimmedText(input.automationCron),
    automationMessage: nullableTrimmedText(input.automationMessage),
    automationTimezone: nullableTrimmedText(input.automationTimezone),
    attachmentChatId: nullableTrimmedText(input.attachmentChatId),
    attachments: normalizeAttachments(input.attachments),
    syncMode: "private",
    syncState: "local",
    origin: "desktop",
    ownerUserId: currentUser.id,
    lastRemoteRevision: 0,
    lastSyncedAt: null,
    syncError: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function applyIssueUpdate(issue: KanbanIssue, input: KanbanIssueUpdateInput): KanbanIssue | null {
  const nextIssue: KanbanIssue = {
    ...issue,
    attachments: [...issue.attachments],
    updatedAt: nowIso()
  };
  if (input.title !== undefined) {
    const title = trimText(input.title);
    if (!title) return null;
    nextIssue.title = title;
  }
  if (input.projectId !== undefined) nextIssue.projectId = nullableTrimmedText(input.projectId) ?? PROJECT_ID;
  if (input.version !== undefined) nextIssue.version = nullableTrimmedText(input.version);
  if (input.description !== undefined) nextIssue.description = typeof input.description === "string" ? input.description.trim() : "";
  if (input.status !== undefined) {
    nextIssue.status = normalizeKanbanStatus(input.status);
  }
  if (input.priority !== undefined) nextIssue.priority = normalizeKanbanPriority(input.priority);
  if (input.severity !== undefined) nextIssue.severity = normalizeKanbanSeverity(input.severity);
  if (input.assigneeAgentKey !== undefined) {
    nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
    nextIssue.workerAgent = nextIssue.assigneeAgentKey;
    if (nextIssue.assigneeAgentKey) nextIssue.workerType = "agent";
  }
  if (input.assigneeId !== undefined) nextIssue.assigneeId = nullableTrimmedText(input.assigneeId);
  if (input.workerType !== undefined) nextIssue.workerType = normalizeWorkerType(input.workerType);
  if (input.workerId !== undefined) nextIssue.workerId = nullableTrimmedText(input.workerId);
  if (input.workerAgent !== undefined) nextIssue.workerAgent = nullableTrimmedText(input.workerAgent);
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) {
    nextIssue.runId = nullableTrimmedText(input.runId);
    nextIssue.activeRunId = nextIssue.runId;
  }
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeKanbanRunState(input.runState);
  } else if (input.runId !== undefined) {
    nextIssue.runState = nextIssue.runId ? "running" : nextIssue.status === "completed" ? "completed" : nextIssue.runState;
  }
  if (input.automationId !== undefined) nextIssue.automationId = nullableTrimmedText(input.automationId);
  if (input.automationEnabled !== undefined) nextIssue.automationEnabled = input.automationEnabled === true;
  if (input.automationCron !== undefined) nextIssue.automationCron = nullableTrimmedText(input.automationCron);
  if (input.automationMessage !== undefined) nextIssue.automationMessage = nullableTrimmedText(input.automationMessage);
  if (input.automationTimezone !== undefined) nextIssue.automationTimezone = nullableTrimmedText(input.automationTimezone);
  if (input.attachmentChatId !== undefined) nextIssue.attachmentChatId = nullableTrimmedText(input.attachmentChatId);
  if (input.attachments !== undefined) nextIssue.attachments = normalizeAttachments(input.attachments);
  return nextIssue;
}

export function listDesktopKanbanIssues(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  connectionState: KanbanListResult["connectionState"] = "disabled"
): KanbanListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => ({
    ok: true,
    message: connectionState === "open" ? t("kanban.runtime.synced") : t("kanban.runtime.loadedFromCache"),
    issues: selectIssues(db, currentUser),
    projects: selectProjects(db),
    projectBindings: selectProjectBindings(db),
    cloudDetails: selectCloudDetailData(db, currentUser),
    storagePath: getDesktopKanbanDatabasePath(app),
    boardId: BOARD_ID,
    projectId: PROJECT_ID,
    revision: readDesktopKanbanRevision(db),
    currentUser,
    connectionState
  }));
}

export function createPrivateDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: KanbanIssueInput
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = buildLocalIssue(db, input, currentUser);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues: selectIssues(db, currentUser) };
    }
    issue.localIssueId = issue.id;
    insertOrReplaceIssue(db, issue, {
      syncMode: "private",
      syncState: "local",
      origin: "desktop",
      ownerUserId: currentUser.id
    });
    return {
      ok: true,
      message: t("kanban.runtime.privateCreated"),
      issue,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function updateDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    const nextIssue = applyIssueUpdate(issue, input);
    if (!nextIssue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues: selectIssues(db, currentUser) };
    }
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "private",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.updated"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

function updateDesktopKanbanIssueByPredicate(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  predicate: (issue: KanbanIssue) => boolean,
  input: KanbanIssueUpdateInput,
  missingMessage: string
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issues = selectIssues(db, currentUser);
    const issue = issues.find(predicate);
    if (!issue) {
      return { ok: false, message: missingMessage, issues };
    }
    const nextIssue = applyIssueUpdate(issue, input);
    if (!nextIssue) {
      return { ok: false, message: t("kanban.runtime.titleRequired"), issues };
    }
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "private",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.updated"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function updateDesktopKanbanIssueByRunId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  const targetRunId = trimText(runId);
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.runId === targetRunId || issue.activeRunId === targetRunId,
    input,
    t("kanban.runtime.runMissing")
  );
}

export function updateDesktopKanbanIssueByChatId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  chatId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  const targetChatId = trimText(chatId);
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.chatId === targetChatId || issue.attachmentChatId === targetChatId,
    input,
    t("kanban.runtime.chatMissing")
  );
}

export function moveDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: KanbanIssueMoveInput
): KanbanIssueResult {
  return setDesktopKanbanIssuePosition(app, currentUser, input.id, input.status, input.position);
}

export function setDesktopKanbanIssuePosition(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  status: KanbanStatus,
  position: number
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    const nextIssue = {
      ...issue,
      status,
      position,
      runState: status === issue.status ? issue.runState : null,
      updatedAt: nowIso()
    };
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: nextIssue.syncMode ?? "private",
      syncState: nextIssue.syncMode === "cloud" ? "synced" : "local",
      origin: nextIssue.origin ?? "desktop",
      ownerUserId: nextIssue.ownerUserId ?? currentUser.id,
      lastRemoteRevision: nextIssue.lastRemoteRevision,
      lastSyncedAt: nextIssue.lastSyncedAt,
      syncError: null
    });
    return { ok: true, message: t("kanban.runtime.moved"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function deleteDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
): KanbanDeleteResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), issueId);
    return {
      ok: true,
      message: t("kanban.runtime.deleted"),
      deletedIssueId: issueId,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function tombstoneDesktopKanbanCloudIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  remoteIssueId: string,
  revision = 0
): KanbanDeleteResult {
  const normalizedRemoteIssueId = trimText(remoteIssueId);
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`
      SELECT LOCAL_ISSUE_ID_ AS localIssueId
      FROM desktop_issue_sync
      WHERE REMOTE_ISSUE_ID_ = ?
    `).get(normalizedRemoteIssueId) as { localIssueId?: string } | undefined;
    const localIssueId = row?.localIssueId ?? "";
    const timestamp = nowIso();
    if (localIssueId) {
      db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(timestamp, timestamp, localIssueId);
      db.prepare(`
        UPDATE desktop_issue_sync
        SET SYNC_STATE_ = 'synced',
          LAST_REMOTE_REVISION_ = MAX(LAST_REMOTE_REVISION_, ?),
          LAST_SYNCED_AT_ = ?,
          SYNC_ERROR_ = NULL
        WHERE LOCAL_ISSUE_ID_ = ?
      `).run(Math.max(0, Math.floor(revision)), timestamp, localIssueId);
    }
    writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(readDesktopKanbanRevision(db), revision) });
    return {
      ok: true,
      message: t("kanban.runtime.deleted"),
      deletedIssueId: localIssueId || normalizedRemoteIssueId,
      issues: selectIssues(db, currentUser)
    };
  });
}

function cloudIssueToLocalIssue(rawIssue: Record<string, unknown>, currentUser: KanbanCurrentUser, revision: number): KanbanIssue | null {
  const remoteIssueId = trimText(rawIssue.id);
  const title = trimText(rawIssue.title);
  if (!remoteIssueId || !title) return null;
  const timestamp = trimText(rawIssue.updatedAt) || nowIso();
  const issueRevision = typeof rawIssue.revision === "number" && Number.isFinite(rawIssue.revision)
    ? Math.max(0, Math.floor(rawIssue.revision))
    : Math.max(0, Math.floor(revision));
  return {
    id: "",
    localIssueId: "",
    remoteIssueId,
    boardId: trimText(rawIssue.boardId) || BOARD_ID,
    projectId: trimText(rawIssue.projectId) || PROJECT_ID,
    projectPath: trimText(rawIssue.projectPath) || undefined,
    projectName: trimText(rawIssue.projectName) || undefined,
    version: nullableTrimmedText(rawIssue.version),
    parentIssueId: nullableTrimmedText(rawIssue.parentIssueId),
    workflowId: trimText(rawIssue.workflowId) || WORKFLOW_ID,
    typeId: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || ISSUE_TYPE_ID,
    issueTypeKey: trimText(rawIssue.issueTypeKey) || trimText(rawIssue.typeId) || ISSUE_TYPE_ID,
    stageId: trimText(rawIssue.stageId) || undefined,
    stageKey: trimText(rawIssue.stageKey) || undefined,
    stageName: trimText(rawIssue.stageName) || undefined,
    statusId: trimText(rawIssue.statusId) || undefined,
    statusName: trimText(rawIssue.statusName) || undefined,
    statusKey: trimText(rawIssue.statusKey) || undefined,
    columnKey: trimText(rawIssue.columnKey) || undefined,
    title,
    description: trimText(rawIssue.description),
    status: normalizeKanbanStatus(rawIssue.status),
    priority: normalizeKanbanPriority(rawIssue.priority),
    severity: normalizeKanbanSeverity(rawIssue.severity),
    assigneeAgentKey: nullableTrimmedText(rawIssue.assigneeAgentKey),
    assigneeId: nullableTrimmedText(rawIssue.assigneeId),
    workerType: normalizeWorkerType(rawIssue.workerType),
    workerId: nullableTrimmedText(rawIssue.workerId),
    workerAgent: nullableTrimmedText(rawIssue.workerAgent),
    activeReviewId: nullableTrimmedText(rawIssue.activeReviewId),
    activeRunId: nullableTrimmedText(rawIssue.activeRunId),
    position: typeof rawIssue.position === "number" && Number.isFinite(rawIssue.position) ? rawIssue.position : 1,
    chatId: nullableTrimmedText(rawIssue.chatId),
    runId: nullableTrimmedText(rawIssue.runId),
    runState: normalizeKanbanRunState(rawIssue.runState),
    runAgentKey: nullableTrimmedText(rawIssue.runAgentKey),
    runCommandId: nullableTrimmedText(rawIssue.runCommandId),
    runStartedAt: nullableTrimmedText(rawIssue.runStartedAt),
    runFinishedAt: nullableTrimmedText(rawIssue.runFinishedAt),
    runResultMessage: nullableTrimmedText(rawIssue.runResultMessage),
    runErrorMessage: nullableTrimmedText(rawIssue.runErrorMessage),
    dispatchState: nullableTrimmedText(rawIssue.dispatchState) as KanbanIssue["dispatchState"],
    dispatchDeviceId: nullableTrimmedText(rawIssue.dispatchDeviceId),
    dispatchCommandId: nullableTrimmedText(rawIssue.dispatchCommandId),
    dispatchUpdatedAt: nullableTrimmedText(rawIssue.dispatchUpdatedAt),
    automationId: nullableTrimmedText(rawIssue.automationId),
    automationEnabled: rawIssue.automationEnabled === true,
    automationCron: nullableTrimmedText(rawIssue.automationCron),
    automationMessage: nullableTrimmedText(rawIssue.automationMessage),
    automationTimezone: nullableTrimmedText(rawIssue.automationTimezone),
    attachmentChatId: nullableTrimmedText(rawIssue.attachmentChatId),
    attachments: normalizeAttachments(rawIssue.attachments),
    customFields: normalizeCustomFields(rawIssue.customFields),
    dueAt: parseCloudDueTime(rawIssue.dueTime),
    createdBy: nullableTrimmedText(rawIssue.createdBy),
    updatedBy: nullableTrimmedText(rawIssue.updatedBy),
    createdByAgent: nullableTrimmedText(rawIssue.createdByAgent),
    updatedByAgent: nullableTrimmedText(rawIssue.updatedByAgent),
    syncMode: "cloud",
    syncState: "synced",
    origin: "cloud_dispatch",
    ownerUserId: currentUser.id,
    lastRemoteRevision: issueRevision,
    lastSyncedAt: nowIso(),
    syncError: null,
    revision: issueRevision,
    createdAt: trimText(rawIssue.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

function findLocalSyncForRemote(db: DatabaseSync, remoteIssueId: string) {
  const row = db.prepare(`
    SELECT LOCAL_ISSUE_ID_ AS localIssueId, ORIGIN_ AS origin FROM desktop_issue_sync
    WHERE REMOTE_ISSUE_ID_ = ?
  `).get(remoteIssueId) as { localIssueId?: string; origin?: KanbanOrigin } | undefined;
  return {
    localIssueId: row?.localIssueId ?? "",
    origin: row?.origin
  };
}

function markIssueSyncState(
  db: DatabaseSync,
  currentUser: KanbanCurrentUser,
  issueId: string,
  syncState: KanbanSyncState,
  syncError: string | null
) {
  const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
  if (!issue) {
    return null;
  }
  insertOrReplaceIssue(db, issue, {
    syncMode: issue.syncMode ?? "private",
    syncState,
    origin: issue.origin ?? "desktop",
    ownerUserId: issue.ownerUserId ?? currentUser.id,
    lastRemoteRevision: issue.lastRemoteRevision,
    lastSyncedAt: issue.lastSyncedAt,
    syncError
  });
  return selectIssues(db, currentUser).find((candidate) => candidate.id === issueId) ?? issue;
}

export function markDesktopKanbanIssueSyncing(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = markIssueSyncState(db, currentUser, issueId, "syncing", null);
    return {
      ok: Boolean(issue),
      message: issue ? t("kanban.runtime.cloudSyncing") : t("kanban.runtime.missing"),
      issue: issue ?? undefined,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function markDesktopKanbanIssueSyncError(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string,
  message: string
): KanbanIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = markIssueSyncState(db, currentUser, issueId, "error", message);
    return {
      ok: false,
      message,
      issue: issue ?? undefined,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function applyDesktopKanbanCloudSnapshot(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  snapshot: KanbanCloudSnapshot,
  origin: KanbanOrigin = "cloud_dispatch"
): KanbanListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const currentRevision = readDesktopKanbanRevision(db);
    const snapshotLastSeq = typeof snapshot.lastSeq === "number" && Number.isFinite(snapshot.lastSeq)
      ? Math.max(0, Math.floor(snapshot.lastSeq))
      : undefined;
    const snapshotRevision = typeof snapshot.revision === "number" && Number.isFinite(snapshot.revision)
      ? Math.max(0, Math.floor(snapshot.revision))
      : undefined;
    const revision = snapshotLastSeq ?? snapshotRevision ?? currentRevision;
    const snapshotProjectId = trimText(snapshot.projectId);
    const snapshotProjectIds = new Set((snapshot.projectIds ?? []).map(trimText).filter(Boolean));
    const isProjectSet = snapshot.complete === true && snapshot.scope === "project_set";
    const canTombstoneMissing = snapshot.complete === true && ((snapshot.scope === "project" && Boolean(snapshotProjectId)) || isProjectSet);
    const remoteIds = new Set<string>();
    const remoteProjectIds = new Set<string>();
    const remoteBindingIds = new Set<string>();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const rawProject of snapshot.projects ?? []) {
        const project = parseCloudProject(rawProject);
        if (project) {
          remoteProjectIds.add(project.id);
          insertOrReplaceProject(db, project, "cloud");
        }
      }
      for (const rawBinding of snapshot.projectBindings ?? []) {
        const binding = parseCloudProjectBinding(rawBinding);
        if (binding) {
          remoteBindingIds.add(binding.id);
          insertOrReplaceProjectBinding(db, binding);
        }
      }
      for (const raw of snapshot.issues ?? []) {
        const cloudIssue = parseCloudIssue(raw);
        if (!cloudIssue) continue;
        const localIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
        if (!localIssue?.remoteIssueId) continue;
        remoteIds.add(localIssue.remoteIssueId);
        const existingSync = findLocalSyncForRemote(db, localIssue.remoteIssueId);
        const existingLocalId = existingSync.localIssueId;
        localIssue.id = existingLocalId || createLocalIssueId("cloud");
        localIssue.localIssueId = localIssue.id;
        insertOrReplaceIssue(db, localIssue, {
          syncMode: "cloud",
          syncState: "synced",
          origin: existingSync.origin ?? origin,
          ownerUserId: currentUser.id,
          lastRemoteRevision: localIssue.revision ?? revision,
          lastSyncedAt: nowIso(),
          syncError: null
        });
      }
      if (canTombstoneMissing) {
        const cloudRows = db.prepare(`
        SELECT sync.LOCAL_ISSUE_ID_ AS localIssueId, sync.REMOTE_ISSUE_ID_ AS remoteIssueId, sync.LAST_REMOTE_REVISION_ AS lastRemoteRevision, issue.PROJECT_ID_ AS projectId
        FROM desktop_issue_sync sync
        JOIN issue ON issue.ID_ = sync.LOCAL_ISSUE_ID_
        WHERE sync.SYNC_MODE_ = 'cloud'
      `).all() as Array<{ localIssueId: string; remoteIssueId: string | null; lastRemoteRevision: number; projectId: string }>;
        for (const row of cloudRows) {
          if (
            (isProjectSet ? snapshotProjectIds.has(row.projectId) : row.projectId === snapshotProjectId) &&
            row.remoteIssueId &&
            !remoteIds.has(row.remoteIssueId) &&
            row.lastRemoteRevision <= revision
          ) {
            db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), row.localIssueId);
          }
        }
      }
      if (isProjectSet) {
        const timestamp = nowIso();
        const cachedBindings = db.prepare(`SELECT ID_ AS id FROM project_desktop_binding WHERE DELETED_AT_ IS NULL`).all() as Array<{ id: string }>;
        const tombstoneBinding = db.prepare(`UPDATE project_desktop_binding SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ? AND DELETED_AT_ IS NULL`);
        for (const binding of cachedBindings) {
          if (!remoteBindingIds.has(binding.id)) tombstoneBinding.run(timestamp, timestamp, binding.id);
        }
        const cachedCloudProjects = db.prepare(`SELECT ID_ AS id FROM project WHERE SYNC_MODE_ = 'cloud' AND DELETED_AT_ IS NULL`).all() as Array<{ id: string }>;
        const removedProjectIds = cachedCloudProjects.map((row) => row.id).filter((id) => !remoteProjectIds.has(id));
        if (removedProjectIds.length > 0) {
          const privateContainerId = "local-private-orphans";
          db.prepare(`
            INSERT INTO project (
              ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, PATH_, DEPTH_, POSITION_, REVISION_, SYNC_MODE_,
              VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
            ) VALUES (?, NULL, 'private-orphans', 'PRIVATE', 'Private Tasks', '', 'private-orphans', 0, 999999, 0, 'private', 'private', ?, ?, ?, NULL)
            ON CONFLICT(ID_) DO UPDATE SET DELETED_AT_ = NULL, UPDATED_AT_ = excluded.UPDATED_AT_
          `).run(privateContainerId, WORKFLOW_ID, timestamp, timestamp);
          const updatePrivateIssues = db.prepare(`
            UPDATE issue SET PROJECT_ID_ = ?, UPDATED_AT_ = ?
            WHERE PROJECT_ID_ = ? AND ID_ IN (SELECT LOCAL_ISSUE_ID_ FROM desktop_issue_sync WHERE SYNC_MODE_ = 'private')
          `);
          const tombstoneCloudIssues = db.prepare(`
            UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ?
            WHERE PROJECT_ID_ = ? AND ID_ IN (SELECT LOCAL_ISSUE_ID_ FROM desktop_issue_sync WHERE SYNC_MODE_ = 'cloud')
          `);
          const tombstoneProject = db.prepare("UPDATE project SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ? AND SYNC_MODE_ = 'cloud'");
          const removeBinding = db.prepare("UPDATE project_desktop_binding SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE PROJECT_ID_ = ? AND DELETED_AT_ IS NULL");
          for (const projectId of removedProjectIds) {
            updatePrivateIssues.run(privateContainerId, timestamp, projectId);
            tombstoneCloudIssues.run(timestamp, timestamp, projectId);
            tombstoneProject.run(timestamp, timestamp, projectId);
            removeBinding.run(timestamp, timestamp, projectId);
          }
        }
      }
      storeCloudDetailData(db, currentUser, snapshot, revision);
      writeDesktopKanbanRevision(db, Math.max(currentRevision, revision));
      writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(currentRevision, revision) });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      ok: true,
      message: t("kanban.runtime.snapshotSynced"),
      issues: selectIssues(db, currentUser),
      projects: selectProjects(db),
      projectBindings: selectProjectBindings(db),
      cloudDetails: selectCloudDetailData(db, currentUser),
      storagePath: getDesktopKanbanDatabasePath(app),
      boardId: BOARD_ID,
      projectId: snapshotProjectId || PROJECT_ID,
      revision,
      currentUser,
      connectionState: "open"
    };
  });
}

export function recordDesktopKanbanCommandReceipt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: { commandId: string; deliverySeq: number; projectId?: string | null; sourceRevision?: number; payload: Record<string, unknown>; issue: unknown }
): { ok: boolean; executable: boolean; message: string; receipt: KanbanCommandReceipt } {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const commandId = trimText(input.commandId);
    const issueRecord = parseCloudIssue(input.issue);
    const issueId = trimText(issueRecord?.id);
    if (!commandId || !issueId) throw new Error("commandId and issue.id are required");
    const payloadJson = stableJson(input.payload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    const idHash = createHash("sha256").update(commandId).digest("hex").slice(0, 32);
    const timestamp = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = readCommandReceiptInDb(db, commandId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          db.prepare(`UPDATE kanban_command_receipt SET STATE_ = 'failed', LAST_ERROR_ = ?, UPDATED_AT_ = ? WHERE COMMAND_ID_ = ?`)
            .run("command payload hash mismatch", timestamp, commandId);
          db.exec("COMMIT");
          const receipt = readCommandReceiptInDb(db, commandId)!;
          return { ok: true, executable: false, message: receipt.lastError || "command payload mismatch", receipt };
        }
        db.exec("COMMIT");
        return { ok: true, executable: existing.state === "received" || existing.state === "starting", message: "command already received", receipt: existing };
      }
      const cloudIssue = cloudIssueToLocalIssue(issueRecord!, currentUser, input.sourceRevision ?? 0);
      if (!cloudIssue) throw new Error("invalid command issue snapshot");
      const existingSync = findLocalSyncForRemote(db, issueId);
      cloudIssue.id = existingSync.localIssueId || createLocalIssueId("cloud");
      cloudIssue.localIssueId = cloudIssue.id;
      insertOrReplaceIssue(db, cloudIssue, {
        syncMode: "cloud",
        syncState: "synced",
        origin: existingSync.origin ?? "cloud_dispatch",
        ownerUserId: currentUser.id,
        lastRemoteRevision: cloudIssue.revision,
        lastSyncedAt: timestamp,
        syncError: null
      });
      db.prepare(`
        INSERT INTO kanban_command_receipt (
          COMMAND_ID_, DELIVERY_SEQ_, PROJECT_ID_, ISSUE_ID_, PAYLOAD_JSON_, PAYLOAD_HASH_, CHAT_ID_, RUN_ID_, REQUEST_ID_,
          STATE_, ATTEMPT_COUNT_, LAST_ERROR_, CREATED_AT_, UPDATED_AT_
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, ?, ?)
      `).run(commandId, input.deliverySeq, trimText(input.projectId), issueId, payloadJson, payloadHash,
        `chat_kanban_${idHash}`, `run_kanban_${idHash}`, `request_kanban_${idHash}`, timestamp, timestamp);
      db.exec("COMMIT");
      return { ok: true, executable: true, message: "command received", receipt: readCommandReceiptInDb(db, commandId)! };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function listPendingDesktopKanbanCommandReceipts(app: AppPathProvider, currentUser: KanbanCurrentUser): KanbanCommandReceipt[] {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const rows = db.prepare(`
      SELECT COMMAND_ID_ AS commandId FROM kanban_command_receipt
      WHERE STATE_ IN ('received','starting','started') OR (STATE_ = 'failed' AND TERMINAL_REPORTED_AT_ IS NULL)
      ORDER BY DELIVERY_SEQ_
    `).all() as Array<{ commandId: string }>;
    return rows.map((row) => readCommandReceiptInDb(db, row.commandId)).filter((item): item is KanbanCommandReceipt => Boolean(item));
  });
}

export function updateDesktopKanbanCommandReceipt(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  commandId: string,
  state: KanbanCommandReceiptState,
  lastError: string | null = null,
  incrementAttempt = false
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`
      UPDATE kanban_command_receipt
      SET STATE_ = ?, LAST_ERROR_ = ?, ATTEMPT_COUNT_ = ATTEMPT_COUNT_ + ?, UPDATED_AT_ = ?
      WHERE COMMAND_ID_ = ? AND (? IN ('completed','failed') OR STATE_ NOT IN ('completed','failed'))
    `).run(state, lastError, incrementAttempt ? 1 : 0, nowIso(), trimText(commandId), state);
    return readCommandReceiptInDb(db, commandId);
  });
}

export function completeDesktopKanbanCommandReceiptByRunId(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  runId: string,
  state: "completed" | "failed"
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_command_receipt SET STATE_ = ?, UPDATED_AT_ = ? WHERE RUN_ID_ = ?`)
      .run(state, nowIso(), trimText(runId));
  });
}

export function markDesktopKanbanCommandReceiptReported(app: AppPathProvider, currentUser: KanbanCurrentUser, commandId: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    db.prepare(`UPDATE kanban_command_receipt SET TERMINAL_REPORTED_AT_ = ?, UPDATED_AT_ = ? WHERE COMMAND_ID_ = ?`)
      .run(nowIso(), nowIso(), trimText(commandId));
  });
}

export function hasDesktopKanbanCloudProject(app: AppPathProvider, currentUser: KanbanCurrentUser, projectId: string) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM project WHERE ID_ = ? AND SYNC_MODE_ = 'cloud' AND DELETED_AT_ IS NULL`)
      .get(trimText(projectId)) as { count?: number } | undefined;
    return (row?.count ?? 0) > 0;
  });
}

export function ensureDesktopKanbanDefaultBinding(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  deviceId: string,
  remoteProjectId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const timestamp = nowIso();
    const localProject = db.prepare(`SELECT ID_ AS id, NAME_ AS name FROM project WHERE ID_ = ? AND DELETED_AT_ IS NULL`)
      .get(PROJECT_ID) as { id: string; name: string } | undefined;
    if (!localProject) return null;
    const binding: KanbanProjectBinding = {
      id: `binding:${trimText(deviceId)}:${trimText(remoteProjectId)}:${localProject.id}`,
      projectId: trimText(remoteProjectId) || PROJECT_ID,
      deviceId: trimText(deviceId),
      currentUserId: currentUser.id,
      localProjectId: localProject.id,
      localDisplayName: localProject.name,
      syncPolicy: "future",
      controlMode: "dispatch",
      status: "active",
      lastRemoteRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    insertOrReplaceProjectBinding(db, binding);
    return binding;
  });
}

function readCommandReceiptInDb(db: DatabaseSync, commandId: string): KanbanCommandReceipt | null {
  const row = db.prepare(`
    SELECT COMMAND_ID_ AS commandId, DELIVERY_SEQ_ AS deliverySeq, PROJECT_ID_ AS projectId, ISSUE_ID_ AS issueId,
      PAYLOAD_JSON_ AS payloadJson, PAYLOAD_HASH_ AS payloadHash, CHAT_ID_ AS chatId, RUN_ID_ AS runId,
      REQUEST_ID_ AS requestId, STATE_ AS state, ATTEMPT_COUNT_ AS attemptCount, LAST_ERROR_ AS lastError,
      TERMINAL_REPORTED_AT_ AS terminalReportedAt, CREATED_AT_ AS createdAt, UPDATED_AT_ AS updatedAt
    FROM kanban_command_receipt WHERE COMMAND_ID_ = ?
  `).get(trimText(commandId)) as (Omit<KanbanCommandReceipt, "payload"> & { payloadJson: string }) | undefined;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { payload = {}; }
  const { payloadJson: _payloadJson, ...receipt } = row;
  return { ...receipt, projectId: receipt.projectId || "", payload };
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
}

export function upsertDispatchedDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issue: unknown,
  revision = 0,
  origin: KanbanOrigin = "cloud_dispatch"
): KanbanIssueResult {
  const cloudIssue = parseCloudIssue(issue);
  if (!cloudIssue) {
    return {
      ok: false,
      message: t("kanban.runtime.dispatchInvalid"),
      issues: listDesktopKanbanIssues(app, currentUser).issues
    };
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const localIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
    if (!localIssue?.remoteIssueId) {
      return { ok: false, message: t("kanban.runtime.dispatchMissingId"), issues: selectIssues(db, currentUser) };
    }
    localIssue.id = findLocalSyncForRemote(db, localIssue.remoteIssueId).localIssueId || createLocalIssueId("cloud");
    localIssue.localIssueId = localIssue.id;
    insertOrReplaceIssue(db, localIssue, {
      syncMode: "cloud",
      syncState: "synced",
      origin,
      ownerUserId: currentUser.id,
      lastRemoteRevision: localIssue.revision ?? revision,
      lastSyncedAt: nowIso(),
      syncError: null
    });
    writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(readDesktopKanbanRevision(db), revision) });
    return { ok: true, message: t("kanban.runtime.dispatched"), issue: localIssue, issues: selectIssues(db, currentUser) };
  });
}

export function linkDesktopKanbanIssueToRemote(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  localIssueId: string,
  remoteIssue: unknown,
  revision = 0
): KanbanIssueResult {
  const cloudIssue = parseCloudIssue(remoteIssue);
  if (!cloudIssue) {
    return { ok: false, message: t("kanban.runtime.cloudIssueInvalid"), issues: listDesktopKanbanIssues(app, currentUser).issues };
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const currentIssue = selectIssues(db, currentUser).find((candidate) => candidate.id === localIssueId);
    const nextIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
    if (!currentIssue || !nextIssue?.remoteIssueId) {
      return { ok: false, message: t("kanban.runtime.missing"), issues: selectIssues(db, currentUser) };
    }
    nextIssue.id = currentIssue.id;
    nextIssue.localIssueId = currentIssue.id;
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: "cloud",
      syncState: "synced",
      origin: currentIssue.origin ?? "desktop",
      ownerUserId: currentUser.id,
      lastRemoteRevision: nextIssue.revision ?? revision,
      lastSyncedAt: nowIso(),
      syncError: null
    });
    writeDesktopKanbanSyncCursorInDb(db, { lastAppliedRevision: Math.max(readDesktopKanbanRevision(db), revision) });
    return { ok: true, message: t("kanban.runtime.syncedToCloud"), issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function getDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  issueId: string
) {
  return withDesktopKanbanDatabase(app, currentUser, (db) =>
    selectIssues(db, currentUser).find((candidate) => candidate.id === issueId) ?? null
  );
}

export const __testInternals = {
  DATABASE_DIRECTORY,
  DATABASE_FILENAME,
  getDesktopKanbanDatabasePath,
  withDesktopKanbanDatabase
};
