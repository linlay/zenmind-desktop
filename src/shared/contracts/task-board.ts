import type { AssistantAttachment } from "./attachments";

export const TASK_BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
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

export interface TaskBoardIssue {
  id: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  assigneeAgentKey: string | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardIssueInput {
  title: string;
  description?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  assigneeAgentKey?: string | null;
  runState?: TaskBoardRunState | null;
  automationId?: string | null;
  automationEnabled?: boolean;
  automationCron?: string | null;
  automationMessage?: string | null;
  automationTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
}

export interface TaskBoardIssueUpdateInput {
  title?: string;
  description?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  assigneeAgentKey?: string | null;
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
