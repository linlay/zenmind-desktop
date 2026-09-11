import { randomUUID } from "node:crypto";
import type {
  KanbanCreateLocalProjectResult,
  KanbanCurrentUser,
  KanbanProject
} from "../../../shared/contracts";
import {
  listDesktopKanbanIssues,
  withDesktopKanbanDatabase
} from "./local-store";
import { t } from "../../support/i18n/main-i18n";

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
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
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
  versions?: string[];
  components?: string[];
};

// 创建本地项目(响应云端 desktop.project.createLocal)。
// 本地项目的 PATH_ 是逻辑路径(slug 链),不涉及文件系统路径,无需平台分支。
export function createLocalDesktopProject(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  input: CreateLocalDesktopProjectInput
): KanbanCreateLocalProjectResult {
  const name = trimText(input.name);
  if (!name) {
    return { ok: false, message: t("kanban.localProject.nameRequired") };
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
        message: t("kanban.localProject.exists"),
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
        ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, VERSIONS_JSON_, COMPONENTS_JSON_, PATH_, DEPTH_, POSITION_,
        VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'workspace', ?, ?, ?)
    `).run(
      id,
      DEFAULT_PARENT_PROJECT_ID,
      slug,
      slug.toUpperCase(),
      name,
      JSON.stringify((input.versions ?? []).map(trimText).filter(Boolean)),
      JSON.stringify((input.components ?? []).map(trimText).filter(Boolean)),
      path,
      depth,
      position,
      DEFAULT_WORKFLOW_ID,
      timestamp,
      timestamp
    );
    return {
      ok: true,
      message: t("kanban.localProject.created"),
      project: { id, name, slug, path }
    };
  });
}

// 校验本地项目是否存在(响应云端 desktop.project.bind)。
export function findLocalDesktopProject(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  localProjectId: string
): KanbanProject | null {
  const id = trimText(localProjectId);
  if (!id) {
    return null;
  }
  const result = listDesktopKanbanIssues(app, currentUser);
  return (result.projects ?? []).find((project) => project.id === id) ?? null;
}

// 解绑后把该本地项目下的 cloud issue 转为 local(本地保留副本,不再随云端同步)。
export function convertLocalProjectIssuesToLocal(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
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
      SET SYNC_MODE_ = 'local', SYNC_STATE_ = 'local', REMOTE_ISSUE_ID_ = NULL, SYNC_ERROR_ = NULL
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
