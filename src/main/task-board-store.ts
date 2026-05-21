import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  TaskBoardDeleteResult,
  TaskBoardIssue,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardPriority,
  TaskBoardStatus
} from "../shared/contracts";
import { TASK_BOARD_PRIORITIES, TASK_BOARD_STATUSES } from "../shared/contracts";

type AppPathProvider = {
  getPath(name: "userData"): string;
};

type StoredTaskBoardIssues = {
  version: 1;
  issues: TaskBoardIssue[];
};

const STORAGE_VERSION = 1;
const ISSUE_IDENTIFIER_PREFIX = "ZEN";
const TASK_BOARD_DIRECTORY = "task-board";
const TASK_BOARD_FILENAME = "issues.json";

const taskBoardStatusSchema = z.enum(TASK_BOARD_STATUSES);
const taskBoardPrioritySchema = z.enum(TASK_BOARD_PRIORITIES);

const taskBoardIssueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: taskBoardStatusSchema,
  priority: taskBoardPrioritySchema,
  assigneeAgentKey: z.string().nullable(),
  assigneeName: z.string().nullable(),
  position: z.number(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const taskBoardStoreSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  issues: z.array(taskBoardIssueSchema)
});

const taskBoardStatusAliases: Record<string, TaskBoardStatus> = {
  complete: "done",
  completed: "done",
  finish: "done",
  finished: "done",
  resolved: "done",
  inprocess: "in_progress",
  in_process: "in_progress",
  "in-process": "in_progress",
  inprogress: "in_progress",
  processing: "in_progress",
  running: "in_progress"
};

const statusRank = new Map<TaskBoardStatus, number>(
  TASK_BOARD_STATUSES.map((status, index) => [status, index])
);

function isTaskBoardPriority(value: unknown): value is TaskBoardPriority {
  return typeof value === "string" && TASK_BOARD_PRIORITIES.includes(value as TaskBoardPriority);
}

function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableTrimmedText(value: unknown) {
  const trimmed = trimText(value);
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTaskBoardStatus(value: unknown): TaskBoardStatus | null {
  const raw = trimText(value).toLowerCase();
  if (!raw) {
    return null;
  }
  if (TASK_BOARD_STATUSES.includes(raw as TaskBoardStatus)) {
    return raw as TaskBoardStatus;
  }
  return taskBoardStatusAliases[raw] ?? null;
}

function normalizeDescription(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptyStore(): StoredTaskBoardIssues {
  return {
    version: STORAGE_VERSION,
    issues: []
  };
}

function sortIssues(issues: TaskBoardIssue[]) {
  return [...issues].sort((a, b) => {
    const statusDelta = (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    return a.number - b.number;
  });
}

function cloneIssue(issue: TaskBoardIssue): TaskBoardIssue {
  return { ...issue };
}

function cloneIssues(issues: TaskBoardIssue[]) {
  return sortIssues(issues).map(cloneIssue);
}

function getTaskBoardRoot(app: AppPathProvider) {
  return path.join(app.getPath("userData"), TASK_BOARD_DIRECTORY);
}

function getTaskBoardIssuesPath(app: AppPathProvider) {
  return path.join(getTaskBoardRoot(app), TASK_BOARD_FILENAME);
}

function writeStore(app: AppPathProvider, store: StoredTaskBoardIssues) {
  const targetPath = getTaskBoardIssuesPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ ...store, issues: sortIssues(store.issues) }, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, targetPath);
}

function readStore(app: AppPathProvider): StoredTaskBoardIssues {
  const targetPath = getTaskBoardIssuesPath(app);
  if (!fs.existsSync(targetPath)) {
    const emptyStore = createEmptyStore();
    writeStore(app, emptyStore);
    return emptyStore;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const normalized = normalizeStoredTaskBoardStore(JSON.parse(raw));
    if (normalized) {
      if (normalized.changed) {
        writeStore(app, normalized.store);
      }
      return normalized.store;
    }
  } catch {
    // Corrupt local state should not block Desktop startup.
  }

  const recoveredStore = createEmptyStore();
  writeStore(app, recoveredStore);
  return recoveredStore;
}

function nextIssueNumber(issues: TaskBoardIssue[]) {
  return issues.reduce((maxNumber, issue) => Math.max(maxNumber, issue.number), 0) + 1;
}

function nextIssuePosition(issues: TaskBoardIssue[], status: TaskBoardStatus) {
  const sameStatus = issues.filter((issue) => issue.status === status);
  if (sameStatus.length === 0) {
    return 1;
  }
  return sameStatus.reduce((maxPosition, issue) => Math.max(maxPosition, issue.position), 0) + 1;
}

function normalizeStoredTaskBoardStore(value: unknown): { store: StoredTaskBoardIssues; changed: boolean } | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.issues)) {
    return null;
  }
  const rawIssues = record.issues;

  let changed = record.version !== STORAGE_VERSION;
  const issues: TaskBoardIssue[] = [];
  for (const rawIssue of rawIssues) {
    const issueRecord = asRecord(rawIssue);
    if (!issueRecord) {
      changed = true;
      continue;
    }
    const status = normalizeTaskBoardStatus(issueRecord.status);
    if (!status) {
      changed = true;
      continue;
    }
    if (issueRecord.status !== status) {
      changed = true;
    }
    const parsedIssue = taskBoardIssueSchema.safeParse({
      ...issueRecord,
      status
    });
    if (parsedIssue.success) {
      issues.push(parsedIssue.data);
    } else {
      changed = true;
    }
  }

  const parsedStore = taskBoardStoreSchema.safeParse({
    version: STORAGE_VERSION,
    issues
  });
  if (!parsedStore.success) {
    return null;
  }
  return {
    store: {
      version: STORAGE_VERSION,
      issues: sortIssues(parsedStore.data.issues)
    },
    changed
  };
}

function buildIssue(input: TaskBoardIssueInput, existingIssues: TaskBoardIssue[]): TaskBoardIssue | null {
  const title = trimText(input.title);
  if (!title) {
    return null;
  }

  const status = normalizeTaskBoardStatus(input.status) ?? "backlog";
  const priority = isTaskBoardPriority(input.priority) ? input.priority : "medium";
  const number = nextIssueNumber(existingIssues);
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    number,
    identifier: `${ISSUE_IDENTIFIER_PREFIX}-${number}`,
    title,
    description: normalizeDescription(input.description),
    status,
    priority,
    assigneeAgentKey: nullableTrimmedText(input.assigneeAgentKey),
    assigneeName: nullableTrimmedText(input.assigneeName),
    position: nextIssuePosition(existingIssues, status),
    chatId: null,
    runId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function applyIssueUpdate(issue: TaskBoardIssue, input: TaskBoardIssueUpdateInput): TaskBoardIssue | null {
  const nextIssue: TaskBoardIssue = {
    ...issue,
    updatedAt: nowIso()
  };

  if (input.title !== undefined) {
    const title = trimText(input.title);
    if (!title) {
      return null;
    }
    nextIssue.title = title;
  }
  if (input.description !== undefined) {
    nextIssue.description = normalizeDescription(input.description);
  }
  if (input.status !== undefined) {
    const status = normalizeTaskBoardStatus(input.status);
    if (status) {
      nextIssue.status = status;
    }
  }
  if (input.priority !== undefined && isTaskBoardPriority(input.priority)) {
    nextIssue.priority = input.priority;
  }
  if (input.assigneeAgentKey !== undefined) {
    nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  }
  if (input.assigneeName !== undefined) {
    nextIssue.assigneeName = nullableTrimmedText(input.assigneeName);
  }
  if (input.chatId !== undefined) {
    nextIssue.chatId = nullableTrimmedText(input.chatId);
  }
  if (input.runId !== undefined) {
    nextIssue.runId = nullableTrimmedText(input.runId);
  }

  return nextIssue;
}

export function listTaskBoardIssues(app: AppPathProvider): TaskBoardListResult {
  const store = readStore(app);
  return {
    ok: true,
    message: "任务看板已加载。",
    issues: cloneIssues(store.issues),
    storagePath: getTaskBoardIssuesPath(app)
  };
}

export function createTaskBoardIssue(app: AppPathProvider, input: TaskBoardIssueInput): TaskBoardIssueResult {
  const store = readStore(app);
  const issue = buildIssue(input, store.issues);
  if (!issue) {
    return {
      ok: false,
      message: "任务标题不能为空。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextStore = {
    ...store,
    issues: [...store.issues, issue]
  };
  writeStore(app, nextStore);
  return {
    ok: true,
    message: "任务已创建。",
    issue: cloneIssue(issue),
    issues: cloneIssues(nextStore.issues)
  };
}

export function updateTaskBoardIssue(
  app: AppPathProvider,
  issueId: string,
  input: TaskBoardIssueUpdateInput
): TaskBoardIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === issueId);
  if (issueIndex < 0) {
    return {
      ok: false,
      message: "任务不存在。",
      issues: cloneIssues(store.issues)
    };
  }

  const currentIssue = store.issues[issueIndex]!;
  const requestedStatus = input.status !== undefined ? normalizeTaskBoardStatus(input.status) : null;
  const clearsActiveRun = input.runId === null;
  if (currentIssue.runId && requestedStatus && requestedStatus !== currentIssue.status && !clearsActiveRun) {
    return {
      ok: false,
      message: "智能体正在回答，完成后才能切换状态。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextIssue = applyIssueUpdate(currentIssue, input);
  if (!nextIssue) {
    return {
      ok: false,
      message: "任务标题不能为空。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { ...store, issues: nextIssues });
  return {
    ok: true,
    message: "任务已更新。",
    issue: cloneIssue(nextIssue),
    issues: cloneIssues(nextIssues)
  };
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
    return {
      ok: false,
      message: "任务运行不存在。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextIssue = applyIssueUpdate(store.issues[issueIndex]!, input);
  if (!nextIssue) {
    return {
      ok: false,
      message: "任务标题不能为空。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { ...store, issues: nextIssues });
  return {
    ok: true,
    message: "任务运行状态已更新。",
    issue: cloneIssue(nextIssue),
    issues: cloneIssues(nextIssues)
  };
}

export function moveTaskBoardIssue(app: AppPathProvider, input: TaskBoardIssueMoveInput): TaskBoardIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === input.id);
  if (issueIndex < 0) {
    return {
      ok: false,
      message: "任务不存在。",
      issues: cloneIssues(store.issues)
    };
  }
  const targetStatus = normalizeTaskBoardStatus(input.status);
  if (!targetStatus || !Number.isFinite(input.position)) {
    return {
      ok: false,
      message: "任务移动参数无效。",
      issues: cloneIssues(store.issues)
    };
  }
  if (store.issues[issueIndex]!.runId) {
    return {
      ok: false,
      message: "智能体正在回答，完成后才能切换状态。",
      issues: cloneIssues(store.issues)
    };
  }

  const nextIssue: TaskBoardIssue = {
    ...store.issues[issueIndex]!,
    status: targetStatus,
    position: input.position,
    updatedAt: nowIso()
  };
  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { ...store, issues: nextIssues });
  return {
    ok: true,
    message: "任务已移动。",
    issue: cloneIssue(nextIssue),
    issues: cloneIssues(nextIssues)
  };
}

export function deleteTaskBoardIssue(app: AppPathProvider, issueId: string): TaskBoardDeleteResult {
  const store = readStore(app);
  const nextIssues = store.issues.filter((issue) => issue.id !== issueId);
  if (nextIssues.length === store.issues.length) {
    return {
      ok: false,
      message: "任务不存在。",
      issues: cloneIssues(store.issues)
    };
  }
  writeStore(app, { ...store, issues: nextIssues });
  return {
    ok: true,
    message: "任务已删除。",
    deletedIssueId: issueId,
    issues: cloneIssues(nextIssues)
  };
}

export const __testInternals = {
  getTaskBoardIssuesPath,
  readStore
};
