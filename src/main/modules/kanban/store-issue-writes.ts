import { DatabaseSync } from "node:sqlite";
import type { KanbanStatus, KanbanIssue, KanbanSyncMode, KanbanSyncState, KanbanOrigin } from "../../../shared/contracts";
import { BOARD_ID, PROJECT_ID, buildIssueDetailJson } from "./store-values";

export function nextIssuePosition(db: DatabaseSync, status: KanbanStatus) {
  const row = db.prepare(`
    SELECT MAX(POSITION_) AS maxPosition FROM issue
    WHERE STATUS_ = ? AND DELETED_AT_ IS NULL
  `).get(status) as { maxPosition?: number | null } | undefined;
  return typeof row?.maxPosition === "number" && Number.isFinite(row.maxPosition) ? row.maxPosition + 1 : 1;
}

export function insertOrReplaceIssue(db: DatabaseSync, issue: KanbanIssue, sync: {
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
    issue.syncMode === "cloud" ? issue.workflowId ?? "" : issue.localWorkflow?.id ?? "",
    issue.syncMode === "cloud" ? issue.typeId ?? null : null,
    issue.stageId ?? null,
    issue.stageName ?? null,
    issue.statusId ?? null,
    issue.statusName ?? null,
    issue.title.trim(),
    issue.description,
    issue.status,
    issue.priority,
    issue.severity,
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
