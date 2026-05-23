import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskBoardIssue } from "../shared/contracts";

type AppPathProvider = {
  getPath(name: "userData"): string;
};

type TaskBoardIssueRow = {
  id: string;
  number: number;
  identifier: string;
  title: string;
  description: string;
  status: TaskBoardIssue["status"];
  priority: TaskBoardIssue["priority"];
  assignee_agent_key: string | null;
  assignee_name: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
  schedule_id: string | null;
  schedule_enabled: number;
  schedule_cron: string | null;
  schedule_message: string | null;
  schedule_timezone: string | null;
  attachment_chat_id: string | null;
  attachments_json: string;
  created_at: string;
  updated_at: string;
};

const TASK_BOARD_DIRECTORY = "task-board";
const TASK_BOARD_LEGACY_FILENAME = "issues.json";
const TASK_BOARD_DATABASE_FILENAME = "issues.sqlite";

export function getTaskBoardRoot(app: AppPathProvider) {
  return path.join(app.getPath("userData"), TASK_BOARD_DIRECTORY);
}

export function getLegacyTaskBoardIssuesPath(app: AppPathProvider) {
  return path.join(getTaskBoardRoot(app), TASK_BOARD_LEGACY_FILENAME);
}

export function getTaskBoardDatabasePath(app: AppPathProvider) {
  return path.join(getTaskBoardRoot(app), TASK_BOARD_DATABASE_FILENAME);
}

function issueFromRow(row: TaskBoardIssueRow): TaskBoardIssue {
  return {
    id: row.id,
    number: row.number,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentKey: row.assignee_agent_key,
    assigneeName: row.assignee_name,
    position: row.position,
    chatId: row.chat_id,
    runId: row.run_id,
    scheduleId: row.schedule_id,
    scheduleEnabled: row.schedule_enabled === 1,
    scheduleCron: row.schedule_cron,
    scheduleMessage: row.schedule_message,
    scheduleTimezone: row.schedule_timezone,
    attachmentChatId: row.attachment_chat_id,
    attachments: parseIssueAttachments(row.attachments_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseIssueAttachments(value: string | null | undefined): TaskBoardIssue["attachments"] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TaskBoardIssue["attachments"] : [];
  } catch {
    return [];
  }
}

function issueParams(issue: TaskBoardIssue) {
  return [
    issue.id,
    issue.number,
    issue.identifier,
    issue.title,
    issue.description,
    issue.status,
    issue.priority,
    issue.assigneeAgentKey,
    issue.assigneeName,
    issue.position,
    issue.chatId,
    issue.runId,
    issue.scheduleId,
    issue.scheduleEnabled ? 1 : 0,
    issue.scheduleCron,
    issue.scheduleMessage,
    issue.scheduleTimezone,
    issue.attachmentChatId,
    JSON.stringify(issue.attachments ?? []),
    issue.createdAt,
    issue.updatedAt
  ];
}

function hasTaskBoardIssueColumn(db: DatabaseSync, columnName: string) {
  const rows = db.prepare("PRAGMA table_info(task_board_issues)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureTaskBoardIssueColumns(db: DatabaseSync) {
  if (!hasTaskBoardIssueColumn(db, "attachment_chat_id")) {
    db.exec("ALTER TABLE task_board_issues ADD COLUMN attachment_chat_id TEXT");
  }
  if (!hasTaskBoardIssueColumn(db, "attachments_json")) {
    db.exec("ALTER TABLE task_board_issues ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensureTaskBoardIssueStatusValues(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'task_board_issues'
  `).get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("'blocked'")) {
    return;
  }

  db.exec(`
    ALTER TABLE task_board_issues RENAME TO task_board_issues_legacy_status;

    CREATE TABLE task_board_issues (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE CHECK (number > 0),
      identifier TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','blocked','in_review','done')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent','high','medium','low','none')),
      assignee_agent_key TEXT,
      assignee_name TEXT,
      position REAL NOT NULL,
      chat_id TEXT,
      run_id TEXT,
      schedule_id TEXT,
      schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1)),
      schedule_cron TEXT,
      schedule_message TEXT,
      schedule_timezone TEXT,
      attachment_chat_id TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO task_board_issues (
      id,
      number,
      identifier,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      assignee_name,
      position,
      chat_id,
      run_id,
      schedule_id,
      schedule_enabled,
      schedule_cron,
      schedule_message,
      schedule_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    )
    SELECT
      id,
      number,
      identifier,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      assignee_name,
      position,
      chat_id,
      run_id,
      schedule_id,
      schedule_enabled,
      schedule_cron,
      schedule_message,
      schedule_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    FROM task_board_issues_legacy_status;

    DROP TABLE task_board_issues_legacy_status;
  `);
}

function ensureTaskBoardIssueIndexes(db: DatabaseSync) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_board_issues_status_position
      ON task_board_issues(status, position, number);

    CREATE INDEX IF NOT EXISTS idx_task_board_issues_run_id
      ON task_board_issues(run_id)
      WHERE run_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_task_board_issues_chat_status
      ON task_board_issues(chat_id, status)
      WHERE chat_id IS NOT NULL;
  `);
}

export function openTaskBoardDatabase(app: AppPathProvider) {
  const databasePath = getTaskBoardDatabasePath(app);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_board_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_board_issues (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE CHECK (number > 0),
      identifier TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','blocked','in_review','done')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent','high','medium','low','none')),
      assignee_agent_key TEXT,
      assignee_name TEXT,
      position REAL NOT NULL,
      chat_id TEXT,
      run_id TEXT,
      schedule_id TEXT,
      schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1)),
      schedule_cron TEXT,
      schedule_message TEXT,
      schedule_timezone TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

  `);
  ensureTaskBoardIssueColumns(db);
  ensureTaskBoardIssueStatusValues(db);
  ensureTaskBoardIssueIndexes(db);
  setTaskBoardMeta(db, "schema_version", "2");
  return db;
}

export function withTaskBoardDatabase<T>(app: AppPathProvider, callback: (db: DatabaseSync) => T): T {
  const db = openTaskBoardDatabase(app);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

export function countTaskBoardIssues(db: DatabaseSync) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM task_board_issues").get() as { count: number };
  return row.count;
}

export function readTaskBoardIssues(db: DatabaseSync): TaskBoardIssue[] {
  const rows = db.prepare(`
    SELECT
      id,
      number,
      identifier,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      assignee_name,
      position,
      chat_id,
      run_id,
      schedule_id,
      schedule_enabled,
      schedule_cron,
      schedule_message,
      schedule_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    FROM task_board_issues
    ORDER BY
      CASE status
        WHEN 'backlog' THEN 0
        WHEN 'todo' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'in_review' THEN 3
        WHEN 'done' THEN 4
        WHEN 'blocked' THEN 5
        ELSE 99
      END,
      position ASC,
      number ASC
  `).all() as TaskBoardIssueRow[];
  return rows.map(issueFromRow);
}

export function replaceTaskBoardIssues(db: DatabaseSync, issues: TaskBoardIssue[]) {
  const insert = db.prepare(`
    INSERT INTO task_board_issues (
      id,
      number,
      identifier,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      assignee_name,
      position,
      chat_id,
      run_id,
      schedule_id,
      schedule_enabled,
      schedule_cron,
      schedule_message,
      schedule_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM task_board_issues").run();
    for (const issue of issues) {
      insert.run(...issueParams(issue));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setTaskBoardMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO task_board_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getTaskBoardMeta(db: DatabaseSync, key: string) {
  const row = db.prepare("SELECT value FROM task_board_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
