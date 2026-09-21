import type { KanbanStatus, KanbanPriority, KanbanIssue, KanbanRunState, AssistantAttachment } from "../../../shared/contracts";
import { KANBAN_STATUSES, parseKanbanPriority, KANBAN_RUN_STATES } from "../../../shared/contracts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const BOARD_ID = "default";

export const PROJECT_ID = "default";

export const DATABASE_DIRECTORY = "desktop-kanban";

export const DATABASE_FILENAME = "kanban.db";

export const DATABASE_SCHEMA_VERSION = 2;

export const SYNC_CACHE_SCHEMA_VERSION = 1;

export function nowIso() {
  return new Date().toISOString();
}

export function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function nullableTrimmedText(value: unknown) {
  const text = trimText(value);
  return text ? text : null;
}

export function normalizeKanbanStatus(value: unknown): KanbanStatus {
  const raw = trimText(value).toLowerCase();
  return KANBAN_STATUSES.includes(raw as KanbanStatus) ? raw as KanbanStatus : "backlog";
}

export function normalizeKanbanPriority(value: unknown): KanbanPriority | null {
  return parseKanbanPriority(value);
}

export function normalizeKanbanSeverity(value: unknown): KanbanIssue["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null;
}

export function normalizeKanbanRunState(value: unknown): KanbanRunState | null {
  return typeof value === "string" && KANBAN_RUN_STATES.includes(value as KanbanRunState)
    ? value as KanbanRunState
    : null;
}

export function normalizeWorkerType(value: unknown): KanbanIssue["workerType"] {
  return value === "human" || value === "agent" ? value : null;
}

export function normalizeAttachments(value: unknown): AssistantAttachment[] {
  return Array.isArray(value)
    ? value.filter((attachment): attachment is AssistantAttachment => Boolean(attachment && typeof attachment === "object"))
    : [];
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(trimText).filter(Boolean))];
}

export function normalizeEffortSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const seconds = Math.trunc(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function parseAttachmentsJson(value: string | null | undefined): AssistantAttachment[] {
  if (!value) return [];
  try {
    return normalizeAttachments(JSON.parse(value));
  } catch {
    return [];
  }
}

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function normalizeCustomFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeDueDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= maxDay
    ? `${yearText}-${monthText}-${dayText}`
    : undefined;
}

export function readStoredDueDate(detail: Record<string, unknown>): KanbanIssue["dueDate"] {
  return normalizeDueDate(detail.dueDate);
}

export function buildIssueDetailJson(issue: KanbanIssue) {
  return JSON.stringify({
    projectPath: issue.projectPath ?? "",
    projectName: issue.projectName ?? "",
    projectVersion: issue.projectVersion ?? null,
    dueDate: issue.dueDate ?? null,
    dueRisk: issue.dueRisk ?? null,
    resolution: issue.resolution ?? null,
    securityLevelKey: issue.securityLevelKey ?? null,
    reporterId: issue.reporterId ?? null,
    componentKeys: normalizeStringList(issue.componentKeys),
    originalEstimate: normalizeEffortSeconds(issue.originalEstimate),
    remainingEstimate: normalizeEffortSeconds(issue.remainingEstimate),
    timeSpent: normalizeEffortSeconds(issue.timeSpent),
    parentIssueId: issue.parentIssueId ?? null,
    issueTypeKey: issue.issueTypeKey ?? issue.typeId ?? "",
    stageKey: issue.stageKey ?? "",
    statusKey: issue.statusKey ?? "",
    columnKey: issue.columnKey ?? "",
    localWorkflow: issue.localWorkflow,
    localWorkflowRollbacks: issue.localWorkflowRollbacks,
    customFields: issue.customFields ?? {},
    activeIssueRunId: issue.activeIssueRunId ?? null,
    runAgentKey: issue.runAgentKey ?? null,
    runCommandId: issue.runCommandId ?? null,
    runStartedAt: issue.runStartedAt ?? null,
    runFinishedAt: issue.runFinishedAt ?? null,
    runResultMessage: issue.runResultMessage ?? null,
    lastRunId: issue.lastRunId ?? null,
    lastRunChatId: issue.lastRunChatId ?? null,
    runErrorMessage: issue.runErrorMessage ?? null,
    createdBy: issue.createdBy ?? null,
    updatedBy: issue.updatedBy ?? null,
    createdByAgent: issue.createdByAgent ?? null,
    updatedByAgent: issue.updatedByAgent ?? null
  });
}

export function parseCloudIssue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createLocalIssueId(db: DatabaseSync) {
  let tick = Math.floor(Date.now() / 100);
  const exists = db.prepare("SELECT 1 FROM issue WHERE ID_ = ? LIMIT 1");
  while (true) {
    const id = `local-${tick.toString(36).toUpperCase()}`;
    if (!exists.get(id)) return id;
    tick += 1;
  }
}

export function createCloudCacheIssueId() {
  return `cloud_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}
