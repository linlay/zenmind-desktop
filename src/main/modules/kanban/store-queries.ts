import { DatabaseSync } from "node:sqlite";
import type { KanbanCurrentUser, KanbanIssue, KanbanProject, KanbanProjectBinding } from "../../../shared/contracts";
import type { KanbanIssueRow, KanbanProjectRow, KanbanProjectBindingRow } from "./store-model";
import { issueFromRow, projectFromRow, projectBindingFromRow } from "./store-row-codec";

export function selectIssues(db: DatabaseSync, currentUser: KanbanCurrentUser): KanbanIssue[] {
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

export function selectProjects(db: DatabaseSync): KanbanProject[] {
  const rows = db.prepare(`
    SELECT
      ID_ AS id,
      SYNC_MODE_ AS sync_mode,
      PARENT_ID_ AS parent_id,
      SLUG_ AS slug,
      KEY_ AS key,
      NAME_ AS name,
      DESCRIPTION_ AS description,
      VERSIONS_JSON_ AS versions_json,
      COMPONENTS_JSON_ AS components_json,
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

export function selectProjectBindings(db: DatabaseSync): KanbanProjectBinding[] {
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
