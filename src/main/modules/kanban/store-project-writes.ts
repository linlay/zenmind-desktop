import { DatabaseSync } from "node:sqlite";
import type { KanbanProject, KanbanSyncMode, KanbanProjectBinding, KanbanCurrentUser } from "../../../shared/contracts";
import type { AppPathProvider } from "./store-model";
import { withDesktopKanbanDatabase } from "./store-database";
import { trimText, nowIso, PROJECT_ID } from "./store-values";

export function insertOrReplaceProject(db: DatabaseSync, project: KanbanProject, syncMode: KanbanSyncMode = "cloud") {
  db.prepare(`
    INSERT INTO project (
      ID_, PARENT_ID_, SLUG_, KEY_, NAME_, DESCRIPTION_, VERSIONS_JSON_, COMPONENTS_JSON_, PATH_, DEPTH_, POSITION_,
      REVISION_, SYNC_MODE_, VISIBILITY_, DEFAULT_WORKFLOW_ID_, CREATED_AT_, UPDATED_AT_, DELETED_AT_
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(ID_) DO UPDATE SET
      PARENT_ID_ = excluded.PARENT_ID_,
      SLUG_ = excluded.SLUG_,
      KEY_ = excluded.KEY_,
      NAME_ = excluded.NAME_,
      DESCRIPTION_ = excluded.DESCRIPTION_,
      VERSIONS_JSON_ = excluded.VERSIONS_JSON_,
      COMPONENTS_JSON_ = excluded.COMPONENTS_JSON_,
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
    JSON.stringify(project.components ?? []),
    project.path,
    project.depth,
    project.position,
    project.revision ?? 0,
    syncMode,
    project.visibility ?? "workspace",
    project.defaultWorkflowId ?? "",
    project.createdAt,
    project.updatedAt
  );
}

export function insertOrReplaceProjectBinding(db: DatabaseSync, binding: KanbanProjectBinding) {
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
