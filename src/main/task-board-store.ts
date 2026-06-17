import type {
  AssistantAttachment,
  TaskBoardDeleteResult,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardPriority,
  TaskBoardRunState,
  TaskBoardStatus
} from "../shared/contracts";
import { TASK_BOARD_PRIORITIES, TASK_BOARD_RUN_STATES, TASK_BOARD_STATUSES } from "../shared/contracts";
import {
  getTaskBoardDatabasePath,
  readTaskBoardIssues,
  replaceTaskBoardIssues,
  withTaskBoardDatabase
} from "./task-board-db";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath(name: "home"): string;
};

type StoredTaskBoardIssues = {
  issues: TaskBoardIssue[];
};

const statusRank = new Map<TaskBoardStatus, number>(
  TASK_BOARD_STATUSES.map((status, index) => [status, index])
);

function nonDragCompletedTransitionMessage() {
  return t("taskBoard.runtime.completedDragLocked");
}

const taskBoardStatusAliases: Record<string, TaskBoardStatus> = {
  complete: "completed",
  completed: "completed",
  done: "completed",
  finish: "completed",
  finished: "completed",
  resolved: "completed",
  inprocess: "in_progress",
  in_process: "in_progress",
  "in-process": "in_progress",
  inprogress: "in_progress",
  processing: "in_progress",
  running: "in_progress"
};

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableTrimmedText(value: unknown) {
  const trimmed = trimText(value);
  return trimmed ? trimmed : null;
}

function normalizeTaskBoardStatus(value: unknown): TaskBoardStatus | null {
  const raw = trimText(value).toLowerCase();
  if (!raw) return null;
  if (TASK_BOARD_STATUSES.includes(raw as TaskBoardStatus)) {
    return raw as TaskBoardStatus;
  }
  return taskBoardStatusAliases[raw] ?? null;
}

function normalizeTaskBoardRunState(value: unknown): TaskBoardRunState | null {
  const raw = trimText(value).toLowerCase();
  return TASK_BOARD_RUN_STATES.includes(raw as TaskBoardRunState) ? raw as TaskBoardRunState : null;
}

function normalizeDescription(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

function isTaskBoardPriority(value: unknown): value is TaskBoardPriority {
  return typeof value === "string" && TASK_BOARD_PRIORITIES.includes(value as TaskBoardPriority);
}

function isNonDragCompletedTransition(issue: TaskBoardIssue, requestedStatus: TaskBoardStatus | null, clearsActiveRun = false) {
  return requestedStatus === "completed" && issue.status !== "completed" && !clearsActiveRun;
}

function nowIso() {
  return new Date().toISOString();
}

function parseTaskBoardIdTick(id: string) {
  const parsed = Number.parseInt(id.trim(), 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createTaskBoardIssueId(existingIssues: TaskBoardIssue[]) {
  const currentTick = Math.floor(Date.now() / 100);
  const maxExistingTick = existingIssues.reduce(
    (maxTick, issue) => Math.max(maxTick, parseTaskBoardIdTick(issue.id)),
    0
  );
  return Math.max(currentTick, maxExistingTick + 1).toString(36).toUpperCase();
}

function issueUpdatedTime(issue: TaskBoardIssue) {
  const timestamp = Date.parse(issue.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortIssues(issues: TaskBoardIssue[]) {
  return [...issues].sort((a, b) => {
    const statusDelta = (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
    if (a.position !== b.position) return a.position - b.position;
    const updatedDelta = issueUpdatedTime(b) - issueUpdatedTime(a);
    if (updatedDelta !== 0) return updatedDelta;
    return a.id.localeCompare(b.id);
  });
}

function cloneIssue(issue: TaskBoardIssue): TaskBoardIssue {
  return { ...issue, attachments: [...issue.attachments] };
}

function cloneIssues(issues: TaskBoardIssue[]) {
  return sortIssues(issues).map(cloneIssue);
}

function readStore(app: AppPathProvider): StoredTaskBoardIssues {
  return withTaskBoardDatabase(app, (db) => ({
    issues: readTaskBoardIssues(db)
  }));
}

function writeStore(app: AppPathProvider, store: StoredTaskBoardIssues) {
  withTaskBoardDatabase(app, (db) => {
    replaceTaskBoardIssues(db, sortIssues(store.issues));
  });
}

function nextIssuePosition(issues: TaskBoardIssue[], status: TaskBoardStatus) {
  const sameStatus = issues.filter((issue) => issue.status === status);
  if (sameStatus.length === 0) return 1;
  return sameStatus.reduce((maxPosition, issue) => Math.max(maxPosition, issue.position), 0) + 1;
}

function buildIssue(input: TaskBoardIssueInput, existingIssues: TaskBoardIssue[]): TaskBoardIssue | null {
  const title = trimText(input.title);
  if (!title) return null;

  const status = normalizeTaskBoardStatus(input.status) ?? "backlog";
  const priority = isTaskBoardPriority(input.priority) ? input.priority : "medium";
  const timestamp = nowIso();
  return {
    id: createTaskBoardIssueId(existingIssues),
    title,
    description: normalizeDescription(input.description),
    status,
    priority,
    assigneeAgentKey: nullableTrimmedText(input.assigneeAgentKey),
    position: nextIssuePosition(existingIssues, status),
    chatId: null,
    runId: null,
    runState: normalizeTaskBoardRunState(input.runState),
    automationId: nullableTrimmedText(input.automationId),
    automationEnabled: input.automationEnabled === true,
    automationCron: nullableTrimmedText(input.automationCron),
    automationMessage: nullableTrimmedText(input.automationMessage),
    automationTimezone: nullableTrimmedText(input.automationTimezone),
    attachmentChatId: nullableTrimmedText(input.attachmentChatId),
    attachments: normalizeAttachments(input.attachments),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function applyIssueUpdate(issue: TaskBoardIssue, input: TaskBoardIssueUpdateInput): TaskBoardIssue | null {
  const nextIssue: TaskBoardIssue = {
    ...issue,
    attachments: [...issue.attachments],
    updatedAt: nowIso()
  };

  if (input.title !== undefined) {
    const title = trimText(input.title);
    if (!title) return null;
    nextIssue.title = title;
  }
  if (input.description !== undefined) nextIssue.description = normalizeDescription(input.description);
  if (input.status !== undefined) {
    const status = normalizeTaskBoardStatus(input.status);
    if (status) nextIssue.status = status;
  }
  if (input.priority !== undefined && isTaskBoardPriority(input.priority)) nextIssue.priority = input.priority;
  if (input.assigneeAgentKey !== undefined) nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) nextIssue.runId = nullableTrimmedText(input.runId);
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeTaskBoardRunState(input.runState);
  } else if (input.runId !== undefined) {
    if (nextIssue.runId) {
      nextIssue.runState = "running";
    } else if (nextIssue.status === "completed") {
      nextIssue.runState = "completed";
    } else if (issue.runId && nextIssue.status === "todo") {
      nextIssue.runState = "failed";
    }
  } else if (input.status !== undefined && nextIssue.status !== issue.status && !nextIssue.runId) {
    nextIssue.runState = null;
  }
  if (input.automationId !== undefined) nextIssue.automationId = nullableTrimmedText(input.automationId);
  if (input.automationEnabled !== undefined) nextIssue.automationEnabled = input.automationEnabled === true;
  if (input.automationCron !== undefined) nextIssue.automationCron = nullableTrimmedText(input.automationCron);
  if (input.automationMessage !== undefined) nextIssue.automationMessage = nullableTrimmedText(input.automationMessage);
  if (input.automationTimezone !== undefined) nextIssue.automationTimezone = nullableTrimmedText(input.automationTimezone);
  if (input.attachmentChatId !== undefined) nextIssue.attachmentChatId = nullableTrimmedText(input.attachmentChatId);
  if (input.attachments !== undefined) nextIssue.attachments = normalizeAttachments(input.attachments);

  return nextIssue;
}

export function listTaskBoardIssues(app: AppPathProvider): TaskBoardListResult {
  const store = readStore(app);
  return {
    ok: true,
    message: t("taskBoard.runtime.loaded"),
    issues: cloneIssues(store.issues),
    storagePath: getTaskBoardDatabasePath(app)
  };
}

export function createTaskBoardIssue(app: AppPathProvider, input: TaskBoardIssueInput): TaskBoardIssueResult {
  const store = readStore(app);
  const issue = buildIssue(input, store.issues);
  if (!issue) {
    return { ok: false, message: t("taskBoard.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }
  const nextIssues = [...store.issues, issue];
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("taskBoard.runtime.created"), issue: cloneIssue(issue), issues: cloneIssues(nextIssues) };
}

export function updateTaskBoardIssue(
  app: AppPathProvider,
  issueId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === issueId);
  if (issueIndex < 0) {
    return { ok: false, message: t("taskBoard.runtime.missing"), issues: cloneIssues(store.issues) };
  }

  const currentIssue = store.issues[issueIndex]!;
  const requestedStatus = input.status !== undefined ? normalizeTaskBoardStatus(input.status) : null;
  const clearsActiveRun = input.runId === null;
  if (currentIssue.runId && requestedStatus && requestedStatus !== currentIssue.status && !clearsActiveRun) {
    return { ok: false, message: t("taskBoard.runtime.agentRunning"), issues: cloneIssues(store.issues) };
  }
  if (isNonDragCompletedTransition(currentIssue, requestedStatus, clearsActiveRun)) {
    return { ok: false, message: nonDragCompletedTransitionMessage(), issues: cloneIssues(store.issues) };
  }

  const nextIssue = applyIssueUpdate(currentIssue, input);
  if (!nextIssue) {
    return { ok: false, message: t("taskBoard.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }

  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("taskBoard.runtime.updated"), issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function updateTaskBoardIssueByRunId(
  app: AppPathProvider,
  runId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const trimmedRunId = trimText(runId);
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.runId === trimmedRunId);
  if (!trimmedRunId || issueIndex < 0) {
    return { ok: false, message: t("taskBoard.runtime.runMissing"), issues: cloneIssues(store.issues) };
  }
  return updateMatchedTaskBoardIssue(app, store, issueIndex, input, t("taskBoard.runtime.runUpdated"));
}

export function updateTaskBoardIssueByChatId(
  app: AppPathProvider,
  chatId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const trimmedChatId = trimText(chatId);
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) =>
    issue.chatId === trimmedChatId && issue.status === "in_progress"
  );
  if (!trimmedChatId || issueIndex < 0) {
    return { ok: false, message: t("taskBoard.runtime.chatMissing"), issues: cloneIssues(store.issues) };
  }
  return updateMatchedTaskBoardIssue(app, store, issueIndex, input, t("taskBoard.runtime.chatUpdated"));
}

function updateMatchedTaskBoardIssue(
  app: AppPathProvider,
  store: StoredTaskBoardIssues,
  issueIndex: number,
  input: TaskBoardIssueUpdateInput,
  message: string
): TaskBoardIssueResult {
  const currentIssue = store.issues[issueIndex]!;
  const requestedStatus = input.status !== undefined ? normalizeTaskBoardStatus(input.status) : null;
  const clearsActiveRun = input.runId === null;
  if (isNonDragCompletedTransition(currentIssue, requestedStatus, clearsActiveRun)) {
    return { ok: false, message: nonDragCompletedTransitionMessage(), issues: cloneIssues(store.issues) };
  }
  const nextIssue = applyIssueUpdate(currentIssue, input);
  if (!nextIssue) {
    return { ok: false, message: t("taskBoard.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }
  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message, issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function moveTaskBoardIssue(app: AppPathProvider, input: TaskBoardIssueMoveInput): TaskBoardIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === input.id);
  if (issueIndex < 0) {
    return { ok: false, message: t("taskBoard.runtime.missing"), issues: cloneIssues(store.issues) };
  }
  const targetStatus = normalizeTaskBoardStatus(input.status);
  if (!targetStatus || !Number.isFinite(input.position)) {
    return { ok: false, message: t("taskBoard.runtime.moveInvalid"), issues: cloneIssues(store.issues) };
  }
  const currentIssue = store.issues[issueIndex]!;
  if (currentIssue.runId) {
    return { ok: false, message: t("taskBoard.runtime.agentRunning"), issues: cloneIssues(store.issues) };
  }

  const nextIssue: TaskBoardIssue = {
    ...currentIssue,
    status: targetStatus,
    position: input.position,
    runState: targetStatus === currentIssue.status ? currentIssue.runState : null,
    updatedAt: nowIso()
  };
  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("taskBoard.runtime.moved"), issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function deleteTaskBoardIssue(app: AppPathProvider, issueId: string): TaskBoardDeleteResult {
  const store = readStore(app);
  const nextIssues = store.issues.filter((issue) => issue.id !== issueId);
  if (nextIssues.length === store.issues.length) {
    return { ok: false, message: t("taskBoard.runtime.missing"), issues: cloneIssues(store.issues) };
  }
  writeStore(app, { issues: nextIssues });
  return {
    ok: true,
    message: t("taskBoard.runtime.deleted"),
    deletedIssueId: issueId,
    issues: cloneIssues(nextIssues)
  };
}

export const __testInternals = {
  createTaskBoardIssueId,
  getTaskBoardDatabasePath,
  readStore
};
