import type { AssistantAttachment } from "./attachments";

export const KANBAN_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "completed"
] as const;

export const KANBAN_PRIORITIES = [
  "high",
  "medium",
  "low"
] as const;

export const KANBAN_RUN_STATES = [
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export type KanbanStatus = typeof KANBAN_STATUSES[number];
export type KanbanPriority = typeof KANBAN_PRIORITIES[number];
export type KanbanRunState = typeof KANBAN_RUN_STATES[number];
export type KanbanSyncMode = "private" | "cloud";
export type KanbanSyncState = "local" | "syncing" | "synced" | "error";
export type KanbanOrigin = "desktop" | "cloud_dispatch";

export interface KanbanCurrentUser {
  id: string;
  name: string;
  email: string;
  source: "sso" | "device";
}

export interface KanbanIssue {
  id: string;
  localIssueId?: string;
  remoteIssueId?: string | null;
  boardId?: string;
  projectId?: string;
  workflowId?: string;
  typeId?: string;
  stageId?: string;
  stageName?: string;
  statusId?: string;
  statusName?: string;
  statusKey?: string;
  title: string;
  description: string;
  status: KanbanStatus;
  priority: KanbanPriority;
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
  runState: KanbanRunState | null;
  automationId: string | null;
  automationEnabled: boolean;
  automationCron: string | null;
  automationMessage: string | null;
  automationTimezone: string | null;
  attachmentChatId: string | null;
  attachments: AssistantAttachment[];
  syncMode?: KanbanSyncMode;
  syncState?: KanbanSyncState;
  origin?: KanbanOrigin;
  ownerUserId?: string;
  lastRemoteRevision?: number;
  lastSyncedAt?: string | null;
  syncError?: string | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanProject {
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

export interface KanbanProjectBinding {
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

export interface KanbanProjectBindingIssue {
  bindingId: string;
  issueId: string;
  source?: "select" | "dispatch" | "desktop_sync";
  createdAt?: string;
}

export interface KanbanDispatchBindingContext {
  id: string;
  localProjectId: string;
  localDisplayName?: string;
}

export interface KanbanIssueSyncUpsert {
  localIssueId: string;
  remoteIssueId?: string | null;
  baseIssueRevision?: number;
  input: Record<string, unknown>;
}

export interface KanbanIssueSyncDelete {
  localIssueId: string;
  remoteIssueId: string;
  baseIssueRevision?: number;
}

export interface KanbanIssueSyncRequest {
  deviceId: string;
  projectId: string;
  localProjectId: string;
  baseRevision?: number;
  upserts?: KanbanIssueSyncUpsert[];
  deletes?: KanbanIssueSyncDelete[];
}

export type KanbanIssueSyncItemStatus =
  | "created"
  | "updated"
  | "deleted"
  | "conflict"
  | "skipped"
  | "error";

export interface KanbanIssueSyncItemResult {
  localIssueId: string;
  remoteIssueId?: string;
  status: KanbanIssueSyncItemStatus;
  issue?: Record<string, unknown>;
  message?: string;
}

export interface KanbanIssueSyncResult {
  ok: boolean;
  message?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  results: KanbanIssueSyncItemResult[];
}

export interface KanbanCreateLocalProjectRequest {
  name: string;
  localProjectId?: string;
  cloudProjectId?: string;
}

export interface KanbanCreateLocalProjectResult {
  ok: boolean;
  message?: string;
  project?: {
    id: string;
    name: string;
    slug?: string;
    path?: string;
  };
}

export interface KanbanIssueInput {
  title: string;
  projectId?: string | null;
  description?: string | null;
  status?: KanbanStatus;
  priority?: KanbanPriority;
  severity?: "critical" | "high" | "medium" | "low";
  assigneeAgentKey?: string | null;
  assigneeId?: string | null;
  workerType?: "human" | "agent" | null;
  workerId?: string | null;
  workerAgent?: string | null;
  reviewerId?: string | null;
  reviewRequired?: boolean;
  runState?: KanbanRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
  syncToCloud?: boolean;
}

export interface KanbanIssueUpdateInput {
  title?: string;
  projectId?: string | null;
  description?: string | null;
  status?: KanbanStatus;
  priority?: KanbanPriority;
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
  runState?: KanbanRunState | null;
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

export interface KanbanIssueMoveInput {
  id: string;
  status: KanbanStatus;
  position: number;
  baseIssueRevision?: number;
}

export interface KanbanListResult {
  ok: boolean;
  message: string;
  issues: KanbanIssue[];
  projects?: KanbanProject[];
  projectBindings?: KanbanProjectBinding[];
  projectBindingIssues?: KanbanProjectBindingIssue[];
  storagePath?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  currentUser?: KanbanCurrentUser;
  connectionState?: "disabled" | "connecting" | "open" | "closed" | "error";
}

export interface KanbanCloudConfig {
  serverUrl: string;
  token: string;
  selectedProjectId: string;
  remoteControlEnabled: boolean;
  deviceAlias?: string;
}

export interface KanbanSettings {
  enabled: boolean;
  cloud: KanbanCloudConfig;
}

export interface KanbanSettingsInput {
  enabled?: boolean;
  cloud?: Partial<KanbanCloudConfig>;
}

export interface KanbanSettingsResult {
  ok: boolean;
  message: string;
  settings: KanbanSettings;
  configPath?: string;
  connectionState?: KanbanListResult["connectionState"];
}

export interface KanbanCloudConfigResult {
  ok: boolean;
  message: string;
  config: KanbanCloudConfig;
  configPath?: string;
  connectionState?: KanbanListResult["connectionState"];
}

export interface KanbanIssueResult {
  ok: boolean;
  message: string;
  issue?: KanbanIssue;
  issues: KanbanIssue[];
}

export interface KanbanDeleteResult {
  ok: boolean;
  message: string;
  deletedIssueId?: string;
  issues: KanbanIssue[];
}

export type KanbanChangedListener = () => void;
