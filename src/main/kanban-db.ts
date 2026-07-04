import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KanbanIssue } from "../shared/contracts";
import { getDataRoot } from "./user-paths";

type AppPathProvider = {
  getPath(name: "home"): string;
};

type KanbanIssueRow = {
  id: string;
  title: string;
  description: string;
  status: KanbanIssue["status"];
  priority: KanbanIssue["priority"];
  assignee_agent_key: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
  run_state: KanbanIssue["runState"];
  automation_id: string | null;
  automation_enabled: number;
  automation_cron: string | null;
  automation_message: string | null;
  automation_timezone: string | null;
  attachment_chat_id: string | null;
  attachments_json: string;
  created_at: string;
  updated_at: string;
};

const KANBAN_DATABASE_FILENAME = "kanban.db";

export function getKanbanRoot(app: AppPathProvider) {
  return getDataRoot(app as Parameters<typeof getDataRoot>[0]);
}

export function getKanbanDatabasePath(app: AppPathProvider) {
  return path.join(getKanbanRoot(app), KANBAN_DATABASE_FILENAME);
}

function issueFromRow(row: KanbanIssueRow): KanbanIssue {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentKey: row.assignee_agent_key,
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
    attachments: parseIssueAttachments(row.attachments_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseIssueAttachments(value: string | null | undefined): KanbanIssue["attachments"] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as KanbanIssue["attachments"] : [];
  } catch {
    return [];
  }
}

function issueParams(issue: KanbanIssue) {
  return [
    issue.id,
    issue.title,
    issue.description,
    issue.status,
    issue.priority,
    issue.assigneeAgentKey,
    issue.position,
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
    issue.createdAt,
    issue.updatedAt
  ];
}

function ensureKanbanIssueColumns(db: DatabaseSync) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(kanban_issues)").all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (!columns.has("run_state")) {
    db.exec(`
      ALTER TABLE kanban_issues
      ADD COLUMN run_state TEXT CHECK (run_state IN ('running','completed','failed','cancelled'))
    `);
  }
}

function ensureKanbanRunStateConstraint(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'kanban_issues'
  `).get() as { sql?: string } | undefined;
  if (!row?.sql || (row.sql.includes("'cancelled'") && row.sql.includes("'in_review'"))) {
    return;
  }
  db.exec(`
    ALTER TABLE kanban_issues RENAME TO kanban_issues_old_run_state;

    CREATE TABLE kanban_issues (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','completed')),
      priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
      assignee_agent_key TEXT,
      position REAL NOT NULL,
      chat_id TEXT,
      run_id TEXT,
      run_state TEXT CHECK (run_state IN ('running','completed','failed','cancelled')),
      automation_id TEXT,
      automation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automation_enabled IN (0, 1)),
      automation_cron TEXT,
      automation_message TEXT,
      automation_timezone TEXT,
      attachment_chat_id TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO kanban_issues (
      id,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      position,
      chat_id,
      run_id,
      run_state,
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    )
    SELECT
      id,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      position,
      chat_id,
      run_id,
      run_state,
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    FROM kanban_issues_old_run_state;

    DROP TABLE kanban_issues_old_run_state;
  `);
}

function ensureKanbanIssueIndexes(db: DatabaseSync) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kanban_issues_status_position
      ON kanban_issues(status, position, id);

    CREATE INDEX IF NOT EXISTS idx_kanban_issues_run_id
      ON kanban_issues(run_id)
      WHERE run_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_kanban_issues_chat_status
      ON kanban_issues(chat_id, status)
      WHERE chat_id IS NOT NULL;
  `);
}

export function openKanbanDatabase(app: AppPathProvider) {
  const databasePath = getKanbanDatabasePath(app);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kanban_issues (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','completed')),
      priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
      assignee_agent_key TEXT,
      position REAL NOT NULL,
      chat_id TEXT,
      run_id TEXT,
      run_state TEXT CHECK (run_state IN ('running','completed','failed','cancelled')),
      automation_id TEXT,
      automation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automation_enabled IN (0, 1)),
      automation_cron TEXT,
      automation_message TEXT,
      automation_timezone TEXT,
      attachment_chat_id TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureKanbanIssueColumns(db);
  ensureKanbanRunStateConstraint(db);
  ensureKanbanIssueIndexes(db);
  setKanbanMeta(db, "schema_version", "5");
  return db;
}

export function withKanbanDatabase<T>(app: AppPathProvider, callback: (db: DatabaseSync) => T): T {
  const db = openKanbanDatabase(app);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

export function readKanbanIssues(db: DatabaseSync): KanbanIssue[] {
  const rows = db.prepare(`
    SELECT
      id,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      position,
      chat_id,
      run_id,
      run_state,
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    FROM kanban_issues
    ORDER BY
      CASE status
        WHEN 'backlog' THEN 0
        WHEN 'todo' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'in_review' THEN 3
        WHEN 'completed' THEN 4
        ELSE 99
      END,
      position ASC,
      id ASC
  `).all() as KanbanIssueRow[];
  return rows.map(issueFromRow);
}

export function replaceKanbanIssues(db: DatabaseSync, issues: KanbanIssue[]) {
  const insert = db.prepare(`
    INSERT INTO kanban_issues (
      id,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      position,
      chat_id,
      run_id,
      run_state,
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM kanban_issues").run();
    for (const issue of issues) {
      insert.run(...issueParams(issue));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setKanbanMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO kanban_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
