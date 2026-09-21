import type { App } from "electron";
import type {
  KanbanStatus,
  KanbanPriority,
  KanbanIssue,
  KanbanRunState,
  KanbanSyncMode,
  KanbanSyncState,
  KanbanOrigin,
  KanbanProjectBinding
} from "../../../shared/contracts";

export type AppPathProvider = {
  getPath(name: Parameters<App["getPath"]>[0]): string;
};

export type KanbanIssueRow = {
  id: string;
  remote_issue_id: string | null;
  board_id: string;
  project_id: string;
  workflow_id: string;
  type_id: string | null;
  stage_id: string | null;
  stage_name: string | null;
  status_id: string | null;
  status_name: string | null;
  title: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority | null;
  severity: KanbanIssue["severity"];
  assignee_agent_key: string | null;
  assignee_id: string | null;
  worker_type: KanbanIssue["workerType"];
  worker_id: string | null;
  worker_agent: string | null;
  active_review_id: string | null;
  active_run_id: string | null;
  position: number;
  chat_id: string | null;
  run_id: string | null;
  run_state: KanbanRunState | null;
  dispatch_state: KanbanIssue["dispatchState"];
  dispatch_device_id: string | null;
  dispatch_command_id: string | null;
  dispatch_updated_at: string | null;
  automation_id: string | null;
  automation_enabled: number;
  automation_cron: string | null;
  automation_message: string | null;
  automation_timezone: string | null;
  attachment_chat_id: string | null;
  attachments_json: string;
  detail_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  sync_mode: KanbanSyncMode;
  sync_state: KanbanSyncState;
  origin: KanbanOrigin;
  owner_user_id: string;
  last_remote_revision: number;
  last_synced_at: string | null;
  sync_error: string | null;
};

export type KanbanProjectRow = {
  id: string;
  sync_mode: KanbanSyncMode;
  parent_id: string | null;
  slug: string;
  key: string;
  name: string;
  description: string;
  versions_json: string;
  components_json: string;
  path: string;
  depth: number;
  position: number;
  revision: number;
  visibility: string;
  default_workflow_id: string;
  created_at: string;
  updated_at: string;
};

export type KanbanProjectBindingRow = {
  id: string;
  project_id: string;
  device_id: string;
  current_user_id: string;
  local_project_id: string;
  local_display_name: string;
  sync_policy: KanbanProjectBinding["syncPolicy"];
  control_mode: KanbanProjectBinding["controlMode"];
  status: KanbanProjectBinding["status"];
  last_remote_revision: number;
  created_at: string;
  updated_at: string;
};

export type KanbanCloudSnapshot = {
  boardId?: string;
  projectId?: string;
  projectIds?: string[];
  revision?: number;
  lastSeq?: number;
  complete?: boolean;
  scope?: string;
  projects?: unknown[];
  projectBindings?: unknown[];
  issues?: unknown[];
  users?: unknown[];
  issueTypes?: unknown[];
  issueFieldDefs?: unknown[];
  issueFieldContexts?: unknown[];
  issueFieldOptions?: unknown[];
  workflows?: unknown[];
  workflowStageDefs?: unknown[];
  workflowStatusDefs?: unknown[];
  workflowStages?: unknown[];
  workflowStatuses?: unknown[];
  workflowTransitions?: unknown[];
  workflowDecomposeRules?: unknown[];
  teams?: unknown[];
  teamMembers?: unknown[];
  projectPermissions?: unknown[];
  issueLabels?: unknown[];
  issueLabelLinks?: unknown[];
  issueDependencies?: unknown[];
  reviews?: unknown[];
  issueStageWorkers?: unknown[];
  issueChats?: unknown[];
  issueRuns?: unknown[];
  issueComments?: unknown[];
  recentEvents?: unknown[];
};

export type KanbanDesktopSyncCursor = {
  lastAckedDeliverySeq: number;
  lastAppliedRevision: number;
  cacheSchemaVersion: number;
};

export type KanbanCommandReceiptState = "received" | "starting" | "started" | "completed" | "failed";

export type KanbanCommandReceipt = {
  commandId: string;
  deliverySeq: number;
  projectId: string;
  issueId: string;
  issueRunId: string;
  commandType: "run" | "review";
  payload: Record<string, unknown>;
  payloadHash: string;
  chatId: string;
  runId: string;
  requestId: string;
  state: KanbanCommandReceiptState;
  attemptCount: number;
  lastError: string | null;
  terminalReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KanbanCloudMutationOutboxItem = {
  id: string;
  requestType: "issue.claim";
  projectId: string;
  issueId: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
};

export type KanbanRunEventOutboxItem = {
  clientEventId: string;
  projectId: string;
  issueId: string;
  issueRunId: string;
  externalRunId: string;
  runId: string;
  chatId: string;
  eventType: string;
  sourceDeliverySeq: number;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
};

export type KanbanManualRunReceiptState = "starting" | "started" | "completed" | "failed" | "cancelled";

export type KanbanManualRunReceipt = {
  issueRunId: string;
  runId: string;
  chatId: string;
  issueId: string;
  projectId: string;
  agentKey: string;
  state: KanbanManualRunReceiptState;
  lastError: string | null;
};
