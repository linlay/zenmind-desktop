import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { App } from "electron";
import type {
  AssistantAttachment,
  TaskBoardCurrentUser,
  TaskBoardDeleteResult,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardOrigin,
  TaskBoardPriority,
  TaskBoardProject,
  TaskBoardProjectBinding,
  TaskBoardRunState,
  TaskBoardStatus,
  TaskBoardSyncMode,
  TaskBoardSyncState
} from "../shared/contracts";
import {
  TASK_BOARD_PRIORITIES,
  TASK_BOARD_RUN_STATES,
  TASK_BOARD_STATUSES
} from "../shared/contracts";
import { getRuntimeDataRoot } from "./user-paths";

type AppPathProvider = {
  getPath(name: Parameters<App["getPath"]>[0]): string;
};

type TaskBoardIssueRow = {
  id: string;
  remote_issue_id: string | null;
  board_id: string;
  project_id: string;
  workflow_id: string;
  type_id: string | null;
  stage_id: string | null;
  status_id: string | null;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  severity: NonNullable<TaskBoardIssue["severity"]>;
  assignee_agent_key: string | null;
  assignee_id: string | null;
  worker_type: TaskBoardIssue["workerType"];
  worker_id: string | null;
  worker_agent: string | null;
  reviewer_id: string | null;
  review_required: number;
  active_review_id: string | null;
  active_run_id: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
  run_state: TaskBoardRunState | null;
  automation_id: string | null;
  automation_enabled: number;
  automation_cron: string | null;
  automation_message: string | null;
  automation_timezone: string | null;
  attachment_chat_id: string | null;
  attachments_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  sync_mode: TaskBoardSyncMode;
  sync_state: TaskBoardSyncState;
  origin: TaskBoardOrigin;
  owner_user_id: string;
  last_remote_revision: number;
  last_synced_at: string | null;
  sync_error: string | null;
};

type TaskBoardProjectRow = {
  id: string;
  parent_id: string | null;
  slug: string;
  key: string;
  name: string;
  description: string;
  path: string;
  depth: number;
  position: number;
  visibility: string;
  default_workflow_id: string;
  created_at: string;
  updated_at: string;
};

type TaskBoardProjectBindingRow = {
  id: string;
  project_id: string;
  device_id: string;
  current_user_id: string;
  local_project_id: string;
  local_display_name: string;
  sync_policy: TaskBoardProjectBinding["syncPolicy"];
  control_mode: TaskBoardProjectBinding["controlMode"];
  status: TaskBoardProjectBinding["status"];
  last_remote_revision: number;
  created_at: string;
  updated_at: string;
};

export type TaskBoardCloudSnapshot = {
  boardId?: string;
  projectId?: string;
  revision?: number;
  complete?: boolean;
  scope?: string;
  projects?: unknown[];
  projectBindings?: unknown[];
  issues?: unknown[];
};

const BOARD_ID = "default";
const PROJECT_ID = "default";
const WORKFLOW_ID = "workflow-standard-requirement";
const ISSUE_TYPE_ID = "issue-type-standard-requirement";
const DATABASE_DIRECTORY = "desktop-kanban";
const DATABASE_FILENAME = "kanban.db";

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

function normalizeTaskBoardStatus(value: unknown): TaskBoardStatus {
  const raw = trimText(value).toLowerCase();
  return TASK_BOARD_STATUSES.includes(raw as TaskBoardStatus) ? raw as TaskBoardStatus : "backlog";
}

function normalizeTaskBoardPriority(value: unknown): TaskBoardPriority {
  return typeof value === "string" && TASK_BOARD_PRIORITIES.includes(value as TaskBoardPriority)
    ? value as TaskBoardPriority
    : "medium";
}

function normalizeTaskBoardSeverity(value: unknown): NonNullable<TaskBoardIssue["severity"]> {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeTaskBoardRunState(value: unknown): TaskBoardRunState | null {
  return typeof value === "string" && TASK_BOARD_RUN_STATES.includes(value as TaskBoardRunState)
    ? value as TaskBoardRunState
    : null;
}

function normalizeWorkerType(value: unknown): TaskBoardIssue["workerType"] {
  return value === "human" || value === "agent" ? value : null;
}

function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

function parseAttachmentsJson(value: string | null | undefined): AssistantAttachment[] {
  if (!value) return [];
  try {
    return normalizeAttachments(JSON.parse(value));
  } catch {
    return [];
  }
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
      PATH_ TEXT NOT NULL,
      DEPTH_ INTEGER NOT NULL DEFAULT 0,
      POSITION_ REAL NOT NULL DEFAULT 0,
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
      STATUS_ID_ TEXT,
      TITLE_ TEXT NOT NULL CHECK (length(trim(TITLE_)) > 0),
      DESCRIPTION_ TEXT NOT NULL DEFAULT '',
      STATUS_ TEXT NOT NULL CHECK (STATUS_ IN ('backlog','todo','in_progress','in_review','completed')),
      PRIORITY_ TEXT NOT NULL CHECK (PRIORITY_ IN ('high','medium','low')),
      SEVERITY_ TEXT NOT NULL DEFAULT 'medium' CHECK (SEVERITY_ IN ('critical','high','medium','low')),
      POSITION_ REAL NOT NULL,
      ASSIGNEE_AGENT_KEY_ TEXT,
      ASSIGNEE_ID_ TEXT,
      WORKER_TYPE_ TEXT CHECK (WORKER_TYPE_ IN ('human','agent') OR WORKER_TYPE_ IS NULL),
      WORKER_ID_ TEXT,
      WORKER_AGENT_ TEXT,
      REVIEWER_ID_ TEXT,
      REVIEW_REQUIRED_ INTEGER NOT NULL DEFAULT 0,
      ACTIVE_REVIEW_ID_ TEXT,
      ACTIVE_RUN_ID_ TEXT,
      CHAT_ID_ TEXT,
      RUN_ID_ TEXT,
      RUN_STATE_ TEXT CHECK (RUN_STATE_ IN ('running','completed','failed','cancelled') OR RUN_STATE_ IS NULL),
      AUTOMATION_ID_ TEXT,
      AUTOMATION_ENABLED_ INTEGER NOT NULL DEFAULT 0,
      AUTOMATION_CRON_ TEXT,
      AUTOMATION_MESSAGE_ TEXT,
      AUTOMATION_TIMEZONE_ TEXT,
      ATTACHMENT_CHAT_ID_ TEXT,
      ATTACHMENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
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
}

function seedDesktopKanban(db: DatabaseSync, currentUser: TaskBoardCurrentUser) {
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
    VALUES (?, 'standard_requirement', '标准需求', '', 1, ?, ?)
    ON CONFLICT(ID_) DO NOTHING
  `).run(WORKFLOW_ID, timestamp, timestamp);
  const statuses: Array<{ id: string; key: TaskBoardStatus; name: string; position: number; terminal: number; review: number }> = [
    { id: "workflow-status-backlog", key: "backlog", name: "新建", position: 1, terminal: 0, review: 0 },
    { id: "workflow-status-todo", key: "todo", name: "待办", position: 2, terminal: 0, review: 0 },
    { id: "workflow-status-in-progress", key: "in_progress", name: "处理中", position: 3, terminal: 0, review: 0 },
    { id: "workflow-status-in-review", key: "in_review", name: "待审查", position: 4, terminal: 0, review: 1 },
    { id: "workflow-status-completed", key: "completed", name: "已完成", position: 5, terminal: 1, review: 0 }
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
  currentUser: TaskBoardCurrentUser,
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

function issueFromRow(row: TaskBoardIssueRow): TaskBoardIssue {
  return {
    id: row.id,
    localIssueId: row.id,
    remoteIssueId: row.remote_issue_id,
    boardId: row.board_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    typeId: row.type_id ?? undefined,
    stageId: row.stage_id ?? undefined,
    statusId: row.status_id ?? undefined,
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
    reviewerId: row.reviewer_id,
    reviewRequired: row.review_required === 1,
    activeReviewId: row.active_review_id,
    activeRunId: row.active_run_id,
    position: row.position,
    chatId: row.chat_id,
    runId: row.run_id,
    runState: row.run_state,
    automationId: row.automation_id,
    automationEnabled: row.automation_enabled === 1,
    automationCron: row.automation_cron,
    automationMessage: row.automation_message,
    automationTimezone: row.automation_timezone,
    attachmentChatId: row.attachment_chat_id,
    attachments: parseAttachmentsJson(row.attachments_json),
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

function projectFromRow(row: TaskBoardProjectRow): TaskBoardProject {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    key: row.key || undefined,
    name: row.name,
    description: row.description || undefined,
    path: row.path,
    depth: row.depth,
    position: row.position,
    visibility: row.visibility || undefined,
    defaultWorkflowId: row.default_workflow_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectBindingFromRow(row: TaskBoardProjectBindingRow): TaskBoardProjectBinding {
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

function parseCloudProject(value: unknown): TaskBoardProject | null {
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
    path: trimText(record.path) || id,
    depth: typeof record.depth === "number" && Number.isFinite(record.depth) ? record.depth : 0,
    position: typeof record.position === "number" && Number.isFinite(record.position) ? record.position : 0,
    visibility: trimText(record.visibility) || undefined,
    defaultWorkflowId: trimText(record.defaultWorkflowId) || WORKFLOW_ID,
    createdAt: trimText(record.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

function parseCloudProjectBinding(value: unknown): TaskBoardProjectBinding | null {
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
  const controlMode = record.controlMode === "observe" || record.controlMode === "disabled" ? record.controlMode : "dispatch";
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

function writeDesktopKanbanRevision(db: DatabaseSync, revision: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, 'revision', ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, String(Math.max(0, Math.floor(revision))));
}

function selectIssues(db: DatabaseSync, currentUser: TaskBoardCurrentUser): TaskBoardIssue[] {
  const rows = db.prepare(`
    SELECT
      issue.ID_ AS id,
      issue.REMOTE_ISSUE_ID_ AS remote_issue_id,
      issue.BOARD_ID_ AS board_id,
      issue.PROJECT_ID_ AS project_id,
      issue.WORKFLOW_ID_ AS workflow_id,
      issue.TYPE_ID_ AS type_id,
      issue.STAGE_ID_ AS stage_id,
      issue.STATUS_ID_ AS status_id,
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
      issue.REVIEWER_ID_ AS reviewer_id,
      issue.REVIEW_REQUIRED_ AS review_required,
      issue.ACTIVE_REVIEW_ID_ AS active_review_id,
      issue.ACTIVE_RUN_ID_ AS active_run_id,
      issue.POSITION_ AS position,
      issue.CHAT_ID_ AS chat_id,
      issue.RUN_ID_ AS run_id,
      issue.RUN_STATE_ AS run_state,
      issue.AUTOMATION_ID_ AS automation_id,
      issue.AUTOMATION_ENABLED_ AS automation_enabled,
      issue.AUTOMATION_CRON_ AS automation_cron,
      issue.AUTOMATION_MESSAGE_ AS automation_message,
      issue.AUTOMATION_TIMEZONE_ AS automation_timezone,
      issue.ATTACHMENT_CHAT_ID_ AS attachment_chat_id,
      issue.ATTACHMENTS_JSON_ AS attachments_json,
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
  `).all(currentUser.id) as TaskBoardIssueRow[];
  return rows.map(issueFromRow);
}

function selectProjects(db: DatabaseSync): TaskBoardProject[] {
  const rows = db.prepare(`
    SELECT
      ID_ AS id,
      PARENT_ID_ AS parent_id,
      SLUG_ AS slug,
      KEY_ AS key,
      NAME_ AS name,
      DESCRIPTION_ AS description,
      PATH_ AS path,
      DEPTH_ AS depth,
      POSITION_ AS position,
      VISIBILITY_ AS visibility,
      DEFAULT_WORKFLOW_ID_ AS default_workflow_id,
      CREATED_AT_ AS created_at,
      UPDATED_AT_ AS updated_at
    FROM project
    WHERE DELETED_AT_ IS NULL
    ORDER BY DEPTH_ ASC, POSITION_ ASC, NAME_ ASC, ID_ ASC
  `).all() as TaskBoardProjectRow[];
  return rows.map(projectFromRow);
}

function selectProjectBindings(db: DatabaseSync): TaskBoardProjectBinding[] {
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
  `).all() as TaskBoardProjectBindingRow[];
  return rows.map(projectBindingFromRow);
}

function nextIssuePosition(db: DatabaseSync, status: TaskBoardStatus) {
  const row = db.prepare(`
    SELECT MAX(POSITION_) AS maxPosition FROM issue
    WHERE STATUS_ = ? AND DELETED_AT_ IS NULL
  `).get(status) as { maxPosition?: number | null } | undefined;
  return typeof row?.maxPosition === "number" && Number.isFinite(row.maxPosition) ? row.maxPosition + 1 : 1;
}

function insertOrReplaceProject(db: DatabaseSync, project: TaskBoardProject) {
  db.prepare(`
    INSERT INTO project (
      ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, PATH_, DEPTH_, POSITION_,
      VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      PARENT_ID_ = excluded.PARENT_ID_,
      SLUG_ = excluded.SLUG_,
      KEY_ = excluded.KEY_,
      NAME_ = excluded.NAME_,
      DESCRIPTION_ = excluded.DESCRIPTION_,
      PATH_ = excluded.PATH_,
      DEPTH_ = excluded.DEPTH_,
      POSITION_ = excluded.POSITION_,
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
    project.path,
    project.depth,
    project.position,
    project.visibility ?? "workspace",
    project.defaultWorkflowId ?? WORKFLOW_ID,
    project.createdAt,
    project.updatedAt
  );
}

function insertOrReplaceProjectBinding(db: DatabaseSync, binding: TaskBoardProjectBinding) {
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

function insertOrReplaceIssue(db: DatabaseSync, issue: TaskBoardIssue, sync: {
  syncMode: TaskBoardSyncMode;
  syncState: TaskBoardSyncState;
  origin: TaskBoardOrigin;
  ownerUserId: string;
  lastRemoteRevision?: number;
  lastSyncedAt?: string | null;
  syncError?: string | null;
}) {
  db.prepare(`
    INSERT INTO issue (
      ID_, REMOTE_ISSUE_ID_, BOARD_ID_, PROJECT_ID_, WORKFLOW_ID_, TYPE_ID_, STAGE_ID_, STATUS_ID_,
      TITLE_, DESCRIPTION_, STATUS_, PRIORITY_, SEVERITY_, POSITION_, ASSIGNEE_AGENT_KEY_, ASSIGNEE_ID_,
      WORKER_TYPE_, WORKER_ID_, WORKER_AGENT_, REVIEWER_ID_, REVIEW_REQUIRED_, ACTIVE_REVIEW_ID_, ACTIVE_RUN_ID_,
      CHAT_ID_, RUN_ID_, RUN_STATE_, AUTOMATION_ID_, AUTOMATION_ENABLED_, AUTOMATION_CRON_, AUTOMATION_MESSAGE_,
      AUTOMATION_TIMEZONE_, ATTACHMENT_CHAT_ID_, ATTACHMENTS_JSON_, REVISION_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      REMOTE_ISSUE_ID_ = excluded.REMOTE_ISSUE_ID_,
      BOARD_ID_ = excluded.BOARD_ID_,
      PROJECT_ID_ = excluded.PROJECT_ID_,
      WORKFLOW_ID_ = excluded.WORKFLOW_ID_,
      TYPE_ID_ = excluded.TYPE_ID_,
      STAGE_ID_ = excluded.STAGE_ID_,
      STATUS_ID_ = excluded.STATUS_ID_,
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
      REVIEWER_ID_ = excluded.REVIEWER_ID_,
      REVIEW_REQUIRED_ = excluded.REVIEW_REQUIRED_,
      ACTIVE_REVIEW_ID_ = excluded.ACTIVE_REVIEW_ID_,
      ACTIVE_RUN_ID_ = excluded.ACTIVE_RUN_ID_,
      CHAT_ID_ = excluded.CHAT_ID_,
      RUN_ID_ = excluded.RUN_ID_,
      RUN_STATE_ = excluded.RUN_STATE_,
      AUTOMATION_ID_ = excluded.AUTOMATION_ID_,
      AUTOMATION_ENABLED_ = excluded.AUTOMATION_ENABLED_,
      AUTOMATION_CRON_ = excluded.AUTOMATION_CRON_,
      AUTOMATION_MESSAGE_ = excluded.AUTOMATION_MESSAGE_,
      AUTOMATION_TIMEZONE_ = excluded.AUTOMATION_TIMEZONE_,
      ATTACHMENT_CHAT_ID_ = excluded.ATTACHMENT_CHAT_ID_,
      ATTACHMENTS_JSON_ = excluded.ATTACHMENTS_JSON_,
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
    issue.statusId ?? null,
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
    issue.reviewerId ?? null,
    issue.reviewRequired ? 1 : 0,
    issue.activeReviewId ?? null,
    issue.activeRunId ?? issue.runId ?? null,
    issue.chatId,
    issue.runId,
    issue.runState,
    issue.automationId,
    issue.automationEnabled ? 1 : 0,
    issue.automationCron,
    issue.automationMessage,
    issue.automationTimezone,
    issue.attachmentChatId,
    JSON.stringify(issue.attachments ?? []),
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
  input: TaskBoardIssueInput,
  currentUser: TaskBoardCurrentUser
): TaskBoardIssue | null {
  const title = trimText(input.title);
  if (!title) return null;
  const timestamp = nowIso();
  const status = normalizeTaskBoardStatus(input.status);
  const assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  return {
    id: createLocalIssueId("local"),
    localIssueId: "",
    remoteIssueId: null,
    boardId: BOARD_ID,
    projectId: nullableTrimmedText(input.projectId) ?? PROJECT_ID,
    workflowId: WORKFLOW_ID,
    typeId: ISSUE_TYPE_ID,
    title,
    description: typeof input.description === "string" ? input.description.trim() : "",
    status,
    priority: normalizeTaskBoardPriority(input.priority),
    severity: normalizeTaskBoardSeverity(input.severity),
    assigneeAgentKey,
    assigneeId: nullableTrimmedText(input.assigneeId),
    workerType: normalizeWorkerType(input.workerType) ?? (assigneeAgentKey ? "agent" : null),
    workerId: nullableTrimmedText(input.workerId),
    workerAgent: nullableTrimmedText(input.workerAgent) ?? assigneeAgentKey,
    reviewerId: nullableTrimmedText(input.reviewerId),
    reviewRequired: input.reviewRequired === true || status === "in_review",
    activeReviewId: null,
    activeRunId: null,
    position: nextIssuePosition(db, status),
    chatId: null,
    runId: null,
    runState: normalizeTaskBoardRunState(input.runState),
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

function applyIssueUpdate(issue: TaskBoardIssue, input: TaskBoardIssueUpdateInput): TaskBoardIssue | null {
  const nextIssue: TaskBoardIssue = {
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
  if (input.description !== undefined) nextIssue.description = typeof input.description === "string" ? input.description.trim() : "";
  if (input.status !== undefined) {
    nextIssue.status = normalizeTaskBoardStatus(input.status);
    nextIssue.reviewRequired = nextIssue.reviewRequired || nextIssue.status === "in_review";
  }
  if (input.priority !== undefined) nextIssue.priority = normalizeTaskBoardPriority(input.priority);
  if (input.severity !== undefined) nextIssue.severity = normalizeTaskBoardSeverity(input.severity);
  if (input.assigneeAgentKey !== undefined) {
    nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
    nextIssue.workerAgent = nextIssue.assigneeAgentKey;
    if (nextIssue.assigneeAgentKey) nextIssue.workerType = "agent";
  }
  if (input.assigneeId !== undefined) nextIssue.assigneeId = nullableTrimmedText(input.assigneeId);
  if (input.workerType !== undefined) nextIssue.workerType = normalizeWorkerType(input.workerType);
  if (input.workerId !== undefined) nextIssue.workerId = nullableTrimmedText(input.workerId);
  if (input.workerAgent !== undefined) nextIssue.workerAgent = nullableTrimmedText(input.workerAgent);
  if (input.reviewerId !== undefined) nextIssue.reviewerId = nullableTrimmedText(input.reviewerId);
  if (input.reviewRequired !== undefined) nextIssue.reviewRequired = input.reviewRequired === true;
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) {
    nextIssue.runId = nullableTrimmedText(input.runId);
    nextIssue.activeRunId = nextIssue.runId;
  }
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeTaskBoardRunState(input.runState);
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
  currentUser: TaskBoardCurrentUser,
  connectionState: TaskBoardListResult["connectionState"] = "disabled"
): TaskBoardListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => ({
    ok: true,
    message: connectionState === "open" ? "任务看板已同步。" : "任务看板已从本地缓存加载。",
    issues: selectIssues(db, currentUser),
    projects: selectProjects(db),
    projectBindings: selectProjectBindings(db),
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
  currentUser: TaskBoardCurrentUser,
  input: TaskBoardIssueInput
): TaskBoardIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = buildLocalIssue(db, input, currentUser);
    if (!issue) {
      return { ok: false, message: "任务标题不能为空。", issues: selectIssues(db, currentUser) };
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
      message: "私有任务已创建。",
      issue,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function updateDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  issueId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: "任务不存在。", issues: selectIssues(db, currentUser) };
    }
    const nextIssue = applyIssueUpdate(issue, input);
    if (!nextIssue) {
      return { ok: false, message: "任务标题不能为空。", issues: selectIssues(db, currentUser) };
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
    return { ok: true, message: "任务已更新。", issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

function updateDesktopKanbanIssueByPredicate(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  predicate: (issue: TaskBoardIssue) => boolean,
  input: TaskBoardIssueUpdateInput,
  missingMessage: string
): TaskBoardIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issues = selectIssues(db, currentUser);
    const issue = issues.find(predicate);
    if (!issue) {
      return { ok: false, message: missingMessage, issues };
    }
    const nextIssue = applyIssueUpdate(issue, input);
    if (!nextIssue) {
      return { ok: false, message: "任务标题不能为空。", issues };
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
    return { ok: true, message: "任务已更新。", issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function updateDesktopKanbanIssueByRunId(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  runId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const targetRunId = trimText(runId);
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.runId === targetRunId || issue.activeRunId === targetRunId,
    input,
    "任务运行不存在。"
  );
}

export function updateDesktopKanbanIssueByChatId(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  chatId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const targetChatId = trimText(chatId);
  return updateDesktopKanbanIssueByPredicate(
    app,
    currentUser,
    (issue) => issue.chatId === targetChatId || issue.attachmentChatId === targetChatId,
    input,
    "任务会话不存在。"
  );
}

export function moveDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  input: TaskBoardIssueMoveInput
): TaskBoardIssueResult {
  return setDesktopKanbanIssuePosition(app, currentUser, input.id, input.status, input.position);
}

export function setDesktopKanbanIssuePosition(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  issueId: string,
  status: TaskBoardStatus,
  position: number
): TaskBoardIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: "任务不存在。", issues: selectIssues(db, currentUser) };
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
    return { ok: true, message: "任务已移动。", issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function deleteDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  issueId: string
): TaskBoardDeleteResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = selectIssues(db, currentUser).find((candidate) => candidate.id === issueId);
    if (!issue) {
      return { ok: false, message: "任务不存在。", issues: selectIssues(db, currentUser) };
    }
    db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), issueId);
    return {
      ok: true,
      message: "任务已删除。",
      deletedIssueId: issueId,
      issues: selectIssues(db, currentUser)
    };
  });
}

function cloudIssueToLocalIssue(rawIssue: Record<string, unknown>, currentUser: TaskBoardCurrentUser, revision: number): TaskBoardIssue | null {
  const remoteIssueId = trimText(rawIssue.id);
  const title = trimText(rawIssue.title);
  if (!remoteIssueId || !title) return null;
  const timestamp = trimText(rawIssue.updatedAt) || nowIso();
  return {
    id: "",
    localIssueId: "",
    remoteIssueId,
    boardId: trimText(rawIssue.boardId) || BOARD_ID,
    projectId: trimText(rawIssue.projectId) || PROJECT_ID,
    workflowId: trimText(rawIssue.workflowId) || WORKFLOW_ID,
    typeId: trimText(rawIssue.typeId) || ISSUE_TYPE_ID,
    stageId: trimText(rawIssue.stageId) || undefined,
    statusId: trimText(rawIssue.statusId) || undefined,
    title,
    description: trimText(rawIssue.description),
    status: normalizeTaskBoardStatus(rawIssue.status),
    priority: normalizeTaskBoardPriority(rawIssue.priority),
    severity: normalizeTaskBoardSeverity(rawIssue.severity),
    assigneeAgentKey: nullableTrimmedText(rawIssue.assigneeAgentKey),
    assigneeId: nullableTrimmedText(rawIssue.assigneeId),
    workerType: normalizeWorkerType(rawIssue.workerType),
    workerId: nullableTrimmedText(rawIssue.workerId),
    workerAgent: nullableTrimmedText(rawIssue.workerAgent),
    reviewerId: nullableTrimmedText(rawIssue.reviewerId),
    reviewRequired: rawIssue.reviewRequired === true,
    activeReviewId: nullableTrimmedText(rawIssue.activeReviewId),
    activeRunId: nullableTrimmedText(rawIssue.activeRunId),
    position: typeof rawIssue.position === "number" && Number.isFinite(rawIssue.position) ? rawIssue.position : 1,
    chatId: nullableTrimmedText(rawIssue.chatId),
    runId: nullableTrimmedText(rawIssue.runId),
    runState: normalizeTaskBoardRunState(rawIssue.runState),
    automationId: nullableTrimmedText(rawIssue.automationId),
    automationEnabled: rawIssue.automationEnabled === true,
    automationCron: nullableTrimmedText(rawIssue.automationCron),
    automationMessage: nullableTrimmedText(rawIssue.automationMessage),
    automationTimezone: nullableTrimmedText(rawIssue.automationTimezone),
    attachmentChatId: nullableTrimmedText(rawIssue.attachmentChatId),
    attachments: normalizeAttachments(rawIssue.attachments),
    syncMode: "cloud",
    syncState: "synced",
    origin: "cloud_dispatch",
    ownerUserId: currentUser.id,
    lastRemoteRevision: revision,
    lastSyncedAt: nowIso(),
    syncError: null,
    revision: typeof rawIssue.revision === "number" ? rawIssue.revision : revision,
    createdAt: trimText(rawIssue.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

function findLocalSyncForRemote(db: DatabaseSync, remoteIssueId: string) {
  const row = db.prepare(`
    SELECT LOCAL_ISSUE_ID_ AS localIssueId, ORIGIN_ AS origin FROM desktop_issue_sync
    WHERE REMOTE_ISSUE_ID_ = ?
  `).get(remoteIssueId) as { localIssueId?: string; origin?: TaskBoardOrigin } | undefined;
  return {
    localIssueId: row?.localIssueId ?? "",
    origin: row?.origin
  };
}

function markIssueSyncState(
  db: DatabaseSync,
  currentUser: TaskBoardCurrentUser,
  issueId: string,
  syncState: TaskBoardSyncState,
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
  currentUser: TaskBoardCurrentUser,
  issueId: string
): TaskBoardIssueResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const issue = markIssueSyncState(db, currentUser, issueId, "syncing", null);
    return {
      ok: Boolean(issue),
      message: issue ? "云同步任务正在同步。" : "任务不存在。",
      issue: issue ?? undefined,
      issues: selectIssues(db, currentUser)
    };
  });
}

export function markDesktopKanbanIssueSyncError(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  issueId: string,
  message: string
): TaskBoardIssueResult {
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
  currentUser: TaskBoardCurrentUser,
  snapshot: TaskBoardCloudSnapshot,
  origin: TaskBoardOrigin = "cloud_dispatch"
): TaskBoardListResult {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const revision = typeof snapshot.revision === "number" ? snapshot.revision : readDesktopKanbanRevision(db);
    const snapshotProjectId = trimText(snapshot.projectId);
    const canTombstoneMissing = snapshot.complete === true && snapshot.scope === "project" && Boolean(snapshotProjectId);
    const remoteIds = new Set<string>();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const rawProject of snapshot.projects ?? []) {
        const project = parseCloudProject(rawProject);
        if (project) {
          insertOrReplaceProject(db, project);
        }
      }
      for (const rawBinding of snapshot.projectBindings ?? []) {
        const binding = parseCloudProjectBinding(rawBinding);
        if (binding) {
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
          lastRemoteRevision: revision,
          lastSyncedAt: nowIso(),
          syncError: null
        });
      }
      if (canTombstoneMissing) {
        const cloudRows = db.prepare(`
        SELECT sync.LOCAL_ISSUE_ID_ AS localIssueId, sync.REMOTE_ISSUE_ID_ AS remoteIssueId, issue.PROJECT_ID_ AS projectId
        FROM desktop_issue_sync sync
        JOIN issue ON issue.ID_ = sync.LOCAL_ISSUE_ID_
        WHERE sync.SYNC_MODE_ = 'cloud'
      `).all() as Array<{ localIssueId: string; remoteIssueId: string | null; projectId: string }>;
        for (const row of cloudRows) {
          if (row.projectId === snapshotProjectId && row.remoteIssueId && !remoteIds.has(row.remoteIssueId)) {
            db.prepare("UPDATE issue SET DELETED_AT_ = ?, UPDATED_AT_ = ? WHERE ID_ = ?").run(nowIso(), nowIso(), row.localIssueId);
          }
        }
      }
      writeDesktopKanbanRevision(db, revision);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      ok: true,
      message: "云端任务快照已同步。",
      issues: selectIssues(db, currentUser),
      projects: selectProjects(db),
      projectBindings: selectProjectBindings(db),
      storagePath: getDesktopKanbanDatabasePath(app),
      boardId: BOARD_ID,
      projectId: snapshotProjectId || PROJECT_ID,
      revision,
      currentUser,
      connectionState: "open"
    };
  });
}

export function upsertDispatchedDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  issue: unknown,
  revision = 0,
  origin: TaskBoardOrigin = "cloud_dispatch"
): TaskBoardIssueResult {
  const cloudIssue = parseCloudIssue(issue);
  if (!cloudIssue) {
    return {
      ok: false,
      message: "派发任务格式无效。",
      issues: listDesktopKanbanIssues(app, currentUser).issues
    };
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const localIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
    if (!localIssue?.remoteIssueId) {
      return { ok: false, message: "派发任务缺少 ID。", issues: selectIssues(db, currentUser) };
    }
    localIssue.id = findLocalSyncForRemote(db, localIssue.remoteIssueId).localIssueId || createLocalIssueId("cloud");
    localIssue.localIssueId = localIssue.id;
    insertOrReplaceIssue(db, localIssue, {
      syncMode: "cloud",
      syncState: "synced",
      origin,
      ownerUserId: currentUser.id,
      lastRemoteRevision: revision,
      lastSyncedAt: nowIso(),
      syncError: null
    });
    return { ok: true, message: "云端任务已派发到 Desktop。", issue: localIssue, issues: selectIssues(db, currentUser) };
  });
}

export function linkDesktopKanbanIssueToRemote(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  localIssueId: string,
  remoteIssue: unknown,
  revision = 0
): TaskBoardIssueResult {
  const cloudIssue = parseCloudIssue(remoteIssue);
  if (!cloudIssue) {
    return { ok: false, message: "云端任务格式无效。", issues: listDesktopKanbanIssues(app, currentUser).issues };
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const currentIssue = selectIssues(db, currentUser).find((candidate) => candidate.id === localIssueId);
    const nextIssue = cloudIssueToLocalIssue(cloudIssue, currentUser, revision);
    if (!currentIssue || !nextIssue?.remoteIssueId) {
      return { ok: false, message: "任务不存在。", issues: selectIssues(db, currentUser) };
    }
    nextIssue.id = currentIssue.id;
    nextIssue.localIssueId = currentIssue.id;
    insertOrReplaceIssue(db, nextIssue, {
      syncMode: "cloud",
      syncState: "synced",
      origin: currentIssue.origin ?? "desktop",
      ownerUserId: currentUser.id,
      lastRemoteRevision: revision,
      lastSyncedAt: nowIso(),
      syncError: null
    });
    return { ok: true, message: "任务已同步到云端看板。", issue: nextIssue, issues: selectIssues(db, currentUser) };
  });
}

export function getDesktopKanbanIssue(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
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
