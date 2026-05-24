import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskBoardIssue } from "../shared/contracts";

type AppPathProvider = {
  getPath(name: "home"): string;
};

type TaskBoardIssueRow = {
  id: string;
  title: string;
  description: string;
  status: TaskBoardIssue["status"];
  priority: TaskBoardIssue["priority"];
  assignee_agent_key: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
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

const TASK_BOARD_DIRECTORY = path.join(".zenmind", ".desktop");
const TASK_BOARD_DATABASE_FILENAME = "task-board.db";

export function getTaskBoardRoot(app: AppPathProvider) {
  return path.join(app.getPath("home"), TASK_BOARD_DIRECTORY);
}

export function getTaskBoardDatabasePath(app: AppPathProvider) {
  return path.join(getTaskBoardRoot(app), TASK_BOARD_DATABASE_FILENAME);
}

function issueFromRow(row: TaskBoardIssueRow): TaskBoardIssue {
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
    issue.title,
    issue.description,
    issue.status,
    issue.priority,
    issue.assigneeAgentKey,
    issue.position,
    issue.chatId,
    issue.runId,
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

function ensureTaskBoardIssueIndexes(db: DatabaseSync) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_board_issues_status_position
      ON task_board_issues(status, position, id);

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
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','completed')),
      priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
      assignee_agent_key TEXT,
      position REAL NOT NULL,
      chat_id TEXT,
      run_id TEXT,
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
  ensureTaskBoardIssueIndexes(db);
  setTaskBoardMeta(db, "schema_version", "3");
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

export function readTaskBoardIssues(db: DatabaseSync): TaskBoardIssue[] {
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
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
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
        WHEN 'completed' THEN 3
        ELSE 99
      END,
      position ASC,
      id ASC
  `).all() as TaskBoardIssueRow[];
  return rows.map(issueFromRow);
}

export function replaceTaskBoardIssues(db: DatabaseSync, issues: TaskBoardIssue[]) {
  const insert = db.prepare(`
    INSERT INTO task_board_issues (
      id,
      title,
      description,
      status,
      priority,
      assignee_agent_key,
      position,
      chat_id,
      run_id,
      automation_id,
      automation_enabled,
      automation_cron,
      automation_message,
      automation_timezone,
      attachment_chat_id,
      attachments_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
