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
  if (event.type === "done" || event.type === "run.complete") {
    return "completed";
  }
  return null;
}

function isCancelledTaskBoardAssistantEvent(event: TaskBoardAssistantSyncEvent) {
  return (
    event.type === "run.cancel" ||
    event.type === "task.cancel" ||
    event.type === "stopped" ||
    event.type === "run.stopped" ||
    event.type === "run.interrupt" ||
    event.status === "cancelled" ||
    event.status === "canceled" ||
    event.status === "stopped"
  );
}

export function resolveTaskBoardRunStateFromAssistantEvent(
  event: TaskBoardAssistantSyncEvent
): TaskBoardIssue["runState"] {
  const status = resolveTaskBoardStatusFromAssistantEvent(event);
  if (status === "completed") {
    return "completed";
  }
  if (isCancelledTaskBoardAssistantEvent(event)) {
    return "cancelled";
  }
  if (
    event.type === "error" ||
    event.type === "run.error" ||
    event.type === "run.expired" ||
    event.status === "error" ||
    event.status === "timeout"
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
  if (result && result.message !== "任务运行不存在。" && result.message !== "任务会话不存在。") {
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
    "关联 ZenMind 任务看板任务：",
    `任务编号：${issue.id}`,
    `标题：${issue.title}`
  ].join("\n");
}

export function buildTaskBoardAutomationPayload(issue: TaskBoardIssue) {
  return {
    name: `任务看板 ${issue.id}: ${issue.title}`.slice(0, 120),
    description: `来自 ZenMind Desktop 任务看板：${issue.id}`,
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
      message: "任务不存在。",
      issues: currentTaskBoardIssues(app)
    };
  }

  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await callAgentPlatform(app, "/api/automation/delete", {
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
      message: "请选择智能体后再启用定时任务。",
      issues: currentTaskBoardIssues(app)
    };
  }
  if (!issue.automationCron?.trim()) {
    return {
      ok: false,
      message: "请设置自动化 cron。",
      issues: currentTaskBoardIssues(app)
    };
  }
  if (!issue.automationMessage?.trim()) {
    return {
      ok: false,
      message: "请填写自动化要执行的内容。",
      issues: currentTaskBoardIssues(app)
    };
  }

  const payload = buildTaskBoardAutomationPayload(issue);
  const detail = issue.automationId
    ? await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/automation/update", {
      method: "POST",
      body: { id: issue.automationId, ...payload }
    })
    : await callAgentPlatform<TaskBoardAutomationDetail>(app, "/api/automation/create", {
      method: "POST",
      body: payload
    });
  const automationId = readPlatformAutomationId(detail) || issue.automationId;
  if (!automationId) {
    return {
      ok: false,
      message: "agent-platform 未返回自动化 ID。",
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
      await callAgentPlatform(app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    } catch (error) {
      return {
        ok: false,
        message: `自动化删除失败：${error instanceof Error ? error.message : String(error)}`,
        issues: currentIssues
      };
    }
  }
  return deleteTaskBoardIssue(app, issueId);
}
