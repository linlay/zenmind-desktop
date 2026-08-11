import type {
  AssistantAttachment,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanRunState,
  KanbanStatus
} from "../shared/contracts";
import { KANBAN_RUN_STATES, KANBAN_STATUSES, parseKanbanPriority } from "../shared/contracts";
import {
  getKanbanDatabasePath,
  readKanbanIssues,
  replaceKanbanIssues,
  withKanbanDatabase
} from "./kanban-db";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath(name: "home"): string;
};

type StoredKanbanIssues = {
  issues: KanbanIssue[];
};

const statusRank = new Map<KanbanStatus, number>(
  KANBAN_STATUSES.map((status, index) => [status, index])
);

function nonDragCompletedTransitionMessage() {
  return t("kanban.runtime.completedDragLocked");
}

const kanbanStatusAliases: Record<string, KanbanStatus> = {
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

function normalizeKanbanStatus(value: unknown): KanbanStatus | null {
  const raw = trimText(value).toLowerCase();
  if (!raw) return null;
  if (KANBAN_STATUSES.includes(raw as KanbanStatus)) {
    return raw as KanbanStatus;
  }
  return kanbanStatusAliases[raw] ?? null;
}

function normalizeKanbanRunState(value: unknown): KanbanRunState | null {
  const raw = trimText(value).toLowerCase();
  return KANBAN_RUN_STATES.includes(raw as KanbanRunState) ? raw as KanbanRunState : null;
}

function normalizeDescription(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

function isNonDragCompletedTransition(issue: KanbanIssue, requestedStatus: KanbanStatus | null, clearsActiveRun = false) {
  return requestedStatus === "completed" && issue.status !== "completed" && !clearsActiveRun;
}

function nowIso() {
  return new Date().toISOString();
}

function parseKanbanIdTick(id: string) {
  const parsed = Number.parseInt(id.trim(), 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createKanbanIssueId(existingIssues: KanbanIssue[]) {
  const currentTick = Math.floor(Date.now() / 100);
  const maxExistingTick = existingIssues.reduce(
    (maxTick, issue) => Math.max(maxTick, parseKanbanIdTick(issue.id)),
    0
  );
  return Math.max(currentTick, maxExistingTick + 1).toString(36).toUpperCase();
}

function issueUpdatedTime(issue: KanbanIssue) {
  const timestamp = Date.parse(issue.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortIssues(issues: KanbanIssue[]) {
  return [...issues].sort((a, b) => {
    const statusDelta = (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
    if (a.position !== b.position) return a.position - b.position;
    const updatedDelta = issueUpdatedTime(b) - issueUpdatedTime(a);
    if (updatedDelta !== 0) return updatedDelta;
    return a.id.localeCompare(b.id);
  });
}

function cloneIssue(issue: KanbanIssue): KanbanIssue {
  return { ...issue, attachments: [...issue.attachments] };
}

function cloneIssues(issues: KanbanIssue[]) {
  return sortIssues(issues).map(cloneIssue);
}

function readStore(app: AppPathProvider): StoredKanbanIssues {
  return withKanbanDatabase(app, (db) => ({
    issues: readKanbanIssues(db)
  }));
}

function writeStore(app: AppPathProvider, store: StoredKanbanIssues) {
  withKanbanDatabase(app, (db) => {
    replaceKanbanIssues(db, sortIssues(store.issues));
  });
}

function nextIssuePosition(issues: KanbanIssue[], status: KanbanStatus) {
  const sameStatus = issues.filter((issue) => issue.status === status);
  if (sameStatus.length === 0) return 1;
  return sameStatus.reduce((maxPosition, issue) => Math.max(maxPosition, issue.position), 0) + 1;
}

function buildIssue(input: KanbanIssueInput, existingIssues: KanbanIssue[]): KanbanIssue | null {
  const title = trimText(input.title);
  if (!title) return null;

  const status = normalizeKanbanStatus(input.status) ?? "backlog";
  const priority = parseKanbanPriority(input.priority);
  const timestamp = nowIso();
  return {
    id: createKanbanIssueId(existingIssues),
    title,
    description: normalizeDescription(input.description),
    status,
    priority,
    severity: input.severity ?? null,
    projectVersion: nullableTrimmedText(input.projectVersion !== undefined ? input.projectVersion : input.version),
    dueDate: nullableTrimmedText(input.dueDate),
    dueRisk: null,
    resolution: nullableTrimmedText(input.resolution),
    securityLevelKey: nullableTrimmedText(input.securityLevelKey),
    reporterId: nullableTrimmedText(input.reporterId),
    componentKeys: Array.isArray(input.componentKeys) ? input.componentKeys.map(trimText).filter(Boolean) : [],
    originalEstimate: typeof input.originalEstimate === "number" && input.originalEstimate >= 0 ? Math.trunc(input.originalEstimate) : 0,
    remainingEstimate: typeof input.remainingEstimate === "number" && input.remainingEstimate >= 0 ? Math.trunc(input.remainingEstimate) : 0,
    timeSpent: typeof input.timeSpent === "number" && input.timeSpent >= 0 ? Math.trunc(input.timeSpent) : 0,
    assigneeAgentKey: nullableTrimmedText(input.assigneeAgentKey),
    position: nextIssuePosition(existingIssues, status),
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
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function applyIssueUpdate(issue: KanbanIssue, input: KanbanIssueUpdateInput): KanbanIssue | null {
  const nextIssue: KanbanIssue = {
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
    const status = normalizeKanbanStatus(input.status);
    if (status) nextIssue.status = status;
  }
  if (input.priority !== undefined) {
    nextIssue.priority = parseKanbanPriority(input.priority);
  }
  if (input.severity !== undefined) nextIssue.severity = input.severity;
  if (input.projectVersion !== undefined || input.version !== undefined) nextIssue.projectVersion = nullableTrimmedText(input.projectVersion !== undefined ? input.projectVersion : input.version);
  if (input.dueDate !== undefined) nextIssue.dueDate = nullableTrimmedText(input.dueDate);
  if (input.resolution !== undefined) nextIssue.resolution = nullableTrimmedText(input.resolution);
  if (input.securityLevelKey !== undefined) nextIssue.securityLevelKey = nullableTrimmedText(input.securityLevelKey);
  if (input.reporterId !== undefined) nextIssue.reporterId = nullableTrimmedText(input.reporterId);
  if (input.componentKeys !== undefined) nextIssue.componentKeys = input.componentKeys.map(trimText).filter(Boolean);
  if (input.originalEstimate !== undefined) nextIssue.originalEstimate = Math.max(0, Math.trunc(input.originalEstimate));
  if (input.remainingEstimate !== undefined) nextIssue.remainingEstimate = Math.max(0, Math.trunc(input.remainingEstimate));
  if (input.timeSpent !== undefined) nextIssue.timeSpent = Math.max(0, Math.trunc(input.timeSpent));
  if (input.assigneeAgentKey !== undefined) nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) nextIssue.runId = nullableTrimmedText(input.runId);
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeKanbanRunState(input.runState);
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

export function listKanbanIssues(app: AppPathProvider): KanbanListResult {
  const store = readStore(app);
  return {
    ok: true,
    message: t("kanban.runtime.loaded"),
    issues: cloneIssues(store.issues),
    storagePath: getKanbanDatabasePath(app)
  };
}

export function createKanbanIssue(app: AppPathProvider, input: KanbanIssueInput): KanbanIssueResult {
  const store = readStore(app);
  const issue = buildIssue(input, store.issues);
  if (!issue) {
    return { ok: false, message: t("kanban.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }
  const nextIssues = [...store.issues, issue];
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("kanban.runtime.created"), issue: cloneIssue(issue), issues: cloneIssues(nextIssues) };
}

export function updateKanbanIssue(
  app: AppPathProvider,
  issueId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === issueId);
  if (issueIndex < 0) {
    return { ok: false, message: t("kanban.runtime.missing"), issues: cloneIssues(store.issues) };
  }

  const currentIssue = store.issues[issueIndex]!;
  const requestedStatus = input.status !== undefined ? normalizeKanbanStatus(input.status) : null;
  const clearsActiveRun = input.runId === null;
  if (currentIssue.runId && requestedStatus && requestedStatus !== currentIssue.status && !clearsActiveRun) {
    return { ok: false, message: t("kanban.runtime.agentRunning"), issues: cloneIssues(store.issues) };
  }
  if (isNonDragCompletedTransition(currentIssue, requestedStatus, clearsActiveRun)) {
    return { ok: false, message: nonDragCompletedTransitionMessage(), issues: cloneIssues(store.issues) };
  }

  const nextIssue = applyIssueUpdate(currentIssue, input);
  if (!nextIssue) {
    return { ok: false, message: t("kanban.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }

  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("kanban.runtime.updated"), issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function updateKanbanIssueByRunId(
  app: AppPathProvider,
  runId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  const trimmedRunId = trimText(runId);
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.runId === trimmedRunId);
  if (!trimmedRunId || issueIndex < 0) {
    return { ok: false, message: t("kanban.runtime.runMissing"), issues: cloneIssues(store.issues) };
  }
  return updateMatchedKanbanIssue(app, store, issueIndex, input, t("kanban.runtime.runUpdated"));
}

export function updateKanbanIssueByChatId(
  app: AppPathProvider,
  chatId: string,
  input: KanbanIssueUpdateInput
): KanbanIssueResult {
  const trimmedChatId = trimText(chatId);
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) =>
    issue.chatId === trimmedChatId && issue.status === "in_progress"
  );
  if (!trimmedChatId || issueIndex < 0) {
    return { ok: false, message: t("kanban.runtime.chatMissing"), issues: cloneIssues(store.issues) };
  }
  return updateMatchedKanbanIssue(app, store, issueIndex, input, t("kanban.runtime.chatUpdated"));
}

function updateMatchedKanbanIssue(
  app: AppPathProvider,
  store: StoredKanbanIssues,
  issueIndex: number,
  input: KanbanIssueUpdateInput,
  message: string
): KanbanIssueResult {
  const currentIssue = store.issues[issueIndex]!;
  const requestedStatus = input.status !== undefined ? normalizeKanbanStatus(input.status) : null;
  const clearsActiveRun = input.runId === null;
  if (isNonDragCompletedTransition(currentIssue, requestedStatus, clearsActiveRun)) {
    return { ok: false, message: nonDragCompletedTransitionMessage(), issues: cloneIssues(store.issues) };
  }
  const nextIssue = applyIssueUpdate(currentIssue, input);
  if (!nextIssue) {
    return { ok: false, message: t("kanban.runtime.titleRequired"), issues: cloneIssues(store.issues) };
  }
  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message, issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function moveKanbanIssue(app: AppPathProvider, input: KanbanIssueMoveInput): KanbanIssueResult {
  const store = readStore(app);
  const issueIndex = store.issues.findIndex((issue) => issue.id === input.id);
  if (issueIndex < 0) {
    return { ok: false, message: t("kanban.runtime.missing"), issues: cloneIssues(store.issues) };
  }
  const targetStatus = normalizeKanbanStatus(input.status);
  if (!targetStatus || !Number.isFinite(input.position)) {
    return { ok: false, message: t("kanban.runtime.moveInvalid"), issues: cloneIssues(store.issues) };
  }
  const currentIssue = store.issues[issueIndex]!;
  if (currentIssue.runId) {
    return { ok: false, message: t("kanban.runtime.agentRunning"), issues: cloneIssues(store.issues) };
  }

  const nextIssue: KanbanIssue = {
    ...currentIssue,
    status: targetStatus,
    position: input.position,
    runState: targetStatus === currentIssue.status ? currentIssue.runState : null,
    updatedAt: nowIso()
  };
  const nextIssues = [...store.issues];
  nextIssues[issueIndex] = nextIssue;
  writeStore(app, { issues: nextIssues });
  return { ok: true, message: t("kanban.runtime.moved"), issue: cloneIssue(nextIssue), issues: cloneIssues(nextIssues) };
}

export function deleteKanbanIssue(app: AppPathProvider, issueId: string): KanbanDeleteResult {
  const store = readStore(app);
  const nextIssues = store.issues.filter((issue) => issue.id !== issueId);
  if (nextIssues.length === store.issues.length) {
    return { ok: false, message: t("kanban.runtime.missing"), issues: cloneIssues(store.issues) };
  }
  writeStore(app, { issues: nextIssues });
  return {
    ok: true,
    message: t("kanban.runtime.deleted"),
    deletedIssueId: issueId,
    issues: cloneIssues(nextIssues)
  };
}

export const __testInternals = {
  createKanbanIssueId,
  getKanbanDatabasePath,
  readStore
};
