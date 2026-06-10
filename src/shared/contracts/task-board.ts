import type { AssistantAttachment } from "./attachments";

export const TASK_BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "completed"
] as const;

export const TASK_BOARD_PRIORITIES = [
  "high",
  "medium",
  "low"
] as const;

export const TASK_BOARD_RUN_STATES = [
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export type TaskBoardStatus = typeof TASK_BOARD_STATUSES[number];
export type TaskBoardPriority = typeof TASK_BOARD_PRIORITIES[number];
export type TaskBoardRunState = typeof TASK_BOARD_RUN_STATES[number];
export type TaskBoardSyncMode = "private" | "cloud";
export type TaskBoardSyncState = "local" | "syncing" | "synced" | "error";
export type TaskBoardOrigin = "desktop" | "cloud_dispatch";

export interface TaskBoardCurrentUser {
  id: string;
  name: string;
  email: string;
  source: "sso" | "device";
}

export interface TaskBoardIssue {
  id: string;
  localIssueId?: string;
  remoteIssueId?: string | null;
  boardId?: string;
  projectId?: string;
  workflowId?: string;
  typeId?: string;
  stageId?: string;
  statusId?: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  severity?: "critical" | "high" | "medium" | "low";
  assigneeAgentKey: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  reviewerId?: string | null;
  reviewRequired?: boolean;
  activeReviewId?: string | null;
  activeRunId?: string | null;
  position: number;
  chatId: string | null;
  runId: string | null;
  runState: TaskBoardRunState | null;
  automationId: string | null;
  automationEnabled: boolean;
  automationCron: string | null;
  automationMessage: string | null;
  automationTimezone: string | null;
  attachmentChatId: string | null;
  attachments: AssistantAttachment[];
  syncMode?: TaskBoardSyncMode;
  syncState?: TaskBoardSyncState;
  origin?: TaskBoardOrigin;
  ownerUserId?: string;
  lastRemoteRevision?: number;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardProject {
  id: string;
  parentId: string | null;
  slug: string;
  key?: string;
  name: string;
  description?: string;
  path: string;
  depth: number;
  position: number;
  visibility?: string;
  defaultWorkflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardProjectBinding {
  id: string;
  projectId: string;
  deviceId: string;
  currentUserId?: string;
  localProjectId: string;
  localDisplayName: string;
  syncPolicy: "future" | "select" | "all";
  controlMode: "dispatch" | "observe" | "disabled";
  status: "active" | "paused" | "error";
  lastRemoteRevision: number;
  syncSinceAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardProjectBindingIssue {
  bindingId: string;
  issueId: string;
  source?: "select" | "dispatch" | "desktop_sync";
  createdAt?: string;
}

export interface TaskBoardDispatchBindingContext {
  id: string;
  localProjectId: string;
  localDisplayName?: string;
}

export interface TaskBoardIssueSyncUpsert {
  localIssueId: string;
  remoteIssueId?: string | null;
  baseIssueRevision?: number;
  input: Record<string, unknown>;
}

export interface TaskBoardIssueSyncDelete {
  localIssueId: string;
  remoteIssueId: string;
  baseIssueRevision?: number;
}

export interface TaskBoardIssueSyncRequest {
  deviceId: string;
  projectId: string;
  localProjectId: string;
  baseRevision?: number;
  upserts?: TaskBoardIssueSyncUpsert[];
  deletes?: TaskBoardIssueSyncDelete[];
}

export type TaskBoardIssueSyncItemStatus =
  | "created"
  | "updated"
  | "deleted"
  | "conflict"
  | "skipped"
  | "error";

export interface TaskBoardIssueSyncItemResult {
  localIssueId: string;
  remoteIssueId?: string;
  status: TaskBoardIssueSyncItemStatus;
  issue?: Record<string, unknown>;
  message?: string;
}

export interface TaskBoardIssueSyncResult {
  ok: boolean;
  message?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  results: TaskBoardIssueSyncItemResult[];
}

export interface TaskBoardCreateLocalProjectRequest {
  name: string;
  localProjectId?: string;
  cloudProjectId?: string;
}

export interface TaskBoardCreateLocalProjectResult {
  ok: boolean;
  message?: string;
  project?: {
    id: string;
    name: string;
    slug?: string;
    path?: string;
  };
}

export interface TaskBoardIssueInput {
  title: string;
  projectId?: string | null;
  description?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  severity?: "critical" | "high" | "medium" | "low";
  assigneeAgentKey?: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  reviewerId?: string | null;
  reviewRequired?: boolean;
  runState?: TaskBoardRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
  syncToCloud?: boolean;
}

export interface TaskBoardIssueUpdateInput {
  title?: string;
  projectId?: string | null;
  description?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  severity?: "critical" | "high" | "medium" | "low";
  assigneeAgentKey?: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  reviewerId?: string | null;
  reviewRequired?: boolean;
  chatId?: string | null;
  runId?: string | null;
  runState?: TaskBoardRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
  syncToCloud?: boolean;
  baseIssueRevision?: number;
}

export interface TaskBoardIssueMoveInput {
  id: string;
  status: TaskBoardStatus;
  position: number;
  baseIssueRevision?: number;
}

export interface TaskBoardListResult {
  ok: boolean;
  message: string;
  issues: TaskBoardIssue[];
  projects?: TaskBoardProject[];
  projectBindings?: TaskBoardProjectBinding[];
  projectBindingIssues?: TaskBoardProjectBindingIssue[];
  storagePath?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  currentUser?: TaskBoardCurrentUser;
  connectionState?: "disabled" | "connecting" | "open" | "closed" | "error";
}

export interface TaskBoardCloudConfig {
  serverUrl: string;
  token: string;
  selectedProjectId: string;
  remoteControlEnabled: boolean;
}

export interface TaskBoardCloudConfigResult {
  ok: boolean;
  message: string;
  config: TaskBoardCloudConfig;
  configPath?: string;
  connectionState?: TaskBoardListResult["connectionState"];
}

export interface TaskBoardDesktopSessionStatus {
  sessionId: string;
  deviceId?: string;
  currentUserId?: string;
  currentUserName?: string;
  selectedProjectId?: string;
  capabilities: string[];
  lastSeenAt?: string;
}

export interface TaskBoardDesktopOnlineAgent {
  agentKey: string;
  displayName: string;
  role?: string;
  icon?: Record<string, unknown>;
}

export interface TaskBoardDesktopOnlineDevice {
  deviceId: string;
  currentUserId?: string;
  currentUserName?: string;
  selectedProjectId?: string;
  capabilities: string[];
  lastSeenAt?: string;
  sessions: TaskBoardDesktopSessionStatus[];
  agents: TaskBoardDesktopOnlineAgent[];
  agentError?: string;
}

export interface TaskBoardDesktopOnlineResult {
  ok: boolean;
  online: boolean;
  deviceCount: number;
  sessionCount: number;
  agentCount: number;
  devices: TaskBoardDesktopOnlineDevice[];
  message?: string;
}

export interface TaskBoardIssueResult {
  ok: boolean;
  message: string;
  issue?: TaskBoardIssue;
  issues: TaskBoardIssue[];
}

export interface TaskBoardDeleteResult {
  ok: boolean;
  message: string;
  deletedIssueId?: string;
  issues: TaskBoardIssue[];
}

export type TaskBoardChangedListener = () => void;
