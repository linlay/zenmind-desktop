import type { App } from "electron";
import type {
  KanbanCurrentUser,
  KanbanIssue,
  KanbanIssueResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { buildKanbanAutomationPayload, kanbanIssueFromAutomationPayload } from "./automation-model";
import { issueSyncMode } from "./cloud-event-model";
import {
  getDesktopKanbanIssue,
  listDesktopKanbanIssues,
  updateDesktopKanbanIssue
} from "./local-store";
import { readText } from "./protocol-values";
import { AgentPlatformCaller, KanbanRuntimeOptions } from "./runtime-options";
import {
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface AutomationSyncDependencies {
  readonly options: Pick<KanbanRuntimeOptions, "callAgentPlatform" | "app">;
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  currentUser(): KanbanCurrentUser;
  readonly connectionState: KanbanDesktopConnectionState;
  cloudIssueReadOnlyResult(): KanbanIssueResult;
  syncAutomationForIssue(issue: KanbanIssue, callAgentPlatform: AgentPlatformCaller<App>): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[]; }>;
}

export async function syncIssueAutomation(dependencies: AutomationSyncDependencies, issueId: string, callAgentPlatform: AgentPlatformCaller<App> = dependencies.options.callAgentPlatform): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
  dependencies.refreshConnection();
  const currentUser = dependencies.currentUser();
  const issue = getDesktopKanbanIssue(dependencies.options.app, currentUser, issueId);
  if (!issue) {
    return {
      ok: false,
      message: t("kanban.runtime.missing"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  if (issueSyncMode(issue) === "cloud") {
    return dependencies.cloudIssueReadOnlyResult();
  }
  const localResult = await dependencies.syncAutomationForIssue(issue, callAgentPlatform);
  if (!localResult.ok || !localResult.issue || issueSyncMode(localResult.issue) === "local") {
    return localResult;
  }
  return localResult;
}

export async function syncAutomationForIssue(dependencies: AutomationSyncDependencies, issue: KanbanIssue, callAgentPlatform: AgentPlatformCaller<App>): Promise<KanbanIssueResult | { ok: false; message: string; issues: KanbanIssue[] }> {
  const currentUser = dependencies.currentUser();
  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await callAgentPlatform(dependencies.options.app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    return updateDesktopKanbanIssue(dependencies.options.app, currentUser, issue.id, {
      automationId: null,
      automationEnabled: false
    });
  }
  if (!issue.assigneeAgentKey?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.assigneeRequired"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  if (!issue.automationCron?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.cronRequired"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  if (!issue.automationMessage?.trim()) {
    return {
      ok: false,
      message: t("kanban.automation.messageRequired"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  const payload = buildKanbanAutomationPayload(issue);
  const detail = issue.automationId
    ? await callAgentPlatform<{
      id?: string;
      scheduleId?: string;
    }>(dependencies.options.app, "/api/automation/update", {
      method: "POST",
      body: { id: issue.automationId, ...payload }
    })
    : await callAgentPlatform<{
      id?: string;
      scheduleId?: string;
    }>(dependencies.options.app, "/api/automation/create", {
      method: "POST",
      body: payload
    });
  const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
  if (!automationId) {
    return {
      ok: false,
      message: t("kanban.automation.platformIdMissing"),
      issues: listDesktopKanbanIssues(dependencies.options.app, currentUser, dependencies.connectionState).issues
    };
  }
  return updateDesktopKanbanIssue(dependencies.options.app, currentUser, issue.id, {
    automationId,
    automationEnabled: true
  });
}

export async function syncRemoteAutomationPayload(dependencies: AutomationSyncDependencies, payload: unknown) {
  const issue = kanbanIssueFromAutomationPayload(payload);
  if (!issue) {
    return { ok: false, message: t("kanban.automation.payloadMissing") };
  }
  if (!issue.automationEnabled) {
    if (issue.automationId) {
      await dependencies.options.callAgentPlatform(dependencies.options.app, "/api/automation/delete", {
        method: "POST",
        body: { id: issue.automationId }
      });
    }
    return {
      ok: true,
      message: t("kanban.automation.disabled"),
      issue: {
        ...issue,
        automationId: null,
        automationEnabled: false
      }
    };
  }
  if (!issue.assigneeAgentKey?.trim()) {
    return { ok: false, message: t("kanban.automation.assigneeRequired") };
  }
  if (!issue.automationCron?.trim()) {
    return { ok: false, message: t("kanban.automation.cronRequired") };
  }
  if (!issue.automationMessage?.trim()) {
    return { ok: false, message: t("kanban.automation.messageRequired") };
  }
  const automationPayload = buildKanbanAutomationPayload(issue);
  const detail = issue.automationId
    ? await dependencies.options.callAgentPlatform<{
      id?: string;
      scheduleId?: string;
    }>(dependencies.options.app, "/api/automation/update", {
      method: "POST",
      body: { id: issue.automationId, ...automationPayload }
    })
    : await dependencies.options.callAgentPlatform<{
      id?: string;
      scheduleId?: string;
    }>(dependencies.options.app, "/api/automation/create", {
      method: "POST",
      body: automationPayload
    });
  const automationId = readText(detail?.id) || readText(detail?.scheduleId) || issue.automationId;
  if (!automationId) {
    return { ok: false, message: t("kanban.automation.platformIdMissing") };
  }
  const result = {
    ok: true,
    message: t("kanban.automation.synced"),
    issue: {
      ...issue,
      automationId,
      automationEnabled: true
    }
  };
  return {
    ok: result.ok,
    message: result.message,
    issue: result.issue
  };
}
