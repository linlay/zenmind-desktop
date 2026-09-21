import type { KanbanIssueRow, KanbanProjectRow, KanbanProjectBindingRow } from "./store-model";
import type { KanbanIssue, KanbanProject, KanbanProjectBinding } from "../../../shared/contracts";
import {
  parseJsonRecord,
  trimText,
  nullableTrimmedText,
  readStoredDueDate,
  normalizeStringList,
  normalizeEffortSeconds,
  parseAttachmentsJson,
  normalizeCustomFields,
  parseStringList,
  parseCloudIssue,
  nowIso
} from "./store-values";

export function issueFromRow(row: KanbanIssueRow): KanbanIssue {
  const detail = parseJsonRecord(row.detail_json);
  const localWorkflow = detail.localWorkflow as KanbanIssue["localWorkflow"];
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
    localWorkflow,
    localWorkflowRollbacks: detail.localWorkflowRollbacks as KanbanIssue["localWorkflowRollbacks"],
    workflowId: row.sync_mode === "cloud" ? row.workflow_id || undefined : localWorkflow?.id,
    typeId: row.sync_mode === "cloud" ? row.type_id || undefined : undefined,
    issueTypeKey: row.sync_mode === "cloud" ? trimText(detail.issueTypeKey) || row.type_id || undefined : undefined,
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
    lastRunId: nullableTrimmedText(detail.lastRunId),
    lastRunChatId: nullableTrimmedText(detail.lastRunChatId),
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
    syncMode: row.sync_mode,
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
    defaultWorkflowId: trimText(record.defaultWorkflowId),
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
