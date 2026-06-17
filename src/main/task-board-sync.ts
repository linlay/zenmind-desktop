import type {
  TaskBoardDeleteResult,
  TaskBoardIssue,
  TaskBoardIssueResult,
  TaskBoardIssueUpdateInput,
  TaskBoardListResult,
  TaskBoardStatus
} from "../shared/contracts";
import {
  deleteTaskBoardIssue,
  listTaskBoardIssues,
  updateTaskBoardIssue,
  updateTaskBoardIssueByChatId,
  updateTaskBoardIssueByRunId
} from "./task-board-store";
import { PRODUCT_NAME } from "../shared/generated/brand";
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

type TaskBoardAssistantSyncEvent = {
  type?: string;
  status?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

type TaskBoardAutomationDetail = {
  id?: string;
  scheduleId?: string;
};

export function resolveTaskBoardStatusFromAssistantEvent(
  event: TaskBoardAssistantSyncEvent
): TaskBoardStatus | null {
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

function isCancelledTaskBoardAssistantEvent(event: TaskBoardAssistantSyncEvent) {
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

export function resolveTaskBoardRunStateFromAssistantEvent(
  event: TaskBoardAssistantSyncEvent
): TaskBoardIssue["runState"] {
  const status = resolveTaskBoardStatusFromAssistantEvent(event);
  if (status === "completed") {
    return "completed";
  }
  const typeValue = (event.type ?? "").trim().toLowerCase();
  const statusValue = (event.status ?? "").trim().toLowerCase();
  if (isCancelledTaskBoardAssistantEvent(event)) {
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

export function syncTaskBoardIssueFromAssistantEvent(
  app: AppPathProvider,
  event: TaskBoardAssistantSyncEvent
) {
  const status = resolveTaskBoardStatusFromAssistantEvent(event);
  const runState = resolveTaskBoardRunStateFromAssistantEvent(event);
  if (!runState || (!event.runId && !event.chatId)) {
    return;
  }

  const input: TaskBoardIssueUpdateInput = {
    runId: null,
    runState
  };
  if (status) {
    input.status = status;
  }
  if (event.chatId) {
    input.chatId = event.chatId;
  }

  const runResult = event.runId ? updateTaskBoardIssueByRunId(app, event.runId, input) : null;
  if (runResult?.ok) {
    return;
  }

  const chatResult = event.chatId ? updateTaskBoardIssueByChatId(app, event.chatId, input) : null;
  if (chatResult?.ok) {
    return;
  }

  const result = chatResult ?? runResult;
  if (
    result &&
    result.message !== t("taskBoard.runtime.runMissing") &&
    result.message !== t("taskBoard.runtime.chatMissing")
  ) {
    console.warn(`[task-board] failed to sync assistant run ${event.runId ?? event.chatId}: ${result.message}`);
  }
}

function readPlatformAutomationId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as TaskBoardAutomationDetail;
  return typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : typeof record.scheduleId === "string" && record.scheduleId.trim()
      ? record.scheduleId.trim()
      : "";
}

function buildTaskBoardAutomationMessage(issue: TaskBoardIssue) {
  const message = issue.automationMessage?.trim() || issue.description.trim() || issue.title.trim();
  return [
    message,
    "",
    t("taskBoard.automation.messageIntro", { productName: PRODUCT_NAME }),
    t("taskBoard.automation.issueId", { id: issue.id }),
    t("taskBoard.automation.issueTitle", { title: issue.title })
  ].join("\n");
}

export function buildTaskBoardAutomationPayload(issue: TaskBoardIssue) {
  return {
    name: t("taskBoard.automation.name", { id: issue.id, title: issue.title }).slice(0, 120),
    description: t("taskBoard.automation.description", { productName: PRODUCT_NAME, id: issue.id }),
    cron: issue.automationCron?.trim() ?? "",
    agentKey: issue.assigneeAgentKey?.trim() ?? "",
    enabled: true,
    zoneId: issue.automationTimezone?.trim() || "Asia/Shanghai",
    query: {
      message: buildTaskBoardAutomationMessage(issue),
      hidden: true,
      params: {
        source: "task-board",
        issueId: issue.id
      }
    }
  };
}

function currentTaskBoardIssues(app: AppPathProvider): TaskBoardListResult["issues"] {
  return listTaskBoardIssues(app).issues;
}

export async function syncTaskBoardIssueAutomation<TApp extends AppPathProvider>(
  app: TApp,
  issueId: string,
  callAgentPlatform: AgentPlatformCaller<TApp>
): Promise<TaskBoardIssueResult | { ok: false; message: string; issues: TaskBoardIssue[] }> {
  const issue = currentTaskBoardIssues(app).find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (!issue) {
    return {
      ok: false,
      message: t("taskBoard.runtime.missing"),
      issues: currentTaskBoardIssues(app)
    };
  }

  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await callAgentPlatform(app, "/api/admin/automations/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    return updateTaskBoardIssue(app, issue.id, {
      automationId: null,
      automationEnabled: false
    });
  }

  if (!issue.assigneeAgentKey?.trim()) {
    return {
      ok: false,
      message: t("taskBoard.automation.assigneeRequired"),
      issues: currentTaskBoardIssues(app)
    };
  }
  if (!issue.automationCron?.trim()) {
    return {
      ok: false,
      message: t("taskBoard.automation.cronRequired"),
      issues: currentTaskBoardIssues(app)
    };
  }
  if (!issue.automationMessage?.trim()) {
    return {
      ok: false,
      message: t("taskBoard.automation.messageRequired"),
      issues: currentTaskBoardIssues(app)
    };
  }

  const payload = buildTaskBoardAutomationPayload(issue);
  const detail = issue.automationId
    ? await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/admin/automations/update", {
      method: "POST",
      body: { id: issue.automationId, ...payload }
    })
    : await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/admin/automations/create", {
      method: "POST",
      body: payload
    });
  const automationId = readPlatformAutomationId(detail) || issue.automationId;
  if (!automationId) {
    return {
      ok: false,
      message: t("taskBoard.automation.platformIdMissing"),
      issues: currentTaskBoardIssues(app)
    };
  }
  return updateTaskBoardIssue(app, issue.id, {
    automationId,
    automationEnabled: true
  });
}

export async function deleteTaskBoardIssueWithAutomation<TApp extends AppPathProvider>(
  app: TApp,
  issueId: string,
  callAgentPlatform: AgentPlatformCaller<TApp>
): Promise<TaskBoardDeleteResult | { ok: false; message: string; issues: TaskBoardIssue[] }> {
  const currentIssues = currentTaskBoardIssues(app);
  const issue = currentIssues.find((candidate) => candidate.id === String(issueId ?? "").trim());
  if (issue?.automationId) {
    try {
      await callAgentPlatform(app, "/api/admin/automations/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    } catch (error) {
      return {
        ok: false,
        message: t("taskBoard.automation.deleteFailed", {
          message: error instanceof Error ? error.message : String(error)
        }),
        issues: currentIssues
      };
    }
  }
  return deleteTaskBoardIssue(app, issueId);
}
