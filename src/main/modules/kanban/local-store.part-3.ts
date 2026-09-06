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

import { AppPathProvider, BOARD_ID, ISSUE_TYPE_ID, KanbanDesktopSyncCursor, KanbanIssueRow, KanbanProjectBindingRow, KanbanProjectRow, PROJECT_ID, SYNC_CACHE_SCHEMA_VERSION, WORKFLOW_ID, buildIssueDetailJson, createLocalIssueId, normalizeAttachments, normalizeCustomFields, normalizeDueDate, normalizeEffortSeconds, normalizeKanbanPriority, normalizeKanbanRunState, normalizeKanbanSeverity, normalizeKanbanStatus, normalizeStringList, normalizeWorkerType, nowIso, nullableTrimmedText, parseAttachmentsJson, parseCloudIssue, parseJsonRecord, parseStringList, readStoredDueDate, trimText } from "./local-store.part-1";

import { withDesktopKanbanDatabase } from "./local-store.part-2";

export function issueFromRow(row: KanbanIssueRow): KanbanIssue {
  const detail = parseJsonRecord(row.detail_json);
  return {
    id: row.id,
    localIssueId: row.id,
    remoteIssueId: row.remote_issue_id,
    boardId: row.board_id,
    projectId: row.project_id,
    projectPath: trimText(detail.projectPath) || undefined,
    projectName: trimText(detail.projectName) || undefined,
    projectVersion: nullableTrimmedText(detail.projectVersion),
    dueDate: readStoredDueDate(detail),
    dueRisk: nullableTrimmedText(detail.dueRisk),
    resolution: nullableTrimmedText(detail.resolution),
    securityLevelKey: nullableTrimmedText(detail.securityLevelKey),
    reporterId: nullableTrimmedText(detail.reporterId),
    componentKeys: normalizeStringList(detail.componentKeys),
    originalEstimate: normalizeEffortSeconds(detail.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(detail.remainingEstimate),
    timeSpent: normalizeEffortSeconds(detail.timeSpent),
    parentIssueId: nullableTrimmedText(detail.parentIssueId),
    workflowId: row.workflow_id,
    typeId: row.type_id ?? undefined,
    issueTypeKey: trimText(detail.issueTypeKey) || row.type_id || undefined,
    stageId: row.stage_id ?? undefined,
    stageKey: trimText(detail.stageKey) || undefined,
    stageName: row.stage_name ?? undefined,
    statusId: row.status_id ?? undefined,
    statusName: row.status_name ?? undefined,
    statusKey: trimText(detail.statusKey) || undefined,
    columnKey: trimText(detail.columnKey) || undefined,
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
    activeReviewId: row.active_review_id,
    activeIssueRunId: nullableTrimmedText(detail.activeIssueRunId),
    activeRunId: row.active_run_id,
    position: row.position,
    chatId: row.chat_id,
    runId: row.run_id,
    runState: row.run_state,
    runAgentKey: nullableTrimmedText(detail.runAgentKey),
    runCommandId: nullableTrimmedText(detail.runCommandId),
    runStartedAt: nullableTrimmedText(detail.runStartedAt),
    runFinishedAt: nullableTrimmedText(detail.runFinishedAt),
    runResultMessage: nullableTrimmedText(detail.runResultMessage),
    runErrorMessage: nullableTrimmedText(detail.runErrorMessage),
    dispatchState: row.dispatch_state,
    dispatchDeviceId: row.dispatch_device_id,
    dispatchCommandId: row.dispatch_command_id,
    dispatchUpdatedAt: row.dispatch_updated_at,
    automationId: row.automation_id,
    automationEnabled: row.automation_enabled === 1,
    automationCron: row.automation_cron,
    automationMessage: row.automation_message,
    automationTimezone: row.automation_timezone,
    attachmentChatId: row.attachment_chat_id,
    attachments: parseAttachmentsJson(row.attachments_json),
    customFields: normalizeCustomFields(detail.customFields),
    createdBy: nullableTrimmedText(detail.createdBy),
    updatedBy: nullableTrimmedText(detail.updatedBy),
    createdByAgent: nullableTrimmedText(detail.createdByAgent),
    updatedByAgent: nullableTrimmedText(detail.updatedByAgent),
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

export function projectFromRow(row: KanbanProjectRow): KanbanProject {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    key: row.key || undefined,
    name: row.name,
    description: row.description || undefined,
    versions: parseStringList(row.versions_json),
    components: parseStringList(row.components_json),
    path: row.path,
    depth: row.depth,
    position: row.position,
    revision: row.revision,
    visibility: row.visibility || undefined,
    defaultWorkflowId: row.default_workflow_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function projectBindingFromRow(row: KanbanProjectBindingRow): KanbanProjectBinding {
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

export function parseCloudProject(value: unknown): KanbanProject | null {
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
    versions: normalizeStringList(record.versions),
    components: normalizeStringList(record.components),
    path: trimText(record.path) || id,
    depth: typeof record.depth === "number" && Number.isFinite(record.depth) ? record.depth : 0,
    position: typeof record.position === "number" && Number.isFinite(record.position) ? record.position : 0,
    revision: typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0,
    visibility: trimText(record.visibility) || undefined,
    defaultWorkflowId: trimText(record.defaultWorkflowId) || WORKFLOW_ID,
    createdAt: trimText(record.createdAt) || timestamp,
    updatedAt: timestamp
  };
}

export function parseCloudProjectBinding(value: unknown): KanbanProjectBinding | null {
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
  const controlMode = record.controlMode === "observe" || record.controlMode === "readonly"
    ? "observe"
    : record.controlMode === "disabled" ? "disabled" : "dispatch";
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

export function readDesktopKanbanRevision(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = 'revision'
  `).get(BOARD_ID) as { value?: string } | undefined;
  const revision = Number.parseInt(row?.value ?? "0", 10);
  return Number.isFinite(revision) ? revision : 0;
}

export function readBoardMetaInteger(db: DatabaseSync, key: string, fallback = 0) {
  const row = db.prepare(`
    SELECT VALUE_ AS value FROM board_meta
    WHERE BOARD_ID_ = ? AND KEY_ = ?
  `).get(BOARD_ID, key) as { value?: string } | undefined;
  const value = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function writeBoardMetaInteger(db: DatabaseSync, key: string, value: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, ?, ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, key, String(Math.max(0, Math.floor(value))));
}

export function writeDesktopKanbanRevision(db: DatabaseSync, revision: number) {
  db.prepare(`
    INSERT INTO board_meta (BOARD_ID_, KEY_, VALUE_)
    VALUES (?, 'revision', ?)
    ON CONFLICT(BOARD_ID_, KEY_) DO UPDATE SET VALUE_ = excluded.VALUE_
  `).run(BOARD_ID, String(Math.max(0, Math.floor(revision))));
}

export function readDesktopKanbanSyncCursorFromDb(db: DatabaseSync): KanbanDesktopSyncCursor {
  return {
    lastAckedDeliverySeq: readBoardMetaInteger(db, "sync.lastAckedDeliverySeq"),
    lastAppliedRevision: Math.max(
      readBoardMetaInteger(db, "sync.lastAppliedRevision"),
      readDesktopKanbanRevision(db)
    ),
    cacheSchemaVersion: readBoardMetaInteger(db, "sync.cacheSchemaVersion", SYNC_CACHE_SCHEMA_VERSION) || SYNC_CACHE_SCHEMA_VERSION
  };
}

export function writeDesktopKanbanSyncCursorInDb(db: DatabaseSync, cursor: Partial<KanbanDesktopSyncCursor>) {
  if (cursor.lastAckedDeliverySeq !== undefined) {
    writeBoardMetaInteger(db, "sync.lastAckedDeliverySeq", cursor.lastAckedDeliverySeq);
  }
  if (cursor.lastAppliedRevision !== undefined) {
    const revision = Math.max(readDesktopKanbanRevision(db), cursor.lastAppliedRevision);
    writeBoardMetaInteger(db, "sync.lastAppliedRevision", revision);
    writeDesktopKanbanRevision(db, revision);
  }
  writeBoardMetaInteger(db, "sync.cacheSchemaVersion", cursor.cacheSchemaVersion ?? SYNC_CACHE_SCHEMA_VERSION);
}

export function readDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => readDesktopKanbanSyncCursorFromDb(db));
}

export function writeDesktopKanbanSyncCursor(
  app: AppPathProvider,
  currentUser: KanbanCurrentUser,
  cursor: Partial<KanbanDesktopSyncCursor>
): KanbanDesktopSyncCursor {
  return withDesktopKanbanDatabase(app, currentUser, (db) => {
    const current = readDesktopKanbanSyncCursorFromDb(db);
    writeDesktopKanbanSyncCursorInDb(db, {
      lastAckedDeliverySeq: Math.max(current.lastAckedDeliverySeq, cursor.lastAckedDeliverySeq ?? 0),
      lastAppliedRevision: Math.max(current.lastAppliedRevision, cursor.lastAppliedRevision ?? 0),
      cacheSchemaVersion: cursor.cacheSchemaVersion ?? current.cacheSchemaVersion
    });
    return readDesktopKanbanSyncCursorFromDb(db);
  });
}

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

export function nextIssuePosition(db: DatabaseSync, status: KanbanStatus) {
  const row = db.prepare(`
    SELECT MAX(POSITION_) AS maxPosition FROM issue
    WHERE STATUS_ = ? AND DELETED_AT_ IS NULL
  `).get(status) as { maxPosition?: number | null } | undefined;
  return typeof row?.maxPosition === "number" && Number.isFinite(row.maxPosition) ? row.maxPosition + 1 : 1;
}

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
    project.defaultWorkflowId ?? WORKFLOW_ID,
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
    issue.workflowId ?? WORKFLOW_ID,
    issue.typeId ?? ISSUE_TYPE_ID,
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

export function buildLocalIssue(
  db: DatabaseSync,
  input: KanbanIssueInput,
  currentUser: KanbanCurrentUser
): KanbanIssue | null {
  const title = trimText(input.title);
  if (!title) return null;
  const timestamp = nowIso();
  const status = normalizeKanbanStatus(input.status);
  const assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  return {
    id: createLocalIssueId(db),
    localIssueId: "",
    remoteIssueId: null,
    boardId: BOARD_ID,
    projectId: nullableTrimmedText(input.projectId) ?? PROJECT_ID,
    projectVersion: nullableTrimmedText(input.projectVersion !== undefined ? input.projectVersion : input.version),
    dueDate: normalizeDueDate(input.dueDate) ?? null,
    dueRisk: null,
    resolution: nullableTrimmedText(input.resolution),
    securityLevelKey: nullableTrimmedText(input.securityLevelKey),
    reporterId: nullableTrimmedText(input.reporterId),
    componentKeys: normalizeStringList(input.componentKeys),
    originalEstimate: normalizeEffortSeconds(input.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(input.remainingEstimate),
    timeSpent: normalizeEffortSeconds(input.timeSpent),
    workflowId: WORKFLOW_ID,
    typeId: ISSUE_TYPE_ID,
    title,
    description: typeof input.description === "string" ? input.description.trim() : "",
    status,
    priority: normalizeKanbanPriority(input.priority),
    severity: normalizeKanbanSeverity(input.severity),
    assigneeAgentKey,
    assigneeId: nullableTrimmedText(input.assigneeId),
    workerType: normalizeWorkerType(input.workerType) ?? (assigneeAgentKey ? "agent" : null),
    workerId: nullableTrimmedText(input.workerId),
    workerAgent: nullableTrimmedText(input.workerAgent) ?? assigneeAgentKey,
    activeReviewId: null,
    activeRunId: null,
    position: nextIssuePosition(db, status),
    chatId: null,
    runId: null,
    runState: normalizeKanbanRunState(input.runState),
    automationId: nullableTrimmedText(input.automationId),
    automationEnabled: input.automationEnabled === true,
    automationCron: nullableTrimmedText(input.automationCron),
    automationMessage: nullableTrimmedText(input.automationMessage),
    automationTimezone: nullableTrimmedText(input.automationTimezone),
    attachmentChatId: nullableTrimmedText(input.attachmentChatId),
    attachments: normalizeAttachments(input.attachments),
    syncMode: "local",
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
