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

import { AppPathProvider, BOARD_ID, DATABASE_SCHEMA_VERSION, PROJECT_ID, WORKFLOW_ID, getDesktopKanbanDatabasePath, nowIso, nullableTrimmedText, parseJsonRecord, readLegacyDueDate } from "./local-store.part-1";

export function ensureDesktopKanbanSchema(db: DatabaseSync) {
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
      COMPONENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
      PATH_ TEXT NOT NULL,
      DEPTH_ INTEGER NOT NULL DEFAULT 0,
      POSITION_ REAL NOT NULL DEFAULT 0,
      REVISION_ INTEGER NOT NULL DEFAULT 0,
      SYNC_MODE_ TEXT NOT NULL DEFAULT 'local' CHECK (SYNC_MODE_ IN ('local','cloud')),
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
      PRIORITY_ TEXT CHECK (PRIORITY_ IS NULL OR PRIORITY_ IN ('P0','P1','P2','P3')),
      SEVERITY_ TEXT CHECK (SEVERITY_ IS NULL OR SEVERITY_ IN ('critical','high','medium','low')),
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
      SYNC_MODE_ TEXT NOT NULL CHECK (SYNC_MODE_ IN ('local','cloud')),
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
      ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT '',
      COMMAND_TYPE_ TEXT NOT NULL DEFAULT 'run' CHECK (COMMAND_TYPE_ IN ('run','review')),
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

    CREATE TABLE IF NOT EXISTS kanban_cloud_mutation_outbox (
      ID_ TEXT PRIMARY KEY,
      REQUEST_TYPE_ TEXT NOT NULL CHECK (REQUEST_TYPE_ IN ('issue.claim')),
      PROJECT_ID_ TEXT NOT NULL,
      ISSUE_ID_ TEXT NOT NULL,
      PAYLOAD_JSON_ TEXT NOT NULL,
      ATTEMPT_COUNT_ INTEGER NOT NULL DEFAULT 0,
      LAST_ERROR_ TEXT,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kanban_run_event_outbox (
      CLIENT_EVENT_ID_ TEXT PRIMARY KEY,
      PROJECT_ID_ TEXT NOT NULL,
      ISSUE_ID_ TEXT NOT NULL,
      ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT '',
      EXTERNAL_RUN_ID_ TEXT NOT NULL DEFAULT '',
      RUN_ID_ TEXT NOT NULL,
      CHAT_ID_ TEXT NOT NULL,
      EVENT_TYPE_ TEXT NOT NULL,
      SOURCE_DELIVERY_SEQ_ INTEGER NOT NULL DEFAULT 0,
      PAYLOAD_JSON_ TEXT NOT NULL,
      ATTEMPT_COUNT_ INTEGER NOT NULL DEFAULT 0,
      LAST_ERROR_ TEXT,
      CREATED_AT_ TEXT NOT NULL,
      UPDATED_AT_ TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kanban_manual_run_receipt (
      ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT '',
      RUN_ID_ TEXT PRIMARY KEY,
      CHAT_ID_ TEXT NOT NULL,
      ISSUE_ID_ TEXT NOT NULL,
      PROJECT_ID_ TEXT NOT NULL,
      AGENT_KEY_ TEXT NOT NULL,
      STATE_ TEXT NOT NULL CHECK (STATE_ IN ('starting','started','completed','failed','cancelled')),
      LAST_ERROR_ TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_kanban_cloud_mutation_outbox_created
      ON kanban_cloud_mutation_outbox(CREATED_AT_, ID_);

    CREATE INDEX IF NOT EXISTS idx_kanban_run_event_outbox_created
      ON kanban_run_event_outbox(CREATED_AT_, CLIENT_EVENT_ID_);

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
  ensureDesktopKanbanSyncModeConstraint(db);
  ensureDesktopKanbanPriorityConstraint(db);
  migrateDesktopKanbanIssueDetailJson(db);
}

export function ensureDesktopKanbanSyncModeConstraint(db: DatabaseSync) {
  const projectSchema = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'project'
  `).get() as { sql?: string } | undefined;
  const issueSyncSchema = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'desktop_issue_sync'
  `).get() as { sql?: string } | undefined;
  if (
    projectSchema?.sql?.includes("SYNC_MODE_ IN ('local','cloud')") &&
    issueSyncSchema?.sql?.includes("SYNC_MODE_ IN ('local','cloud')")
  ) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE project_sync_mode_migration (
        ID_ TEXT PRIMARY KEY,
        PARENT_ID_ TEXT,
        SLUG_ TEXT NOT NULL,
        KEY_ TEXT NOT NULL DEFAULT '',
        NAME_ TEXT NOT NULL,
        DESCRIPTION_ TEXT NOT NULL DEFAULT '',
        VERSIONS_JSON_ TEXT NOT NULL DEFAULT '[]',
        COMPONENTS_JSON_ TEXT NOT NULL DEFAULT '[]',
        PATH_ TEXT NOT NULL,
        DEPTH_ INTEGER NOT NULL DEFAULT 0,
        POSITION_ REAL NOT NULL DEFAULT 0,
        REVISION_ INTEGER NOT NULL DEFAULT 0,
        SYNC_MODE_ TEXT NOT NULL DEFAULT 'local' CHECK (SYNC_MODE_ IN ('local','cloud')),
        VISIBILITY_ TEXT NOT NULL DEFAULT 'workspace',
        DEFAULT_WORKFLOW_ID_ TEXT NOT NULL,
        CREATED_AT_ TEXT NOT NULL,
        UPDATED_AT_ TEXT NOT NULL,
        DELETED_AT_ TEXT
      );

      INSERT INTO project_sync_mode_migration (
        ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, VERSIONS_JSON_, COMPONENTS_JSON_, PATH_, DEPTH_, POSITION_,
        REVISION_, SYNC_MODE_, VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
      )
      SELECT
        ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, VERSIONS_JSON_, COMPONENTS_JSON_, PATH_, DEPTH_, POSITION_,
        REVISION_, CASE SYNC_MODE_ WHEN 'private' THEN 'local' ELSE SYNC_MODE_ END,
        VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
      FROM project;

      CREATE TABLE desktop_issue_sync_mode_migration (
        LOCAL_ISSUE_ID_ TEXT PRIMARY KEY REFERENCES issue(ID_) ON DELETE CASCADE,
        REMOTE_ISSUE_ID_ TEXT,
        SYNC_MODE_ TEXT NOT NULL CHECK (SYNC_MODE_ IN ('local','cloud')),
        SYNC_STATE_ TEXT NOT NULL CHECK (SYNC_STATE_ IN ('local','syncing','synced','error')),
        ORIGIN_ TEXT NOT NULL CHECK (ORIGIN_ IN ('desktop','cloud_dispatch')),
        OWNER_USER_ID_ TEXT NOT NULL,
        LAST_REMOTE_REVISION_ INTEGER NOT NULL DEFAULT 0,
        LAST_SYNCED_AT_ TEXT,
        SYNC_ERROR_ TEXT
      );

      INSERT INTO desktop_issue_sync_mode_migration (
        LOCAL_ISSUE_ID_, REMOTE_ISSUE_ID_, SYNC_MODE_, SYNC_STATE_, ORIGIN_, OWNER_USER_ID_,
        LAST_REMOTE_REVISION_, LAST_SYNCED_AT_, SYNC_ERROR_
      )
      SELECT
        LOCAL_ISSUE_ID_, REMOTE_ISSUE_ID_, CASE SYNC_MODE_ WHEN 'private' THEN 'local' ELSE SYNC_MODE_ END,
        SYNC_STATE_, ORIGIN_, OWNER_USER_ID_, LAST_REMOTE_REVISION_, LAST_SYNCED_AT_, SYNC_ERROR_
      FROM desktop_issue_sync;

      DROP TABLE desktop_issue_sync;
      ALTER TABLE desktop_issue_sync_mode_migration RENAME TO desktop_issue_sync;
      DROP TABLE project;
      ALTER TABLE project_sync_mode_migration RENAME TO project;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_issue_sync_remote
        ON desktop_issue_sync(REMOTE_ISSUE_ID_)
        WHERE REMOTE_ISSUE_ID_ IS NOT NULL;

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

export function ensureDesktopKanbanIssueColumns(db: DatabaseSync) {
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
  if (!projectColumns.has("COMPONENTS_JSON_")) db.exec("ALTER TABLE project ADD COLUMN COMPONENTS_JSON_ TEXT NOT NULL DEFAULT '[]'");
  if (!projectColumns.has("SYNC_MODE_")) {
    db.exec("ALTER TABLE project ADD COLUMN SYNC_MODE_ TEXT NOT NULL DEFAULT 'local'");
    db.exec(`UPDATE project SET SYNC_MODE_ = 'cloud' WHERE ID_ IN (SELECT DISTINCT PROJECT_ID_ FROM issue JOIN desktop_issue_sync ON desktop_issue_sync.LOCAL_ISSUE_ID_ = issue.ID_ WHERE desktop_issue_sync.SYNC_MODE_ = 'cloud')`);
  }
  const receiptColumns = new Set((db.prepare("PRAGMA table_info(kanban_command_receipt)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!receiptColumns.has("TERMINAL_REPORTED_AT_")) db.exec("ALTER TABLE kanban_command_receipt ADD COLUMN TERMINAL_REPORTED_AT_ TEXT");
  if (!receiptColumns.has("ISSUE_RUN_ID_")) db.exec("ALTER TABLE kanban_command_receipt ADD COLUMN ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT ''");
  if (!receiptColumns.has("COMMAND_TYPE_")) db.exec("ALTER TABLE kanban_command_receipt ADD COLUMN COMMAND_TYPE_ TEXT NOT NULL DEFAULT 'run'");
  const eventColumns = new Set((db.prepare("PRAGMA table_info(kanban_run_event_outbox)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!eventColumns.has("ISSUE_RUN_ID_")) db.exec("ALTER TABLE kanban_run_event_outbox ADD COLUMN ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT ''");
  if (!eventColumns.has("EXTERNAL_RUN_ID_")) db.exec("ALTER TABLE kanban_run_event_outbox ADD COLUMN EXTERNAL_RUN_ID_ TEXT NOT NULL DEFAULT ''");
  const manualRunColumns = new Set((db.prepare("PRAGMA table_info(kanban_manual_run_receipt)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!manualRunColumns.has("ISSUE_RUN_ID_")) db.exec("ALTER TABLE kanban_manual_run_receipt ADD COLUMN ISSUE_RUN_ID_ TEXT NOT NULL DEFAULT ''");
}

export function ensureDesktopKanbanPriorityConstraint(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'issue'
  `).get() as { sql?: string } | undefined;
  if (
    row?.sql?.includes("'P0'") &&
    row.sql.includes("'P3'") &&
    !/PRIORITY_\s+TEXT\s+NOT NULL/iu.test(row.sql) &&
    !/SEVERITY_\s+TEXT\s+NOT NULL/iu.test(row.sql)
  ) return;

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
        PRIORITY_ TEXT CHECK (PRIORITY_ IS NULL OR PRIORITY_ IN ('P0','P1','P2','P3')),
        SEVERITY_ TEXT CHECK (SEVERITY_ IS NULL OR SEVERITY_ IN ('critical','high','medium','low')),
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
          WHEN 'urgent' THEN 'P0'
          WHEN 'high' THEN 'P1'
          WHEN 'medium' THEN 'P2'
          WHEN 'low' THEN 'P3'
          ELSE NULL
        END,
        CASE WHEN SEVERITY_ IN ('critical','high','medium','low') THEN SEVERITY_ ELSE NULL END,
        POSITION_, ASSIGNEE_AGENT_KEY_, ASSIGNEE_ID_,
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

export function migrateDesktopKanbanIssueDetailJson(db: DatabaseSync) {
  const rows = db.prepare("SELECT ID_ AS id, DETAIL_JSON_ AS detail_json FROM issue").all() as Array<{ id: string; detail_json: string }>;
  const update = db.prepare("UPDATE issue SET DETAIL_JSON_ = ? WHERE ID_ = ?");
  for (const row of rows) {
    const detail = parseJsonRecord(row.detail_json);
    let changed = false;
    if (!("projectVersion" in detail) && "version" in detail) {
      detail.projectVersion = nullableTrimmedText(detail.version);
      changed = true;
    }
    if (!("dueDate" in detail)) {
      const legacyDueDate = readLegacyDueDate(detail.dueTime, detail.dueAt);
      if (legacyDueDate !== undefined) {
        detail.dueDate = legacyDueDate;
        changed = true;
      }
    }
    for (const legacyKey of ["version", "dueTime", "dueAt"] as const) {
      if (legacyKey in detail) {
        delete detail[legacyKey];
        changed = true;
      }
    }
    if (changed) update.run(JSON.stringify(detail), row.id);
  }
}

export function seedDesktopKanban(db: DatabaseSync, currentUser: KanbanCurrentUser) {
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
    VALUES (?, 'schema_version', ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, String(DATABASE_SCHEMA_VERSION));
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
