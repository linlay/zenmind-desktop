import type { AssistantAttachment } from "./attachments";

export const TASK_BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "done"
] as const;

export const TASK_BOARD_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none"
] as const;

export type TaskBoardStatus = typeof TASK_BOARD_STATUSES[number];
export type TaskBoardPriority = typeof TASK_BOARD_PRIORITIES[number];

export interface TaskBoardIssue {
  id: string;
  number: number;
  identifier: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  assigneeAgentKey: string | null;
  assigneeName: string | null;
  position: number;
  chatId: string | null;
  runId: string | null;
  scheduleId: string | null;
  scheduleEnabled: boolean;
  scheduleCron: string | null;
  scheduleMessage: string | null;
  scheduleTimezone: string | null;
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
  assigneeName?: string | null;
  scheduleId?: string | null;
  scheduleEnabled?: boolean;
  scheduleCron?: string | null;
  scheduleMessage?: string | null;
  scheduleTimezone?: string | null;
  attachmentChatId?: string | null;
  attachments?: AssistantAttachment[];
}

export interface TaskBoardIssueUpdateInput {
  title?: string;
  description?: string | null;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  assigneeAgentKey?: string | null;
  assigneeName?: string | null;
  chatId?: string | null;
  runId?: string | null;
  scheduleId?: string | null;
  scheduleEnabled?: boolean;
  scheduleCron?: string | null;
  scheduleMessage?: string | null;
  scheduleTimezone?: string | null;
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
