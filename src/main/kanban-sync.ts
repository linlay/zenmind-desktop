import type {
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueResult,
  KanbanIssueUpdateInput,
  KanbanListResult,
  KanbanStatus
} from "../shared/contracts";
import {
  deleteKanbanIssue,
  listKanbanIssues,
  updateKanbanIssue,
  updateKanbanIssueByChatId,
  updateKanbanIssueByRunId
} from "./kanban-store";
import { PRODUCT_NAME } from "../shared/brand";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath(name: "home"): string;
};

type AgentPlatformCaller<TApp> = <T = unknown>(
  app: TApp,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
  }
) => Promise<T>;

type KanbanAssistantSyncEvent = {
  type?: string;
  status?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

type KanbanAutomationDetail = {
  id?: string;
  scheduleId?: string;
};

export function resolveKanbanStatusFromAssistantEvent(
  event: KanbanAssistantSyncEvent
): KanbanStatus | null {
  const type = (event.type ?? "").trim().toLowerCase();
  const status = (event.status ?? "").trim().toLowerCase();
  if (
    type === "done" ||
    type === "complete" ||
    type === "completed" ||
    type === "success" ||
    type === "succeeded" ||
    type === "finish" ||
    type === "finished" ||
    type === "run.complete" ||
    type === "run.completed" ||
    type === "run.success" ||
    type === "run.succeeded" ||
    type === "task.complete" ||
    type === "task.completed" ||
    type === "task.success" ||
    type === "task.succeeded" ||
    status === "done" ||
    status === "complete" ||
    status === "completed" ||
    status === "success" ||
    status === "succeeded" ||
    status === "finish" ||
    status === "finished"
  ) {
    return "completed";
  }
  return null;
}

function isCancelledKanbanAssistantEvent(event: KanbanAssistantSyncEvent) {
  const type = (event.type ?? "").trim().toLowerCase();
  const status = (event.status ?? "").trim().toLowerCase();
  return (
    type === "cancel" ||
    type === "cancelled" ||
    type === "canceled" ||
    type === "run.cancel" ||
    type === "run.cancelled" ||
    type === "run.canceled" ||
    type === "task.cancel" ||
    type === "task.cancelled" ||
    type === "task.canceled" ||
    type === "stopped" ||
    type === "run.stopped" ||
    type === "run.interrupt" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "stopped"
  );
}

export function resolveKanbanRunStateFromAssistantEvent(
  event: KanbanAssistantSyncEvent
): KanbanIssue["runState"] {
  const status = resolveKanbanStatusFromAssistantEvent(event);
  if (status === "completed") {
    return "completed";
  }
  const typeValue = (event.type ?? "").trim().toLowerCase();
  const statusValue = (event.status ?? "").trim().toLowerCase();
  if (isCancelledKanbanAssistantEvent(event)) {
    return "cancelled";
  }
  if (
    typeValue === "error" ||
    typeValue === "failed" ||
    typeValue === "fail" ||
    typeValue === "timeout" ||
    typeValue === "run.error" ||
    typeValue === "run.fail" ||
    typeValue === "run.failed" ||
    typeValue === "task.fail" ||
    typeValue === "task.failed" ||
    typeValue === "run.expired" ||
    statusValue === "error" ||
    statusValue === "failed" ||
    statusValue === "fail" ||
    statusValue === "timeout"
  ) {
    return "failed";
  }
  return null;
}

export function syncKanbanIssueFromAssistantEvent(
  app: AppPathProvider,
  event: KanbanAssistantSyncEvent
) {
  const status = resolveKanbanStatusFromAssistantEvent(event);
  const runState = resolveKanbanRunStateFromAssistantEvent(event);
  if (!runState || (!event.runId && !event.chatId)) {
    return;
  }

  const input: KanbanIssueUpdateInput = {
    runId: null,
    runState
  };
  if (status) {
    input.status = status;
  }
  if (event.chatId) {
    input.chatId = event.chatId;
  }

  const runResult = event.runId ? updateKanbanIssueByRunId(app, event.runId, input) : null;
  if (runResult?.ok) {
    return;
  }

  const chatResult = event.chatId ? updateKanbanIssueByChatId(app, event.chatId, input) : null;
  if (chatResult?.ok) {
    return;
  }

  const result = chatResult ?? runResult;
  if (
    result &&
    result.message !== t("kanban.runtime.runMissing") &&
    result.message !== t("kanban.runtime.chatMissing")
  ) {
    console.warn(`[kanban] failed to sync assistant run ${event.runId ?? event.chatId}: ${result.message}`);
  }
}

function readPlatformAutomationId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as KanbanAutomationDetail;
  return typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : typeof record.scheduleId === "string" && record.scheduleId.trim()
      ? record.scheduleId.trim()
      : "";
}

function buildKanbanAutomationMessage(issue: KanbanIssue) {
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

function currentKanbanIssues(app: AppPathProvider): KanbanListResult["issues"] {
  return listKanbanIssues(app).issues;
}

export async function syncKanbanIssueAutomation<TApp extends AppPathProvider>(
  app: TApp,
  issueId: string,
  callAgentPlatform: AgentPlatformCaller<TApp>
): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
  const issue = currentKanbanIssues(app).find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (!issue) {
    return {
      ok: false,
      message: t("kanban.runtime.missing"),
      issues: currentKanbanIssues(app)
    };
  }

  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await callAgentPlatform(app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    return updateKanbanIssue(app, issue.id, {
      automationId: null,
      automationEnabled: false
    });
  }

  if (!issue.assigneeAgentKey?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.assigneeRequired"),
      issues: currentKanbanIssues(app)
    };
  }
  if (!issue.automationCron?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.cronRequired"),
      issues: currentKanbanIssues(app)
    };
  }
  if (!issue.automationMessage?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.messageRequired"),
      issues: currentKanbanIssues(app)
    };
  }

  const payload = buildKanbanAutomationPayload(issue);
  const detail = issue.automationId
    ? await callAgentPlatform<KanbanAutomationDetail>(app, "/api/automation/update", {
      method: "POST",
      body: { id: issue.automationId, ...payload }
    })
    : await callAgentPlatform<KanbanAutomationDetail>(app, "/api/automation/create", {
      method: "POST",
      body: payload
    });
  const automationId = readPlatformAutomationId(detail) || issue.automationId;
  if (!automationId) {
    return {
      ok: false,
      message: t("kanban.automation.platformIdMissing"),
      issues: currentKanbanIssues(app)
    };
  }
  return updateKanbanIssue(app, issue.id, {
    automationId,
    automationEnabled: true
  });
}

export async function deleteKanbanIssueWithAutomation<TApp extends AppPathProvider>(
  app: TApp,
  issueId: string,
  callAgentPlatform: AgentPlatformCaller<TApp>
): Promise<KanbanDeleteResult | { ok: false; message: string; issues: KanbanIssue[] }> {
  const currentIssues = currentKanbanIssues(app);
  const issue = currentIssues.find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (issue?.automationId) {
    try {
      await callAgentPlatform(app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    } catch (error) {
      return {
        ok: false,
        message: t("kanban.automation.deleteFailed", {
          message: error instanceof Error ? error.message : String(error)
        }),
        issues: currentIssues
      };
    }
  }
  return deleteKanbanIssue(app, issueId);
}
