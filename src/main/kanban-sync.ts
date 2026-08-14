import type {
  AssistantNavigationPushEvent,
  KanbanDeleteResult,
  KanbanIssue,
  KanbanIssueResult,
  KanbanListResult,
  KanbanRunState,
  KanbanStatus,
} from "../shared/contracts";
import {
  deleteKanbanIssue,
  listKanbanIssues,
  updateKanbanIssue,
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

type KanbanAutomationDetail = {
  id?: string;
  scheduleId?: string;
};

export type KanbanRunFinishedPushResolution = {
  status: KanbanStatus;
  runState: Exclude<KanbanRunState, "running">;
  terminalEventType: "run.completed" | "run.failed" | "run.cancelled";
};

export function resolveKanbanRunFinishedPush(
  event: Pick<AssistantNavigationPushEvent, "frame" | "type" | "status" | "finishReason">
): KanbanRunFinishedPushResolution | null {
  if (event.frame !== "push" || event.type !== "run.finished") {
    return null;
  }
  const status = event.status?.trim() ?? "";
  const finishReason = event.finishReason?.trim() ?? "";
  if (status === "completed" && finishReason === "complete") {
    return { status: "completed", runState: "completed", terminalEventType: "run.completed" };
  }
  if (status === "failed" && finishReason === "error") {
    return { status: "todo", runState: "failed", terminalEventType: "run.failed" };
  }
  if (status === "interrupted" && finishReason === "cancel") {
    return { status: "todo", runState: "cancelled", terminalEventType: "run.cancelled" };
  }
  return null;
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
