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
}

export interface TaskBoardIssueMoveInput {
  id: string;
  status: TaskBoardStatus;
  position: number;
}

export interface TaskBoardListResult {
  ok: boolean;
  message: string;
  issues: TaskBoardIssue[];
  storagePath?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  currentUser?: TaskBoardCurrentUser;
  connectionState?: "disabled" | "connecting" | "open" | "closed" | "error";
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
