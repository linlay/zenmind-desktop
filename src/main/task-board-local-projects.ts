import { randomUUID } from "node:crypto";
import type {
  TaskBoardCreateLocalProjectResult,
  TaskBoardCurrentUser,
  TaskBoardIssue,
  TaskBoardIssueSyncItemResult,
  TaskBoardProject
} from "../shared/contracts";
import {
  linkDesktopKanbanIssueToRemote,
  listDesktopKanbanIssues,
  markDesktopKanbanIssueSyncError,
  withDesktopKanbanDatabase
} from "./task-board-local-store";

type AppPathProvider = {
  getPath: (name: "userData") => string;
};

const DEFAULT_PARENT_PROJECT_ID = "default";
const DEFAULT_WORKFLOW_ID = "workflow-standard-requirement";

function nowIso() {
  return new Date().toISOString();
}

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `project-${Date.now().toString(36)}`;
}

function createLocalProjectId() {
  return `localproj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export type CreateLocalDesktopProjectInput = {
  id?: string;
  name: string;
  slug?: string;
};

// 创建本地项目(响应云端 desktop.project.createLocal)。
// 本地项目的 PATH_ 是逻辑路径(slug 链),不涉及文件系统路径,无需平台分支。
export function createLocalDesktopProject(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  input: CreateLocalDesktopProjectInput
): TaskBoardCreateLocalProjectResult {
  const name = trimText(input.name);
  if (!name) {
    return { ok: false, message: "本地项目名称不能为空。" };
  }
  const id = trimText(input.id) || createLocalProjectId();
  const slug = trimText(input.slug) || slugify(name);
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const existing = db.prepare(`
      SELECT ID_ AS id, NAME_ AS name, SLUG_ AS slug, PATH_ AS path FROM project
      WHERE ID_ = ? AND DELETED_AT_ IS NULL
    `).get(id) as { id?: string; name?: string; slug?: string; path?: string } | undefined;
    if (existing?.id) {
      return {
        ok: true,
        message: "本地项目已存在。",
        project: {
          id: existing.id,
          name: existing.name ?? name,
          slug: existing.slug ?? slug,
          path: existing.path ?? ""
        }
      };
    }
    const timestamp = nowIso();
    const parent = db.prepare(`
      SELECT PATH_ AS path, DEPTH_ AS depth FROM project
      WHERE ID_ = ? AND DELETED_AT_ IS NULL
    `).get(DEFAULT_PARENT_PROJECT_ID) as { path?: string; depth?: number } | undefined;
    const parentPath = parent?.path ?? "default";
    const depth = (parent?.depth ?? 0) + 1;
    const path = `${parentPath}/${slug}`;
    const maxPosition = db.prepare(`
      SELECT MAX(POSITION_) AS maxPosition FROM project
      WHERE PARENT_ID_ = ? AND DELETED_AT_ IS NULL
    `).get(DEFAULT_PARENT_PROJECT_ID) as { maxPosition?: number | null } | undefined;
    const position = typeof maxPosition?.maxPosition === "number" ? maxPosition.maxPosition + 1 : 1;
    db.prepare(`
      INSERT INTO project (
        ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, PATH_, DEPTH_, POSITION_,
        VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'workspace', ?, ?, ?)
    `).run(
      id,
      DEFAULT_PARENT_PROJECT_ID,
      slug,
      slug.toUpperCase(),
      name,
      path,
      depth,
      position,
      DEFAULT_WORKFLOW_ID,
      timestamp,
      timestamp
    );
    return {
      ok: true,
      message: "本地项目已创建。",
      project: { id, name, slug, path }
    };
  });
}

// 校验本地项目是否存在(响应云端 desktop.project.bind)。
export function findLocalDesktopProject(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  localProjectId: string
): TaskBoardProject | null {
  const id = trimText(localProjectId);
  if (!id) {
    return null;
  }
  const result = listDesktopKanbanIssues(app, currentUser);
  return (result.projects ?? []).find((project) => project.id === id) ?? null;
}

// 解绑后把该本地项目下的 cloud issue 转为 private(本地保留副本,不再随云端同步)。
export function convertLocalProjectIssuesToPrivate(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  localProjectId: string
): number {
  const id = trimText(localProjectId);
  if (!id) {
    return 0;
  }
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const rows = db.prepare(`
      SELECT sync.LOCAL_ISSUE_ID_ AS localIssueId
      FROM desktop_issue_sync sync
      JOIN issue ON issue.ID_ = sync.LOCAL_ISSUE_ID_
      WHERE sync.SYNC_MODE_ = 'cloud' AND issue.PROJECT_ID_ = ? AND issue.DELETED_AT_ IS NULL
    `).all(id) as Array<{ localIssueId: string }>;
    const update = db.prepare(`
      UPDATE desktop_issue_sync
      SET SYNC_MODE_ = 'private', SYNC_STATE_ = 'local', REMOTE_ISSUE_ID_ = NULL, SYNC_ERROR_ = NULL
      WHERE LOCAL_ISSUE_ID_ = ?
    `);
    const clearRemote = db.prepare(`
      UPDATE issue SET REMOTE_ISSUE_ID_ = NULL, UPDATED_AT_ = ? WHERE ID_ = ?
    `);
    const timestamp = nowIso();
    for (const row of rows) {
      update.run(row.localIssueId);
      clearRemote.run(timestamp, row.localIssueId);
    }
    return rows.length;
  });
}

// 收集等待上行的本地 issue:origin=desktop 且 syncState 为 local/error。
// localProjectIds 为空数组时返回空(无 active 绑定即无需上行)。
export function listPendingUpstreamIssues(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  localProjectIds: string[]
): TaskBoardIssue[] {
  const ids = localProjectIds.map((value) => trimText(value)).filter(Boolean);
  if (ids.length === 0) {
    return [];
  }
  const result = listDesktopKanbanIssues(app, currentUser);
  return result.issues.filter((issue) =>
    issue.origin === "desktop" &&
    (issue.syncState === "local" || issue.syncState === "error") &&
    ids.includes(issue.projectId ?? "")
  );
}

// 把 desktop.issue.sync 的逐条结果回写本地库:
//   created/updated → 用云端权威版覆盖本地并建立映射(syncState=synced)
//   conflict        → 云端 revision 优先,同样用云端版覆盖本地
//   deleted/skipped → 标记 synced(deleted 表示云端已确认删除)
//   error           → syncState=error 并记录消息
export function applyDesktopIssueSyncResults(
  app: AppPathProvider,
  currentUser: TaskBoardCurrentUser,
  results: TaskBoardIssueSyncItemResult[],
  revision = 0
): { synced: number; conflicts: number; errors: number } {
  let synced = 0;
  let conflicts = 0;
  let errors = 0;
  for (const item of results) {
    const localIssueId = trimText(item.localIssueId);
    if (!localIssueId) {
      continue;
    }
    if ((item.status === "created" || item.status === "updated") && item.issue) {
      linkDesktopKanbanIssueToRemote(app, currentUser, localIssueId, item.issue, revision);
      synced += 1;
      continue;
    }
    if (item.status === "conflict") {
      conflicts += 1;
      if (item.issue) {
        linkDesktopKanbanIssueToRemote(app, currentUser, localIssueId, item.issue, revision);
      } else {
        markDesktopKanbanIssueSyncError(app, currentUser, localIssueId, item.message || "云端版本冲突。");
      }
      continue;
    }
    if (item.status === "error") {
      errors += 1;
      markDesktopKanbanIssueSyncError(app, currentUser, localIssueId, item.message || "云端同步失败。");
      continue;
    }
    if (item.status === "deleted") {
      synced += 1;
    }
  }
  return { synced, conflicts, errors };
}
