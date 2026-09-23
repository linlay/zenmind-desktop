import { PRODUCT_NAME } from "../../../shared/brand";
import type {
  KanbanIssue,
  KanbanRunState,
  KanbanStatus
} from "../../../shared/contracts";
import { parseKanbanPriority } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { isRecord, nullableText, optionalText, readBoolean, readDueDate, readEffortSeconds, readStringList, readText } from "./protocol-values";

export function buildKanbanAutomationMessage(issue: KanbanIssue) {
  const message = issue.automationMessage?.trim() || issue.description.trim() || issue.title.trim();
  return [
    message,
    "",
    t("kanban.automation.messageIntro", { productName: PRODUCT_NAME }),
    t("kanban.automation.issueId", { id: issue.id }),
    t("kanban.automation.issueTitle", { title: issue.title })
  ].join("\n");
}

export function buildKanbanAutomationPayload(issue: KanbanIssue) {
  return {
    name: t("kanban.automation.name", { id: issue.id, title: issue.title }).slice(0, 120),
    description: t("kanban.automation.description", { productName: PRODUCT_NAME, id: issue.id }),
    cron: issue.automationCron?.trim() ?? "",
    agentKey: issue.assigneeAgentKey?.trim() ?? "",
    enabled: true,
    zoneId: issue.automationTimezone?.trim() || "Asia/Shanghai",
    query: {
      message: buildKanbanAutomationMessage(issue),
      hidden: true,
      params: {
        source: "kanban",
        issueId: issue.id
      }
    }
  };
}

export function kanbanIssueFromAutomationPayload(payload: unknown): KanbanIssue | null {
  const record = isRecord(payload) && isRecord(payload.issue) ? payload.issue : payload;
  if (!isRecord(record)) {
    return null;
  }
  const now = new Date().toISOString();
  const id = readText(record.id);
  const title = readText(record.title);
  if (!id || !title) {
    return null;
  }
  return {
    id,
    localIssueId: optionalText(record.localIssueId),
    remoteIssueId: nullableText(record.remoteIssueId) ?? id,
    boardId: readText(record.boardId) || "default",
    projectId: readText(record.projectId) || "default",
    projectPath: optionalText(record.projectPath),
    projectName: optionalText(record.projectName),
    projectVersion: nullableText(record.projectVersion),
    dueDate: readDueDate(record.dueDate),
    dueRisk: nullableText(record.dueRisk),
    resolution: nullableText(record.resolution),
    securityLevelKey: nullableText(record.securityLevelKey),
    reporterId: nullableText(record.reporterId),
    componentKeys: readStringList(record.componentKeys),
    originalEstimate: readEffortSeconds(record.originalEstimate),
    remainingEstimate: readEffortSeconds(record.remainingEstimate),
    timeSpent: readEffortSeconds(record.timeSpent),
    parentIssueId: nullableText(record.parentIssueId),
    workflowId: optionalText(record.workflowId),
    typeId: optionalText(record.issueTypeKey) ?? optionalText(record.typeId),
    issueTypeKey: optionalText(record.issueTypeKey) ?? optionalText(record.typeId),
    stageId: optionalText(record.stageId),
    stageKey: optionalText(record.stageKey),
    stageName: optionalText(record.stageName),
    statusId: optionalText(record.statusId),
    statusName: optionalText(record.statusName),
    statusKey: optionalText(record.statusKey),
    columnKey: optionalText(record.columnKey),
    title,
    description: readText(record.description),
    status: (readText(record.status) || "backlog") as KanbanStatus,
    priority: parseKanbanPriority(record.priority),
    severity: (["critical", "high", "medium", "low"] as const).includes(readText(record.severity) as "critical" | "high" | "medium" | "low")
      ? readText(record.severity) as NonNullable<KanbanIssue["severity"]>
      : null,
    assigneeAgentKey: nullableText(record.assigneeAgentKey),
    assigneeId: nullableText(record.assigneeId),
    workerType: readText(record.workerType) === "human" || readText(record.workerType) === "agent" ? readText(record.workerType) as "human" | "agent" : null,
    workerId: nullableText(record.workerId),
    workerAgent: nullableText(record.workerAgent),
    activeReviewId: nullableText(record.activeReviewId),
    activeIssueRunId: nullableText(record.activeIssueRunId),
    activeRunId: nullableText(record.activeIssueRunId) ?? nullableText(record.activeRunId),
    position: typeof record.position === "number" ? record.position : 1,
    chatId: nullableText(record.chatId),
    runId: nullableText(record.runId),
    runState: nullableText(record.runState) as KanbanRunState | null,
    automationId: nullableText(record.automationId),
    automationEnabled: readBoolean(record.automationEnabled),
    automationCron: nullableText(record.automationCron),
    automationMessage: nullableText(record.automationMessage),
    automationTimezone: nullableText(record.automationTimezone),
    attachmentChatId: nullableText(record.attachmentChatId),
    attachments: Array.isArray(record.attachments) ? record.attachments as KanbanIssue["attachments"] : [],
    syncMode: "cloud",
    syncState: "synced",
    origin: "cloud_dispatch",
    ownerUserId: nullableText(record.ownerUserId) ?? undefined,
    lastRemoteRevision: typeof record.revision === "number" ? record.revision : 0,
    lastSyncedAt: null,
    syncError: null,
    revision: typeof record.revision === "number" ? record.revision : 0,
    createdAt: readText(record.createdAt) || now,
    updatedAt: readText(record.updatedAt) || now
  };
}
