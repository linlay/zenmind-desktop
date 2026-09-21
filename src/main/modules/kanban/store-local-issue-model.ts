import { DatabaseSync } from "node:sqlite";
import type { KanbanIssueInput, KanbanCurrentUser, KanbanIssue, KanbanIssueUpdateInput } from "../../../shared/contracts";
import {
  trimText,
  nowIso,
  normalizeKanbanStatus,
  nullableTrimmedText,
  createLocalIssueId,
  BOARD_ID,
  PROJECT_ID,
  normalizeDueDate,
  normalizeStringList,
  normalizeEffortSeconds,
  normalizeKanbanPriority,
  normalizeKanbanSeverity,
  normalizeWorkerType,
  normalizeKanbanRunState,
  normalizeAttachments
} from "./store-values";
import { nextIssuePosition } from "./store-issue-writes";
import { moveLocalWorkflow } from "./local-workflows";

export function buildLocalIssue(
  db: DatabaseSync,
  input: KanbanIssueInput,
  currentUser: KanbanCurrentUser
): KanbanIssue | null {
  const title = trimText(input.title);
  if (!title) return null;
  const timestamp = nowIso();
  const status = normalizeKanbanStatus(input.status);
  const assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
  return {
    id: createLocalIssueId(db),
    localIssueId: "",
    remoteIssueId: null,
    boardId: BOARD_ID,
    projectId: nullableTrimmedText(input.projectId) ?? PROJECT_ID,
    projectVersion: nullableTrimmedText(input.projectVersion),
    dueDate: normalizeDueDate(input.dueDate) ?? null,
    dueRisk: null,
    resolution: nullableTrimmedText(input.resolution),
    securityLevelKey: nullableTrimmedText(input.securityLevelKey),
    reporterId: nullableTrimmedText(input.reporterId),
    componentKeys: normalizeStringList(input.componentKeys),
    originalEstimate: normalizeEffortSeconds(input.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(input.remainingEstimate),
    timeSpent: normalizeEffortSeconds(input.timeSpent),
    workflowId: undefined,
    typeId: undefined,
    title,
    description: typeof input.description === "string" ? input.description.trim() : "",
    status,
    priority: normalizeKanbanPriority(input.priority),
    severity: normalizeKanbanSeverity(input.severity),
    assigneeAgentKey,
    assigneeId: nullableTrimmedText(input.assigneeId),
    workerType: normalizeWorkerType(input.workerType) ?? (assigneeAgentKey ? "agent" : null),
    workerId: nullableTrimmedText(input.workerId),
    workerAgent: nullableTrimmedText(input.workerAgent) ?? assigneeAgentKey,
    activeReviewId: null,
    activeRunId: null,
    position: nextIssuePosition(db, status),
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
    syncMode: "local",
    syncState: "local",
    origin: "desktop",
    ownerUserId: currentUser.id,
    lastRemoteRevision: 0,
    lastSyncedAt: null,
    syncError: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export type LocalRunDetails = Partial<Pick<KanbanIssue, "runResultMessage" | "runErrorMessage" | "runStartedAt" | "runFinishedAt" | "lastRunId" | "lastRunChatId">>;

export function applyIssueUpdate(issue: KanbanIssue, input: KanbanIssueUpdateInput): KanbanIssue | null {
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
  if (input.projectId !== undefined) nextIssue.projectId = nullableTrimmedText(input.projectId) ?? PROJECT_ID;
  if (input.projectVersion !== undefined) {
    nextIssue.projectVersion = nullableTrimmedText(input.projectVersion);
  }
  if (input.dueDate !== undefined) nextIssue.dueDate = normalizeDueDate(input.dueDate) ?? null;
  if (input.resolution !== undefined) nextIssue.resolution = nullableTrimmedText(input.resolution);
  if (input.securityLevelKey !== undefined) nextIssue.securityLevelKey = nullableTrimmedText(input.securityLevelKey);
  if (input.reporterId !== undefined) nextIssue.reporterId = nullableTrimmedText(input.reporterId);
  if (input.componentKeys !== undefined) nextIssue.componentKeys = normalizeStringList(input.componentKeys);
  if (input.originalEstimate !== undefined) nextIssue.originalEstimate = normalizeEffortSeconds(input.originalEstimate);
  if (input.remainingEstimate !== undefined) nextIssue.remainingEstimate = normalizeEffortSeconds(input.remainingEstimate);
  if (input.timeSpent !== undefined) nextIssue.timeSpent = normalizeEffortSeconds(input.timeSpent);
  if (input.description !== undefined) nextIssue.description = typeof input.description === "string" ? input.description.trim() : "";
  if (input.status !== undefined) {
    Object.assign(nextIssue, moveLocalWorkflow(nextIssue, normalizeKanbanStatus(input.status)));
  }
  if (input.priority !== undefined) nextIssue.priority = normalizeKanbanPriority(input.priority);
  if (input.severity !== undefined) nextIssue.severity = normalizeKanbanSeverity(input.severity);
  if (input.assigneeAgentKey !== undefined) {
    nextIssue.assigneeAgentKey = nullableTrimmedText(input.assigneeAgentKey);
    nextIssue.workerAgent = nextIssue.assigneeAgentKey;
    if (nextIssue.assigneeAgentKey) nextIssue.workerType = "agent";
  }
  if (input.assigneeId !== undefined) nextIssue.assigneeId = nullableTrimmedText(input.assigneeId);
  if (input.workerType !== undefined) nextIssue.workerType = normalizeWorkerType(input.workerType);
  if (input.workerId !== undefined) nextIssue.workerId = nullableTrimmedText(input.workerId);
  if (input.workerAgent !== undefined) nextIssue.workerAgent = nullableTrimmedText(input.workerAgent);
  if (input.chatId !== undefined) nextIssue.chatId = nullableTrimmedText(input.chatId);
  if (input.runId !== undefined) {
    nextIssue.runId = nullableTrimmedText(input.runId);
    nextIssue.activeRunId = nextIssue.runId;
    if (nextIssue.syncMode !== "cloud" && nextIssue.runId) {
      if (nextIssue.lastRunId !== nextIssue.runId) {
        nextIssue.runResultMessage = null;
        nextIssue.runErrorMessage = null;
        nextIssue.runStartedAt = null;
        nextIssue.runFinishedAt = null;
      }
      nextIssue.lastRunId = nextIssue.runId;
      nextIssue.lastRunChatId = nextIssue.chatId;
    }
  }
  if (input.runState !== undefined) {
    nextIssue.runState = normalizeKanbanRunState(input.runState);
  } else if (input.runId !== undefined) {
    nextIssue.runState = nextIssue.runId ? "running" : nextIssue.status === "completed" ? "completed" : nextIssue.runState;
  }
  if (input.automationId !== undefined) nextIssue.automationId = nullableTrimmedText(input.automationId);
  if (input.automationEnabled !== undefined) nextIssue.automationEnabled = input.automationEnabled === true;
  if (input.automationCron !== undefined) nextIssue.automationCron = nullableTrimmedText(input.automationCron);
  if (input.automationMessage !== undefined) nextIssue.automationMessage = nullableTrimmedText(input.automationMessage);
  if (input.automationTimezone !== undefined) nextIssue.automationTimezone = nullableTrimmedText(input.automationTimezone);
  if (input.attachmentChatId !== undefined) nextIssue.attachmentChatId = nullableTrimmedText(input.attachmentChatId);
  if (input.attachments !== undefined) nextIssue.attachments = normalizeAttachments(input.attachments);
  if (nextIssue.stageId !== issue.stageId) {
    nextIssue.chatId = null;
    nextIssue.runId = null;
    nextIssue.activeRunId = null;
    nextIssue.runState = null;
  }
  return nextIssue;
}
